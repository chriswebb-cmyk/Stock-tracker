import type { Ticker } from '../../../shared/types';

interface Props {
  tickers: Ticker[];
  selected: string | null;
  onSelect: (symbol: string) => void;
}

export function Watchlist({ tickers, selected, onSelect }: Props) {
  return (
    <ul className="divide-y divide-slate-800">
      {tickers.map((t) => {
        const isActive = t.symbol === selected;
        return (
          <li key={t.symbol}>
            <button
              type="button"
              onClick={() => onSelect(t.symbol)}
              className={
                'w-full px-4 py-3 text-left flex items-center justify-between transition-colors ' +
                (isActive ? 'bg-slate-800 text-white' : 'hover:bg-slate-900 text-slate-200')
              }
            >
              <span className="font-medium tracking-wide">{t.symbol}</span>
              {!t.enabled && (
                <span className="text-xs text-slate-500">disabled</span>
              )}
            </button>
          </li>
        );
      })}
      {tickers.length === 0 && (
        <li className="px-4 py-6 text-sm text-slate-500">No tickers yet.</li>
      )}
    </ul>
  );
}
