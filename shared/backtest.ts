import type { Bar } from './types';
import {
  aggregateTo,
  atr,
  bollinger,
  ema,
  etDayKey,
  isNum,
  rsi,
  trendStrength,
  volRegime,
  vwap,
} from './indicators';
import type { DetectedSignal, SetupName } from './setups';
import { buildFeatures, type FeatureName } from './features';

const ORB_MINUTES = 30;
const SQUEEZE_LOOKBACK = 60;
const SQUEEZE_PCTILE = 0.2;
const SQUEEZE_RELEASE_MULT = 1.5;
const RSI_OVERSOLD = 30;
const RSI_OVERBOUGHT = 70;
// Lookback for the volatility regime feature. 390 ≈ 1 US trading day of
// 1-min bars; long enough to distinguish today's vol from a typical day,
// short enough that recent regime shifts dominate stale history.
const VOL_REGIME_LOOKBACK = 390;

export interface BacktestTrade {
  symbol: string;
  setup: SetupName;
  direction: 'long' | 'short';
  entryTs: number;
  entryPrice: number;
  exitTs: number;
  exitPrice: number;
  pnlPct: number;
  features: Record<FeatureName, number>;
}

export interface SetupStats {
  setup: SetupName;
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  avgPnlPct: number;
  medianPnlPct: number;
  bestPnlPct: number;
  worstPnlPct: number;
  totalPnlPct: number;
}

export interface BacktestResult {
  symbol: string;
  bars: number;
  startTs: number | null;
  endTs: number | null;
  holdMinutes: number;
  cooldownSeconds: number;
  trades: BacktestTrade[];
  bySetup: SetupStats[];
}

interface DayInfo {
  dayKey: string;
  startIndex: number;
  prevClose: number;
  orbHigh: number;
  orbLow: number;
  orbReadyIndex: number;
  brokeUp: boolean;
  brokeDown: boolean;
  priorHigh: number;
  priorLow: number;
  dayOpen: number;
  vpoc: number; // full-day VPOC. Used by the NEXT day's trades (no lookahead).
}

