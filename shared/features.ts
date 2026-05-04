// Standardized feature extraction shared between backtest (for training data)
// and live signal scoring (for inference). Keep FEATURE_NAMES in sync with
// buildFeatures so model weights map back to the right values.

export const FEATURE_NAMES = [
  'change_pct',
  'rsi_norm',
  'vwap_dist',
  'bb_pos',
  'atr_ratio',
  'min_of_day',
  'dow_norm',
] as const;

export type FeatureName = typeof FEATURE_NAMES[number];

export interface FeatureInput {
  close: number;
  prevClose: number;
  rsi: number;
  vwap: number;
  bbLower: number;
  bbUpper: number;
  atr: number;
  ts: number; // unix seconds, bar open time
}

export function buildFeatures(opts: FeatureInput): Record<FeatureName, number> {
  const date = new Date(opts.ts * 1000);
  // Approximate ET = UTC - 4h (EDT).
  const etMin = (date.getUTCHours() * 60 + date.getUTCMinutes() - 4 * 60 + 1440) % 1440;
  const minSinceOpen = etMin - (9 * 60 + 30);
  const dow = date.getUTCDay(); // 0=Sun..6=Sat
  const bbRange = opts.bbUpper - opts.bbLower;
  return {
    change_pct: opts.prevClose > 0 ? (opts.close - opts.prevClose) / opts.prevClose : 0,
    rsi_norm: opts.rsi / 100,
    vwap_dist: opts.vwap > 0 ? (opts.close - opts.vwap) / opts.vwap : 0,
    bb_pos: bbRange > 0 ? (opts.close - opts.bbLower) / bbRange : 0.5,
    atr_ratio: opts.close > 0 ? opts.atr / opts.close : 0,
    min_of_day: Math.max(0, Math.min(389, minSinceOpen)) / 389,
    // Map Mon-Fri (1..5) to 0..1; weekend bars shouldn't appear but clamp anyway.
    dow_norm: Math.max(0, Math.min(1, (dow - 1) / 4)),
  };
}

export function featuresToVector(features: Record<string, number>): number[] {
  return FEATURE_NAMES.map((n) => {
    const v = features[n];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  });
}
