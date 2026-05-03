import io
import hashlib
import json
import logging
import math
import os
import re
import shutil
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timezone
from collections import Counter
from logging.handlers import RotatingFileHandler
from typing import Any, Dict, List, Optional

import chess
import chess.engine
import chess.pgn
from flask import Flask, jsonify, render_template, request

app = Flask(__name__)

CATEGORY_ORDER = [
    "Brilliant",
    "Great",
    "Book",
    "Best",
    "Excellent",
    "Good",
    "Inaccuracy",
    "Mistake",
    "Miss",
    "Blunder",
]

PIECE_VALUES = {
    chess.PAWN: 100,
    chess.KNIGHT: 320,
    chess.BISHOP: 330,
    chess.ROOK: 500,
    chess.QUEEN: 900,
}

CHESSCOM_BASE = "https://api.chess.com/pub"
CHESSCOM_USER_AGENT = "chess-pgn-analyzer/1.0 (contact: local-app)"
MATE_PUZZLE_MAX_PLIES = 160
DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
GAMES_STORE_PATH = os.path.join(DATA_DIR, "chesscom_games_store.json")
ANALYSIS_STORE_PATH = os.path.join(DATA_DIR, "analysis_store.json")
BATCH_ANALYSIS_STORE_PATH = os.path.join(DATA_DIR, "batch_analysis_store.json")
LOGS_DIR = os.path.join(os.path.dirname(__file__), "logs")
APP_LOG_PATH = os.path.join(LOGS_DIR, "app.log")
STORE_LOCK = threading.Lock()
ACTIVE_ANALYSIS_LOCK = threading.Lock()
ACTIVE_ANALYSIS_JOBS: Dict[str, float] = {}
ANALYSIS_SLOT_LOCK = threading.Lock()
ACTIVE_BATCH_LOCK = threading.Lock()
ACTIVE_BATCH_JOB_ID: Optional[str] = None
ACTIVE_BATCH_THREAD: Optional[threading.Thread] = None


def ensure_data_dir() -> None:
    os.makedirs(DATA_DIR, exist_ok=True)


def full_cpu_threads() -> int:
    count = os.cpu_count() or 1
    return max(1, min(128, int(count)))


def stockfish_hash_mb(threads: int) -> int:
    return max(256, min(4096, int(threads) * 128))


def compute_per_call_time_budget(
    *,
    total_plies: int,
    player_side: str,
    target_time_sec: Optional[float],
) -> Optional[float]:
    if target_time_sec is None:
        return None
    try:
        target = float(target_time_sec)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(target) or target <= 0:
        return None

    side = "black" if player_side == "black" else "white"
    player_plies = total_plies // 2 if side == "black" else (total_plies + 1) // 2
    estimated_calls = max(1.0, float(total_plies) + float(player_plies) * 0.35)
    per_call = target / estimated_calls
    return max(0.03, min(1.2, per_call))


def setup_logging() -> None:
    os.makedirs(LOGS_DIR, exist_ok=True)
    log_handler = RotatingFileHandler(
        APP_LOG_PATH,
        maxBytes=2_000_000,
        backupCount=5,
        encoding="utf-8",
    )
    log_handler.setLevel(logging.INFO)
    log_handler.setFormatter(
        logging.Formatter("%(asctime)s [%(levelname)s] %(message)s")
    )

    has_file_handler = any(
        isinstance(handler, RotatingFileHandler)
        and getattr(handler, "baseFilename", "") == os.path.abspath(APP_LOG_PATH)
        for handler in app.logger.handlers
    )
    if not has_file_handler:
        app.logger.addHandler(log_handler)

    app.logger.setLevel(logging.INFO)


setup_logging()


def read_json_file(path: str, default: Dict[str, Any]) -> Dict[str, Any]:
    if not os.path.exists(path):
        return default
    try:
        with open(path, "r", encoding="utf-8") as file:
            parsed = json.load(file)
            if isinstance(parsed, dict):
                return parsed
    except (OSError, json.JSONDecodeError):
        return default
    return default


def write_json_atomic(path: str, payload: Dict[str, Any]) -> None:
    ensure_data_dir()
    fd, tmp_path = tempfile.mkstemp(prefix="tmp_store_", suffix=".json", dir=DATA_DIR)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as file:
            json.dump(payload, file, ensure_ascii=False, indent=2)
        os.replace(tmp_path, path)
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


def load_games_store() -> Dict[str, Any]:
    return read_json_file(GAMES_STORE_PATH, {"games": {}})


def save_games_store(store: Dict[str, Any]) -> None:
    write_json_atomic(GAMES_STORE_PATH, store)


def load_analysis_store() -> Dict[str, Any]:
    return read_json_file(ANALYSIS_STORE_PATH, {"analyses": {}})


def save_analysis_store(store: Dict[str, Any]) -> None:
    write_json_atomic(ANALYSIS_STORE_PATH, store)


def load_batch_analysis_store() -> Dict[str, Any]:
    return read_json_file(BATCH_ANALYSIS_STORE_PATH, {"jobs": {}})


def save_batch_analysis_store(store: Dict[str, Any]) -> None:
    write_json_atomic(BATCH_ANALYSIS_STORE_PATH, store)


def has_eval_points(payload: Dict[str, Any]) -> bool:
    eval_points = payload.get("eval_points")
    return isinstance(eval_points, list) and bool(eval_points)


def parse_analysis_key_params(key: str) -> Dict[str, int]:
    match = re.search(r":d=(\d+):t=(\d+):pv=(\d+)$", key)
    if not match:
        return {}
    depth, threads, pv_plies = match.groups()
    return {
        "depth": int(depth),
        "threads": int(threads),
        "pv_plies": int(pv_plies),
    }


def best_cached_chesscom_analysis(
    *,
    analysis_map: Dict[str, Any],
    game_id: str,
    side: str,
) -> Optional[Dict[str, Any]]:
    prefix = f"chesscom:{game_id}:"
    best_entry: Optional[Dict[str, Any]] = None
    best_rank: Optional[tuple] = None

    for key, payload_raw in analysis_map.items():
        if not isinstance(key, str) or not key.startswith(prefix):
            continue
        if extract_side_from_analysis_key(key) != side:
            continue
        if not isinstance(payload_raw, dict):
            continue
        if not has_eval_points(payload_raw):
            continue

        key_params = parse_analysis_key_params(key)
        settings = payload_raw.get("settings", {}) or {}
        depth = int(key_params.get("depth") or settings.get("depth") or 0)
        threads = int(key_params.get("threads") or settings.get("threads") or 0)
        pv_plies = int(key_params.get("pv_plies") or settings.get("pv_plies") or 0)
        saved_at = int(payload_raw.get("saved_at") or 0)
        rank = (depth, pv_plies, threads, saved_at)

        if best_rank is None or rank > best_rank:
            best_rank = rank
            best_entry = {"key": key, "payload": payload_raw}

    return best_entry


def prepare_cached_analysis_payload(payload: Dict[str, Any], analysis_key: str) -> Dict[str, Any]:
    data = dict(payload)
    data["cached"] = True
    data["analysis_key"] = analysis_key
    return data


def try_mark_analysis_job(job_key: str) -> bool:
    with ACTIVE_ANALYSIS_LOCK:
        if job_key in ACTIVE_ANALYSIS_JOBS:
            return False
        ACTIVE_ANALYSIS_JOBS[job_key] = time.time()
        return True


def finish_analysis_job(job_key: str) -> None:
    with ACTIVE_ANALYSIS_LOCK:
        ACTIVE_ANALYSIS_JOBS.pop(job_key, None)


def extract_side_from_analysis_key(key: str) -> Optional[str]:
    marker = ":side="
    if marker not in key:
        return None
    after = key.split(marker, maxsplit=1)[1]
    side = after.split(":", maxsplit=1)[0].strip().lower()
    if side in {"white", "black"}:
        return side
    return None


def parse_chesscom_analysis_index(
    analysis_map: Dict[str, Any]
) -> Dict[str, List[Dict[str, Any]]]:
    index: Dict[str, List[Dict[str, Any]]] = {}
    for key, payload in analysis_map.items():
        if not isinstance(key, str) or not key.startswith("chesscom:"):
            continue
        parts = key.split(":", maxsplit=2)
        if len(parts) < 3:
            continue
        game_id = parts[1]
        if not game_id:
            continue
        index.setdefault(game_id, []).append(
            {
                "key": key,
                "side": extract_side_from_analysis_key(key),
                "payload": payload if isinstance(payload, dict) else {},
            }
        )
    return index


def summarize_cached_chesscom_games(
    *,
    username: str,
    max_games: int,
) -> Dict[str, Any]:
    with STORE_LOCK:
        games_store = load_games_store()
        game_map = games_store.get("games", {}) or {}
        analysis_store = load_analysis_store()
        analysis_map = analysis_store.get("analyses", {}) or {}

    analysis_index = parse_chesscom_analysis_index(analysis_map)
    username_lc = username.lower()
    summaries: List[Dict[str, Any]] = []

    for game_id, entry in game_map.items():
        if not isinstance(entry, dict):
            continue

        white_data = entry.get("white", {}) or {}
        black_data = entry.get("black", {}) or {}
        white_user = str(white_data.get("username", ""))
        black_user = str(black_data.get("username", ""))
        white_lc = white_user.lower()
        black_lc = black_user.lower()
        owner_lc = str(entry.get("username", "")).lower()

        if username_lc:
            include = username_lc in {owner_lc, white_lc, black_lc}
            if not include:
                continue

        if username_lc and white_lc == username_lc:
            player_side = "white"
        elif username_lc and black_lc == username_lc:
            player_side = "black"
        elif owner_lc and owner_lc == white_lc:
            player_side = "white"
        elif owner_lc and owner_lc == black_lc:
            player_side = "black"
        else:
            player_side = "white"

        analyses = analysis_index.get(str(game_id), [])
        saved_count = len(analyses)
        preferred = [item for item in analyses if item.get("side") == player_side]
        pool = preferred if preferred else analyses
        latest: Optional[Dict[str, Any]] = None
        if pool:
            latest = max(
                pool,
                key=lambda item: int(
                    (item.get("payload", {}) or {}).get("saved_at") or 0
                ),
            )

        last_accuracy: Optional[float] = None
        moves_full: Optional[int] = None
        if latest:
            payload = latest.get("payload", {}) or {}
            last_accuracy = accuracy_for_display_from_payload(payload)
            mainline = payload.get("mainline_uci")
            if isinstance(mainline, list):
                moves_full = int(math.ceil(len(mainline) / 2))

        result_raw = str((entry.get(player_side, {}) or {}).get("result", ""))
        result_bucket = classify_player_result(result_raw)
        eco = str(entry.get("eco", "")).strip()
        opening_name = str(entry.get("opening", "")).strip()
        if not eco or not opening_name:
            opening_meta = extract_opening_meta(str(entry.get("pgn", "")))
            eco = eco or opening_meta.get("eco", "")
            opening_name = opening_name or opening_meta.get("opening", "")
        end_time = int(entry.get("end_time", 0) or 0)
        summaries.append(
            {
                "game_id": str(game_id),
                "url": str(entry.get("url", "")),
                "white": white_user,
                "black": black_user,
                "white_rating": white_data.get("rating"),
                "black_rating": black_data.get("rating"),
                "player_side": player_side,
                "player_result": result_raw,
                "player_result_bucket": result_bucket,
                "end_time": end_time,
                "end_time_iso": ts_to_iso(end_time),
                "time_class": str(entry.get("time_class", "")),
                "time_control": str(entry.get("time_control", "")),
                "rated": bool(entry.get("rated", False)),
                "saved_analyses": saved_count,
                "last_accuracy": last_accuracy,
                "moves_full": moves_full,
                "eco": eco,
                "opening": opening_name,
            }
        )

    summaries.sort(key=lambda item: int(item.get("end_time", 0)), reverse=True)
    summaries = summaries[:max_games]
    return {
        "username": username,
        "count": len(summaries),
        "games": summaries,
        "updated_at": games_store.get("updated_at"),
    }


