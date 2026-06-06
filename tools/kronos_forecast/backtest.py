"""Walk-forward backtest for Kronos on the stock-tracker watchlist.

For each symbol:
  1. Pull ~3 years of daily history.
  2. Step through the last year in `--step` day increments. At each step,
     slice off the future, run Kronos as if standing at that date, predict
     `--horizon` business days ahead, and compare against the actual close.
  3. Aggregate: direction hit rate, mean absolute error, mean signed bias,
     a naive "trade when Kronos says long" return vs. buy-and-hold.

Results are POSTed to /kronos/backtest. The dashboard's Kronos tab joins
them onto each forecast so you can see "AAPL: +3% forecast, 62% hit rate
on last year" at a glance.

This is slow — expect 30–90 minutes on M1 8GB. Run on demand, not daily.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import requests
import yfinance as yf

from forecast import Config, load_env, fetch_tickers


def backtest_symbol(
    predictor,  # type: ignore[no-untyped-def]
    sym: str,
    cfg: Config,
    horizon: int,
    step: int,
    n_windows: int,
) -> dict | None:
    """Return aggregated metrics for one symbol, or None on failure."""
    try:
        df = yf.download(
            sym,
            period="3y",
            interval="1d",
            auto_adjust=True,
            progress=False,
            threads=False,
        )
    except Exception as e:
        print(f"  ! {sym}: yfinance error: {e}", file=sys.stderr)
        return None
    if df is None or df.empty:
        return None
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    df = df.rename(columns=str.lower)
    needed = ["open", "high", "low", "close", "volume"]
    if any(c not in df.columns for c in needed):
        return None
    df = df[needed].dropna()
    if len(df) < cfg.lookback + horizon + 10:
        print(f"  - {sym}: not enough history for backtest")
        return None

    # Step backwards from the most recent date that still has `horizon`
    # days of "future" to compare against. Take the most recent n_windows
    # eligible step points.
    last_valid = len(df) - horizon - 1
    earliest = max(cfg.lookback, last_valid - n_windows * step)
    indices = list(range(earliest, last_valid + 1, step))
    if not indices:
        return None

    hits: list[int] = []
    abs_errs: list[float] = []
    signed_errs: list[float] = []
    long_returns: list[float] = []
    bh_returns: list[float] = []

    for i in indices:
        history = df.iloc[: i + 1]
        # Future window is the NEXT horizon days. Compare close at end of
        # window with current close at i.
        future = df.iloc[i + 1 : i + 1 + horizon]
        if len(future) < horizon:
            continue
        x_df = history.tail(cfg.lookback)
        x_ts = pd.Series(x_df.index)
        y_ts = pd.Series(future.index)
        try:
            pred = predictor.predict(
                df=x_df.reset_index(drop=True),
                x_timestamp=x_ts,
                y_timestamp=y_ts,
                pred_len=horizon,
                T=cfg.temperature,
                top_p=cfg.top_p,
                sample_count=1,
            )
        except Exception as e:
            print(f"  ! {sym} @ {history.index[-1].date()}: predict failed: {e}", file=sys.stderr)
            continue

        current = float(history["close"].iloc[-1])
        forecast = float(pred["close"].iloc[-1])
        actual = float(future["close"].iloc[-1])
        if current <= 0:
            continue
        forecast_ret = (forecast - current) / current
        actual_ret = (actual - current) / current

        hit = 1 if (forecast_ret > 0) == (actual_ret > 0) else 0
        hits.append(hit)
        abs_errs.append(abs(forecast_ret - actual_ret))
        signed_errs.append(forecast_ret - actual_ret)
        # Take the actual return when forecast was bullish, sit out when
        # bearish. Compounded.
        long_returns.append(actual_ret if forecast_ret > 0 else 0.0)
        bh_returns.append(actual_ret)

    if not hits:
        return None

    hit_rate = float(np.mean(hits))
    mae_pct = float(np.mean(abs_errs))
    signed_err_pct = float(np.mean(signed_errs))
    long_only_return_pct = float(np.prod([1 + r for r in long_returns]) - 1)
    buy_hold_return_pct = float(np.prod([1 + r for r in bh_returns]) - 1)

    return dict(
        symbol=sym,
        horizon_days=horizon,
        n_runs=len(hits),
        hit_rate=hit_rate,
        mae_pct=mae_pct,
        signed_err_pct=signed_err_pct,
        long_only_return_pct=long_only_return_pct,
        buy_hold_return_pct=buy_hold_return_pct,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description="Walk-forward backtest for Kronos.")
    parser.add_argument("--horizon", type=int, default=None, help="Days ahead per forecast (defaults to KRONOS_PRED_LEN).")
    parser.add_argument("--step", type=int, default=5, help="Days between backtest points.")
    parser.add_argument("--windows", type=int, default=60, help="Max number of backtest windows per symbol (most recent).")
    parser.add_argument("--symbols", type=str, default=None, help="Comma-separated symbols to backtest. Defaults to the watchlist.")
    args = parser.parse_args()

    env = load_env()
    cfg = Config.from_env(env)
    horizon = args.horizon or cfg.pred_len

    if not cfg.repo_dir.exists():
        print(f"Kronos repo not found at {cfg.repo_dir}.", file=sys.stderr)
        return 1
    sys.path.insert(0, str(cfg.repo_dir))

    try:
        from model import Kronos, KronosTokenizer, KronosPredictor  # type: ignore
    except ImportError as e:
        print(f"Could not import model: {e}", file=sys.stderr)
        return 1

    print(f"Loading {cfg.tokenizer_name} + {cfg.model_name}…")
    tokenizer = KronosTokenizer.from_pretrained(cfg.tokenizer_name)
    model = Kronos.from_pretrained(cfg.model_name)

    device = cfg.device
    try:
        predictor = KronosPredictor(model, tokenizer, device=device, max_context=cfg.lookback)
    except (RuntimeError, NotImplementedError) as e:
        print(f"  ! {device} init failed ({e}); falling back to cpu", file=sys.stderr)
        device = "cpu"
        predictor = KronosPredictor(model, tokenizer, device=device, max_context=cfg.lookback)
    print(f"Predictor ready on {device}.")

    if args.symbols:
        symbols = [s.strip().upper() for s in args.symbols.split(",") if s.strip()]
    else:
        symbols = fetch_tickers(cfg.api_base)
    print(
        f"Backtesting {len(symbols)} symbols at horizon={horizon}d, "
        f"step={args.step}d, windows≤{args.windows}…"
    )

    out_rows: list[dict] = []
    start = time.time()
    for idx, sym in enumerate(symbols, start=1):
        t0 = time.time()
        result = backtest_symbol(predictor, sym, cfg, horizon, args.step, args.windows)
        if result is None:
            continue
        out_rows.append(result)
        elapsed = time.time() - t0
        print(
            f"  [{idx:>2}/{len(symbols)}] {sym:>6}: "
            f"n={result['n_runs']:>3}, hit={result['hit_rate'] * 100:>5.1f}%, "
            f"MAE={result['mae_pct'] * 100:>5.2f}%, "
            f"bias={result['signed_err_pct'] * 100:>+5.2f}%, "
            f"long_only={result['long_only_return_pct'] * 100:>+6.2f}% vs "
            f"BH={result['buy_hold_return_pct'] * 100:>+6.2f}%  ({elapsed:.0f}s)"
        )

    total = time.time() - start
    print(f"\nTotal: {total / 60:.1f} min, {len(out_rows)} symbols backtested.")

    if not out_rows:
        print("Nothing to post.", file=sys.stderr)
        return 1

    body = dict(
        model=cfg.model_name.split("/")[-1],
        computed_at=int(time.time()),
        results=out_rows,
    )
    print(f"Posting {len(out_rows)} backtest results…")
    r = requests.post(
        f"{cfg.api_base}/kronos/backtest",
        json=body,
        headers={"Authorization": f"Bearer {cfg.api_key}"},
        timeout=60,
    )
    if not r.ok:
        print(f"Worker rejected batch: {r.status_code} {r.text}", file=sys.stderr)
        return 1
    print(f"Done: {r.json()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
