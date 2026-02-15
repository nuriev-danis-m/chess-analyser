const CATEGORY_ORDER = window.CATEGORY_ORDER || [
  "Brilliant",
  "Great",
  "Book",
  "Best",
  "Excellent",
  "Good",
  "Inaccuracy",
  "Mistake",
  "Miss",
  "Blunder"
];

const CATEGORY_META = {
  Brilliant: { mark: "!!", className: "cat-Brilliant" },
  Great: { mark: "!", className: "cat-Great" },
  Book: { mark: "Bk", className: "cat-Book" },
  Best: { mark: "*", className: "cat-Best" },
  Excellent: { mark: "Ex", className: "cat-Excellent" },
  Good: { mark: "Gd", className: "cat-Good" },
  Inaccuracy: { mark: "?!", className: "cat-Inaccuracy" },
  Mistake: { mark: "?", className: "cat-Mistake" },
  Miss: { mark: "Miss", className: "cat-Miss" },
  Blunder: { mark: "??", className: "cat-Blunder" }
};

const CATEGORY_COLORS = {
  Brilliant: "#27c8b7",
  Great: "#6fa8dc",
  Book: "#d8a472",
  Best: "#8bcf55",
  Excellent: "#95b776",
  Good: "#95b776",
  Inaccuracy: "#f0c03c",
  Mistake: "#f8a359",
  Miss: "#ff7b67",
  Blunder: "#ff4b3a"
};

const DARK_SIDE_TONE = "#686f76";
const LIGHT_SIDE_TONE = "#efefea";
const STORAGE_KEYS = {
  chesscomUsername: "chess_analyzer.chesscom_username"
};

const state = {
  board: null,
  chess: null,
  boardReady: false,
  analysis: null,
  chesscomGames: [],
  selectedCategory: "All",
  selectedPly: null,
  currentPly: 0,
  arrows: [],
  playerMoveByPly: new Map(),
  mainlineRows: [],
  evalByPly: new Map(),
  manualLine: null,
  selectedVariationIndex: null,
  liveAnalyzeTimer: null,
  liveAnalyzeToken: 0,
  analysisBusy: false
};

const detectedCpuThreads = Math.max(
  1,
  Math.floor(parseFiniteNumber(window.navigator && window.navigator.hardwareConcurrency) || 0) || 2
);

const el = {
  globalError: document.getElementById("global-error"),
  selectionView: document.getElementById("selection-view"),
  analysisView: document.getElementById("analysis-view"),

  chesscomUsername: document.getElementById("chesscom-username"),
  chesscomMaxGames: document.getElementById("chesscom-max-games"),
  chesscomLoadBtn: document.getElementById("btn-load-chesscom"),
  chesscomStatus: document.getElementById("chesscom-status"),
  chesscomGames: document.getElementById("chesscom-games"),
  overviewChart: document.getElementById("overview-chart"),

  pgnFile: document.getElementById("pgn-file"),
  pgnText: document.getElementById("pgn-text"),
  analyzeFileBtn: document.getElementById("btn-analyze-file"),
  analyzeTextBtn: document.getElementById("btn-analyze-text"),
  pasteAnalyzeBtn: document.getElementById("btn-paste-analyze"),

  side: document.getElementById("side"),
  depth: document.getElementById("depth"),
  threads: document.getElementById("threads"),
  hashMb: document.getElementById("hash-mb"),
  targetTime: document.getElementById("target-time"),
  pvPlies: document.getElementById("pv-plies"),

  backBtn: document.getElementById("btn-back-selection"),
  analysisGameTitle: document.getElementById("analysis-game-title"),
  analysisSourceMeta: document.getElementById("analysis-source-meta"),

  overallAccuracy: document.getElementById("overall-accuracy"),
  gameMeta: document.getElementById("game-meta"),

  boardStatus: document.getElementById("board-status"),
  suggestions: document.getElementById("current-suggestions"),
  categoryChips: document.getElementById("category-chips"),
  categoryFilter: document.getElementById("category-filter"),
  moveList: document.getElementById("move-list"),

  accuracyChart: document.getElementById("accuracy-chart"),
  highlightPlayer: document.getElementById("highlight-player"),
  highlightOpponent: document.getElementById("highlight-opponent"),
  highlightPlayerAccuracy: document.getElementById("highlight-player-accuracy"),
  highlightOpponentAccuracy: document.getElementById("highlight-opponent-accuracy"),
  highlightsBreakdown: document.getElementById("highlights-breakdown"),

  evalScore: document.getElementById("eval-score"),
  evalScale: document.getElementById("eval-scale"),
  evalWhiteZone: document.getElementById("eval-white-zone"),
  evalBlackZone: document.getElementById("eval-black-zone"),
  evalMarker: document.getElementById("eval-marker"),

  btnStart: document.getElementById("btn-start"),
  btnPrev: document.getElementById("btn-prev"),
  btnNext: document.getElementById("btn-next"),
  btnEnd: document.getElementById("btn-end")
};

function resolveChessCtor() {
  if (typeof window.Chess === "function") {
    return window.Chess;
  }
  if (window.Chess && typeof window.Chess.Chess === "function") {
    return window.Chess.Chess;
  }
  return null;
}

function createChess(fen) {
  const ChessCtor = resolveChessCtor();
  if (!ChessCtor) {
    throw new Error("Chess.js не загружен");
  }
  return fen ? new ChessCtor(fen) : new ChessCtor();
}

function showError(message) {
  el.globalError.textContent = message;
  el.globalError.classList.remove("hidden");
}

function clearError() {
  el.globalError.textContent = "";
  el.globalError.classList.add("hidden");
}

