import type { Bar } from './types';
import { atr, bollinger, etDayKey, rsi, vwap, type BollingerBand } from './indicators';
import type { DetectedSignal, SetupName } from './setups';

const ORB_MINUTES = 30;
const SQUEEZE_LOOKBACK = 60;
const SQUEEZE_PCTILE = 0.2;
const SQUEEZE_RELEASE_MULT = 1.5;
const RSI_OVERSOLD = 30;
const RSI_OVERBOUGHT = 70;

export interface BacktestTrade {
  symbol: string;
  setup: SetupName;
  direction: 'long' | 'short';
  entryTs: number;
  entryPrice: number;
  exitTs: number;
  exitPrice: number;
  pnlPct: number;
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
  orbReadyIndex: number; // first index where ORB is established
  brokeUp: boolean;
  brokeDown: boolean;
}

// Walks `bars` forward, simulating signals + fixed-time exits. Bars must be
// sorted ascending and contiguous within trading days. `cooldownSec` mirrors
// live signal dedup. `holdMinutes` is exit time relative to signal bar.
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

  // Precompute per-day metadata and per-bar lookup of "which day am I in".
  const days: DayInfo[] = [];
  let lastDay = '';
  for (let i = 0; i < bars.length; i++) {
    if (dayKeys[i] !== lastDay) {
      lastDay = dayKeys[i];
      days.push({
        dayKey: lastDay,
        startIndex: i,
        prevClose: i > 0 ? bars[i - 1].close : bars[i].open,
        orbHigh: -Infinity,
        orbLow: Infinity,
        orbReadyIndex: -1,
        brokeUp: false,
        brokeDown: false,
      });
    }
  }

  // Compute ORB high/low for each day from first ORB_MINUTES bars.
  for (const day of days) {
    const end = Math.min(day.startIndex + ORB_MINUTES, bars.length);
    for (let i = day.startIndex; i < end; i++) {
      if (bars[i].high > day.orbHigh) day.orbHigh = bars[i].high;
      if (bars[i].low < day.orbLow) day.orbLow = bars[i].low;
    }
    if (end - day.startIndex >= ORB_MINUTES) {
      day.orbReadyIndex = day.startIndex + ORB_MINUTES;
    }
  }

  // Map bar index -> day metadata index.
  const dayIndexOf = new Array<number>(bars.length).fill(0);
  let di = 0;
  for (let i = 0; i < bars.length; i++) {
    while (di + 1 < days.length && days[di + 1].startIndex <= i) di++;
    dayIndexOf[i] = di;
  }

  const trades: BacktestTrade[] = [];
  // Cooldown tracker: last signal ts per setup name.
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
    const entry = bars[entryIndex].close;
    const exit = bars[exitIndex].close;
    const pnlPct = direction === 'long' ? (exit - entry) / entry : (entry - exit) / entry;
    trades.push({
      symbol,
      setup,
      direction,
      entryTs: bars[entryIndex].ts,
      entryPrice: entry,
      exitTs: bars[exitIndex].ts,
      exitPrice: exit,
      pnlPct,
    });
  }

  for (let i = 1; i < bars.length; i++) {
    const day = days[dayIndexOf[i]];
    const ts = bars[i].ts;
    const prev = bars[i - 1];
    const cur = bars[i];

    const lastVwap = vwapSeries[i];
    const prevVwap = vwapSeries[i - 1];
    const lastRsi = rsiSeries[i];
    const prevRsi = rsiSeries[i - 1];
    const lastBb = bbSeries[i];
    const lastAtr = atrSeries[i];

    // VWAP reclaim long
    if (
      Number.isFinite(lastVwap) &&
      Number.isFinite(prevVwap) &&
      Number.isFinite(lastAtr) &&
      prev.close < prevVwap &&
      cur.close > lastVwap &&
      cur.close - lastVwap > lastAtr * 0.1 &&
      shouldFire('vwap_reclaim_long', ts)
    ) {
      recordTrade('vwap_reclaim_long', 'long', i);
    }

    // VWAP reject short
    if (
      Number.isFinite(lastVwap) &&
      Number.isFinite(prevVwap) &&
      Number.isFinite(lastAtr) &&
      prev.close > prevVwap &&
      cur.close < lastVwap &&
      lastVwap - cur.close > lastAtr * 0.1 &&
      shouldFire('vwap_reject_short', ts)
    ) {
      recordTrade('vwap_reject_short', 'short', i);
    }

    // ORB breakout — only after orbReadyIndex, only first time per day
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

    // Bollinger squeeze release
    if (i >= SQUEEZE_LOOKBACK && Number.isFinite(lastBb.width)) {
      // Could be cached, but ~60 numbers is cheap.
      const widths: number[] = [];
      for (let k = i - SQUEEZE_LOOKBACK + 1; k < i; k++) {
        const w = bbSeries[k].width;
        if (Number.isFinite(w)) widths.push(w);
      }
      if (widths.length >= SQUEEZE_LOOKBACK / 2) {
        widths.sort((a, b) => a - b);
        const threshold = widths[Math.floor(widths.length * SQUEEZE_PCTILE)];
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

    // RSI mean reversion
    if (Number.isFinite(prevRsi) && Number.isFinite(lastRsi)) {
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
    out.push({
      setup,
      trades: arr.length,
      wins,
      losses,
      winRate: arr.length > 0 ? wins / arr.length : 0,
      avgPnlPct: arr.length > 0 ? total / arr.length : 0,
      medianPnlPct: pnls.length > 0 ? pnls[Math.floor(pnls.length / 2)] : 0,
      bestPnlPct: pnls.length > 0 ? pnls[pnls.length - 1] : 0,
      worstPnlPct: pnls.length > 0 ? pnls[0] : 0,
      totalPnlPct: total,
    });
  }
  // Stable sort by setup name for predictable display order.
  out.sort((a, b) => a.setup.localeCompare(b.setup));
  return out;
}

// Aggregate stats across multiple per-symbol BacktestResults.
export function combineResults(results: BacktestResult[]): SetupStats[] {
  const allTrades = results.flatMap((r) => r.trades);
  return aggregate(allTrades);
}

// Re-exposed so the API worker can call it without an import dance.
export type { DetectedSignal };
