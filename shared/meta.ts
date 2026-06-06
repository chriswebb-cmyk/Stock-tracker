// Meta-ensemble stacker. Takes the per-setup model's calibrated probability
// plus context (setup identity, direction, base features) and outputs a
// unified probability. Lets the model learn cross-setup patterns, e.g.
// "RSI overbought reversal in high vol + bearish SPY-relative + lunch
// hour wins more than the per-setup model says, because per-setup couldn't
// see those interactions."

import type { SetupName } from './setups';
import { FEATURE_NAMES } from './features';

// Stable ordering for the one-hot encoding of the setup that fired. Changing
// this list breaks loaded meta models — they're keyed by position.
const SETUP_ORDER: readonly SetupName[] = [
  'vwap_reclaim_long',
  'vwap_reject_short',
  'orb_breakout_long',
  'orb_breakdown_short',
  'bb_squeeze_release_long',
  'bb_squeeze_release_short',
  'rsi_oversold_reversal',
  'rsi_overbought_reversal',
];

export const META_FEATURE_NAMES = [
  'setup_prob',     // calibrated per-setup probability
  'direction_long', // 1 if long, 0 if short
  ...SETUP_ORDER.map((s) => `setup_${s}` as const),
  ...FEATURE_NAMES,
] as const;

export type MetaFeatureName = typeof META_FEATURE_NAMES[number];

export function buildMetaVector(
  setupProb: number,
  setup: SetupName,
  direction: 'long' | 'short',
  baseFeatures: number[],
): number[] {
  const v: number[] = new Array(META_FEATURE_NAMES.length);
  let i = 0;
  v[i++] = setupProb;
  v[i++] = direction === 'long' ? 1 : 0;
  for (const s of SETUP_ORDER) v[i++] = s === setup ? 1 : 0;
  for (const f of baseFeatures) v[i++] = f;
  // If baseFeatures was shorter than expected (older callers, missing
  // features), pad with zeros so the vector length matches model weights.
  while (i < META_FEATURE_NAMES.length) v[i++] = 0;
  return v;
}