function setView(view) {
  const selection = view === "selection";
  el.selectionView.classList.toggle("hidden", !selection);
  el.analysisView.classList.toggle("hidden", selection);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function parseFiniteNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readStoredUsername() {
  try {
    const value = window.localStorage.getItem(STORAGE_KEYS.chesscomUsername);
    return String(value || "").trim();
  } catch (error) {
    return "";
  }
}

function persistUsername(value) {
  const normalized = String(value || "").trim();
  try {
    if (normalized) {
      window.localStorage.setItem(STORAGE_KEYS.chesscomUsername, normalized);
    } else {
      window.localStorage.removeItem(STORAGE_KEYS.chesscomUsername);
    }
  } catch (error) {
    // Ignore storage errors (private mode / blocked storage).
  }
}

function defaultThreadsForAnalysis() {
  return Math.max(1, Math.min(8, detectedCpuThreads));
}

function analysisDepthValue() {
  const value = parseFiniteNumber(el.depth && el.depth.value);
  if (value === null) {
    return 14;
  }
  return Math.max(6, Math.min(40, Math.round(value)));
}

function analysisThreadsValue() {
  const value = parseFiniteNumber(el.threads && el.threads.value);
  const fallback = defaultThreadsForAnalysis();
  if (value === null) {
    return fallback;
  }
  return Math.max(1, Math.min(128, Math.round(value)));
}

function analysisHashValue() {
  const value = parseFiniteNumber(el.hashMb && el.hashMb.value);
  const fallback = Math.max(128, Math.min(2048, analysisThreadsValue() * 128));
  if (value === null) {
    return fallback;
  }
  return Math.max(64, Math.min(8192, Math.round(value)));
}

function analysisTargetTimeValue() {
  const value = parseFiniteNumber(el.targetTime && el.targetTime.value);
  if (value === null) {
    return 60;
  }
  return Math.max(20, Math.min(300, Math.round(value)));
}

function analysisRequestTimeoutMs() {
  const seconds = analysisTargetTimeValue();
  return Math.max(70000, seconds * 1000 + 20000);
}

function setSelectionBusy(isBusy, label) {
  el.chesscomLoadBtn.disabled = isBusy;
  el.chesscomLoadBtn.textContent = label || "Загрузить игры";
}

function setAnalyzeBusy(isBusy, label) {
  const text = label || "Анализировать";
  [el.analyzeFileBtn, el.analyzeTextBtn, el.pasteAnalyzeBtn].forEach((button) => {
    if (button) {
      button.disabled = isBusy;
    }
  });
  if (el.analyzeFileBtn) {
    el.analyzeFileBtn.textContent = text;
  }
}

function setGlobalAnalysisBusy(isBusy) {
  state.analysisBusy = Boolean(isBusy);
  const disabled = state.analysisBusy;
  [el.analyzeFileBtn, el.analyzeTextBtn, el.pasteAnalyzeBtn].forEach((button) => {
    if (button) {
      button.disabled = disabled;
    }
  });
  [...document.querySelectorAll(".review-btn")].forEach((button) => {
    button.disabled = disabled;
  });
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 180000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}

function missingBoardLibs() {
  const missing = [];
  if (typeof window.jQuery !== "function") {
    missing.push("jQuery");
  }
  if (!resolveChessCtor()) {
    missing.push("Chess.js");
  }
  if (typeof window.Chessboard !== "function") {
    missing.push("Chessboard.js");
  }
  return missing;
}

function hasBoardLibs() {
  return missingBoardLibs().length === 0;
}

function setStatus(text) {
  el.boardStatus.textContent = text;
}

function initCategoryFilter() {
  const options = ["All", ...CATEGORY_ORDER];
  el.categoryFilter.innerHTML = options
    .map((name) => `<option value="${name}">${name}</option>`)
    .join("");
  el.categoryFilter.value = state.selectedCategory;
}

function categoryInfo(category) {
  return CATEGORY_META[category] || { mark: "", className: "" };
}

function setCategory(category) {
  state.selectedCategory = category;
  if (el.categoryFilter.value !== category) {
    el.categoryFilter.value = category;
  }
  renderCategoryChips();
  renderMoveList();
  renderHighlightsBreakdown();
}

function renderHistoryList() {
  if (!state.chesscomGames.length) {
    el.chesscomGames.innerHTML = "<div class='history-empty'>Игры пока не загружены.</div>";
    renderOverviewChart();
    return;
  }

  el.chesscomGames.innerHTML = state.chesscomGames
    .map((game) => {
      const whiteLine = `${escapeHtml(game.white || "-")} (${escapeHtml(game.white_rating || "-")})`;
      const blackLine = `${escapeHtml(game.black || "-")} (${escapeHtml(game.black_rating || "-")})`;
      const resultRaw = String(game.player_result || "").toLowerCase();
      const resultClass = resultRaw.includes("win") || resultRaw === "1"
        ? "result-win"
        : resultRaw.includes("lose") || resultRaw === "0"
          ? "result-loss"
          : "result-draw";
      const resultLabel = game.player_result || "-";
      const accuracyValue = parseFiniteNumber(game.last_accuracy);
      const accuracyLabel = accuracyValue !== null ? `${accuracyValue.toFixed(1)}%` : "-";
      const moves = game.moves_full || "-";
      const dateLabel = game.end_time_iso || "-";

      const whiteYou = game.player_side === "white" ? "player-you" : "";
      const blackYou = game.player_side === "black" ? "player-you" : "";
      const accuracyKnown = accuracyValue !== null;
      const accuracyPct = accuracyKnown
        ? Math.max(0, Math.min(100, accuracyValue))
        : 54;
      const accuracyClass = accuracyKnown ? "" : "no-data";

      return `
        <div class="history-row" data-game-id="${game.game_id}">
          <div class="players-cell">
            <div class="player-line ${whiteYou}">${whiteLine}</div>
            <div class="player-line ${blackYou}">${blackLine}</div>
          </div>
          <div class="${resultClass}">${escapeHtml(resultLabel)}</div>
          <div class="mini-graph">
            <div class="accuracy-mini-graph ${accuracyClass}">
              <span class="accuracy-fill" style="width:${accuracyPct.toFixed(1)}%"></span>
            </div>
            <div class="mini-label">${accuracyLabel}</div>
          </div>
          <div>${moves}</div>
          <div>${escapeHtml(dateLabel)}</div>
          <div>
            <button
              class="review-btn"
              type="button"
              data-action="review"
              data-game-id="${game.game_id}"
              data-side="${game.player_side || "white"}"
              ${state.analysisBusy ? "disabled" : ""}>
              Review
            </button>
          </div>
        </div>
      `;
    })
    .join("");

  [...el.chesscomGames.querySelectorAll("button[data-action='review']")].forEach((btn) => {
    btn.addEventListener("click", async () => {
      const gameId = btn.dataset.gameId;
      const side = btn.dataset.side || "white";
      await analyzeChesscomGame(gameId, side, btn);
    });
  });
  renderOverviewChart();
}

function renderOverviewChart() {
  if (!el.overviewChart) {
    return;
  }

  const games = [...state.chesscomGames].sort(
    (a, b) => Number(a.end_time || 0) - Number(b.end_time || 0)
  );
  if (!games.length) {
    el.overviewChart.innerHTML = "<div class='history-empty'>Загрузите игры для построения графика.</div>";
    return;
  }

  const width = 900;
  const height = 112;
  const padX = 10;
  const padY = 10;
  const spanX = width - padX * 2;
  const spanY = height - padY * 2;

  const ratingSeries = games.map((game) => {
    const side = game.player_side === "black" ? "black" : "white";
    return parseFiniteNumber(side === "white" ? game.white_rating : game.black_rating);
  });
  const accuracySeries = games.map((game) => {
    const accuracy = parseFiniteNumber(game.last_accuracy);
    return accuracy !== null ? Math.max(0, Math.min(100, accuracy)) : null;
  });

  const ratingValues = ratingSeries.filter((value) => Number.isFinite(value));
  let ratingMin = ratingValues.length ? Math.min(...ratingValues) : 0;
  let ratingMax = ratingValues.length ? Math.max(...ratingValues) : 1;
  if (ratingMax <= ratingMin) {
    ratingMax = ratingMin + 1;
  }
  const ratingPad = Math.max(10, (ratingMax - ratingMin) * 0.08);
  ratingMin -= ratingPad;
  ratingMax += ratingPad;

  const xAt = (idx) => games.length === 1
    ? width / 2
    : padX + (idx / (games.length - 1)) * spanX;
  const yFromRating = (rating) => padY + ((ratingMax - rating) / (ratingMax - ratingMin)) * spanY;
  const yFromAccuracy = (accuracy) => padY + ((100 - accuracy) / 100) * spanY;

  const ratingPoints = ratingSeries
    .map((rating, idx) => Number.isFinite(rating) ? `${xAt(idx).toFixed(2)},${yFromRating(rating).toFixed(2)}` : null)
    .filter(Boolean)
    .join(" ");
  const accuracyPoints = accuracySeries
    .map((accuracy, idx) => Number.isFinite(accuracy) ? `${xAt(idx).toFixed(2)},${yFromAccuracy(accuracy).toFixed(2)}` : null)
    .filter(Boolean)
    .join(" ");

  const ratingDots = ratingSeries
    .map((rating, idx) => {
      if (!Number.isFinite(rating)) {
        return "";
      }
      return `<circle cx="${xAt(idx).toFixed(2)}" cy="${yFromRating(rating).toFixed(2)}" r="2.6" fill="#7aaeff" />`;
    })
    .join("");
  const accuracyDots = accuracySeries
    .map((accuracy, idx) => {
      if (!Number.isFinite(accuracy)) {
        return "";
      }
      return `<circle cx="${xAt(idx).toFixed(2)}" cy="${yFromAccuracy(accuracy).toFixed(2)}" r="2.6" fill="#95ca5f" />`;
    })
    .join("");

  el.overviewChart.innerHTML = `
    <div class="overview-legend">
      <span><span class="legend-dot legend-rating"></span>Rating</span>
      <span><span class="legend-dot legend-accuracy"></span>Accuracy</span>
    </div>
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
      <line x1="${padX}" y1="${padY}" x2="${width - padX}" y2="${padY}" stroke="#4c4b47" stroke-width="1" />
      <line x1="${padX}" y1="${(padY + height) / 2}" x2="${width - padX}" y2="${(padY + height) / 2}" stroke="#3c3a36" stroke-width="1" />
      <line x1="${padX}" y1="${height - padY}" x2="${width - padX}" y2="${height - padY}" stroke="#4c4b47" stroke-width="1" />
      ${ratingPoints ? `<polyline points="${ratingPoints}" fill="none" stroke="#7aaeff" stroke-width="2.0" />` : ""}
      ${accuracyPoints ? `<polyline points="${accuracyPoints}" fill="none" stroke="#95ca5f" stroke-width="2.0" />` : ""}
      ${ratingDots}
      ${accuracyDots}
    </svg>
  `;
}

function updateGameStatsAfterAnalysis(gameId, analysisData) {
  const item = state.chesscomGames.find((game) => game.game_id === gameId);
  if (!item) {
    return;
  }
  if (typeof analysisData.overall_accuracy === "number") {
    item.last_accuracy = analysisData.overall_accuracy;
  }
  if (Array.isArray(analysisData.mainline_uci)) {
    item.moves_full = Math.ceil(analysisData.mainline_uci.length / 2);
  }
  if (!analysisData.cached) {
    item.saved_analyses = Number(item.saved_analyses || 0) + 1;
  }
}

async function loadChesscomGames() {
  clearError();
  const username = String(el.chesscomUsername.value || "").trim();
  const maxRaw = Number(el.chesscomMaxGames.value || 25);
  const maxGames = Number.isFinite(maxRaw) ? Math.max(1, Math.min(100, Math.floor(maxRaw))) : 25;

  if (!username) {
    showError("Введите Chess.com username или ссылку профиля.");
    return;
  }
  persistUsername(username);

  setSelectionBusy(true, "Loading...");
  el.chesscomStatus.textContent = "Загрузка игр...";

  try {
    const response = await fetch(
      `/api/chesscom/player-games?username=${encodeURIComponent(username)}&max_games=${encodeURIComponent(maxGames)}`
    );
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Ошибка загрузки игр.");
    }

    state.chesscomGames = Array.isArray(data.games)
      ? data.games.map((game) => ({
          ...game,
          last_accuracy: typeof game.last_accuracy === "number" ? game.last_accuracy : null,
          moves_full: game.moves_full || null
        }))
      : [];

    renderHistoryList();
    el.chesscomStatus.textContent = `Загружено ${state.chesscomGames.length} игр для ${data.username}.`;
  } catch (error) {
    showError(error.message);
    el.chesscomStatus.textContent = "Ошибка загрузки игр.";
  } finally {
    setSelectionBusy(false);
  }
}

async function loadCachedGames() {
  clearError();
  const username = String(el.chesscomUsername.value || "").trim();
  const maxRaw = Number(el.chesscomMaxGames.value || 200);
  const maxGames = Number.isFinite(maxRaw) ? Math.max(1, Math.min(500, Math.floor(maxRaw))) : 200;
  const query = new URLSearchParams();
  query.set("max_games", String(maxGames));
  if (username) {
    query.set("username", username);
  }

  try {
    const response = await fetch(`/api/chesscom/cached-games?${query.toString()}`);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Ошибка загрузки локальной истории.");
    }

    state.chesscomGames = Array.isArray(data.games)
      ? data.games.map((game) => ({
          ...game,
          last_accuracy: typeof game.last_accuracy === "number" ? game.last_accuracy : null,
          moves_full: game.moves_full || null
        }))
      : [];

    renderHistoryList();
    if (state.chesscomGames.length) {
      el.chesscomStatus.textContent = `История из кэша: ${state.chesscomGames.length} игр.`;
    } else {
      el.chesscomStatus.textContent = "Кэш пуст. Нажмите загрузить игры.";
    }
  } catch (error) {
    showError(error.message);
  }
}

