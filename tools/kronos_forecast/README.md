# Kronos local forecaster

A small Python harness that runs the [Kronos](https://github.com/shiyu-coder/Kronos)
foundation model on your Mac and posts daily price forecasts to the
stock-tracker worker. The dashboard's **Kronos** tab reads them back.

This is a **second opinion** layer. The intraday ML produces minute-resolution
signals; Kronos produces a multi-day outlook. Agreement between the two
raises conviction; conflict is a yellow flag.

## One-time setup

```sh
# 1. Clone Kronos somewhere outside this repo.
git clone https://github.com/shiyu-coder/Kronos.git ~/Kronos

# 2. Set up a Python env (conda or venv).
cd /path/to/Stock-tracker/tools/kronos_forecast
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
pip install -r ~/Kronos/requirements.txt   # Kronos's own deps

# 3. Configure secrets.
cp .env.example .env
# Edit .env: set KRONOS_API_KEY to any long random string.

# 4. Tell the worker the same secret.
cd ../../workers/api
npx wrangler secret put KRONOS_API_KEY
# Paste the same string. Then redeploy:
npm run deploy

# 5. Apply the DB migration (adds the kronos_forecasts table).
npx wrangler d1 execute stock-tracker --remote --file=../../db/schema.sql
```

## Quick-launch shortcuts (Desktop)

Two double-clickable wrappers ship with the repo so you don't have to
open a terminal every time:

- `run_forecast.command` — runs `forecast.py` and leaves the Terminal
  window open so you can read the output.
- `run_backtest.command` — runs `backtest.py`; accepts the same flags
  (passes any args through), so e.g. you can make a copy named
  `backtest_quick.command` whose only difference is calling
  `./.venv/bin/python backtest.py --symbols AAPL,NVDA --windows 10`.

Drop copies of either file on your Desktop (or anywhere) and
double-click. macOS may warn the first time about "unidentified
developer" — right-click → Open and pick Open from the prompt.

The wrappers assume the repo lives at
`~/Desktop/options trading/Stock-tracker`. If you moved it, edit
`KRONOS_DIR` near the top of each file.

## Running

```sh
cd tools/kronos_forecast
source .venv/bin/activate
./.venv/bin/python forecast.py
```

The first run downloads model weights (~50 MB for mini, ~200 MB for small)
from Hugging Face. Subsequent runs are fast.

Each forecast pulls N independent paths (`KRONOS_SAMPLE_COUNT`, default 5)
so the dashboard can show real P10/P90 confidence bands. With N=5 expect:

- **Kronos-mini** on M1 8 GB: ~10–30 s per symbol, peak RAM ~1 GB.
- **Kronos-small**: ~30–60 s per symbol, peak RAM ~2 GB.

For ~25 symbols that's 4–12 minutes (mini) or 12–25 minutes (small). Run
it once a day before the market opens.

### Backtest

`backtest.py` walks back through the last year's worth of trading days,
runs Kronos at each historical date, and scores the prediction against
what actually happened. Posts hit-rate and MAE per symbol; the dashboard
joins it onto each forecast row. Slow — plan for 30–90 min on mini.

```sh
./.venv/bin/python backtest.py                        # last 60 windows, 5d step
./.venv/bin/python backtest.py --windows 30 --step 7  # quicker
./.venv/bin/python backtest.py --symbols AAPL,NVDA    # subset for testing
```

Re-run when you change the model size or horizon. The numbers stay valid
otherwise — old hit rates inform new forecasts.

## Automating (optional)

A `launchd` plist or cron entry can run this nightly. Example crontab line
(Mac: `crontab -e`):

```
30 8 * * 1-5 cd ~/Desktop/options\ trading/Stock-tracker/tools/kronos_forecast && ./.venv/bin/python forecast.py >> ~/kronos.log 2>&1
```

That runs 8:30 AM ET on weekdays.

## Tuning on 8 GB

If memory pressure hits or inference is too slow:

- Drop `KRONOS_MODEL` from `Kronos-small` to `Kronos-mini`.
- Lower `KRONOS_LOOKBACK` from 480 to e.g. 256.
- Lower `KRONOS_SAMPLE_COUNT` from 5 to 1 (faster, noisier forecasts).
- Switch `KRONOS_DEVICE` from `mps` to `cpu` — slower but uses less RAM.

## Troubleshooting

**`ImportError: cannot import name 'Kronos'`** — Kronos repo not found at
`KRONOS_REPO` or its `model/` package isn't on `sys.path`. Check the path
in `.env`.

**`401 invalid bearer token`** — `.env`'s `KRONOS_API_KEY` doesn't match
the worker's secret. Re-run `wrangler secret put` and redeploy.

**`mps init failed`** — Some torch versions can't run all of Kronos's ops
on MPS. The script auto-falls-back to CPU; you'll see a warning. To force
CPU, set `KRONOS_DEVICE=cpu`.

**No forecasts in the dashboard** — Check the JSON response: `curl
$STOCK_TRACKER_API/kronos/latest`. If empty, the POST never landed; check
the script's exit message.
