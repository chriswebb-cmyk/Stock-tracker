"""Run Chronos (Amazon) forecasts for the stock-tracker watchlist.

Chronos is univariate — it predicts close-price trajectory from close-price
history alone. That's both a strength (no need to clean OHLCV) and a
limitation (no volume/intraday-range signal). It's a useful complement to
Kronos: when both agree on direction, conviction is higher; when they
disagree, that's a flag to skip the trade.

Run from this directory after `pip install -r requirements.txt` and
copying .env.example to .env.
"""

from __future__ import annotations

import os
import re
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
    env: dict[str, str] = {}
    env_file = Path(__file__).parent / ".env"
    if env_file.exists():
        for line in env_file.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            v = re.split(r"\s+#", v, maxsplit=1)[0].strip()
            if len(v) >= 2 and v[0] == v[-1] and v[0] in ("'", '"'):
                v = v[1:-1]
            env[k.strip()] = v
    env.update({
        k: v for k, v in os.environ.items()
        if k in env or k.startswith("CHRONOS_") or k == "STOCK_TRACKER_API" or k == "KRONOS_API_KEY"
    })
    return env


@dataclass
class Config:
    api_base: str
    api_key: str
    model_name: str
    pred_len: int
    lookback: int
    sample_count: int
    device: str

    @classmethod
    def from_env(cls, env: dict[str, str]) -> "Config":
        return cls(
            api_base=env["STOCK_TRACKER_API"].rstrip("/"),
            api_key=env["KRONOS_API_KEY"],
            model_name=env.get("CHRONOS_MODEL", "amazon/chronos-bolt-tiny"),
            pred_len=int(env.get("CHRONOS_PRED_LEN", "5")),
            lookback=int(env.get("CHRONOS_LOOKBACK", "480")),
            sample_count=int(env.get("CHRONOS_SAMPLE_COUNT", "20")),
            device=env.get("CHRONOS_DEVICE", "mps"),
        )


def fetch_tickers(api_base: str) -> list[str]:
    r = requests.get(f"{api_base}/tickers", timeout=30)
    r.raise_for_status()
    rows = r.json()
    return [
        t["symbol"]
        for t in rows
        if t.get("enabled") and not t["symbol"].startswith("^")
    ]


def fetch_daily(symbol: str, lookback: int) -> Optional[pd.DataFrame]:
    try:
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
    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)
    df = df.rename(columns=str.lower)
    if "close" not in df.columns:
        return None
    df = df[["close"]].dropna()
    if len(df) < 64:
        return None
    return df.tail(lookback)


def main() -> int:
    env = load_env()
    cfg = Config.from_env(env)

    # Chronos lives in its own package — no repo to clone.
    try:
        import torch
        from chronos import BaseChronosPipeline  # type: ignore
    except ImportError as e:
        print(
            f"Could not import chronos: {e}\n"
            "Run `pip install -r requirements.txt` in this directory.",
            file=sys.stderr,
        )
        return 1

    print(f"Loading {cfg.model_name}…")
    device = cfg.device
    try:
        pipeline = BaseChronosPipeline.from_pretrained(
            cfg.model_name,
            device_map=device,
            torch_dtype=torch.float32,
        )
    except (RuntimeError, NotImplementedError, ValueError) as e:
        print(f"  ! {device} init failed ({e}); falling back to cpu", file=sys.stderr)
        device = "cpu"
        pipeline = BaseChronosPipeline.from_pretrained(
            cfg.model_name,
            device_map=device,
            torch_dtype=torch.float32,
        )
    print(f"Pipeline ready on {device}.")

    symbols = fetch_tickers(cfg.api_base)
    print(f"Forecasting {len(symbols)} symbols, horizon={cfg.pred_len} business days…")

    out_rows: list[dict] = []
    generated_at = int(time.time())

    for sym in symbols:
        df = fetch_daily(sym, cfg.lookback)
        if df is None:
            print(f"  - {sym}: no usable history")
            continue

        closes = df["close"].astype(float).values
        context = torch.tensor(closes)
        try:
            # Bolt pipeline returns (quantiles_tensor, mean_tensor). Pass
            # context positionally — the kwarg name is `inputs` on Bolt
            # and `context` on the original ChronosPipeline, so positional
            # works on both. Shape: [1, pred_len, 3] for [P10, P50, P90].
            result = pipeline.predict_quantiles(
                context,
                prediction_length=cfg.pred_len,
                quantile_levels=[0.1, 0.5, 0.9],
            )
            quantiles = result[0] if isinstance(result, tuple) else result
            q = quantiles[0].cpu().numpy()
            p10_final = float(q[-1, 0])
            p50_final = float(q[-1, 1])
            p90_final = float(q[-1, 2])
        except AttributeError:
            # Older original Chronos: only .predict() returning samples.
            samples = pipeline.predict(
                context,
                prediction_length=cfg.pred_len,
                num_samples=cfg.sample_count,
            )
            arr = samples[0, :, -1].cpu().numpy()
            p10_final = float(np.percentile(arr, 10))
            p50_final = float(np.percentile(arr, 50))
            p90_final = float(np.percentile(arr, 90))
        except Exception as e:
            print(f"  ! {sym}: predict failed: {e}", file=sys.stderr)
            continue

        current_close = float(closes[-1])
        ret = (p50_final - current_close) / current_close
        p10_ret = (p10_final - current_close) / current_close
        p90_ret = (p90_final - current_close) / current_close
        sign = "+" if ret >= 0 else ""
        print(
            f"  {sym:>6}: ${current_close:>8.2f} → ${p50_final:>8.2f} "
            f"({sign}{ret * 100:>+5.2f}%, band {p10_ret * 100:>+5.2f}%/"
            f"{p90_ret * 100:>+5.2f}%)"
        )
        out_rows.append(
            dict(
                symbol=sym,
                horizon_days=cfg.pred_len,
                current_close=current_close,
                forecast_close=p50_final,
                forecast_p10=p10_final,
                forecast_p90=p90_final,
                sample_count=cfg.sample_count,
            )
        )

    if not out_rows:
        print("No forecasts produced.", file=sys.stderr)
        return 1

    body = dict(
        model=cfg.model_name.split("/")[-1],
        generated_at=generated_at,
        forecasts=out_rows,
    )
    print(f"Posting {len(out_rows)} forecasts…")
    r = requests.post(
        f"{cfg.api_base}/chronos/forecast",
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
