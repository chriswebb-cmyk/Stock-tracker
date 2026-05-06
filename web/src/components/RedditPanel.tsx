import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import type { RedditDiamond, RedditPost, RedditTrending } from '../../../shared/types';

type Mode = 'trending' | 'diamonds';
type Window = '6h' | '24h' | '7d';

const WINDOWS: Window[] = ['6h', '24h', '7d'];

interface Props {
  // When set, the parent's selected ticker is reflected back here so the post
  // list filters down. Clicking a row in this panel calls onSelectSymbol so
  // the parent can sync the chart tab.
  selectedSymbol: string | null;
  onSelectSymbol: (symbol: string) => void;
}

export function RedditPanel({ selectedSymbol, onSelectSymbol }: Props) {
  const [mode, setMode] = useState<Mode>('trending');
  const [windowSize, setWindowSize] = useState<Window>('24h');
  const [trending, setTrending] = useState<RedditTrending[]>([]);
  const [diamonds, setDiamonds] = useState<RedditDiamond[]>([]);
  const [posts, setPosts] = useState<RedditPost[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const load = async () => {
      try {
        if (mode === 'trending') {
          const data = await api.redditTrending(windowSize, 30);
          if (!cancelled) setTrending(data);
        } else {
          const data = await api.redditDiamonds('6h', '7d', 20);
          if (!cancelled) setDiamonds(data);
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    load();
    const id = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [mode, windowSize]);

  useEffect(() => {
    let cancelled = false;
    api
      .redditPosts(selectedSymbol, 25)
      .then((p) => {
        if (!cancelled) setPosts(p);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSymbol]);

  const rows = useMemo(() => (mode === 'trending' ? trending : diamonds), [mode, trending, diamonds]);

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center gap-3 border-b border-slate-800 px-4 py-2">
        <div className="flex gap-1">
          <ModeButton active={mode === 'trending'} onClick={() => setMode('trending')}>
            Trending
          </ModeButton>
          <ModeButton active={mode === 'diamonds'} onClick={() => setMode('diamonds')}>
            Hidden Diamonds
          </ModeButton>
        </div>
        {mode === 'trending' && (
          <div className="flex gap-1 ml-auto">
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
          <span className="ml-auto text-xs text-slate-500">
            6h spike vs. 7d baseline
          </span>
        )}
      </div>

      {error && (
        <div className="bg-rose-950 text-rose-200 text-xs px-4 py-2 border-b border-rose-900">
          {error}
        </div>
      )}

      <div className="flex-1 grid grid-cols-[320px_1fr] min-h-0">
        <div className="border-r border-slate-800 overflow-y-auto">
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wider text-slate-500 sticky top-0 bg-slate-950">
              <tr>
                <th className="text-left px-3 py-2">Symbol</th>
                <th className="text-right px-3 py-2">Mentions</th>
                <th className="text-right px-3 py-2">Sent.</th>
                {mode === 'diamonds' && <th className="text-right px-3 py-2">Spike</th>}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.symbol}
                  className={
                    'border-t border-slate-900 cursor-pointer hover:bg-slate-900 ' +
                    (r.symbol === selectedSymbol ? 'bg-slate-800' : '')
                  }
                  onClick={() => onSelectSymbol(r.symbol)}
                >
                  <td className="px-3 py-2 font-medium">{r.symbol}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {r.mentions}
                    <span className="text-slate-500 text-xs"> / {r.posts}p</span>
                  </td>
                  <td className={'px-3 py-2 text-right tabular-nums ' + sentimentColor(r.netSentiment)}>
                    {formatSentiment(r.netSentiment)}
                  </td>
                  {mode === 'diamonds' && (
                    <td className="px-3 py-2 text-right tabular-nums text-amber-300">
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

        <div className="overflow-y-auto">
          <div className="px-4 py-2 text-xs uppercase tracking-wider text-slate-500 border-b border-slate-800">
            {selectedSymbol ? `Posts mentioning ${selectedSymbol}` : 'Latest posts'}
          </div>
          <ul className="divide-y divide-slate-900">
            {posts.map((p) => (
              <li key={p.id} className="px-4 py-3 hover:bg-slate-900">
                <a
                  href={p.permalink ?? p.url ?? '#'}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="block"
                >
                  <div className="text-sm text-slate-100 leading-snug">{p.title}</div>
                  <div className="mt-1 text-xs text-slate-500 flex gap-3">
                    <span>r/{p.subreddit}</span>
                    {p.author && <span>u/{p.author}</span>}
                    <span>{p.score.toLocaleString()} ▲</span>
                    <span>{p.numComments} comments</span>
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

function relativeTime(unixSeconds: number): string {
  const diff = Math.floor(Date.now() / 1000) - unixSeconds;
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}
