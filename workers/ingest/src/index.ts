import { FinnhubClient, RateLimiter, RateLimitError } from './finnhub';
import {
  finishIngestRun,
  listEnabledTickers,
  startIngestRun,
  upsertBars,
} from './db';

export interface Env {
  DB: D1Database;
  FINNHUB_API_KEY: string;
  // Requests per minute available on your Finnhub plan. Defaults to 60 (free tier).
  FINNHUB_REQUESTS_PER_MINUTE?: string;
}

// US market hours in ET: 09:30 - 16:00. The cron triggers every minute, but
// we only do work during that window.
function isMarketHoursEt(d: Date): boolean {
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) return false; // weekend
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
  if (!env.FINNHUB_API_KEY) {
    throw new Error('FINNHUB_API_KEY is not set');
  }

  const runId = await startIngestRun(env.DB);
  const tickers = await listEnabledTickers(env.DB);
  const client = new FinnhubClient(env.FINNHUB_API_KEY);
  const rpm = Number(env.FINNHUB_REQUESTS_PER_MINUTE ?? '60');
  const limiter = new RateLimiter(rpm);

  let apiCalls = 0;
  let errors = 0;
  let errorText: string | null = null;

  for (const symbol of tickers) {
    try {
      await limiter.take(1);
      const bar = await client.quoteBar(symbol, '1min', now);
      apiCalls += 1;
      if (bar) {
        await upsertBars(env.DB, [bar]);
      }
    } catch (err) {
      errors += 1;
      const msg = err instanceof Error ? err.message : String(err);
      errorText = errorText ? `${errorText}\n${symbol}: ${msg}` : `${symbol}: ${msg}`;
      if (err instanceof RateLimitError) break;
    }
  }

  await finishIngestRun(env.DB, runId, tickers.length, apiCalls, errors, errorText);
  return { ran: true, symbols: tickers.length, apiCalls, errors };
}
