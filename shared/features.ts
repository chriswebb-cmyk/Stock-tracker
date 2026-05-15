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
  'tod_sin',
  'tod_cos',
  'vix_level_norm',
  'vix_delta_norm',
  'reddit_velocity',
  'reddit_sentiment',
  'mtf_5m_ema_dist',
  'mtf_15m_ema_dist',
  'pc_ratio_norm',
  'gamma_concentration',
  // Round 2: structural / cross-asset features.
  'dist_pdh',         // (close - prev day high) / close
  'dist_pdl',         // (close - prev day low) / close
  'gap_pct',          // (today open - prev close) / prev close
  'vpoc_dist',        // (close - today's volume POC) / close
  'trend_strength',   // -1..1, net of HH/HL vs LH/LL over recent swings
  'spy_rel_return',   // (this symbol's intraday change) - (SPY's intraday change), normalised
  'tnx_level_norm',   // 10Y yield normalised to 0..1 over 1..6%
  'tnx_delta_norm',   // daily change normalised to -1..1
  'days_to_earnings', // 1 = earnings today, 0 = >=30 days out
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
  ts: number;
  volRegime: number;
  // Round 2: caller-computed structural inputs. Optional — defaults are
  // neutral so older callers keep working without code changes.
  pdh?: number;             // prior day high
  pdl?: number;             // prior day low
  pdClose?: number;         // prior day close (used together with todayOpen for gap)
  todayOpen?: number;       // today's first bar open
  vpoc?: number;            // today's volume-weighted POC price
  trendStrength?: number;   // -1..1 HH/HL count vs LH/LL
  context?: SignalContext;
}

export interface SignalContext {
  vixLevel?: number;
  vixDelta?: number;
  redditVelocity?: number;
  redditSentiment?: number;
  pcRatio?: number;
  gammaConcentration?: number;
  ema5mDist?: number;
  ema15mDist?: number;
  // Round 2 context fields.
  spyReturnPct?: number;    // SPY's intraday return, decimal
  tnxLevel?: number;        // 10Y treasury yield, % (e.g. 4.35)
  tnxDelta?: number;        // daily change in yield, % points
  daysToEarnings?: number;  // calendar days; 0 if today, >=30 if far out
}

export function buildFeatures(opts: FeatureInput): Record<FeatureName, number> {
  const date = new Date(opts.ts * 1000);
  const etMin = (date.getUTCHours() * 60 + date.getUTCMinutes() - 4 * 60 + 1440) % 1440;
  const minSinceOpen = etMin - (9 * 60 + 30);
  const dow = date.getUTCDay();
  const bbRange = opts.bbUpper - opts.bbLower;
  const minOfDayNorm = Math.max(0, Math.min(389, minSinceOpen)) / 389;
  const angle = 2 * Math.PI * minOfDayNorm;
  const ctx = opts.context ?? {};
  const changePct = opts.prevClose > 0 ? (opts.close - opts.prevClose) / opts.prevClose : 0;
  // SPY-relative: this symbol's intraday move minus SPY's. Positive = stronger
  // than market. ctx.spyReturnPct is the SPY change; if missing, the relative
  // collapses to 0 (neutral). Magnify by 10 then clamp to keep the feature
  // in roughly [-1, 1] like other normalized inputs.
  const spyRel = ctx.spyReturnPct === undefined ? 0 : changePct - ctx.spyReturnPct;
  return {
    change_pct: changePct,
    rsi_norm: opts.rsi / 100,
    vwap_dist: opts.vwap > 0 ? (opts.close - opts.vwap) / opts.vwap : 0,
    bb_pos: bbRange > 0 ? (opts.close - opts.bbLower) / bbRange : 0.5,
    atr_ratio: opts.close > 0 ? opts.atr / opts.close : 0,
    min_of_day: minOfDayNorm,
    dow_norm: Math.max(0, Math.min(1, (dow - 1) / 4)),
    vol_regime: clamp01(opts.volRegime),
    tod_sin: Math.sin(angle),
    tod_cos: Math.cos(angle),
    vix_level_norm: clamp01(((ctx.vixLevel ?? 18) - 12) / 30),
    vix_delta_norm: clamp((ctx.vixDelta ?? 0) / 5, -1, 1),
    reddit_velocity: clamp((ctx.redditVelocity ?? 1) / 5, 0, 1),
    reddit_sentiment: clamp(ctx.redditSentiment ?? 0, -1, 1),
    mtf_5m_ema_dist: clamp(ctx.ema5mDist ?? 0, -0.1, 0.1) * 10,
    mtf_15m_ema_dist: clamp(ctx.ema15mDist ?? 0, -0.1, 0.1) * 10,
    pc_ratio_norm: clamp(((ctx.pcRatio ?? 1) - 1) / 1.5, -1, 1),
    gamma_concentration: clamp01(ctx.gammaConcentration ?? 0),
    dist_pdh: opts.pdh && opts.close > 0 ? clamp((opts.close - opts.pdh) / opts.close, -0.2, 0.2) * 5 : 0,
    dist_pdl: opts.pdl && opts.close > 0 ? clamp((opts.close - opts.pdl) / opts.close, -0.2, 0.2) * 5 : 0,
    gap_pct:
      opts.todayOpen && opts.pdClose && opts.pdClose > 0
        ? clamp((opts.todayOpen - opts.pdClose) / opts.pdClose, -0.1, 0.1) * 10
        : 0,
    vpoc_dist: opts.vpoc && opts.close > 0 ? clamp((opts.close - opts.vpoc) / opts.close, -0.1, 0.1) * 10 : 0,
    trend_strength: clamp(opts.trendStrength ?? 0, -1, 1),
    spy_rel_return: clamp(spyRel, -0.05, 0.05) * 20,
    // TNX is reported in % (e.g. 4.35). Normalize so 1% maps to 0 and 6% to 1.
    tnx_level_norm: clamp01(((ctx.tnxLevel ?? 4) - 1) / 5),
    tnx_delta_norm: clamp((ctx.tnxDelta ?? 0) / 0.2, -1, 1),
    // Inverted so closer earnings -> higher feature value (avoidance signal).
    // Caps at 30 days out where feature reads 0.
    days_to_earnings: clamp01((30 - Math.min(30, Math.max(0, ctx.daysToEarnings ?? 30))) / 30),
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
