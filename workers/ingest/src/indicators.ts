import type { Bar } from '../../../shared/types';

// Exponential moving average. Returns one value per input close, with the
// first (period - 1) entries set to NaN so indexes line up with closes.
export function ema(values: number[], period: number): number[] {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k);
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
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gainSum += diff;
    else lossSum -= diff;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
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
  width: number; // (upper - lower) / middle
}

export function bollinger(closes: number[], period = 20, mult = 2): BollingerBand[] {
  const out: BollingerBand[] = closes.map(() => ({
    middle: NaN,
    upper: NaN,
    lower: NaN,
    width: NaN,
  }));
  if (closes.length < period) return out;
  for (let i = period - 1; i < closes.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += closes[j];
    const mean = sum / period;
    let varSum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const d = closes[j] - mean;
      varSum += d * d;
    }
    const sd = Math.sqrt(varSum / period);
    const upper = mean + mult * sd;
    const lower = mean - mult * sd;
    out[i] = { middle: mean, upper, lower, width: mean === 0 ? 0 : (upper - lower) / mean };
  }
  return out;
}

// True range, then Wilder-smoothed ATR(period).
export function atr(bars: Bar[], period = 14): number[] {
  const out = new Array<number>(bars.length).fill(NaN);
  if (bars.length <= period) return out;
  const tr: number[] = new Array(bars.length).fill(0);
  tr[0] = bars[0].high - bars[0].low;
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].high;
    const l = bars[i].low;
    const pc = bars[i - 1].close;
    tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
  let sum = 0;
  for (let i = 1; i <= period; i++) sum += tr[i];
  let prev = sum / period;
  out[period] = prev;
  for (let i = period + 1; i < bars.length; i++) {
    prev = (prev * (period - 1) + tr[i]) / period;
    out[i] = prev;
  }
  return out;
}

// Cumulative VWAP, reset whenever `dayKey(bar.ts)` changes. Pass an empty
// dayKey function to compute over the whole input.
export function vwap(bars: Bar[], dayKey: (ts: number) => string): number[] {
  const out = new Array<number>(bars.length).fill(NaN);
  let currentDay = '';
  let pv = 0;
  let v = 0;
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i];
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

// Returns 'YYYY-MM-DD' for an ET trading day. Uses fixed -4h (EDT) offset to
// avoid IANA tz dependencies inside Workers.
export function etDayKey(tsSeconds: number): string {
  const ms = (tsSeconds - 4 * 3600) * 1000;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
