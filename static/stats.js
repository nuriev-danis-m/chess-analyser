const STORAGE_KEYS = {
  chesscomUsername: "chess_analyzer.chesscom_username",
  chesscomMaxGames: "chess_analyzer.chesscom_max_games",
  mateReviewedPrefix: "chess_analyzer.mate_hunt.reviewed"
};

const BOARD_MOVE_ANIMATION_MS = 420;
const detectedCpuThreads = Math.max(1, Math.floor(Number(window.navigator && window.navigator.hardwareConcurrency) || 0) || 4);

const el = {
  username: document.getElementById("stats-username"),
  maxGames: document.getElementById("stats-max-games"),
  btnLoad: document.getElementById("btn-load-stats"),
  btnReanalyzeAll: document.getElementById("btn-reanalyze-all-stats"),
  btnStopBatch: document.getElementById("btn-stop-batch-analysis-stats"),
  status: document.getElementById("stats-status"),
  tabButtons: Array.from(document.querySelectorAll("[data-stats-tab]")),
  tabOverview: document.getElementById("stats-tab-overview"),
  tabMateHunt: document.getElementById("stats-tab-mate-hunt"),
  openings: document.getElementById("stats-openings"),
  phases: document.getElementById("stats-phases"),
  falling: document.getElementById("stats-falling"),
  pieces: document.getElementById("stats-pieces"),
  tactics: document.getElementById("stats-tactics"),
  advantage: document.getElementById("stats-advantage"),
  mateKpis: document.getElementById("stats-mate-kpis"),
  mateQueue: document.getElementById("stats-mate-queue"),
  mateHistory: document.getElementById("stats-mate-history"),
  matePositions: document.getElementById("stats-mate-positions"),
  mateBoardShell: document.getElementById("mate-board-shell"),
  mateBoard: document.getElementById("mate-board"),
  mateToast: document.getElementById("mate-toast"),
  mateStatus: document.getElementById("mate-status"),
  mateTitle: document.getElementById("mate-title"),
  mateSubtitle: document.getElementById("mate-subtitle"),
  mateSummary: document.getElementById("mate-summary"),
  btnMateNext: document.getElementById("btn-mate-next"),
  btnMateAnalyze: document.getElementById("btn-mate-analyze"),
  btnMateFinish: document.getElementById("btn-mate-finish")
};

const state = {
  busy: false,
  activeTab: "overview",
  lastStats: null,
  batchJob: null,
  batchStatusTimer: null,
  mate: {
    ownerUsername: "",
    reviewMap: {},
    games: [],
    positions: [],
    queue: [],
    history: [],
    board: null,
    chess: null,
    boardReady: false,
    activeMeta: null,
    activeLine: [],
    nextIndex: 0,
    solved: false,
    loading: false,
    autoPlaying: false,
    toastTimer: null,
    autoMoveTimer: null
  }
};

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function clampInt(value, minValue, maxValue, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(minValue, Math.min(maxValue, Math.floor(parsed)));
}

function normalizeUsername(value) {
  return String(value || "").trim().toLowerCase();
}

function currentUsername() {
  return String(el.username.value || "").trim();
}

function currentUsernameKey() {
  return normalizeUsername(currentUsername());
}

function currentMaxGames() {
  return clampInt(el.maxGames.value, 1, 5000, 5000);
}

function readStoredUsername() {
  try {
    return String(window.localStorage.getItem(STORAGE_KEYS.chesscomUsername) || "").trim();
  } catch (error) {
    return "";
  }
}

function readStoredMaxGames() {
  try {
    const value = window.localStorage.getItem(STORAGE_KEYS.chesscomMaxGames);
    if (!value) {
      return null;
    }
    return clampInt(value, 1, 5000, 5000);
  } catch (error) {
    return null;
  }
}

function persistInputs() {
  const username = String(el.username.value || "").trim();
  const maxGames = currentMaxGames();
  el.maxGames.value = String(maxGames);
  try {
    if (username) {
      window.localStorage.setItem(STORAGE_KEYS.chesscomUsername, username);
    }
    window.localStorage.setItem(STORAGE_KEYS.chesscomMaxGames, String(maxGames));
  } catch (error) {
    // ignore storage issues
  }
  return { username, maxGames };
}

function setBusy(isBusy, label) {
  state.busy = Boolean(isBusy);
  const batchRunning = batchJobIsActive(state.batchJob);
  el.btnLoad.disabled = state.busy || batchRunning;
  el.btnReanalyzeAll.disabled = state.busy || batchRunning;
  if (el.btnStopBatch) {
    el.btnStopBatch.disabled = !batchRunning || state.busy;
  }
  if (!state.busy && !batchRunning) {
    el.btnLoad.textContent = "Refresh stats";
    el.btnReanalyzeAll.textContent = "Reanalyze all";
    if (el.btnStopBatch) {
      el.btnStopBatch.textContent = "Stop analysis";
    }
  } else if (label) {
    el.btnReanalyzeAll.textContent = label;
  }
  syncMateButtons();
}

function batchJobIsActive(job) {
  if (!job || typeof job !== "object") {
    return false;
  }
  const status = String(job.status || "").toLowerCase();
  return Boolean(job.active) || status === "queued" || status === "running";
}

function batchJobButtonLabel(job) {
  const base = String(job && job.label || "Reanalyze all");
  const processed = Number(job && job.processed || 0);
  const total = Number(job && job.total || 0);
  return `${base} ${processed}/${total}`;
}

function batchStopButtonLabel(job) {
  return String(job && job.status || "").toLowerCase() === "stopping"
    ? "Stopping..."
    : "Stop analysis";
}

function batchJobStatusLine(job) {
  if (!job || typeof job !== "object") {
    return "";
  }
  const processed = Number(job.processed || 0);
  const total = Number(job.total || 0);
  const currentGameId = String(job.current_game_id || "").trim();
  const detail = currentGameId ? ` (game_id=${currentGameId})` : "";
  if (String(job.status || "").toLowerCase() === "stopping") {
    return String(job.message || "Stop requested. Waiting for the current game to finish.");
  }
  if (String(job.status || "").toLowerCase() === "stopped") {
    return String(job.message || `${String(job.label || "Batch analysis")} stopped.`);
  }
  if (batchJobIsActive(job)) {
    return `${String(job.label || "Batch analysis")}: ${processed}/${total}${detail}`;
  }
  const success = Number(job.success || 0);
  const failed = Number(job.failed || 0);
  if (String(job.status || "").toLowerCase() === "completed_with_errors") {
    return `${String(job.label || "Batch analysis")} finished. Success: ${success}, failed: ${failed}.`;
  }
  if (String(job.status || "").toLowerCase() === "completed") {
    return `${String(job.label || "Batch analysis")} finished. Success: ${success}.`;
  }
  return String(job.message || `${String(job.label || "Batch analysis")} status: ${String(job.status || "unknown")}.`);
}

