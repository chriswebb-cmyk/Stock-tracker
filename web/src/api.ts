import type {
  Bar,
  BarInterval,
  IngestRun,
  RedditDiamond,
  RedditPost,
  RedditTrending,
  Ticker,
} from '../../shared/types';
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
  cachedAt?: number | null;
  stale?: boolean;
}

export interface ModelRow {
  setup: string;
  trained_at: number;
  sample_count: number;
  train_accuracy: number;
  val_accuracy: number;
  train_baseline: number;
}

export interface SignalRow {
  id: number;
  symbol: string;
  ts: number;
  setup: string;
  direction: 'long' | 'short';
  ml_probability: number | null;
  features_json: string | null;
  contract_pick: string | null;
  notes: string | null;
}

export interface TrainResult {
  perSetup: Array<{ setup: string; samples: number; trainAcc: number; valAcc: number; baseline: number }>;
  symbols: number;
  trades: number;
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
  models: () => getJson<ModelRow[]>('/ml/models'),
  signals: (limit = 50) => getJson<SignalRow[]>(`/signals?limit=${limit}`),
  signalsForSymbol: (symbol: string, days = 7) =>
    getJson<SignalRow[]>(`/signals/by-symbol/${encodeURIComponent(symbol)}?days=${days}`),
  trainModels: async (days = 7, hold = 30) => {
    const res = await fetch(`${BASE}/ml/train?days=${days}&hold=${hold}`);
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
    return (await res.json()) as TrainResult;
  },
  redditTrending: (window = '24h', limit = 30) =>
    getJson<RedditTrending[]>(`/reddit/trending?window=${window}&limit=${limit}`),
  redditDiamonds: (recent = '6h', baseline = '7d', limit = 20) =>
    getJson<RedditDiamond[]>(
      `/reddit/diamonds?recent=${recent}&baseline=${baseline}&limit=${limit}`,
    ),
  redditPosts: (symbol: string | null, limit = 25) =>
    getJson<RedditPost[]>(
      symbol
        ? `/reddit/posts?symbol=${encodeURIComponent(symbol)}&limit=${limit}`
        : `/reddit/posts?limit=${limit}`,
    ),
};
