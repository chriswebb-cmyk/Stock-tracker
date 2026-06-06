import { useEffect, useState } from 'react';
import { api, type NewsItem } from '../api';

interface Props {
  symbol: string | null;
}

function relative(unixSec: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSec;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// Only render hrefs that look like real http(s) URLs. Finnhub usually
// returns clean URLs but this is cheap defense.
function safeHref(u: string | null | undefined): string {
  return typeof u === 'string' && /^https?:\/\//i.test(u) ? u : '#';
}

export function NewsPanel({ symbol }: Props) {
  const [news, setNews] = useState<NewsItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!symbol) {
      setNews(null);
      return;
    }
    let cancelled = false;
    setError(null);
    api
      .news(symbol, 20)
      .then((rows) => {
        if (!cancelled) setNews(rows);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [symbol]);

  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="flex items-center justify-between border-b border-slate-800 px-3 sm:px-4 py-1.5 bg-slate-950/80 sticky top-0">
        <div className="text-xs uppercase tracking-wider text-slate-500">
          News {symbol ? `· ${symbol}` : ''}
        </div>
        {error && <span className="text-xs text-rose-400 truncate ml-2">{error}</span>}
      </div>
      <ul className="divide-y divide-slate-900 overflow-y-auto">
        {news === null && !error && (
          <li className="px-4 py-3 text-sm text-slate-500">Loading…</li>
        )}
        {news && news.length === 0 && (
          <li className="px-4 py-3 text-sm text-slate-500">No recent news.</li>
        )}
        {news?.map((n) => (
          <li key={n.id} className="px-3 sm:px-4 py-2 hover:bg-slate-900">
            <a
              href={safeHref(n.url)}
              target="_blank"
              rel="noopener noreferrer"
              className="block"
            >
              <div className="text-sm text-slate-100 leading-snug">{n.headline}</div>
              <div className="mt-0.5 text-xs text-slate-500 flex gap-3 flex-wrap">
                <span>{n.source}</span>
                <span>{relative(n.datetime)}</span>
              </div>
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
