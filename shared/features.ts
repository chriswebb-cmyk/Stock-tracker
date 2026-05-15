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
  'vol_regime',
  // Step 3: cyclic encoding of time of day. Lets a linear model express
  // U-shaped intraday patterns (morning trend / lunch chop / power hour)
  // that min_of_day alone can't represent.
  'tod_sin',
  'tod_cos',
  // Step 4: VIX regime. Normalized so 0 ≈ calm market, 1 ≈ panic.
  'vix_level_norm',
  'vix_delta_norm',
  // Step 6: Reddit chatter intensity and sentiment for this symbol.
  'reddit_velocity',
  'reddit_sentiment',
  // Step 7: multi-timeframe agreement. Distance from EMA(9) computed on
  // 5-min and 15-min bars, signed by the underlying 1-min direction.
  'mtf_5m_ema_dist',
  'mtf_15m_ema_dist',
  // Step 8: options-derived features. P/C ratio normalized so neutral=0;
  // gamma_concentration is the fraction of OI within ±2% of spot.
  'pc_ratio_norm',
  'gamma_concentration',
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
  // 0..1 percentile rank of recent ATR/price vs the trailing window. Caller
  // computes via volRegime(); 0.5 if there isn't enough warmup history.
  volRegime: number;
  // Optional cross-asset / external context. When absent, the corresponding
  // features fall back to neutral values so models trained without context
  // don't degrade on the missing dimensions.
  context?: SignalContext;
}

export interface SignalContext {
  // VIX
  vixLevel?: number;       // raw VIX index value (e.g. 14.5)
  vixDelta?: number;       // VIX change vs previous close (raw points)
  // Reddit / WSB
  redditVelocity?: number; // ratio: mentions(last 1h) / mentions(prior 24h avg per hour)
  redditSentiment?: number; // -1..1, average sentiment across mentioning posts
  // Options
  pcRatio?: number;             // put volume / call volume for the underlying
  gammaConcentration?: number;  // OI fraction in strikes within ±2% of spot (0..1)
  // Multi-timeframe
  ema5mDist?: number;   // (close - ema9_on_5m) / close
  ema15mDist?: number;  // (close - ema9_on_15m) / close
}

export function buildFeatures(opts: FeatureInput): Record<FeatureName, number> {
  const date = new Date(opts.ts * 1000);
  // Approximate ET = UTC - 4h (EDT).
  const etMin = (date.getUTCHours() * 60 + date.getUTCMinutes() - 4 * 60 + 1440) % 1440;
  const minSinceOpen = etMin - (9 * 60 + 30);
  const dow = date.getUTCDay(); // 0=Sun..6=Sat
  const bbRange = opts.bbUpper - opts.bbLower;
  const minOfDayNorm = Math.max(0, Math.min(389, minSinceOpen)) / 389;
  const angle = 2 * Math.PI * minOfDayNorm;
  const ctx = opts.context ?? {};
  return {
    change_pct: opts.prevClose > 0 ? (opts.close - opts.prevClose) / opts.prevClose : 0,
    rsi_norm: opts.rsi / 100,
    vwap_dist: opts.vwap > 0 ? (opts.close - opts.vwap) / opts.vwap : 0,
    bb_pos: bbRange > 0 ? (opts.close - opts.bbLower) / bbRange : 0.5,
    atr_ratio: opts.close > 0 ? opts.atr / opts.close : 0,
    min_of_day: minOfDayNorm,
    dow_norm: Math.max(0, Math.min(1, (dow - 1) / 4)),
    vol_regime: Math.max(0, Math.min(1, opts.volRegime)),
    tod_sin: Math.sin(angle),
    tod_cos: Math.cos(angle),
    // VIX 12 ≈ historically calm, 30+ ≈ panic. Normalize so 12 maps to 0
    // and 42 to 1, then clamp.
    vix_level_norm: clamp01(((ctx.vixLevel ?? 18) - 12) / 30),
    // Daily VIX moves typically within ±5; normalize to [-1, 1].
    vix_delta_norm: clamp((ctx.vixDelta ?? 0) / 5, -1, 1),
    // Reddit velocity is a ratio; cap at 5x to avoid runaway values.
    reddit_velocity: clamp((ctx.redditVelocity ?? 1) / 5, 0, 1),
    reddit_sentiment: clamp(ctx.redditSentiment ?? 0, -1, 1),
    // Multi-timeframe EMA distances (-1..1 after clamp; raw values are
    // typically <0.05).
    mtf_5m_ema_dist: clamp(ctx.ema5mDist ?? 0, -0.1, 0.1) * 10,
    mtf_15m_ema_dist: clamp(ctx.ema15mDist ?? 0, -0.1, 0.1) * 10,
    // P/C ratio: 1.0 is neutral, >1 bearish bias. Center on 0 and clamp.
    pc_ratio_norm: clamp(((ctx.pcRatio ?? 1) - 1) / 1.5, -1, 1),
    gamma_concentration: clamp01(ctx.gammaConcentration ?? 0),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function clamp01(v: number): number {
  return clamp(v, 0, 1);
}

export function featuresToVector(features: Record<string, number>): number[] {
  return FEATURE_NAMES.map((n) => {
    const v = features[n];
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  });
}