function clearBatchStatusTimer() {
  if (state.batchStatusTimer) {
    window.clearTimeout(state.batchStatusTimer);
    state.batchStatusTimer = null;
  }
}

function scheduleBatchStatusPoll(delayMs = 2500) {
  clearBatchStatusTimer();
  if (!currentUsername()) {
    return;
  }
  state.batchStatusTimer = window.setTimeout(() => {
    void syncPersistentBatchStatus({ refreshStatsOnFinish: true });
  }, delayMs);
}

function applyPersistentBatchStatus(job, options = {}) {
  const previousJob = state.batchJob;
  const wasActive = batchJobIsActive(previousJob);
  const isActive = batchJobIsActive(job);
  state.batchJob = job && typeof job === "object" ? job : null;

  if (isActive) {
    el.status.textContent = batchJobStatusLine(job);
    setBusy(false, batchJobButtonLabel(job));
    if (el.btnStopBatch) {
      el.btnStopBatch.disabled = false;
      el.btnStopBatch.textContent = batchStopButtonLabel(job);
    }
    scheduleBatchStatusPoll();
    return;
  }

  clearBatchStatusTimer();
  setBusy(false);
  if (el.btnStopBatch) {
    el.btnStopBatch.disabled = true;
    el.btnStopBatch.textContent = "Stop analysis";
  }
  if (job) {
    el.status.textContent = batchJobStatusLine(job);
  }
  if (options.refreshStatsOnFinish && wasActive && currentUsername()) {
    void loadStats();
  }
}

async function syncPersistentBatchStatus(options = {}) {
  const username = currentUsername();
  if (!username) {
    clearBatchStatusTimer();
    applyPersistentBatchStatus(null, options);
    return null;
  }
  const response = await fetch(`/api/chesscom/batch-analysis/status?username=${encodeURIComponent(username)}&max_games=${encodeURIComponent(currentMaxGames())}`);
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Failed to load batch status.");
  }
  applyPersistentBatchStatus(data.job || null, options);
  return data.job || null;
}

async function stopPersistentBatchAnalysis() {
  const { username, maxGames } = persistInputs();
  if (!username) {
    return false;
  }
  const response = await fetch("/api/chesscom/batch-analysis/stop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username,
      max_games: maxGames,
      job_id: state.batchJob && state.batchJob.job_id ? state.batchJob.job_id : ""
    })
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Failed to stop batch analysis.");
  }
  applyPersistentBatchStatus(data.job || null, { refreshStatsOnFinish: true });
  return true;
}

function renderTable(container, columns, rows, emptyLabel, options = {}) {
  if (!rows || !rows.length) {
    container.innerHTML = `<div class="history-empty">${escapeHtml(emptyLabel || "No data.")}</div>`;
    return;
  }
  const th = columns.map((col) => `<th>${escapeHtml(col.label)}</th>`).join("");
  const body = rows
    .map((row) => {
      const cells = columns
        .map((col) => {
          const raw = col.render ? col.render(row) : row[col.key];
          return `<td>${raw === undefined || raw === null ? "-" : raw}</td>`;
        })
        .join("");
      const rowClass = typeof options.rowClass === "function" ? String(options.rowClass(row) || "").trim() : "";
      return `<tr${rowClass ? ` class="${escapeHtml(rowClass)}"` : ""}>${cells}</tr>`;
    })
    .join("");
  container.innerHTML = `
    <table class="stats-table">
      <thead><tr>${th}</tr></thead>
      <tbody>${body}</tbody>
    </table>
  `;
}

function normalizeTab(value) {
  return value === "mate-hunt" ? "mate-hunt" : "overview";
}

function syncFilterQuery(username, maxGames) {
  const url = new URL(window.location.href);
  if (username) {
    url.searchParams.set("username", username);
  } else {
    url.searchParams.delete("username");
  }
  url.searchParams.set("max_games", String(maxGames));
  if (state.activeTab === "overview") {
    url.searchParams.delete("tab");
  } else {
    url.searchParams.set("tab", state.activeTab);
  }
  const query = url.searchParams.toString();
  window.history.replaceState(null, "", query ? `${url.pathname}?${query}` : url.pathname);
}

function setActiveTab(tab, syncUrl = true) {
  state.activeTab = normalizeTab(tab);
  const isMate = state.activeTab === "mate-hunt";
  if (el.tabOverview) {
    el.tabOverview.classList.toggle("hidden", isMate);
  }
  if (el.tabMateHunt) {
    el.tabMateHunt.classList.toggle("hidden", !isMate);
  }
  el.tabButtons.forEach((button) => {
    const selected = String(button.dataset.statsTab || "") === state.activeTab;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", selected ? "true" : "false");
  });
  if (syncUrl) {
    syncFilterQuery(currentUsername(), currentMaxGames());
  }
  if (isMate && state.mate.boardReady && state.mate.board) {
    requestAnimationFrame(() => state.mate.board.resize());
  }
  if (isMate && !state.mate.activeMeta && state.mate.queue.length) {
    void loadMatePuzzle(state.mate.queue[0]);
  }
}

function percentLabel(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return "-";
  }
  return `${num.toFixed(1)}%`;
}

function resultBadge(result) {
  const normalized = String(result || "").toLowerCase();
  if (normalized === "win") {
    return '<span class="result-win">Win</span>';
  }
  if (normalized === "loss") {
    return '<span class="result-loss">Loss</span>';
  }
  if (normalized === "draw") {
    return '<span class="result-draw">Draw</span>';
  }
  return escapeHtml(result || "-");
}

function moveLabel(row) {
  const moveNumber = clampInt(row.move_number, 1, 999, 1);
  const side = String(row.side || "").toLowerCase() === "black" ? "black" : "white";
  const prefix = side === "black" ? `${moveNumber}...` : `${moveNumber}.`;
  return `${prefix} ${escapeHtml(row.san || "-")}`;
}

function positionLabel(row) {
  const moveNumber = clampInt(row.move_number, 1, 999, 1);
  const side = String(row.side || "").toLowerCase() === "black" ? "black" : "white";
  return side === "black" ? `${moveNumber}...` : `${moveNumber}.`;
}

function openingLabel(row) {
  const opening = String(row.opening || "").trim() || "Unknown opening";
  const eco = String(row.eco || "").trim();
  return `<strong>${escapeHtml(opening)}</strong>${eco ? `<br><small>${escapeHtml(eco)}</small>` : ""}`;
}

function gameLink(row) {
  const url = String(row.url || "").trim();
  const gameId = String(row.game_id || "").trim() || "-";
  if (!url) {
    return escapeHtml(gameId);
  }
  return `<a class="stats-link" href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open</a><br><small>${escapeHtml(gameId)}</small>`;
}