def sanitize_username(value: str) -> str:
    normalized = value.strip().lower()
    marker = "chess.com/member/"
    if marker in normalized:
        normalized = normalized.split(marker, maxsplit=1)[1]
    normalized = normalized.strip("/").split("/")[0]
    return re.sub(r"[^a-z0-9_-]", "", normalized)


def analysis_key_game_id(key: str) -> str:
    if not isinstance(key, str) or not key.startswith("chesscom:"):
        return ""
    parts = key.split(":", maxsplit=2)
    return parts[1] if len(parts) >= 2 else ""


def fetch_json(url: str) -> Dict[str, Any]:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": CHESSCOM_USER_AGENT,
            "Accept": "application/json",
        },
    )
    with urllib.request.urlopen(req, timeout=25) as response:
        raw = response.read().decode("utf-8", errors="ignore")
        return json.loads(raw)


def ts_to_iso(ts: Optional[int]) -> str:
    if ts is None:
        return ""
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC")


def to_game_id(game: Dict[str, Any]) -> str:
    url = str(game.get("url") or "")
    pgn = str(game.get("pgn") or "")
    key = f"{url}|{pgn[:80]}|{game.get('end_time')}"
    digest = hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]
    return f"cc_{digest}"


def build_analysis_key(
    *,
    source: str,
    game_id: str,
    side: str,
    depth: int,
    threads: int,
    pv_plies: int,
) -> str:
    return f"{source}:{game_id}:side={side}:d={depth}:t={threads}:pv={pv_plies}"


def extract_result_for_player(game: Dict[str, Any], username: str) -> str:
    white_name = str((game.get("white") or {}).get("username", "")).lower()
    black_name = str((game.get("black") or {}).get("username", "")).lower()
    if username == white_name:
        return str((game.get("white") or {}).get("result", ""))
    if username == black_name:
        return str((game.get("black") or {}).get("result", ""))
    return ""


def classify_player_result(result_raw: str) -> str:
    result = str(result_raw or "").strip().lower()
    if not result:
        return "other"

    if result in {"win", "checkmate"} or "win" in result:
        return "win"

    if result in {"checkmated", "resigned", "timeout", "lose", "abandoned"}:
        return "loss"
    if any(token in result for token in ("lose", "loss", "checkmated", "resigned", "timeout")):
        return "loss"

    if result in {
        "agreed",
        "repetition",
        "stalemate",
        "insufficient",
        "50move",
        "timevsinsufficient",
        "draw",
        "1/2-1/2",
    }:
        return "draw"
    if "draw" in result:
        return "draw"

    return "other"


def extract_pgn_headers(pgn_text: str) -> Dict[str, str]:
    headers: Dict[str, str] = {}
    if not pgn_text:
        return headers

    for raw_line in pgn_text.splitlines():
        line = raw_line.strip()
        if not line:
            break
        match = re.match(r'^\[(\w+)\s+"(.*)"\]$', line)
        if not match:
            continue
        key, value = match.groups()
        headers[str(key)] = str(value)
    return headers


def extract_opening_meta(pgn_text: str) -> Dict[str, str]:
    headers = extract_pgn_headers(pgn_text)
    eco = str(headers.get("ECO", "")).strip()
    opening = str(headers.get("Opening", "")).strip()
    eco_url = str(headers.get("ECOUrl", "")).strip()

    if not opening and eco_url:
        tail = eco_url.rstrip("/").split("/")[-1]
        opening = re.sub(r"\s+", " ", tail.replace("-", " ")).strip()

    return {"eco": eco, "opening": opening}


def resolve_player_side_for_entry(entry: Dict[str, Any], username_lc: str) -> Optional[str]:
    white_data = entry.get("white", {}) or {}
    black_data = entry.get("black", {}) or {}
    white_user = str(white_data.get("username", "")).lower()
    black_user = str(black_data.get("username", "")).lower()
    owner_lc = str(entry.get("username", "")).lower()

    if username_lc:
        include = username_lc in {owner_lc, white_user, black_user}
        if not include:
            return None

    if username_lc and white_user == username_lc:
        return "white"
    if username_lc and black_user == username_lc:
        return "black"
    if owner_lc and owner_lc == white_user:
        return "white"
    if owner_lc and owner_lc == black_user:
        return "black"
    return "white"


class AnalysisConflictError(RuntimeError):
    pass


class AnalysisNotFoundError(LookupError):
    pass


def resolve_default_chesscom_side(entry: Dict[str, Any]) -> str:
    owner_username = sanitize_username(str(entry.get("username", "")))
    resolved = resolve_player_side_for_entry(entry, owner_username) if owner_username else None
    return "black" if resolved == "black" else "white"


def batch_job_scope_key(username: str, max_games: int) -> str:
    return f"{sanitize_username(username)}::{clamp(int(max_games), 1, 5000)}"


def register_active_batch_thread(job_id: str, thread: threading.Thread) -> None:
    global ACTIVE_BATCH_JOB_ID, ACTIVE_BATCH_THREAD
    with ACTIVE_BATCH_LOCK:
        ACTIVE_BATCH_JOB_ID = job_id
        ACTIVE_BATCH_THREAD = thread


def clear_active_batch_thread(job_id: str) -> None:
    global ACTIVE_BATCH_JOB_ID, ACTIVE_BATCH_THREAD
    with ACTIVE_BATCH_LOCK:
        if ACTIVE_BATCH_JOB_ID == job_id:
            ACTIVE_BATCH_JOB_ID = None
            ACTIVE_BATCH_THREAD = None


def is_batch_job_running(job_id: Optional[str] = None) -> bool:
    with ACTIVE_BATCH_LOCK:
        thread = ACTIVE_BATCH_THREAD
        active_job_id = ACTIVE_BATCH_JOB_ID
    if not thread or not thread.is_alive() or not active_job_id:
        return False
    return active_job_id == job_id if job_id else True


def persist_batch_job(job: Dict[str, Any]) -> Dict[str, Any]:
    if not isinstance(job, dict) or not str(job.get("job_id", "")).strip():
        raise ValueError("Batch job payload must include job_id.")

    snapshot = dict(job)
    jobs_to_keep = 32
    with STORE_LOCK:
        store = load_batch_analysis_store()
        jobs = store.setdefault("jobs", {})
        jobs[str(snapshot["job_id"])] = snapshot
        ordered_ids = sorted(
            jobs.keys(),
            key=lambda job_id: int((jobs.get(job_id, {}) or {}).get("started_at") or 0),
            reverse=True,
        )
        for stale_id in ordered_ids[jobs_to_keep:]:
            jobs.pop(stale_id, None)
        save_batch_analysis_store(store)
    return snapshot


def latest_batch_job_snapshot(username: str, max_games: int) -> Optional[Dict[str, Any]]:
    scope_key = batch_job_scope_key(username, max_games)
    with STORE_LOCK:
        store = load_batch_analysis_store()
        jobs = store.get("jobs", {}) or {}
        candidates = [
            dict(payload)
            for payload in jobs.values()
            if isinstance(payload, dict) and str(payload.get("scope_key", "")) == scope_key
        ]

    if not candidates:
        return None

    latest = max(
        candidates,
        key=lambda payload: (
            int(payload.get("started_at") or 0),
            int(payload.get("updated_at") or 0),
        ),
    )
    status = str(latest.get("status", "")).lower()
    if status in {"queued", "running"} and not is_batch_job_running(str(latest.get("job_id", ""))):
        latest["status"] = "interrupted"
        latest["finished_at"] = int(time.time())
        latest["updated_at"] = int(time.time())
        latest.setdefault("message", "Batch analysis stopped when the server process ended.")
        persist_batch_job(latest)
    latest["active"] = is_batch_job_running(str(latest.get("job_id", "")))
    return latest


def build_batch_queue(*, username: str, max_games: int, mode: str) -> List[Dict[str, Any]]:
    summary = summarize_cached_chesscom_games(username=username, max_games=max_games)
    games = [
        game
        for game in (summary.get("games") or [])
        if isinstance(game, dict) and str(game.get("game_id", "")).strip()
    ]
    if mode == "missing":
        return [
            game
            for game in games
            if int(game.get("saved_analyses") or 0) <= 0
        ]
    return games


def opening_meta_for_entry(entry: Dict[str, Any]) -> Dict[str, str]:
    eco = str(entry.get("eco", "")).strip()
    opening = str(entry.get("opening", "")).strip()
    if eco and opening:
        return {"eco": eco, "opening": opening}
    fallback = extract_opening_meta(str(entry.get("pgn", "")))
    return {
        "eco": eco or fallback.get("eco", ""),
        "opening": opening or fallback.get("opening", ""),
    }


def phase_for_ply(ply: int) -> str:
    if ply <= 20:
        return "opening"
    if ply <= 60:
        return "middlegame"
    return "endgame"


def moved_piece_name(fen_before: str, uci: str) -> str:
    try:
        if not fen_before or not uci or len(uci) < 4:
            return "Unknown"
        board = chess.Board(fen_before)
        from_square = chess.parse_square(uci[:2])
        piece = board.piece_at(from_square)
        if piece is None:
            return "Unknown"
        return {
            chess.PAWN: "Pawn",
            chess.KNIGHT: "Knight",
            chess.BISHOP: "Bishop",
            chess.ROOK: "Rook",
            chess.QUEEN: "Queen",
            chess.KING: "King",
        }.get(piece.piece_type, "Unknown")
    except Exception:
        return "Unknown"


def compact_position_key(fen: str) -> str:
    if not fen:
        return ""
    parts = str(fen).split()
    if len(parts) < 2:
        return str(fen).strip()
    return f"{parts[0]} {parts[1]}"


def pick_latest_analysis_for_side(
    analyses: List[Dict[str, Any]],
    side: str,
) -> Optional[Dict[str, Any]]:
    preferred = [item for item in analyses if item.get("side") == side]
    pool = preferred if preferred else analyses
    if not pool:
        return None
    return max(
        pool,
        key=lambda item: int(((item.get("payload", {}) or {}).get("saved_at") or 0)),
    )


def to_int(value: Any, default: int = 0) -> int:
    try:
        if isinstance(value, bool):
            return default
        return int(value)
    except (TypeError, ValueError):
        return default


def to_float(value: Any, default: float = 0.0) -> float:
    try:
        if isinstance(value, bool):
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def cp_white_to_player(cp_white: int, side: str) -> int:
    return cp_white if side == "white" else -cp_white


def normalize_side(value: Any, default: str = "white") -> str:
    return "black" if str(value or default).strip().lower() == "black" else "white"


def analysis_total_plies(analysis: Dict[str, Any]) -> int:
    mainline = analysis.get("mainline_uci")
    if isinstance(mainline, list):
        return len(mainline)

    max_ply = 0
    for key in ("eval_points", "player_moves"):
        items = analysis.get(key)
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            max_ply = max(max_ply, to_int(item.get("ply"), 0))
    return max_ply


