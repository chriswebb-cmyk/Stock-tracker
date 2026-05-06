import { TICKER_DENYLIST, TICKER_UNIVERSE } from './tickers';

// Bullish vs. bearish keyword lexicon for crude per-post sentiment. The score
// is sign(bull - bear) * tanh(|bull - bear| / 3) so it stays in [-1, 1] and
// saturates rather than blowing up on rant posts that say 'calls' 50 times.
const BULL_PATTERNS: RegExp[] = [
  /\bcalls?\b/i, /\blong(?:ing)?\b/i, /\bbuy(?:ing|s)?\b/i, /\bbull(?:ish)?\b/i,
  /\bmoon(?:ing|shot)?\b/i, /\brocket(?:s|ing)?\b/i, /\btendies?\b/i,
  /\byolo\b/i, /\bsqueeze\b/i, /\bbreakout\b/i, /\bripping?\b/i,
  /\bprint(?:ing|s)?\b/i, /\bhodl\b/i, /\bpump(?:ing|s)?\b/i,
  /\bup(?:side|trend)\b/i, /\bbeat(?:s)? earnings\b/i, /\bwagmi\b/i,
  /🚀/u, /📈/u, /💎/u, /🙌/u, /🌕/u, /💰/u, /🤑/u,
];
const BEAR_PATTERNS: RegExp[] = [
  /\bputs?\b/i, /\bshort(?:ing|s)?\b/i, /\bbear(?:ish)?\b/i,
  /\bsell(?:ing|s|off)?\b/i, /\bdump(?:ing|s)?\b/i, /\bcrash(?:ing|es)?\b/i,
  /\bdrill(?:ing|s)?\b/i, /\btank(?:ing|s)?\b/i, /\brug(?:pull)?\b/i,
  /\bdown(?:side|trend)\b/i, /\bmiss(?:ed)? earnings\b/i, /\bbankrupt(?:cy)?\b/i,
  /\bfud\b/i, /\bngmi\b/i, /\bbagholder?s?\b/i, /\bguh\b/i,
  /📉/u, /💀/u, /🐻/u, /🤡/u, /🩸/u,
];

// Cashtags are unambiguous: '$AAPL', '$BRK.B'. We match these even if not in
// the universe — anyone bothering with '$' meant a ticker.
const CASHTAG_RE = /\$([A-Z]{1,5}(?:\.[A-Z])?)\b/g;
// Bare uppercase tokens, 1-5 letters. We then validate against the universe
// and reject anything in the denylist.
const BARE_RE = /\b([A-Z]{1,5})\b/g;

export interface ExtractedMention {
  symbol: string;
  count: number;
}

export interface PostExtraction {
  mentions: ExtractedMention[];
  sentiment: number; // -1..1
}

// Pull cashtags + universe-validated uppercase tokens out of one post's text.
// Returns the symbol -> count map plus a single sentiment score for the post.
export function extractFromPost(title: string, selftext: string | null): PostExtraction {
  const text = `${title}\n${selftext ?? ''}`;
  const counts = new Map<string, number>();

  for (const m of text.matchAll(CASHTAG_RE)) {
    const sym = m[1]?.toUpperCase();
    if (!sym || TICKER_DENYLIST.has(sym)) continue;
    counts.set(sym, (counts.get(sym) ?? 0) + 1);
  }
  for (const m of text.matchAll(BARE_RE)) {
    const sym = m[1]?.toUpperCase();
    if (!sym) continue;
    if (TICKER_DENYLIST.has(sym)) continue;
    if (!TICKER_UNIVERSE.has(sym)) continue;
    counts.set(sym, (counts.get(sym) ?? 0) + 1);
  }

  let bull = 0;
  let bear = 0;
  for (const re of BULL_PATTERNS) bull += countMatches(text, re);
  for (const re of BEAR_PATTERNS) bear += countMatches(text, re);
  const diff = bull - bear;
  const sentiment = diff === 0 ? 0 : Math.tanh(diff / 3);

  return {
    mentions: Array.from(counts, ([symbol, count]) => ({ symbol, count })),
    sentiment,
  };
}

function countMatches(text: string, re: RegExp): number {
  // Force-global re-creation so .matchAll works regardless of source flags.
  const flags = re.flags.includes('g') ? re.flags : re.flags + 'g';
  const g = new RegExp(re.source, flags);
  let n = 0;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  for (const _ of text.matchAll(g)) n += 1;
  return n;
}