function renderOpenings(openings) {
  renderTable(
    el.openings,
    [
      { label: "Opening", render: (row) => `<strong>${escapeHtml(row.opening || "Unknown opening")}</strong><br><small>${escapeHtml(row.eco || "-")}</small>` },
      { label: "Games", key: "games" },
      { label: "W", key: "wins" },
      { label: "D", key: "draws" },
      { label: "L", key: "losses" },
      { label: "Loss %", render: (row) => `<span class="${Number(row.loss_rate) >= 50 ? "highlight-negative" : ""}">${percentLabel(row.loss_rate)}</span>` },
      { label: "Score %", render: (row) => `${percentLabel(row.score_rate)}` },
      { label: "Analyzed", key: "analyzed_games" }
    ],
    openings || [],
    "No opening data."
  );
}

function renderPhases(phases) {
  renderTable(
    el.phases,
    [
      { label: "Phase", render: (row) => escapeHtml(String(row.phase || "")) },
      { label: "Moves", key: "moves" },
      { label: "Error moves", key: "error_moves" },
      { label: "Blunders", key: "blunders" },
      { label: "Avg cp_loss", render: (row) => Number(row.avg_cp_loss || 0).toFixed(1) },
      { label: "Errors/100", render: (row) => Number(row.error_per_100 || 0).toFixed(1) },
      { label: "Blunders/100", render: (row) => Number(row.blunder_per_100 || 0).toFixed(1) }
    ],
    phases || [],
    "No game phase data."
  );
}

function renderFallingMoves(rows) {
  renderTable(
    el.falling,
    [
      { label: "cp_loss", render: (row) => `<span class="highlight-negative">-${Number(row.cp_loss || 0)}</span>` },
      { label: "Move", render: (row) => `${escapeHtml(row.san || "-")} <small>(#${escapeHtml(row.ply || "-")})</small>` },
      { label: "Piece", key: "piece" },
      { label: "Phase", key: "phase" },
      { label: "Opening", render: (row) => `${escapeHtml(row.opening || "-")} <small>${escapeHtml(row.eco || "")}</small>` },
      { label: "Position repeats", key: "position_repeats" },
      { label: "Result", key: "result_bucket" },
      { label: "Date", key: "end_time_iso" },
      { label: "Game", key: "game_id" }
    ],
    rows || [],
    "No falling-move data."
  );
}

function renderWeakPieces(rows) {
  renderTable(
    el.pieces,
    [
      { label: "Piece", key: "piece" },
      { label: "Moves", key: "moves" },
      { label: "Avg cp_loss", render: (row) => Number(row.avg_cp_loss || 0).toFixed(1) },
      { label: "Error rate", render: (row) => percentLabel(row.error_rate) },
      { label: "Blunder rate", render: (row) => percentLabel(row.blunder_rate) }
    ],
    rows || [],
    "No piece data."
  );
}

function renderTactics(payload) {
  const tactics = payload || {};
  const missedMate = Number(tactics.missed_mate_1_3 || 0);
  const tacticalMisses = Number(tactics.tactical_misses || 0);
  const samples = Array.isArray(tactics.samples) ? tactics.samples : [];

  const kpiHtml = `
    <div class="stats-kpi">
      <div class="stats-kpi-item"><span class="label">Missed mate 1-3</span><span class="value">${missedMate}</span></div>
      <div class="stats-kpi-item"><span class="label">Tactical misses</span><span class="value">${tacticalMisses}</span></div>
    </div>
  `;

  if (!samples.length) {
    el.tactics.innerHTML = `${kpiHtml}<div class="history-empty">No tactical examples.</div>`;
    return;
  }

  const table = `
    <table class="stats-table">
      <thead>
        <tr>
          <th>Type</th>
          <th>Move</th>
          <th>Best</th>
          <th>cp_loss</th>
          <th>Ply</th>
          <th>Game</th>
        </tr>
      </thead>
      <tbody>
        ${samples.map((row) => `
          <tr>
            <td>${escapeHtml(row.type || "-")}</td>
            <td>${escapeHtml(row.san || "-")}</td>
            <td>${escapeHtml(row.best_san || "-")}</td>
            <td class="highlight-negative">-${escapeHtml(row.cp_loss || "0")}</td>
            <td>${escapeHtml(row.ply || "-")}</td>
            <td>${escapeHtml(row.game_id || "-")}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
  el.tactics.innerHTML = `${kpiHtml}${table}`;
}

function renderAdvantage(payload) {
  const row = payload || {};
  const gamesWithAdv = Number(row.games_with_advantage || 0);
  const converted = Number(row.converted_to_win || 0);
  const dropped = Number(row.draw_or_loss_after_advantage || 0);
  const dropsCount = Number(row.big_drops_count || 0);
  const conversionRate = Number.isFinite(Number(row.conversion_rate)) ? `${Number(row.conversion_rate).toFixed(1)}%` : "-";
  const samples = Array.isArray(row.samples) ? row.samples : [];

  const kpiHtml = `
    <div class="stats-kpi">
      <div class="stats-kpi-item"><span class="label">Games with +2+</span><span class="value">${gamesWithAdv}</span></div>
      <div class="stats-kpi-item"><span class="label">Converted to win</span><span class="value highlight-positive">${converted}</span></div>
      <div class="stats-kpi-item"><span class="label">Draw/loss after +2+</span><span class="value highlight-negative">${dropped}</span></div>
      <div class="stats-kpi-item"><span class="label">Conversion rate</span><span class="value">${conversionRate}</span></div>
      <div class="stats-kpi-item"><span class="label">Big drops while ahead</span><span class="value highlight-negative">${dropsCount}</span></div>
    </div>
  `;

  if (!samples.length) {
    el.advantage.innerHTML = `${kpiHtml}<div class="history-empty">No examples of drops while ahead.</div>`;
    return;
  }

  const table = `
    <table class="stats-table">
      <thead>
        <tr>
          <th>Move</th>
          <th>cp before</th>
          <th>cp_loss</th>
          <th>Ply</th>
          <th>Game</th>
        </tr>
      </thead>
      <tbody>
        ${samples.map((item) => `
          <tr>
            <td>${escapeHtml(item.san || "-")}</td>
            <td class="highlight-positive">+${escapeHtml(item.cp_before || "0")}</td>
            <td class="highlight-negative">-${escapeHtml(item.cp_loss || "0")}</td>
            <td>${escapeHtml(item.ply || "-")}</td>
            <td>${escapeHtml(item.game_id || "-")}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
  el.advantage.innerHTML = `${kpiHtml}${table}`;
}

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
    throw new Error("Chess.js is not loaded.");
  }
  return fen ? new ChessCtor(fen) : new ChessCtor();
}