function renderSummary() {
  if (!state.analysis) {
    el.overallAccuracy.textContent = "-";
    el.gameMeta.textContent = "-";
    return;
  }

  const accuracy = state.analysis.overall_accuracy;
  const game = state.analysis.game || {};
  const opening = [game.eco, game.opening].filter(Boolean).join(" ");
  el.overallAccuracy.textContent = typeof accuracy === "number" ? `${accuracy.toFixed(1)}%` : "-";
  el.gameMeta.textContent = [game.result || "*", game.date || "", opening].filter(Boolean).join(" | ");
}

function renderCategoryChips() {
  if (!state.analysis) {
    el.categoryChips.innerHTML = "";
    return;
  }

  const chips = ["All", ...CATEGORY_ORDER]
    .map((name) => {
      const count = name === "All"
        ? state.analysis.player_moves.length
        : state.analysis.counts[name] || 0;
      const active = name === state.selectedCategory ? "active" : "";
      return `<button class="chip ${active}" type="button" data-category="${name}">${name}: ${count}</button>`;
    })
    .join("");

  el.categoryChips.innerHTML = chips;
  [...el.categoryChips.querySelectorAll(".chip")].forEach((btn) => {
    btn.addEventListener("click", () => {
      setCategory(btn.dataset.category);
    });
  });
}

function buildMainlineRows(analysis) {
  const rows = [];
  let chess = null;
  try {
    chess = createChess(analysis.start_fen);
  } catch (error) {
    return rows;
  }

  analysis.mainline_uci.forEach((uci, idx) => {
    const ply = idx + 1;
    const turn = chess.turn() === "w" ? "white" : "black";
    const moveObj = uciToMoveObj(uci);
    let san = uci;

    if (moveObj) {
      const move = chess.move(moveObj);
      if (move) {
        san = move.san || uci;
      }
    }

    const playerMove = state.playerMoveByPly.get(ply) || null;
    const entry = {
      ply,
      side: turn,
      uci,
      san,
      category: playerMove ? playerMove.category : null,
      accuracy: playerMove ? playerMove.accuracy : null,
      cpLoss: playerMove ? playerMove.cp_loss : null
    };

    const rowIndex = Math.floor((ply - 1) / 2);
    if (!rows[rowIndex]) {
      rows[rowIndex] = { moveNo: rowIndex + 1, white: null, black: null };
    }
    rows[rowIndex][turn] = entry;
  });

  return rows;
}

function rowMatchesCategory(row) {
  if (!state.analysis || state.selectedCategory === "All") {
    return true;
  }
  const side = (state.analysis.settings && state.analysis.settings.side) || "white";
  const entry = row[side];
  return Boolean(entry && entry.category === state.selectedCategory);
}

function variationMoveLabel(move) {
  const ply = Number(move && move.ply);
  const san = String((move && move.san) || "").trim() || "?";
  if (!Number.isFinite(ply) || ply <= 0) {
    return san;
  }
  const prefix = ply % 2 === 1 ? `${Math.ceil(ply / 2)}. ` : `${Math.ceil(ply / 2)}... `;
  return `${prefix}${san}`;
}

function renderMoveCell(entry) {
  if (!entry) {
    return "<td class='move-cell move-empty'>-</td>";
  }

  const analyzedMove = state.playerMoveByPly.has(entry.ply);
  const isCursor = state.selectedPly === null && state.currentPly >= 0 && entry.ply === state.currentPly;
  const active = state.selectedPly === entry.ply || isCursor ? "active" : "";
  const playerTurn = analyzedMove ? "player-turn" : "";
  const categoryClass = analyzedMove && entry.category ? categoryInfo(entry.category).className : "";

  const titleParts = [entry.san];
  if (entry.category) {
    titleParts.push(entry.category);
  }
  if (typeof entry.accuracy === "number") {
    titleParts.push(`Accuracy ${entry.accuracy.toFixed(2)}%`);
  }
  if (typeof entry.cpLoss === "number") {
    titleParts.push(`Loss ${entry.cpLoss} cp`);
  }

  return `
    <td
      class="move-cell ${active} ${playerTurn} ${categoryClass}"
      data-ply="${entry.ply}"
      title="${escapeHtml(titleParts.join(" | "))}">
      ${escapeHtml(entry.san)}
    </td>
  `;
}

function renderMoveList() {
  if (!state.analysis) {
    el.moveList.innerHTML = "<div class='history-empty'>Выберите игру для анализа.</div>";
    return;
  }

  const rows = state.mainlineRows
    .map((row, idx) => ({ row, idx }))
    .filter(({ row }) => rowMatchesCategory(row));
  if (!rows.length && !(state.manualLine && state.selectedCategory === "All")) {
    el.moveList.innerHTML = "<div class='history-empty'>Нет ходов для выбранной категории.</div>";
    return;
  }

  const variationBaseRow = state.manualLine && Number.isFinite(Number(state.manualLine.basePly))
    ? Math.max(0, Math.floor(Number(state.manualLine.basePly) / 2))
    : -1;

  el.moveList.innerHTML = `
    <table class="move-table">
      <thead>
        <tr>
          <th>#</th>
          <th>White</th>
          <th>Black</th>
        </tr>
      </thead>
      <tbody>
        ${rows
          .map(({ row, idx }) => `
            <tr>
              <td class="move-num">${row.moveNo}.</td>
              ${renderMoveCell(row.white)}
              ${renderMoveCell(row.black)}
            </tr>
            ${
              state.selectedCategory === "All" &&
              state.manualLine &&
              Array.isArray(state.manualLine.moves) &&
              state.manualLine.moves.length &&
              idx === variationBaseRow
                ? `
                  <tr class="variation-row">
                    <td class="move-num variation-prefix">|</td>
                    <td class="variation-line" colspan="2">
                      ${state.manualLine.moves
                        .map((move, moveIdx) => `
                          <button
                            type="button"
                            class="variation-move ${state.selectedVariationIndex === moveIdx ? "active" : ""}"
                            data-variation-index="${moveIdx}">
                            ${escapeHtml(variationMoveLabel(move))}
                          </button>
                        `)
                        .join("")}
                    </td>
                  </tr>
                `
                : ""
            }
          `)
          .join("")}
      </tbody>
    </table>
  `;

  [...el.moveList.querySelectorAll(".move-cell[data-ply]")].forEach((cell) => {
    cell.addEventListener("click", () => {
      const ply = Number(cell.dataset.ply);
      if (!Number.isFinite(ply)) {
        return;
      }
      if (state.playerMoveByPly.has(ply)) {
        selectMoveByPly(ply);
        return;
      }
      state.selectedPly = ply;
      state.selectedVariationIndex = null;
      goToPly(ply);
      renderMoveList();
      renderAccuracyChart();
    });
  });

  [...el.moveList.querySelectorAll(".variation-move[data-variation-index]")].forEach((btn) => {
    btn.addEventListener("click", () => {
      const idx = Number(btn.dataset.variationIndex);
      if (!Number.isFinite(idx)) {
        return;
      }
      selectVariationMove(idx);
    });
  });
}

function selectVariationMove(index) {
  if (!state.manualLine || !Array.isArray(state.manualLine.moves)) {
    return;
  }
  const move = state.manualLine.moves[index];
  if (!move || !move.fenAfter || !ensureBoardReady()) {
    return;
  }

  clearBoardMoveHints();
  state.selectedVariationIndex = index;
  state.selectedPly = null;
  state.currentPly = -1;
  state.chess = createChess(move.fenAfter);
  state.board.position(move.fenAfter, false);
  setStatus(`Вариант: ${variationMoveLabel(move)}`);
  renderMoveList();
  renderAccuracyChart();
  scheduleLivePositionAnalysis(80);
  requestAnimationFrame(drawArrows);
}

function renderHighlightsMeta() {
  if (!state.analysis) {
    el.highlightPlayer.textContent = "-";
    el.highlightOpponent.textContent = "-";
    el.highlightPlayerAccuracy.textContent = "-";
    el.highlightOpponentAccuracy.textContent = "-";
    return;
  }

  const side = analysisSide();
  el.highlightPlayer.textContent = side === "white" ? "Белые" : "Черные";
  el.highlightOpponent.textContent = side === "white" ? "Черные" : "Белые";

  const accuracy = state.analysis.overall_accuracy;
  el.highlightPlayerAccuracy.textContent = typeof accuracy === "number" ? accuracy.toFixed(1) : "-";
  el.highlightOpponentAccuracy.textContent = "-";
}

function renderHighlightsBreakdown() {
  if (!state.analysis) {
    el.highlightsBreakdown.innerHTML = "";
    return;
  }

  const rows = CATEGORY_ORDER.map((category) => {
    const count = state.analysis.counts[category] || 0;
    const active = state.selectedCategory === category ? "active" : "";
    return `
      <button class="highlight-row ${active}" type="button" data-category="${category}">
        <span class="highlight-label ${categoryInfo(category).className}">${category}</span>
        <span class="highlight-count">${count}</span>
      </button>
    `;
  }).join("");

  el.highlightsBreakdown.innerHTML = rows;
  [...el.highlightsBreakdown.querySelectorAll(".highlight-row")].forEach((row) => {
    row.addEventListener("click", () => {
      setCategory(row.dataset.category);
    });
  });
}

function formatCp(cpValue) {
  if (!Number.isFinite(cpValue)) {
    return "-";
  }
  const rounded = Math.round(cpValue);
  const prefix = rounded > 0 ? "+" : "";
  return `${prefix}${rounded}`;
}

function scoreLabelLikeScale(cpWhite, mateWhite) {
  const mate = parseFiniteNumber(mateWhite);
  if (mate !== null && mate !== 0) {
    return `#${mate}`;
  }
  const cp = parseFiniteNumber(cpWhite);
  if (cp === null) {
    return "-";
  }
  return `${cp >= 0 ? "+" : ""}${(cp / 100).toFixed(2)}`;
}

