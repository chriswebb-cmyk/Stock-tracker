import { useEffect, useState } from 'react';
import { api, type KronosForecast } from '../api';

interface Props {
  onSelectSymbol?: (symbol: string) => void;
}

function fmtPct(v: number): string {
  return (v * 100).toFixed(2) + '%';
}

function fmtMoney(v: number | null): string {
  if (v === null || !Number.isFinite(v)) return '—';
  return '$' + v.toFixed(2);
}

function fmtRelTime(unixSec: number): string {
  const ageHrs = (Date.now() / 1000 - unixSec) / 3600;
  if (ageHrs < 1) return `${Math.round(ageHrs * 60)}m ago`;
  if (ageHrs < 24) return `${ageHrs.toFixed(1)}h ago`;
  return `${(ageHrs / 24).toFixed(1)}d ago`;
}

export function KronosPanel({ onSelectSymbol }: Props) {
  const [forecasts, setForecasts] = useState<KronosForecast[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      api
        .kronosLatest()
        .then((rows) => {
          if (cancelled) return;
          setForecasts(rows);
          setError(null);
        })
        .catch((e) => {
          if (cancelled) return;
          setError(e instanceof Error ? e.message : String(e));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };
    load();
    const id = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // Sort by expected return descending so the highest-conviction longs are
  // up top. Symbols with no forecast (returns null/NaN) fall to the bottom.
  const sorted = [...forecasts].sort((a, b) => b.expected_return_pct - a.expected_return_pct);

  return (
    <div className="p-3 sm:p-4 space-y-3">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">Kronos forecasts</h2>
        <p className="text-xs text-slate-400 max-w-3xl">
          Daily-horizon "second opinion" from the Kronos foundation model, run locally on
          your machine. <strong className="text-slate-200">Forecast</strong> is the
          median predicted close at the horizon (default 5 trading days);{' '}
          <strong className="text-slate-200">P10–P90 band</strong> shows the 80%
          confidence range from the sampled forecast paths; a wide band means low
          conviction. <strong className="text-slate-200">Hit rate</strong> and{' '}
          <strong className="text-slate-200">MAE</strong> come from{' '}
          <code className="text-slate-300">backtest.py</code> — hit rate is the
          fraction of historical predictions whose direction matched reality;
          green ≥55%, rose ≤45%. Run forecasts daily, the backtest occasionally.
        </p>
      </div>

      {error && <div className="text-rose-400 text-xs">{error}</div>}

      {!loading && forecasts.length === 0 && !error && (
        <div className="text-slate-500 text-sm border border-slate-800 rounded p-4">
          No forecasts yet. Run{' '}
          <code className="text-slate-300">python forecast.py</code> in{' '}
          <code className="text-slate-300">tools/kronos_forecast/</code> to populate.
        </div>
      )}

      {loading && <div className="text-slate-500 text-sm">Loading…</div>}

      {sorted.length > 0 && (
        <div className="overflow-auto border border-slate-800 rounded">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wider text-slate-300 bg-slate-950 sticky top-0 z-10 shadow-[0_1px_0_0_rgb(30,41,59)]">
              <tr>
                <th className="text-left px-3 py-2">Symbol</th>
                <th className="text-right px-3 py-2">Spot</th>
                <th className="text-right px-3 py-2">Forecast</th>
                <th className="text-right px-3 py-2">Expected return</th>
                <th className="text-right px-3 py-2 hidden md:table-cell">P10–P90 band</th>
                <th className="text-right px-3 py-2 hidden lg:table-cell">Hit rate</th>
                <th className="text-right px-3 py-2 hidden lg:table-cell">MAE</th>
                <th className="text-right px-3 py-2 hidden sm:table-cell">Horizon</th>
                <th className="text-right px-3 py-2 hidden sm:table-cell">Generated</th>
                <th className="text-right px-3 py-2 hidden xl:table-cell">Model</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((f) => {
                const positive = f.expected_return_pct >= 0;
                const strong = Math.abs(f.expected_return_pct) >= 0.02;
                const colorClass =
                  positive && strong
                    ? 'text-emerald-300'
                    : !positive && strong
                      ? 'text-rose-300'
                      : 'text-slate-300';
                const bandLow =
                  f.forecast_p10 !== null
                    ? (f.forecast_p10 - f.current_close) / f.current_close
                    : null;
                const bandHigh =
                  f.forecast_p90 !== null
                    ? (f.forecast_p90 - f.current_close) / f.current_close
                    : null;
                const hitRateColor =
                  f.hit_rate === null
                    ? 'text-slate-500'
                    : f.hit_rate >= 0.55
                      ? 'text-emerald-300'
                      : f.hit_rate <= 0.45
                        ? 'text-rose-300'
                        : 'text-slate-400';
                return (
                  <tr
                    key={f.symbol}
                    className="border-t border-slate-800 hover:bg-slate-900/40 cursor-pointer"
                    onClick={() => onSelectSymbol?.(f.symbol)}
                  >
                    <td className="text-left px-3 py-1.5 font-medium">{f.symbol}</td>
                    <td className="text-right px-3 py-1.5 tabular-nums">{fmtMoney(f.current_close)}</td>
                    <td className="text-right px-3 py-1.5 tabular-nums">{fmtMoney(f.forecast_close)}</td>
                    <td className={'text-right px-3 py-1.5 tabular-nums font-medium ' + colorClass}>
                      {positive ? '+' : ''}
                      {fmtPct(f.expected_return_pct)}
                    </td>
                    <td className="text-right px-3 py-1.5 tabular-nums hidden md:table-cell text-slate-400 text-xs">
                      {bandLow !== null && bandHigh !== null
                        ? `${bandLow >= 0 ? '+' : ''}${(bandLow * 100).toFixed(1)}% / ${bandHigh >= 0 ? '+' : ''}${(bandHigh * 100).toFixed(1)}%`
                        : '—'}
                    </td>
                    <td className={'text-right px-3 py-1.5 tabular-nums hidden lg:table-cell ' + hitRateColor}>
                      {f.hit_rate !== null ? (f.hit_rate * 100).toFixed(0) + '%' : '—'}
                    </td>
                    <td className="text-right px-3 py-1.5 tabular-nums hidden lg:table-cell text-slate-400 text-xs">
                      {f.mae_pct !== null ? (f.mae_pct * 100).toFixed(2) + '%' : '—'}
                    </td>
                    <td className="text-right px-3 py-1.5 tabular-nums hidden sm:table-cell text-slate-400">
                      {f.horizon_days}d
                    </td>
                    <td className="text-right px-3 py-1.5 hidden sm:table-cell text-slate-500 text-xs">
                      {fmtRelTime(f.generated_at)}
                    </td>
                    <td className="text-right px-3 py-1.5 hidden xl:table-cell text-slate-500 text-xs">
                      {f.model_name}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
