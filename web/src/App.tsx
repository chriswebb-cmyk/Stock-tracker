import { useEffect, useState } from 'react';
import { api, type SignalRow } from './api';
import type { Bar, BarInterval, IngestRun, Ticker } from '../../shared/types';
import { Watchlist } from './components/Watchlist';
import { PriceChart } from './components/PriceChart';
import { IndicatorPanel } from './components/IndicatorPanel';
import { StatusBar } from './components/StatusBar';
import { BacktestPanel } from './components/BacktestPanel';
import { MlPanel } from './components/MlPanel';

const INTERVALS: BarInterval[] = ['1min', '5min', '15min', '60min'];

type Tab = 'chart' | 'backtest' | 'ml';

export default function App() {
  const [tickers, setTickers] = useState<Ticker[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [interval, setInterval_] = useState<BarInterval>('1min');
  const [bars, setBars] = useState<Bar[]>([]);
  const [signals, setSignals] = useState<SignalRow[]>([]);
  const [latestRun, setLatestRun] = useState<IngestRun | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('chart');

  useEffect(() => {
    api
      .tickers()
      .then((ts) => {
        setTickers(ts);
        if (ts.length > 0 && !selected) setSelected(ts[0]?.symbol ?? null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selected || tab !== 'chart') return;
    let cancelled = false;
    const load = async () => {
      try {
        const [data, sigs] = await Promise.all([
          api.bars(selected, interval, 500),
          api.signalsForSymbol(selected, 7).catch(() => [] as SignalRow[]),
        ]);
        if (!cancelled) {
          setBars(data);
          setSignals(sigs);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      }
    };
    load();
    const id = window.setInterval(load, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [selected, interval, tab]);

  useEffect(() => {
    const load = () => api.ingestRuns(1).then((rs) => setLatestRun(rs[0] ?? null)).catch(() => {});
    load();
    const id = window.setInterval(load, 60_000);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="h-full flex flex-col">
      <header className="flex items-center justify-between border-b border-slate-800 px-4 py-2">
        <div className="flex items-baseline gap-3">
          <h1 className="text-lg font-semibold tracking-tight">Stock Tracker</h1>
          <span className="text-xs text-slate-500">Phase 2 · indicators + backtest</span>
        </div>
        <StatusBar latest={latestRun} />
      </header>

      {error && (
        <div className="bg-rose-950 text-rose-200 text-xs px-4 py-2 border-b border-rose-900">
          {error}
        </div>
      )}

      <div className="flex border-b border-slate-800 px-4">
        {(['chart', 'backtest', 'ml'] as Tab[]).map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={
              'px-3 py-2 text-xs uppercase tracking-wider ' +
              (tab === t
                ? 'text-white border-b-2 border-emerald-500'
                : 'text-slate-500 hover:text-slate-300')
            }
          >
            {t}
          </button>
        ))}
      </div>

      {tab === 'ml' ? (
        <div className="flex-1 overflow-y-auto">
          <MlPanel />
        </div>
      ) : tab === 'chart' ? (
        <div className="flex-1 grid grid-cols-[220px_1fr] min-h-0">
          <aside className="border-r border-slate-800 overflow-y-auto">
            <div className="px-4 py-3 text-xs uppercase tracking-wider text-slate-500">
              Watchlist
            </div>
            <Watchlist tickers={tickers} selected={selected} onSelect={setSelected} />
          </aside>

          <main className="flex flex-col min-h-0">
            <div className="flex items-center justify-between border-b border-slate-800 px-4 py-2">
              <div className="text-base font-medium">{selected ?? '—'}</div>
              <div className="flex gap-1">
                {INTERVALS.map((iv) => (
                  <button
                    key={iv}
                    type="button"
                    onClick={() => setInterval_(iv)}
                    className={
                      'px-2 py-1 text-xs rounded ' +
                      (iv === interval
                        ? 'bg-slate-700 text-white'
                        : 'text-slate-400 hover:bg-slate-800')
                    }
                  >
                    {iv}
                  </button>
                ))}
              </div>
            </div>

            <IndicatorPanel bars={bars} />

            <div className="flex-1 min-h-0">
              <PriceChart bars={bars} signals={signals} />
            </div>
          </main>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          <BacktestPanel />
        </div>
      )}
    </div>
  );
}
