"""Print last-trading-day-of-each-week OHLC for one or more symbols.

Usage:
  python weekly_ohlc.py                # SPY + ^GSPC (SPX), last 1 year
  python weekly_ohlc.py SPY ^GSPC QQQ  # any symbol list
  python weekly_ohlc.py --period 2y    # custom history window
  python weekly_ohlc.py --csv out.csv  # also save to CSV

Run from any directory; uses the closest venv with yfinance installed
(the kronos_forecast or chronos_forecast .venv works).
"""

from __future__ import annotations

import argparse
import sys

import pandas as pd
import yfinance as yf


def weekly_last(symbol: str, period: str) -> pd.DataFrame | None:
    df = yf.download(
        symbol,
        period=period,
        interval="1d",
        auto_adjust=False,
        progress=False,
        threads=False,
    )
    if df is None or df.empty:
        return None
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    needed = ["Open", "High", "Low", "Close"]
    if any(c not in df.columns for c in needed):
        return None
    df = df[needed].dropna()
    # ISO week period, then keep the last bar in each week (= Friday or
    # the nearest preceding trading day on a holiday-shortened week).
    df = df.copy()
    df["week"] = df.index.to_period("W-FRI")
    last = df.groupby("week").tail(1)
    out = last[needed].copy()
    # Body = close - open (positive = green candle). Range = high - low.
    # Percentages are referenced to the open so they're comparable across
    # symbols at very different price levels.
    out["Body $"] = out["Close"] - out["Open"]
    out["Body %"] = (out["Close"] - out["Open"]) / out["Open"] * 100
    out["Range $"] = out["High"] - out["Low"]
    out["Range %"] = (out["High"] - out["Low"]) / out["Open"] * 100
    out.index = out.index.date
    out.index.name = "date"
    return out


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("symbols", nargs="*", default=["SPY", "^GSPC"])
    p.add_argument("--period", default="1y")
    p.add_argument("--csv", default=None, help="Also write all symbols to this CSV.")
    args = p.parse_args()

    frames: dict[str, pd.DataFrame] = {}
    for sym in args.symbols:
        df = weekly_last(sym, args.period)
        if df is None:
            print(f"!! no data for {sym}", file=sys.stderr)
            continue
        frames[sym] = df
        print(f"\n=== {sym} ({len(df)} weeks) ===")
        # Pretty print with 2dp money formatting.
        with pd.option_context("display.float_format", lambda v: f"{v:>10.2f}"):
            print(df.to_string())

    if args.csv and frames:
        merged = pd.concat(
            {sym: df for sym, df in frames.items()},
            axis=1,
        )
        merged.to_csv(args.csv)
        print(f"\nwrote {args.csv}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
