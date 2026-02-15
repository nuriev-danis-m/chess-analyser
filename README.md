# Chess PGN Analyzer (Stockfish)

Веб-приложение для анализа шахматных партий из Chess.com и PGN.

## Возможности
- загрузка партий с Chess.com PubAPI по username или ссылке профиля;
- анализ выбранной партии и сохранение анализа в локальный кэш;
- загрузка PGN из файла, текстом и из буфера обмена;
- интерактивная доска с ручным разбором вариантов;
- категории ходов: `Brilliant`, `Great`, `Book`, `Best`, `Excellent`, `Good`, `Inaccuracy`, `Mistake`, `Miss`, `Blunder`;
- подсветка рекомендаций Stockfish и график преимущества;
- логирование API-запросов и анализа.

## Быстрый запуск
```powershell
cd C:\Scirpts\Chess
py -3 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
pip install -r requirements.txt
python run_server.py
```

Откройте в браузере: `http://127.0.0.1:5000`

## Stockfish
В репозиторий движок не добавляется (бинарники большие).
Укажите путь одним из способов:

1. Через переменную окружения `STOCKFISH_PATH`:
```powershell
$env:STOCKFISH_PATH="C:\path\to\stockfish.exe"
```
2. Или положите `stockfish.exe` в `bin\stockfish.exe` (локально, не в git).

Порядок поиска движка в коде:
1. `STOCKFISH_PATH`;
2. `stockfish`/`stockfish.exe` в `PATH`;
3. `./bin/stockfish(.exe)`;
4. `C:\Program Files\Stockfish\stockfish.exe`.

## Где хранятся данные
- `data/chesscom_games_store.json` - загруженные партии Chess.com;
- `data/analysis_store.json` - сохраненные результаты анализа;
- `logs/app.log` - лог приложения.

Эти файлы локальные и в git не коммитятся.

## Username Chess.com
- В поле username нет значения по умолчанию.
- После первого ввода и загрузки игр имя сохраняется в браузере (`localStorage`) и подставляется автоматически.
