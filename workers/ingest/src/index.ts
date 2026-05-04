import { FinnhubClient, RateLimiter, RateLimitError } from './finnhub';
import {
  finishIngestRun,
  insertSignal,
  lastSignalTs,
  listEnabledTickers,
  startIngestRun,
  upsertBars,
} from './db';
import { detectSignals } from './signals';
import { postDiscordSignal } from './discord';

export interface Env {
  DB: D1Database;
  FINNHUB_API_KEY: string;
  // Optional. If set, signals are POSTed to this Discord webhook URL.
  DISCORD_WEBHOOK_URL?: string;
  // Requests per minute available on your Finnhub plan. Defaults to 60 (free tier).
  FINNHUB_REQUESTS_PER_MINUTE?: string;
  // Cooldown in seconds between identical (symbol, setup) alerts. Default 1800 (30 min).
  SIGNAL_COOLDOWN_SECONDS?: string;
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
    if (url.pathname === '/test-discord') {
      if (!env.DISCORD_WEBHOOK_URL) {
        return Response.json({ ok: false, error: 'DISCORD_WEBHOOK_URL not set' }, { status: 400 });
      }
      try {
        await postDiscordSignal(env.DISCORD_WEBHOOK_URL, {
          symbol: 'TEST',
          ts: Math.floor(Date.now() / 1000),
          setup: 'big_move_up',
          direction: 'long',
          price: 123.45,
          prevClose: 120.00,
          changePct: 0.02875,
          notes: 'Test alert from /test-discord',
        });
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
}

async function runIngest(env: Env, now: Date, opts: RunOptions = {}): Promise<{
  ran: boolean;
  symbols: number;
  apiCalls: number;
  errors: number;
  signals: number;
  notified: number;
}> {
  if (!opts.force && !isMarketHoursEt(now)) {
    return { ran: false, symbols: 0, apiCalls: 0, errors: 0, signals: 0, notified: 0 };
  }
  if (!env.FINNHUB_API_KEY) {
    throw new Error('FINNHUB_API_KEY is not set');
  }

  const runId = await startIngestRun(env.DB);
  const tickers = await listEnabledTickers(env.DB);
  const client = new FinnhubClient(env.FINNHUB_API_KEY);
  const rpm = Number(env.FINNHUB_REQUESTS_PER_MINUTE ?? '60');
  const limiter = new RateLimiter(rpm);
  const cooldownSec = Number(env.SIGNAL_COOLDOWN_SECONDS ?? '1800');
  const webhookUrl = env.DISCORD_WEBHOOK_URL?.trim();

  let apiCalls = 0;
  let errors = 0;
  let signalsFound = 0;
  let notified = 0;
  let errorText: string | null = null;

  for (const symbol of tickers) {
    try {
      await limiter.take(1);
      const result = await client.quoteBar(symbol, '1min', now);
      apiCalls += 1;
      if (!result) continue;

      await upsertBars(env.DB, [result.bar]);

      const detected = detectSignals(symbol, result.bar.ts, result.quote);
      for (const sig of detected) {
        signalsFound += 1;
        const last = await lastSignalTs(env.DB, sig.symbol, sig.setup);
        if (last !== null && sig.ts - last < cooldownSec) continue;

        const features = JSON.stringify({
          price: sig.price,
          prev_close: sig.prevClose,
          change_pct: sig.changePct,
          day_high: result.quote.dayHigh,
          day_low: result.quote.dayLow,
          day_open: result.quote.dayOpen,
        });
        await insertSignal(env.DB, sig.symbol, sig.ts, sig.setup, sig.direction, sig.notes, features);

        if (webhookUrl) {
          try {
            await postDiscordSignal(webhookUrl, sig);
            notified += 1;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            errorText = errorText
              ? `${errorText}\n${symbol} discord: ${msg}`
              : `${symbol} discord: ${msg}`;
          }
        }
      }
    } catch (err) {
      errors += 1;
      const msg = err instanceof Error ? err.message : String(err);
      errorText = errorText ? `${errorText}\n${symbol}: ${msg}` : `${symbol}: ${msg}`;
      if (err instanceof RateLimitError) break;
    }
  }

  await finishIngestRun(env.DB, runId, tickers.length, apiCalls, errors, errorText);
  return { ran: true, symbols: tickers.length, apiCalls, errors, signals: signalsFound, notified };
}
