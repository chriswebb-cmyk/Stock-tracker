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
import { postDiscordSignals, type DiscordSignal } from './discord';
import { modelFromJson, predict, type Model } from '../../../shared/ml';
import { featuresToVector } from '../../../shared/features';
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
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false;
  const utcHour = d.getUTCHours();
  const utcMin = d.getUTCMinutes();
  const etHour = (utcHour - 4 + 24) % 24;
  const minutesEt = etHour * 60 + utcMin;
  return minutesEt >= 9 * 60 + 30 && minutesEt < 16 * 60;
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
    const detected = detectSetups(f.symbol, f.bars, f.prevClose);
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
