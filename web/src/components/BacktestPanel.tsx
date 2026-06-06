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
const DAYS_OPTIONS = [1, 3, 7];

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

          {data.bySymbol && data.bySymbol.length > 0 && (
            <PerSymbolMatrix bySymbol={data.bySymbol} bySetupTotal={data.bySetup} />
          )}
        </>
      )}
    </div>
  );
}

interface SetupStatsLite {
  setup: string;
  trades: number;
  winRate: number;
  avgPnlPct: number;
  totalPnlPct: number;
}

interface PerSymbolRow {
  symbol: string;
  trades: number;
  bySetup: SetupStatsLite[];
}

type SortKey = 'symbol' | 'trades' | 'totalPnlPct';

// Per-symbol breakdown. Heatmap-style matrix: rows = symbols, columns =
// setups, each cell shows win-rate / trade-count colored by edge. Lets you
// see at a glance "VWAP reclaim is great on NVDA but garbage on TLT".
function PerSymbolMatrix({
  bySymbol,
  bySetupTotal,
}: {
  bySymbol: PerSymbolRow[];
  bySetupTotal: SetupStatsLite[];
}) {
  const [sortKey, setSortKey] = useState<SortKey>('totalPnlPct');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  // Column order matches the aggregate table: setups that actually fired
  // in this window, in the order the aggregate displays them.
  const setupCols = bySetupTotal.filter((s) => s.trades > 0).map((s) => s.setup);

  // For each row, compute totals across all setups so we can sort by it.
  const enriched = bySymbol.map((r) => {
    const totalPnl = r.bySetup.reduce((acc, s) => acc + s.totalPnlPct, 0);
    return { ...r, totalPnlPct: totalPnl };
  });

  const sorted = [...enriched].sort((a, b) => {
    const mul = sortDir === 'asc' ? 1 : -1;
    if (sortKey === 'symbol') return a.symbol.localeCompare(b.symbol) * mul;
    if (sortKey === 'trades') return (a.trades - b.trades) * mul;
    return (a.totalPnlPct - b.totalPnlPct) * mul;
  });

  function toggleSort(k: SortKey) {
    if (k === sortKey) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else {
      setSortKey(k);
      setSortDir(k === 'symbol' ? 'asc' : 'desc');
    }
  }

  function cellColor(s: SetupStatsLite | undefined): string {
    if (!s || s.trades === 0) return 'bg-slate-900/40 text-slate-600';
    const edge = s.avgPnlPct;
    if (edge >= 0.005) return 'bg-emerald-900/40 text-emerald-200';
    if (edge >= 0.002) return 'bg-emerald-900/20 text-emerald-300';
    if (edge <= -0.005) return 'bg-rose-900/40 text-rose-200';
    if (edge <= -0.002) return 'bg-rose-900/20 text-rose-300';
    return 'bg-slate-800/40 text-slate-300';
  }

  return (
    <div className="space-y-2 pt-2 border-t border-slate-800">
      <div className="flex items-baseline justify-between">
        <h3 className="text-sm font-medium text-slate-200">Per-symbol breakdown</h3>
        <span className="text-xs text-slate-500">
          cells = avg P&amp;L / trades · click headers to sort
        </span>
      </div>
      <div className="overflow-auto border border-slate-800 rounded max-h-[60vh]">
        <table className="text-xs">
          <thead className="text-xs uppercase tracking-wider text-slate-300 bg-slate-950 sticky top-0 z-10 shadow-[0_1px_0_0_rgb(30,41,59)]">
            <tr>
              <th
                onClick={() => toggleSort('symbol')}
                className="text-left px-2 py-2 cursor-pointer hover:text-white"
              >
                Symbol {sortKey === 'symbol' && (sortDir === 'asc' ? '▲' : '▼')}
              </th>
              <th
                onClick={() => toggleSort('trades')}
                className="text-right px-2 py-2 cursor-pointer hover:text-white"
              >
                Trades {sortKey === 'trades' && (sortDir === 'asc' ? '▲' : '▼')}
              </th>
              <th
                onClick={() => toggleSort('totalPnlPct')}
                className="text-right px-2 py-2 cursor-pointer hover:text-white"
              >
                Total P&amp;L {sortKey === 'totalPnlPct' && (sortDir === 'asc' ? '▲' : '▼')}
              </th>
              {setupCols.map((setup) => (
                <th key={setup} className="text-right px-2 py-2 whitespace-nowrap">
                  {SETUP_LABEL[setup] ?? setup}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => {
              const bySetupMap = new Map(row.bySetup.map((s) => [s.setup, s]));
              return (
                <tr key={row.symbol} className="border-t border-slate-900">
                  <td className="px-2 py-1.5 font-medium text-slate-100">{row.symbol}</td>
                  <td className="text-right px-2 py-1.5 tabular-nums text-slate-400">
                    {row.trades}
                  </td>
                  <td
                    className={
                      'text-right px-2 py-1.5 tabular-nums font-medium ' +
                      (row.totalPnlPct >= 0 ? 'text-emerald-400' : 'text-rose-400')
                    }
                  >
                    {fmtPct(row.totalPnlPct)}
                  </td>
                  {setupCols.map((setup) => {
                    const s = bySetupMap.get(setup);
                    return (
                      <td
                        key={setup}
                        className={
                          'text-right px-2 py-1.5 tabular-nums whitespace-nowrap ' +
                          cellColor(s)
                        }
                        title={
                          s && s.trades > 0
                            ? `${SETUP_LABEL[setup] ?? setup}\nwin rate: ${(s.winRate * 100).toFixed(1)}%\navg P&L: ${fmtPct(s.avgPnlPct)}\ntotal: ${fmtPct(s.totalPnlPct)}\ntrades: ${s.trades}`
                            : 'no trades fired'
                        }
                      >
                        {s && s.trades > 0
                          ? `${fmtPct(s.avgPnlPct)} (${s.trades})`
                          : '—'}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