function toWhiteCpFromTurn(cpValue, turnSide) {
  const cp = parseFiniteNumber(cpValue);
  if (cp === null) {
    return null;
  }
  return turnSide === "black" ? -cp : cp;
}

function toWhiteMateFromTurn(mateValue, turnSide) {
  const mate = parseFiniteNumber(mateValue);
  if (mate === null) {
    return null;
  }
  return turnSide === "black" ? -mate : mate;
}

function chartPointsFromAnalysis() {
  if (!state.analysis) {
    return [];
  }
  const sortByPly = (list) => [...list].sort((a, b) => Number(a.ply) - Number(b.ply));

  const fromEvalPoints = (Array.isArray(state.analysis.eval_points) ? state.analysis.eval_points : [])
    .map((point) => {
      const ply = parseFiniteNumber(point && point.ply);
      const cpWhite = parseFiniteNumber(
        point && (point.cp_white ?? point.cpWhite ?? point.cp)
      );
      if (ply === null || cpWhite === null) {
        return null;
      }
      const mateWhite = parseFiniteNumber(point && (point.mate_white ?? point.mateWhite ?? point.mate));
      return {
        ply,
        cpWhite,
        mateWhite,
        side: point && point.side ? point.side : null,
        san: point && point.san ? point.san : "",
        category: (state.playerMoveByPly.get(Number(ply)) || {}).category || null
      };
    })
    .filter(Boolean);
  if (fromEvalPoints.length) {
    return sortByPly(fromEvalPoints);
  }

  const fromPlayerMoves = (Array.isArray(state.analysis.player_moves) ? state.analysis.player_moves : [])
    .map((move) => {
      const ply = parseFiniteNumber(move && move.ply);
      const playedCp = parseFiniteNumber(move && (move.played_eval_cp ?? move.played_cp ?? move.cp));
      if (ply === null || playedCp === null) {
        return null;
      }
      const side = move && move.side === "black" ? "black" : "white";
      return {
        ply,
        cpWhite: side === "white" ? playedCp : -playedCp,
        mateWhite: null,
        side,
        san: move && move.san ? move.san : "",
        category: move && move.category ? move.category : null
      };
    })
    .filter(Boolean);
  if (fromPlayerMoves.length) {
    return sortByPly(fromPlayerMoves);
  }

  const mainline = Array.isArray(state.analysis.mainline_uci) ? state.analysis.mainline_uci : [];
  if (!mainline.length) {
    return [];
  }

  return mainline.map((uci, idx) => ({
    ply: idx + 1,
    cpWhite: 0,
    mateWhite: null,
    side: (idx + 1) % 2 === 1 ? "white" : "black",
    san: String(uci || ""),
    category: (state.playerMoveByPly.get(idx + 1) || {}).category || null
  }));
}

function scoreLabelFromPerspective(cpValue, mateValue) {
  const mate = parseFiniteNumber(mateValue);
  if (mate !== null && mate !== 0) {
    return `#${mate}`;
  }
  const cp = parseFiniteNumber(cpValue);
  if (cp === null) {
    return "-";
  }
  return `${cp >= 0 ? "+" : ""}${(cp / 100).toFixed(2)}`;
}

function effectiveScoreCp(cpValue, mateValue) {
  const mate = parseFiniteNumber(mateValue);
  if (mate !== null && mate !== 0) {
    const distance = Math.max(1, Math.min(40, Math.abs(mate)));
    const mateScore = 3200 - distance * 26;
    return mate > 0 ? mateScore : -mateScore;
  }
  const cp = parseFiniteNumber(cpValue);
  return cp === null ? 0 : cp;
}

function jumpToChartPly(ply) {
  if (!Number.isFinite(ply) || ply < 0) {
    return;
  }
  if (state.playerMoveByPly.has(ply)) {
    selectMoveByPly(ply);
    return;
  }
  state.selectedPly = ply;
  state.selectedVariationIndex = null;
  goToPly(ply);
  renderMoveList();
  renderAccuracyChart();
}

