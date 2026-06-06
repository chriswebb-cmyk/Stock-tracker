import type { Bar, BarInterval } from '../../../shared/types';

const BASE = 'https://finnhub.io/api/v1';

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitError';
  }
}

export class FinnhubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FinnhubError';
  }
}

interface QuoteResponse {
  c: number;  // current price
  d: number | null;  // change
  dp: number | null; // change %
  h: number;  // day high
  l: number;  // day low
  o: number;  // day open
  pc: number; // previous close
  t: number;  // unix seconds
}

export interface Quote {
  current: number;
  dayOpen: number;
  dayHigh: number;
  dayLow: number;
  prevClose: number;
}

export interface QuoteResult {
  bar: Bar;
  quote: Quote;
}

export class FinnhubClient {
  constructor(private readonly apiKey: string) {}

  private async get<T>(path: string, params: Record<string, string>, timeoutMs = 5_000): Promise<T> {
    const url = new URL(`${BASE}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('token', this.apiKey);
    // Bound wall-clock time so a hung Finnhub request can't burn the cron's
    // 30s budget and prevent finishIngestRun() from running.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url.toString(), {
        headers: { 'User-Agent': 'stock-tracker/0.1' },
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === 'AbortError') {
        throw new FinnhubError(`Finnhub timeout for ${path}`);
      }
      throw err;
    }
    clearTimeout(timer);
    if (res.status === 429) {
      throw new RateLimitError('Finnhub rate limit hit');
    }
    if (!res.ok) {
      throw new FinnhubError(`HTTP ${res.status} from Finnhub`);
    }
    return (await res.json()) as T;
  }

  // Free tier doesn't expose intraday candles, so we synthesize a 1-minute bar
  // from the realtime quote on each poll. open/high/low reflect the day so far,
  // close is the current price. Volume isn't available on /quote and is set to 0.
  async quoteBar(symbol: string, interval: BarInterval, now: Date): Promise<QuoteResult | null> {
    const q = await this.get<QuoteResponse>('/quote', { symbol });
    if (!q || q.c === 0 || q.t === 0) return null;
    const ts = Math.floor(now.getTime() / 60_000) * 60;
    return {
      bar: {
        symbol,
        interval,
        ts,
        open: q.o,
        high: q.h,
        low: q.l,
        close: q.c,
        volume: 0,
      },
      quote: {
        current: q.c,
        dayOpen: q.o,
        dayHigh: q.h,
        dayLow: q.l,
        prevClose: q.pc,
      },
    };
  }
}

// Token bucket rate limiter. Finnhub free tier allows 60 req/min.
export class RateLimiter {
  private tokens: number;
  private last: number;
  constructor(private readonly perMinute: number) {
    this.tokens = perMinute;
    this.last = Date.now();
  }

  async take(n = 1): Promise<void> {
    this.refill();
    while (this.tokens < n) {
      const waitMs = Math.ceil(((n - this.tokens) / this.perMinute) * 60_000);
      await new Promise((r) => setTimeout(r, Math.min(waitMs, 5_000)));
      this.refill();
    }
    this.tokens -= n;
  }

  private refill() {
    const now = Date.now();
    const elapsedMin = (now - this.last) / 60_000;
    this.tokens = Math.min(this.perMinute, this.tokens + elapsedMin * this.perMinute);
    this.last = now;
  }
}
