import { useEffect, useRef } from 'react';
import {
  createChart,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type SeriesMarker,
  type Time,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { Bar } from '../../../shared/types';
import type { SignalRow } from '../api';
import { bollinger, ema, sessionVwap } from '../indicators';

interface Props {
  bars: Bar[];
  signals: SignalRow[];
}

const SETUP_LABEL: Record<string, string> = {
  vwap_reclaim_long: 'VWAP rec',
  vwap_reject_short: 'VWAP rej',
  orb_breakout_long: 'ORB up',
  orb_breakdown_short: 'ORB down',
  bb_squeeze_release_long: 'BB up',
  bb_squeeze_release_short: 'BB down',
  rsi_oversold_reversal: 'RSI rev',
  rsi_overbought_reversal: 'RSI rev',
};

export function PriceChart({ bars, signals }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const vwapRef = useRef<ISeriesApi<'Line'> | null>(null);
  const ema9Ref = useRef<ISeriesApi<'Line'> | null>(null);
  const ema20Ref = useRef<ISeriesApi<'Line'> | null>(null);
  const bbUpperRef = useRef<ISeriesApi<'Line'> | null>(null);
  const bbLowerRef = useRef<ISeriesApi<'Line'> | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: { background: { color: '#020617' }, textColor: '#cbd5e1' },
      grid: {
        vertLines: { color: '#1e293b' },
        horzLines: { color: '#1e293b' },
      },
      timeScale: { timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: '#334155' },
    });
    candleRef.current = chart.addCandlestickSeries({
      upColor: '#22c55e',
      downColor: '#ef4444',
      borderUpColor: '#22c55e',
      borderDownColor: '#ef4444',
      wickUpColor: '#22c55e',
      wickDownColor: '#ef4444',
    });
    vwapRef.current = chart.addLineSeries({
      color: '#a855f7',
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      title: 'VWAP',
    });
    ema9Ref.current = chart.addLineSeries({
      color: '#38bdf8',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      title: 'EMA9',
    });
    ema20Ref.current = chart.addLineSeries({
      color: '#facc15',
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      title: 'EMA20',
    });
    bbUpperRef.current = chart.addLineSeries({
      color: '#475569',
      lineWidth: 1,
      lineStyle: 2, // dashed
      priceLineVisible: false,
      lastValueVisible: false,
      title: 'BB upper',
    });
    bbLowerRef.current = chart.addLineSeries({
      color: '#475569',
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      title: 'BB lower',
    });
    chartRef.current = chart;
    return () => {
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      vwapRef.current = null;
      ema9Ref.current = null;
      ema20Ref.current = null;
      bbUpperRef.current = null;
      bbLowerRef.current = null;
    };
  }, []);

  useEffect(() => {
    const candle = candleRef.current;
    if (!candle) return;

    const candleData = bars.map((b) => ({
      time: b.ts as UTCTimestamp,
      open: b.open,
      high: b.high,
      low: b.low,
      close: b.close,
    }));
    candle.setData(candleData);

    const closes = bars.map((b) => b.close);
    const vwapVals = sessionVwap(bars);
    const ema9Vals = ema(closes, 9);
    const ema20Vals = ema(closes, 20);
    const bbVals = bollinger(closes, 20, 2);

    const lineFrom = (vals: (number | null)[]): LineData[] =>
      bars
        .map((b, i) => {
          const v = vals[i];
          return v == null ? null : { time: b.ts as UTCTimestamp, value: v };
        })
        .filter((x): x is LineData => x !== null);

    vwapRef.current?.setData(lineFrom(vwapVals));
    ema9Ref.current?.setData(lineFrom(ema9Vals));
    ema20Ref.current?.setData(lineFrom(ema20Vals));
    bbUpperRef.current?.setData(lineFrom(bbVals.map((p) => p.upper)));
    bbLowerRef.current?.setData(lineFrom(bbVals.map((p) => p.lower)));

    const firstTs = bars[0]?.ts ?? 0;
    const lastTs = bars[bars.length - 1]?.ts ?? Number.POSITIVE_INFINITY;
    const markers: SeriesMarker<Time>[] = signals
      .filter((s) => s.ts >= firstTs && s.ts <= lastTs)
      .map((s) => ({
        time: s.ts as UTCTimestamp,
        position: s.direction === 'long' ? 'belowBar' : 'aboveBar',
        color: s.direction === 'long' ? '#22c55e' : '#ef4444',
        shape: s.direction === 'long' ? 'arrowUp' : 'arrowDown',
        text:
          (SETUP_LABEL[s.setup] ?? s.setup) +
          (s.ml_probability != null ? ` ${(s.ml_probability * 100).toFixed(0)}%` : ''),
      }));
    candle.setMarkers(markers);

    chartRef.current?.timeScale().fitContent();
  }, [bars, signals]);

  return <div ref={containerRef} className="w-full h-full" />;
}
