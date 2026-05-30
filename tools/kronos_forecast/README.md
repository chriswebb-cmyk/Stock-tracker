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

## Running

```sh
cd tools/kronos_forecast
source .venv/bin/activate
python forecast.py
```

The first run downloads model weights (~50 MB for mini, ~200 MB for small)
from Hugging Face. Subsequent runs are fast. Expect:

- **Kronos-mini** on M1 8 GB: ~5–10 s per symbol, peak RAM ~1 GB.
- **Kronos-small**: ~15–30 s per symbol, peak RAM ~2 GB.

For ~25 symbols that's 2–4 minutes (mini) or 6–12 minutes (small). Run it
once a day before the market opens.

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