function hasMateBoardLibs() {
  return typeof Chessboard === "function" && Boolean(resolveChessCtor());
}

function clearMateTimer(name) {
  if (state.mate[name]) {
    window.clearTimeout(state.mate[name]);
    state.mate[name] = null;
  }
}

function setMateStatus(message) {
  if (el.mateStatus) {
    el.mateStatus.textContent = message;
  }
}

function showMateToast(message, tone = "warn") {
  if (!el.mateToast) {
    return;
  }
  clearMateTimer("toastTimer");
  el.mateToast.textContent = message;
  el.mateToast.classList.remove("hidden", "tone-info", "tone-warn", "tone-success");
  el.mateToast.classList.add(`tone-${tone}`);
  state.mate.toastTimer = window.setTimeout(() => {
    el.mateToast.classList.add("hidden");
  }, 2200);
}

function clearMateToast() {
  clearMateTimer("toastTimer");
  if (el.mateToast) {
    el.mateToast.textContent = "";
    el.mateToast.classList.add("hidden");
    el.mateToast.classList.remove("tone-info", "tone-warn", "tone-success");
  }
}

function mateReviewStorageKey(usernameKey) {
  return `${STORAGE_KEYS.mateReviewedPrefix}::${usernameKey || "anonymous"}`;
}

function readMateReviewMap(usernameKey) {
  if (!usernameKey) {
    return {};
  }
  try {
    const raw = window.localStorage.getItem(mateReviewStorageKey(usernameKey));
    if (!raw) {
      return {};
    }
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    return {};
  }
}

function writeMateReviewMap(usernameKey, value) {
  if (!usernameKey) {
    return;
  }
  try {
    window.localStorage.setItem(mateReviewStorageKey(usernameKey), JSON.stringify(value || {}));
  } catch (error) {
    // ignore storage issues
  }
}

function buildGameReviewKey(row, usernameKey = currentUsernameKey()) {
  const side = String((row && row.player_side) || (row && row.side) || "white").toLowerCase() === "black" ? "black" : "white";
  return `${usernameKey}::${String((row && row.game_id) || "").trim()}::${side}`;
}

function buildPuzzleKey(row, usernameKey = currentUsernameKey()) {
  return `${buildGameReviewKey(row, usernameKey)}::ply${clampInt((row && row.ply) || 0, 0, 99999, 0)}`;
}

function normalizeMateGameRows(rows, usernameKey) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => {
      const reviewKey = buildGameReviewKey(row, usernameKey);
      return {
        ...row,
        review_key: reviewKey,
        puzzle_key: buildPuzzleKey(row, usernameKey)
      };
    });
}

function normalizeMatePositionRows(rows, usernameKey) {
  return (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      ...row,
      review_key: buildGameReviewKey(row, usernameKey),
      puzzle_key: buildPuzzleKey(row, usernameKey)
    }));
}

function compareMateRows(left, right) {
  return (
    clampInt(left.best_mate, 1, 999, 999) - clampInt(right.best_mate, 1, 999, 999)
    || clampInt(right.plies_left, 0, 9999, 0) - clampInt(left.plies_left, 0, 9999, 0)
    || (String(left.result_bucket || "").toLowerCase() === "win" ? -1 : 1) - (String(right.result_bucket || "").toLowerCase() === "win" ? -1 : 1)
    || clampInt(right.missed_positions, 0, 999, 0) - clampInt(left.missed_positions, 0, 999, 0)
    || clampInt(left.ply, 0, 9999, 0) - clampInt(right.ply, 0, 9999, 0)
  );
}

function compareReviewedRows(left, right) {
  const leftTs = Date.parse(String(left.reviewed_at || "")) || 0;
  const rightTs = Date.parse(String(right.reviewed_at || "")) || 0;
  return rightTs - leftTs || compareMateRows(left, right);
}

function rebuildMateCollections() {
  const reviewMap = state.mate.reviewMap || {};
  state.mate.games = state.mate.games
    .map((row) => {
      const reviewMeta = reviewMap[row.review_key] || null;
      return {
        ...row,
        reviewed: Boolean(reviewMeta),
        reviewed_at: reviewMeta ? String(reviewMeta.reviewed_at || "") : ""
      };
    })
    .sort(compareMateRows);
  state.mate.positions = state.mate.positions
    .map((row) => {
      const reviewMeta = reviewMap[row.review_key] || null;
      return {
        ...row,
        reviewed: Boolean(reviewMeta),
        reviewed_at: reviewMeta ? String(reviewMeta.reviewed_at || "") : ""
      };
    })
    .sort(compareMateRows);
  state.mate.queue = state.mate.games.filter((row) => !row.reviewed);
  state.mate.history = state.mate.games.filter((row) => row.reviewed).sort(compareReviewedRows);
}

function activeReviewKey() {
  return state.mate.activeMeta ? String(state.mate.activeMeta.review_key || "") : "";
}

function isActiveMateRow(row) {
  return Boolean(row) && String(row.review_key || row.puzzle_key || "") !== "" && (
    String(row.puzzle_key || "") === String(state.mate.activeMeta && state.mate.activeMeta.puzzle_key || "")
    || String(row.review_key || "") === activeReviewKey()
  );
}

function reviewedBadge(row) {
  if (!row || !row.reviewed) {
    return '<span class="mate-inline-badge tone-pending">Pending</span>';
  }
  const reviewedAt = row.reviewed_at ? new Date(row.reviewed_at) : null;
  const label = reviewedAt && !Number.isNaN(reviewedAt.getTime())
    ? reviewedAt.toLocaleString()
    : "Reviewed";
  return `<span class="mate-inline-badge tone-reviewed">${escapeHtml(label)}</span>`;
}

function buildMateSummaryItem(label, value, extraClass = "") {
  return `
    <div class="mate-summary-item${extraClass ? ` ${escapeHtml(extraClass)}` : ""}">
      <span class="label">${escapeHtml(label)}</span>
      <span class="value">${value}</span>
    </div>
  `;
}

function renderMateQueue() {
  renderTable(
    el.mateQueue,
    [
      {
        label: "Play",
        render: (row) => `
          <button
            type="button"
            class="mate-action-btn"
            data-mate-action="play-game"
            data-review-key="${escapeHtml(row.review_key)}">
            ${isActiveMateRow(row) ? "Current" : "Play"}
          </button>
        `
      },
      { label: "Mate", render: (row) => `<strong>Mate in ${escapeHtml(row.best_mate || "-")}</strong>` },
      { label: "Position", render: (row) => positionLabel(row) },
      { label: "Missed spots", key: "missed_positions" },
      { label: "Still played", render: (row) => `${escapeHtml(row.plies_left || 0)} plies` },
      { label: "Result", render: (row) => resultBadge(row.result_bucket) },
      { label: "Opening", render: (row) => openingLabel(row) },
      { label: "Game", render: (row) => gameLink(row) }
    ],
    state.mate.queue,
    "No pending games. Reviewed games stay below.",
    {
      rowClass: (row) => isActiveMateRow(row) ? "mate-row-active" : ""
    }
  );
}

