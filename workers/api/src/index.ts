import type {
  Bar,
  BarInterval,
  Ticker,
  IngestRun,
  RedditDiamond,
  RedditPost,
  RedditTrending,
} from '../../../shared/types';
import { backtest, combineResults, type BacktestResult, type SetupStats } from '../../../shared/backtest';
import { modelFromJson, predict, trainLogReg, modelToJson, type Model, type ModelStats } from '../../../shared/ml';
import { FEATURE_NAMES, featuresToVector } from '../../../shared/features';
import type { SetupName } from '../../../shared/setups';
import { buildMetaVector } from '../../../shared/meta';

export interface Env {
  DB: D1Database;
  // Comma-separated list of allowed origins for CORS. Defaults to '*' for
  // dev convenience; set this in production.
  ALLOWED_ORIGINS?: string;
  // Service binding to the reddit scraper worker (defined in wrangler.toml).
  // /reddit/scrape proxies to it so the dashboard can trigger a scrape.
  REDDIT?: Fetcher;
  // Finnhub API key. Used for company news (/news/:symbol). When unset,
  // /news returns 503; the dashboard handles that gracefully.
  FINNHUB_API_KEY?: string;
}

const VALID_INTERVALS: BarInterval[] = ['1min', '5min', '15min', '30min', '60min'];

export default {
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(refreshCaches(env, event.cron));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin');
    const cors = corsHeaders(origin, env.ALLOWED_ORIGINS);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      const json = await route(url, request, env);
      return new Response(JSON.stringify(json), {
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      const message = err instanceof Error ? err.message : 'internal error';
      return new Response(JSON.stringify({ error: message }), {
        status,
        headers: { 'Content-Type': 'application/json', ...cors },
      });
    }
  },
};

async function route(url: URL, request: Request, env: Env): Promise<unknown> {
  const path = url.pathname;

  if (path === '/health') {
    return { ok: true, ts: Math.floor(Date.now() / 1000) };
  }

  if (path === '/tickers' && request.method === 'GET') {
    return getTickers(env.DB);
  }

  // /bars/:symbol?interval=1min&limit=500
  const barsMatch = path.match(/^\/bars\/([A-Za-z.\-]+)$/);
  if (barsMatch && request.method === 'GET') {
    const symbol = barsMatch[1].toUpperCase();
    const interval = (url.searchParams.get('interval') ?? '1min') as BarInterval;
    if (!VALID_INTERVALS.includes(interval)) {
      throw new HttpError(400, `invalid interval; must be one of ${VALID_INTERVALS.join(', ')}`);
    }
    const limit = clampInt(url.searchParams.get('limit'), 1, 5000, 500);
    return interval === '1min'
      ? getBars(env.DB, symbol, '1min', limit)
      : getAggregatedBars(env.DB, symbol, interval, limit);
  }

  // /options/:symbol?expiration=YYYY-MM-DD
  const optsMatch = path.match(/^\/options\/([A-Za-z.\-]+)$/);
  if (optsMatch && request.method === 'GET') {
    const symbol = optsMatch[1].toUpperCase();
    const expiration = url.searchParams.get('expiration');
    return getLatestOptions(env.DB, symbol, expiration);
  }

  if (path === '/ingest-runs' && request.method === 'GET') {
    const limit = clampInt(url.searchParams.get('limit'), 1, 100, 20);
    return getIngestRuns(env.DB, limit);
  }

  if (path === '/signals' && request.method === 'GET') {
    const limit = clampInt(url.searchParams.get('limit'), 1, 200, 50);
    return getSignals(env.DB, limit);
  }

  // /signals/by-symbol/:symbol?days=N
  const sigSymMatch = path.match(/^\/signals\/by-symbol\/([A-Za-z.\-]+)$/);
  if (sigSymMatch && request.method === 'GET') {
    const symbol = sigSymMatch[1].toUpperCase();
    const days = clampInt(url.searchParams.get('days'), 1, 30, 7);
    return getSignalsForSymbol(env.DB, symbol, days);
  }

  // /backtest/:symbol?days=7&hold=30&cooldown=1800
  const btMatch = path.match(/^\/backtest\/([A-Za-z.\-]+)$/);
  if (btMatch && request.method === 'GET') {
    const symbol = btMatch[1].toUpperCase();
    const days = clampInt(url.searchParams.get('days'), 1, 30, 7);
    const hold = clampInt(url.searchParams.get('hold'), 1, 240, 30);
    const cooldown = clampInt(url.searchParams.get('cooldown'), 0, 86400, 1800);
    const includeTrades = url.searchParams.get('trades') === '1';
    const result = await runBacktest(env.DB, symbol, days, hold, cooldown);
    return includeTrades ? result : { ...result, trades: [] };
  }

  // /ml/train?days=7&hold=30 — runs backtest, trains per-setup logreg, persists.
  if (path === '/ml/train' && (request.method === 'POST' || request.method === 'GET')) {
    const days = clampInt(url.searchParams.get('days'), 1, 30, 7);
    const hold = clampInt(url.searchParams.get('hold'), 1, 240, 30);
    const cooldown = clampInt(url.searchParams.get('cooldown'), 0, 86400, 1800);
    return trainModels(env.DB, days, hold, cooldown);
  }

  if (path === '/ml/models' && request.method === 'GET') {
    return getModels(env.DB);
  }

  // /backtest-summary?days=7&hold=30 — aggregated across all enabled tickers.
  // Cached in D1 because the full sweep blows the free-tier 10ms CPU budget.
  // Pass &refresh=1 to bypass cache (may 503 on free tier).
  if (path === '/backtest-summary' && request.method === 'GET') {
    const days = clampInt(url.searchParams.get('days'), 1, 30, 7);
    const hold = clampInt(url.searchParams.get('hold'), 1, 240, 30);
    const cooldown = clampInt(url.searchParams.get('cooldown'), 0, 86400, 1800);
    const refresh = url.searchParams.get('refresh') === '1';
    return getCachedBacktestSummary(env.DB, days, hold, cooldown, refresh);
  }

  // Reddit endpoints. The scraper worker writes reddit_posts +
  // reddit_mentions; these are pure reads.
  if (path === '/reddit/trending' && request.method === 'GET') {
    const window = parseWindow(url.searchParams.get('window'), 24 * 3600);
    const limit = clampInt(url.searchParams.get('limit'), 1, 200, 30);
    const subreddit = url.searchParams.get('subreddit');
    return getRedditTrending(env.DB, window, limit, subreddit);
  }
  if (path === '/reddit/diamonds' && request.method === 'GET') {
    const recent = parseWindow(url.searchParams.get('recent'), 6 * 3600);
    const baseline = parseWindow(url.searchParams.get('baseline'), 7 * 86400);
    const limit = clampInt(url.searchParams.get('limit'), 1, 100, 20);
    const subreddit = url.searchParams.get('subreddit');
    return getRedditDiamonds(env.DB, recent, baseline, limit, subreddit);
  }
  const postsMatch = path.match(/^\/reddit\/posts\/?$/);
  if (postsMatch && request.method === 'GET') {
    const symbol = url.searchParams.get('symbol');
    const limit = clampInt(url.searchParams.get('limit'), 1, 100, 25);
    const subreddit = url.searchParams.get('subreddit');
    return getRedditPosts(env.DB, symbol, limit, subreddit);
  }

  // Company news for a symbol via Finnhub.
  const newsMatch = path.match(/^\/news\/([A-Za-z.^\-]+)$/);
  if (newsMatch && request.method === 'GET') {
    const symbol = newsMatch[1]!.toUpperCase();
    const limit = clampInt(url.searchParams.get('limit'), 1, 50, 20);
    return getCompanyNews(env, symbol, limit);
  }

  // Options chain for a symbol — nearest expiration by default. Yahoo's
  // free options endpoint with Black-Scholes greeks computed in-worker.
  const optionsMatch2 = path.match(/^\/options-chain\/([A-Za-z.\-]+)$/);
  if (optionsMatch2 && request.method === 'GET') {
    const symbol = optionsMatch2[1]!.toUpperCase();
    const expiration = url.searchParams.get('expiration');
    return getOptionsChain(env, symbol, expiration ? Number(expiration) : null);
  }

  // Triggers an on-demand scrape on the reddit worker via the service
  // binding. The reddit worker doesn't ship CORS headers, so the dashboard
  // hits this proxy instead.
  if (path === '/reddit/scrape' && (request.method === 'POST' || request.method === 'GET')) {
    if (!env.REDDIT) {
      throw new HttpError(503, 'reddit service binding not configured');
    }
    const upstream = await env.REDDIT.fetch('https://reddit.internal/run');
    if (!upstream.ok) {
      throw new HttpError(upstream.status, `reddit worker ${upstream.status}`);
    }
    return upstream.json();
  }

  throw new HttpError(404, 'not found');
}

