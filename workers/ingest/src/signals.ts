import type { Quote } from './finnhub';

export type SetupName =
  | 'big_move_up'
  | 'big_move_down'
  | 'day_high_break'
  | 'day_low_break';

export interface DetectedSignal {
  symbol: string;
  ts: number;
  setup: SetupName;
  direction: 'long' | 'short';
  price: number;
  prevClose: number;
  changePct: number;
  notes: string;
}

// Tuning knobs. Conservative defaults so we don't spam Discord.
const BIG_MOVE_PCT = 0.02;          // 2% from previous close
const BREAK_PROXIMITY = 0.002;      // within 0.2% of day high/low
const BREAK_MIN_DAY_RANGE = 0.005;  // day extreme must be > 0.5% from prev close

export function detectSignals(symbol: string, ts: number, q: Quote): DetectedSignal[] {
  const out: DetectedSignal[] = [];
  if (q.prevClose <= 0 || q.current <= 0) return out;

  const changePct = (q.current - q.prevClose) / q.prevClose;
  const absChange = Math.abs(changePct);

  if (changePct >= BIG_MOVE_PCT) {
    out.push({
      symbol,
      ts,
      setup: 'big_move_up',
      direction: 'long',
      price: q.current,
      prevClose: q.prevClose,
      changePct,
      notes: `Up ${(changePct * 100).toFixed(2)}% vs prev close`,
    });
  } else if (-changePct >= BIG_MOVE_PCT) {
    out.push({
      symbol,
      ts,
      setup: 'big_move_down',
      direction: 'short',
      price: q.current,
      prevClose: q.prevClose,
      changePct,
      notes: `Down ${(absChange * 100).toFixed(2)}% vs prev close`,
    });
  }

  // Day-high break: price near day high AND day high meaningfully above prev close.
  if (
    q.dayHigh > 0 &&
    q.current >= q.dayHigh * (1 - BREAK_PROXIMITY) &&
    q.dayHigh >= q.prevClose * (1 + BREAK_MIN_DAY_RANGE)
  ) {
    out.push({
      symbol,
      ts,
      setup: 'day_high_break',
      direction: 'long',
      price: q.current,
      prevClose: q.prevClose,
      changePct,
      notes: `At day high ${q.dayHigh.toFixed(2)} (${(changePct * 100).toFixed(2)}% on day)`,
    });
  }

  // Day-low break: price near day low AND day low meaningfully below prev close.
  if (
    q.dayLow > 0 &&
    q.current <= q.dayLow * (1 + BREAK_PROXIMITY) &&
    q.dayLow <= q.prevClose * (1 - BREAK_MIN_DAY_RANGE)
  ) {
    out.push({
      symbol,
      ts,
      setup: 'day_low_break',
      direction: 'short',
      price: q.current,
      prevClose: q.prevClose,
      changePct,
      notes: `At day low ${q.dayLow.toFixed(2)} (${(changePct * 100).toFixed(2)}% on day)`,
    });
  }

  return out;
}
