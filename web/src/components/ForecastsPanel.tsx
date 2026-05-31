import { useEffect, useMemo, useState } from 'react';
import { api, type KronosForecast } from '../api';

interface Props {
  onSelectSymbol?: (symbol: string) => void;
}

interface Row {
  symbol: string;
  kronos: KronosForecast | null;
  chronos: KronosForecast | null;
}

function fmtPctSigned(v: number): string {
  return (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%';
}

function fmtMoney(v: number | null | undefined): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  return '$' + v.toFixed(2);
}

function fmtRelTime(unixSec: number): string {
  const ageHrs = (Date.now() / 1000 - unixSec) / 3600;
  if (ageHrs < 1) return `${Math.round(ageHrs * 60)}m ago`;
  if (ageHrs < 24) return `${ageHrs.toFixed(1)}h ago`;
  return `${(ageHrs / 24).toFixed(1)}d ago`;
}

function returnColor(positive: boolean, strong: boolean): string {
  if (!strong) return 'text-slate-300';
  return positive ? 'text-emerald-300' : 'text-rose-300';
}

export function ForecastsPanel({ onSelectSymbol }: Props) {
  const [kronos, setKronos] = useState<KronosForecast[]>([]);
  const [chronos, setChronos] = useState<KronosForecast[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      // Fetch both endpoints in parallel; tolerate one failing.
      Promise.allSettled([api.kronosLatest(), api.chronosLatest()])
        .then(([k, c]) => {
          if (cancelled) return;
          if (k.status === 'fulfilled') setKronos(k.value);
          if (c.status === 'fulfilled') setChronos(c.value);
          if (k.status === 'rejected' && c.status === 'rejected') {
            setError(
              k.reason instanceof Error ? k.reason.message : String(k.reason),
            );
          } else {
            setError(null);
          }
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

  const rows = useMemo<Row[]>(() => {
    const byKronos = new Map(kronos.map((f) => [f.symbol, f]));
    const byChronos = new Map(chronos.map((f) => [f.symbol, f]));
    const allSymbols = new Set<string>([...byKronos.keys(), ...byChronos.keys()]);
    return [...allSymbols].map((symbol) => ({
      symbol,
      kronos: byKronos.get(symbol) ?? null,
      chronos: byChronos.get(symbol) ?? null,
    }));
  }, [kronos, chronos]);

  // Sort by ensemble strength: prefer rows where both models agree and have
  // larger combined magnitude. Disagreements fall to the bottom.
  const sorted = useMemo(() => {
    return [...rows].sort((a, b) => {
      const score = (r: Row) => {
        const k = r.kronos?.expected_return_pct ?? 0;
        const c = r.chronos?.expected_return_pct ?? 0;
        const agree = Math.sign(k) === Math.sign(c) && k !== 0 && c !== 0;
        return agree ? Math.abs(k) + Math.abs(c) : -Math.abs(k - c);
      };
      return score(b) - score(a);
    });
  }, [rows]);

  function renderAgreement(r: Row): JSX.Element {
    const kRet = r.kronos?.expected_return_pct;
    const cRet = r.chronos?.expected_return_pct;
    if (kRet === undefined || cRet === undefined) {
      return <span className="text-slate-600 text-xs">—</span>;
    }
    const sameSign = (kRet >= 0) === (cRet >= 0);
    const bothStrong = Math.abs(kRet) >= 0.01 && Math.abs(cRet) >= 0.01;
    if (sameSign && bothStrong) {
      const positive = kRet >= 0;
      return (
        <span className={positive ? 'text-emerald-400 font-medium' : 'text-rose-400 font-medium'}>
          {positive ? '⬆ agree' : '⬇ agree'}
        </span>
      );
    }
    if (!sameSign) {
      return <span className="text-amber-400 font-medium">⚠ split</span>;
    }
    return <span className="text-slate-500 text-xs">flat</span>;
  }

  function renderModelCell(f: KronosForecast | null): JSX.Element {
    if (!f) return <span className="text-slate-600">—</span>;
    const positive = f.expected_return_pct >= 0;
    const strong = Math.abs(f.expected_return_pct) >= 0.02;
    const cls = returnColor(positive, strong);
    const bandLow =
      f.forecast_p10 !== null
        ? (f.forecast_p10 - f.current_close) / f.current_close
        : null;
    const bandHigh =
      f.forecast_p90 !== null
        ? (f.forecast_p90 - f.current_close) / f.current_close
        : null;
    return (
      <div>
        <div className={'tabular-nums font-medium ' + cls}>
          {fmtPctSigned(f.expected_return_pct)}
        </div>
        {bandLow !== null && bandHigh !== null && (
          <div className="text-xs text-slate-500 tabular-nums">
            {fmtPctSigned(bandLow)} / {fmtPctSigned(bandHigh)}
          </div>
        )}
      </div>
    );
  }

  function renderHitRate(f: KronosForecast | null): JSX.Element {
    if (!f || f.hit_rate === null) return <span className="text-slate-600">—</span>;
    const cls =
      f.hit_rate >= 0.55
        ? 'text-emerald-300'
        : f.hit_rate <= 0.45
          ? 'text-rose-300'
          : 'text-slate-400';
    return <span className={'tabular-nums ' + cls}>{(f.hit_rate * 100).toFixed(0)}%</span>;
  }

  return (
    <div className="p-3 sm:p-4 space-y-3">
      <div className="space-y-1">
        <h2 className="text-base font-semibold">Forecast ensemble</h2>
        <p className="text-xs text-slate-400 max-w-3xl">
          Side-by-side comparison of <strong className="text-slate-200">Kronos</strong>{' '}
          (multivariate, OHLCV) and <strong className="text-slate-200">Chronos</strong>{' '}
          (univariate, close-only). Both are foundation models run locally on your
          Mac. <strong className="text-emerald-400">⬆/⬇ agree</strong> means both
          models point the same direction — strongest signal.{' '}
          <strong className="text-amber-400">⚠ split</strong> means they disagree —
          skip the trade. Each model's <code>P10/P90</code> band shows its 80%
          confidence range; <code>hit</code> is its historical direction-accuracy
          from <code>backtest.py</code>.
        </p>
      </div>

      {error && <div className="text-rose-400 text-xs">{error}</div>}

      {!loading && rows.length === 0 && !error && (
        <div className="text-slate-500 text-sm border border-slate-800 rounded p-4 space-y-2">
          <div>No forecasts yet. Run both forecasters:</div>
          <div>
            <code className="text-slate-300">tools/kronos_forecast/run_forecast.command</code>
          </div>
          <div>
            <code className="text-slate-300">tools/chronos_forecast/run_forecast.command</code>
          </div>
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
                <th className="text-right px-3 py-2">Kronos</th>
                <th className="text-right px-3 py-2 hidden md:table-cell">K hit</th>
                <th className="text-right px-3 py-2">Chronos</th>
                <th className="text-right px-3 py-2 hidden md:table-cell">C hit</th>
                <th className="text-right px-3 py-2">Agreement</th>
                <th className="text-right px-3 py-2 hidden lg:table-cell">Horizon</th>
                <th className="text-right px-3 py-2 hidden lg:table-cell">Updated</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => {
                const ref = r.kronos ?? r.chronos!;
                return (
                  <tr
                    key={r.symbol}
                    className="border-t border-slate-800 hover:bg-slate-900/40 cursor-pointer"
                    onClick={() => onSelectSymbol?.(r.symbol)}
                  >
                    <td className="text-left px-3 py-2 font-medium">{r.symbol}</td>
                    <td className="text-right px-3 py-2 tabular-nums">{fmtMoney(ref.current_close)}</td>
                    <td className="text-right px-3 py-2">{renderModelCell(r.kronos)}</td>
                    <td className="text-right px-3 py-2 hidden md:table-cell">{renderHitRate(r.kronos)}</td>
                    <td className="text-right px-3 py-2">{renderModelCell(r.chronos)}</td>
                    <td className="text-right px-3 py-2 hidden md:table-cell">{renderHitRate(r.chronos)}</td>
                    <td className="text-right px-3 py-2 text-sm">{renderAgreement(r)}</td>
                    <td className="text-right px-3 py-2 hidden lg:table-cell text-slate-400 text-xs">
                      {ref.horizon_days}d
                    </td>
                    <td className="text-right px-3 py-2 hidden lg:table-cell text-slate-500 text-xs">
                      {fmtRelTime(ref.generated_at)}
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