function renderAccuracyChart() {
  const points = chartPointsFromAnalysis();
  if (!state.analysis || !points.length) {
    el.accuracyChart.innerHTML = "<div class='history-empty'>График появится после анализа.</div>";
    return;
  }

  const width = 420;
  const height = 106;
  const padX = 12;
  const padY = 10;
  const plotWidth = width - padX * 2;
  const plotHeight = height - padY * 2;
  const midY = padY + plotHeight / 2;

  const side = analysisSide() === "black" ? "black" : "white";
  const gridColor = "rgba(68, 70, 74, 0.2)";
  const zeroLineColor = "rgba(60, 62, 66, 0.48)";
  const topAreaFill = "rgba(104, 111, 118, 0.9)";
  const bottomAreaFill = "rgba(238, 238, 232, 0.98)";
  const lineMain = "#f2f2ef";
  const lineShadow = "rgba(36, 38, 42, 0.36)";

  const pointAt = (idx, point, totalPoints) => {
    const total = Math.max(1, Number(totalPoints) || 1);
    const x = total === 1 ? width / 2 : padX + (idx / (total - 1)) * plotWidth;
    const cpWhite = parseFiniteNumber(point.cpWhite) ?? 0;
    const mateWhite = parseFiniteNumber(point.mateWhite);
    const playerCp = side === "white" ? cpWhite : -cpWhite;
    const playerMate = mateWhite === null ? null : (side === "white" ? mateWhite : -mateWhite);
    const normalized = normalizedEvalForDisplay(playerCp, playerMate);
    const y = midY + normalized * (plotHeight / 2);
    return { ...point, x, y, cpWhite, mateWhite, playerCp, playerMate, normalized };
  };
  const prepared = points
    .map((point, idx) => pointAt(idx, point, points.length))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  let usablePrepared = prepared;
  if (!usablePrepared.length) {
    const mainline = Array.isArray(state.analysis.mainline_uci) ? state.analysis.mainline_uci : [];
    const fallbackPoints = mainline.length
      ? mainline.map((uci, idx) => {
          const ply = idx + 1;
          const evalPoint = state.evalByPly.get(ply) || {};
          return {
            ply,
            cpWhite: parseFiniteNumber(evalPoint.cpWhite) ?? 0,
            mateWhite: parseFiniteNumber(evalPoint.mateWhite),
            side: ply % 2 === 1 ? "white" : "black",
            san: String(uci || ""),
            category: (state.playerMoveByPly.get(ply) || {}).category || null
          };
        })
      : [{ ply: 0, cpWhite: 0, mateWhite: null, side, san: "", category: null }];

    usablePrepared = fallbackPoints
      .map((point, idx) => pointAt(idx, point, fallbackPoints.length))
      .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  }
  if (!usablePrepared.length) {
    usablePrepared = [
      {
        ply: 0,
        x: width / 2,
        y: midY,
        cpWhite: 0,
        mateWhite: null,
        playerCp: 0,
        playerMate: null,
        normalized: 0,
        san: "",
        category: null
      }
    ];
  }
  usablePrepared = [...usablePrepared].sort((a, b) => Number(a.ply) - Number(b.ply));
  const currentPly = state.selectedPly !== null ? state.selectedPly : state.currentPly;
  const currentPoint = usablePrepared.find((point) => point.ply === currentPly) || null;
  const currentGuide = currentPoint
    ? `<line x1="${currentPoint.x.toFixed(2)}" y1="${padY}" x2="${currentPoint.x.toFixed(
        2
      )}" y2="${height - padY}" stroke="${gridColor}" stroke-width="1" stroke-dasharray="3 3" />`
    : "";

  const deltaByPly = new Map();
  const indexedPrepared = new Map(usablePrepared.map((point) => [Number(point.ply), point]));
  usablePrepared.forEach((point, idx) => {
    const ply = Number(point.ply);
    if (!Number.isFinite(ply) || ply <= 0) {
      return;
    }
    const prevPoint = idx > 0 ? usablePrepared[idx - 1] : null;
    const prevScore = prevPoint ? effectiveScoreCp(prevPoint.playerCp, prevPoint.playerMate) : 0;
    const currentScore = effectiveScoreCp(point.playerCp, point.playerMate);
    deltaByPly.set(ply, currentScore - prevScore);
  });

  const rankedPlayerMoves = usablePrepared
    .filter((point) => Number(point.ply) > 0 && String(point.side || "") === side)
    .map((point) => ({
      ply: Number(point.ply),
      deltaCp: Number(deltaByPly.get(Number(point.ply)) || 0)
    }));
  const bestPlys = new Set(
    rankedPlayerMoves
      .filter((item) => item.deltaCp > 0)
      .sort((a, b) => b.deltaCp - a.deltaCp)
      .slice(0, 3)
      .map((item) => item.ply)
  );
  const worstPlys = new Set(
    rankedPlayerMoves
      .filter((item) => item.deltaCp < 0)
      .sort((a, b) => a.deltaCp - b.deltaCp)
      .slice(0, 3)
      .map((item) => item.ply)
  );
  const keyCategories = new Set(["Blunder", "Mistake", "Miss", "Brilliant", "Great"]);
  const categoryPlys = usablePrepared
    .filter((point) => Number(point.ply) > 0 && keyCategories.has(String(point.category || "")))
    .map((point) => Number(point.ply));
  const swingPlys = rankedPlayerMoves
    .filter((item) => Math.abs(item.deltaCp) >= 90)
    .sort((a, b) => Math.abs(b.deltaCp) - Math.abs(a.deltaCp))
    .slice(0, 8)
    .map((item) => item.ply);
  const extremaPlys = [];
  for (let idx = 1; idx < usablePrepared.length - 1; idx += 1) {
    const prev = usablePrepared[idx - 1];
    const cur = usablePrepared[idx];
    const next = usablePrepared[idx + 1];
    const d1 = (cur.playerCp || 0) - (prev.playerCp || 0);
    const d2 = (next.playerCp || 0) - (cur.playerCp || 0);
    const signChange = (d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0);
    const prominence = Math.abs(d1) + Math.abs(d2);
    if (signChange && prominence >= 80) {
      extremaPlys.push(Number(cur.ply));
    }
  }
  const firstPly = usablePrepared.length ? Number(usablePrepared[0].ply) : null;
  const lastPly = usablePrepared.length
    ? Number(usablePrepared[usablePrepared.length - 1].ply)
    : null;
  const mustKeepPlys = new Set([
    ...bestPlys,
    ...worstPlys,
    ...[firstPly, lastPly, currentPly].filter((value) => Number.isFinite(value) && value > 0)
  ]);
  const allImportantCandidates = new Set([
    ...mustKeepPlys,
    ...categoryPlys,
    ...swingPlys,
    ...extremaPlys
  ]);
  const maxVisibleMarkers = 22;
  let visibleMarkerPlys = allImportantCandidates;
  if (allImportantCandidates.size > maxVisibleMarkers) {
    const scored = [...allImportantCandidates]
      .map((ply) => {
        const point = indexedPrepared.get(Number(ply));
        const category = String((point && point.category) || "");
        const delta = Math.abs(Number(deltaByPly.get(Number(ply)) || 0));
        const categoryWeight =
          category === "Blunder" || category === "Miss"
            ? 240
            : category === "Mistake"
              ? 190
              : category === "Brilliant"
                ? 180
                : category === "Great"
                  ? 140
                  : 0;
        const mustKeepWeight = mustKeepPlys.has(Number(ply)) ? 10000 : 0;
        return { ply: Number(ply), score: mustKeepWeight + categoryWeight + delta };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, maxVisibleMarkers)
      .map((item) => item.ply);
    visibleMarkerPlys = new Set(scored);
  }

  const linePoints = usablePrepared
    .map((point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`)
    .join(" ");
  const firstPoint = usablePrepared[0];
  const lastPoint = usablePrepared[usablePrepared.length - 1];
  const topPolygonPoints = firstPoint
    ? `${firstPoint.x.toFixed(2)},${padY.toFixed(2)} ${linePoints} ${lastPoint.x.toFixed(
        2
      )},${padY.toFixed(2)}`
    : "";
  const bottomPolygonPoints = firstPoint
    ? `${firstPoint.x.toFixed(2)},${(height - padY).toFixed(2)} ${linePoints} ${lastPoint.x.toFixed(
        2
      )},${(height - padY).toFixed(2)}`
    : "";

  const circles = usablePrepared
    .filter((point) => visibleMarkerPlys.has(Number(point.ply)))
    .map((point) => {
      const ply = Number(point.ply);
      const deltaCp = Number(deltaByPly.get(ply) || 0);
      const isBest = bestPlys.has(ply);
      const isWorst = worstPlys.has(ply);
      const fill = isBest ? "#f2a75c" : isWorst ? "#e35c54" : CATEGORY_COLORS[point.category] || "#7a828b";
      const scoreLabel = scoreLabelLikeScale(point.cpWhite, point.mateWhite);
      const impactLabel = `${deltaCp >= 0 ? "+" : ""}${(deltaCp / 100).toFixed(2)}`;
      const title = `${point.ply}. ${point.san || ""} | Eval ${scoreLabel} | Impact ${impactLabel}`;
      const isCursor =
        state.selectedPly === ply ||
        (state.selectedPly === null && state.currentPly >= 0 && state.currentPly === ply);
      const radius = isCursor ? 4.4 : isBest || isWorst ? 3.6 : 2.9;
      const stroke = isCursor
        ? "#f6f4ef"
        : isBest
          ? "rgba(120,72,28,0.8)"
          : isWorst
            ? "rgba(115,22,18,0.75)"
            : "rgba(28,28,28,0.22)";
      const strokeWidth = isCursor ? "0.9" : isBest || isWorst ? "0.65" : "0.4";
      return `
        <circle
          class="chart-point ${isBest ? "chart-point-best" : ""} ${isWorst ? "chart-point-worst" : ""}"
          data-ply="${ply}"
          data-eval="${escapeHtml(scoreLabelFromPerspective(point.playerCp, point.playerMate))}"
          data-impact="${escapeHtml(impactLabel)}"
          cx="${point.x.toFixed(2)}"
          cy="${point.y.toFixed(2)}"
          r="${radius}"
          fill="${fill}"
          stroke="${stroke}"
          stroke-width="${strokeWidth}">
          <title>${escapeHtml(title)}</title>
        </circle>
      `;
    })
    .join("");

  el.accuracyChart.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">
      <defs>
        <clipPath id="adv-clip">
          <rect x="${padX}" y="${padY}" width="${plotWidth}" height="${plotHeight}" />
        </clipPath>
      </defs>
      <rect x="${padX}" y="${padY}" width="${plotWidth}" height="${plotHeight}" fill="${bottomAreaFill}" />
      ${topPolygonPoints ? `<polygon points="${topPolygonPoints}" fill="${topAreaFill}" clip-path="url(#adv-clip)" />` : ""}
      ${bottomPolygonPoints ? `<polygon points="${bottomPolygonPoints}" fill="${bottomAreaFill}" clip-path="url(#adv-clip)" />` : ""}
      <line x1="${padX}" y1="${padY + plotHeight * 0.25}" x2="${width - padX}" y2="${padY + plotHeight * 0.25}" stroke="${gridColor}" stroke-width="0.6" />
      <line x1="${padX}" y1="${padY + plotHeight * 0.75}" x2="${width - padX}" y2="${padY + plotHeight * 0.75}" stroke="${gridColor}" stroke-width="0.6" />
      <line x1="${padX}" y1="${midY}" x2="${width - padX}" y2="${midY}" stroke="${zeroLineColor}" stroke-width="1.1" />
      ${linePoints ? `<polyline points="${linePoints}" fill="none" stroke="${lineShadow}" stroke-width="2.6" clip-path="url(#adv-clip)" />` : ""}
      ${linePoints ? `<polyline points="${linePoints}" fill="none" stroke="${lineMain}" stroke-width="1.55" clip-path="url(#adv-clip)" />` : ""}
      ${currentGuide}
      ${circles}
    </svg>
    <div class="chart-hover-tooltip hidden"></div>
  `;

  const svg = el.accuracyChart.querySelector("svg");
  const tooltip = el.accuracyChart.querySelector(".chart-hover-tooltip");
  if (!svg || !tooltip) {
    return;
  }

  const nearestPointByClientX = (clientX) => {
    const rect = svg.getBoundingClientRect();
    if (!rect.width) {
      return null;
    }
    const viewX = ((clientX - rect.left) / rect.width) * width;
    let nearest = null;
    let nearestDx = Infinity;
    usablePrepared.forEach((point) => {
      const dx = Math.abs(point.x - viewX);
      if (dx < nearestDx) {
        nearest = point;
        nearestDx = dx;
      }
    });
    return nearest;
  };

  const hideTooltip = () => {
    tooltip.classList.add("hidden");
  };

  const showTooltip = (point) => {
    if (!point) {
      hideTooltip();
      return;
    }
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      hideTooltip();
      return;
    }
    const localX = ((point.x - 0) / width) * rect.width;
    const localY = ((point.y - 0) / height) * rect.height;
    const impactCp = Number(deltaByPly.get(Number(point.ply)) || 0);
    const impactLabel = `${impactCp >= 0 ? "+" : ""}${(impactCp / 100).toFixed(2)}`;
    const evalLabel = scoreLabelFromPerspective(point.playerCp, point.playerMate);
    tooltip.innerHTML = `<strong>${impactLabel}</strong><span>eval ${escapeHtml(evalLabel)}</span>`;
    tooltip.style.left = `${Math.max(12, Math.min(rect.width - 12, localX))}px`;
    tooltip.style.top = `${Math.max(14, localY - 8)}px`;
    tooltip.classList.remove("hidden");
  };

  svg.addEventListener("mousemove", (event) => {
    const nearest = nearestPointByClientX(event.clientX);
    showTooltip(nearest);
  });
  svg.addEventListener("mouseleave", hideTooltip);
  svg.addEventListener("click", (event) => {
    const nearest = nearestPointByClientX(event.clientX);
    if (!nearest) {
      return;
    }
    jumpToChartPly(Number(nearest.ply));
  });

  [...el.accuracyChart.querySelectorAll(".chart-point")].forEach((pointNode) => {
    pointNode.addEventListener("mouseenter", () => {
      const ply = Number(pointNode.dataset.ply);
      const point = indexedPrepared.get(ply) || null;
      showTooltip(point);
    });
  });
}

function renderHighlights() {
  renderHighlightsMeta();
  renderHighlightsBreakdown();
  renderAccuracyChart();
}

function analysisSide() {
  return (state.analysis && state.analysis.settings && state.analysis.settings.side) || "white";
}

function toPerspectiveCp(cpWhite) {
  const cp = Number(cpWhite);
  if (!Number.isFinite(cp)) {
    return null;
  }
  return analysisSide() === "black" ? -cp : cp;
}

function toPerspectiveMate(mateWhite) {
  const mate = Number(mateWhite);
  if (!Number.isFinite(mate)) {
    return null;
  }
  return analysisSide() === "black" ? -mate : mate;
}

function evalPointForPly(ply) {
  if (!state.analysis) {
    return null;
  }
  if (ply <= 0) {
    return { cpWhite: 0, mateWhite: null };
  }

  const direct = state.evalByPly.get(ply);
  if (direct && Number.isFinite(Number(direct.cpWhite))) {
    return {
      cpWhite: Number(direct.cpWhite),
      mateWhite: Number.isFinite(Number(direct.mateWhite)) ? Number(direct.mateWhite) : null
    };
  }

  const list = Array.isArray(state.analysis.eval_points) ? state.analysis.eval_points : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const point = list[i];
    const pointPly = Number(point && point.ply);
    if (
      Number.isFinite(pointPly) &&
      pointPly <= ply &&
      Number.isFinite(Number(point.cp_white))
    ) {
      return {
        cpWhite: Number(point.cp_white),
        mateWhite: Number.isFinite(Number(point.mate_white)) ? Number(point.mate_white) : null
      };
    }
  }

  return { cpWhite: 0, mateWhite: null };
}

function normalizedEvalForDisplay(cpPerspective, matePerspective) {
  if (Number.isFinite(matePerspective) && matePerspective !== 0) {
    return Math.sign(matePerspective);
  }
  if (!Number.isFinite(cpPerspective)) {
    return 0;
  }
  const clamped = Math.max(-590, Math.min(590, cpPerspective));
  return clamped / 600;
}

function isPlayerFavored(cpWhite, mateWhite) {
  const side = analysisSide();
  if (Number.isFinite(mateWhite) && mateWhite !== 0) {
    return side === "white" ? mateWhite > 0 : mateWhite < 0;
  }
  if (!Number.isFinite(cpWhite) || Math.abs(cpWhite) < 1) {
    return null;
  }
  return side === "white" ? cpWhite > 0 : cpWhite < 0;
}

function updateEvalTickLabels() {
  const side = analysisSide();
  const ticks = [
    { key: "top", value: 6 },
    { key: "top-mid", value: 3 },
    { key: "mid", value: 0 },
    { key: "bot-mid", value: -3 },
    { key: "bot", value: -6 }
  ];

  ticks.forEach((item) => {
    const node = document.querySelector(`[data-tick="${item.key}"]`);
    if (!node) {
      return;
    }
    node.textContent = item.value > 0 ? `+${item.value}` : String(item.value);
    node.classList.remove("tick-favored", "tick-unfavored", "tick-neutral");
    if (item.value === 0) {
      node.classList.add("tick-neutral");
      return;
    }
    const favored = side === "white" ? item.value > 0 : item.value < 0;
    node.classList.add(favored ? "tick-favored" : "tick-unfavored");
  });
}

function syncEvalScaleHeight() {
  if (!el.evalScale) {
    return;
  }
  const boardEl = document.getElementById("board");
  const size = boardEl ? boardEl.clientWidth : 0;
  if (!size) {
    return;
  }
  if (window.innerWidth <= 1040) {
    el.evalScale.style.height = "16px";
    return;
  }
  el.evalScale.style.height = `${Math.round(size)}px`;
}

function updateEvalScale(cpWhite, mateWhite) {
  if (!el.evalScale || !el.evalWhiteZone || !el.evalBlackZone || !el.evalMarker || !el.evalScore) {
    return;
  }

  const side = analysisSide() === "black" ? "black" : "white";
  const cpWhiteValue = Number.isFinite(Number(cpWhite)) ? Number(cpWhite) : 0;
  const mateWhiteValue = Number.isFinite(Number(mateWhite)) ? Number(mateWhite) : null;
  const playerCp = side === "white" ? cpWhiteValue : -cpWhiteValue;
  const playerMate = mateWhiteValue === null ? null : (side === "white" ? mateWhiteValue : -mateWhiteValue);
  const normPlayer = normalizedEvalForDisplay(playerCp, playerMate);
  const bottomShare = Math.max(2, Math.min(98, 50 + normPlayer * 50));
  const topShare = 100 - bottomShare;
  const topColor = side === "white" ? DARK_SIDE_TONE : LIGHT_SIDE_TONE;
  const bottomColor = side === "white" ? LIGHT_SIDE_TONE : DARK_SIDE_TONE;

  el.evalWhiteZone.style.height = `${topShare}%`;
  el.evalBlackZone.style.height = `${bottomShare}%`;
  el.evalWhiteZone.style.background = topColor;
  el.evalBlackZone.style.background = bottomColor;
  el.evalScale.style.setProperty("--white-part", `${topShare}%`);
  el.evalScale.style.setProperty("--black-part", `${bottomShare}%`);
  el.evalMarker.style.top = `calc(${topShare}% - 1px)`;

  let label = `${cpWhiteValue >= 0 ? "+" : ""}${(cpWhiteValue / 100).toFixed(2)}`;
  if (Number.isFinite(mateWhiteValue) && mateWhiteValue !== 0) {
    label = `#${mateWhiteValue}`;
  }

  const favored = isPlayerFavored(cpWhiteValue, mateWhiteValue);
  const hasEval = Math.abs(cpWhiteValue) > 0 || (Number.isFinite(mateWhiteValue) && mateWhiteValue !== 0);
  el.evalScore.textContent = label;
  el.evalScore.classList.toggle("positive", favored === true);
  el.evalScore.classList.toggle("negative", favored === false && hasEval);
  updateEvalTickLabels();
  syncEvalScaleHeight();
}

function updateEvalScaleFromPly(ply) {
  const point = evalPointForPly(ply);
  if (!point) {
    updateEvalScale(0, null);
    return;
  }
  updateEvalScale(point.cpWhite, point.mateWhite);
}

function cpWhiteFromEvalResponse(data) {
  if (!data || !Number.isFinite(Number(data.best_eval_cp))) {
    return null;
  }
  const cpTurn = Number(data.best_eval_cp);
  return data.turn === "black" ? -cpTurn : cpTurn;
}

function mateWhiteFromEvalResponse(data) {
  if (!data || !Number.isFinite(Number(data.best_mate))) {
    return null;
  }
  const mateTurn = Number(data.best_mate);
  return data.turn === "black" ? -mateTurn : mateTurn;
}

function clearBoardMoveHints() {
  const nodes = document.querySelectorAll(
    "#board .drag-source, #board .legal-target, #board .legal-capture"
  );
  nodes.forEach((node) => {
    node.classList.remove("drag-source", "legal-target", "legal-capture");
  });
}

function markSquare(square, className) {
  if (!square || !className) {
    return;
  }
  const node = document.querySelector(`#board .square-${square}`);
  if (node) {
    node.classList.add(className);
  }
}

function showLegalTargets(fromSquare) {
  clearBoardMoveHints();
  if (!state.chess || !fromSquare) {
    return;
  }
  const moves = state.chess.moves({ square: fromSquare, verbose: true });
  if (!moves.length) {
    return;
  }
  markSquare(fromSquare, "drag-source");
  moves.forEach((move) => {
    markSquare(move.to, move.captured ? "legal-capture" : "legal-target");
  });
}

function scheduleLivePositionAnalysis(delayMs = 180) {
  if (state.liveAnalyzeTimer) {
    clearTimeout(state.liveAnalyzeTimer);
    state.liveAnalyzeTimer = null;
  }
  const token = ++state.liveAnalyzeToken;
  state.liveAnalyzeTimer = window.setTimeout(() => {
    state.liveAnalyzeTimer = null;
    void analyzeCurrentPosition({ silent: true, token });
  }, delayMs);
}

function squareCenter(square, boardSize) {
  const file = square.charCodeAt(0) - 97;
  const rank = Number(square.slice(1)) - 1;
  const step = boardSize / 8;

  let x = (file + 0.5) * step;
  let y = (7 - rank + 0.5) * step;

  if (state.board && typeof state.board.orientation === "function" && state.board.orientation() === "black") {
    x = boardSize - x;
    y = boardSize - y;
  }

  return { x, y };
}

function drawArrows() {
  const svg = document.getElementById("arrow-layer");
  const boardEl = document.getElementById("board");
  if (!svg || !boardEl || !state.boardReady) {
    return;
  }

  const size = boardEl.clientWidth;
  if (!size) {
    return;
  }
  syncEvalScaleHeight();

  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.innerHTML = "";

  const colors = ["#2f99ff", "#59b5ff", "#8fd4ff"];
  const widths = [
    Math.max(9.1, size / 48),
    Math.max(7.4, size / 58),
    Math.max(5.5, size / 72)
  ];
  const opacities = [1, 1, 1];

  state.arrows.forEach((arrow, idx) => {
    if (!arrow || !arrow.from || !arrow.to) {
      return;
    }
    const rank = Math.min(2, idx);
    const from = squareCenter(arrow.from, size);
    const to = squareCenter(arrow.to, size);
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (!Number.isFinite(len) || len < 1) {
      return;
    }
    const ux = dx / len;
    const uy = dy / len;
    const px = -uy;
    const py = ux;
    const width = widths[rank];

    const startInset = Math.max(size / 44, width * 0.55);
    const tipInset = Math.max(size / 22, width * 0.75);
    const maxHeadLen = Math.max(8, len - startInset - tipInset - 4);
    const headLen = Math.min(Math.max(width * 2.2, size / 22), maxHeadLen);
    if (!Number.isFinite(headLen) || headLen <= 0) {
      return;
    }
    const headHalf = Math.max(width * 1.05, size / 88);

    const shaftStartX = from.x + ux * startInset;
    const shaftStartY = from.y + uy * startInset;
    const tipX = to.x - ux * tipInset;
    const tipY = to.y - uy * tipInset;
    const baseX = tipX - ux * headLen;
    const baseY = tipY - uy * headLen;
    const leftX = baseX + px * headHalf;
    const leftY = baseY + py * headHalf;
    const rightX = baseX - px * headHalf;
    const rightY = baseY - py * headHalf;

    const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
    line.setAttribute("x1", String(shaftStartX));
    line.setAttribute("y1", String(shaftStartY));
    line.setAttribute("x2", String(baseX));
    line.setAttribute("y2", String(baseY));
    line.setAttribute("stroke", colors[rank]);
    line.setAttribute("stroke-width", String(width));
    line.setAttribute("stroke-linecap", "round");
    line.setAttribute("opacity", String(opacities[rank]));
    svg.appendChild(line);

    const head = document.createElementNS("http://www.w3.org/2000/svg", "polygon");
    head.setAttribute(
      "points",
      `${tipX.toFixed(2)},${tipY.toFixed(2)} ${leftX.toFixed(2)},${leftY.toFixed(2)} ${rightX.toFixed(
        2
      )},${rightY.toFixed(2)}`
    );
    head.setAttribute("fill", colors[rank]);
    head.setAttribute("opacity", String(opacities[rank]));
    svg.appendChild(head);
  });
}

function commitAppliedMove(move, beforeFen, beforePly) {
  const moveUci = `${move.from}${move.to}${move.promotion || ""}`;
  let isMainlineAdvance = false;
  if (state.analysis && Number.isFinite(beforePly) && beforePly >= 0) {
    const expected = state.analysis.mainline_uci[beforePly];
    isMainlineAdvance = Boolean(expected && expected === moveUci);
  }

  if (isMainlineAdvance) {
    state.currentPly = beforePly + 1;
    state.selectedVariationIndex = null;
    state.selectedPly = null;
    setStatus(`Позиция по партии: полуход ${state.currentPly}/${state.analysis.mainline_uci.length}`);
  } else {
    const canAppendToCurrentVariation = Boolean(
      state.manualLine &&
      Array.isArray(state.manualLine.moves) &&
      state.manualLine.moves.length &&
      state.manualLine.moves[state.manualLine.moves.length - 1].fenAfter === beforeFen
    );

    if (!canAppendToCurrentVariation) {
      state.manualLine = {
        basePly: Number.isFinite(beforePly) && beforePly >= 0 ? beforePly : 0,
        baseFen: beforeFen,
        moves: []
      };
    }

    const movesCount = state.manualLine.moves.length + 1;
    const manualPly = state.manualLine.basePly + movesCount;
    state.manualLine.moves.push({
      ply: manualPly,
      san: move.san,
      uci: moveUci,
      fenAfter: state.chess.fen()
    });

    state.selectedPly = null;
    state.currentPly = -1;
    state.selectedVariationIndex = state.manualLine.moves.length - 1;
    setStatus(`Вариант: ${variationMoveLabel(state.manualLine.moves[state.selectedVariationIndex])}`);
  }

  renderMoveList();
  renderAccuracyChart();
  if (state.board) {
    state.board.position(state.chess.fen(), false);
  }
  scheduleLivePositionAnalysis(160);
  requestAnimationFrame(drawArrows);
}

function initBoard() {
  if (state.boardReady) {
    return true;
  }
  if (!hasBoardLibs()) {
    return false;
  }

  state.chess = createChess();
  state.board = Chessboard("board", {
    draggable: true,
    pieceTheme: "/static/vendor/chessboard/img/chesspieces/wikipedia/{piece}.png",
    position: "start",
    onDragStart(source, piece) {
      if (!state.chess) {
        return false;
      }
      const turn = state.chess.turn();
      const pieceSide = String(piece || "").charAt(0).toLowerCase();
      if (!source || pieceSide !== turn) {
        return false;
      }
      const moves = state.chess.moves({ square: source, verbose: true });
      if (!moves.length) {
        return false;
      }
      showLegalTargets(source);
      return true;
    },
    onDrop(source, target) {
      const beforeFen = state.chess ? state.chess.fen() : "";
      const beforePly = Number(state.currentPly);
      clearBoardMoveHints();
      const move = state.chess.move({
        from: source,
        to: target,
        promotion: "q"
      });
      if (!move) {
        return "snapback";
      }
      commitAppliedMove(move, beforeFen, beforePly);
      return undefined;
    },
    onSnapEnd() {
      clearBoardMoveHints();
      state.board.position(state.chess.fen(), false);
      requestAnimationFrame(drawArrows);
    }
  });

  state.boardReady = true;
  return true;
}

function ensureBoardReady() {
  if (state.boardReady) {
    return true;
  }
  const missing = missingBoardLibs();
  if (missing.length) {
    showError(`Не удалось загрузить библиотеки доски: ${missing.join(", ")}.`);
    return false;
  }
  try {
    return initBoard();
  } catch (error) {
    showError(`Ошибка инициализации доски: ${error.message}`);
    return false;
  }
}

function uciToMoveObj(uci) {
  if (!uci || uci.length < 4) {
    return null;
  }
  return {
    from: uci.slice(0, 2),
    to: uci.slice(2, 4),
    promotion: uci.length > 4 ? uci.slice(4, 5) : "q"
  };
}

function applyUciMove(chess, uci) {
  const moveObj = uciToMoveObj(uci);
  if (!moveObj) {
    return null;
  }
  return chess.move(moveObj);
}

function renderSuggestionLines(topMoves, turnSide = analysisSide()) {
  const lines = (Array.isArray(topMoves) ? topMoves : []).slice(0, 3);
  if (!lines.length) {
    return "<div class='suggestion-empty'>Нет данных.</div>";
  }

  return `
    <div class="suggestion-lines">
      ${lines
        .map((item, idx) => {
          const uci = String((item && item.uci) || "").trim();
          const san = String((item && item.san) || uci || "?");
          const cpWhite = toWhiteCpFromTurn(item && item.cp, turnSide);
          const mateWhite = toWhiteMateFromTurn(item && item.mate, turnSide);
          const scoreText = scoreLabelLikeScale(cpWhite, mateWhite);
          const disabledAttr = uci ? "" : "disabled";
          return `
            <button
              type="button"
              class="suggestion-move suggestion-rank-${idx + 1}"
              data-uci="${escapeHtml(uci)}"
              data-san="${escapeHtml(san)}"
              ${disabledAttr}>
              <span class="suggestion-left">
                <span class="suggestion-rank">${idx + 1}.</span>
                <span>${escapeHtml(san)}</span>
              </span>
              <span class="suggestion-right">${scoreText}</span>
            </button>
          `;
        })
        .join("")}
    </div>
  `;
}

function bindSuggestionMoveButtons() {
  [...el.suggestions.querySelectorAll(".suggestion-move[data-uci]")].forEach((button) => {
    button.addEventListener("click", () => {
      const uci = String(button.dataset.uci || "").trim();
      if (!uci) {
        return;
      }
      applySuggestedMove(uci, button.dataset.san || uci);
    });
  });
}

function renderStoredMoveSuggestion(move) {
  if (!move) {
    el.suggestions.textContent = "Нет рекомендаций для выбранной позиции.";
    return;
  }

  const cpLoss = parseFiniteNumber(move.cp_loss);
  const lossPoints = cpLoss === null ? "-" : (cpLoss / 100).toFixed(2);
  const turnSide = move.side === "black" ? "black" : move.side === "white" ? "white" : analysisSide();
  el.suggestions.innerHTML = `
    <div class="suggestion-title">Рекомендация перед #${move.ply} ${escapeHtml(move.san || "")}</div>
    <div class="suggestion-sub">Лучший: <strong>${escapeHtml(move.best_move_san || "-")}</strong> | Потеря: ${lossPoints}</div>
    ${renderSuggestionLines(move.top_moves, turnSide)}
  `;
  bindSuggestionMoveButtons();
}

function applySuggestedMove(uci, sanLabel) {
  if (!ensureBoardReady() || !state.chess) {
    return;
  }
  const moveObj = uciToMoveObj(uci);
  if (!moveObj) {
    return;
  }

  clearError();
  clearBoardMoveHints();
  const beforeFen = state.chess.fen();
  const beforePly = Number(state.currentPly);
  const move = state.chess.move(moveObj);
  if (!move) {
    setStatus(`Ход ${sanLabel || uci} недоступен в текущей позиции.`);
    return;
  }
  commitAppliedMove(move, beforeFen, beforePly);
}

function goToPly(ply) {
  if (!state.analysis || !ensureBoardReady()) {
    return;
  }
  clearBoardMoveHints();
  const safePly = Math.max(0, Math.min(ply, state.analysis.mainline_uci.length));
  state.chess = createChess(state.analysis.start_fen);
  for (let i = 0; i < safePly; i += 1) {
    if (!applyUciMove(state.chess, state.analysis.mainline_uci[i])) {
      break;
    }
  }
  state.currentPly = safePly;
  state.board.position(state.chess.fen(), false);
  setStatus(`Позиция по партии: полуход ${safePly}/${state.analysis.mainline_uci.length}`);
  updateEvalScaleFromPly(safePly);
  state.selectedVariationIndex = null;
  const nextPlayerMove = state.playerMoveByPly.get(safePly + 1);
  if (nextPlayerMove) {
    setArrows(nextPlayerMove.recommended_arrows || []);
    renderStoredMoveSuggestion(nextPlayerMove);
  } else {
    setArrows([]);
    el.suggestions.textContent = "Выбран ход соперника. Для рекомендаций выберите ход своей стороны.";
  }
  requestAnimationFrame(drawArrows);
}

function setArrows(arrows) {
  state.arrows = Array.isArray(arrows) ? arrows : [];
  drawArrows();
}

function selectMoveByPly(ply) {
  if (!state.analysis) {
    return;
  }
  const move = state.playerMoveByPly.get(ply);
  if (!move) {
    return;
  }

  state.selectedPly = ply;
  state.selectedVariationIndex = null;
  goToPly(Math.max(0, ply - 1));
  setArrows(move.recommended_arrows);
  renderStoredMoveSuggestion(move);
  renderMoveList();
  renderAccuracyChart();
}

function renderCurrentSuggestions(data) {
  const turnSide = data && data.turn === "black" ? "black" : "white";
  el.suggestions.innerHTML = `
    <div class="suggestion-title">Лучшие линии для текущей позиции</div>
    ${renderSuggestionLines(data.top_moves, turnSide)}
  `;
  bindSuggestionMoveButtons();
}

function openAnalysisView(data, sourceLabel) {
  state.analysis = data;
  state.selectedCategory = "All";
  state.selectedPly = null;
  state.selectedVariationIndex = null;
  state.currentPly = 0;
  state.manualLine = null;
  state.liveAnalyzeToken += 1;
  if (state.liveAnalyzeTimer) {
    clearTimeout(state.liveAnalyzeTimer);
    state.liveAnalyzeTimer = null;
  }
  state.playerMoveByPly = new Map((data.player_moves || []).map((move) => [move.ply, move]));
  state.mainlineRows = buildMainlineRows(data);
  state.evalByPly = new Map(
    (Array.isArray(data.eval_points) ? data.eval_points : [])
      .filter((item) => Number.isFinite(Number(item && item.ply)) && Number.isFinite(Number(item.cp_white)))
      .map((item) => [
        Number(item.ply),
        {
          cpWhite: Number(item.cp_white),
          mateWhite: Number.isFinite(Number(item.mate_white)) ? Number(item.mate_white) : null
        }
      ])
  );

  el.analysisGameTitle.textContent = "Анализ партии";
  el.analysisSourceMeta.textContent = sourceLabel;

  renderSummary();
  initCategoryFilter();
  renderCategoryChips();
  renderMoveList();
  renderHighlights();

  setView("analysis");

  if (ensureBoardReady()) {
    state.chess = createChess(data.start_fen);
    state.board.position(data.start_fen, false);
    if (state.board.orientation && data.settings && data.settings.side) {
      state.board.orientation(data.settings.side === "black" ? "black" : "white");
    }
    state.board.resize();
    goToPly(0);
  }
}

async function analyzeChesscomGame(gameId, side, buttonEl) {
  clearError();
  const prevText = buttonEl.textContent;
  setGlobalAnalysisBusy(true);
  buttonEl.disabled = true;
  buttonEl.textContent = "Analyzing...";
  if (el.chesscomStatus) {
    el.chesscomStatus.textContent = "Идет анализ партии. Цель: около 1 минуты.";
  }

  if (side === "white" || side === "black") {
    el.side.value = side;
  }

  try {
    const timeoutMs = analysisRequestTimeoutMs();
    const payload = {
      game_id: gameId,
      side: el.side.value,
      depth: analysisDepthValue(),
      threads: analysisThreadsValue(),
      hash_mb: analysisHashValue(),
      target_time_sec: analysisTargetTimeValue(),
      pv_plies: Number(el.pvPlies.value || 3)
    };

    const response = await fetchWithTimeout("/api/chesscom/analyze-game", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    }, timeoutMs);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Ошибка анализа выбранной игры.");
    }

    updateGameStatsAfterAnalysis(gameId, data);
    renderHistoryList();

    const sourceText = data.cached ? "Chess.com (saved analysis)" : "Chess.com (new analysis)";
    openAnalysisView(data, sourceText);
  } catch (error) {
    if (error && error.name === "AbortError") {
      showError("Анализ занял слишком много времени. Попробуйте снова через несколько секунд.");
    } else {
      showError(error.message);
    }
  } finally {
    setGlobalAnalysisBusy(false);
    buttonEl.disabled = false;
    buttonEl.textContent = prevText;
  }
}

