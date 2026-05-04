import type { Bar, OptionContract } from '../../../shared/types';

export async function listEnabledTickers(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare('SELECT symbol FROM tickers WHERE enabled = 1 ORDER BY symbol')
    .all<{ symbol: string }>();
  return results.map((r) => r.symbol);
}

export async function upsertBars(db: D1Database, bars: Bar[]): Promise<number> {
  if (bars.length === 0) return 0;
  // D1 batches statements together for atomicity + a single round trip.
  const stmt = db.prepare(
    `INSERT INTO bars(symbol, interval, ts, open, high, low, close, volume)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(symbol, interval, ts) DO UPDATE SET
       open = excluded.open,
       high = excluded.high,
       low  = excluded.low,
       close = excluded.close,
       volume = excluded.volume`,
  );
  const batch = bars.map((b) =>
    stmt.bind(b.symbol, b.interval, b.ts, b.open, b.high, b.low, b.close, b.volume),
  );
  await db.batch(batch);
  return bars.length;
}

export async function insertOptionsSnapshot(db: D1Database, contracts: OptionContract[]): Promise<number> {
  if (contracts.length === 0) return 0;
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO options_snapshots(
       underlying, fetched_at, contract, expiration, strike, type,
       bid, ask, last, volume, open_interest, implied_vol,
       delta, gamma, theta, vega, rho
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  // D1 batches up to ~50 statements efficiently; chunk to be safe.
  const CHUNK = 50;
  for (let i = 0; i < contracts.length; i += CHUNK) {
    const chunk = contracts.slice(i, i + CHUNK);
    await db.batch(
      chunk.map((c) =>
        stmt.bind(
          c.underlying, c.fetchedAt, c.contract, c.expiration, c.strike, c.type,
          c.bid, c.ask, c.last, c.volume, c.openInterest, c.impliedVol,
          c.delta, c.gamma, c.theta, c.vega, c.rho,
        ),
      ),
    );
  }
  return contracts.length;
}

export async function loadRecentBars(
  db: D1Database,
  symbol: string,
  interval: string,
  limit: number,
): Promise<import('../../../shared/types').Bar[]> {
  const { results } = await db
    .prepare(
      `SELECT symbol, interval, ts, open, high, low, close, volume
         FROM bars
        WHERE symbol = ? AND interval = ?
        ORDER BY ts DESC
        LIMIT ?`,
    )
    .bind(symbol, interval, limit)
    .all<{
      symbol: string;
      interval: string;
      ts: number;
      open: number;
      high: number;
      low: number;
      close: number;
      volume: number;
    }>();
  return results
    .map((r) => ({
      symbol: r.symbol,
      interval: r.interval as import('../../../shared/types').BarInterval,
      ts: r.ts,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
    }))
    .reverse();
}

export async function loadModels(db: D1Database): Promise<Map<string, {
  setup: string;
  weightsJson: string;
  trainedAt: number;
  sampleCount: number;
  trainAccuracy: number;
  valAccuracy: number;
  trainBaseline: number;
}>> {
  const out = new Map<string, {
    setup: string;
    weightsJson: string;
    trainedAt: number;
    sampleCount: number;
    trainAccuracy: number;
    valAccuracy: number;
    trainBaseline: number;
  }>();
  const { results } = await db
    .prepare(
      `SELECT setup, weights_json, trained_at, sample_count,
              train_accuracy, val_accuracy, train_baseline FROM models`,
    )
    .all<{
      setup: string;
      weights_json: string;
      trained_at: number;
      sample_count: number;
      train_accuracy: number;
      val_accuracy: number;
      train_baseline: number;
    }>();
  for (const r of results) {
    out.set(r.setup, {
      setup: r.setup,
      weightsJson: r.weights_json,
      trainedAt: r.trained_at,
      sampleCount: r.sample_count,
      trainAccuracy: r.train_accuracy,
      valAccuracy: r.val_accuracy,
      trainBaseline: r.train_baseline,
    });
  }
  return out;
}

export async function lastSignalTs(
  db: D1Database,
  symbol: string,
  setup: string,
): Promise<number | null> {
  const row = await db
    .prepare('SELECT ts FROM signals WHERE symbol = ? AND setup = ? ORDER BY ts DESC LIMIT 1')
    .bind(symbol, setup)
    .first<{ ts: number }>();
  return row ? row.ts : null;
}

export async function insertSignal(
  db: D1Database,
  symbol: string,
  ts: number,
  setup: string,
  direction: 'long' | 'short',
  notes: string,
  featuresJson: string,
  mlProbability: number | null,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO signals(symbol, ts, setup, direction, ml_probability, features_json, contract_pick, notes)
       VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`,
    )
    .bind(symbol, ts, setup, direction, mlProbability, featuresJson, notes)
    .run();
}

export async function startIngestRun(db: D1Database): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const res = await db
    .prepare('INSERT INTO ingest_runs(started_at) VALUES (?)')
    .bind(now)
    .run();
  return Number(res.meta.last_row_id);
}

export async function finishIngestRun(
  db: D1Database,
  id: number,
  symbols: number,
  apiCalls: number,
  errors: number,
  errorText: string | null,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `UPDATE ingest_runs
         SET finished_at = ?, symbols = ?, api_calls = ?, errors = ?, error_text = ?
       WHERE id = ?`,
    )
    .bind(now, symbols, apiCalls, errors, errorText, id)
    .run();
}
