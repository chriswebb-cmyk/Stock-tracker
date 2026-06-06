import { extractFromPost } from './extract';
import { RedditClient, RedditError } from './reddit';
import {
  finishRedditRun,
  normalizePost,
  replaceMentions,
  startRedditRun,
  upsertPost,
} from './db';

export interface Env {
  DB: D1Database;
  SUBREDDITS?: string;            // comma-separated, defaults to 'wallstreetbets'
  POSTS_PER_LISTING?: string;     // defaults to 100
  LISTINGS?: string;              // 'hot,new'
  REDDIT_USER_AGENT?: string;     // required by Reddit; set in wrangler.toml
}

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runScrape(env));
  },

  // Manual trigger for local dev: `curl http://localhost:8789/run`.
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/run') {
      const result = await runScrape(env);
      return Response.json(result);
    }
    if (url.pathname === '/health') {
      return Response.json({ ok: true });
    }
    return new Response('not found', { status: 404 });
  },
};

interface RunResult {
  subreddits: string[];
  postsSeen: number;
  postsNew: number;
  mentions: number;
  errors: number;
}

async function runScrape(env: Env): Promise<RunResult> {
  const subs = (env.SUBREDDITS ?? 'wallstreetbets').split(',').map((s) => s.trim()).filter(Boolean);
  const listings = (env.LISTINGS ?? 'hot,new').split(',').map((s) => s.trim()).filter(Boolean);
  const limit = Math.max(1, Math.min(100, Number(env.POSTS_PER_LISTING ?? '100')));
  const userAgent = env.REDDIT_USER_AGENT ?? 'web:stock-tracker:0.1';

  const runId = await startRedditRun(env.DB);
  const client = new RedditClient(userAgent);
  const fetchedAt = Math.floor(Date.now() / 1000);

  let postsSeen = 0;
  let postsNew = 0;
  let mentionsTotal = 0;
  let errors = 0;
  let errorText: string | null = null;

  // Track which post ids we've already processed in this run. Reddit
  // listings overlap across hot/new, and we'd rather not double-extract.
  const seenIds = new Set<string>();

  for (const sub of subs) {
    for (const listing of listings) {
      try {
        const raws = await client.listing(sub, listing, limit);
        for (const raw of raws) {
          const post = normalizePost(raw, fetchedAt);
          if (seenIds.has(post.id)) continue;
          seenIds.add(post.id);
          postsSeen += 1;

          const isNew = await upsertPost(env.DB, post);
          if (isNew) postsNew += 1;

          const { mentions, sentiment } = extractFromPost(post.title, post.selftext);
          await replaceMentions(env.DB, post.id, mentions, sentiment);
          mentionsTotal += mentions.length;
        }
      } catch (err) {
        errors += 1;
        const msg = err instanceof Error ? err.message : String(err);
        errorText = errorText ? `${errorText}\n${sub}/${listing}: ${msg}` : `${sub}/${listing}: ${msg}`;
        // Reddit 429 means stop now — don't burn through our budget.
        if (err instanceof RedditError && err.status === 429) break;
      }
    }
  }

  await finishRedditRun(env.DB, runId, postsSeen, postsNew, mentionsTotal, errors, errorText);
  return { subreddits: subs, postsSeen, postsNew, mentions: mentionsTotal, errors };
}