function buildPgnFormData({ textOnly }) {
  const formData = new FormData();
  formData.append("side", el.side.value);
  formData.append("depth", String(analysisDepthValue()));
  formData.append("threads", String(analysisThreadsValue()));
  formData.append("hash_mb", String(analysisHashValue()));
  formData.append("target_time_sec", String(analysisTargetTimeValue()));
  formData.append("pv_plies", String(Number(el.pvPlies.value || 3)));

  const textValue = String(el.pgnText.value || "").trim();
  const fileValue = el.pgnFile.files && el.pgnFile.files[0];

  if (!textOnly && fileValue) {
    formData.append("pgn", fileValue);
  }
  if (textValue) {
    formData.append("pgn_text", textValue);
  }

  if (textOnly && !textValue) {
    throw new Error("Вставьте PGN текст для анализа.");
  }
  if (!textValue && !fileValue) {
    throw new Error("Выберите PGN файл или вставьте PGN текст.");
  }

  return formData;
}

async function runPgnAnalyze({ textOnly, sourceLabel }) {
  clearError();
  setGlobalAnalysisBusy(true);
  setAnalyzeBusy(true, "Analyzing...");

  try {
    const formData = buildPgnFormData({ textOnly });
    const timeoutMs = analysisRequestTimeoutMs();
    const response = await fetchWithTimeout("/api/analyze-pgn", {
      method: "POST",
      body: formData
    }, timeoutMs);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Ошибка анализа PGN.");
    }

    openAnalysisView(data, sourceLabel);
  } catch (error) {
    if (error && error.name === "AbortError") {
      showError("Анализ PGN занял слишком много времени. Попробуйте снова через несколько секунд.");
    } else {
      showError(error.message);
    }
  } finally {
    setGlobalAnalysisBusy(false);
    setAnalyzeBusy(false);
  }
}

