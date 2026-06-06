import { useEffect, useMemo, useState } from 'react';
import { api, type EarningsItem } from '../api';
import type { Ticker } from '../../../shared/types';

interface Props {
  tickers: Ticker[];
  onSelectSymbol?: (symbol: string) => void;
}

const DAY_OPTIONS = [7, 14, 30];

function fmtMoney(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  return v.toFixed(2);
}

function fmtRevenue(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
  return '$' + v.toFixed(0);
}

function fmtDate(s: string): string {
  // 'YYYY-MM-DD' → 'Mon Jun 2'
  const [y, m, d] = s.split('-').map((n) => parseInt(n, 10));
  if (!y || !m || !d) return s;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
}

function fmtHour(h: string): string {
  if (h === 'bmo') return 'before open';
  if (h === 'amc') return 'after close';
  return '—';
}

function epsSurprisePct(actual: number | null, est: number | null): number | null {
  if (actual === null || est === null || est === 0) return null;
  return (actual - est) / Math.abs(est);
}

export function EarningsPanel({ tickers, onSelectSymbol }: Props) {
  const [days, setDays] = useState(7);
  const [items, setItems] = useState<EarningsItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [watchOnly, setWatchOnly] = useState(true);

  const watchSet = useMemo(
    () => new Set(tickers.filter((t) => t.enabled).map((t) => t.symbol)),
    [tickers],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .earnings(days)
      .then((rows) => {
        if (!cancelled) setItems(rows);
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
  }, [days]);

  const filtered = useMemo(
    () => (watchOnly ? items.filter((r) => watchSet.has(r.symbol)) : items),
    [items, watchOnly, watchSet],
  );

  // Group by date for the day headers.
  const groups = useMemo(() => {
    const map = new Map<string, EarningsItem[]>();
    for (const r of filtered) {
      const arr = map.get(r.date) ?? [];
      arr.push(r);
      map.set(r.date, arr);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  return (
    <div className="p-3 sm:p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-base font-semibold">Earnings calendar</h2>
        <div className="flex items-center gap-1">
          <span className="text-xs text-slate-500">Window</span>
          {DAY_OPTIONS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className={
                'px-2 py-1 text-xs rounded ' +
                (d === days
                  ? 'bg-slate-700 text-white'
                  : 'text-slate-400 hover:bg-slate-800')
              }
            >
              {d}d
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer ml-auto">
          <input
            type="checkbox"
            checked={watchOnly}
            onChange={(e) => setWatchOnly(e.target.checked)}
            className="accent-emerald-500"
          />
          Watchlist only
        </label>
      </div>

      <p className="text-xs text-slate-400 max-w-3xl">
        Source: Finnhub. Earnings are a known volatility event — options premiums
        swell into the print, and the post-earnings move often dwarfs the prior
        week's range. Use this list to skip trades on names that report inside
        your hold window (or to deliberately take vol exposure on names you
        believe will surprise).
      </p>

      {error && <div className="text-rose-400 text-xs">{error}</div>}
      {loading && <div className="text-slate-500 text-sm">Loading…</div>}

      {!loading && !error && filtered.length === 0 && (
        <div className="text-slate-500 text-sm border border-slate-800 rounded p-4">
          {watchOnly
            ? `No watchlist symbols report in the next ${days} days.`
            : `No earnings in the next ${days} days.`}
        </div>
      )}

      {groups.length > 0 && (
        <div className="space-y-4">
          {groups.map(([date, rows]) => (
            <div key={date} className="border border-slate-800 rounded overflow-hidden">
              <div className="bg-slate-950 px-3 py-2 text-xs uppercase tracking-wider text-slate-300 font-medium">
                {fmtDate(date)} ·{' '}
                <span className="text-slate-500 normal-case">{rows.length} reports</span>
              </div>
              <table className="w-full text-sm">
                <thead className="text-xs uppercase tracking-wider text-slate-500 bg-slate-900/60">
                  <tr>
                    <th className="text-left px-3 py-1.5">Symbol</th>
                    <th className="text-left px-3 py-1.5">When</th>
                    <th className="text-right px-3 py-1.5">EPS est</th>
                    <th className="text-right px-3 py-1.5">EPS actual</th>
                    <th className="text-right px-3 py-1.5">Surprise</th>
                    <th className="text-right px-3 py-1.5 hidden md:table-cell">Rev est</th>
                    <th className="text-right px-3 py-1.5 hidden md:table-cell">Rev actual</th>
                    <th className="text-right px-3 py-1.5 hidden lg:table-cell">Q/FY</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const inWatchlist = watchSet.has(r.symbol);
                    const surprise = epsSurprisePct(r.epsActual, r.epsEstimate);
                    const positive = surprise !== null && surprise >= 0;
                    return (
                      <tr
                        key={r.symbol + r.date + r.hour}
                        className={
                          'border-t border-slate-800 ' +
                          (inWatchlist
                            ? 'bg-emerald-950/20 hover:bg-emerald-950/40 cursor-pointer'
                            : 'hover:bg-slate-900/40 cursor-pointer')
                        }
                        onClick={() => onSelectSymbol?.(r.symbol)}
                      >
                        <td className="text-left px-3 py-1.5 font-medium">
                          {r.symbol}
                          {inWatchlist && (
                            <span className="ml-1.5 text-xs text-emerald-400">●</span>
                          )}
                        </td>
                        <td className="text-left px-3 py-1.5 text-slate-400 text-xs">
                          {fmtHour(r.hour)}
                        </td>
                        <td className="text-right px-3 py-1.5 tabular-nums">
                          {fmtMoney(r.epsEstimate)}
                        </td>
                        <td className="text-right px-3 py-1.5 tabular-nums">
                          {fmtMoney(r.epsActual)}
                        </td>
                        <td
                          className={
                            'text-right px-3 py-1.5 tabular-nums ' +
                            (surprise === null
                              ? 'text-slate-600'
                              : positive
                                ? 'text-emerald-400'
                                : 'text-rose-400')
                          }
                        >
                          {surprise === null
                            ? '—'
                            : (positive ? '+' : '') +
                              (surprise * 100).toFixed(1) +
                              '%'}
                        </td>
                        <td className="text-right px-3 py-1.5 tabular-nums hidden md:table-cell text-slate-300">
                          {fmtRevenue(r.revenueEstimate)}
                        </td>
                        <td className="text-right px-3 py-1.5 tabular-nums hidden md:table-cell text-slate-300">
                          {fmtRevenue(r.revenueActual)}
                        </td>
                        <td className="text-right px-3 py-1.5 tabular-nums hidden lg:table-cell text-slate-500 text-xs">
                          Q{r.quarter} FY{r.year}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
