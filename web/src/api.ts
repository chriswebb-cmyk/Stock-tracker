import type { Bar, BarInterval, IngestRun, Ticker } from '../../shared/types';
import type { BacktestResult, SetupStats } from '../../shared/backtest';

const BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8788';

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

export interface BacktestSummary {
  symbols: number;
  trades: number;
  bySetup: SetupStats[];
}

export const api = {
  tickers: () => getJson<Ticker[]>('/tickers'),
  bars: (symbol: string, interval: BarInterval = '1min', limit = 500) =>
    getJson<Bar[]>(`/bars/${encodeURIComponent(symbol)}?interval=${interval}&limit=${limit}`),
  ingestRuns: (limit = 10) => getJson<IngestRun[]>(`/ingest-runs?limit=${limit}`),
  backtestSummary: (days = 7, hold = 30) =>
    getJson<BacktestSummary>(`/backtest-summary?days=${days}&hold=${hold}`),
  backtestSymbol: (symbol: string, days = 7, hold = 30, includeTrades = false) =>
    getJson<BacktestResult>(
      `/backtest/${encodeURIComponent(symbol)}?days=${days}&hold=${hold}${includeTrades ? '&trades=1' : ''}`,
    ),
};
