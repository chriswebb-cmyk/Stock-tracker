import type { Bar, BarInterval, Ticker, IngestRun } from '../../../shared/types';
import { backtest, combineResults, type BacktestResult, type SetupStats } from '../../../shared/backtest';
import { trainLogReg, modelToJson, type ModelStats } from '../../../shared/ml';
import { FEATURE_NAMES, featuresToVector } from '../../../shared/features';
import type { SetupName } from '../../../shared/setups';

export interface Env {
  DB: D1Database;
  // Comma-separated list of allowed origins for CORS. Defaults to '*' for
  // dev convenience; set this in production.
  ALLOWED_ORIGINS?: string;
}

const VALID_INTERVALS: BarInterval[] = ['1min', '5min', '15min', '30min', '60min'];

export default {
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
    return getBars(env.DB, symbol, interval, limit);
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
  if (path === '/backtest-summary' && request.method === 'GET') {
    const days = clampInt(url.searchParams.get('days'), 1, 30, 7);
    const hold = clampInt(url.searchParams.get('hold'), 1, 240, 30);
    const cooldown = clampInt(url.searchParams.get('cooldown'), 0, 86400, 1800);
    return getBacktestSummary(env.DB, days, hold, cooldown);
  }

  throw new HttpError(404, 'not found');
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
  const results: BacktestResult[] = [];
  for (const { symbol } of tickers.results) {
    const bars = await loadBarsSince(db, symbol, '1min', sinceTs);
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

async function trainModels(
  db: D1Database,
  days: number,
  holdMinutes: number,
  cooldownSec: number,
): Promise<{
  perSetup: Array<{ setup: SetupName; samples: number; trainAcc: number; valAcc: number; baseline: number }>;
  symbols: number;
  trades: number;
}> {
  const tickers = await db
    .prepare('SELECT symbol FROM tickers WHERE enabled = 1 ORDER BY symbol')
    .all<{ symbol: string }>();
  const sinceTs = Math.floor(Date.now() / 1000) - days * 86400;

  const bySetup = new Map<SetupName, { X: number[][]; y: number[] }>();
  let totalTrades = 0;
  let symbolsUsed = 0;

  for (const { symbol } of tickers.results) {
    const bars = await loadBarsSince(db, symbol, '1min', sinceTs);
    if (bars.length < 30) continue;
    symbolsUsed += 1;
    const result = backtest(symbol, bars, holdMinutes, cooldownSec);
    for (const t of result.trades) {
      totalTrades += 1;
      const bucket = bySetup.get(t.setup) ?? { X: [], y: [] };
      bucket.X.push(featuresToVector(t.features));
      bucket.y.push(t.pnlPct > 0 ? 1 : 0);
      bySetup.set(t.setup, bucket);
    }
  }

  const trainedAt = Math.floor(Date.now() / 1000);
  const perSetup: Array<{ setup: SetupName; samples: number; trainAcc: number; valAcc: number; baseline: number }> = [];

  for (const [setup, { X, y }] of bySetup) {
    if (X.length < 30) continue;
    const trained = trainLogReg(X, y);
    const stats: ModelStats = trained.stats;
    const json = modelToJson({
      setup,
      featureNames: FEATURE_NAMES,
      means: trained.means,
      stds: trained.stds,
      weights: trained.weights,
      bias: trained.bias,
      trainedAt,
      stats,
    });
    await db
      .prepare(
        `INSERT INTO models(setup, trained_at, sample_count, train_accuracy,
                            val_accuracy, train_baseline, weights_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(setup) DO UPDATE SET
           trained_at = excluded.trained_at,
           sample_count = excluded.sample_count,
           train_accuracy = excluded.train_accuracy,
           val_accuracy = excluded.val_accuracy,
           train_baseline = excluded.train_baseline,
           weights_json = excluded.weights_json`,
      )
      .bind(setup, trainedAt, stats.sampleCount, stats.trainAccuracy, stats.valAccuracy, stats.trainBaseline, json)
      .run();
    perSetup.push({
      setup,
      samples: stats.sampleCount,
      trainAcc: stats.trainAccuracy,
      valAcc: stats.valAccuracy,
      baseline: stats.trainBaseline,
    });
  }

  perSetup.sort((a, b) => a.setup.localeCompare(b.setup));
  return { perSetup, symbols: symbolsUsed, trades: totalTrades };
}

async function getModels(db: D1Database): Promise<unknown[]> {
  const { results } = await db
    .prepare(
      `SELECT setup, trained_at, sample_count, train_accuracy, val_accuracy,
              train_baseline FROM models ORDER BY setup`,
    )
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
