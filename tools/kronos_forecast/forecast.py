"""Run Kronos forecasts for the stock-tracker watchlist and post them back.

Workflow:
  1. Read the watchlist from the worker's /tickers endpoint.
  2. Fetch ~2 years of daily OHLCV per symbol from Yahoo (yfinance).
  3. Run Kronos to forecast the next N business days.
  4. POST a batch of {symbol, forecast_close, ...} rows to /kronos/forecast.

Run from this directory after `pip install -r requirements.txt` and
copying .env.example to .env.
"""

from __future__ import annotations

import os
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd
import requests
import yfinance as yf


def load_env() -> dict[str, str]:
    """Tiny .env loader (avoids depending on python-dotenv)."""
    import re

    env: dict[str, str] = {}
    env_file = Path(__file__).parent / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            # Strip inline comments (' #' or '\t#'). Leaves URL fragments
            # like https://example.com#frag alone since there's no
            # whitespace before the '#'.
            v = re.split(r"\s+#", v, maxsplit=1)[0].strip()
            # Strip surrounding quotes if present.
            if len(v) >= 2 and v[0] == v[-1] and v[0] in ("'", '"'):
                v = v[1:-1]
            env[k.strip()] = v
    # Process env wins over .env.
    env.update({k: v for k, v in os.environ.items() if k in env or k.startswith("KRONOS_") or k == "STOCK_TRACKER_API"})
    return env


@dataclass
class Config:
    api_base: str
    api_key: str
    repo_dir: Path
    model_name: str
    tokenizer_name: str
    pred_len: int
    lookback: int
    sample_count: int
    temperature: float
    top_p: float
    device: str

    @classmethod
    def from_env(cls, env: dict[str, str]) -> "Config":
        repo = Path(os.path.expanduser(env.get("KRONOS_REPO", "~/Kronos"))).resolve()
        return cls(
            api_base=env["STOCK_TRACKER_API"].rstrip("/"),
            api_key=env["KRONOS_API_KEY"],
            repo_dir=repo,
            model_name=env.get("KRONOS_MODEL", "NeoQuasar/Kronos-mini"),
            tokenizer_name=env.get("KRONOS_TOKENIZER", "NeoQuasar/Kronos-Tokenizer-base"),
            pred_len=int(env.get("KRONOS_PRED_LEN", "5")),
            lookback=int(env.get("KRONOS_LOOKBACK", "480")),
            sample_count=int(env.get("KRONOS_SAMPLE_COUNT", "5")),
            temperature=float(env.get("KRONOS_TEMPERATURE", "1.0")),
            top_p=float(env.get("KRONOS_TOP_P", "0.9")),
            device=env.get("KRONOS_DEVICE", "mps"),
        )


def fetch_tickers(api_base: str) -> list[str]:
    r = requests.get(f"{api_base}/tickers", timeout=30)
    r.raise_for_status()
    rows = r.json()
    # Skip indices like ^VIX / ^TNX — Yahoo daily is fine on them, but Kronos
    # daily forecasts on volatility/yield indices aren't useful.
    return [
        t["symbol"]
        for t in rows
        if t.get("enabled") and not t["symbol"].startswith("^")
    ]


def fetch_daily(symbol: str, lookback: int) -> Optional[pd.DataFrame]:
    """Pull daily OHLCV from Yahoo. Returns lower-cased columns."""
    try:
        # ~lookback business days + safety margin → roughly lookback*1.5 days
        period_days = int(lookback * 1.5) + 30
        df = yf.download(
            symbol,
            period=f"{max(period_days, 365)}d",
            interval="1d",
            auto_adjust=True,
            progress=False,
            threads=False,
        )
    except Exception as e:
        print(f"  ! yfinance error for {symbol}: {e}", file=sys.stderr)
        return None
    if df is None or df.empty:
        return None
    # Some yfinance versions return MultiIndex columns when threads is on.
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    df = df.rename(columns=str.lower)
    needed = ["open", "high", "low", "close", "volume"]
    if any(c not in df.columns for c in needed):
        return None
    df = df[needed].dropna()
    if len(df) < 64:
        return None
    return df.tail(lookback)


