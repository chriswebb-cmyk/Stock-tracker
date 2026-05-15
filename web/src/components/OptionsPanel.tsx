import { useEffect, useMemo, useState } from 'react';
import { api, type OptionContract, type OptionsChain } from '../api';
import type { Ticker } from '../../../shared/types';

interface Props {
  tickers: Ticker[];
}

function fmtMoney(v: number | null): string {
  if (v === null) return '—';
  return v.toFixed(2);
}

function fmtInt(v: number | null): string {
  if (v === null) return '—';
  return v.toLocaleString();
}

function fmtPct(v: number | null): string {
  if (v === null) return '—';
  return (v * 100).toFixed(1) + '%';
}

function fmtGreek(v: number | null, digits = 2): string {
  if (v === null) return '—';
  return v.toFixed(digits);
}

function fmtExpiration(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function OptionsPanel({ tickers }: Props) {
  // Indices like ^VIX and ^TNX don't have tradeable options on Yahoo's
  // free endpoint — strip them from the dropdown so users don't hit dead
  // ends. Also filter to enabled-only.
  const tradeable = useMemo(
    () => tickers.filter((t) => t.enabled && !t.symbol.startsWith('^')),
    [tickers],
  );

  const [symbol, setSymbol] = useState<string>('');
  const [chain, setChain] = useState<OptionsChain | null>(null);
  const [selectedExpiration, setSelectedExpiration] = useState<number | null>(null);
  const [side, setSide] = useState<'calls' | 'puts'>('calls');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pick a default ticker once tickers load.
  useEffect(() => {
    if (!symbol && tradeable.length > 0) setSymbol(tradeable[0]!.symbol);
  }, [tradeable, symbol]);

  useEffect(() => {
    if (!symbol) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .optionsChain(symbol, selectedExpiration ?? undefined)
      .then((c) => {
        if (cancelled) return;
        setChain(c);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [symbol, selectedExpiration]);

  // Determine ATM strike: the strike closest to the spot price.
  const atmStrike = useMemo(() => {
    if (!chain) return null;
    const all = side === 'calls' ? chain.calls : chain.puts;
    if (all.length === 0) return null;
    let closest = all[0]!;
    for (const c of all) {
      if (Math.abs(c.strike - chain.spot) < Math.abs(closest.strike - chain.spot)) closest = c;
    }
    return closest.strike;
  }, [chain, side]);

  const contracts = chain ? (side === 'calls' ? chain.calls : chain.puts) : [];

  return (
    <div className="p-3 sm:p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <label className="text-xs uppercase tracking-wider text-slate-500">Ticker</label>
          <select
            value={symbol}
            onChange={(e) => {
              setSymbol(e.target.value);
              setSelectedExpiration(null);
            }}
            className="bg-slate-900 border border-slate-800 rounded px-2 py-1 text-sm text-slate-100"
          >
            {tradeable.map((t) => (
              <option key={t.symbol} value={t.symbol}>
                {t.symbol}
              </option>
            ))}
          </select>
        </div>

        {chain && (
          <>
            <div className="flex items-center gap-2">
              <label className="text-xs uppercase tracking-wider text-slate-500">Expiration</label>
              <select
                value={selectedExpiration ?? chain.expiration}
                onChange={(e) => setSelectedExpiration(Number(e.target.value))}
                className="bg-slate-900 border border-slate-800 rounded px-2 py-1 text-sm text-slate-100"
              >
                {chain.availableExpirations.map((ts) => (
                  <option key={ts} value={ts}>
                    {fmtExpiration(ts)}
                  </option>
                ))}
              </select>
            </div>

            <div className="text-xs text-slate-400">
              spot <span className="text-slate-100 font-medium">${chain.spot.toFixed(2)}</span>
              {' · '}
              <span className="text-slate-100">{chain.daysToExpiry.toFixed(1)}</span> days to exp
            </div>
          </>
        )}

        <div className="ml-auto flex gap-1">
          <button
            type="button"
            onClick={() => setSide('calls')}
            className={
              'px-3 py-1 text-xs rounded ' +
              (side === 'calls' ? 'bg-emerald-700 text-white' : 'text-slate-400 hover:bg-slate-800')
            }
          >
            Calls
          </button>
          <button
            type="button"
            onClick={() => setSide('puts')}
            className={
              'px-3 py-1 text-xs rounded ' +
              (side === 'puts' ? 'bg-rose-700 text-white' : 'text-slate-400 hover:bg-slate-800')
            }
          >
            Puts
          </button>
        </div>
      </div>

      {error && <div className="text-rose-400 text-xs">{error}</div>}
      {loading && !chain && <div className="text-slate-500 text-sm">Loading…</div>}

      {chain && (
        <div className="overflow-x-auto border border-slate-800 rounded">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wider text-slate-500 bg-slate-950 sticky top-0">
              <tr>
                <th className="text-right px-2 py-1.5">Strike</th>
                <th className="text-right px-2 py-1.5">Bid</th>
                <th className="text-right px-2 py-1.5">Ask</th>
                <th className="text-right px-2 py-1.5 hidden sm:table-cell">Last</th>
                <th className="text-right px-2 py-1.5">Vol</th>
                <th className="text-right px-2 py-1.5 hidden sm:table-cell">OI</th>
                <th className="text-right px-2 py-1.5">IV</th>
                <th className="text-right px-2 py-1.5">Delta</th>
                <th className="text-right px-2 py-1.5 hidden md:table-cell">Gamma</th>
                <th className="text-right px-2 py-1.5 hidden md:table-cell">Theta</th>
                <th className="text-right px-2 py-1.5 hidden md:table-cell">Vega</th>
              </tr>
            </thead>
            <tbody>
              {contracts.length === 0 && (
                <tr>
                  <td colSpan={11} className="px-3 py-6 text-center text-slate-500 text-sm">
                    No contracts on this side.
                  </td>
                </tr>
              )}
              {contracts.map((c) => (
                <OptionRow
                  key={c.contractSymbol}
                  c={c}
                  atm={c.strike === atmStrike}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="text-xs text-slate-500 pt-2 border-t border-slate-800">
        Data: Yahoo Finance (free, ~15min delayed for some symbols). Greeks computed via
        Black-Scholes using the latest 10-year Treasury yield as the risk-free rate
        (zero dividend assumption). ATM row highlighted; ITM strikes shown in the side's color.
      </div>
    </div>
  );
}

function OptionRow({ c, atm }: { c: OptionContract; atm: boolean }) {
  const rowClass = atm
    ? 'border-t border-slate-800 bg-slate-800/50 font-medium'
    : c.inTheMoney
      ? 'border-t border-slate-800 bg-slate-900/30'
      : 'border-t border-slate-900';
  return (
    <tr className={rowClass}>
      <td className="text-right px-2 py-1 tabular-nums">{c.strike.toFixed(2)}</td>
      <td className="text-right px-2 py-1 tabular-nums">{fmtMoney(c.bid)}</td>
      <td className="text-right px-2 py-1 tabular-nums">{fmtMoney(c.ask)}</td>
      <td className="text-right px-2 py-1 tabular-nums hidden sm:table-cell">{fmtMoney(c.last)}</td>
      <td className="text-right px-2 py-1 tabular-nums">{fmtInt(c.volume)}</td>
      <td className="text-right px-2 py-1 tabular-nums hidden sm:table-cell">{fmtInt(c.openInterest)}</td>
      <td className="text-right px-2 py-1 tabular-nums">{fmtPct(c.impliedVolatility)}</td>
      <td className="text-right px-2 py-1 tabular-nums">{fmtGreek(c.delta, 3)}</td>
      <td className="text-right px-2 py-1 tabular-nums hidden md:table-cell">{fmtGreek(c.gamma, 4)}</td>
      <td className="text-right px-2 py-1 tabular-nums hidden md:table-cell">{fmtGreek(c.theta, 3)}</td>
      <td className="text-right px-2 py-1 tabular-nums hidden md:table-cell">{fmtGreek(c.vega, 3)}</td>
    </tr>
  );
}