def build_mate_hunt_row(
    *,
    game_id: str,
    summary: Dict[str, Any],
    player_side: str,
    total_plies: int,
    move: Dict[str, Any],
    best_move: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    best_mate = best_move.get("mate")
    if not isinstance(best_mate, (int, float)):
        return None
    best_mate_int = int(best_mate)
    if best_mate_int <= 0:
        return None

    best_uci = str(best_move.get("uci", ""))
    played_uci = str(move.get("uci", ""))
    if not best_uci or played_uci == best_uci:
        return None

    ply = max(1, to_int(move.get("ply"), 0))
    plies_left = max(0, total_plies - ply)
    return {
        "game_id": game_id,
        "url": str(summary.get("url", "")),
        "white": str(summary.get("white", "")),
        "black": str(summary.get("black", "")),
        "opening": str(summary.get("opening", "")),
        "eco": str(summary.get("eco", "")),
        "result_bucket": str(summary.get("player_result_bucket", "")).lower(),
        "player_side": player_side,
        "end_time_iso": str(summary.get("end_time_iso", "")),
        "ply": ply,
        "move_number": to_int(move.get("move_number"), (ply + 1) // 2),
        "side": normalize_side(move.get("side", player_side), player_side),
        "san": str(move.get("san", "")),
        "uci": played_uci,
        "best_san": str(best_move.get("san", "")),
        "best_uci": best_uci,
        "best_mate": best_mate_int,
        "cp_loss": max(0, to_int(move.get("cp_loss"), 0)),
        "plies_left": plies_left,
        "full_moves_left": int(math.ceil(plies_left / 2.0)),
        "fen_before": str(move.get("fen_before", "")),
    }


def resolve_cached_game_summary(entry: Dict[str, Any], game_id: str, side: str) -> Dict[str, Any]:
    white_data = entry.get("white", {}) or {}
    black_data = entry.get("black", {}) or {}
    opening_meta = opening_meta_for_entry(entry)
    end_time = int(entry.get("end_time", 0) or 0)
    result_raw = str((entry.get(side, {}) or {}).get("result", ""))
    return {
        "game_id": str(game_id),
        "url": str(entry.get("url", "")),
        "white": str(white_data.get("username", "")),
        "black": str(black_data.get("username", "")),
        "player_side": side,
        "player_result": result_raw,
        "player_result_bucket": classify_player_result(result_raw),
        "end_time": end_time,
        "end_time_iso": ts_to_iso(end_time),
        "eco": opening_meta.get("eco", ""),
        "opening": opening_meta.get("opening", ""),
    }


def build_forced_mate_line(
    *,
    start_fen: str,
    first_uci: str,
    mate_in: int,
    player_side: str,
) -> List[Dict[str, Any]]:
    board = chess.Board(start_fen)
    first_move = chess.Move.from_uci(first_uci)
    if first_move not in board.legal_moves:
        raise ValueError("Stored mating move is no longer legal in the puzzle position.")

    stockfish_path = find_stockfish_path()
    line: List[Dict[str, Any]] = []
    remaining_player_mates = max(1, int(mate_in))
    hard_cap = min(MATE_PUZZLE_MAX_PLIES, max(4, remaining_player_mates * 2 + 8))

    with chess.engine.SimpleEngine.popen_uci(stockfish_path) as engine:
        engine.configure({"Threads": max(1, min(4, full_cpu_threads()))})
        if "Hash" in engine.options:
            engine.configure({"Hash": 256})

        while not board.is_game_over() and len(line) < hard_cap:
            current_side = "white" if board.turn == chess.WHITE else "black"
            if not line:
                move = first_move
            else:
                limit = chess.engine.Limit(mate=max(1, remaining_player_mates))
                raw_info = engine.analyse(board, limit, multipv=1)
                info = raw_info[0] if isinstance(raw_info, list) else raw_info
                lines = parse_engine_info(board, [info], board.turn)
                if not lines:
                    break
                move = lines[0]["move"]

            if move not in board.legal_moves:
                break

            row = {
                "side": current_side,
                "fen_before": board.fen(),
                "uci": move.uci(),
                "san": safe_san(board, move),
            }
            board.push(move)
            row["fen_after"] = board.fen()
            line.append(row)

            if current_side == player_side and remaining_player_mates > 0:
                remaining_player_mates -= 1

        if not board.is_checkmate():
            raise RuntimeError("Could not reconstruct a full mate line for this puzzle.")

    return line


def build_mate_hunt_payload(
    *,
    summary_map: Dict[str, Dict[str, Any]],
    analyzed_by_game: Dict[str, Dict[str, Any]],
) -> Dict[str, Any]:
    position_rows: List[Dict[str, Any]] = []
    game_rows: List[Dict[str, Any]] = []
    wins_with_missed_finish = 0
    mate_in_one_missed = 0
    shortest_mate: Optional[int] = None

    for game_id, analysis in analyzed_by_game.items():
        summary = summary_map.get(game_id, {}) or {}
        result_bucket = str(summary.get("player_result_bucket", "")).lower()
        player_side = normalize_side(
            (analysis.get("settings", {}) or {}).get("side", "") or summary.get("player_side", "white"),
            "white",
        )

        player_moves = analysis.get("player_moves", []) or []
        if not isinstance(player_moves, list) or not player_moves:
            continue

        total_plies = analysis_total_plies(analysis)
        if total_plies <= 0:
            continue

        missed_in_game = 0
        primary_row: Optional[Dict[str, Any]] = None
        for move in player_moves:
            if not isinstance(move, dict):
                continue
            top_moves = move.get("top_moves", [])
            if not isinstance(top_moves, list) or not top_moves:
                continue
            best_move = top_moves[0]
            if not isinstance(best_move, dict):
                continue

            row = build_mate_hunt_row(
                game_id=game_id,
                summary=summary,
                player_side=player_side,
                total_plies=total_plies,
                move=move,
                best_move=best_move,
            )
            if row is None:
                continue

            position_rows.append(row)
            missed_in_game += 1

            if row["best_mate"] == 1:
                mate_in_one_missed += 1
            if shortest_mate is None or row["best_mate"] < shortest_mate:
                shortest_mate = row["best_mate"]
            if primary_row is None or (
                row["best_mate"],
                row["ply"],
                -row["plies_left"],
                -row["cp_loss"],
            ) < (
                primary_row["best_mate"],
                primary_row["ply"],
                -primary_row["plies_left"],
                -primary_row["cp_loss"],
            ):
                primary_row = row

        if primary_row is None:
            continue

        if result_bucket == "win":
            wins_with_missed_finish += 1

        game_rows.append(
            {
                **primary_row,
                "missed_positions": missed_in_game,
            }
        )

    position_rows.sort(
        key=lambda row: (
            to_int(row.get("best_mate"), 99),
            -to_int(row.get("plies_left"), 0),
            0 if str(row.get("result_bucket", "")).lower() == "win" else 1,
            -to_int(row.get("cp_loss"), 0),
            to_int(row.get("ply"), 0),
        )
    )
    game_rows.sort(
        key=lambda row: (
            to_int(row.get("best_mate"), 99),
            -to_int(row.get("plies_left"), 0),
            0 if str(row.get("result_bucket", "")).lower() == "win" else 1,
            -to_int(row.get("missed_positions"), 0),
            to_int(row.get("ply"), 0),
        )
    )

    return {
        "missed_positions": len(position_rows),
        "games_with_missed_finish": len(game_rows),
        "won_games_with_missed_finish": wins_with_missed_finish,
        "mate_in_one_missed": mate_in_one_missed,
        "shortest_mate": shortest_mate,
        "games": game_rows,
        "positions": position_rows,
    }


def build_insights_overview(
    *,
    username: str,
    max_games: int,
) -> Dict[str, Any]:
    summary_payload = summarize_cached_chesscom_games(username=username, max_games=max_games)
    summaries = summary_payload.get("games", []) or []
    summary_map = {
        str(item.get("game_id", "")): item
        for item in summaries
        if isinstance(item, dict) and item.get("game_id")
    }

    with STORE_LOCK:
        analysis_store = load_analysis_store()
        analysis_map = analysis_store.get("analyses", {}) or {}
    analysis_index = parse_chesscom_analysis_index(analysis_map)

    analyzed_by_game: Dict[str, Dict[str, Any]] = {}
    for game_id, summary in summary_map.items():
        side = str(summary.get("player_side", "white")).lower()
        side = "black" if side == "black" else "white"
        analyses = analysis_index.get(game_id, [])
        picked = pick_latest_analysis_for_side(analyses, side)
        if not picked:
            continue
        payload = picked.get("payload", {}) or {}
        if isinstance(payload, dict):
            analyzed_by_game[game_id] = payload

    # Openings (uses all loaded games, not only analyzed games)
    opening_rows: Dict[str, Dict[str, Any]] = {}
    for summary in summaries:
        if not isinstance(summary, dict):
            continue
        eco = str(summary.get("eco", "")).strip()
        opening_name = str(summary.get("opening", "")).strip() or "Unknown opening"
        key = f"{eco}||{opening_name}"
        bucket = opening_rows.setdefault(
            key,
            {
                "eco": eco,
                "opening": opening_name,
                "games": 0,
                "wins": 0,
                "draws": 0,
                "losses": 0,
                "analyzed_games": 0,
            },
        )
        bucket["games"] += 1
        result_bucket = str(summary.get("player_result_bucket", "")).lower()
        if result_bucket == "win":
            bucket["wins"] += 1
        elif result_bucket == "draw":
            bucket["draws"] += 1
        elif result_bucket == "loss":
            bucket["losses"] += 1
        if str(summary.get("game_id", "")) in analyzed_by_game:
            bucket["analyzed_games"] += 1

    openings = []
    for row in opening_rows.values():
        games = max(1, to_int(row.get("games"), 1))
        losses = to_int(row.get("losses"), 0)
        wins = to_int(row.get("wins"), 0)
        draws = to_int(row.get("draws"), 0)
        loss_rate = (losses / games) * 100.0
        score_rate = ((wins + draws * 0.5) / games) * 100.0
        openings.append(
            {
                **row,
                "loss_rate": round(loss_rate, 2),
                "score_rate": round(score_rate, 2),
            }
        )
    openings.sort(
        key=lambda row: (
            -to_float(row.get("loss_rate"), 0.0),
            -to_int(row.get("losses"), 0),
            -to_int(row.get("games"), 0),
            str(row.get("opening", "")),
        )
    )

    phase_raw = {
        "opening": {"moves": 0, "cp_loss_sum": 0, "error_moves": 0, "blunders": 0},
        "middlegame": {"moves": 0, "cp_loss_sum": 0, "error_moves": 0, "blunders": 0},
        "endgame": {"moves": 0, "cp_loss_sum": 0, "error_moves": 0, "blunders": 0},
    }
    piece_raw: Dict[str, Dict[str, int]] = {}
    move_events: List[Dict[str, Any]] = []
    tactic_samples: List[Dict[str, Any]] = []
    missed_mates = 0
    tactical_misses = 0
    games_with_advantage = 0
    converted_advantage = 0
    lost_advantage = 0
    advantage_drop_count = 0
    advantage_samples: List[Dict[str, Any]] = []

    for game_id, analysis in analyzed_by_game.items():
        summary = summary_map.get(game_id, {}) or {}
        player_side = str((analysis.get("settings", {}) or {}).get("side", "")).lower()
        if player_side not in {"white", "black"}:
            player_side = "black" if str(summary.get("player_side", "")).lower() == "black" else "white"

        player_moves = analysis.get("player_moves", []) or []
        eval_points = analysis.get("eval_points", []) or []
        if not isinstance(player_moves, list):
            player_moves = []
        if not isinstance(eval_points, list):
            eval_points = []

        eval_by_ply: Dict[int, int] = {}
        max_adv_cp = 0
        for point in eval_points:
            if not isinstance(point, dict):
                continue
            ply = to_int(point.get("ply"), -1)
            cp_white = to_int(point.get("cp_white"), 0)
            if ply >= 0:
                eval_by_ply[ply] = cp_white
                cp_player = cp_white_to_player(cp_white, player_side)
                if cp_player > max_adv_cp:
                    max_adv_cp = cp_player

        result_bucket = str(summary.get("player_result_bucket", "")).lower()
        if max_adv_cp >= 200:
            games_with_advantage += 1
            if result_bucket == "win":
                converted_advantage += 1
            elif result_bucket in {"draw", "loss"}:
                lost_advantage += 1

        for move in player_moves:
            if not isinstance(move, dict):
                continue
            ply = to_int(move.get("ply"), 0)
            cp_loss = max(0, to_int(move.get("cp_loss"), 0))
            category = str(move.get("category", ""))
            phase = phase_for_ply(ply)

            phase_bucket = phase_raw.get(phase)
            if phase_bucket is not None:
                phase_bucket["moves"] += 1
                phase_bucket["cp_loss_sum"] += cp_loss
                if cp_loss >= 120 or category in {"Inaccuracy", "Mistake", "Miss", "Blunder"}:
                    phase_bucket["error_moves"] += 1
                if category in {"Miss", "Blunder"}:
                    phase_bucket["blunders"] += 1

            piece_name = moved_piece_name(str(move.get("fen_before", "")), str(move.get("uci", "")))
            piece_bucket = piece_raw.setdefault(
                piece_name,
                {"moves": 0, "cp_loss_sum": 0, "error_moves": 0, "blunders": 0},
            )
            piece_bucket["moves"] += 1
            piece_bucket["cp_loss_sum"] += cp_loss
            if cp_loss >= 120 or category in {"Inaccuracy", "Mistake", "Miss", "Blunder"}:
                piece_bucket["error_moves"] += 1
            if category in {"Miss", "Blunder"} or cp_loss >= 320:
                piece_bucket["blunders"] += 1

            best_move = None
            top_moves = move.get("top_moves", [])
            if isinstance(top_moves, list) and top_moves:
                head = top_moves[0]
                if isinstance(head, dict):
                    best_move = head

            if best_move:
                best_uci = str(best_move.get("uci", ""))
                best_san = str(best_move.get("san", ""))
                best_mate = best_move.get("mate")
                if isinstance(best_mate, (int, float)):
                    best_mate_int = int(best_mate)
                    if best_mate_int > 0 and best_mate_int <= 3 and str(move.get("uci", "")) != best_uci:
                        missed_mates += 1
                        tactic_samples.append(
                            {
                                "type": "Missed mate",
                                "game_id": game_id,
                                "ply": ply,
                                "san": str(move.get("san", "")),
                                "best_san": best_san,
                                "cp_loss": cp_loss,
                            }
                        )
                if cp_loss >= 180 and any(token in best_san for token in ("x", "+", "#")):
                    tactical_misses += 1
                    tactic_samples.append(
                        {
                            "type": "Tactical miss",
                            "game_id": game_id,
                            "ply": ply,
                            "san": str(move.get("san", "")),
                            "best_san": best_san,
                            "cp_loss": cp_loss,
                        }
                    )

            cp_before_white = eval_by_ply.get(ply - 1, 0)
            cp_before_player = cp_white_to_player(cp_before_white, player_side)
            if cp_before_player >= 200 and cp_loss >= 120:
                advantage_drop_count += 1
                advantage_samples.append(
                    {
                        "game_id": game_id,
                        "ply": ply,
                        "san": str(move.get("san", "")),
                        "cp_before": cp_before_player,
                        "cp_loss": cp_loss,
                    }
                )

            move_events.append(
                {
                    "game_id": game_id,
                    "ply": ply,
                    "san": str(move.get("san", "")),
                    "category": category,
                    "cp_loss": cp_loss,
                    "phase": phase,
                    "piece": piece_name,
                    "position_key": compact_position_key(str(move.get("fen_before", ""))),
                    "opening": str(summary.get("opening", "")),
                    "eco": str(summary.get("eco", "")),
                    "result_bucket": result_bucket,
                    "end_time_iso": str(summary.get("end_time_iso", "")),
                }
            )

    phase_stats: List[Dict[str, Any]] = []
    for phase_name in ["opening", "middlegame", "endgame"]:
        bucket = phase_raw[phase_name]
        moves = bucket["moves"]
        avg_cp_loss = (bucket["cp_loss_sum"] / moves) if moves else 0.0
        error_rate = (bucket["error_moves"] / moves * 100.0) if moves else 0.0
        blunder_rate = (bucket["blunders"] / moves * 100.0) if moves else 0.0
        phase_stats.append(
            {
                "phase": phase_name,
                "moves": moves,
                "error_moves": bucket["error_moves"],
                "blunders": bucket["blunders"],
                "avg_cp_loss": round(avg_cp_loss, 2),
                "error_per_100": round(error_rate, 2),
                "blunder_per_100": round(blunder_rate, 2),
            }
        )

    weak_pieces: List[Dict[str, Any]] = []
    for piece_name, bucket in piece_raw.items():
        moves = bucket["moves"]
        if moves <= 0 or piece_name == "Unknown":
            continue
        weak_pieces.append(
            {
                "piece": piece_name,
                "moves": moves,
                "avg_cp_loss": round(bucket["cp_loss_sum"] / moves, 2),
                "error_rate": round(bucket["error_moves"] / moves * 100.0, 2),
                "blunder_rate": round(bucket["blunders"] / moves * 100.0, 2),
            }
        )
    weak_pieces.sort(
        key=lambda row: (
            -to_float(row.get("error_rate"), 0.0),
            -to_float(row.get("avg_cp_loss"), 0.0),
            -to_int(row.get("moves"), 0),
        )
    )

    position_counts: Counter = Counter()
    for event in move_events:
        pos_key = str(event.get("position_key", ""))
        if pos_key:
            position_counts[pos_key] += 1

    falling_moves = []
    for event in move_events:
        event_copy = dict(event)
        event_copy["position_repeats"] = position_counts.get(str(event.get("position_key", "")), 0)
        event_copy.pop("position_key", None)
        falling_moves.append(event_copy)
    falling_moves.sort(
        key=lambda item: (
            -to_int(item.get("cp_loss"), 0),
            -to_int(item.get("position_repeats"), 0),
            to_int(item.get("ply"), 0),
        )
    )

    tactic_samples.sort(key=lambda item: -to_int(item.get("cp_loss"), 0))
    advantage_samples.sort(
        key=lambda item: (
            -to_int(item.get("cp_loss"), 0),
            -to_int(item.get("cp_before"), 0),
        )
    )

    conversion_rate = (
        round(converted_advantage / games_with_advantage * 100.0, 2)
        if games_with_advantage
        else None
    )
    mate_hunt = build_mate_hunt_payload(
        summary_map=summary_map,
        analyzed_by_game=analyzed_by_game,
    )

    return {
        "username": username,
        "loaded_games": len(summaries),
        "analyzed_games": len(analyzed_by_game),
        "openings": openings[:24],
        "phase_stats": phase_stats,
        "falling_moves": falling_moves[:20],
        "weak_pieces": weak_pieces[:10],
        "tactics": {
            "missed_mate_1_3": missed_mates,
            "tactical_misses": tactical_misses,
            "samples": tactic_samples[:14],
        },
        "advantage_play": {
            "games_with_advantage": games_with_advantage,
            "converted_to_win": converted_advantage,
            "draw_or_loss_after_advantage": lost_advantage,
            "conversion_rate": conversion_rate,
            "big_drops_count": advantage_drop_count,
            "samples": advantage_samples[:12],
        },
        "mate_hunt": mate_hunt,
        "updated_at": summary_payload.get("updated_at"),
    }


def fetch_chesscom_games(username: str, max_games: int) -> List[Dict[str, Any]]:
    archives_url = f"{CHESSCOM_BASE}/player/{username}/games/archives"
    archives_payload = fetch_json(archives_url)
    archives = archives_payload.get("archives", [])
    if not isinstance(archives, list):
        return []

    collected: List[Dict[str, Any]] = []
    app.logger.info("Chess.com archives username=%s archive_count=%s", username, len(archives))
    for archive_url in reversed(archives):
        if len(collected) >= max_games:
            break
        try:
            archive_data = fetch_json(str(archive_url))
        except Exception:
            continue

        games = archive_data.get("games", [])
        if not isinstance(games, list):
            continue

        for game in reversed(games):
            if len(collected) >= max_games:
                break
            if not isinstance(game, dict):
                continue
            if game.get("rules") not in {"chess", None}:
                continue
            if not game.get("pgn"):
                continue
            collected.append(game)

        # Chess.com asks to avoid high frequency polling.
        time.sleep(0.15)

    collected.sort(key=lambda item: int(item.get("end_time", 0)), reverse=True)
    return collected[:max_games]


def stockfish_search_candidates() -> List[str]:
    project_dir = os.path.dirname(os.path.abspath(__file__))
    local_bin_dir = os.path.join(project_dir, "bin")
    candidates = [
        os.environ.get("STOCKFISH_PATH", "").strip(),
        "stockfish",
        "stockfish.exe",
        os.path.join(local_bin_dir, "stockfish"),
        os.path.join(local_bin_dir, "stockfish.exe"),
        "/usr/local/bin/stockfish",
        "/usr/bin/stockfish",
        "/usr/games/stockfish",
        "/snap/bin/stockfish",
    ]

    if sys.platform == "darwin":
        candidates.extend(
            [
                "/opt/homebrew/bin/stockfish",
                "/opt/local/bin/stockfish",
            ]
        )
    if os.name == "nt":
        candidates.extend(
            [
                r"C:\Program Files\Stockfish\stockfish.exe",
                r"C:\Program Files (x86)\Stockfish\stockfish.exe",
            ]
        )

    unique_candidates: List[str] = []
    seen = set()
    for candidate in candidates:
        if not candidate or candidate in seen:
            continue
        seen.add(candidate)
        unique_candidates.append(candidate)
    return unique_candidates


def find_stockfish_path() -> str:
    for candidate in stockfish_search_candidates():
        if not candidate:
            continue
        if os.path.isfile(candidate):
            return candidate
        resolved = shutil.which(candidate)
        if resolved:
            return resolved

    raise FileNotFoundError(
        "Stockfish not found. Set the full path via the STOCKFISH_PATH environment "
        "variable, install it in PATH, or place the binary at ./bin/stockfish(.exe)."
    )


def read_server_port(default: int = 5000) -> int:
    raw_value = str(os.environ.get("PORT", default)).strip()
    try:
        port = int(raw_value)
    except (TypeError, ValueError):
        return default
    return max(1, min(65535, port))


def run_local_server(*, debug: bool = False) -> None:
    host = str(os.environ.get("HOST", "127.0.0.1")).strip() or "127.0.0.1"
    app.run(
        host=host,
        port=read_server_port(),
        debug=debug,
        use_reloader=debug,
    )


def score_to_cp(score: chess.engine.PovScore, pov_color: chess.Color) -> int:
    return int(score.pov(pov_color).score(mate_score=100_000))


def score_to_mate(score: chess.engine.PovScore, pov_color: chess.Color) -> Optional[int]:
    return score.pov(pov_color).mate()


def cp_loss_to_accuracy(cp_loss: int) -> float:
    return max(0.0, min(100.0, 100.0 * math.exp(-cp_loss / 200.0)))


def accuracy_from_values(values: List[float]) -> Optional[float]:
    if not values:
        return None
    return round(sum(values) / len(values), 2)


def calculate_accuracy_metrics(player_moves: List[Dict[str, Any]]) -> Dict[str, Any]:
    all_values: List[float] = []
    non_book_values: List[float] = []
    book_moves_count = 0
    non_book_moves_count = 0

    for move in player_moves:
        if not isinstance(move, dict):
            continue
        category = str(move.get("category", "")).strip()
        accuracy_raw = move.get("accuracy")
        if not isinstance(accuracy_raw, (int, float)):
            continue

        accuracy = float(accuracy_raw)
        all_values.append(accuracy)
        if category == "Book":
            book_moves_count += 1
        else:
            non_book_moves_count += 1
            non_book_values.append(accuracy)

    overall_with_book = accuracy_from_values(all_values)
    overall_non_book = accuracy_from_values(non_book_values)
    overall_effective = (
        overall_non_book if overall_non_book is not None else overall_with_book
    )
    return {
        "overall_accuracy_with_book": overall_with_book,
        "overall_accuracy_non_book": overall_non_book,
        "overall_accuracy": overall_effective,
        "book_moves_count": int(book_moves_count),
        "non_book_moves_count": int(non_book_moves_count),
        "accuracy_scope": "non_book",
    }


def accuracy_for_display_from_payload(payload: Dict[str, Any]) -> Optional[float]:
    if not isinstance(payload, dict):
        return None

    preferred = payload.get("overall_accuracy_non_book")
    if isinstance(preferred, (int, float)):
        return float(preferred)

    fallback = payload.get("overall_accuracy")
    if isinstance(fallback, (int, float)):
        return float(fallback)

    legacy = payload.get("overall_accuracy_with_book")
    if isinstance(legacy, (int, float)):
        return float(legacy)

    return None


def recalc_stored_analysis_accuracy_metrics() -> Dict[str, int]:
    scanned = 0
    updated = 0

    with STORE_LOCK:
        store = load_analysis_store()
        analysis_map = store.get("analyses", {}) or {}

        for key, payload in analysis_map.items():
            if not isinstance(payload, dict):
                continue
            player_moves = payload.get("player_moves")
            if not isinstance(player_moves, list):
                continue

            scanned += 1
            metrics = calculate_accuracy_metrics(player_moves)

            prev_tuple = (
                payload.get("overall_accuracy"),
                payload.get("overall_accuracy_non_book"),
                payload.get("overall_accuracy_with_book"),
                payload.get("book_moves_count"),
                payload.get("non_book_moves_count"),
                payload.get("accuracy_scope"),
            )
            next_tuple = (
                metrics.get("overall_accuracy"),
                metrics.get("overall_accuracy_non_book"),
                metrics.get("overall_accuracy_with_book"),
                metrics.get("book_moves_count"),
                metrics.get("non_book_moves_count"),
                metrics.get("accuracy_scope"),
            )
            if prev_tuple == next_tuple:
                continue

            payload["overall_accuracy"] = metrics["overall_accuracy"]
            payload["overall_accuracy_non_book"] = metrics["overall_accuracy_non_book"]
            payload["overall_accuracy_with_book"] = metrics["overall_accuracy_with_book"]
            payload["book_moves_count"] = metrics["book_moves_count"]
            payload["non_book_moves_count"] = metrics["non_book_moves_count"]
            payload["accuracy_scope"] = metrics["accuracy_scope"]
            updated += 1

        if updated:
            save_analysis_store(store)

    return {"scanned": scanned, "updated": updated}


def material_value(board: chess.Board, color: chess.Color) -> int:
    return sum(
        len(board.pieces(piece_type, color)) * piece_value
        for piece_type, piece_value in PIECE_VALUES.items()
    )


def safe_san(board: chess.Board, move: chess.Move) -> str:
    try:
        return board.san(move)
    except (ValueError, TypeError):
        return move.uci()


def pv_to_arrows(board: chess.Board, pv: List[chess.Move], pv_plies: int) -> List[Dict[str, str]]:
    temp = board.copy(stack=False)
    arrows: List[Dict[str, str]] = []
    for move in pv[:pv_plies]:
        if move not in temp.legal_moves:
            break
        arrows.append(
            {
                "from": chess.square_name(move.from_square),
                "to": chess.square_name(move.to_square),
            }
        )
        temp.push(move)
    return arrows


def classify_move(
    *,
    ply: int,
    played_move: chess.Move,
    best_move: chess.Move,
    best_cp: int,
    played_cp: int,
    second_cp: Optional[int],
    cp_loss: int,
    best_mate: Optional[int],
    played_mate: Optional[int],
    material_swing: int,
) -> str:
    is_book = ply <= 16 and cp_loss <= 20
    if is_book:
        return "Book"

    is_best_move = played_move == best_move and cp_loss <= 15
    second_gap = best_cp - second_cp if second_cp is not None else 0
    is_forcing = second_gap >= 120
    is_sacrifice = material_swing <= -300

    if is_best_move and is_sacrifice and is_forcing and best_cp >= 80:
        return "Brilliant"
    if is_best_move and is_forcing:
        return "Great"
    if is_best_move:
        return "Best"
    if cp_loss <= 35:
        return "Excellent"
    if cp_loss <= 90:
        return "Good"

    is_miss = best_cp >= 250 and played_cp <= 80 and cp_loss >= 180
    if best_mate is not None and best_mate > 0:
        if played_mate is None or played_mate > best_mate + 2:
            is_miss = True
    if is_miss:
        return "Miss"

    if cp_loss <= 180:
        return "Inaccuracy"
    if cp_loss <= 320:
        return "Mistake"
    return "Blunder"


def parse_engine_info(
    board: chess.Board, infos: List[Dict[str, Any]], pov_color: chess.Color
) -> List[Dict[str, Any]]:
    parsed: List[Dict[str, Any]] = []
    for info in infos:
        pv = info.get("pv", [])
        if not pv:
            continue
        move = pv[0]
        parsed.append(
            {
                "move": move,
                "san": safe_san(board, move),
                "uci": move.uci(),
                "cp": score_to_cp(info["score"], pov_color),
                "mate": score_to_mate(info["score"], pov_color),
                "pv": pv,
                "score": info["score"],
            }
        )
    return parsed


def analyze_game(
    game: chess.pgn.Game,
    *,
    side: str,
    depth: int,
    threads: int,
    hash_mb: int,
    target_time_sec: Optional[float],
    pv_plies: int,
) -> Dict[str, Any]:
    stockfish_path = find_stockfish_path()
    board = game.board()
    start_fen = board.fen()
    mainline_moves = list(game.mainline_moves())
    mainline_uci: List[str] = []
    fen_sequence: List[str] = [start_fen]
    eval_points: List[Dict[str, Any]] = []
    player_moves: List[Dict[str, Any]] = []
    category_counts: Counter = Counter({name: 0 for name in CATEGORY_ORDER})
    per_call_time = compute_per_call_time_budget(
        total_plies=len(mainline_moves),
        player_side=side,
        target_time_sec=target_time_sec,
    )
    base_limit = (
        chess.engine.Limit(depth=depth, time=per_call_time)
        if per_call_time is not None
        else chess.engine.Limit(depth=depth)
    )
    forced_limit = (
        chess.engine.Limit(depth=depth, time=max(0.025, per_call_time * 0.82))
        if per_call_time is not None
        else chess.engine.Limit(depth=depth)
    )

    with chess.engine.SimpleEngine.popen_uci(stockfish_path) as engine:
        engine.configure({"Threads": threads})
        if "Hash" in engine.options:
            engine.configure({"Hash": hash_mb})

        for ply, move in enumerate(mainline_moves, start=1):
            moving_color = board.turn
            moving_side = "white" if moving_color == chess.WHITE else "black"
            fen_before = board.fen()
            san = safe_san(board, move)
            uci = move.uci()
            played_cp_for_graph: Optional[int] = None
            played_mate_for_graph: Optional[int] = None
            item: Optional[Dict[str, Any]] = None

            if moving_side == side:
                raw_info = engine.analyse(board, base_limit, multipv=3)
                info_list = raw_info if isinstance(raw_info, list) else [raw_info]
                info_list = sorted(info_list, key=lambda x: x.get("multipv", 1))
                lines = parse_engine_info(board, info_list, moving_color)
                if not lines:
                    raise RuntimeError("Stockfish did not return candidate lines for this position.")

                best = lines[0]
                second_cp = lines[1]["cp"] if len(lines) > 1 else None

                played_line = next((line for line in lines if line["move"] == move), None)
                if played_line is None:
                    forced_info = engine.analyse(
                        board, forced_limit, root_moves=[move]
                    )
                    played_cp = score_to_cp(forced_info["score"], moving_color)
                    played_mate = score_to_mate(forced_info["score"], moving_color)
                else:
                    played_cp = played_line["cp"]
                    played_mate = played_line["mate"]

                played_cp_for_graph = played_cp
                played_mate_for_graph = played_mate

                cp_loss = max(0, best["cp"] - played_cp)
                accuracy = round(cp_loss_to_accuracy(cp_loss), 2)

                board_after = board.copy(stack=False)
                board_after.push(move)
                material_swing = material_value(board_after, moving_color) - material_value(
                    board, moving_color
                )

                category = classify_move(
                    ply=ply,
                    played_move=move,
                    best_move=best["move"],
                    best_cp=best["cp"],
                    played_cp=played_cp,
                    second_cp=second_cp,
                    cp_loss=cp_loss,
                    best_mate=best["mate"],
                    played_mate=played_mate,
                    material_swing=material_swing,
                )
                category_counts[category] += 1

                item = {
                    "ply": ply,
                    "move_number": (ply + 1) // 2,
                    "side": moving_side,
                    "san": san,
                    "uci": uci,
                    "fen_before": fen_before,
                    "best_move_san": best["san"],
                    "best_move_uci": best["uci"],
                    "best_eval_cp": best["cp"],
                    "played_eval_cp": played_cp,
                    "cp_loss": cp_loss,
                    "accuracy": accuracy,
                    "category": category,
                    "recommended_arrows": pv_to_arrows(board, best["pv"], pv_plies),
                    "top_moves": [
                        {
                            "san": line["san"],
                            "uci": line["uci"],
                            "cp": line["cp"],
                            "mate": line["mate"],
                        }
                        for line in lines[:3]
                    ],
                }
            else:
                forced_info = engine.analyse(
                    board, forced_limit, root_moves=[move]
                )
                played_cp_for_graph = score_to_cp(forced_info["score"], moving_color)
                played_mate_for_graph = score_to_mate(forced_info["score"], moving_color)

            if played_cp_for_graph is not None:
                cp_white = (
                    played_cp_for_graph
                    if moving_color == chess.WHITE
                    else -played_cp_for_graph
                )
                mate_white = (
                    played_mate_for_graph
                    if moving_color == chess.WHITE
                    else (
                        -played_mate_for_graph
                        if played_mate_for_graph is not None
                        else None
                    )
                )
                eval_points.append(
                    {
                        "ply": ply,
                        "side": moving_side,
                        "san": san,
                        "uci": uci,
                        "cp_white": int(cp_white),
                        "mate_white": mate_white,
                    }
                )

            board.push(move)
            mainline_uci.append(uci)
            fen_sequence.append(board.fen())

            if item is not None:
                item["fen_after"] = board.fen()
                player_moves.append(item)

    accuracy_metrics = calculate_accuracy_metrics(player_moves)
    overall_accuracy = accuracy_metrics.get("overall_accuracy")
    headers = game.headers

    return {
        "engine_path": stockfish_path,
        "settings": {
            "side": side,
            "depth": depth,
            "threads": threads,
            "hash_mb": hash_mb,
            "target_time_sec": target_time_sec,
            "pv_plies": pv_plies,
        },
        "game": {
            "white": headers.get("White", "Unknown"),
            "black": headers.get("Black", "Unknown"),
            "event": headers.get("Event", ""),
            "site": headers.get("Site", ""),
            "date": headers.get("Date", ""),
            "result": headers.get("Result", "*"),
            "opening": headers.get("Opening", ""),
            "eco": headers.get("ECO", ""),
        },
        "start_fen": start_fen,
        "mainline_uci": mainline_uci,
        "fen_sequence": fen_sequence,
        "eval_points": eval_points,
        "player_moves": player_moves,
        "overall_accuracy": overall_accuracy,
        "overall_accuracy_non_book": accuracy_metrics.get("overall_accuracy_non_book"),
        "overall_accuracy_with_book": accuracy_metrics.get("overall_accuracy_with_book"),
        "book_moves_count": accuracy_metrics.get("book_moves_count"),
        "non_book_moves_count": accuracy_metrics.get("non_book_moves_count"),
        "accuracy_scope": accuracy_metrics.get("accuracy_scope"),
        "counts": {category: int(category_counts.get(category, 0)) for category in CATEGORY_ORDER},
    }


def analyze_fen(
    *,
    fen: str,
    depth: int,
    threads: int,
    hash_mb: int,
    pv_plies: int,
) -> Dict[str, Any]:
    stockfish_path = find_stockfish_path()
    board = chess.Board(fen)

    with chess.engine.SimpleEngine.popen_uci(stockfish_path) as engine:
        engine.configure({"Threads": threads})
        if "Hash" in engine.options:
            engine.configure({"Hash": hash_mb})

        raw_info = engine.analyse(board, chess.engine.Limit(depth=depth), multipv=3)
        info_list = raw_info if isinstance(raw_info, list) else [raw_info]
        info_list = sorted(info_list, key=lambda x: x.get("multipv", 1))
        lines = parse_engine_info(board, info_list, board.turn)
        if not lines:
            raise RuntimeError("Stockfish did not return analysis for the current position.")

        best = lines[0]
        return {
            "engine_path": stockfish_path,
            "turn": "white" if board.turn == chess.WHITE else "black",
            "best_eval_cp": best["cp"],
            "best_mate": best["mate"],
            "best_move_san": best["san"],
            "best_move_uci": best["uci"],
            "arrows": pv_to_arrows(board, best["pv"], pv_plies),
            "top_moves": [
                {"san": line["san"], "uci": line["uci"], "cp": line["cp"], "mate": line["mate"]}
                for line in lines[:3]
            ],
        }


def clamp(value: int, low: int, high: int) -> int:
    return max(low, min(high, value))


def clamp_float(value: float, low: float, high: float) -> float:
    return max(low, min(high, float(value)))


@app.before_request
def log_request_start() -> None:
    if request.path.startswith("/static/"):
        return
    request.environ["request_start_ts"] = time.time()
    app.logger.info(
        "REQ method=%s path=%s ip=%s",
        request.method,
        request.path,
        request.remote_addr,
    )


@app.after_request
def log_response(response):
    if request.path.startswith("/static/"):
        return response
    started = request.environ.get("request_start_ts")
    duration_ms = int((time.time() - started) * 1000) if started else -1
    app.logger.info(
        "RES method=%s path=%s status=%s duration_ms=%s",
        request.method,
        request.path,
        response.status_code,
        duration_ms,
    )
    return response


@app.route("/", methods=["GET"])
def index() -> str:
    return render_template("index.html", categories=CATEGORY_ORDER)


@app.route("/stats", methods=["GET"])
def stats_page() -> str:
    return render_template("stats.html")


@app.get("/api/insights/overview")
def insights_overview_endpoint():
    try:
        username = sanitize_username(request.args.get("username", ""))
        max_games = clamp(int(request.args.get("max_games", 5000)), 1, 5000)
        payload = build_insights_overview(username=username, max_games=max_games)
        app.logger.info(
            "Insights overview username=%s loaded=%s analyzed=%s",
            username or "-",
            payload.get("loaded_games"),
            payload.get("analyzed_games"),
        )
        return jsonify(payload)
    except (ValueError, TypeError):
        return jsonify({"error": "Invalid FEN or numeric analysis parameters."}), 400
    except Exception as exc:
        app.logger.exception("Insights overview failed")
        return jsonify({"error": f"Position analysis failed: {exc}"}), 500


@app.post("/api/mate-hunt/puzzle")
def mate_hunt_puzzle_endpoint():
    try:
        payload = request.get_json(silent=True) or {}
        game_id = str(payload.get("game_id", "")).strip()
        if not game_id:
            return jsonify({"error": "Field game_id is required."}), 400

        ply = clamp(int(payload.get("ply", 0)), 1, 10_000)
        username = sanitize_username(str(payload.get("username", "")))
        requested_side = str(payload.get("side", "")).strip().lower()

        with STORE_LOCK:
            games_store = load_games_store()
            game_entry = (games_store.get("games") or {}).get(game_id)
            analysis_store = load_analysis_store()
            analysis_map = analysis_store.get("analyses", {}) or {}

        if not isinstance(game_entry, dict):
            return jsonify({"error": "Game not found in local cache."}), 404

        resolved_side = (
            requested_side
            if requested_side in {"white", "black"}
            else resolve_player_side_for_entry(game_entry, username) or "white"
        )
        analysis_index = parse_chesscom_analysis_index(analysis_map)
        picked = pick_latest_analysis_for_side(analysis_index.get(game_id, []), resolved_side)
        if not picked:
            return jsonify({"error": "No analyzed game found for this puzzle."}), 404

        analysis = picked.get("payload", {}) or {}
        player_moves = analysis.get("player_moves", []) or []
        if not isinstance(player_moves, list):
            return jsonify({"error": "Puzzle move list is unavailable in cached analysis."}), 404

        target_move = next(
            (
                item
                for item in player_moves
                if isinstance(item, dict) and to_int(item.get("ply"), -1) == ply
            ),
            None,
        )
        if target_move is None:
            return jsonify({"error": "Puzzle position was not found in analyzed moves."}), 404

        top_moves = target_move.get("top_moves", []) or []
        best_move = top_moves[0] if isinstance(top_moves, list) and top_moves else None
        if not isinstance(best_move, dict):
            return jsonify({"error": "Puzzle move does not contain mating candidates."}), 404

        summary = resolve_cached_game_summary(game_entry, game_id, normalize_side(resolved_side))
        puzzle_row = build_mate_hunt_row(
            game_id=game_id,
            summary=summary,
            player_side=normalize_side(resolved_side),
            total_plies=analysis_total_plies(analysis),
            move=target_move,
            best_move=best_move,
        )
        if puzzle_row is None:
            return jsonify({"error": "This position is not a valid mating puzzle."}), 400

        line = build_forced_mate_line(
            start_fen=str(puzzle_row.get("fen_before", "")),
            first_uci=str(puzzle_row.get("best_uci", "")),
            mate_in=to_int(puzzle_row.get("best_mate"), 1),
            player_side=normalize_side(puzzle_row.get("player_side", "white")),
        )
        app.logger.info(
            "Mate hunt puzzle game_id=%s ply=%s side=%s mate_in=%s line_len=%s",
            game_id,
            ply,
            resolved_side,
            puzzle_row.get("best_mate"),
            len(line),
        )
        return jsonify(
            {
                "puzzle_key": f"{game_id}:{ply}:{normalize_side(resolved_side)}",
                "username": username or str(game_entry.get("username", "")),
                "game_id": game_id,
                "ply": ply,
                "side": normalize_side(resolved_side),
                "start_fen": str(puzzle_row.get("fen_before", "")),
                "target_mate": to_int(puzzle_row.get("best_mate"), 1),
                "line": line,
                "url": str(summary.get("url", "")),
                "white": str(summary.get("white", "")),
                "black": str(summary.get("black", "")),
                "opening": str(summary.get("opening", "")),
                "eco": str(summary.get("eco", "")),
                "result_bucket": str(summary.get("player_result_bucket", "")),
                "end_time_iso": str(summary.get("end_time_iso", "")),
                "played_san": str(puzzle_row.get("san", "")),
                "played_uci": str(puzzle_row.get("uci", "")),
                "best_san": str(puzzle_row.get("best_san", "")),
                "best_uci": str(puzzle_row.get("best_uci", "")),
                "plies_left": to_int(puzzle_row.get("plies_left"), 0),
                "full_moves_left": to_int(puzzle_row.get("full_moves_left"), 0),
                "missed_positions": 1,
            }
        )
    except FileNotFoundError as exc:
        app.logger.exception("Stockfish binary missing for mate hunt")
        return jsonify({"error": str(exc)}), 500
    except (ValueError, TypeError):
        return jsonify({"error": "Invalid puzzle parameters."}), 400
    except Exception as exc:
        app.logger.exception("Mate hunt puzzle build failed")
        return jsonify({"error": f"Puzzle build failed: {exc}"}), 500


@app.get("/api/chesscom/cached-games")
def chesscom_cached_games_endpoint():
    try:
        username = sanitize_username(request.args.get("username", ""))
        max_games = clamp(int(request.args.get("max_games", 200)), 1, 5000)
        data = summarize_cached_chesscom_games(username=username, max_games=max_games)
        app.logger.info(
            "Chess.com cached games username=%s count=%s",
            username or "-",
            data.get("count"),
        )
        return jsonify(data)
    except (ValueError, TypeError):
        return jsonify({"error": "Invalid FEN or numeric analysis parameters."}), 400
    except Exception as exc:
        app.logger.exception("Cached games load failed")
        return jsonify({"error": f"Position analysis failed: {exc}"}), 500


@app.post("/api/chesscom/clear-cache")
def chesscom_clear_cache_endpoint():
    try:
        if is_batch_job_running():
            return (
                jsonify(
                    {
                        "error": (
                            "A batch analysis is still running. "
                            "Wait until it finishes before clearing the cache."
                        )
                    }
                ),
                409,
            )

        with STORE_LOCK:
            games_store = load_games_store()
            analysis_store = load_analysis_store()
            batch_store = load_batch_analysis_store()
            game_map = games_store.get("games", {}) or {}
            analysis_map = analysis_store.get("analyses", {}) or {}
            batch_jobs = batch_store.get("jobs", {}) or {}

            removed_game_ids = [str(game_id) for game_id in game_map.keys()]
            removed_games = len(removed_game_ids)
            removed_analyses = len(
                [
                    key
                    for key in analysis_map.keys()
                    if analysis_key_game_id(key) or str(key).startswith("chesscom:")
                ]
            )
            removed_batch_jobs = len(batch_jobs)

            games_store["games"] = {}
            games_store["updated_at"] = int(time.time())
            analysis_store["analyses"] = {}
            analysis_store["updated_at"] = int(time.time())
            batch_store["jobs"] = {}
            save_games_store(games_store)
            save_analysis_store(analysis_store)
            save_batch_analysis_store(batch_store)

        app.logger.info(
            "Chess.com cache cleared removed_games=%s removed_analyses=%s removed_batch_jobs=%s",
            removed_games,
            removed_analyses,
            removed_batch_jobs,
        )
        return jsonify(
            {
                "cleared": True,
                "removed_games": removed_games,
                "removed_analyses": removed_analyses,
                "removed_batch_jobs": removed_batch_jobs,
            }
        )
    except Exception as exc:
        app.logger.exception("Chess.com cache clear failed")
        return jsonify({"error": f"Cache clear failed: {exc}"}), 500


@app.get("/api/chesscom/player-games")
def chesscom_player_games_endpoint():
    try:
        username = sanitize_username(request.args.get("username", ""))
        if not username:
            return jsonify({"error": "Parameter username is required."}), 400

        max_games = clamp(int(request.args.get("max_games", 25)), 1, 5000)
        app.logger.info(
            "Chess.com load games username=%s max_games=%s",
            username,
            max_games,
        )
        games = fetch_chesscom_games(username, max_games)

        with STORE_LOCK:
            games_store = load_games_store()
            game_map = games_store.setdefault("games", {})
            analysis_store = load_analysis_store()
            analysis_map = analysis_store.get("analyses", {})
            analysis_index = parse_chesscom_analysis_index(analysis_map)

            summaries: List[Dict[str, Any]] = []
            for game in games:
                game_id = to_game_id(game)
                white_data = game.get("white", {}) or {}
                black_data = game.get("black", {}) or {}
                white_user = str(white_data.get("username", ""))
                black_user = str(black_data.get("username", ""))
                player_side = (
                    "white"
                    if white_user.lower() == username
                    else "black"
                    if black_user.lower() == username
                    else "white"
                )
                analyses = analysis_index.get(str(game_id), [])
                saved_count = len(analyses)
                preferred = [item for item in analyses if item.get("side") == player_side]
                pool = preferred if preferred else analyses
                latest: Optional[Dict[str, Any]] = None
                if pool:
                    latest = max(
                        pool,
                        key=lambda item: int(
                            (item.get("payload", {}) or {}).get("saved_at") or 0
                        ),
                    )

                last_accuracy: Optional[float] = None
                moves_full: Optional[int] = None
                if latest:
                    latest_payload = latest.get("payload", {}) or {}
                    last_accuracy = accuracy_for_display_from_payload(latest_payload)
                    latest_mainline = latest_payload.get("mainline_uci")
                    if isinstance(latest_mainline, list):
                        moves_full = int(math.ceil(len(latest_mainline) / 2))

                pgn_text = str(game.get("pgn", ""))
                opening_meta = extract_opening_meta(pgn_text)
                player_result = extract_result_for_player(game, username)
                result_bucket = classify_player_result(player_result)

                game_map[game_id] = {
                    "source": "chesscom",
                    "username": username,
                    "game_id": game_id,
                    "url": str(game.get("url", "")),
                    "pgn": pgn_text,
                    "end_time": int(game.get("end_time", 0) or 0),
                    "fetched_at": int(time.time()),
                    "white": {
                        "username": white_user,
                        "rating": white_data.get("rating"),
                        "result": white_data.get("result"),
                    },
                    "black": {
                        "username": black_user,
                        "rating": black_data.get("rating"),
                        "result": black_data.get("result"),
                    },
                    "time_class": str(game.get("time_class", "")),
                    "time_control": str(game.get("time_control", "")),
                    "rated": bool(game.get("rated", False)),
                    "rules": str(game.get("rules", "chess")),
                    "eco": opening_meta.get("eco", ""),
                    "opening": opening_meta.get("opening", ""),
                }

                summaries.append(
                    {
                        "game_id": game_id,
                        "url": str(game.get("url", "")),
                        "white": white_user,
                        "black": black_user,
                        "white_rating": white_data.get("rating"),
                        "black_rating": black_data.get("rating"),
                        "player_side": player_side,
                        "player_result": player_result,
                        "player_result_bucket": result_bucket,
                        "end_time": int(game.get("end_time", 0) or 0),
                        "end_time_iso": ts_to_iso(game.get("end_time")),
                        "time_class": str(game.get("time_class", "")),
                        "time_control": str(game.get("time_control", "")),
                        "rated": bool(game.get("rated", False)),
                        "saved_analyses": saved_count,
                        "last_accuracy": last_accuracy,
                        "moves_full": moves_full,
                        "eco": opening_meta.get("eco", ""),
                        "opening": opening_meta.get("opening", ""),
                    }
                )

            games_store["updated_at"] = int(time.time())
            save_games_store(games_store)

        app.logger.info(
            "Chess.com games loaded username=%s count=%s",
            username,
            len(summaries),
        )
        return jsonify(
            {
                "username": username,
                "count": len(summaries),
                "games": summaries,
            }
        )
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return jsonify({"error": "Player not found on Chess.com."}), 404
        if exc.code == 429:
            return jsonify({"error": "Chess.com rate limit exceeded. Try again later."}), 429
        return jsonify({"error": f"Chess.com API error: HTTP {exc.code}"}), 502
    except urllib.error.URLError as exc:
        return jsonify({"error": f"Chess.com API is unreachable: {exc.reason}"}), 502
    except (ValueError, TypeError):
        return jsonify({"error": "Invalid FEN or numeric analysis parameters."}), 400
    except Exception as exc:
        app.logger.exception("Chess.com games load failed")
        return jsonify({"error": f"Position analysis failed: {exc}"}), 500


def analyze_cached_chesscom_game(
    *,
    game_id: str,
    side: str,
    depth: int,
    threads: int,
    hash_mb: int,
    target_time_sec: float,
    pv_plies: int,
    force_reanalyze: bool,
    allow_compatible_cache: bool,
    skip_slot_lock: bool = False,
) -> Dict[str, Any]:
    with STORE_LOCK:
        games_store = load_games_store()
        game_entry = (games_store.get("games") or {}).get(game_id)

    if not game_entry:
        raise AnalysisNotFoundError(
            "Game not found in local cache. Load games first via /api/chesscom/player-games."
        )

    resolved_side = normalize_side(side or resolve_default_chesscom_side(game_entry), "white")
    analysis_key = build_analysis_key(
        source="chesscom",
        game_id=game_id,
        side=resolved_side,
        depth=depth,
        threads=threads,
        pv_plies=pv_plies,
    )

    with STORE_LOCK:
        analysis_store = load_analysis_store()
        analysis_map = analysis_store.get("analyses", {}) or {}
        existing = analysis_map.get(analysis_key)
        fallback_cached = (
            None
            if force_reanalyze or not allow_compatible_cache
            else best_cached_chesscom_analysis(
                analysis_map=analysis_map,
                game_id=game_id,
                side=resolved_side,
            )
        )

    if existing and not force_reanalyze:
        if has_eval_points(existing):
            app.logger.info("Chess.com analysis cache hit key=%s", analysis_key)
            return prepare_cached_analysis_payload(existing, analysis_key)
        app.logger.info(
            "Chess.com analysis cache upgrade key=%s missing_eval_points=true",
            analysis_key,
        )

    if fallback_cached and not force_reanalyze:
        fallback_key = str(fallback_cached.get("key", "")).strip()
        fallback_payload = fallback_cached.get("payload", {}) or {}
        if fallback_key and isinstance(fallback_payload, dict):
            app.logger.info(
                "Chess.com analysis compatible cache hit requested=%s matched=%s",
                analysis_key,
                fallback_key,
            )
            data = prepare_cached_analysis_payload(fallback_payload, fallback_key)
            data["cache_match"] = "compatible"
            return data

    pgn_text = str(game_entry.get("pgn", "")).strip()
    game = chess.pgn.read_game(io.StringIO(pgn_text))
    if game is None:
        raise RuntimeError("Failed to parse cached game PGN.")

    slot_locked = False
    job_marked = False
    job_key = f"chesscom:{game_id}:side={resolved_side}"
    if not skip_slot_lock:
        if not try_mark_analysis_job(job_key):
            raise AnalysisConflictError(
                "Analysis for this game is already running. Wait until it finishes and click Review again."
            )
        job_marked = True
        if not ANALYSIS_SLOT_LOCK.acquire(blocking=False):
            finish_analysis_job(job_key)
            job_marked = False
            raise AnalysisConflictError(
                "Another full analysis is running right now. Wait until it finishes and retry your request."
            )
        slot_locked = True

    try:
        analysis = analyze_game(
            game,
            side=resolved_side,
            depth=depth,
            threads=threads,
            hash_mb=hash_mb,
            target_time_sec=target_time_sec,
            pv_plies=pv_plies,
        )
    finally:
        if slot_locked:
            ANALYSIS_SLOT_LOCK.release()
        if job_marked:
            finish_analysis_job(job_key)

    analysis["source"] = {
        "provider": "chesscom",
        "game_id": game_id,
        "url": game_entry.get("url", ""),
        "username": game_entry.get("username", ""),
        "end_time": game_entry.get("end_time"),
        "end_time_iso": ts_to_iso(game_entry.get("end_time")),
    }
    analysis["analysis_key"] = analysis_key
    analysis["cached"] = False
    analysis["saved_at"] = int(time.time())

    with STORE_LOCK:
        analysis_store = load_analysis_store()
        analysis_map = analysis_store.setdefault("analyses", {})
        analysis_map[analysis_key] = analysis
        save_analysis_store(analysis_store)

    app.logger.info("Chess.com analysis saved key=%s", analysis_key)
    return analysis


def run_chesscom_batch_job(job: Dict[str, Any], queue: List[Dict[str, Any]]) -> None:
    job_id = str(job.get("job_id", ""))
    slot_locked = False
    try:
        job["status"] = "queued"
        job["active"] = True
        job["message"] = "Waiting for the analysis slot."
        job["updated_at"] = int(time.time())
        persist_batch_job(job)

        ANALYSIS_SLOT_LOCK.acquire()
        slot_locked = True

        job["status"] = "running"
        job["message"] = "Batch analysis is running."
        job["updated_at"] = int(time.time())
        persist_batch_job(job)

        for index, game in enumerate(queue, start=1):
            game_id = str((game or {}).get("game_id", "")).strip()
            side = normalize_side((game or {}).get("player_side", "white"), "white")
            if not game_id:
                job["processed"] = index
                job["failed"] = int(job.get("failed") or 0) + 1
                job["updated_at"] = int(time.time())
                persist_batch_job(job)
                continue

            job["current_index"] = index
            job["current_game_id"] = game_id
            job["processed"] = index - 1
            job["message"] = f"Analyzing {index}/{len(queue)} (game_id={game_id})."
            job["updated_at"] = int(time.time())
            persist_batch_job(job)

            try:
                analyze_cached_chesscom_game(
                    game_id=game_id,
                    side=side,
                    depth=int(job.get("depth") or 14),
                    threads=int(job.get("threads") or full_cpu_threads()),
                    hash_mb=int(job.get("hash_mb") or stockfish_hash_mb(full_cpu_threads())),
                    target_time_sec=float(job.get("target_time_sec") or 60.0),
                    pv_plies=int(job.get("pv_plies") or 3),
                    force_reanalyze=bool(job.get("force_reanalyze")),
                    allow_compatible_cache=bool(job.get("allow_compatible_cache")),
                    skip_slot_lock=True,
                )
                job["success"] = int(job.get("success") or 0) + 1
            except Exception as exc:
                app.logger.exception("Batch analysis failed for game_id=%s", game_id)
                job["failed"] = int(job.get("failed") or 0) + 1
                failed_ids = job.setdefault("failed_ids", [])
                if len(failed_ids) < 24:
                    failed_ids.append(game_id)
                failures = job.setdefault("failures", [])
                if len(failures) < 12:
                    failures.append({"game_id": game_id, "error": str(exc)})
            finally:
                job["processed"] = index
                job["updated_at"] = int(time.time())
                persist_batch_job(job)

        job["current_index"] = int(job.get("total") or len(queue))
        job["current_game_id"] = ""
        job["finished_at"] = int(time.time())
        job["updated_at"] = int(time.time())
        job["active"] = False
        if int(job.get("failed") or 0) > 0:
            job["status"] = "completed_with_errors"
            job["message"] = (
                f"Batch analysis finished with errors. Success: {job.get('success', 0)}, "
                f"failed: {job.get('failed', 0)}."
            )
        else:
            job["status"] = "completed"
            job["message"] = f"Batch analysis finished. Success: {job.get('success', 0)}."
        persist_batch_job(job)
    except Exception as exc:
        app.logger.exception("Batch analysis worker crashed job_id=%s", job_id)
        job["status"] = "failed"
        job["active"] = False
        job["finished_at"] = int(time.time())
        job["updated_at"] = int(time.time())
        job["message"] = f"Batch analysis failed: {exc}"
        persist_batch_job(job)
    finally:
        if slot_locked:
            ANALYSIS_SLOT_LOCK.release()
        clear_active_batch_thread(job_id)


@app.get("/api/chesscom/batch-analysis/status")
def chesscom_batch_analysis_status_endpoint():
    try:
        username = sanitize_username(request.args.get("username", ""))
        max_games = clamp(int(request.args.get("max_games", 25)), 1, 5000)
        if not username:
            return jsonify({"job": None})
        return jsonify({"job": latest_batch_job_snapshot(username, max_games)})
    except (ValueError, TypeError):
        return jsonify({"error": "Invalid batch status parameters."}), 400
    except Exception as exc:
        app.logger.exception("Batch status load failed")
        return jsonify({"error": f"Batch status load failed: {exc}"}), 500


@app.post("/api/chesscom/batch-analysis/start")
def chesscom_batch_analysis_start_endpoint():
    try:
        payload = request.get_json(silent=True) or {}
        username = sanitize_username(str(payload.get("username", "")))
        if not username:
            return jsonify({"error": "Field username is required."}), 400

        max_games = clamp(int(payload.get("max_games", 25)), 1, 5000)
        mode = str(payload.get("mode", "missing")).strip().lower()
        if mode not in {"missing", "reanalyze", "deeper"}:
            return jsonify({"error": "Unsupported batch mode."}), 400

        threads = clamp(int(payload.get("threads", full_cpu_threads())), 1, 128)
        hash_mb = clamp(int(payload.get("hash_mb", stockfish_hash_mb(threads))), 64, 8192)
        depth = clamp(int(payload.get("depth", 14)), 6, 40)
        target_time_sec = clamp_float(float(payload.get("target_time_sec", 60.0)), 20.0, 300.0)
        pv_plies = clamp(int(payload.get("pv_plies", 3)), 2, 3)

        current_job = latest_batch_job_snapshot(username, max_games)
        if current_job and str(current_job.get("status", "")).lower() in {"queued", "running"} and current_job.get("active"):
            return jsonify({"started": False, "job": current_job}), 200
        if is_batch_job_running():
            return (
                jsonify(
                    {
                        "error": (
                            "Another batch analysis is already running. "
                            "Wait until it finishes before starting a new one."
                        )
                    }
                ),
                409,
            )

        queue = build_batch_queue(username=username, max_games=max_games, mode=mode)
        if not queue:
            return jsonify(
                {
                    "error": (
                        "All loaded games are already analyzed."
                        if mode == "missing"
                        else "No cached games are available for reanalysis."
                    )
                }
            ), 400

        label = {
            "missing": "Analyze unanalyzed",
            "reanalyze": "Reanalyze all",
            "deeper": "Reanalyze all deeper",
        }[mode]
        force_reanalyze = mode in {"reanalyze", "deeper"}
        allow_compatible_cache = False if force_reanalyze else bool(payload.get("allow_compatible_cache", False))
        now_ts = int(time.time())
        job = {
            "job_id": uuid.uuid4().hex,
            "scope_key": batch_job_scope_key(username, max_games),
            "username": username,
            "max_games": max_games,
            "mode": mode,
            "label": label,
            "status": "queued",
            "active": True,
            "depth": depth,
            "threads": threads,
            "hash_mb": hash_mb,
            "target_time_sec": target_time_sec,
            "pv_plies": pv_plies,
            "force_reanalyze": force_reanalyze,
            "allow_compatible_cache": allow_compatible_cache,
            "total": len(queue),
            "processed": 0,
            "success": 0,
            "failed": 0,
            "current_index": 0,
            "current_game_id": "",
            "failed_ids": [],
            "failures": [],
            "message": "Batch analysis is queued.",
            "started_at": now_ts,
            "updated_at": now_ts,
            "finished_at": None,
        }
        persist_batch_job(job)

        worker = threading.Thread(
            target=run_chesscom_batch_job,
            args=(job, queue),
            daemon=True,
            name=f"batch-analysis-{job['job_id'][:8]}",
        )
        register_active_batch_thread(str(job["job_id"]), worker)
        worker.start()

        app.logger.info(
            "Batch analysis started job_id=%s username=%s max_games=%s mode=%s total=%s",
            job["job_id"],
            username,
            max_games,
            mode,
            len(queue),
        )
        return jsonify({"started": True, "job": latest_batch_job_snapshot(username, max_games) or job})
    except (ValueError, TypeError):
        return jsonify({"error": "Invalid batch analysis parameters."}), 400
    except Exception as exc:
        app.logger.exception("Batch analysis start failed")
        return jsonify({"error": f"Batch analysis start failed: {exc}"}), 500


@app.post("/api/chesscom/analyze-game")
def chesscom_analyze_game_endpoint():
    try:
        payload = request.get_json(silent=True) or {}
        game_id = str(payload.get("game_id", "")).strip()
        if not game_id:
            return jsonify({"error": "Field game_id is required."}), 400

        side_raw = str(payload.get("side", "")).strip().lower()
        if side_raw and side_raw not in {"white", "black"}:
            return jsonify({"error": "Parameter side must be white or black."}), 400

        depth = clamp(int(payload.get("depth", 14)), 6, 40)
        threads = clamp(int(payload.get("threads", 4)), 1, 128)
        hash_mb = clamp(int(payload.get("hash_mb", stockfish_hash_mb(threads))), 64, 8192)
        target_time_sec = clamp_float(float(payload.get("target_time_sec", 60.0)), 20.0, 300.0)
        pv_plies = clamp(int(payload.get("pv_plies", 3)), 2, 3)
        force_reanalyze = bool(payload.get("force_reanalyze", False))
        allow_compatible_cache = bool(payload.get("allow_compatible_cache", False))
        app.logger.info(
            "Chess.com analyze game_id=%s side=%s depth=%s threads=%s hash_mb=%s target_time_sec=%s pv_plies=%s force=%s allow_compatible_cache=%s",
            game_id,
            side_raw or "auto",
            depth,
            threads,
            hash_mb,
            target_time_sec,
            pv_plies,
            force_reanalyze,
            allow_compatible_cache,
        )
        analysis = analyze_cached_chesscom_game(
            game_id=game_id,
            side=side_raw,
            depth=depth,
            threads=threads,
            hash_mb=hash_mb,
            target_time_sec=target_time_sec,
            pv_plies=pv_plies,
            force_reanalyze=force_reanalyze,
            allow_compatible_cache=allow_compatible_cache,
        )
        return jsonify(analysis)
    except FileNotFoundError as exc:
        app.logger.exception("Stockfish binary missing")
        return jsonify({"error": str(exc)}), 500
    except AnalysisNotFoundError as exc:
        return jsonify({"error": str(exc)}), 404
    except AnalysisConflictError as exc:
        return jsonify({"error": str(exc)}), 409
    except (ValueError, TypeError):
        return jsonify({"error": "Invalid FEN or numeric analysis parameters."}), 400
    except Exception as exc:
        app.logger.exception("Chess.com game analysis failed")
        return jsonify({"error": f"Position analysis failed: {exc}"}), 500


@app.post("/api/analyze-pgn")
def analyze_pgn_endpoint():
    try:
        payload = request.get_json(silent=True) or {}
        pgn_file = request.files.get("pgn")
        raw_text = ""
        source = "none"

        if pgn_file and pgn_file.filename:
            raw_text = pgn_file.read().decode("utf-8", errors="ignore").strip()
            source = "file"
        elif request.form.get("pgn_text"):
            raw_text = str(request.form.get("pgn_text", "")).strip()
            source = "form_text"
        elif payload.get("pgn_text"):
            raw_text = str(payload.get("pgn_text", "")).strip()
            source = "json_text"

        if not raw_text:
            return jsonify({"error": "Provide PGN file or pgn_text."}), 400

        game = chess.pgn.read_game(io.StringIO(raw_text))
        if game is None:
            return jsonify({"error": "Failed to parse game from PGN."}), 400

        side = str(request.form.get("side") or payload.get("side") or "white").strip().lower()
        if side not in {"white", "black"}:
            return jsonify({"error": "Parameter side must be white or black."}), 400

        depth = clamp(int(request.form.get("depth") or payload.get("depth") or 14), 6, 40)
        threads = clamp(
            int(request.form.get("threads") or payload.get("threads") or 4), 1, 128
        )
        hash_mb = clamp(
            int(request.form.get("hash_mb") or payload.get("hash_mb") or stockfish_hash_mb(threads)),
            64,
            8192,
        )
        target_time_sec = clamp_float(
            float(request.form.get("target_time_sec") or payload.get("target_time_sec") or 60.0),
            20.0,
            300.0,
        )
        pv_plies = clamp(int(request.form.get("pv_plies") or payload.get("pv_plies") or 3), 2, 3)

        app.logger.info(
            "Analyze PGN source=%s side=%s depth=%s threads=%s hash_mb=%s target_time_sec=%s pv_plies=%s",
            source,
            side,
            depth,
            threads,
            hash_mb,
            target_time_sec,
            pv_plies,
        )

        pgn_hash = hashlib.sha1(raw_text.encode("utf-8")).hexdigest()[:16]
        job_key = f"pgn:{pgn_hash}:side={side}"
        if not try_mark_analysis_job(job_key):
            app.logger.info("PGN analysis already running key=%s", job_key)
            return (
                jsonify(
                    {
                        "error": (
                            "This PGN is already being analyzed. "
                            "Wait for the current analysis to finish."
                        )
                    }
                ),
                409,
            )

        if not ANALYSIS_SLOT_LOCK.acquire(blocking=False):
            finish_analysis_job(job_key)
            app.logger.info("Analysis slot busy for key=%s", job_key)
            return (
                jsonify(
                    {
                        "error": (
                            "Another full analysis is running right now. "
                            "Wait until it finishes and retry your request."
                        )
                    }
                ),
                409,
            )

        try:
            data = analyze_game(
                game,
                side=side,
                depth=depth,
                threads=threads,
                hash_mb=hash_mb,
                target_time_sec=target_time_sec,
                pv_plies=pv_plies,
            )
        finally:
            ANALYSIS_SLOT_LOCK.release()
            finish_analysis_job(job_key)
        return jsonify(data)
    except FileNotFoundError as exc:
        app.logger.exception("Stockfish binary missing")
        return jsonify({"error": str(exc)}), 500
    except (ValueError, TypeError):
        return jsonify({"error": "Invalid FEN or numeric analysis parameters."}), 400
    except Exception as exc:
        app.logger.exception("PGN analysis failed")
        return jsonify({"error": f"Position analysis failed: {exc}"}), 500


@app.post("/api/evaluate-position")
def evaluate_position_endpoint():
    try:
        payload = request.get_json(silent=True) or {}
        fen = payload.get("fen")
        if not fen:
            return jsonify({"error": "The fen field is required."}), 400

        depth = clamp(int(payload.get("depth", 14)), 6, 40)
        threads = clamp(int(payload.get("threads", 2)), 1, 64)
        hash_mb = clamp(int(payload.get("hash_mb", stockfish_hash_mb(threads))), 64, 8192)
        pv_plies = clamp(int(payload.get("pv_plies", 3)), 2, 3)
        app.logger.info(
            "Evaluate position depth=%s threads=%s hash_mb=%s pv_plies=%s",
            depth,
            threads,
            hash_mb,
            pv_plies,
        )

        data = analyze_fen(
            fen=fen,
            depth=depth,
            threads=threads,
            hash_mb=hash_mb,
            pv_plies=pv_plies,
        )
        return jsonify(data)
    except FileNotFoundError as exc:
        app.logger.exception("Stockfish binary missing")
        return jsonify({"error": str(exc)}), 500
    except (ValueError, TypeError):
        return jsonify({"error": "Invalid FEN or numeric analysis parameters."}), 400
    except Exception as exc:
        app.logger.exception("Evaluate position failed")
        return jsonify({"error": f"Position analysis failed: {exc}"}), 500


if __name__ == "__main__":
    run_local_server(debug=False)

