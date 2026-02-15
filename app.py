import io
import hashlib
import json
import logging
import math
import os
import re
import shutil
import tempfile
import threading
import time
import urllib.error
import urllib.request
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
DATA_DIR = os.path.join(os.path.dirname(__file__), "data")
GAMES_STORE_PATH = os.path.join(DATA_DIR, "chesscom_games_store.json")
ANALYSIS_STORE_PATH = os.path.join(DATA_DIR, "analysis_store.json")
LOGS_DIR = os.path.join(os.path.dirname(__file__), "logs")
APP_LOG_PATH = os.path.join(LOGS_DIR, "app.log")
STORE_LOCK = threading.Lock()
ACTIVE_ANALYSIS_LOCK = threading.Lock()
ACTIVE_ANALYSIS_JOBS: Dict[str, float] = {}
ANALYSIS_SLOT_LOCK = threading.Lock()


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
            accuracy_raw = payload.get("overall_accuracy")
            if isinstance(accuracy_raw, (int, float)):
                last_accuracy = float(accuracy_raw)
            mainline = payload.get("mainline_uci")
            if isinstance(mainline, list):
                moves_full = int(math.ceil(len(mainline) / 2))

        result_raw = str((entry.get(player_side, {}) or {}).get("result", ""))
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
                "end_time": end_time,
                "end_time_iso": ts_to_iso(end_time),
                "time_class": str(entry.get("time_class", "")),
                "time_control": str(entry.get("time_control", "")),
                "rated": bool(entry.get("rated", False)),
                "saved_analyses": saved_count,
                "last_accuracy": last_accuracy,
                "moves_full": moves_full,
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


def find_stockfish_path() -> str:
    candidates = [
        os.environ.get("STOCKFISH_PATH"),
        "stockfish",
        "stockfish.exe",
        os.path.join("bin", "stockfish.exe"),
        os.path.join("bin", "stockfish"),
        r"C:\Program Files\Stockfish\stockfish.exe",
        r"C:\Program Files (x86)\Stockfish\stockfish.exe",
    ]

    for candidate in candidates:
        if not candidate:
            continue
        if os.path.isfile(candidate):
            return candidate
        resolved = shutil.which(candidate)
        if resolved:
            return resolved

    raise FileNotFoundError(
        "Stockfish Р Р…Р Вµ Р Р…Р В°Р в„–Р Т‘Р ВµР Р…. Р Р€Р С”Р В°Р В¶Р С‘РЎвЂљР Вµ Р С—РЎС“РЎвЂљРЎРЉ РЎвЂЎР ВµРЎР‚Р ВµР В· Р С—Р ВµРЎР‚Р ВµР СР ВµР Р…Р Р…РЎС“РЎР‹ Р С•Р С”РЎР‚РЎС“Р В¶Р ВµР Р…Р С‘РЎРЏ STOCKFISH_PATH "
        "Р С‘Р В»Р С‘ Р С—Р С•Р В»Р С•Р В¶Р С‘РЎвЂљР Вµ Р В±Р С‘Р Р…Р В°РЎР‚Р Р…Р С‘Р С” Р Р† ./bin/stockfish(.exe)."
    )


def score_to_cp(score: chess.engine.PovScore, pov_color: chess.Color) -> int:
    return int(score.pov(pov_color).score(mate_score=100_000))


def score_to_mate(score: chess.engine.PovScore, pov_color: chess.Color) -> Optional[int]:
    return score.pov(pov_color).mate()


def cp_loss_to_accuracy(cp_loss: int) -> float:
    return max(0.0, min(100.0, 100.0 * math.exp(-cp_loss / 200.0)))


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
    accuracies: List[float] = []
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
                    raise RuntimeError("Stockfish Р Р…Р Вµ Р Р†Р ВµРЎР‚Р Р…РЎС“Р В» Р Р†Р В°РЎР‚Р С‘Р В°Р Р…РЎвЂљР С•Р Р† Р Т‘Р В»РЎРЏ Р С—Р С•Р В·Р С‘РЎвЂ Р С‘Р С‘.")

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
                accuracies.append(accuracy)

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

    overall_accuracy = round(sum(accuracies) / len(accuracies), 2) if accuracies else None
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
            raise RuntimeError("Stockfish Р Р…Р Вµ Р Р†Р ВµРЎР‚Р Р…РЎС“Р В» Р В°Р Р…Р В°Р В»Р С‘Р В· Р Т‘Р В»РЎРЏ РЎвЂљР ВµР С”РЎС“РЎвЂ°Р ВµР в„– Р С—Р С•Р В·Р С‘РЎвЂ Р С‘Р С‘.")

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


@app.get("/api/chesscom/cached-games")
def chesscom_cached_games_endpoint():
    try:
        username = sanitize_username(request.args.get("username", ""))
        max_games = clamp(int(request.args.get("max_games", 200)), 1, 500)
        data = summarize_cached_chesscom_games(username=username, max_games=max_games)
        app.logger.info(
            "Chess.com cached games username=%s count=%s",
            username or "-",
            data.get("count"),
        )
        return jsonify(data)
    except (ValueError, TypeError):
        return jsonify({"error": "max_games must be numeric."}), 400
    except Exception as exc:
        app.logger.exception("Cached games load failed")
        return jsonify({"error": f"Failed to load cached games: {exc}"}), 500


