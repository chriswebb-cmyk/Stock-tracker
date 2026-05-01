import { AlphaVantageClient, RateLimiter, RateLimitError } from './alphavantage';
import {
  finishIngestRun,
  insertOptionsSnapshot,
  listEnabledTickers,
  startIngestRun,
  upsertBars,
} from './db';

export interface Env {
  DB: D1Database;
  ALPHAVANTAGE_API_KEY: string;
  // Optional. If set, options chains are pulled too. Costs +1 call per ticker
  // per run, so tune to your AV req/min limit.
  POLL_OPTIONS?: string; // 'true' | 'false'
  // Requests per minute available on your AV plan. Defaults to 75 (entry tier).
  AV_REQUESTS_PER_MINUTE?: string;
}

// US market hours in ET: 09:30 - 16:00. The cron triggers every minute, but
// we only do work during that window.
function isMarketHoursEt(d: Date): boolean {
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false; // weekend
  // Convert UTC to ET. Reuses the same DST logic in alphavantage.ts implicitly:
  // we approximate with a fixed 4h offset (EDT). For 1-minute granularity in
  // pre-market boundary cases this is good enough; we don't care about being
  // exact at 09:29 vs 09:30.
  const utcHour = d.getUTCHours();
  const utcMin = d.getUTCMinutes();
  const etHour = (utcHour - 4 + 24) % 24;
  const minutesEt = etHour * 60 + utcMin;
  return minutesEt >= 9 * 60 + 30 && minutesEt < 16 * 60;
}

export default {
  // Cron trigger. Configured in wrangler.toml as '* * * * *' but we no-op
  // outside market hours so the worker stays under free tier limits.
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runIngest(env, new Date(event.scheduledTime)));
  },

  // Manual trigger for local testing: `curl http://localhost:8787/run`.
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/run') {
      const result = await runIngest(env, new Date(), { force: true });
      return Response.json(result);
    }
    if (url.pathname === '/health') {
      return Response.json({ ok: true });
    }
    return new Response('not found', { status: 404 });
  },
};

interface RunOptions {
  force?: boolean;
}

async function runIngest(env: Env, now: Date, opts: RunOptions = {}): Promise<{
  ran: boolean;
  symbols: number;
  apiCalls: number;
  errors: number;
}> {
  if (!opts.force && !isMarketHoursEt(now)) {
    return { ran: false, symbols: 0, apiCalls: 0, errors: 0 };
  }
  if (!env.ALPHAVANTAGE_API_KEY) {
    throw new Error('ALPHAVANTAGE_API_KEY is not set');
  }

  const runId = await startIngestRun(env.DB);
  const tickers = await listEnabledTickers(env.DB);
  const client = new AlphaVantageClient(env.ALPHAVANTAGE_API_KEY);
  const rpm = Number(env.AV_REQUESTS_PER_MINUTE ?? '75');
  const limiter = new RateLimiter(rpm);
  const pollOptions = env.POLL_OPTIONS === 'true';

  let apiCalls = 0;
  let errors = 0;
  let errorText: string | null = null;

  for (const symbol of tickers) {
    try {
      await limiter.take(1);
      const bars = await client.intraday(symbol, '1min', 'compact');
      apiCalls += 1;
      // 'compact' returns the latest 100 bars. Most are already in the DB;
      // upsert handles dedup. Keeps each cron invocation small.
      await upsertBars(env.DB, bars);

      if (pollOptions) {
        await limiter.take(1);
        const chain = await client.realtimeOptions(symbol);
        apiCalls += 1;
        if (chain.length > 0) {
          await insertOptionsSnapshot(env.DB, chain);
        }
      }
    } catch (err) {
      errors += 1;
      const msg = err instanceof Error ? err.message : String(err);
      errorText = errorText ? `${errorText}\n${symbol}: ${msg}` : `${symbol}: ${msg}`;
      // On rate-limit, abort the rest of the run so we don't burn the budget.
      if (err instanceof RateLimitError) break;
    }
  }

  await finishIngestRun(env.DB, runId, tickers.length, apiCalls, errors, errorText);
  return { ran: true, symbols: tickers.length, apiCalls, errors };
}