def main() -> int:
    env = load_env()
    cfg = Config.from_env(env)

    if not cfg.repo_dir.exists():
        print(
            f"Kronos repo not found at {cfg.repo_dir}. Clone it:\n"
            f"  git clone https://github.com/shiyu-coder/Kronos.git {cfg.repo_dir}",
            file=sys.stderr,
        )
        return 1
    sys.path.insert(0, str(cfg.repo_dir))

    # Imports deferred until after sys.path is set.
    try:
        from model import Kronos, KronosTokenizer, KronosPredictor  # type: ignore
    except ImportError as e:
        print(
            f"Could not import from {cfg.repo_dir}/model: {e}\n"
            "Verify the repo is intact and requirements.txt is installed.",
            file=sys.stderr,
        )
        return 1

    print(f"Loading {cfg.tokenizer_name}…")
    tokenizer = KronosTokenizer.from_pretrained(cfg.tokenizer_name)
    print(f"Loading {cfg.model_name}…")
    model = Kronos.from_pretrained(cfg.model_name)

    # MPS fallback: torch's MPS backend is missing a handful of ops; if the
    # model fails to move, fall back to CPU rather than crashing the run.
    device = cfg.device
    try:
        predictor = KronosPredictor(
            model, tokenizer, device=device, max_context=cfg.lookback
        )
    except (RuntimeError, NotImplementedError) as e:
        print(f"  ! {device} init failed ({e}); falling back to cpu", file=sys.stderr)
        device = "cpu"
        predictor = KronosPredictor(
            model, tokenizer, device=device, max_context=cfg.lookback
        )
    print(f"Predictor ready on {device}.")

    symbols = fetch_tickers(cfg.api_base)
    print(f"Forecasting {len(symbols)} symbols, horizon={cfg.pred_len} business days…")

    out_rows: list[dict] = []
    generated_at = int(time.time())

    for sym in symbols:
        df = fetch_daily(sym, cfg.lookback)
        if df is None:
            print(f"  - {sym}: no usable history")
            continue

        x_timestamp = pd.Series(df.index)
        last_ts = df.index[-1]
        y_timestamp = pd.Series(
            pd.bdate_range(
                start=last_ts + pd.Timedelta(days=1), periods=cfg.pred_len
            )
        )

        try:
            pred = predictor.predict(
                df=df.reset_index(drop=True),
                x_timestamp=x_timestamp,
                y_timestamp=y_timestamp,
                pred_len=cfg.pred_len,
                T=cfg.temperature,
                top_p=cfg.top_p,
                sample_count=cfg.sample_count,
            )
        except Exception as e:
            print(f"  ! {sym}: predict() failed: {e}", file=sys.stderr)
            continue

        current_close = float(df["close"].iloc[-1])
        forecast_close = float(pred["close"].iloc[-1])
        forecast_high = float(pred["high"].max()) if "high" in pred else None
        forecast_low = float(pred["low"].min()) if "low" in pred else None
        ret = (forecast_close - current_close) / current_close
        sign = "+" if ret >= 0 else ""
        print(
            f"  {sym:>6}: ${current_close:>8.2f} → ${forecast_close:>8.2f} "
            f"({sign}{ret * 100:.2f}%)"
        )
        out_rows.append(
            dict(
                symbol=sym,
                horizon_days=cfg.pred_len,
                current_close=current_close,
                forecast_close=forecast_close,
                forecast_high=forecast_high,
                forecast_low=forecast_low,
                sample_count=cfg.sample_count,
            )
        )

    if not out_rows:
        print("No forecasts produced.", file=sys.stderr)
        return 1

    body = dict(
        model=cfg.model_name.split("/")[-1],  # e.g. 'Kronos-mini'
        generated_at=generated_at,
        forecasts=out_rows,
    )
    print(f"Posting {len(out_rows)} forecasts…")
    r = requests.post(
        f"{cfg.api_base}/kronos/forecast",
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
