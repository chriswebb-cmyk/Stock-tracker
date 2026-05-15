import type { Bar } from './types';

export function isNum(v: number | undefined): v is number {
  return v !== undefined && Number.isFinite(v);
}

// Exponential moving average. Returns one value per input close, with the
// first (period - 1) entries set to NaN so indexes line up with closes.
export function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i]!;
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

// Wilder's RSI(14) by default. Returns one value per close, NaN for warmup.
export function rsi(closes: number[], period = 14): number[] {
  const out = new Array<number>(closes.length).fill(NaN);
  if (closes.length <= period) return out;
  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    if (diff >= 0) gainSum += diff;
    else lossSum -= diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i]! - closes[i - 1]!;
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export interface BollingerBand {
  middle: number;
  upper: number;
  lower: number;
  width: number;
}

export function bollinger(closes: number[], period = 20, mult = 2): BollingerBand[] {
  const out: BollingerBand[] = closes.map(() => ({
    middle: NaN,
    upper: NaN,
    lower: NaN,
    width: NaN,
  }));
  if (closes.length < period) return out;
  // Running sum + running sum of squares so each step is O(1) instead of O(period).
  let sum = 0;
  let sumSq = 0;
  for (let i = 0; i < period; i++) {
    const v = closes[i]!;
    sum += v;
    sumSq += v * v;
  }
  const writeBand = (i: number) => {
    const mean = sum / period;
    // var = E[X^2] - E[X]^2; clamp to 0 to absorb fp noise.
    const variance = Math.max(0, sumSq / period - mean * mean);
    const sd = Math.sqrt(variance);
    const upper = mean + mult * sd;
    const lower = mean - mult * sd;
    out[i] = {
      middle: mean,
      upper,
      lower,
      width: mean === 0 ? 0 : (upper - lower) / mean,
    };
  };
  writeBand(period - 1);
  for (let i = period; i < closes.length; i++) {
    const incoming = closes[i]!;
    const outgoing = closes[i - period]!;
    sum += incoming - outgoing;
    sumSq += incoming * incoming - outgoing * outgoing;
    writeBand(i);
  }
  return out;
}

export function atr(bars: Bar[], period = 14): number[] {
  const out = new Array<number>(bars.length).fill(NaN);
  if (bars.length <= period) return out;
  const tr: number[] = new Array(bars.length).fill(0);
  const first = bars[0]!;
  tr[0] = first.high - first.low;
  for (let i = 1; i < bars.length; i++) {
    const cur = bars[i]!;
    const prev = bars[i - 1]!;
    const h = cur.high;
    const l = cur.low;
    const pc = prev.close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i]!;
  let prev = sum / period;
  out[period] = prev;
  for (let i = period + 1; i < bars.length; i++) {
    prev = (prev * (period - 1) + tr[i]!) / period;
    out[i] = prev;
  }
  return out;
}

// Cumulative VWAP, reset whenever `dayKey(bar.ts)` changes.
export function vwap(bars: Bar[], dayKey: (ts: number) => string): number[] {
  const out = new Array<number>(bars.length).fill(NaN);
  let currentDay = '';
  let pv = 0;
  let v = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!;
    const day = dayKey(b.ts);
    if (day !== currentDay) {
      currentDay = day;
      pv = 0;
      v = 0;
    }
    const typical = (b.high + b.low + b.close) / 3;
    pv += typical * b.volume;
    v += b.volume;
    out[i] = v > 0 ? pv / v : NaN;
  }
  return out;
}

// Returns 'YYYY-MM-DD' for an ET trading day. Fixed -4h (EDT) offset to
// avoid IANA tz dependencies inside Workers.
export function etDayKey(tsSeconds: number): string {
  const ms = (tsSeconds - 4 * 3600) * 1000;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Volatility regime: percentile rank of the most recent ATR/price ratio
// against the same ratio over the trailing window. Returns 0..1 where 1 =
// most volatile minute in the window, 0 = calmest. Used as an ML feature so
// setups can be scored differently in calm vs. choppy markets — RSI mean
// reversion historically works in low-vol regimes; BB squeeze releases and
// breakouts work in higher-vol regimes.
//
// Lookback is in bars (not minutes) so the caller controls the horizon:
// 390 bars ≈ 1 US trading day of 1-min data; 1950 ≈ 5 days.
export function volRegime(
  bars: Bar[],
  atrSeries: number[],
  endIndex: number,
  lookbackBars: number,
): number {
  const start = Math.max(0, endIndex - lookbackBars + 1);
  const ratios: number[] = [];
  for (let i = start; i <= endIndex; i++) {
    const b = bars[i];
    const a = atrSeries[i];
    if (!b || !isNum(a) || b.close <= 0) continue;
    ratios.push(a / b.close);
  }
  // Need enough samples to compute a stable rank; below this, just return
  // 0.5 (neutral) so a few warmup bars don't poison early signals.
  if (ratios.length < 30) return 0.5;
  const current = ratios[ratios.length - 1]!;
  let below = 0;
  for (const r of ratios) if (r < current) below++;
  return below / ratios.length;
}
