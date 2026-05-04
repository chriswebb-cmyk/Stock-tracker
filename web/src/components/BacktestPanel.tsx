import { useEffect, useState } from 'react';
import { api, type BacktestSummary } from '../api';

const SETUP_LABEL: Record<string, string> = {
  vwap_reclaim_long: 'VWAP reclaim',
  vwap_reject_short: 'VWAP rejection',
  orb_breakout_long: 'ORB breakout',
  orb_breakdown_short: 'ORB breakdown',
  bb_squeeze_release_long: 'BB squeeze (up)',
  bb_squeeze_release_short: 'BB squeeze (down)',
  rsi_oversold_reversal: 'RSI oversold rev.',
  rsi_overbought_reversal: 'RSI overbought rev.',
};

const HOLD_OPTIONS = [15, 30, 60, 120];
const DAYS_OPTIONS = [3, 7];

function fmtPct(p: number): string {
  return `${(p * 100).toFixed(2)}%`;
}

export function BacktestPanel() {
  const [days, setDays] = useState(7);
  const [hold, setHold] = useState(30);
  const [data, setData] = useState<BacktestSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .backtestSummary(days, hold)
      .then((d) => {
        if (!cancelled) setData(d);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days, hold]);

  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center gap-4 text-xs">
        <div className="flex items-center gap-1">
          <span className="text-slate-500">Days</span>
          {DAYS_OPTIONS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className={
                'px-2 py-1 rounded ' +
                (d === days ? 'bg-slate-700 text-white' : 'text-slate-400 hover:bg-slate-800')
              }
            >
              {d}d
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <span className="text-slate-500">Hold</span>
          {HOLD_OPTIONS.map((h) => (
            <button
              key={h}
              type="button"
              onClick={() => setHold(h)}
              className={
                'px-2 py-1 rounded ' +
                (h === hold ? 'bg-slate-700 text-white' : 'text-slate-400 hover:bg-slate-800')
              }
            >
              {h}m
            </button>
          ))}
        </div>
        {loading && <span className="text-slate-500">loading…</span>}
      </div>

      {error && <div className="text-rose-400 text-xs">{error}</div>}

      {data && (
        <>
          <div className="text-xs text-slate-400">
            {data.symbols} symbols · {data.trades} trades · last {days}d · {hold}m hold
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs uppercase text-slate-500">
                <tr>
                  <th className="text-left py-1 pr-3">Setup</th>
                  <th className="text-right py-1 px-2">Trades</th>
                  <th className="text-right py-1 px-2">Win rate</th>
                  <th className="text-right py-1 px-2">Avg P&amp;L</th>
                  <th className="text-right py-1 px-2">Median</th>
                  <th className="text-right py-1 px-2">Best</th>
                  <th className="text-right py-1 px-2">Worst</th>
                  <th className="text-right py-1 pl-2">Total P&amp;L</th>
                </tr>
              </thead>
              <tbody>
                {data.bySetup.length === 0 && (
                  <tr>
                    <td colSpan={8} className="py-3 text-slate-500 italic">
                      No trades fired in this window. Backfill more history or wait for live signals.
                    </td>
                  </tr>
                )}
                {data.bySetup.map((s) => (
                  <tr key={s.setup} className="border-t border-slate-800">
                    <td className="py-1 pr-3">{SETUP_LABEL[s.setup] ?? s.setup}</td>
                    <td className="text-right px-2 tabular-nums">{s.trades}</td>
                    <td className="text-right px-2 tabular-nums">{(s.winRate * 100).toFixed(1)}%</td>
                    <td
                      className={
                        'text-right px-2 tabular-nums ' +
                        (s.avgPnlPct >= 0 ? 'text-emerald-400' : 'text-rose-400')
                      }
                    >
                      {fmtPct(s.avgPnlPct)}
                    </td>
                    <td className="text-right px-2 tabular-nums">{fmtPct(s.medianPnlPct)}</td>
                    <td className="text-right px-2 tabular-nums text-emerald-400">{fmtPct(s.bestPnlPct)}</td>
                    <td className="text-right px-2 tabular-nums text-rose-400">{fmtPct(s.worstPnlPct)}</td>
                    <td
                      className={
                        'text-right pl-2 tabular-nums ' +
                        (s.totalPnlPct >= 0 ? 'text-emerald-400' : 'text-rose-400')
                      }
                    >
                      {fmtPct(s.totalPnlPct)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