export function backtest(
  symbol: string,
  bars: Bar[],
  holdMinutes: number,
  cooldownSec: number,
): BacktestResult {
  const empty: BacktestResult = {
    symbol,
    bars: bars.length,
    startTs: bars[0]?.ts ?? null,
    endTs: bars[bars.length - 1]?.ts ?? null,
    holdMinutes,
    cooldownSeconds: cooldownSec,
    trades: [],
    bySetup: [],
  };
  if (bars.length < 30) return empty;

  const closes = bars.map((b) => b.close);
  const vwapSeries = vwap(bars, etDayKey);
  const rsiSeries = rsi(closes, 14);
  const bbSeries = bollinger(closes, 20, 2);
  const atrSeries = atr(bars, 14);
  const dayKeys = bars.map((b) => etDayKey(b.ts));

  // Precompute multi-timeframe EMA(9) on 5m and 15m aggregates so trades can
  // look them up by bar index in O(1). aggregate->EMA is O(N) once per
  // backtest instead of per-trade.
  const mtf5 = buildMtfLookup(bars, 5 * 60, 9);
  const mtf15 = buildMtfLookup(bars, 15 * 60, 9);

  const days: DayInfo[] = [];
  let lastDay = '';
  for (let i = 0; i < bars.length; i++) {
    const key = dayKeys[i]!;
    if (key !== lastDay) {
      lastDay = key;
      const prevBar = i > 0 ? bars[i - 1] : undefined;
      const curBar = bars[i]!;
      days.push({
        dayKey: key,
        startIndex: i,
        prevClose: prevBar?.close ?? curBar.open,
        orbHigh: -Infinity,
        orbLow: Infinity,
        orbReadyIndex: -1,
        brokeUp: false,
        brokeDown: false,
        priorHigh: -Infinity,
        priorLow: Infinity,
        dayOpen: curBar.open,
        vpoc: NaN,
      });
    }
  }

  for (let d = 0; d < days.length; d++) {
    const day = days[d]!;
    const dayEnd = d + 1 < days.length ? days[d + 1]!.startIndex : bars.length;
    // Single pass: full-day H/L, ORB H/L, day open, volume histogram for VPOC.
    let dh = -Infinity;
    let dl = Infinity;
    for (let i = day.startIndex; i < dayEnd; i++) {
      const b = bars[i]!;
      if (b.high > dh) dh = b.high;
      if (b.low < dl) dl = b.low;
    }
    day.priorHigh = dh;
    day.priorLow = dl;
    // VPOC: 50-bin volume histogram over the day's price range, find peak bin.
    if (dh > dl) {
      const BIN_COUNT = 50;
      const binSize = (dh - dl) / BIN_COUNT;
      const bins = new Array<number>(BIN_COUNT + 1).fill(0);
      for (let i = day.startIndex; i < dayEnd; i++) {
        const b = bars[i]!;
        const startBin = Math.max(0, Math.floor((b.low - dl) / binSize));
        const endBin = Math.min(BIN_COUNT, Math.floor((b.high - dl) / binSize));
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
      day.vpoc = dl + (bestIdx + 0.5) * binSize;
    }
    const orbEnd = Math.min(day.startIndex + ORB_MINUTES, dayEnd);
    for (let i = day.startIndex; i < orbEnd; i++) {
      const b = bars[i]!;
      if (b.high > day.orbHigh) day.orbHigh = b.high;
      if (b.low < day.orbLow) day.orbLow = b.low;
    }
    if (orbEnd - day.startIndex >= ORB_MINUTES) {
      day.orbReadyIndex = day.startIndex + ORB_MINUTES;
    }
  }

  const dayIndexOf = new Array<number>(bars.length).fill(0);
  let di = 0;
  for (let i = 0; i < bars.length; i++) {
    while (di + 1 < days.length && days[di + 1]!.startIndex <= i) di++;
    dayIndexOf[i] = di;
  }

  const trades: BacktestTrade[] = [];
  const lastSignalTs = new Map<SetupName, number>();

  function shouldFire(setup: SetupName, ts: number): boolean {
    const prev = lastSignalTs.get(setup);
    if (prev !== undefined && ts - prev < cooldownSec) return false;
    lastSignalTs.set(setup, ts);
    return true;
  }

  function recordTrade(
    setup: SetupName,
    direction: 'long' | 'short',
    entryIndex: number,
  ): void {
    const exitIndex = entryIndex + holdMinutes;
    if (exitIndex >= bars.length) return;
    const entryBar = bars[entryIndex]!;
    const exitBar = bars[exitIndex]!;
    const dayIdx = dayIndexOf[entryIndex]!;
    const day = days[dayIdx]!;
    const entry = entryBar.close;
    const exit = exitBar.close;
    const pnlPct = direction === 'long' ? (exit - entry) / entry : (entry - exit) / entry;
    const lastVwap = vwapSeries[entryIndex] ?? entryBar.close;
    const lastRsi = rsiSeries[entryIndex] ?? 50;
    const bbBand = bbSeries[entryIndex];
    const lastAtr = atrSeries[entryIndex] ?? 0;
    const regime = volRegime(bars, atrSeries, entryIndex, VOL_REGIME_LOOKBACK);
    const ema5 = mtf5[entryIndex];
    const ema15 = mtf15[entryIndex];
    // Structural features come from precomputed per-day metrics in days[],
    // so this is O(1) per trade instead of O(N) bar-slicing + filtering.
    // Using PRIOR day's VPOC (not current) avoids lookahead bias — the
    // current day's POC isn't knowable until the close.
    const prior = dayIdx > 0 ? days[dayIdx - 1]! : null;
    const trend = trendStrength(bars, 60, 3, entryIndex + 1);
    const features = buildFeatures({
      close: entryBar.close,
      prevClose: day.prevClose,
      rsi: isNum(lastRsi) ? lastRsi : 50,
      vwap: isNum(lastVwap) ? lastVwap : entryBar.close,
      bbLower: bbBand && isNum(bbBand.lower) ? bbBand.lower : entryBar.close,
      bbUpper: bbBand && isNum(bbBand.upper) ? bbBand.upper : entryBar.close,
      atr: isNum(lastAtr) ? lastAtr : 0,
      ts: entryBar.ts,
      volRegime: regime,
      pdh: prior?.priorHigh,
      pdl: prior?.priorLow,
      pdClose: day.prevClose,
      todayOpen: day.dayOpen,
      vpoc: prior && isNum(prior.vpoc) ? prior.vpoc : undefined,
      trendStrength: trend,
      // VIX/Reddit/Options/SPY/TNX/earnings context isn't historically
      // available in backtest; those features fall back to neutral defaults.
      context: {
        ema5mDist: isNum(ema5) && entryBar.close > 0 ? (entryBar.close - ema5) / entryBar.close : 0,
        ema15mDist: isNum(ema15) && entryBar.close > 0 ? (entryBar.close - ema15) / entryBar.close : 0,
      },
    });
    trades.push({
      symbol,
      setup,
      direction,
      entryTs: entryBar.ts,
      entryPrice: entry,
      exitTs: exitBar.ts,
      exitPrice: exit,
      pnlPct,
      features,
    });
  }

  for (let i = 1; i < bars.length; i++) {
    const dayIdx = dayIndexOf[i]!;
    const day = days[dayIdx]!;
    const cur = bars[i]!;
    const prev = bars[i - 1]!;
    const ts = cur.ts;

    const lastVwap = vwapSeries[i];
    const prevVwap = vwapSeries[i - 1];
    const lastRsi = rsiSeries[i];
    const prevRsi = rsiSeries[i - 1];
    const lastBb = bbSeries[i];
    const lastAtr = atrSeries[i];

    if (
      isNum(lastVwap) &&
      isNum(prevVwap) &&
      isNum(lastAtr) &&
      prev.close < prevVwap &&
      cur.close > lastVwap &&
      cur.close - lastVwap > lastAtr * 0.1 &&
      shouldFire('vwap_reclaim_long', ts)
    ) {
      recordTrade('vwap_reclaim_long', 'long', i);
    }

    if (
      isNum(lastVwap) &&
      isNum(prevVwap) &&
      isNum(lastAtr) &&
      prev.close > prevVwap &&
      cur.close < lastVwap &&
      lastVwap - cur.close > lastAtr * 0.1 &&
      shouldFire('vwap_reject_short', ts)
    ) {
      recordTrade('vwap_reject_short', 'short', i);
    }

    if (
      day.orbReadyIndex >= 0 &&
      i >= day.orbReadyIndex &&
      Number.isFinite(day.orbHigh) &&
      Number.isFinite(day.orbLow)
    ) {
      if (!day.brokeUp && cur.close > day.orbHigh && shouldFire('orb_breakout_long', ts)) {
        day.brokeUp = true;
        recordTrade('orb_breakout_long', 'long', i);
      }
      if (!day.brokeDown && cur.close < day.orbLow && shouldFire('orb_breakdown_short', ts)) {
        day.brokeDown = true;
        recordTrade('orb_breakdown_short', 'short', i);
      }
    }

    if (i >= SQUEEZE_LOOKBACK && lastBb && isNum(lastBb.width)) {
      const widths: number[] = [];
      for (let k = i - SQUEEZE_LOOKBACK + 1; k < i; k++) {
        const w = bbSeries[k]?.width;
        if (isNum(w)) widths.push(w);
      }
      if (widths.length >= SQUEEZE_LOOKBACK / 2) {
        widths.sort((a, b) => a - b);
        const threshold = widths[Math.floor(widths.length * SQUEEZE_PCTILE)];
        if (isNum(threshold)) {
          const releaseTrigger = threshold * SQUEEZE_RELEASE_MULT;
          if (lastBb.width >= releaseTrigger) {
            if (cur.close > lastBb.upper && shouldFire('bb_squeeze_release_long', ts)) {
              recordTrade('bb_squeeze_release_long', 'long', i);
            } else if (cur.close < lastBb.lower && shouldFire('bb_squeeze_release_short', ts)) {
              recordTrade('bb_squeeze_release_short', 'short', i);
            }
          }
        }
      }
    }

    if (isNum(prevRsi) && isNum(lastRsi)) {
      if (
        prevRsi < RSI_OVERSOLD &&
        lastRsi > prevRsi &&
        cur.close > prev.close &&
        shouldFire('rsi_oversold_reversal', ts)
      ) {
        recordTrade('rsi_oversold_reversal', 'long', i);
      }
      if (
        prevRsi > RSI_OVERBOUGHT &&
        lastRsi < prevRsi &&
        cur.close < prev.close &&
        shouldFire('rsi_overbought_reversal', ts)
      ) {
        recordTrade('rsi_overbought_reversal', 'short', i);
      }
    }
  }

  return {
    symbol,
    bars: bars.length,
    startTs: bars[0]?.ts ?? null,
    endTs: bars[bars.length - 1]?.ts ?? null,
    holdMinutes,
    cooldownSeconds: cooldownSec,
    trades,
    bySetup: aggregate(trades),
  };
}

function aggregate(trades: BacktestTrade[]): SetupStats[] {
  const buckets = new Map<SetupName, BacktestTrade[]>();
  for (const t of trades) {
    const arr = buckets.get(t.setup) ?? [];
    arr.push(t);
    buckets.set(t.setup, arr);
  }
  const out: SetupStats[] = [];
  for (const [setup, arr] of buckets) {
    const pnls = arr.map((t) => t.pnlPct).sort((a, b) => a - b);
    const wins = pnls.filter((p) => p > 0).length;
    const losses = pnls.filter((p) => p <= 0).length;
    const total = pnls.reduce((s, p) => s + p, 0);
    const median = pnls.length > 0 ? pnls[Math.floor(pnls.length / 2)]! : 0;
    const best = pnls.length > 0 ? pnls[pnls.length - 1]! : 0;
    const worst = pnls.length > 0 ? pnls[0]! : 0;
    out.push({
      setup,
      trades: arr.length,
      wins,
      losses,
      winRate: arr.length > 0 ? wins / arr.length : 0,
      avgPnlPct: arr.length > 0 ? total / arr.length : 0,
      medianPnlPct: median,
      bestPnlPct: best,
      worstPnlPct: worst,
      totalPnlPct: total,
    });
  }
  out.sort((a, b) => a.setup.localeCompare(b.setup));
  return out;
}

export function combineResults(results: BacktestResult[]): SetupStats[] {
  const allTrades = results.flatMap((r) => r.trades);
  return aggregate(allTrades);
}

// For each 1-min bar index, returns the EMA(period) value of the higher
// timeframe (bucketSec) bucket containing that minute. NaN until the
// higher-timeframe EMA has enough warmup. Lets backtest look up MTF
// context in O(1) per trade rather than re-aggregating each entry.
function buildMtfLookup(bars: Bar[], bucketSec: number, period: number): number[] {
  const out = new Array<number>(bars.length).fill(NaN);
  if (bars.length === 0) return out;
  const agg = aggregateTo(bars, bucketSec);
  const aggEma = ema(agg.map((b) => b.close), period);
  let aggIdx = 0;
  for (let i = 0; i < bars.length; i++) {
    const ts = bars[i]!.ts;
    while (aggIdx + 1 < agg.length && agg[aggIdx + 1]!.ts <= ts) aggIdx++;
    out[i] = aggEma[aggIdx] ?? NaN;
  }
  return out;
}

export type { DetectedSignal };
