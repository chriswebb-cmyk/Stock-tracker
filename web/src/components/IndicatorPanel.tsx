import { useMemo } from 'react';
import type { Bar } from '../../../shared/types';
import { ema, rsi, sessionVwap, sma } from '../indicators';

interface Props {
  bars: Bar[];
}

function last<T>(arr: (T | null)[]): T | null {
  for (let i = arr.length - 1; i >= 0; i--) {
    const v = arr[i];
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

function fmt(n: number | null, digits = 2): string {
  if (n === null || !Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

export function IndicatorPanel({ bars }: Props) {
  const stats = useMemo(() => {
    const closes = bars.map((b) => b.close);
    const sma20 = last(sma(closes, 20));
    const sma50 = last(sma(closes, 50));
    const ema9 = last(ema(closes, 9));
    const r = last(rsi(closes, 14));
    const vwap = last(sessionVwap(bars));
    const lastBar = bars[bars.length - 1] ?? null;
    return { sma20, sma50, ema9, rsi: r, vwap, lastBar };
  }, [bars]);

  if (!stats.lastBar) {
    return (
      <div className="px-4 py-3 text-sm text-slate-500">
        Waiting for bars…
      </div>
    );
  }

  const price = stats.lastBar.close;
  const vwapDelta = stats.vwap !== null ? ((price - stats.vwap) / stats.vwap) * 100 : null;

  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 px-4 py-3 text-sm">
      <Stat label="Price" value={fmt(price)} />
      <Stat
        label="VWAP"
        value={fmt(stats.vwap)}
        sub={vwapDelta !== null ? `${vwapDelta >= 0 ? '+' : ''}${vwapDelta.toFixed(2)}%` : undefined}
        subTone={vwapDelta !== null ? (vwapDelta >= 0 ? 'pos' : 'neg') : undefined}
      />
      <Stat label="EMA(9)" value={fmt(stats.ema9)} />
      <Stat label="SMA(20)" value={fmt(stats.sma20)} />
      <Stat label="SMA(50)" value={fmt(stats.sma50)} />
      <Stat label="RSI(14)" value={fmt(stats.rsi, 1)} tone={rsiTone(stats.rsi)} />
    </div>
  );
}

function rsiTone(r: number | null): 'pos' | 'neg' | undefined {
  if (r === null) return undefined;
  if (r >= 70) return 'neg';
  if (r <= 30) return 'pos';
  return undefined;
}

function Stat({
  label,
  value,
  sub,
  tone,
  subTone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'pos' | 'neg';
  subTone?: 'pos' | 'neg';
}) {
  const toneClass =
    tone === 'pos' ? 'text-emerald-400' : tone === 'neg' ? 'text-rose-400' : 'text-slate-100';
  const subToneClass =
    subTone === 'pos' ? 'text-emerald-400' : subTone === 'neg' ? 'text-rose-400' : 'text-slate-500';
  return (
    <div className="rounded-md bg-slate-900 border border-slate-800 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
      <div className={`text-base font-semibold ${toneClass}`}>{value}</div>
      {sub && <div className={`text-xs ${subToneClass}`}>{sub}</div>}
    </div>
  );
}