async function pasteAndAnalyze() {
  clearError();
  try {
    if (!navigator.clipboard || typeof navigator.clipboard.readText !== "function") {
      throw new Error("Браузер не поддерживает чтение буфера обмена.");
    }
    const text = await navigator.clipboard.readText();
    if (!String(text || "").trim()) {
      throw new Error("Буфер обмена пуст или не содержит PGN.");
    }
    el.pgnText.value = String(text).trim();
    await runPgnAnalyze({ textOnly: true, sourceLabel: "PGN Clipboard" });
  } catch (error) {
    showError(error.message);
  }
}

async function analyzeCurrentPosition(options = {}) {
  const silent = Boolean(options.silent);
  const token = Number.isFinite(Number(options.token))
    ? Number(options.token)
    : ++state.liveAnalyzeToken;

  if (!silent) {
    clearError();
  }
  if (!ensureBoardReady() || !state.chess) {
    return;
  }

  try {
    const payload = {
      fen: state.chess.fen(),
      depth: analysisDepthValue(),
      threads: analysisThreadsValue(),
      hash_mb: analysisHashValue(),
      pv_plies: Number(el.pvPlies.value || 3)
    };

    const response = await fetch("/api/evaluate-position", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Ошибка анализа позиции.");
    }
    if (token !== state.liveAnalyzeToken) {
      return;
    }

    setArrows(data.arrows || []);
    renderCurrentSuggestions(data);
    const cpWhite = cpWhiteFromEvalResponse(data);
    const mateWhite = mateWhiteFromEvalResponse(data);
    if (cpWhite !== null) {
      updateEvalScale(cpWhite, mateWhite);
      if (state.currentPly >= 0) {
        state.evalByPly.set(state.currentPly, { cpWhite, mateWhite });
      }
    }
    if (state.currentPly < 0) {
      const cp = Number(cpWhite);
      if (Number.isFinite(cp)) {
        setStatus(`Свободный анализ: оценка ${cp >= 0 ? "+" : ""}${(cp / 100).toFixed(2)}.`);
      }
    }
  } catch (error) {
    if (!silent) {
      showError(error.message);
    }
  }
}

