import type { Bar, BarInterval } from '../../../shared/types';

const BASE = 'https://query1.finance.yahoo.com/v8/finance/chart';

export class YahooError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'YahooError';
  }
}

interface YahooChartResult {
  chart: {
    result: Array<{
      meta: {
        symbol: string;
        regularMarketPrice?: number;
        chartPreviousClose?: number;
        previousClose?: number;
      };
      timestamp?: number[];
      indicators: {
        quote: Array<{
          open?: (number | null)[];
          high?: (number | null)[];
          low?: (number | null)[];
          close?: (number | null)[];
          volume?: (number | null)[];
        }>;
      };
    }> | null;
    error: { code: string; description: string } | null;
  };
}

export interface YahooFetchResult {
  bars: Bar[];
  prevClose: number | null;
  current: number | null;
  dayHigh: number | null;
  dayLow: number | null;
  dayOpen: number | null;
}

// Yahoo intraday history caps:
//  1m: last 7 days, 2m: 60d, 5m: 60d, 15m: 60d, 30m: 60d, 60m: 730d, 1d: years.
const YAHOO_INTERVAL: Record<BarInterval, string> = {
  '1min': '1m',
  '5min': '5m',
  '15min': '15m',
  '30min': '30m',
  '60min': '60m',
};

export class YahooClient {
  async chart(symbol: string, interval: BarInterval, range: string): Promise<YahooFetchResult> {
    const url = new URL(`${BASE}/${encodeURIComponent(symbol)}`);
    url.searchParams.set('interval', YAHOO_INTERVAL[interval]);
    url.searchParams.set('range', range);
    url.searchParams.set('includePrePost', 'false');

    const res = await fetch(url.toString(), {
      headers: {
        // Yahoo blocks default fetch UA. Anything browser-ish works.
        'User-Agent': 'Mozilla/5.0 (compatible; stock-tracker/0.1)',
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      throw new YahooError(`HTTP ${res.status} from Yahoo for ${symbol}`);
    }
    const json = (await res.json()) as YahooChartResult;
    if (json.chart.error) {
      throw new YahooError(`${json.chart.error.code}: ${json.chart.error.description}`);
    }
    const result = json.chart.result?.[0];
    if (!result) {
      throw new YahooError(`No chart result for ${symbol}`);
    }

    const ts = result.timestamp ?? [];
    const q = result.indicators.quote[0] ?? {};
    const opens = q.open ?? [];
    const highs = q.high ?? [];
    const lows = q.low ?? [];
    const closes = q.close ?? [];
    const volumes = q.volume ?? [];

    const bars: Bar[] = [];
    let dayHigh: number | null = null;
    let dayLow: number | null = null;
    let dayOpen: number | null = null;
    let lastClose: number | null = null;
    for (let i = 0; i < ts.length; i++) {
      const o = opens[i];
      const h = highs[i];
      const l = lows[i];
      const c = closes[i];
      const v = volumes[i] ?? 0;
      if (o == null || h == null || l == null || c == null) continue;
      bars.push({
        symbol,
        interval,
        ts: ts[i],
        open: o,
        high: h,
        low: l,
        close: c,
        volume: v,
      });
      if (dayOpen === null) dayOpen = o;
      dayHigh = dayHigh === null ? h : Math.max(dayHigh, h);
      dayLow = dayLow === null ? l : Math.min(dayLow, l);
      lastClose = c;
    }

    const prevClose = result.meta.chartPreviousClose ?? result.meta.previousClose ?? null;
    const current = result.meta.regularMarketPrice ?? lastClose;

    return { bars, prevClose, current, dayHigh, dayLow, dayOpen };
  }

  // Convenience: pull today's 1-min bars + meta.
  latest(symbol: string, interval: BarInterval = '1min'): Promise<YahooFetchResult> {
    return this.chart(symbol, interval, '1d');
  }
}
