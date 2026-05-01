import type { Bar, BarInterval, IngestRun, Ticker } from '../../shared/types';

const BASE = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8788';

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) {
    const text = await res.text();
    let message = text;
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === 'string') message = parsed.error;
    } catch {
      // body wasn't JSON; fall through with the raw text
    }
    throw new Error(`API ${res.status}: ${message || res.statusText}`);
  }
  return (await res.json()) as T;
}

export const api = {
  tickers: () => getJson<Ticker[]>('/tickers'),
  bars: (symbol: string, interval: BarInterval = '1min', limit = 500) =>
    getJson<Bar[]>(`/bars/${encodeURIComponent(symbol)}?interval=${interval}&limit=${limit}`),
  ingestRuns: (limit = 10) => getJson<IngestRun[]>(`/ingest-runs?limit=${limit}`),
};
