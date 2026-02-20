const STORAGE_KEYS = {
  chesscomUsername: "chess_analyzer.chesscom_username",
  chesscomMaxGames: "chess_analyzer.chesscom_max_games"
};

const detectedCpuThreads = Math.max(1, Math.floor(Number(window.navigator && window.navigator.hardwareConcurrency) || 0) || 4);

const el = {
  username: document.getElementById("stats-username"),
  maxGames: document.getElementById("stats-max-games"),
  btnLoad: document.getElementById("btn-load-stats"),
  btnReanalyzeAll: document.getElementById("btn-reanalyze-all-stats"),
  status: document.getElementById("stats-status"),
  openings: document.getElementById("stats-openings"),
  phases: document.getElementById("stats-phases"),
  falling: document.getElementById("stats-falling"),
  pieces: document.getElementById("stats-pieces"),
  tactics: document.getElementById("stats-tactics"),
  advantage: document.getElementById("stats-advantage")
};

let busy = false;

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
  const maxGames = clampInt(el.maxGames.value, 1, 5000, 5000);
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
  busy = Boolean(isBusy);
  el.btnLoad.disabled = busy;
  el.btnReanalyzeAll.disabled = busy;
  if (!busy) {
    el.btnLoad.textContent = "Refresh stats";
    el.btnReanalyzeAll.textContent = "Reanalyze All";
  } else if (label) {
    el.btnReanalyzeAll.textContent = label;
  }
}

function renderTable(container, columns, rows, emptyLabel) {
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
      return `<tr>${cells}</tr>`;
    })
    .join("");
  container.innerHTML = `
    <table class="stats-table">
      <thead><tr>${th}</tr></thead>
      <tbody>${body}</tbody>
    </table>
  `;
}

function percentLabel(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return "-";
  }
  return `${num.toFixed(1)}%`;
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

async function loadStats() {
  if (busy) {
    return;
  }
  const { username, maxGames } = persistInputs();
  if (!username) {
    el.status.textContent = "Enter username.";
    return;
  }

  setBusy(true);
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

    renderOpenings(Array.isArray(data.openings) ? data.openings : []);
    renderPhases(Array.isArray(data.phase_stats) ? data.phase_stats : []);
    renderFallingMoves(Array.isArray(data.falling_moves) ? data.falling_moves : []);
    renderWeakPieces(Array.isArray(data.weak_pieces) ? data.weak_pieces : []);
    renderTactics(data.tactics || {});
    renderAdvantage(data.advantage_play || {});

    el.status.textContent = `Done: games ${data.loaded_games || 0}, analyzed ${data.analyzed_games || 0}.`;
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
  if (busy) {
    return;
  }
  const { username, maxGames } = persistInputs();
  if (!username) {
    el.status.textContent = "Enter username.";
    return;
  }

  setBusy(true, "Reanalyze 0/0");
  try {
    el.status.textContent = "Loading game list for reanalysis...";
    const listResp = await fetch(`/api/chesscom/cached-games?username=${encodeURIComponent(username)}&max_games=${encodeURIComponent(maxGames)}`);
    const listData = await listResp.json();
    if (!listResp.ok) {
      throw new Error(listData.error || "Failed to fetch games.");
    }
    const games = Array.isArray(listData.games) ? listData.games : [];
    if (!games.length) {
      el.status.textContent = "No games to reanalyze.";
      return;
    }

    let ok = 0;
    let fail = 0;
    for (let i = 0; i < games.length; i += 1) {
      const game = games[i] || {};
      const gameId = String(game.game_id || "").trim();
      const side = String(game.player_side || "").toLowerCase() === "black" ? "black" : "white";
      if (!gameId) {
        fail += 1;
        continue;
      }
      try {
        await analyzeGame(gameId, side, i + 1, games.length);
        ok += 1;
      } catch (error) {
        fail += 1;
      }
    }
    el.status.textContent = `Reanalysis complete. Success: ${ok}, failed: ${fail}. Refreshing stats...`;
    await loadStats();
  } catch (error) {
    el.status.textContent = error.message || "Reanalysis error.";
  } finally {
    setBusy(false);
  }
}

function init() {
  const query = new URLSearchParams(window.location.search);
  const qUser = String(query.get("username") || "").trim();
  const qMax = query.get("max_games");

  const savedUsername = readStoredUsername();
  const savedMax = readStoredMaxGames();

  el.username.value = qUser || savedUsername || "";
  el.maxGames.value = String(clampInt(qMax || savedMax || 5000, 1, 5000, 5000));

  el.btnLoad.addEventListener("click", loadStats);
  el.btnReanalyzeAll.addEventListener("click", reanalyzeAll);

  if (el.username.value) {
    void loadStats();
  } else {
    el.status.textContent = 'Enter username and click "Refresh stats".';
  }
}

init();


