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
  vpocToday,
  vwap,
  type BollingerBand,
} from './indicators';
import { buildFeatures, type SignalContext } from './features';

export type SetupName =
  | 'vwap_reclaim_long'
  | 'vwap_reject_short'
  | 'orb_breakout_long'
  | 'orb_breakdown_short'
  | 'bb_squeeze_release_long'
  | 'bb_squeeze_release_short'
  | 'rsi_oversold_reversal'
  | 'rsi_overbought_reversal';

export interface DetectedSignal {
  symbol: string;
  ts: number;
  setup: SetupName;
  direction: 'long' | 'short';
  price: number;
  prevClose: number;
  changePct: number;
  notes: string;
  features: Record<string, number>;
}

const ORB_MINUTES = 30;
const SQUEEZE_LOOKBACK = 60;
const SQUEEZE_PCTILE = 0.2;
const SQUEEZE_RELEASE_MULT = 1.5;
const RSI_OVERSOLD = 30;
const RSI_OVERBOUGHT = 70;
const VOL_REGIME_LOOKBACK = 390;

export function detectSetups(
  symbol: string,
  bars: Bar[],
  prevClose: number,
  context: SignalContext = {},
): DetectedSignal[] {
  const out: DetectedSignal[] = [];
  if (bars.length < 30) return out;

  const last = bars[bars.length - 1]!;
  const prev = bars[bars.length - 2]!;
  const closes = bars.map((b) => b.close);
  const todayKey = etDayKey(last.ts);
  const todaysBars = bars.filter((b) => etDayKey(b.ts) === todayKey);

  const vwapSeries = vwap(bars, etDayKey);
  const rsiSeries = rsi(closes, 14);
  const bb = bollinger(closes, 20, 2);
  const atrSeries = atr(bars, 14);

  const i = bars.length - 1;
  const j = bars.length - 2;
  const lastVwap = vwapSeries[i];
  const prevVwap = vwapSeries[j];
  const lastRsi = rsiSeries[i];
  const prevRsi = rsiSeries[j];
  const lastBb: BollingerBand | undefined = bb[i];
  const lastAtr = atrSeries[i];

  const changePct = prevClose > 0 ? (last.close - prevClose) / prevClose : 0;

  const regime = volRegime(bars, atrSeries, i, VOL_REGIME_LOOKBACK);
  const ema5mDist = computeEmaDist(bars, 5 * 60, 9, last.close);
  const ema15mDist = computeEmaDist(bars, 15 * 60, 9, last.close);
  const mergedContext: SignalContext = { ...context, ema5mDist, ema15mDist };
  // Round 2 structural features computed from the bars themselves.
  const priorDay = findPriorDay(bars, todayKey);
  const todayOpen = todaysBars[0]?.open;
  const vpoc = vpocToday(bars, etDayKey);
  const trend = trendStrength(bars, 60, 3);
  const mlFeatures = buildFeatures({
    close: last.close,
    prevClose,
    rsi: isNum(lastRsi) ? lastRsi : 50,
    vwap: isNum(lastVwap) ? lastVwap : last.close,
    bbLower: lastBb && isNum(lastBb.lower) ? lastBb.lower : last.close,
    bbUpper: lastBb && isNum(lastBb.upper) ? lastBb.upper : last.close,
    atr: isNum(lastAtr) ? lastAtr : 0,
    ts: last.ts,
    volRegime: regime,
    pdh: priorDay?.high,
    pdl: priorDay?.low,
    pdClose: priorDay?.close,
    todayOpen,
    vpoc: isNum(vpoc) ? vpoc : undefined,
    trendStrength: trend,
    context: mergedContext,
  });
  const baseFeatures: Record<string, number> = {
    // Raw values for human inspection / Discord alerts.
    close: last.close,
    prev_close: prevClose,
    // ML-keyed normalized features.
    ...mlFeatures,
  };
  if (isNum(lastVwap)) baseFeatures.vwap = lastVwap;
  if (isNum(lastRsi)) baseFeatures.rsi = lastRsi;
  if (lastBb && isNum(lastBb.width)) baseFeatures.bb_width = lastBb.width;
  if (isNum(lastAtr)) baseFeatures.atr = lastAtr;

  // VWAP reclaim long
  if (
    isNum(lastVwap) &&
    isNum(prevVwap) &&
    isNum(lastAtr) &&
    prev.close < prevVwap &&
    last.close > lastVwap &&
    last.close - lastVwap > lastAtr * 0.1
  ) {
    out.push({
      symbol,
      ts: last.ts,
      setup: 'vwap_reclaim_long',
      direction: 'long',
      price: last.close,
      prevClose,
      changePct,
      notes: `Reclaimed VWAP ${lastVwap.toFixed(2)} from below`,
      features: { ...baseFeatures },
    });
  }

  // VWAP reject short
  if (
    isNum(lastVwap) &&
    isNum(prevVwap) &&
    isNum(lastAtr) &&
    prev.close > prevVwap &&
    last.close < lastVwap &&
    lastVwap - last.close > lastAtr * 0.1
  ) {
    out.push({
      symbol,
      ts: last.ts,
      setup: 'vwap_reject_short',
      direction: 'short',
      price: last.close,
      prevClose,
      changePct,
      notes: `Rejected VWAP ${lastVwap.toFixed(2)} from above`,
      features: { ...baseFeatures },
    });
  }

  // Opening range breakout
  if (todaysBars.length > ORB_MINUTES) {
    const orbBars = todaysBars.slice(0, ORB_MINUTES);
    const orbHigh = Math.max(...orbBars.map((b) => b.high));
    const orbLow = Math.min(...orbBars.map((b) => b.low));
    const postOrb = todaysBars.slice(ORB_MINUTES, -1);
    const alreadyBrokeUp = postOrb.some((b) => b.close > orbHigh);
    const alreadyBrokeDown = postOrb.some((b) => b.close < orbLow);

    if (!alreadyBrokeUp && last.close > orbHigh) {
      out.push({
        symbol,
        ts: last.ts,
        setup: 'orb_breakout_long',
        direction: 'long',
        price: last.close,
        prevClose,
        changePct,
        notes: `Broke ${ORB_MINUTES}m ORB high ${orbHigh.toFixed(2)}`,
        features: { ...baseFeatures, orb_high: orbHigh, orb_low: orbLow },
      });
    }
    if (!alreadyBrokeDown && last.close < orbLow) {
      out.push({
        symbol,
        ts: last.ts,
        setup: 'orb_breakdown_short',
        direction: 'short',
        price: last.close,
        prevClose,
        changePct,
        notes: `Broke ${ORB_MINUTES}m ORB low ${orbLow.toFixed(2)}`,
        features: { ...baseFeatures, orb_high: orbHigh, orb_low: orbLow },
      });
    }
  }

  // Bollinger squeeze release
  if (i >= SQUEEZE_LOOKBACK && lastBb && isNum(lastBb.width)) {
    const widths: number[] = [];
    for (let k = i - SQUEEZE_LOOKBACK + 1; k < i; k++) {
      const w = bb[k]?.width;
      if (isNum(w)) widths.push(w);
    }
    if (widths.length >= SQUEEZE_LOOKBACK / 2) {
      const sorted = [...widths].sort((a, b) => a - b);
      const threshold = sorted[Math.floor(sorted.length * SQUEEZE_PCTILE)];
      if (isNum(threshold)) {
        const releaseTrigger = threshold * SQUEEZE_RELEASE_MULT;
        if (lastBb.width >= releaseTrigger) {
          if (last.close > lastBb.upper) {
            out.push({
              symbol,
              ts: last.ts,
              setup: 'bb_squeeze_release_long',
              direction: 'long',
              price: last.close,
              prevClose,
              changePct,
              notes: `BB squeeze release above upper ${lastBb.upper.toFixed(2)}`,
              features: { ...baseFeatures, bb_upper: lastBb.upper, bb_lower: lastBb.lower },
            });
          } else if (last.close < lastBb.lower) {
            out.push({
              symbol,
              ts: last.ts,
              setup: 'bb_squeeze_release_short',
              direction: 'short',
              price: last.close,
              prevClose,
              changePct,
              notes: `BB squeeze release below lower ${lastBb.lower.toFixed(2)}`,
              features: { ...baseFeatures, bb_upper: lastBb.upper, bb_lower: lastBb.lower },
            });
          }
        }
      }
    }
  }

  // RSI mean reversion
  if (isNum(prevRsi) && isNum(lastRsi)) {
    if (prevRsi < RSI_OVERSOLD && lastRsi > prevRsi && last.close > prev.close) {
      out.push({
        symbol,
        ts: last.ts,
        setup: 'rsi_oversold_reversal',
        direction: 'long',
        price: last.close,
        prevClose,
        changePct,
        notes: `RSI turning up from oversold (${prevRsi.toFixed(1)} → ${lastRsi.toFixed(1)})`,
        features: { ...baseFeatures },
      });
    }
    if (prevRsi > RSI_OVERBOUGHT && lastRsi < prevRsi && last.close < prev.close) {
      out.push({
        symbol,
        ts: last.ts,
        setup: 'rsi_overbought_reversal',
        direction: 'short',
        price: last.close,
        prevClose,
        changePct,
        notes: `RSI turning down from overbought (${prevRsi.toFixed(1)} → ${lastRsi.toFixed(1)})`,
        features: { ...baseFeatures },
      });
    }
  }

  return out;
}