function parseWindow(raw: string | null, fallbackSeconds: number): number {
  // Accepts plain integers (seconds) or shorthand like '24h' / '7d' / '30m'.
  if (!raw) return fallbackSeconds;
  const m = raw.match(/^(\d+)([smhd])?$/);
  if (!m) return fallbackSeconds;
  const n = parseInt(m[1] ?? '', 10);
  if (!Number.isFinite(n)) return fallbackSeconds;
  const unit = m[2] ?? 's';
  const mul = unit === 'd' ? 86400 : unit === 'h' ? 3600 : unit === 'm' ? 60 : 1;
  return Math.min(30 * 86400, Math.max(60, n * mul));
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function clampInt(raw: string | null, min: number, max: number, fallback: number): number {
  if (raw === null) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function corsHeaders(origin: string | null, allowed: string | undefined): Record<string, string> {
  const list = (allowed ?? '*').split(',').map((s) => s.trim());
  const allow = list.includes('*')
    ? '*'
    : origin && list.includes(origin)
      ? origin
      : list[0] ?? '*';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

async function getTickers(db: D1Database): Promise<Ticker[]> {
  const { results } = await db
    .prepare('SELECT symbol, enabled, added_at FROM tickers ORDER BY symbol')
    .all<{ symbol: string; enabled: number; added_at: number }>();
  return results.map((r) => ({
    symbol: r.symbol,
    enabled: r.enabled === 1,
    addedAt: r.added_at,
  }));
}

async function getBars(
  db: D1Database,
  symbol: string,
  interval: BarInterval,
  limit: number,
): Promise<Bar[]> {
  const { results } = await db
    .prepare(
      `SELECT symbol, interval, ts, open, high, low, close, volume
       FROM bars
       WHERE symbol = ? AND interval = ?
       ORDER BY ts DESC
       LIMIT ?`,
    )
    .bind(symbol, interval, limit)
    .all<Bar>();
  // Return ascending so charts render left-to-right by time.
  return results.reverse();
}

const INTERVAL_SECONDS: Record<BarInterval, number> = {
  '1min': 60,
  '5min': 300,
  '15min': 900,
  '30min': 1800,
  '60min': 3600,
};

// Roll the stored 1min bars up into the requested interval. Cheaper than
// storing every interval separately (the ingest worker only writes 1min)
// and instant — D1 read + in-memory aggregation, no extra fetches.
async function getAggregatedBars(
  db: D1Database,
  symbol: string,
  interval: BarInterval,
  limit: number,
): Promise<Bar[]> {
  const bucketSec = INTERVAL_SECONDS[interval];
  // Pull enough 1min bars to fill `limit` aggregated bars, capped at 5000
  // for safety. e.g. limit=500 5min bars -> need 2500 1min bars.
  const oneMinLimit = Math.min(5000, limit * (bucketSec / 60));
  const ones = await getBars(db, symbol, '1min', oneMinLimit);
  if (ones.length === 0) return [];

  // ones is ascending; bucket by floor(ts/bucketSec) and fold OHLC.
  const buckets = new Map<number, Bar>();
  for (const b of ones) {
    const bucketTs = Math.floor(b.ts / bucketSec) * bucketSec;
    const existing = buckets.get(bucketTs);
    if (!existing) {
      buckets.set(bucketTs, {
        symbol: b.symbol,
        interval,
        ts: bucketTs,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
      });
    } else {
      existing.high = Math.max(existing.high, b.high);
      existing.low = Math.min(existing.low, b.low);
      existing.close = b.close; // last close wins (ones is sorted ascending)
      existing.volume += b.volume;
    }
  }
  return Array.from(buckets.values())
    .sort((a, b) => a.ts - b.ts)
    .slice(-limit);
}

async function getLatestOptions(
  db: D1Database,
  underlying: string,
  expiration: string | null,
): Promise<unknown[]> {
  // Pull the most recent fetched_at, then return all contracts in that batch.
  const latest = await db
    .prepare(
      `SELECT MAX(fetched_at) AS fetched_at FROM options_snapshots WHERE underlying = ?`,
    )
    .bind(underlying)
    .first<{ fetched_at: number | null }>();
  if (!latest?.fetched_at) return [];

  const sql = expiration
    ? `SELECT * FROM options_snapshots
       WHERE underlying = ? AND fetched_at = ? AND expiration = ?
       ORDER BY type, strike`
    : `SELECT * FROM options_snapshots
       WHERE underlying = ? AND fetched_at = ?
       ORDER BY expiration, type, strike`;

  const stmt = expiration
    ? db.prepare(sql).bind(underlying, latest.fetched_at, expiration)
    : db.prepare(sql).bind(underlying, latest.fetched_at);

  const { results } = await stmt.all();
  return results;
}

async function getIngestRuns(db: D1Database, limit: number): Promise<IngestRun[]> {
  const { results } = await db
    .prepare(
      `SELECT id, started_at, finished_at, symbols, api_calls, errors, error_text
       FROM ingest_runs
       ORDER BY id DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all<{
      id: number;
      started_at: number;
      finished_at: number | null;
      symbols: number;
      api_calls: number;
      errors: number;
      error_text: string | null;
    }>();
  return results.map((r) => ({
    id: r.id,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    symbols: r.symbols,
    apiCalls: r.api_calls,
    errors: r.errors,
    errorText: r.error_text,
  }));
}

async function loadBarsSince(
  db: D1Database,
  symbol: string,
  interval: BarInterval,
  sinceTs: number,
): Promise<Bar[]> {
  const { results } = await db
    .prepare(
      `SELECT symbol, interval, ts, open, high, low, close, volume
         FROM bars
        WHERE symbol = ? AND interval = ? AND ts >= ?
        ORDER BY ts ASC`,
    )
    .bind(symbol, interval, sinceTs)
    .all<Bar>();
  return results;
}

async function runBacktest(
  db: D1Database,
  symbol: string,
  days: number,
  holdMinutes: number,
  cooldownSec: number,
): Promise<BacktestResult> {
  const sinceTs = Math.floor(Date.now() / 1000) - days * 86400;
  const bars = await loadBarsSince(db, symbol, '1min', sinceTs);
  return backtest(symbol, bars, holdMinutes, cooldownSec);
}

// Cron entry point. Branches on the schedule that fired so the daily
// after-close trigger doesn't re-run the expensive ML retrain.
async function refreshCaches(env: Env, cron: string): Promise<void> {
  const isWeeklyRetrain = cron === '0 6 * * SUN';
  if (isWeeklyRetrain) {
    try {
      await trainModels(env.DB, 7, 30, 1800);
    } catch (err) {
      console.error('weekly retrain failed', err);
    }
  }
  // Refresh the cached backtest summaries the dashboard reads. We always
  // refresh both windows so each daily run keeps the '1d' tab fresh and the
  // weekly run keeps the '7d' tab fresh; the cost is one extra sweep.
  for (const days of [1, 7] as const) {
    try {
      const summary = await getBacktestSummary(env.DB, days, 30, 1800);
      await writeCache(env.DB, `backtest-summary-${days}-30-1800`, JSON.stringify(summary));
    } catch (err) {
      console.error(`backtest cache refresh failed (days=${days})`, err);
    }
  }
}

async function getCachedBacktestSummary(
  db: D1Database,
  days: number,
  holdMinutes: number,
  cooldownSec: number,
  refresh: boolean,
): Promise<{ symbols: number; trades: number; bySetup: SetupStats[]; cachedAt: number | null; stale: boolean }> {
  const key = `backtest-summary-${days}-${holdMinutes}-${cooldownSec}`;
  if (!refresh) {
    const row = await db
      .prepare('SELECT value, updated_at FROM json_cache WHERE key = ?')
      .bind(key)
      .first<{ value: string; updated_at: number }>();
    if (row) {
      const ageHours = (Math.floor(Date.now() / 1000) - row.updated_at) / 3600;
      const parsed = JSON.parse(row.value) as { symbols: number; trades: number; bySetup: SetupStats[] };
      return { ...parsed, cachedAt: row.updated_at, stale: ageHours > 24 };
    }
  }
  const fresh = await getBacktestSummary(db, days, holdMinutes, cooldownSec);
  await writeCache(db, key, JSON.stringify(fresh));
  return { ...fresh, cachedAt: Math.floor(Date.now() / 1000), stale: false };
}

interface NewsItem {
  id: number;
  headline: string;
  summary: string;
  source: string;
  url: string;
  datetime: number;
  image?: string;
}

// Fetch company news for a symbol. 30-minute cache in json_cache so a
// page refresh hitting 47 tickers doesn't blow Finnhub's free-tier
// 60 req/min budget.
async function getCompanyNews(env: Env, symbol: string, limit: number): Promise<NewsItem[]> {
  if (!env.FINNHUB_API_KEY) {
    throw new HttpError(503, 'FINNHUB_API_KEY not configured on api worker');
  }
  const key = `news-${symbol}`;
  const now = Math.floor(Date.now() / 1000);
  try {
    const row = await env.DB
      .prepare('SELECT value, updated_at FROM json_cache WHERE key = ?')
      .bind(key)
      .first<{ value: string; updated_at: number }>();
    if (row && now - row.updated_at < 30 * 60) {
      return (JSON.parse(row.value) as NewsItem[]).slice(0, limit);
    }
  } catch {
    // Cache lookup failure shouldn't break the request; fall through to live fetch.
  }
  // Finnhub /company-news returns recent news with sentiment; we trim
  // payload to fields the dashboard renders.
  const to = new Date(now * 1000).toISOString().slice(0, 10);
  const from = new Date((now - 7 * 86400) * 1000).toISOString().slice(0, 10);
  // ^VIX / ^TNX aren't tradeable equities; Finnhub returns 404. Strip the
  // caret so we get the index proxy news (e.g. ^VIX -> VIX).
  const finnhubSym = symbol.replace(/^\^/, '');
  const u = `https://finnhub.io/api/v1/company-news?symbol=${encodeURIComponent(finnhubSym)}&from=${from}&to=${to}&token=${env.FINNHUB_API_KEY}`;
  let news: NewsItem[] = [];
  try {
    const res = await fetch(u, { signal: AbortSignal.timeout(8_000) });
    if (res.ok) {
      const raw = (await res.json()) as Array<{
        id: number; headline: string; summary: string; source: string;
        url: string; datetime: number; image?: string;
      }>;
      news = raw.map((n) => ({
        id: n.id,
        headline: n.headline,
        summary: n.summary,
        source: n.source,
        url: n.url,
        datetime: n.datetime,
        image: n.image,
      }));
    }
  } catch {
    // Upstream failures fall through to returning an empty cache write so
    // we don't hammer Finnhub on repeated failures.
  }
  try {
    await env.DB
      .prepare(
        `INSERT INTO json_cache(key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      )
      .bind(key, JSON.stringify(news), now)
      .run();
  } catch {
    // Best-effort cache write.
  }
  return news.slice(0, limit);
}

async function writeCache(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO json_cache(key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(key, value, Math.floor(Date.now() / 1000))
    .run();
}

async function getBacktestSummary(
  db: D1Database,
  days: number,
  holdMinutes: number,
  cooldownSec: number,
): Promise<{ symbols: number; trades: number; bySetup: SetupStats[] }> {
  const tickers = await db
    .prepare('SELECT symbol FROM tickers WHERE enabled = 1 ORDER BY symbol')
    .all<{ symbol: string }>();
  const sinceTs = Math.floor(Date.now() / 1000) - days * 86400;
  const symbolBars = await Promise.all(
    tickers.results.map(async ({ symbol }) => ({
      symbol,
      bars: await loadBarsSince(db, symbol, '1min', sinceTs),
    })),
  );
  const results: BacktestResult[] = [];
  for (const { symbol, bars } of symbolBars) {
    if (bars.length < 30) continue;
    results.push(backtest(symbol, bars, holdMinutes, cooldownSec));
  }
  const totalTrades = results.reduce((sum, r) => sum + r.trades.length, 0);
  return {
    symbols: results.length,
    trades: totalTrades,
    bySetup: combineResults(results),
  };
}

// Hold periods (minutes) the trainer produces models for. Each horizon
// gets its own per-setup models and meta-ensemble — outcomes at 15m vs
// 60m can differ wildly, so single-horizon training was leaving signal
// on the table. The first entry is used as the "primary" hold reported
// in the legacy response shape.
const TRAIN_HOLDS_MINUTES = [15, 30, 60, 120] as const;

async function trainModels(
  db: D1Database,
  days: number,
  primaryHoldMinutes: number,
  cooldownSec: number,
): Promise<{
  perSetup: Array<{ setup: SetupName; samples: number; trainAcc: number; valAcc: number; baseline: number }>;
  meta: { samples: number; trainAcc: number; valAcc: number; baseline: number } | null;
  byHold: Array<{
    holdMinutes: number;
    perSetup: Array<{ setup: SetupName; samples: number; trainAcc: number; valAcc: number; baseline: number }>;
    meta: { samples: number; trainAcc: number; valAcc: number; baseline: number } | null;
    trades: number;
  }>;
  symbols: number;
  trades: number;
}> {
  const tickers = await db
    .prepare('SELECT symbol FROM tickers WHERE enabled = 1 ORDER BY symbol')
    .all<{ symbol: string }>();
  const sinceTs = Math.floor(Date.now() / 1000) - days * 86400;
  const symbolBars = await Promise.all(
    tickers.results.map(async ({ symbol }) => ({
      symbol,
      bars: await loadBarsSince(db, symbol, '1min', sinceTs),
    })),
  );

  // Holds we train at — union of the requested primary hold and the
  // standard set, deduped.
  const holds = Array.from(new Set([primaryHoldMinutes, ...TRAIN_HOLDS_MINUTES])).sort((a, b) => a - b);
  const trainedAt = Math.floor(Date.now() / 1000);

  const byHold: Array<{
    holdMinutes: number;
    perSetup: Array<{ setup: SetupName; samples: number; trainAcc: number; valAcc: number; baseline: number }>;
    meta: { samples: number; trainAcc: number; valAcc: number; baseline: number } | null;
    trades: number;
  }> = [];

  let symbolsUsedMax = 0;
  let primaryPerSetup: Array<{ setup: SetupName; samples: number; trainAcc: number; valAcc: number; baseline: number }> = [];
  let primaryMeta: { samples: number; trainAcc: number; valAcc: number; baseline: number } | null = null;
  let primaryTrades = 0;

  for (const hold of holds) {
    interface TradeRow {
      setup: SetupName;
      direction: 'long' | 'short';
      features: number[];
      won: number;
    }
    const allTrades: TradeRow[] = [];
    let symbolsUsed = 0;
    for (const { bars } of symbolBars) {
      if (bars.length < 30) continue;
      symbolsUsed += 1;
      const result = backtest('-', bars, hold, cooldownSec);
      for (const t of result.trades) {
        allTrades.push({
          setup: t.setup,
          direction: t.direction,
          features: featuresToVector(t.features),
          won: t.pnlPct > 0 ? 1 : 0,
        });
      }
    }
    symbolsUsedMax = Math.max(symbolsUsedMax, symbolsUsed);

    const bySetup = new Map<SetupName, { X: number[][]; y: number[] }>();
    for (const t of allTrades) {
      const bucket = bySetup.get(t.setup) ?? { X: [], y: [] };
      bucket.X.push(t.features);
      bucket.y.push(t.won);
      bySetup.set(t.setup, bucket);
    }

    const perSetup: typeof primaryPerSetup = [];
    const trainedPerSetupModels = new Map<SetupName, Model>();

    for (const [setup, { X, y }] of bySetup) {
      if (X.length < 30) continue;
      const trained = trainLogReg(X, y);
      const stats: ModelStats = trained.stats;
      const model: Model = {
        setup,
        featureNames: FEATURE_NAMES,
        means: trained.means,
        stds: trained.stds,
        weights: trained.weights,
        bias: trained.bias,
        trainedAt,
        stats,
        calibA: trained.calibA,
        calibB: trained.calibB,
      };
      trainedPerSetupModels.set(setup, model);
      const json = modelToJson(model);
      await db
        .prepare(
          `INSERT INTO models(setup, hold_minutes, trained_at, sample_count,
                              train_accuracy, val_accuracy, train_baseline,
                              weights_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(setup, hold_minutes) DO UPDATE SET
             trained_at = excluded.trained_at,
             sample_count = excluded.sample_count,
             train_accuracy = excluded.train_accuracy,
             val_accuracy = excluded.val_accuracy,
             train_baseline = excluded.train_baseline,
             weights_json = excluded.weights_json`,
        )
        .bind(setup, hold, trainedAt, stats.sampleCount, stats.trainAccuracy, stats.valAccuracy, stats.trainBaseline, json)
        .run();
      perSetup.push({
        setup,
        samples: stats.sampleCount,
        trainAcc: stats.trainAccuracy,
        valAcc: stats.valAccuracy,
        baseline: stats.trainBaseline,
      });
    }

    // Meta ensemble for this horizon.
    const metaX: number[][] = [];
    const metaY: number[] = [];
    for (const t of allTrades) {
      const model = trainedPerSetupModels.get(t.setup);
      if (!model) continue;
      const setupProb = predict(model, t.features);
      metaX.push(buildMetaVector(setupProb, t.setup, t.direction, t.features));
      metaY.push(t.won);
    }
    let meta: { samples: number; trainAcc: number; valAcc: number; baseline: number } | null = null;
    if (metaX.length >= 50) {
      const trained = trainLogReg(metaX, metaY);
      const stats = trained.stats;
      const json = modelToJson({
        setup: '__meta__' as SetupName,
        featureNames: FEATURE_NAMES,
        means: trained.means,
        stds: trained.stds,
        weights: trained.weights,
        bias: trained.bias,
        trainedAt,
        stats,
        calibA: trained.calibA,
        calibB: trained.calibB,
      });
      await db
        .prepare(
          `INSERT INTO meta_model(hold_minutes, trained_at, sample_count,
                                  train_accuracy, val_accuracy, train_baseline,
                                  weights_json)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(hold_minutes) DO UPDATE SET
             trained_at = excluded.trained_at,
             sample_count = excluded.sample_count,
             train_accuracy = excluded.train_accuracy,
             val_accuracy = excluded.val_accuracy,
             train_baseline = excluded.train_baseline,
             weights_json = excluded.weights_json`,
        )
        .bind(hold, trainedAt, stats.sampleCount, stats.trainAccuracy, stats.valAccuracy, stats.trainBaseline, json)
        .run();
      meta = {
        samples: stats.sampleCount,
        trainAcc: stats.trainAccuracy,
        valAcc: stats.valAccuracy,
        baseline: stats.trainBaseline,
      };
    }

    perSetup.sort((a, b) => a.setup.localeCompare(b.setup));
    byHold.push({ holdMinutes: hold, perSetup, meta, trades: allTrades.length });
    if (hold === primaryHoldMinutes) {
      primaryPerSetup = perSetup;
      primaryMeta = meta;
      primaryTrades = allTrades.length;
    }
  }

  return {
    perSetup: primaryPerSetup,
    meta: primaryMeta,
    byHold,
    symbols: symbolsUsedMax,
    trades: primaryTrades,
  };
}

async function getModels(db: D1Database): Promise<unknown> {
  const perSetup = await db
    .prepare(
      `SELECT setup, hold_minutes, trained_at, sample_count, train_accuracy,
              val_accuracy, train_baseline
         FROM models
        ORDER BY hold_minutes, setup`,
    )
    .all();
  const meta = await db
    .prepare(
      `SELECT hold_minutes, trained_at, sample_count, train_accuracy,
              val_accuracy, train_baseline
         FROM meta_model
        ORDER BY hold_minutes`,
    )
    .all();
  return { perSetup: perSetup.results, meta: meta.results };
}

async function getSignalsForSymbol(db: D1Database, symbol: string, days: number): Promise<unknown[]> {
  const sinceTs = Math.floor(Date.now() / 1000) - days * 86400;
  const { results } = await db
    .prepare(
      `SELECT id, symbol, ts, setup, direction, ml_probability, notes
         FROM signals
        WHERE symbol = ? AND ts >= ?
        ORDER BY ts ASC`,
    )
    .bind(symbol, sinceTs)
    .all();
  return results;
}

async function getSignals(db: D1Database, limit: number): Promise<unknown[]> {
  const { results } = await db
    .prepare(
      `SELECT id, symbol, ts, setup, direction, ml_probability,
              features_json, contract_pick, notes
       FROM signals
       ORDER BY ts DESC
       LIMIT ?`,
    )
    .bind(limit)
    .all();
  return results;
}

interface TrendingRow {
  symbol: string;
  posts: number;
  mentions: number;
  net_sentiment: number;
  total_score: number;
  top_post_id: string | null;
  top_post_title: string | null;
}

async function getRedditTrending(
  db: D1Database,
  windowSeconds: number,
  limit: number,
  subreddit: string | null,
): Promise<RedditTrending[]> {
  const since = Math.floor(Date.now() / 1000) - windowSeconds;
  // For each symbol in the window, take the highest-scoring post as the
  // 'top post' surface. Done with a correlated subquery for portability —
  // D1's SQLite supports it cleanly.
  const sql = `
    SELECT m.symbol                                             AS symbol,
           COUNT(DISTINCT p.id)                                 AS posts,
           SUM(m.mention_count)                                 AS mentions,
           AVG(m.sentiment)                                     AS net_sentiment,
           SUM(p.score)                                         AS total_score,
           (SELECT p2.id    FROM reddit_mentions m2
              JOIN reddit_posts p2 ON p2.id = m2.post_id
             WHERE m2.symbol = m.symbol
               AND p2.created_utc >= ?1
               ${subreddit ? 'AND p2.subreddit = ?4' : ''}
             ORDER BY p2.score DESC LIMIT 1)                    AS top_post_id,
           (SELECT p2.title FROM reddit_mentions m2
              JOIN reddit_posts p2 ON p2.id = m2.post_id
             WHERE m2.symbol = m.symbol
               AND p2.created_utc >= ?1
               ${subreddit ? 'AND p2.subreddit = ?4' : ''}
             ORDER BY p2.score DESC LIMIT 1)                    AS top_post_title
      FROM reddit_mentions m
      JOIN reddit_posts p ON p.id = m.post_id
     WHERE p.created_utc >= ?1
       ${subreddit ? 'AND p.subreddit = ?4' : ''}
     GROUP BY m.symbol
     ORDER BY mentions DESC, posts DESC
     LIMIT ?2`;
  const stmt = subreddit
    ? db.prepare(sql).bind(since, limit, since, subreddit)
    : db.prepare(sql).bind(since, limit);
  const { results } = await stmt.all<TrendingRow>();
  return results.map((r) => ({
    symbol: r.symbol,
    posts: r.posts,
    mentions: r.mentions,
    netSentiment: r.net_sentiment,
    totalScore: r.total_score,
    topPostId: r.top_post_id,
    topPostTitle: r.top_post_title,
  }));
}

async function getRedditDiamonds(
  db: D1Database,
  recentSeconds: number,
  baselineSeconds: number,
  limit: number,
  subreddit: string | null,
): Promise<RedditDiamond[]> {
  const now = Math.floor(Date.now() / 1000);
  const recentSince = now - recentSeconds;
  const baselineSince = now - baselineSeconds;

  // Recent vs. baseline mention counts per symbol. spike_ratio is normalised
  // by window length so a 6h burst on a symbol with low 7d activity scores
  // higher than something that's been steady all week.
  const subFilter = subreddit ? 'AND p.subreddit = ?5' : '';
  const sql = `
    WITH recent AS (
      SELECT m.symbol, SUM(m.mention_count) AS mentions, COUNT(DISTINCT p.id) AS posts,
             AVG(m.sentiment) AS net_sentiment, SUM(p.score) AS total_score
        FROM reddit_mentions m JOIN reddit_posts p ON p.id = m.post_id
       WHERE p.created_utc >= ?1 ${subFilter}
       GROUP BY m.symbol
    ),
    baseline AS (
      SELECT m.symbol, SUM(m.mention_count) AS mentions
        FROM reddit_mentions m JOIN reddit_posts p ON p.id = m.post_id
       WHERE p.created_utc >= ?2 AND p.created_utc < ?1 ${subFilter}
       GROUP BY m.symbol
    ),
    top_post AS (
      SELECT m.symbol, p.id AS top_post_id, p.title AS top_post_title,
             ROW_NUMBER() OVER (PARTITION BY m.symbol ORDER BY p.score DESC) AS rn
        FROM reddit_mentions m JOIN reddit_posts p ON p.id = m.post_id
       WHERE p.created_utc >= ?1 ${subFilter}
    )
    SELECT r.symbol                                            AS symbol,
           r.posts                                             AS posts,
           r.mentions                                          AS mentions,
           r.net_sentiment                                     AS net_sentiment,
           r.total_score                                       AS total_score,
           t.top_post_id                                       AS top_post_id,
           t.top_post_title                                    AS top_post_title,
           COALESCE(b.mentions, 0)                             AS baseline_mentions,
           -- recent_rate / baseline_rate, with a small floor so brand-new
           -- symbols (baseline = 0) don't divide by zero. baseline_rate is
           -- mentions normalized to the recent-window length.
           (CAST(r.mentions AS REAL) / (?3 / 3600.0))
             / ((CAST(COALESCE(b.mentions, 0) AS REAL) + 0.5)
                / ((?4 - ?3) / 3600.0))                        AS spike_ratio
      FROM recent r
      LEFT JOIN baseline b ON b.symbol = r.symbol
      LEFT JOIN top_post  t ON t.symbol = r.symbol AND t.rn = 1
     WHERE r.mentions >= 2
     ORDER BY spike_ratio DESC, r.mentions DESC
     LIMIT ?6`;
  const stmt = subreddit
    ? db.prepare(sql).bind(recentSince, baselineSince, recentSeconds, baselineSeconds, subreddit, limit)
    : db.prepare(sql).bind(recentSince, baselineSince, recentSeconds, baselineSeconds, limit);
  const { results } = await stmt.all<TrendingRow & { baseline_mentions: number; spike_ratio: number }>();
  return results.map((r) => ({
    symbol: r.symbol,
    posts: r.posts,
    mentions: r.mentions,
    netSentiment: r.net_sentiment,
    totalScore: r.total_score,
    topPostId: r.top_post_id,
    topPostTitle: r.top_post_title,
    baselineMentions: r.baseline_mentions,
    spikeRatio: r.spike_ratio,
  }));
}

interface PostRow {
  id: string;
  subreddit: string;
  author: string | null;
  title: string;
  selftext: string | null;
  flair: string | null;
  score: number;
  num_comments: number;
  permalink: string | null;
  url: string | null;
  created_utc: number;
  fetched_at: number;
}

async function getRedditPosts(
  db: D1Database,
  symbol: string | null,
  limit: number,
  subreddit: string | null,
): Promise<RedditPost[]> {
  let stmt: D1PreparedStatement;
  if (symbol) {
    const sym = symbol.toUpperCase();
    const sql = `SELECT p.id, p.subreddit, p.author, p.title, p.selftext, p.flair,
                        p.score, p.num_comments, p.permalink, p.url,
                        p.created_utc, p.fetched_at
                   FROM reddit_posts p
                   JOIN reddit_mentions m ON m.post_id = p.id
                  WHERE m.symbol = ?
                  ${subreddit ? 'AND p.subreddit = ?3' : ''}
                  ORDER BY p.created_utc DESC
                  LIMIT ?2`;
    stmt = subreddit
      ? db.prepare(sql).bind(sym, limit, subreddit)
      : db.prepare(sql).bind(sym, limit);
  } else {
    const sql = `SELECT id, subreddit, author, title, selftext, flair,
                        score, num_comments, permalink, url,
                        created_utc, fetched_at
                   FROM reddit_posts
                  ${subreddit ? 'WHERE subreddit = ?2' : ''}
                  ORDER BY created_utc DESC
                  LIMIT ?1`;
    stmt = subreddit ? db.prepare(sql).bind(limit, subreddit) : db.prepare(sql).bind(limit);
  }
  const { results } = await stmt.all<PostRow>();
  return results.map((r) => ({
    id: r.id,
    subreddit: r.subreddit,
    author: r.author,
    title: r.title,
    selftext: r.selftext,
    flair: r.flair,
    score: r.score,
    numComments: r.num_comments,
    permalink: r.permalink,
    url: r.url,
    createdUtc: r.created_utc,
    fetchedAt: r.fetched_at,
  }));
}


// ─────────────────────────────────────────────────────────────────────────
// Options chain (Yahoo free endpoint + Black-Scholes greeks)
// ─────────────────────────────────────────────────────────────────────────

interface OptionContract {
  contractSymbol: string;
  strike: number;
  bid: number | null;
  ask: number | null;
  last: number | null;
  volume: number | null;
  openInterest: number | null;
  impliedVolatility: number | null;
  inTheMoney: boolean;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
}

interface OptionsChainResponse {
  symbol: string;
  spot: number;
  expiration: number; // unix seconds
  expirationDate: string; // YYYY-MM-DD
  daysToExpiry: number;
  availableExpirations: number[]; // all expirations Yahoo offers
  calls: OptionContract[];
  puts: OptionContract[];
}

// Fetch a symbol's options chain from Yahoo's free endpoint. Cached in
// json_cache for 60s — chains barely move between page loads, and we'd
// otherwise burn rate budget on every dashboard refresh.
async function getOptionsChain(
  env: Env,
  symbol: string,
  expirationTs: number | null,
): Promise<OptionsChainResponse> {
  const cacheKey = `options-${symbol}-${expirationTs ?? 'nearest'}`;
  const now = Math.floor(Date.now() / 1000);
  try {
    const row = await env.DB
      .prepare('SELECT value, updated_at FROM json_cache WHERE key = ?')
      .bind(cacheKey)
      .first<{ value: string; updated_at: number }>();
    if (row && now - row.updated_at < 60) {
      return JSON.parse(row.value) as OptionsChainResponse;
    }
  } catch {
    // Fall through to live fetch.
  }

  const url = `https://query1.finance.yahoo.com/v7/finance/options/${encodeURIComponent(symbol)}${expirationTs ? `?date=${expirationTs}` : ''}`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; stock-tracker/0.1)',
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) {
    throw new HttpError(res.status, `Yahoo options ${res.status} for ${symbol}`);
  }
  const json = (await res.json()) as YahooOptionsResponse;
  const result = json.optionChain?.result?.[0];
  if (!result) throw new HttpError(502, `no chain returned for ${symbol}`);
  const opt = result.options?.[0];
  if (!opt) throw new HttpError(502, `no options block for ${symbol}`);

  const spot = result.quote?.regularMarketPrice ?? 0;
  const expiration = opt.expirationDate;
  const expirationDate = new Date(expiration * 1000).toISOString().slice(0, 10);
  const daysToExpiry = Math.max(0, (expiration - now) / 86400);

  // Get current risk-free rate from latest ^TNX close. ^TNX is reported
  // as a percentage (e.g. 4.35 = 4.35%), so divide by 100.
  let rate = 0.045; // sensible default if ^TNX unavailable
  try {
    const tnx = await env.DB
      .prepare(`SELECT close FROM bars WHERE symbol='^TNX' AND interval='1min' ORDER BY ts DESC LIMIT 1`)
      .first<{ close: number }>();
    if (tnx && tnx.close > 0) rate = tnx.close / 100;
  } catch {
    // Stick with default rate.
  }

  const yearsToExpiry = daysToExpiry / 365;
  const calls = (opt.calls ?? []).map((c) => toContract(c, spot, rate, yearsToExpiry, 'call'));
  const puts = (opt.puts ?? []).map((c) => toContract(c, spot, rate, yearsToExpiry, 'put'));

  const response: OptionsChainResponse = {
    symbol,
    spot,
    expiration,
    expirationDate,
    daysToExpiry: Math.round(daysToExpiry * 10) / 10,
    availableExpirations: result.expirationDates ?? [],
    calls,
    puts,
  };

  try {
    await env.DB
      .prepare(
        `INSERT INTO json_cache(key, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      )
      .bind(cacheKey, JSON.stringify(response), now)
      .run();
  } catch {
    // Cache write is best-effort.
  }
  return response;
}

interface YahooOptionsResponse {
  optionChain?: {
    result?: Array<{
      underlyingSymbol?: string;
      expirationDates?: number[];
      strikes?: number[];
      quote?: { regularMarketPrice?: number };
      options?: Array<{
        expirationDate: number;
        calls?: YahooContractRaw[];
        puts?: YahooContractRaw[];
      }>;
    }>;
  };
}

interface YahooContractRaw {
  contractSymbol: string;
  strike: number;
  bid?: number;
  ask?: number;
  lastPrice?: number;
  volume?: number;
  openInterest?: number;
  impliedVolatility?: number;
  inTheMoney?: boolean;
}

function toContract(
  c: YahooContractRaw,
  spot: number,
  rate: number,
  t: number,
  kind: 'call' | 'put',
): OptionContract {
  const iv = typeof c.impliedVolatility === 'number' && c.impliedVolatility > 0 ? c.impliedVolatility : null;
  const greeks = iv && spot > 0 && c.strike > 0 && t > 0
    ? blackScholesGreeks(spot, c.strike, rate, iv, t, kind)
    : { delta: null, gamma: null, theta: null, vega: null };
  return {
    contractSymbol: c.contractSymbol,
    strike: c.strike,
    bid: c.bid ?? null,
    ask: c.ask ?? null,
    last: c.lastPrice ?? null,
    volume: c.volume ?? null,
    openInterest: c.openInterest ?? null,
    impliedVolatility: iv,
    inTheMoney: !!c.inTheMoney,
    ...greeks,
  };
}

// Black-Scholes greeks. Uses ^TNX as the risk-free rate; assumes zero
// dividend yield (slight bias for high-divvy underlyings but close enough
// for ATM-near strikes used for swing trades). N(x) approximation is
// Abramowitz-Stegun 7.1.26 — accurate to ~7e-8 across the real line.
function blackScholesGreeks(
  s: number,
  k: number,
  r: number,
  sigma: number,
  t: number,
  kind: 'call' | 'put',
): { delta: number; gamma: number; theta: number; vega: number } {
  const sqrtT = Math.sqrt(t);
  const d1 = (Math.log(s / k) + (r + (sigma * sigma) / 2) * t) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const nd1 = normalCdf(d1);
  const npd1 = normalPdf(d1);
  const nd2 = normalCdf(d2);
  let delta: number;
  let theta: number;
  if (kind === 'call') {
    delta = nd1;
    theta = (-(s * npd1 * sigma) / (2 * sqrtT) - r * k * Math.exp(-r * t) * nd2) / 365;
  } else {
    delta = nd1 - 1;
    theta = (-(s * npd1 * sigma) / (2 * sqrtT) + r * k * Math.exp(-r * t) * normalCdf(-d2)) / 365;
  }
  const gamma = npd1 / (s * sigma * sqrtT);
  const vega = (s * npd1 * sqrtT) / 100; // per 1% IV change
  return { delta, gamma, theta, vega };
}

function normalCdf(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + p * ax);
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-ax * ax);
  return 0.5 * (1 + sign * y);
}

function normalPdf(x: number): number {
  return Math.exp(-(x * x) / 2) / Math.sqrt(2 * Math.PI);
}