function renderMateHistory() {
  renderTable(
    el.mateHistory,
    [
      {
        label: "Replay",
        render: (row) => `
          <button
            type="button"
            class="mate-action-btn secondary"
            data-mate-action="play-game"
            data-review-key="${escapeHtml(row.review_key)}">
            Replay
          </button>
        `
      },
      { label: "Reviewed", render: (row) => reviewedBadge(row) },
      { label: "Mate", render: (row) => `Mate in ${escapeHtml(row.best_mate || "-")}` },
      { label: "Position", render: (row) => positionLabel(row) },
      { label: "Missed spots", key: "missed_positions" },
      { label: "Opening", render: (row) => openingLabel(row) },
      { label: "Game", render: (row) => gameLink(row) }
    ],
    state.mate.history,
    "No reviewed games yet.",
    {
      rowClass: (row) => isActiveMateRow(row) ? "mate-row-active" : ""
    }
  );
}

function renderMatePositions() {
  renderTable(
    el.matePositions,
    [
      {
        label: "Play spot",
        render: (row) => `
          <button
            type="button"
            class="mate-action-btn tertiary"
            data-mate-action="play-position"
            data-puzzle-key="${escapeHtml(row.puzzle_key)}">
            ${isActiveMateRow(row) && String(row.puzzle_key || "") === String(state.mate.activeMeta && state.mate.activeMeta.puzzle_key || "") ? "Current" : "Play"}
          </button>
        `
      },
      { label: "Status", render: (row) => reviewedBadge(row) },
      { label: "Mate", render: (row) => `Mate in ${escapeHtml(row.best_mate || "-")}` },
      { label: "Position", render: (row) => positionLabel(row) },
      { label: "Still played", render: (row) => `${escapeHtml(row.plies_left || 0)} plies` },
      { label: "Result", render: (row) => resultBadge(row.result_bucket) },
      { label: "Opening", render: (row) => openingLabel(row) },
      { label: "Game", render: (row) => gameLink(row) }
    ],
    state.mate.positions,
    "No missed mating positions found.",
    {
      rowClass: (row) => isActiveMateRow(row) ? "mate-row-active" : ""
    }
  );
}

function resolveGameRow(reviewKey) {
  return state.mate.games.find((row) => String(row.review_key || "") === String(reviewKey || "")) || null;
}

function resolvePositionRow(puzzleKey) {
  return state.mate.positions.find((row) => String(row.puzzle_key || "") === String(puzzleKey || "")) || null;
}

function remainingMateMoves() {
  if (!state.mate.activeMeta || !state.mate.activeLine.length) {
    return 0;
  }
  const playerSide = String(state.mate.activeMeta.player_side || "white");
  return state.mate.activeLine
    .slice(state.mate.nextIndex)
    .filter((row) => String(row.side || "").toLowerCase() === playerSide)
    .length;
}

function expectedMateMove() {
  return state.mate.activeLine[state.mate.nextIndex] || null;
}

function syncMateButtons() {
  const nextGame = nextPendingMateGame();
  if (el.btnMateNext) {
    el.btnMateNext.disabled = state.busy || state.mate.loading || !nextGame;
  }
  if (el.btnMateAnalyze) {
    el.btnMateAnalyze.disabled = state.busy || state.mate.loading || !state.mate.activeMeta || !state.mate.solved;
  }
  if (el.btnMateFinish) {
    el.btnMateFinish.disabled = state.busy
      || state.mate.loading
      || !state.mate.activeMeta
      || !state.mate.solved
      || Boolean(state.mate.activeMeta.reviewed);
  }
}

