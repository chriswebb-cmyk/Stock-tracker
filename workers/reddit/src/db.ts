import type { RedditPostRaw } from './reddit';
import type { ExtractedMention } from './extract';

export interface NormalizedPost {
  id: string;
  subreddit: string;
  author: string | null;
  title: string;
  selftext: string | null;
  flair: string | null;
  score: number;
  numComments: number;
  permalink: string | null;
  url: string | null;
  createdUtc: number;
  fetchedAt: number;
}

export function normalizePost(raw: RedditPostRaw, fetchedAt: number): NormalizedPost {
  return {
    id: raw.name || `t3_${raw.id}`,
    subreddit: raw.subreddit,
    author: raw.author === '[deleted]' ? null : raw.author,
    title: raw.title,
    selftext: raw.is_self ? raw.selftext : null,
    flair: raw.link_flair_text,
    score: raw.score,
    numComments: raw.num_comments,
    permalink: raw.permalink ? `https://www.reddit.com${raw.permalink}` : null,
    url: raw.url,
    createdUtc: Math.floor(raw.created_utc),
    fetchedAt,
  };
}

// Returns true if this is the first time we've seen this post id. Used to
// keep an accurate posts_new count in the run heartbeat — score and comments
// keep refreshing on every scrape, so a plain INSERT OR REPLACE wouldn't tell
// us which rows were genuinely new.
export async function upsertPost(db: D1Database, p: NormalizedPost): Promise<boolean> {
  const existing = await db
    .prepare('SELECT 1 AS x FROM reddit_posts WHERE id = ? LIMIT 1')
    .bind(p.id)
    .first<{ x: number }>();
  await db
    .prepare(
      `INSERT INTO reddit_posts(
         id, subreddit, author, title, selftext, flair,
         score, num_comments, permalink, url, created_utc, fetched_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         score = excluded.score,
         num_comments = excluded.num_comments,
         flair = excluded.flair,
         fetched_at = excluded.fetched_at`,
    )
    .bind(
      p.id, p.subreddit, p.author, p.title, p.selftext, p.flair,
      p.score, p.numComments, p.permalink, p.url, p.createdUtc, p.fetchedAt,
    )
    .run();
  return !existing;
}

export async function replaceMentions(
  db: D1Database,
  postId: string,
  mentions: ExtractedMention[],
  sentiment: number,
): Promise<void> {
  // Wipe and re-insert so edits/deletes upstream are reflected. Mention sets
  // for a single post are tiny (<20), so this is cheap.
  await db.prepare('DELETE FROM reddit_mentions WHERE post_id = ?').bind(postId).run();
  if (mentions.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO reddit_mentions(post_id, symbol, mention_count, sentiment)
     VALUES (?, ?, ?, ?)`,
  );
  await db.batch(
    mentions.map((m) => stmt.bind(postId, m.symbol, m.count, sentiment)),
  );
}

export async function startRedditRun(db: D1Database): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const res = await db
    .prepare('INSERT INTO reddit_runs(started_at) VALUES (?)')
    .bind(now)
    .run();
  return Number(res.meta.last_row_id);
}

export async function finishRedditRun(
  db: D1Database,
  id: number,
  postsSeen: number,
  postsNew: number,
  mentions: number,
  errors: number,
  errorText: string | null,
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `UPDATE reddit_runs
         SET finished_at = ?, posts_seen = ?, posts_new = ?,
             mentions = ?, errors = ?, error_text = ?
       WHERE id = ?`,
    )
    .bind(now, postsSeen, postsNew, mentions, errors, errorText, id)
    .run();
}
