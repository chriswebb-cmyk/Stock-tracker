// Types shared between workers and the frontend.
// Keep this file framework-free so it's safe to import from anywhere.

export type BarInterval = '1min' | '5min' | '15min' | '30min' | '60min';

export interface Bar {
  symbol: string;
  interval: BarInterval;
  ts: number; // unix seconds, bar open time UTC
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface OptionContract {
  underlying: string;
  fetchedAt: number;
  contract: string;
  expiration: string; // YYYY-MM-DD
  strike: number;
  type: 'call' | 'put';
  bid: number | null;
  ask: number | null;
  last: number | null;
  volume: number | null;
  openInterest: number | null;
  impliedVol: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
  rho: number | null;
}

export interface Ticker {
  symbol: string;
  enabled: boolean;
  addedAt: number;
}

export interface Signal {
  id: number;
  symbol: string;
  ts: number;
  setup: string;
  direction: 'long' | 'short';
  mlProbability: number | null;
  featuresJson: string | null;
  contractPick: string | null;
  notes: string | null;
}

export interface IngestRun {
  id: number;
  startedAt: number;
  finishedAt: number | null;
  symbols: number;
  apiCalls: number;
  errors: number;
  errorText: string | null;
}

export interface RedditPost {
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

export interface RedditMention {
  postId: string;
  symbol: string;
  mentionCount: number;
  sentiment: number; // -1..1
}

// Aggregate row returned by /reddit/trending.
export interface RedditTrending {
  symbol: string;
  posts: number;          // distinct posts mentioning the symbol
  mentions: number;       // total textual mentions
  netSentiment: number;   // mean sentiment across posts, -1..1
  totalScore: number;     // sum of post upvote scores
  topPostId: string | null;
  topPostTitle: string | null;
}

// "Hidden diamond" = symbol whose mention rate spiked recently vs. its
// longer-term baseline. The API computes the ratio server-side.
export interface RedditDiamond extends RedditTrending {
  baselineMentions: number;   // mentions over the baseline window
  spikeRatio: number;         // recent / baseline, normalised
}

export interface RedditRun {
  id: number;
  startedAt: number;
  finishedAt: number | null;
  postsSeen: number;
  postsNew: number;
  mentions: number;
  errors: number;
  errorText: string | null;
}
