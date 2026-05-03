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
```bash
cd /path/to/chess-analyser
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
pip install -r requirements.txt
python run_server.py
```

Open in browser: `http://127.0.0.1:5000`

### Windows
```powershell
cd C:\path\to\chess-analyser
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
python run_server.py
```

### Host and Port
The app reads optional environment variables:

- `HOST` (default: `127.0.0.1`)
- `PORT` (default: `5000`)

## Stockfish
The engine binary is not included in the repository (large binaries are excluded).
Set the path in one of these ways:

1. Via `STOCKFISH_PATH` environment variable:
```bash
export STOCKFISH_PATH="/path/to/stockfish"
```
On Windows PowerShell:
```powershell
$env:STOCKFISH_PATH="C:\path\to\stockfish.exe"
```
2. Or install `stockfish` so it is available in `PATH`.
3. Or place a local binary at `./bin/stockfish` or `./bin/stockfish.exe` (not in git).

Engine lookup order in code:
1. `STOCKFISH_PATH`;
2. `stockfish` / `stockfish.exe` in `PATH`;
3. `./bin/stockfish` / `./bin/stockfish.exe`;
4. common Linux locations such as `/usr/local/bin/stockfish`, `/usr/bin/stockfish`, `/usr/games/stockfish`;
5. common macOS locations such as `/opt/homebrew/bin/stockfish`;
6. common Windows locations under `C:\Program Files\Stockfish`.

## Data Storage
- `data/chesscom_games_store.json` - loaded Chess.com games;
- `data/analysis_store.json` - saved analysis results;
- `logs/app.log` - app log.

These files are local and are not committed to git.

## Chess.com Username
- The username input has no default value.
- After first input and game load, the name is saved in browser `localStorage` and auto-filled later.