// Returns OHLC summary for the most recent trading day strictly before
// `todayKey`. Used to expose prior day high/low/close as features.
function findPriorDay(bars: Bar[], todayKey: string): { high: number; low: number; close: number } | null {
  let high = -Infinity;
  let low = Infinity;
  let close = NaN;
  let lastKey = '';
  for (let i = bars.length - 1; i >= 0; i--) {
    const b = bars[i]!;
    const k = etDayKey(b.ts);
    if (k === todayKey) continue;
    if (lastKey === '') {
      lastKey = k;
      close = b.close; // most recent bar of the prior day is the day's close
    }
    if (k !== lastKey) break;
    if (b.high > high) high = b.high;
    if (b.low < low) low = b.low;
  }
  if (!Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) return null;
  return { high, low, close };
}

// Aggregates the 1-min bars to `bucketSec` resolution, computes EMA(`period`)
// on the resulting closes, and returns the signed fractional distance of
// `currentClose` from the latest EMA value. Returns 0 if there's not enough
// data — that's neutral after clamping in buildFeatures.
function computeEmaDist(
  bars: Bar[],
  bucketSec: number,
  period: number,
  currentClose: number,
): number {
  const agg = aggregateTo(bars, bucketSec);
  if (agg.length < period) return 0;
  const emaSeries = ema(agg.map((b) => b.close), period);
  const last = emaSeries[emaSeries.length - 1];
  if (!isNum(last) || currentClose <= 0) return 0;
  return (currentClose - last) / currentClose;
}
