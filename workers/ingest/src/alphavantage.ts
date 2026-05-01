import type { Bar, BarInterval, OptionContract } from '../../../shared/types';

const BASE = 'https://www.alphavantage.co/query';

export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateLimitError';
  }
}

export class AlphaVantageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AlphaVantageError';
  }
}

interface IntradayResponse {
  // Alpha Vantage returns a dynamic key like 'Time Series (1min)'. We probe
  // for the first key starting with 'Time Series'.
  [key: string]: unknown;
  'Meta Data'?: Record<string, string>;
  Note?: string;            // sent when rate limit is hit
  Information?: string;     // sent for invalid keys / messages
  'Error Message'?: string;
}

type RawBar = {
  '1. open': string;
  '2. high': string;
  '3. low': string;
  '4. close': string;
  '5. volume': string;
};

type RawOption = {
  contractID: string;
  symbol: string;
  expiration: string;
  strike: string;
  type: string;
  last: string;
  mark?: string;
  bid?: string;
  ask?: string;
  volume?: string;
  open_interest?: string;
  implied_volatility?: string;
  delta?: string;
  gamma?: string;
  theta?: string;
  vega?: string;
  rho?: string;
};

interface RealtimeOptionsResponse {
  endpoint?: string;
  message?: string;
  data?: RawOption[];
  Note?: string;
  Information?: string;
  'Error Message'?: string;
}

function parseNumber(s: string | undefined | null): number | null {
  if (s === undefined || s === null || s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// AV intraday timestamps are 'YYYY-MM-DD HH:mm:ss' in US/Eastern. We convert
// to unix seconds UTC by treating them as ET. Workers don't have IANA zones,
// so we apply a fixed -05:00 / -04:00 offset based on US DST rules.
function etToUnix(ts: string): number {
  // Format: 'YYYY-MM-DD HH:mm:ss'
  const [date, time] = ts.split(' ');
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi, s] = time.split(':').map(Number);
  // US DST: second Sunday of March 02:00 -> first Sunday of November 02:00
  const offsetHours = isUsDst(y, mo, d, h) ? 4 : 5;
  const utcMs = Date.UTC(y, mo - 1, d, h + offsetHours, mi, s);
  return Math.floor(utcMs / 1000);
}

function isUsDst(y: number, mo: number, d: number, h: number): boolean {
  if (mo < 3 || mo > 11) return false;
  if (mo > 3 && mo < 11) return true;
  // March: DST starts second Sunday at 02:00
  if (mo === 3) {
    const secondSunday = nthWeekday(y, 3, 0, 2);
    if (d > secondSunday) return true;
    if (d < secondSunday) return false;
    return h >= 2;
  }
  // November: DST ends first Sunday at 02:00
  const firstSunday = nthWeekday(y, 11, 0, 1);
  if (d < firstSunday) return true;
  if (d > firstSunday) return false;
  return h < 2;
}

function nthWeekday(year: number, month1to12: number, weekday: number, n: number): number {
  // Returns day-of-month for the nth occurrence of `weekday` (0=Sun) in
  // `month1to12` of `year`.
  const first = new Date(Date.UTC(year, month1to12 - 1, 1)).getUTCDay();
  const offset = (weekday - first + 7) % 7;
  return 1 + offset + (n - 1) * 7;
}

export class AlphaVantageClient {
  constructor(private readonly apiKey: string) {}

  private async get<T>(params: Record<string, string>): Promise<T> {
    const url = new URL(BASE);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set('apikey', this.apiKey);
    const res = await fetch(url.toString(), {
      headers: { 'User-Agent': 'stock-tracker/0.1' },
    });
    if (!res.ok) {
      throw new AlphaVantageError(`HTTP ${res.status} from Alpha Vantage`);
    }
    const json = (await res.json()) as Record<string, unknown>;
    // AV returns 200 OK with a Note/Information body when rate-limited or
    // when the key is invalid. Surface those as proper errors.
    const note = (json.Note ?? json.Information) as string | undefined;
    if (note && typeof note === 'string') {
      if (/call frequency|rate/i.test(note)) throw new RateLimitError(note);
      throw new AlphaVantageError(note);
    }
    if (typeof json['Error Message'] === 'string') {
      throw new AlphaVantageError(json['Error Message'] as string);
    }
    return json as T;
  }

  async intraday(symbol: string, interval: BarInterval, outputsize: 'compact' | 'full' = 'compact'): Promise<Bar[]> {
    const json = await this.get<IntradayResponse>({
      function: 'TIME_SERIES_INTRADAY',
      symbol,
      interval,
      outputsize,
      adjusted: 'true',
      extended_hours: 'false',
      datatype: 'json',
    });
    const seriesKey = Object.keys(json).find((k) => k.startsWith('Time Series'));
    if (!seriesKey) {
      throw new AlphaVantageError(`No time series in response for ${symbol}`);
    }
    const series = json[seriesKey] as Record<string, RawBar>;
    const bars: Bar[] = [];
    for (const [ts, raw] of Object.entries(series)) {
      bars.push({
        symbol,
        interval,
        ts: etToUnix(ts),
        open: Number(raw['1. open']),
        high: Number(raw['2. high']),
        low: Number(raw['3. low']),
        close: Number(raw['4. close']),
        volume: Number(raw['5. volume']),
      });
    }
    bars.sort((a, b) => a.ts - b.ts);
    return bars;
  }

  async realtimeOptions(symbol: string): Promise<OptionContract[]> {
    const json = await this.get<RealtimeOptionsResponse>({
      function: 'REALTIME_OPTIONS',
      symbol,
      require_greeks: 'true',
      datatype: 'json',
    });
    const fetchedAt = Math.floor(Date.now() / 1000);
    const data = json.data ?? [];
    return data.map((o) => ({
      underlying: symbol,
      fetchedAt,
      contract: o.contractID,
      expiration: o.expiration,
      strike: Number(o.strike),
      type: o.type === 'call' ? 'call' : 'put',
      bid: parseNumber(o.bid),
      ask: parseNumber(o.ask),
      last: parseNumber(o.last),
      volume: parseNumber(o.volume),
      openInterest: parseNumber(o.open_interest),
      impliedVol: parseNumber(o.implied_volatility),
      delta: parseNumber(o.delta),
      gamma: parseNumber(o.gamma),
      theta: parseNumber(o.theta),
      vega: parseNumber(o.vega),
      rho: parseNumber(o.rho),
    }));
  }
}

// Simple budget-based rate limiter. AV paid tiers are documented as
// requests-per-minute; we treat the budget as a token bucket.
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
