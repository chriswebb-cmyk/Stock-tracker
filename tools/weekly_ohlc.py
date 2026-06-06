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
    # The percentage columns are stored as raw decimal fractions (e.g.
    # 0.0042 for 0.42%) so spreadsheet apps applying percentage formatting
    # render them correctly. The terminal printer formats them as `0.42%`.
    out["Body $"] = out["Close"] - out["Open"]
    out["Body %"] = (out["Close"] - out["Open"]) / out["Open"]
    out["Range $"] = out["High"] - out["Low"]
    out["Range %"] = (out["High"] - out["Low"]) / out["Open"]
    out.index = out.index.date
    out.index.name = "date"
    return out


def display_frame(df: pd.DataFrame) -> pd.DataFrame:
    """Stringify each column the way a human reads it: $ for prices and
    body/range, % for the percentage columns. Underlying DataFrame stays
    numeric so the CSV export is still spreadsheet-friendly.
    """
    out = df.copy()
    for col in out.columns:
        if col in ("Body %", "Range %"):
            out[col] = out[col].apply(
                lambda v: f"{v * 100:>+8.2f}%" if pd.notna(v) else ""
            )
        else:
            out[col] = out[col].apply(
                lambda v: f"${v:>9.2f}" if pd.notna(v) else ""
            )
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
        print(display_frame(df).to_string())

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