@app.get("/api/chesscom/player-games")
def chesscom_player_games_endpoint():
    try:
        username = sanitize_username(request.args.get("username", ""))
        if not username:
            return jsonify({"error": "Parameter username is required."}), 400

        max_games = clamp(int(request.args.get("max_games", 25)), 1, 100)
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
                    accuracy_raw = latest_payload.get("overall_accuracy")
                    if isinstance(accuracy_raw, (int, float)):
                        last_accuracy = float(accuracy_raw)
                    latest_mainline = latest_payload.get("mainline_uci")
                    if isinstance(latest_mainline, list):
                        moves_full = int(math.ceil(len(latest_mainline) / 2))

                game_map[game_id] = {
                    "source": "chesscom",
                    "username": username,
                    "game_id": game_id,
                    "url": str(game.get("url", "")),
                    "pgn": str(game.get("pgn", "")),
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
                        "player_result": extract_result_for_player(game, username),
                        "end_time": int(game.get("end_time", 0) or 0),
                        "end_time_iso": ts_to_iso(game.get("end_time")),
                        "time_class": str(game.get("time_class", "")),
                        "time_control": str(game.get("time_control", "")),
                        "rated": bool(game.get("rated", False)),
                        "saved_analyses": saved_count,
                        "last_accuracy": last_accuracy,
                        "moves_full": moves_full,
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
        return jsonify({"error": "max_games must be numeric."}), 400
    except Exception as exc:
        app.logger.exception("Chess.com games load failed")
        return jsonify({"error": f"Failed to load games: {exc}"}), 500


@app.post("/api/chesscom/analyze-game")
def chesscom_analyze_game_endpoint():
    try:
        payload = request.get_json(silent=True) or {}
        game_id = str(payload.get("game_id", "")).strip()
        if not game_id:
            return jsonify({"error": "Field game_id is required."}), 400

        side = str(payload.get("side", "white")).strip().lower()
        if side not in {"white", "black"}:
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
            side,
            depth,
            threads,
            hash_mb,
            target_time_sec,
            pv_plies,
            force_reanalyze,
            allow_compatible_cache,
        )

        with STORE_LOCK:
            games_store = load_games_store()
            game_entry = (games_store.get("games") or {}).get(game_id)

        if not game_entry:
            return (
                jsonify(
                    {
                        "error": (
                            "Game not found in local cache. "
                            "Load games first via /api/chesscom/player-games."
                        )
                    }
                ),
                404,
            )

        analysis_key = build_analysis_key(
            source="chesscom",
            game_id=game_id,
            side=side,
            depth=depth,
            threads=threads,
            pv_plies=pv_plies,
        )
        job_key = f"chesscom:{game_id}:side={side}"

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
                    side=side,
                )
            )

        if existing and not force_reanalyze:
            if has_eval_points(existing):
                app.logger.info("Chess.com analysis cache hit key=%s", analysis_key)
                return jsonify(prepare_cached_analysis_payload(existing, analysis_key))
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
                return jsonify(data)

        pgn_text = str(game_entry.get("pgn", "")).strip()
        game = chess.pgn.read_game(io.StringIO(pgn_text))
        if game is None:
            return jsonify({"error": "Failed to parse cached game PGN."}), 500

        if not try_mark_analysis_job(job_key):
            app.logger.info("Chess.com analysis already running key=%s", job_key)
            return (
                jsonify(
                    {
                        "error": (
                            "Анализ этой партии уже выполняется. "
                            "Дождитесь завершения и нажмите Review снова."
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
                            "Сейчас выполняется другой полный анализ. "
                            "Подождите завершения и повторите запрос."
                        )
                    }
                ),
                409,
            )

        try:
            analysis = analyze_game(
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
        return jsonify(analysis)
    except FileNotFoundError as exc:
        app.logger.exception("Stockfish binary missing")
        return jsonify({"error": str(exc)}), 500
    except (ValueError, TypeError):
        return jsonify({"error": "depth/threads/hash_mb/target_time_sec/pv_plies must be numeric."}), 400
    except Exception as exc:
        app.logger.exception("Chess.com game analysis failed")
        return jsonify({"error": f"Chess.com game analysis failed: {exc}"}), 500


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
                            "Этот PGN уже анализируется. "
                            "Дождитесь завершения текущего анализа."
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
                            "Сейчас выполняется другой полный анализ. "
                            "Подождите завершения и повторите запрос."
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
        return jsonify({"error": "depth/threads/hash_mb/target_time_sec/pv_plies must be numeric."}), 400
    except Exception as exc:
        app.logger.exception("PGN analysis failed")
        return jsonify({"error": f"PGN analysis failed: {exc}"}), 500


@app.post("/api/evaluate-position")
def evaluate_position_endpoint():
    try:
        payload = request.get_json(silent=True) or {}
        fen = payload.get("fen")
        if not fen:
            return jsonify({"error": "Р СџР С•Р В»Р Вµ fen Р С•Р В±РЎРЏР В·Р В°РЎвЂљР ВµР В»РЎРЉР Р…Р С•."}), 400

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
        return jsonify({"error": "Р СњР ВµР С”Р С•РЎР‚РЎР‚Р ВµР С”РЎвЂљР Р…РЎвЂ№Р в„– FEN Р С‘Р В»Р С‘ РЎвЂЎР С‘РЎРѓР В»Р С•Р Р†РЎвЂ№Р Вµ Р С—Р В°РЎР‚Р В°Р СР ВµРЎвЂљРЎР‚РЎвЂ№."}), 400
    except Exception as exc:
        app.logger.exception("Evaluate position failed")
        return jsonify({"error": f"Р С›РЎв‚¬Р С‘Р В±Р С”Р В° Р В°Р Р…Р В°Р В»Р С‘Р В·Р В° Р С—Р С•Р В·Р С‘РЎвЂ Р С‘Р С‘: {exc}"}), 500


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)

