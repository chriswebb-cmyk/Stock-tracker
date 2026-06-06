# Chronos local forecaster

Sibling to `tools/kronos_forecast/`. Runs Amazon's
[Chronos](https://github.com/amazon-science/chronos-forecasting) foundation
model on your Mac and posts daily forecasts to the worker. The dashboard
ensembles it against Kronos — agreement raises conviction, disagreement is
a yellow flag.

Chronos is **univariate** — it consumes close prices only, no OHLCV.
That makes it cheap to set up and a genuinely independent second opinion
versus Kronos (which is multivariate). Default model `chronos-bolt-tiny`
is ~9M params and ~250× faster than the original Chronos.

## One-time setup

```sh
cd ~/Desktop/options\ trading/Stock-tracker/tools/chronos_forecast
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
# Edit .env: paste the SAME KRONOS_API_KEY value you set on the worker.
# (No new secret needed — the worker reuses KRONOS_API_KEY for both models.)
```

The D1 migration (`chronos_forecasts` + `chronos_backtest` tables) is
already in `db/schema.sql`. Apply it once with:

```sh
cd ../../workers/api
npx wrangler d1 execute stock-tracker --remote --command="CREATE TABLE IF NOT EXISTS chronos_forecasts (symbol TEXT NOT NULL, generated_at INTEGER NOT NULL, horizon_days INTEGER NOT NULL, current_close REAL NOT NULL, forecast_close REAL NOT NULL, forecast_p10 REAL, forecast_p90 REAL, expected_return_pct REAL NOT NULL, sample_count INTEGER NOT NULL, model_name TEXT NOT NULL, PRIMARY KEY (symbol, generated_at, horizon_days));"
npx wrangler d1 execute stock-tracker --remote --command="CREATE TABLE IF NOT EXISTS chronos_backtest (symbol TEXT NOT NULL, horizon_days INTEGER NOT NULL, computed_at INTEGER NOT NULL, n_runs INTEGER NOT NULL, hit_rate REAL NOT NULL, mae_pct REAL NOT NULL, signed_err_pct REAL NOT NULL, long_only_return_pct REAL, buy_hold_return_pct REAL, model_name TEXT NOT NULL, PRIMARY KEY (symbol, horizon_days));"
npm run deploy
```

## Quick-launch shortcut

Drop a copy of `run_forecast.command` on your Desktop and double-click.

## Running manually

```sh
./.venv/bin/python forecast.py
```

The first run downloads the model (~50 MB for tiny, ~200 MB for small).
With `chronos-bolt-tiny` on M1 8GB, expect **under 30 seconds** for ~25
symbols — Bolt is dramatically faster than Kronos.

## Tuning on 8GB

If you want bigger models:
- `CHRONOS_MODEL=amazon/chronos-bolt-mini` — still trivially fits, slightly slower.
- `CHRONOS_MODEL=amazon/chronos-bolt-small` — comfortable on 8GB, ~2× slower.
- Avoid `chronos-bolt-base` and `chronos-t5-large` — they'll thrash swap on 8GB.

## Why this matters

Kronos and Chronos use different architectures, training data, and
inputs. When they both flag AAPL as bullish, that's a much stronger
signal than either alone. The dashboard's Chronos tab shows them
side-by-side and computes an **agreement** column.
