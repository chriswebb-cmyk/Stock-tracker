import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { RedditDiamond, RedditPost, RedditTrending } from '../../../shared/types';

type Mode = 'trending' | 'diamonds';
type Window = '6h' | '24h' | '7d';

const WINDOWS: Window[] = ['6h', '24h', '7d'];

interface Props {
  // Clicking a row in this panel calls onSelectSymbol so the parent can sync
  // the Chart tab to that ticker. The post-list filter is driven by
  // filterSymbol (internal state), so the chart's current symbol doesn't
  // narrow what posts the user sees here by default.
  onSelectSymbol: (symbol: string) => void;
}

export function RedditPanel({ onSelectSymbol }: Props) {
  const [mode, setMode] = useState<Mode>('trending');
  const [windowSize, setWindowSize] = useState<Window>('24h');
  const [trending, setTrending] = useState<RedditTrending[]>([]);
  const [diamonds, setDiamonds] = useState<RedditDiamond[]>([]);
  const [posts, setPosts] = useState<RedditPost[]>([]);
  const [filterSymbol, setFilterSymbol] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [scraping, setScraping] = useState(false);
  const [scrapeStatus, setScrapeStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const [aggregate, postList] = await Promise.all([
        mode === 'trending' ? api.redditTrending(windowSize, 30) : api.redditDiamonds('6h', '7d', 20),
        api.redditPosts(filterSymbol, 25),
      ]);
      if (signal?.aborted) return;
      if (mode === 'trending') setTrending(aggregate as RedditTrending[]);
      else setDiamonds(aggregate as RedditDiamond[]);
      setPosts(postList);
    } catch (e) {
      if (signal?.aborted) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [mode, windowSize, filterSymbol]);

  useEffect(() => {
    const ctrl = new AbortController();
    reload(ctrl.signal);
    const id = window.setInterval(() => reload(ctrl.signal), 60_000);
    return () => {
      ctrl.abort();
      window.clearInterval(id);
    };
  }, [reload]);

  const handleRowClick = (symbol: string) => {
    setFilterSymbol(symbol);
    onSelectSymbol(symbol);
  };

  const handleRefresh = async () => {
    setScraping(true);
    setScrapeStatus(null);
    setError(null);
    try {
      const r = await api.redditScrape();
      setScrapeStatus(`Scraped ${r.postsSeen} posts (${r.postsNew} new, ${r.mentions} mentions${r.errors > 0 ? `, ${r.errors} errors` : ''})`);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setScraping(false);
    }
  };

  const rows = useMemo(() => (mode === 'trending' ? trending : diamonds), [mode, trending, diamonds]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 px-3 sm:px-4 py-2">
        <div className="flex gap-1">
          <ModeButton active={mode === 'trending'} onClick={() => setMode('trending')}>
            Trending
          </ModeButton>
          <ModeButton active={mode === 'diamonds'} onClick={() => setMode('diamonds')}>
            Hidden Diamonds
          </ModeButton>
        </div>
        {mode === 'trending' && (
          <div className="flex gap-1">
            {WINDOWS.map((w) => (
              <button
                key={w}
                type="button"
                onClick={() => setWindowSize(w)}
                className={
                  'px-2 py-1 text-xs rounded ' +
                  (w === windowSize
                    ? 'bg-slate-700 text-white'
                    : 'text-slate-400 hover:bg-slate-800')
                }
              >
                {w}
              </button>
            ))}
          </div>
        )}
        {mode === 'diamonds' && (
          <span className="text-xs text-slate-500">6h spike vs. 7d baseline</span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {scrapeStatus && (
            <span className="hidden sm:inline text-xs text-emerald-400">{scrapeStatus}</span>
          )}
          <button
            type="button"
            onClick={handleRefresh}
            disabled={scraping}
            className={
              'px-2.5 py-1 text-xs rounded border border-slate-700 ' +
              (scraping
                ? 'text-slate-500 cursor-not-allowed'
                : 'text-slate-200 hover:bg-slate-800 hover:border-slate-600')
            }
            title="Run a fresh Reddit scrape now"
          >
            {scraping ? 'Scraping…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-rose-950 text-rose-200 text-xs px-4 py-2 border-b border-rose-900">
          {error}
        </div>
      )}

      <div className="flex-1 grid grid-rows-[auto_1fr] md:grid-rows-1 md:grid-cols-[280px_1fr] min-h-0">
        <div className="border-b md:border-b-0 md:border-r border-slate-800 overflow-y-auto max-h-[40vh] md:max-h-none">
          <table className="w-full text-xs sm:text-sm">
            <thead className="text-[10px] sm:text-xs uppercase tracking-wider text-slate-500 sticky top-0 bg-slate-950">
              <tr>
                <th className="text-left px-2 py-1.5">Sym</th>
                <th className="text-right px-2 py-1.5">Ment.</th>
                <th className="text-right px-2 py-1.5">Sent.</th>
                {mode === 'diamonds' && <th className="text-right px-2 py-1.5">Spike</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.symbol}
                  className={
                    'border-t border-slate-900 cursor-pointer hover:bg-slate-900 ' +
                    (r.symbol === filterSymbol ? 'bg-slate-800' : '')
                  }
                  onClick={() => handleRowClick(r.symbol)}
                >
                  <td className="px-2 py-1.5 font-medium">{r.symbol}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {r.mentions}
                    <span className="hidden sm:inline text-slate-500 text-xs"> / {r.posts}p</span>
                  </td>
                  <td className={'px-2 py-1.5 text-right tabular-nums ' + sentimentColor(r.netSentiment)}>
                    {formatSentiment(r.netSentiment)}
                  </td>
                  {mode === 'diamonds' && (
                    <td className="px-2 py-1.5 text-right tabular-nums text-amber-300">
                      {(r as RedditDiamond).spikeRatio.toFixed(1)}×
                    </td>
                  )}
                </tr>
              ))}
              {!loading && rows.length === 0 && (
                <tr>
                  <td colSpan={mode === 'diamonds' ? 4 : 3} className="px-3 py-6 text-center text-slate-500 text-sm">
                    No data yet — has the scraper run?
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="overflow-y-auto min-h-0">
          <div className="px-3 sm:px-4 py-2 text-xs uppercase tracking-wider text-slate-500 border-b border-slate-800 flex items-center justify-between gap-2">
            <span className="truncate">{filterSymbol ? `Posts mentioning ${filterSymbol}` : 'Latest posts'}</span>
            {filterSymbol && (
              <button
                type="button"
                onClick={() => setFilterSymbol(null)}
                className="shrink-0 text-xs normal-case tracking-normal text-slate-400 hover:text-slate-200"
              >
                clear
              </button>
            )}
          </div>
          <ul className="divide-y divide-slate-900">
            {posts.map((p) => (
              <li key={p.id} className="px-3 sm:px-4 py-3 hover:bg-slate-900">
                <a
                  href={safeHref(p.permalink, p.url)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block"
                >
                  <div className="text-sm text-slate-100 leading-snug">{p.title}</div>
                  <div className="mt-1 text-xs text-slate-500 flex flex-wrap gap-x-3 gap-y-1">
                    <span>r/{p.subreddit}</span>
                    {p.author && <span className="hidden sm:inline">u/{p.author}</span>}
                    <span>{p.score.toLocaleString()} ▲</span>
                    <span>{p.numComments} 💬</span>
                    <span>{relativeTime(p.createdUtc)}</span>
                    {p.flair && (
                      <span className="px-1.5 py-0.5 rounded bg-slate-800 text-slate-300">
                        {p.flair}
                      </span>
                    )}
                  </div>
                </a>
              </li>
            ))}
            {posts.length === 0 && (
              <li className="px-4 py-6 text-sm text-slate-500">No posts yet.</li>
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'px-3 py-1 text-xs rounded ' +
        (active ? 'bg-slate-700 text-white' : 'text-slate-400 hover:bg-slate-800')
      }
    >
      {children}
    </button>
  );
}

function formatSentiment(s: number): string {
  if (s === 0) return '0.00';
  return (s > 0 ? '+' : '') + s.toFixed(2);
}

function sentimentColor(s: number): string {
  if (s > 0.15) return 'text-emerald-400';
  if (s < -0.15) return 'text-rose-400';
  return 'text-slate-400';
}

// Reddit feeds the URL/permalink fields verbatim; a malicious post could
// inject 'javascript:...' there. Only allow http(s) URLs to land in href.
function safeHref(...candidates: (string | null | undefined)[]): string {
  for (const c of candidates) {
    if (typeof c === 'string' && /^https?:\/\//i.test(c)) return c;
  }
  return '#';
}

function relativeTime(unixSeconds: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSeconds;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