function bindEvents() {
  el.chesscomLoadBtn.addEventListener("click", loadChesscomGames);
  if (el.chesscomUsername) {
    el.chesscomUsername.addEventListener("change", () => {
      persistUsername(el.chesscomUsername.value);
    });
  }
  el.analyzeFileBtn.addEventListener("click", async () => {
    await runPgnAnalyze({ textOnly: false, sourceLabel: "PGN File/Text" });
  });
  el.analyzeTextBtn.addEventListener("click", async () => {
    await runPgnAnalyze({ textOnly: true, sourceLabel: "PGN Text" });
  });
  el.pasteAnalyzeBtn.addEventListener("click", pasteAndAnalyze);

  el.backBtn.addEventListener("click", () => {
    setView("selection");
    setArrows([]);
    clearError();
  });

  el.btnStart.addEventListener("click", () => {
    if (!state.analysis) {
      return;
    }
    state.selectedPly = null;
    state.selectedVariationIndex = null;
    goToPly(0);
    renderMoveList();
    renderAccuracyChart();
  });

  el.btnPrev.addEventListener("click", () => {
    if (!state.analysis) {
      return;
    }
    const from = state.currentPly < 0 ? state.analysis.mainline_uci.length : state.currentPly;
    state.selectedPly = null;
    state.selectedVariationIndex = null;
    goToPly(from - 1);
    renderMoveList();
    renderAccuracyChart();
  });

  el.btnNext.addEventListener("click", () => {
    if (!state.analysis || state.currentPly < 0) {
      return;
    }
    state.selectedPly = null;
    state.selectedVariationIndex = null;
    goToPly(state.currentPly + 1);
    renderMoveList();
    renderAccuracyChart();
  });

  el.btnEnd.addEventListener("click", () => {
    if (!state.analysis) {
      return;
    }
    state.selectedPly = null;
    state.selectedVariationIndex = null;
    goToPly(state.analysis.mainline_uci.length);
    renderMoveList();
    renderAccuracyChart();
  });

  el.categoryFilter.addEventListener("change", () => {
    setCategory(el.categoryFilter.value);
  });

  window.addEventListener("resize", () => {
    if (state.boardReady && state.board) {
      state.board.resize();
    }
    syncEvalScaleHeight();
    requestAnimationFrame(drawArrows);
  });
}

function init() {
  if (el.chesscomUsername) {
    const savedUsername = readStoredUsername();
    if (savedUsername) {
      el.chesscomUsername.value = savedUsername;
    }
  }
  if (el.threads) {
    const defaultThreads = defaultThreadsForAnalysis();
    el.threads.value = String(defaultThreads);
    const prevMax = parseFiniteNumber(el.threads.max);
    if (prevMax === null || detectedCpuThreads > prevMax) {
      el.threads.max = String(detectedCpuThreads);
    }
  }
  if (el.hashMb) {
    const defaultHash = Math.max(128, Math.min(2048, defaultThreadsForAnalysis() * 128));
    el.hashMb.value = String(defaultHash);
  }
  if (el.targetTime) {
    el.targetTime.value = "60";
  }
  initCategoryFilter();
  renderHistoryList();
  renderMoveList();
  renderHighlights();
  updateEvalScale(0, null);
  bindEvents();
  setView("selection");
  void loadCachedGames();
}

init();