function renderActiveMateSummary() {
  if (!state.mate.activeMeta) {
    el.mateTitle.textContent = state.mate.queue.length ? "Pick the next missed finish" : "Queue complete";
    el.mateSubtitle.textContent = state.mate.queue.length
      ? "The shortest mate opportunities appear first."
      : "Load another username or replay something from the reviewed history.";
    el.mateSummary.innerHTML = '<div class="history-empty">No active puzzle.</div>';
    syncMateButtons();
    return;
  }

  const meta = state.mate.activeMeta;
  const mateCount = remainingMateMoves();
  const title = state.mate.solved
    ? `Solved: mate in ${escapeHtml(meta.target_mate || meta.best_mate || "-")}`
    : `Find mate in ${escapeHtml(mateCount || meta.target_mate || meta.best_mate || "-")}`;
  const subtitle = `${escapeHtml(meta.white || "-")} vs ${escapeHtml(meta.black || "-")} | ${escapeHtml(meta.opening || "Unknown opening")}`;
  const statusBadge = meta.reviewed
    ? reviewedBadge(meta)
    : state.mate.solved
      ? '<span class="mate-inline-badge tone-success">Solved, not finished</span>'
      : reviewedBadge(meta);

  el.mateTitle.textContent = title;
  el.mateSubtitle.textContent = subtitle;
  el.mateSummary.innerHTML = `
    <div class="mate-summary-grid">
      ${buildMateSummaryItem("Status", statusBadge)}
      ${buildMateSummaryItem("Position", positionLabel(meta))}
      ${buildMateSummaryItem("Queue rank", state.mate.queue.findIndex((row) => row.review_key === meta.review_key) >= 0 ? `#${state.mate.queue.findIndex((row) => row.review_key === meta.review_key) + 1}` : "Reviewed")}
      ${buildMateSummaryItem("Game kept going", `${escapeHtml(meta.plies_left || 0)} plies<br><small>${escapeHtml(meta.full_moves_left || 0)} full moves</small>`)}
      ${buildMateSummaryItem("Game result", resultBadge(meta.result_bucket))}
      ${buildMateSummaryItem("Date", escapeHtml(meta.end_time_iso || "-"))}
      ${buildMateSummaryItem("Game", gameLink(meta))}
    </div>
  `;
  syncMateButtons();
}

function resetMateBoard(emptyMessage) {
  clearMateTimer("autoMoveTimer");
  state.mate.loading = false;
  state.mate.autoPlaying = false;
  state.mate.solved = false;
  state.mate.activeMeta = null;
  state.mate.activeLine = [];
  state.mate.nextIndex = 0;
  clearMateToast();
  if (state.mate.boardReady && state.mate.board) {
    state.mate.chess = createChess();
    state.mate.board.position("start", false);
    state.mate.board.orientation("white");
    state.mate.board.resize();
  }
  setMateStatus(emptyMessage || "Load analyzed games to start the trainer.");
  renderActiveMateSummary();
}

function ensureMateBoardReady() {
  if (state.mate.boardReady) {
    return true;
  }
  if (!hasMateBoardLibs()) {
    setMateStatus("Board libraries are missing.");
    return false;
  }

  state.mate.chess = createChess();
  state.mate.board = Chessboard("mate-board", {
    draggable: true,
    moveSpeed: BOARD_MOVE_ANIMATION_MS,
    pieceTheme: "/static/vendor/chessboard/img/chesspieces/wikipedia/{piece}.png",
    position: "start",
    onDragStart(source, piece) {
      if (!state.mate.activeMeta || state.mate.loading || state.mate.autoPlaying || state.mate.solved || !state.mate.chess) {
        return false;
      }
      const expected = expectedMateMove();
      if (!expected) {
        return false;
      }
      const turn = state.mate.chess.turn();
      const pieceSide = String(piece || "").charAt(0).toLowerCase();
      const expectedSide = String(expected.side || "").toLowerCase() === "black" ? "b" : "w";
      if (pieceSide !== turn || turn !== expectedSide) {
        return false;
      }
      return state.mate.chess.moves({ square: source, verbose: true }).length > 0;
    },
    onDrop(source, target) {
      return handleMateDrop(source, target);
    },
    onSnapEnd() {
      if (state.mate.board && state.mate.chess) {
        state.mate.board.position(state.mate.chess.fen(), false);
      }
    }
  });

  state.mate.boardReady = true;
  return true;
}

function verboseMoveToUci(move) {
  if (!move) {
    return "";
  }
  return `${move.from || ""}${move.to || ""}${move.promotion || ""}`;
}

function uciToMoveObject(uci) {
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
  const moveObj = uciToMoveObject(uci);
  if (!moveObj) {
    return null;
  }
  return chess.move(moveObj);
}

function isMateBoardCheckmate(chess) {
  if (!chess) {
    return false;
  }
  if (typeof chess.isCheckmate === "function") {
    return Boolean(chess.isCheckmate());
  }
  if (typeof chess.in_checkmate === "function") {
    return Boolean(chess.in_checkmate());
  }
  return false;
}

function selectDropMove(source, target, expectedUci) {
  if (!state.mate.chess) {
    return null;
  }
  const moves = state.mate.chess.moves({ square: source, verbose: true }).filter((move) => move.to === target);
  if (!moves.length) {
    return null;
  }
  const exact = moves.find((move) => verboseMoveToUci(move) === expectedUci);
  return exact || moves.find((move) => !move.promotion) || moves[0];
}

function updateMateProgressStatus() {
  if (!state.mate.activeMeta) {
    return;
  }
  if (state.mate.solved) {
    setMateStatus("Solved. Open the full game, move on, or finish the review.");
    return;
  }
  const expected = expectedMateMove();
  const remain = remainingMateMoves();
  if (!expected) {
    setMateStatus("Line finished.");
    return;
  }
  const turnSide = String(expected.side || "").toLowerCase();
  if (turnSide === String(state.mate.activeMeta.player_side || "").toLowerCase()) {
    setMateStatus(`Your turn. Mate in ${remain}.`);
  } else {
    setMateStatus(`Opponent to move. Forced line continues.`);
  }
}

function markActiveGameReviewed() {
  if (!state.mate.activeMeta) {
    return;
  }
  const usernameKey = currentUsernameKey();
  if (!usernameKey) {
    return;
  }
  const reviewedAt = new Date().toISOString();
  state.mate.reviewMap = {
    ...state.mate.reviewMap,
    [state.mate.activeMeta.review_key]: {
      reviewed_at: reviewedAt,
      game_id: state.mate.activeMeta.game_id,
      ply: state.mate.activeMeta.ply,
      best_mate: state.mate.activeMeta.best_mate
    }
  };
  writeMateReviewMap(usernameKey, state.mate.reviewMap);
  rebuildMateCollections();
  const refreshed = resolvePositionRow(state.mate.activeMeta.puzzle_key) || resolveGameRow(state.mate.activeMeta.review_key);
  if (refreshed) {
    state.mate.activeMeta = { ...state.mate.activeMeta, ...refreshed, reviewed: true, reviewed_at: reviewedAt };
  }
}

function finishSolvedPuzzle(message) {
  state.mate.autoPlaying = false;
  state.mate.solved = true;
  clearMateToast();
  showMateToast("Puzzle solved. Finish the review or open the full game.", "success");
  renderActiveMateSummary();
  syncMateButtons();
  setMateStatus(message || "Checkmate delivered. Use Finish review to move this game into history.");
}

function playForcedReply() {
  clearMateTimer("autoMoveTimer");
  if (!state.mate.activeMeta || !state.mate.activeLine.length || state.mate.solved) {
    state.mate.autoPlaying = false;
    syncMateButtons();
    return;
  }
  const expected = expectedMateMove();
  if (!expected) {
    if (isMateBoardCheckmate(state.mate.chess)) {
      finishSolvedPuzzle();
    } else {
      state.mate.autoPlaying = false;
      updateMateProgressStatus();
      renderActiveMateSummary();
      syncMateButtons();
    }
    return;
  }

  const playerSide = String(state.mate.activeMeta.player_side || "").toLowerCase();
  if (String(expected.side || "").toLowerCase() === playerSide) {
    state.mate.autoPlaying = false;
    updateMateProgressStatus();
    renderActiveMateSummary();
    syncMateButtons();
    return;
  }

  const applied = applyUciMove(state.mate.chess, expected.uci);
  if (!applied) {
    state.mate.autoPlaying = false;
    setMateStatus("Could not replay the defending move. Reload this puzzle.");
    return;
  }
  state.mate.nextIndex += 1;
  if (state.mate.board) {
    state.mate.board.position(state.mate.chess.fen(), true);
  }
  showMateToast("Opponent replied.", "info");

  if (isMateBoardCheckmate(state.mate.chess) || state.mate.nextIndex >= state.mate.activeLine.length) {
    finishSolvedPuzzle();
    return;
  }

  state.mate.autoPlaying = false;
  renderActiveMateSummary();
  updateMateProgressStatus();
  syncMateButtons();
}

function handleMateDrop(source, target) {
  if (!state.mate.activeMeta || !state.mate.chess || state.mate.loading || state.mate.autoPlaying || state.mate.solved) {
    return "snapback";
  }
  const expected = expectedMateMove();
  if (!expected) {
    return "snapback";
  }

  const pickedMove = selectDropMove(source, target, String(expected.uci || ""));
  if (!pickedMove) {
    return "snapback";
  }

  const attemptedUci = verboseMoveToUci(pickedMove);
  if (attemptedUci !== String(expected.uci || "")) {
    const alternativeMate = state.mate.chess.move({
      from: pickedMove.from,
      to: pickedMove.to,
      promotion: pickedMove.promotion || "q"
    });
    if (alternativeMate && isMateBoardCheckmate(state.mate.chess)) {
      state.mate.nextIndex = state.mate.activeLine.length;
      finishSolvedPuzzle("Checkmate delivered.");
      return undefined;
    }
    if (alternativeMate) {
      state.mate.chess.undo();
    }
    showMateToast(`Wrong move. The mate in ${remainingMateMoves()} is still there.`, "warn");
    setMateStatus("Wrong move. Try a cleaner finish.");
    return "snapback";
  }

  const applied = state.mate.chess.move({
    from: pickedMove.from,
    to: pickedMove.to,
    promotion: pickedMove.promotion || "q"
  });
  if (!applied) {
    return "snapback";
  }

  state.mate.nextIndex += 1;
  clearMateToast();
  if (isMateBoardCheckmate(state.mate.chess) || state.mate.nextIndex >= state.mate.activeLine.length) {
    finishSolvedPuzzle();
    return undefined;
  }

  state.mate.autoPlaying = true;
  renderActiveMateSummary();
  setMateStatus("Correct. Opponent is defending...");
  syncMateButtons();
  state.mate.autoMoveTimer = window.setTimeout(playForcedReply, BOARD_MOVE_ANIMATION_MS + 120);
  return undefined;
}

function nextPendingMateGame() {
  const pending = state.mate.queue || [];
  if (!pending.length) {
    return null;
  }
  if (!state.mate.activeMeta) {
    return pending[0];
  }
  const currentReviewKey = String(state.mate.activeMeta.review_key || "");
  const currentIndex = pending.findIndex((row) => row.review_key === currentReviewKey);
  if (currentIndex === -1) {
    return pending[0];
  }
  const nextDifferent = pending.slice(currentIndex + 1).find((row) => String(row.review_key || "") !== currentReviewKey)
    || pending.slice(0, currentIndex).find((row) => String(row.review_key || "") !== currentReviewKey);
  return nextDifferent || null;
}

async function loadMatePuzzle(row) {
  if (!row || state.mate.loading) {
    return;
  }
  if (!ensureMateBoardReady()) {
    return;
  }

  clearMateTimer("autoMoveTimer");
  clearMateToast();
  state.mate.loading = true;
  state.mate.autoPlaying = false;
  state.mate.solved = false;
  syncMateButtons();
  setMateStatus("Preparing forced mate line...");

  try {
    const response = await fetch("/api/mate-hunt/puzzle", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username: currentUsername(),
        game_id: row.game_id,
        ply: row.ply,
        side: row.player_side || row.side || "white"
      })
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Failed to open mate trainer.");
    }
    if (!Array.isArray(data.line) || !data.line.length) {
      throw new Error("Mate line is empty for this puzzle.");
    }

    const mergedMeta = {
      ...row,
      ...data,
      review_key: row.review_key || buildGameReviewKey(row),
      puzzle_key: row.puzzle_key || buildPuzzleKey(row)
    };

    state.mate.activeMeta = mergedMeta;
    state.mate.activeLine = data.line;
    state.mate.nextIndex = 0;
    state.mate.chess = createChess(data.start_fen || row.fen_before);
    state.mate.board.position(state.mate.chess.fen(), false);
    if (typeof state.mate.board.orientation === "function") {
      state.mate.board.orientation(String(mergedMeta.player_side || "white").toLowerCase() === "black" ? "black" : "white");
    }
    state.mate.board.resize();

    renderMateQueue();
    renderMateHistory();
    renderMatePositions();
    renderActiveMateSummary();
    updateMateProgressStatus();
  } catch (error) {
    resetMateBoard(error.message || "Failed to load mate trainer.");
  } finally {
    state.mate.loading = false;
    syncMateButtons();
  }
}

function renderMateHunt(payload) {
  const data = payload || {};
  const usernameKey = currentUsernameKey();

  if (state.mate.ownerUsername && state.mate.ownerUsername !== usernameKey) {
    resetMateBoard("Username changed. Pick a new puzzle.");
  }
  state.mate.ownerUsername = usernameKey;
  state.mate.reviewMap = readMateReviewMap(usernameKey);
  state.mate.games = normalizeMateGameRows(data.games, usernameKey);
  state.mate.positions = normalizeMatePositionRows(data.positions, usernameKey);
  rebuildMateCollections();

  const missedPositions = Number(data.missed_positions || 0);
  const gamesWithMissedFinish = Number(data.games_with_missed_finish || 0);
  const wonGamesWithMissedFinish = Number(data.won_games_with_missed_finish || 0);
  const mateInOneMissed = Number(data.mate_in_one_missed || 0);
  const shortestMate = Number(data.shortest_mate || 0);

  el.mateKpis.innerHTML = `
    <div class="stats-kpi">
      <div class="stats-kpi-item"><span class="label">Missed mate spots</span><span class="value highlight-negative">${missedPositions}</span></div>
      <div class="stats-kpi-item"><span class="label">Games in queue</span><span class="value">${gamesWithMissedFinish}</span></div>
      <div class="stats-kpi-item"><span class="label">Wins dragged out</span><span class="value highlight-positive">${wonGamesWithMissedFinish}</span></div>
      <div class="stats-kpi-item"><span class="label">Missed mate in 1</span><span class="value highlight-negative">${mateInOneMissed}</span></div>
      <div class="stats-kpi-item"><span class="label">Shortest mate</span><span class="value">${shortestMate > 0 ? `#${shortestMate}` : "-"}</span></div>
    </div>
    <div class="stats-note">Queue is sorted from the shortest forced mate upward. Solved games move into reviewed history and stop appearing in the main run.</div>
  `;

  renderMateQueue();
  renderMateHistory();
  renderMatePositions();

  if (!state.mate.games.length) {
    resetMateBoard("No missed mating finishes found in analyzed games.");
    return;
  }

  if (state.mate.activeMeta) {
    const refreshed = resolvePositionRow(state.mate.activeMeta.puzzle_key) || resolveGameRow(state.mate.activeMeta.review_key);
    if (refreshed) {
      state.mate.activeMeta = { ...state.mate.activeMeta, ...refreshed };
      renderActiveMateSummary();
      updateMateProgressStatus();
      syncMateButtons();
      return;
    }
  }

  renderActiveMateSummary();
  if (state.activeTab === "mate-hunt" && state.mate.queue.length) {
    void loadMatePuzzle(state.mate.queue[0]);
  } else {
    setMateStatus("Pick a game from the queue to start.");
    syncMateButtons();
  }
}

async function loadStats() {
  if (state.busy) {
    return;
  }
  const { username, maxGames } = persistInputs();
  if (!username) {
    el.status.textContent = "Enter username.";
    return;
  }

  setBusy(true);
  syncFilterQuery(username, maxGames);
  el.status.textContent = "Loading stats...";
  try {
    const query = new URLSearchParams({
      username,
      max_games: String(maxGames)
    });
    const response = await fetch(`/api/insights/overview?${query.toString()}`);
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Failed to load stats.");
    }

    state.lastStats = data;
    renderOpenings(Array.isArray(data.openings) ? data.openings : []);
    renderPhases(Array.isArray(data.phase_stats) ? data.phase_stats : []);
    renderFallingMoves(Array.isArray(data.falling_moves) ? data.falling_moves : []);
    renderWeakPieces(Array.isArray(data.weak_pieces) ? data.weak_pieces : []);
    renderTactics(data.tactics || {});
    renderAdvantage(data.advantage_play || {});
    renderMateHunt(data.mate_hunt || {});

    el.status.textContent = `Done: games ${data.loaded_games || 0}, analyzed ${data.analyzed_games || 0}.`;
    try {
      await syncPersistentBatchStatus({ refreshStatsOnFinish: false });
    } catch (statusError) {
      // keep the completed stats message if the batch status request fails
    }
  } catch (error) {
    el.status.textContent = error.message || "Stats load error.";
  } finally {
    setBusy(false);
  }
}

async function analyzeGame(gameId, side, index, total) {
  const payload = {
    game_id: gameId,
    side,
    depth: 14,
    threads: Math.max(1, Math.min(128, detectedCpuThreads)),
    hash_mb: Math.max(256, Math.min(8192, detectedCpuThreads * 128)),
    target_time_sec: 60,
    pv_plies: 3,
    force_reanalyze: true,
    allow_compatible_cache: false
  };
  el.status.textContent = `Reanalyze: ${index}/${total} (game_id=${gameId})`;
  setBusy(true, `Reanalyze ${index}/${total}`);

  const response = await fetch("/api/chesscom/analyze-game", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `Analysis failed for game_id=${gameId}`);
  }
}

async function reanalyzeAll() {
  if (state.busy || batchJobIsActive(state.batchJob)) {
    return;
  }
  const { username, maxGames } = persistInputs();
  if (!username) {
    el.status.textContent = "Enter username.";
    return;
  }

  try {
    const response = await fetch("/api/chesscom/batch-analysis/start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        username,
        max_games: maxGames,
        mode: "reanalyze",
        depth: 14,
        threads: Math.max(1, Math.min(128, detectedCpuThreads)),
        hash_mb: Math.max(256, Math.min(8192, detectedCpuThreads * 128)),
        target_time_sec: 60,
        pv_plies: 3
      })
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Failed to start reanalysis.");
    }
    applyPersistentBatchStatus(data.job || null, { refreshStatsOnFinish: true });
  } catch (error) {
    el.status.textContent = error.message || "Reanalysis error.";
  }
}

function handleMateActionClick(event) {
  const button = event.target.closest("button[data-mate-action]");
  if (!button) {
    return;
  }
  const action = String(button.dataset.mateAction || "");
  if (action === "play-game") {
    const row = resolveGameRow(button.dataset.reviewKey || "");
    if (row) {
      void loadMatePuzzle(row);
    }
    return;
  }
  if (action === "play-position") {
    const row = resolvePositionRow(button.dataset.puzzleKey || "");
    if (row) {
      void loadMatePuzzle(row);
    }
  }
}

function openActiveGameInMainTab() {
  if (!state.mate.activeMeta) {
    return;
  }
  const query = new URLSearchParams();
  const username = currentUsername();
  if (username) {
    query.set("username", username);
  }
  query.set("max_games", String(currentMaxGames()));
  query.set("game_id", String(state.mate.activeMeta.game_id || ""));
  query.set("side", String(state.mate.activeMeta.player_side || "white"));
  query.set("mate_review_game", String(state.mate.activeMeta.game_id || ""));
  query.set("mate_review_side", String(state.mate.activeMeta.player_side || "white"));
  query.set("focus_ply", String(clampInt(state.mate.activeMeta.ply, 1, 9999, 1)));
  window.location.href = `/?${query.toString()}`;
}

function finishActiveMateReview() {
  if (!state.mate.activeMeta || !state.mate.solved || state.mate.activeMeta.reviewed) {
    return;
  }
  markActiveGameReviewed();
  renderMateQueue();
  renderMateHistory();
  renderMatePositions();
  renderActiveMateSummary();
  syncMateButtons();
  showMateToast("Review finished. This game moved to history.", "success");
  setMateStatus("Review finished. Pick another game from the queue or replay history.");
}

function init() {
  const query = new URLSearchParams(window.location.search);
  const qUser = String(query.get("username") || "").trim();
  const qMax = query.get("max_games");
  const qTab = normalizeTab(query.get("tab"));

  const savedUsername = readStoredUsername();
  const savedMax = readStoredMaxGames();

  el.username.value = qUser || savedUsername || "";
  el.maxGames.value = String(clampInt(qMax || savedMax || 5000, 1, 5000, 5000));

  el.tabButtons.forEach((button) => {
    button.addEventListener("click", () => {
      setActiveTab(button.dataset.statsTab || "overview");
    });
  });
  el.btnLoad.addEventListener("click", loadStats);
  el.btnReanalyzeAll.addEventListener("click", reanalyzeAll);
  if (el.btnStopBatch) {
    el.btnStopBatch.addEventListener("click", async () => {
      try {
        await stopPersistentBatchAnalysis();
      } catch (error) {
        el.status.textContent = error.message || "Failed to stop batch analysis.";
      }
    });
  }
  if (el.btnMateNext) {
    el.btnMateNext.addEventListener("click", () => {
      const nextGame = nextPendingMateGame();
      if (nextGame) {
        void loadMatePuzzle(nextGame);
      }
    });
  }
  if (el.btnMateAnalyze) {
    el.btnMateAnalyze.addEventListener("click", openActiveGameInMainTab);
  }
  if (el.btnMateFinish) {
    el.btnMateFinish.addEventListener("click", finishActiveMateReview);
  }
  if (el.mateQueue) {
    el.mateQueue.addEventListener("click", handleMateActionClick);
  }
  if (el.mateHistory) {
    el.mateHistory.addEventListener("click", handleMateActionClick);
  }
  if (el.matePositions) {
    el.matePositions.addEventListener("click", handleMateActionClick);
  }

  window.addEventListener("resize", () => {
    if (state.mate.boardReady && state.mate.board) {
      state.mate.board.resize();
    }
  });

  setActiveTab(qTab, false);
  renderActiveMateSummary();

  if (el.username.value) {
    void loadStats().finally(() => {
      void syncPersistentBatchStatus({ refreshStatsOnFinish: true }).catch(() => {});
    });
  } else {
    el.status.textContent = 'Enter username and click "Refresh stats".';
    setMateStatus("Load analyzed games to start the trainer.");
  }
}

init();
