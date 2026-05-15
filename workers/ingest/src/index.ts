import { FinnhubClient, RateLimiter, RateLimitError } from './finnhub';
import { YahooClient } from './yahoo';
import {
  batchInsertSignals,
  finishIngestRun,
  listEnabledTickers,
  loadModels,
  recentSignalCooldown,
  startIngestRun,
  upsertBars,
} from './db';
import { detectSetups } from '../../../shared/setups';
import { isUsRegularHours } from '../../../shared/indicators';
import { postDiscordSignals, type DiscordSignal } from './discord';
import { modelFromJson, predict, type Model } from '../../../shared/ml';
import { featuresToVector, type SignalContext } from '../../../shared/features';
import type { Bar } from '../../../shared/types';
import type { SetupName } from '../../../shared/setups';

export interface Env {
  DB: D1Database;
  FINNHUB_API_KEY: string;
  DISCORD_WEBHOOK_URL?: string;
  FINNHUB_REQUESTS_PER_MINUTE?: string;
  SIGNAL_COOLDOWN_SECONDS?: string;
  ML_DISCORD_THRESHOLD?: string;
  DISABLED_SETUPS?: string;
  // Number of cron buckets to split the watchlist across. With CHUNKS=2 each
  // symbol is polled every 2 minutes; default keeps free-tier subrequests
  // within budget for ~50 symbols.
  CHUNKS?: string;
}

function isMarketHoursEt(d: Date): boolean {
  // Delegates to shared/indicators.isUsRegularHours so DST is handled
  // properly. The previous fixed -4h offset silently mis-bucketed half the
  // year — under EST it polled 08:30-15:00 ET, missing the closing hour
  // and wasting invocations on pre-market.
  return isUsRegularHours(Math.floor(d.getTime() / 1000));
}

export default {
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runIngest(env, new Date(event.scheduledTime)));
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/run') {
      const result = await runIngest(env, new Date(), { force: true, allChunks: true });
      return Response.json(result);
    }
    if (url.pathname === '/backfill') {
      const days = Math.max(1, Math.min(7, Number(url.searchParams.get('days') ?? '7')));
      const result = await runBackfill(env, days);
      return Response.json(result);
    }
    if (url.pathname === '/health') {
      return Response.json({ ok: true });
    }
    if (url.pathname === '/test-discord') {
      if (!env.DISCORD_WEBHOOK_URL) {
        return Response.json({ ok: false, error: 'DISCORD_WEBHOOK_URL not set' }, { status: 400 });
      }
      try {
        await postDiscordSignals(env.DISCORD_WEBHOOK_URL, [{
          symbol: 'TEST',
          ts: Math.floor(Date.now() / 1000),
          setup: 'vwap_reclaim_long',
          direction: 'long',
          price: 123.45,
          prevClose: 120.00,
          changePct: 0.02875,
          notes: 'Test alert from /test-discord',
          features: { rsi: 42, vwap: 122.10, atr: 0.85 },
          mlProbability: 0.62,
        }]);
        return Response.json({ ok: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return Response.json({ ok: false, error: msg }, { status: 500 });
      }
    }
    return new Response('not found', { status: 404 });
  },
};

interface RunOptions {
  force?: boolean;
  allChunks?: boolean;
}

