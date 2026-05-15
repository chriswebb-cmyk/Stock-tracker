import type { Bar } from './types';
import { atr, bollinger, etDayKey, isNum, rsi, volRegime, vwap, type BollingerBand } from './indicators';

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

export function detectSetups(symbol: string, bars: Bar[], prevClose: number): DetectedSignal[] {
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
  const baseFeatures: Record<string, number> = {
    close: last.close,
    prev_close: prevClose,
    change_pct: changePct,
    vol_regime: regime,
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
