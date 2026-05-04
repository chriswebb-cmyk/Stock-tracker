import { FinnhubClient, RateLimiter, RateLimitError } from './finnhub';
import { YahooClient, YahooError } from './yahoo';
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
      const result = await runIngest(env, new Date(), { force: true });
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
  yahooOk: number;
  finnhubFallback: number;
  errors: number;
  signals: number;
  notified: number;
  barsWritten: number;
}> {
  if (!opts.force && !isMarketHoursEt(now)) {
    return { ran: false, symbols: 0, apiCalls: 0, yahooOk: 0, finnhubFallback: 0, errors: 0, signals: 0, notified: 0, barsWritten: 0 };
  }

  const runId = await startIngestRun(env.DB);
  const tickers = await listEnabledTickers(env.DB);
  const yahoo = new YahooClient();
  const finnhub = env.FINNHUB_API_KEY ? new FinnhubClient(env.FINNHUB_API_KEY) : null;
  const finnhubRpm = Number(env.FINNHUB_REQUESTS_PER_MINUTE ?? '60');
  const finnhubLimiter = new RateLimiter(finnhubRpm);
  const cooldownSec = Number(env.SIGNAL_COOLDOWN_SECONDS ?? '1800');
  const webhookUrl = env.DISCORD_WEBHOOK_URL?.trim();

  let apiCalls = 0;
  let yahooOk = 0;
  let finnhubFallback = 0;
  let errors = 0;
  let signalsFound = 0;
  let notified = 0;
  let barsWritten = 0;
  let errorText: string | null = null;

  for (const symbol of tickers) {
    let signalQuote: { current: number; dayOpen: number; dayHigh: number; dayLow: number; prevClose: number } | null = null;
    let signalTs: number | null = null;

    try {
      const result = await yahoo.latest(symbol, '1min');
      apiCalls += 1;
      yahooOk += 1;
      if (result.bars.length > 0) {
        await upsertBars(env.DB, result.bars);
        barsWritten += result.bars.length;
        const last = result.bars[result.bars.length - 1];
        if (
          result.prevClose != null &&
          result.dayHigh != null &&
          result.dayLow != null &&
          result.dayOpen != null
        ) {
          signalQuote = {
            current: result.current ?? last.close,
            dayOpen: result.dayOpen,
            dayHigh: result.dayHigh,
            dayLow: result.dayLow,
            prevClose: result.prevClose,
          };
          signalTs = last.ts;
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errorText = errorText ? `${errorText}\nyahoo ${symbol}: ${msg}` : `yahoo ${symbol}: ${msg}`;

      if (finnhub) {
        try {
          await finnhubLimiter.take(1);
          const result = await finnhub.quoteBar(symbol, '1min', now);
          apiCalls += 1;
          finnhubFallback += 1;
          if (result) {
            await upsertBars(env.DB, [result.bar]);
            barsWritten += 1;
            signalQuote = result.quote;
            signalTs = result.bar.ts;
          }
        } catch (fbErr) {
          errors += 1;
          const fbMsg = fbErr instanceof Error ? fbErr.message : String(fbErr);
          errorText = errorText ? `${errorText}\nfinnhub ${symbol}: ${fbMsg}` : `finnhub ${symbol}: ${fbMsg}`;
          if (fbErr instanceof RateLimitError) break;
        }
      } else {
        errors += 1;
      }
    }

    if (signalQuote && signalTs !== null) {
      const detected = detectSignals(symbol, signalTs, signalQuote);
      for (const sig of detected) {
        signalsFound += 1;
        const last = await lastSignalTs(env.DB, sig.symbol, sig.setup);
        if (last !== null && sig.ts - last < cooldownSec) continue;

        const features = JSON.stringify({
          price: sig.price,
          prev_close: sig.prevClose,
          change_pct: sig.changePct,
          day_high: signalQuote.dayHigh,
          day_low: signalQuote.dayLow,
          day_open: signalQuote.dayOpen,
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
    }
  }

  await finishIngestRun(env.DB, runId, tickers.length, apiCalls, errors, errorText);
  return {
    ran: true,
    symbols: tickers.length,
    apiCalls,
    yahooOk,
    finnhubFallback,
    errors,
    signals: signalsFound,
    notified,
    barsWritten,
  };
}

// Pulls `days` of 1-min bars (Yahoo caps at 7d for 1m) for every enabled
// ticker and stores them. Run once after deploy to seed history.
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
      if (err instanceof YahooError && /rate|429/i.test(msg)) {
        errorText = errorText ? `${errorText}\n${symbol}: ${msg} (aborting)` : `${symbol}: ${msg} (aborting)`;
        break;
      }
      errorText = errorText ? `${errorText}\n${symbol}: ${msg}` : `${symbol}: ${msg}`;
    }
  }

  return { symbols: tickers.length, barsWritten, errors, errorText };
}