async function runIngest(env: Env, now: Date, opts: RunOptions = {}): Promise<{
  ran: boolean;
  chunk: number;
  chunkSize: number;
  symbols: number;
  yahooOk: number;
  finnhubFallback: number;
  errors: number;
  signals: number;
  notified: number;
  suppressedByMl: number;
  barsWritten: number;
}> {
  if (!opts.force && !isMarketHoursEt(now)) {
    return { ran: false, chunk: 0, chunkSize: 0, symbols: 0, yahooOk: 0, finnhubFallback: 0, errors: 0, signals: 0, notified: 0, suppressedByMl: 0, barsWritten: 0 };
  }

  const tickers = await listEnabledTickers(env.DB);
  const numChunks = Math.max(1, Number(env.CHUNKS ?? '2'));
  // Pick chunk by minute parity / mod so successive cron firings rotate.
  const chunkIdx = opts.allChunks ? -1 : Math.floor(now.getTime() / 60_000) % numChunks;
  const symbols = opts.allChunks
    ? tickers
    : tickers.filter((_, i) => i % numChunks === chunkIdx);

  const runId = await startIngestRun(env.DB);
  const yahoo = new YahooClient();
  const finnhub = env.FINNHUB_API_KEY ? new FinnhubClient(env.FINNHUB_API_KEY) : null;
  const finnhubLimiter = new RateLimiter(Number(env.FINNHUB_REQUESTS_PER_MINUTE ?? '60'));
  const cooldownSec = Number(env.SIGNAL_COOLDOWN_SECONDS ?? '1800');
  const webhookUrl = env.DISCORD_WEBHOOK_URL?.trim();
  const mlThreshold = Number(env.ML_DISCORD_THRESHOLD ?? '0.60');
  const disabled = new Set(
    (env.DISABLED_SETUPS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

  let yahooOk = 0;
  let finnhubFallback = 0;
  let errors = 0;
  let signalsFound = 0;
  let suppressedByMl = 0;
  let notified = 0;
  let allBars: Bar[] = [];
  let errorText: string | null = null;

  try {

  // Load models + cooldown map up-front so we don't hit D1 inside the inner loop.
  const modelRows = await loadModels(env.DB);
  const models = new Map<SetupName, Model>();
  for (const [setup, row] of modelRows) {
    const m = modelFromJson(setup as SetupName, row.weightsJson, row.trainedAt, {
      sampleCount: row.sampleCount,
      trainAccuracy: row.trainAccuracy,
      valAccuracy: row.valAccuracy,
      trainBaseline: row.trainBaseline,
    });
    if (m) models.set(setup as SetupName, m);
  }
  const cooldownLookup = await recentSignalCooldown(
    env.DB,
    Math.floor(now.getTime() / 1000) - cooldownSec,
  );

  // Fan out Yahoo fetches concurrently. Each fetch is one subrequest; with
  // chunked symbol lists we stay well under the 50-per-invocation cap.
  type FetchOk = {
    symbol: string;
    bars: Bar[];
    prevClose: number | null;
    source: 'yahoo' | 'finnhub';
  };
  type FetchFail = { symbol: string; err: unknown };
  const settled = await Promise.allSettled(
    symbols.map(async (symbol): Promise<FetchOk> => {
      const result = await yahoo.latest(symbol, '1min');
      return { symbol, bars: result.bars, prevClose: result.prevClose, source: 'yahoo' };
    }),
  );

  const fetched: FetchOk[] = [];
  const failedSymbols: string[] = [];
  for (let i = 0; i < settled.length; i++) {
    const r = settled[i]!;
    const symbol = symbols[i]!;
    if (r.status === 'fulfilled') {
      yahooOk += 1;
      fetched.push(r.value);
    } else {
      const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
      errorText = errorText ? `${errorText}\nyahoo ${symbol}: ${msg}` : `yahoo ${symbol}: ${msg}`;
      failedSymbols.push(symbol);
    }
  }

  // For symbols Yahoo couldn't serve, try Finnhub /quote sequentially since
  // it's rate-limited. Skip the fallback only on near-total Yahoo wipeouts
  // (>70% failure) — that's a Yahoo-wide issue where 20+ serial Finnhub
  // calls would blow the wall-clock budget. Below that, partial fallback
  // is better than dropping the data entirely.
  const yahooFailRate = symbols.length > 0 ? failedSymbols.length / symbols.length : 0;
  const shouldFinnhubFallback = finnhub !== null && yahooFailRate <= 0.7;
  if (shouldFinnhubFallback) {
    for (const symbol of failedSymbols) {
      try {
        await finnhubLimiter.take(1);
        const result = await finnhub!.quoteBar(symbol, '1min', now);
        finnhubFallback += 1;
        if (result) {
          fetched.push({
            symbol,
            bars: [result.bar],
            prevClose: result.quote.prevClose,
            source: 'finnhub',
          });
        }
      } catch (err) {
        errors += 1;
        const msg = err instanceof Error ? err.message : String(err);
        errorText = errorText ? `${errorText}\nfinnhub ${symbol}: ${msg}` : `finnhub ${symbol}: ${msg}`;
        if (err instanceof RateLimitError) break;
      }
    }
  } else if (failedSymbols.length > 0) {
    errors += failedSymbols.length;
    const note = `skipped Finnhub fallback for ${failedSymbols.length} symbols (Yahoo failure rate too high)`;
    errorText = errorText ? `${errorText}\n${note}` : note;
  }

  // Single batched bar upsert. We pulled 2 days from Yahoo for indicator
  // warmup, but D1 already has the older bars from prior runs/backfill — only
  // upsert the trailing tail per symbol (covers any minutes we missed since
  // last poll) so the batch stays under D1's per-call limits.
  const TAIL_BARS = 10;
  allBars = fetched.flatMap((f) => f.bars.slice(-TAIL_BARS));
  if (allBars.length > 0) {
    await upsertBars(env.DB, allBars);
  }

  // Build per-scan context once: VIX/TNX/SPY are global; Reddit, options
  // and earnings are per-symbol. Best-effort — any query failure leaves the
  // corresponding context fields neutral so signal detection still runs.
  const vixCtx = await loadIndexContext(env.DB, '^VIX', 'vix');
  const tnxCtx = await loadIndexContext(env.DB, '^TNX', 'tnx');
  const spyCtx = await loadSpyContext(env.DB);
  const redditBySymbol = await loadRedditContext(env.DB, symbols);
  const optionsBySymbol = await loadOptionsContext(env.DB, symbols);
  const earningsBySymbol = await loadEarningsContext(env, symbols);

  // In-memory setup detection per symbol.
  const signalsToFire: DiscordSignal[] = [];
  const signalsToInsert: Array<{
    symbol: string;
    ts: number;
    setup: string;
    direction: 'long' | 'short';
    notes: string;
    featuresJson: string;
    mlProbability: number | null;
  }> = [];

  for (const f of fetched) {
    if (f.bars.length < 30 || f.prevClose === null) continue;
    const symbolContext: SignalContext = {
      ...vixCtx,
      ...tnxCtx,
      ...spyCtx,
      ...(redditBySymbol.get(f.symbol) ?? {}),
      ...(optionsBySymbol.get(f.symbol) ?? {}),
      ...(earningsBySymbol.get(f.symbol) ?? {}),
    };
    const detected = detectSetups(f.symbol, f.bars, f.prevClose, symbolContext);
    for (const sig of detected) {
      if (disabled.has(sig.setup)) continue;
      signalsFound += 1;
      const cdKey = `${sig.symbol}|${sig.setup}`;
      const lastTs = cooldownLookup.get(cdKey);
      if (lastTs !== undefined && sig.ts - lastTs < cooldownSec) continue;

      let mlProbability: number | null = null;
      const model = models.get(sig.setup);
      if (model) {
        mlProbability = predict(model, featuresToVector(sig.features));
      }

      signalsToInsert.push({
        symbol: sig.symbol,
        ts: sig.ts,
        setup: sig.setup,
        direction: sig.direction,
        notes: sig.notes,
        featuresJson: JSON.stringify({ ...sig.features, ml_probability: mlProbability ?? -1 }),
        mlProbability,
      });

      // Update cooldown map so subsequent setups in the same run respect it.
      cooldownLookup.set(cdKey, sig.ts);

      const passesMl = mlProbability === null || mlProbability >= mlThreshold;
      if (!passesMl) {
        suppressedByMl += 1;
        continue;
      }
      signalsToFire.push({ ...sig, mlProbability });
    }
  }

  if (signalsToInsert.length > 0) {
    await batchInsertSignals(env.DB, signalsToInsert);
  }

  if (webhookUrl && signalsToFire.length > 0) {
    try {
      await postDiscordSignals(webhookUrl, signalsToFire);
      notified = signalsToFire.length;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errorText = errorText ? `${errorText}\ndiscord: ${msg}` : `discord: ${msg}`;
    }
  }
  } catch (err) {
    errors += 1;
    const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    errorText = errorText ? `${errorText}\nfatal: ${msg}` : `fatal: ${msg}`;
    console.error('runIngest fatal', msg);
  } finally {
    try {
      await finishIngestRun(env.DB, runId, symbols.length, yahooOk + finnhubFallback, errors, errorText);
    } catch (err) {
      console.error('finishIngestRun failed', err);
    }
  }

  return {
    ran: true,
    chunk: chunkIdx,
    chunkSize: symbols.length,
    symbols: symbols.length,
    yahooOk,
    finnhubFallback,
    errors,
    signals: signalsFound,
    notified,
    suppressedByMl,
    barsWritten: allBars.length,
  };
}

// Loads the latest level + delta for an index symbol (^VIX, ^TNX, etc.)
// and returns it as a SignalContext under the appropriate key prefix.
// Empty object if the symbol hasn't been ingested yet.
async function loadIndexContext(
  db: D1Database,
  symbol: string,
  prefix: 'vix' | 'tnx',
): Promise<SignalContext> {
  try {
    const { results } = await db
      .prepare(
        `SELECT close FROM bars
          WHERE symbol = ? AND interval = '1min'
          ORDER BY ts DESC
          LIMIT 2`,
      )
      .bind(symbol)
      .all<{ close: number }>();
    if (results.length === 0) return {};
    const latest = results[0]!.close;
    const prev = results[1]?.close ?? latest;
    return prefix === 'vix'
      ? { vixLevel: latest, vixDelta: latest - prev }
      : { tnxLevel: latest, tnxDelta: latest - prev };
  } catch {
    return {};
  }
}

// SPY intraday return: today's latest close vs today's open. Used as a
// relative-strength baseline for every other symbol's signal.
async function loadSpyContext(db: D1Database): Promise<SignalContext> {
  try {
    const latestRow = await db
      .prepare(
        `SELECT ts, close FROM bars
          WHERE symbol='SPY' AND interval='1min'
          ORDER BY ts DESC LIMIT 1`,
      )
      .first<{ ts: number; close: number }>();
    if (!latestRow) return {};
    // Find SPY's first bar of the same trading day. We can't use etDayKey
    // here without importing it; the 14h window is conservative enough to
    // cover from 09:30 ET to 16:00 ET regardless of DST.
    const open = await db
      .prepare(
        `SELECT open FROM bars
          WHERE symbol='SPY' AND interval='1min' AND ts >= ? AND ts <= ?
          ORDER BY ts ASC LIMIT 1`,
      )
      .bind(latestRow.ts - 14 * 3600, latestRow.ts)
      .first<{ open: number }>();
    if (!open || open.open <= 0) return {};
    return { spyReturnPct: (latestRow.close - open.open) / open.open };
  } catch {
    return {};
  }
}

// Earnings calendar via Finnhub. Cached for 12h in json_cache so we don't
// burn the 60-req/min budget on every scan. Returns days-to-earnings per
// symbol; symbols with no upcoming announcement on file get 30 (the cap).
async function loadEarningsContext(
  env: Env,
  symbols: string[],
): Promise<Map<string, SignalContext>> {
  const out = new Map<string, SignalContext>();
  if (symbols.length === 0 || !env.FINNHUB_API_KEY) return out;
  // Read from cache if fresh, otherwise refresh.
  const now = Math.floor(Date.now() / 1000);
  let cached: Record<string, string> | null = null;
  try {
    const row = await env.DB
      .prepare(`SELECT value, updated_at FROM json_cache WHERE key='earnings-calendar'`)
      .first<{ value: string; updated_at: number }>();
    if (row && now - row.updated_at < 12 * 3600) {
      cached = JSON.parse(row.value) as Record<string, string>;
    }
  } catch {
    // json_cache table may not exist on older DBs; soft-fail to refresh.
  }
  if (!cached) {
    cached = await fetchEarningsCalendar(env.FINNHUB_API_KEY);
    if (cached) {
      try {
        await env.DB
          .prepare(
            `INSERT INTO json_cache(key, value, updated_at)
             VALUES ('earnings-calendar', ?, ?)
             ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
          )
          .bind(JSON.stringify(cached), now)
          .run();
      } catch {
        // Cache write is best-effort.
      }
    }
  }
  if (!cached) return out;
  const today = new Date(now * 1000);
  for (const sym of symbols) {
    const dateStr = cached[sym];
    if (!dateStr) continue;
    const earningsDate = new Date(dateStr + 'T12:00:00Z');
    const days = Math.max(0, Math.round((earningsDate.getTime() - today.getTime()) / 86400000));
    if (days <= 60) out.set(sym, { daysToEarnings: days });
  }
  return out;
}

async function fetchEarningsCalendar(apiKey: string): Promise<Record<string, string> | null> {
  // Finnhub returns symbol-keyed announcements for a date range. Pull the
  // next ~30 days. Wall-clock-bounded so a hung response doesn't kill the
  // run.
  try {
    const start = new Date().toISOString().slice(0, 10);
    const endDate = new Date(Date.now() + 35 * 86400000).toISOString().slice(0, 10);
    const url = `https://finnhub.io/api/v1/calendar/earnings?from=${start}&to=${endDate}&token=${apiKey}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;
    const json = (await res.json()) as { earningsCalendar?: Array<{ symbol: string; date: string }> };
    const map: Record<string, string> = {};
    for (const e of json.earningsCalendar ?? []) {
      if (!e.symbol || !e.date) continue;
      // First (= earliest) date per symbol wins.
      if (!(e.symbol in map)) map[e.symbol] = e.date;
    }
    return map;
  } catch {
    return null;
  }
}

// For each symbol, compute Reddit mention velocity (last 1h vs prior 24h avg)
// and the average sentiment across those posts. One D1 round-trip total.
async function loadRedditContext(
  db: D1Database,
  symbols: string[],
): Promise<Map<string, SignalContext>> {
  const out = new Map<string, SignalContext>();
  if (symbols.length === 0) return out;
  try {
    const now = Math.floor(Date.now() / 1000);
    const placeholders = symbols.map(() => '?').join(',');
    const stmt = db
      .prepare(
        `SELECT m.symbol AS symbol,
                SUM(CASE WHEN p.created_utc >= ?1 THEN m.mention_count ELSE 0 END) AS recent,
                SUM(CASE WHEN p.created_utc < ?1 THEN m.mention_count ELSE 0 END) AS prior,
                AVG(CASE WHEN p.created_utc >= ?1 THEN m.sentiment ELSE NULL END) AS sentiment
           FROM reddit_mentions m
           JOIN reddit_posts p ON p.id = m.post_id
          WHERE p.created_utc >= ?2
            AND m.symbol IN (${placeholders})
          GROUP BY m.symbol`,
      )
      .bind(now - 3600, now - 86400, ...symbols);
    const { results } = await stmt.all<{
      symbol: string;
      recent: number;
      prior: number;
      sentiment: number | null;
    }>();
    for (const r of results) {
      // Velocity = recent-1h rate / 23h-prior hourly rate. 1 ≈ steady, >1 spiking.
      const priorRate = (r.prior ?? 0) / 23;
      const recentRate = r.recent ?? 0;
      const velocity = priorRate > 0 ? recentRate / priorRate : recentRate > 0 ? 5 : 1;
      out.set(r.symbol, {
        redditVelocity: velocity,
        redditSentiment: r.sentiment ?? 0,
      });
    }
  } catch {
    // Reddit tables may not exist on older DBs; soft-fail.
  }
  return out;
}

// Compute P/C ratio and gamma concentration from the latest options snapshot
// per underlying. Spot price comes from the latest 1-min bar close.
async function loadOptionsContext(
  db: D1Database,
  symbols: string[],
): Promise<Map<string, SignalContext>> {
  const out = new Map<string, SignalContext>();
  if (symbols.length === 0) return out;
  try {
    const placeholders = symbols.map(() => '?').join(',');
    const { results } = await db
      .prepare(
        `WITH latest AS (
           SELECT underlying, MAX(fetched_at) AS fetched_at
             FROM options_snapshots
            WHERE underlying IN (${placeholders})
            GROUP BY underlying
         ),
         spot AS (
           SELECT b.symbol AS underlying, b.close
             FROM bars b
             JOIN (
               SELECT symbol, MAX(ts) AS ts
                 FROM bars
                WHERE interval = '1min'
                  AND symbol IN (${placeholders})
                GROUP BY symbol
             ) m ON m.symbol = b.symbol AND m.ts = b.ts
            WHERE b.interval = '1min'
         )
         SELECT s.underlying AS symbol,
                SUM(CASE WHEN s.type='put' THEN s.volume ELSE 0 END) AS put_vol,
                SUM(CASE WHEN s.type='call' THEN s.volume ELSE 0 END) AS call_vol,
                SUM(s.open_interest) AS total_oi,
                SUM(CASE WHEN ABS(s.strike - sp.close) / sp.close <= 0.02
                         THEN s.open_interest ELSE 0 END) AS near_oi
           FROM options_snapshots s
           JOIN latest l ON l.underlying = s.underlying AND l.fetched_at = s.fetched_at
           JOIN spot sp ON sp.underlying = s.underlying
          GROUP BY s.underlying`,
      )
      .bind(...symbols, ...symbols)
      .all<{
        symbol: string;
        put_vol: number | null;
        call_vol: number | null;
        total_oi: number | null;
        near_oi: number | null;
      }>();
    for (const r of results) {
      const pv = r.put_vol ?? 0;
      const cv = r.call_vol ?? 0;
      const tot = r.total_oi ?? 0;
      const near = r.near_oi ?? 0;
      out.set(r.symbol, {
        pcRatio: cv > 0 ? pv / cv : 1,
        gammaConcentration: tot > 0 ? near / tot : 0,
      });
    }
  } catch {
    // Options snapshots are optional (POLL_OPTIONS=false by default); soft-fail.
  }
  return out;
}

async function runBackfill(env: Env, days: number): Promise<{
  symbols: number;
  barsWritten: number;
  errors: number;
  errorText: string | null;
}> {
  const tickers = await listEnabledTickers(env.DB);
  const yahoo = new YahooClient();
  let barsWritten = 0;
  let errors = 0;
  let errorText: string | null = null;
  const range = `${days}d`;

  for (const symbol of tickers) {
    try {
      const result = await yahoo.chart(symbol, '1min', range);
      if (result.bars.length > 0) {
        await upsertBars(env.DB, result.bars);
        barsWritten += result.bars.length;
      }
    } catch (err) {
      errors += 1;
      const msg = err instanceof Error ? err.message : String(err);
      errorText = errorText ? `${errorText}\n${symbol}: ${msg}` : `${symbol}: ${msg}`;
    }
  }

  return { symbols: tickers.length, barsWritten, errors, errorText };
}
