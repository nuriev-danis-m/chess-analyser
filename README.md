# Chess PGN Analyzer (Stockfish)

Web app for analyzing chess games from Chess.com and PGN.

## Features
- Load games from Chess.com PubAPI by username or profile URL.
- Analyze a selected game and save results in local cache.
- Load PGN from file, text input, or clipboard.
- Interactive board with manual variation analysis.
- Move categories: `Brilliant`, `Great`, `Book`, `Best`, `Excellent`, `Good`, `Inaccuracy`, `Mistake`, `Miss`, `Blunder`.
- Stockfish recommendations with arrows and advantage chart.
- API and analysis logging.

## Quick Start
```powershell
cd C:\Scirpts\Chess
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
python run_server.py
```

Open in browser: `http://127.0.0.1:5000`

## Stockfish
The engine binary is not included in the repository (large binaries are excluded).
Set the path in one of these ways:

1. Via `STOCKFISH_PATH` environment variable:
```powershell
$env:STOCKFISH_PATH="C:\path\to\stockfish.exe"
```
2. Or place `stockfish.exe` at `bin\stockfish.exe` (locally, not in git).

Engine lookup order in code:
1. `STOCKFISH_PATH`;
2. `stockfish` / `stockfish.exe` in `PATH`;
3. `./bin/stockfish(.exe)`;
4. `C:\Program Files\Stockfish\stockfish.exe`.

## Data Storage
- `data/chesscom_games_store.json` - loaded Chess.com games;
- `data/analysis_store.json` - saved analysis results;
- `logs/app.log` - app log.

These files are local and are not committed to git.

## Chess.com Username
- The username input has no default value.
- After first input and game load, the name is saved in browser `localStorage` and auto-filled later.
