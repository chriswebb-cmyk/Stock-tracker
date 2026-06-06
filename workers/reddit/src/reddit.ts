// Thin client over Reddit's public JSON endpoints. We deliberately avoid
// OAuth here: the public www.reddit.com/r/<sub>/<listing>.json endpoints work
// fine for read-only scraping as long as we send a unique User-Agent and stay
// under Reddit's soft rate limit (~60 req/min unauthenticated).

export interface RedditPostRaw {
  id: string;             // 'abcdef' (without the 't3_' prefix)
  name: string;           // 't3_abcdef'
  subreddit: string;
  author: string;
  title: string;
  selftext: string;
  link_flair_text: string | null;
  score: number;
  num_comments: number;
  permalink: string;      // '/r/wallstreetbets/comments/...'
  url: string;
  created_utc: number;    // float seconds since epoch
  is_self: boolean;
  stickied: boolean;
  removed_by_category: string | null;
}

interface ListingResponse {
  kind: 'Listing';
  data: {
    after: string | null;
    children: { kind: string; data: RedditPostRaw }[];
  };
}

export class RedditError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = 'RedditError';
  }
}

export class RedditClient {
  constructor(private readonly userAgent: string) {}

  // Fetches a listing ('hot' | 'new' | 'top' | 'rising') for a subreddit and
  // returns just the post payloads, filtering out stickies and removed posts.
  async listing(subreddit: string, listing: string, limit: number): Promise<RedditPostRaw[]> {
    const url = `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/${encodeURIComponent(listing)}.json?limit=${limit}&raw_json=1`;
    const res = await fetch(url, {
      headers: {
        'User-Agent': this.userAgent,
        'Accept': 'application/json',
      },
      // Reddit returns Cache-Control headers; let CF cache the response so
      // multiple cron retries within the same minute don't double-bill.
      cf: { cacheTtl: 60, cacheEverything: true },
    });
    if (res.status === 429) {
      throw new RedditError('Reddit rate limit (HTTP 429)', 429);
    }
    if (!res.ok) {
      throw new RedditError(`Reddit HTTP ${res.status}`, res.status);
    }
    const json = (await res.json()) as ListingResponse;
    if (!json?.data?.children) {
      throw new RedditError('malformed listing payload');
    }
    return json.data.children
      .map((c) => c.data)
      .filter((p) => p && !p.stickied && !p.removed_by_category);
  }
}
