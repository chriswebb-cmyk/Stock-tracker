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

// US Eastern offset in hours for a given UTC instant, accounting for DST.
// DST: second Sunday of March 02:00 ET -> first Sunday of November 02:00 ET.
// Returns 4 during EDT and 5 during EST. Pure math; no IANA tz needed inside
// Workers.
export function etOffsetHours(tsSeconds: number): number {
  const utc = new Date(tsSeconds * 1000);
  const y = utc.getUTCFullYear();
  const dstStart = nthSundayUtc(y, 3, 2, 7); // 2nd Sunday of March, 07:00 UTC = 02:00 EST
  const dstEnd = nthSundayUtc(y, 11, 1, 6);  // 1st Sunday of November, 06:00 UTC = 02:00 EDT
  return tsSeconds * 1000 >= dstStart && tsSeconds * 1000 < dstEnd ? 4 : 5;
}

// 'YYYY-MM-DD' for the ET trading day covering this UTC instant. Uses the
// DST-aware offset so trading-day boundaries don't shift by an hour twice a
// year (which silently corrupted VWAP/ORB groupings in the previous fixed
// -4h implementation).
export function etDayKey(tsSeconds: number): string {
  const ms = (tsSeconds - etOffsetHours(tsSeconds) * 3600) * 1000;
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Returns true if the instant is inside US regular trading hours (09:30 -
// 16:00 ET, Mon-Fri), accounting for DST. Replaces the fixed -4h offset
// version in the ingest/reddit workers that silently mis-bucketed half the
// year (polling 08:30-15:00 ET in winter instead of 09:30-16:00 ET).
export function isUsRegularHours(tsSeconds: number): boolean {
  const offset = etOffsetHours(tsSeconds);
  const utc = new Date(tsSeconds * 1000);
  const dow = utc.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const totalUtcMin = utc.getUTCHours() * 60 + utc.getUTCMinutes();
  const etMin = (totalUtcMin - offset * 60 + 1440) % 1440;
  return etMin >= 9 * 60 + 30 && etMin < 16 * 60;
}

// Returns Unix ms of the nth occurrence of `weekday` (0=Sun..6=Sat) in
// `month1to12` of `year`, at `hourUtc:00:00`. Used to compute DST boundaries.
function nthSundayUtc(year: number, month1to12: number, n: number, hourUtc: number): number {
  const firstOfMonth = Date.UTC(year, month1to12 - 1, 1);
  const firstDow = new Date(firstOfMonth).getUTCDay();
  const daysToFirstSunday = (7 - firstDow) % 7;
  const dom = 1 + daysToFirstSunday + (n - 1) * 7;
  return Date.UTC(year, month1to12 - 1, dom, hourUtc, 0, 0);
}

// Volume Point of Control for today's session: the price level (rounded
// to a granularity that's a fraction of the daily range) that traded the
// most volume. Returns NaN if there isn't enough today-data to compute.
export function vpocToday(bars: Bar[], dayKey: (ts: number) => string): number {
  if (bars.length === 0) return NaN;
  const lastKey = dayKey(bars[bars.length - 1]!.ts);
  const today = bars.filter((b) => dayKey(b.ts) === lastKey);
  if (today.length < 10) return NaN;
  let lo = Infinity;
  let hi = -Infinity;
  for (const b of today) {
    if (b.low < lo) lo = b.low;
    if (b.high > hi) hi = b.high;
  }
  const range = hi - lo;
  if (range <= 0) return today[today.length - 1]!.close;
  // Bucket into ~50 bins; vol is split evenly across the bar's H-L span.
  const BIN_COUNT = 50;
  const binSize = range / BIN_COUNT;
  const bins = new Array<number>(BIN_COUNT + 1).fill(0);
  for (const b of today) {
    const startBin = Math.max(0, Math.floor((b.low - lo) / binSize));
    const endBin = Math.min(BIN_COUNT, Math.floor((b.high - lo) / binSize));
    const spanBins = Math.max(1, endBin - startBin + 1);
    const volPerBin = b.volume / spanBins;
    for (let k = startBin; k <= endBin; k++) bins[k]! += volPerBin;
  }
  let bestIdx = 0;
  let bestVol = -1;
  for (let k = 0; k < bins.length; k++) {
    if (bins[k]! > bestVol) {
      bestVol = bins[k]!;
      bestIdx = k;
    }
  }
  return lo + (bestIdx + 0.5) * binSize;
}

// Trend strength: simple swing detector over the last `lookback` bars.
// Scans for local highs / lows (each higher than its `pivot` neighbours on
// both sides) and counts higher-highs / higher-lows minus lower-highs /
// lower-lows. Result normalised to [-1, 1] by total swing count. Captures
// directional pressure that EMAs alone miss.
export function trendStrength(bars: Bar[], lookback = 60, pivot = 3): number {
  const end = bars.length;
  const start = Math.max(pivot, end - lookback);
  const highs: number[] = [];
  const lows: number[] = [];
  for (let i = start; i < end - pivot; i++) {
    const cur = bars[i]!;
    let isHigh = true;
    let isLow = true;
    for (let k = 1; k <= pivot; k++) {
      const l = bars[i - k]!;
      const r = bars[i + k]!;
      if (l.high >= cur.high || r.high >= cur.high) isHigh = false;
      if (l.low <= cur.low || r.low <= cur.low) isLow = false;
    }
    if (isHigh) highs.push(cur.high);
    if (isLow) lows.push(cur.low);
  }
  let score = 0;
  let total = 0;
  for (let i = 1; i < highs.length; i++) {
    total++;
    score += highs[i]! > highs[i - 1]! ? 1 : -1;
  }
  for (let i = 1; i < lows.length; i++) {
    total++;
    score += lows[i]! > lows[i - 1]! ? 1 : -1;
  }
  return total === 0 ? 0 : score / total;
}

// Roll 1-min bars into a higher timeframe by floor-bucketing on bucketSec.
// Returns OHLCV bars ascending in time. Used by multi-timeframe features
// so we can compute, e.g., the 5m EMA(9) on top of stored 1m data without
// fetching separate higher-timeframe series.
export function aggregateTo(bars: Bar[], bucketSec: number): Bar[] {
  if (bars.length === 0 || bucketSec <= 60) return bars.slice();
  const out: Bar[] = [];
  let bucketTs = -1;
  let cur: Bar | null = null;
  for (const b of bars) {
    const ts = Math.floor(b.ts / bucketSec) * bucketSec;
    if (cur === null || ts !== bucketTs) {
      if (cur !== null) out.push(cur);
      bucketTs = ts;
      cur = {
        symbol: b.symbol,
        interval: b.interval,
        ts: bucketTs,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
      };
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.volume += b.volume;
    }
  }
  if (cur !== null) out.push(cur);
  return out;
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
