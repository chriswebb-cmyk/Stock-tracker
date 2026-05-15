-- Cloudflare D1 schema for stock-tracker.
-- D1 is SQLite under the hood, so types are SQLite affinities.

-- Watchlist. The ingest worker reads this to know what to poll.
CREATE TABLE IF NOT EXISTS tickers (
  symbol      TEXT PRIMARY KEY,
  enabled     INTEGER NOT NULL DEFAULT 1,           -- 0/1 boolean
  added_at    INTEGER NOT NULL DEFAULT (unixepoch()) -- seconds since epoch
);

-- Intraday OHLCV bars. ts is the bar's open time in unix seconds (UTC).
-- interval is one of '1min','5min','15min','30min','60min'.
CREATE TABLE IF NOT EXISTS bars (
  symbol     TEXT NOT NULL,
  interval   TEXT NOT NULL,
  ts         INTEGER NOT NULL,
  open       REAL NOT NULL,
  high       REAL NOT NULL,
  low        REAL NOT NULL,
  close      REAL NOT NULL,
  volume     INTEGER NOT NULL,
  PRIMARY KEY (symbol, interval, ts)
);
CREATE INDEX IF NOT EXISTS bars_symbol_ts ON bars(symbol, interval, ts DESC);

-- Snapshot of an options chain at a point in time. Each row is a single
-- contract observed at fetched_at. Ingest writes a fresh batch each poll.
CREATE TABLE IF NOT EXISTS options_snapshots (
  underlying     TEXT NOT NULL,
  fetched_at     INTEGER NOT NULL,
  contract       TEXT NOT NULL,         -- e.g. 'AAPL250503C00200000'
  expiration     TEXT NOT NULL,         -- 'YYYY-MM-DD'
  strike         REAL NOT NULL,
  type           TEXT NOT NULL,         -- 'call' | 'put'
  bid            REAL,
  ask            REAL,
  last           REAL,
  volume         INTEGER,
  open_interest  INTEGER,
  implied_vol    REAL,
  delta          REAL,
  gamma          REAL,
  theta          REAL,
  vega           REAL,
  rho            REAL,
  PRIMARY KEY (underlying, fetched_at, contract)
);
CREATE INDEX IF NOT EXISTS options_underlying_time
  ON options_snapshots(underlying, fetched_at DESC);

-- Detected setups / ML signals. One row per (symbol, ts, setup) emitted by
-- the signal worker. Phase 2.
CREATE TABLE IF NOT EXISTS signals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  symbol          TEXT NOT NULL,
  ts              INTEGER NOT NULL,
  setup           TEXT NOT NULL,        -- e.g. 'vwap_reclaim'
  direction       TEXT NOT NULL,        -- 'long' | 'short'
  ml_probability  REAL,                 -- 0..1, null until phase 3
  features_json   TEXT,                 -- snapshot of features used
  contract_pick   TEXT,                 -- suggested options contract symbol
  notes           TEXT
);
CREATE INDEX IF NOT EXISTS signals_symbol_ts ON signals(symbol, ts DESC);

-- Manual trade journal. The user logs entries/exits to track real-world hit
-- rate vs. backtested edge.
CREATE TABLE IF NOT EXISTS trades (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id    INTEGER REFERENCES signals(id),
  symbol       TEXT NOT NULL,
  contract     TEXT,
  direction    TEXT NOT NULL,
  entry_ts     INTEGER NOT NULL,
  entry_price  REAL NOT NULL,
  exit_ts      INTEGER,
  exit_price   REAL,
  pnl          REAL,
  notes        TEXT
);

-- Cron heartbeat / ingest log. Lets the dashboard show "last polled at".
CREATE TABLE IF NOT EXISTS ingest_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  symbols       INTEGER NOT NULL DEFAULT 0,
  api_calls     INTEGER NOT NULL DEFAULT 0,
  errors        INTEGER NOT NULL DEFAULT 0,
  error_text    TEXT
);

-- Generic JSON cache. Used so the backtest summary doesn't have to be
-- recomputed on every dashboard load (which trips the 10ms free-tier CPU
-- budget). The weekly retrain cron writes this; /backtest-summary reads it.
CREATE TABLE IF NOT EXISTS json_cache (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- Per-setup logistic regression model trained on backtest results. One row
-- per (setup, hold_minutes); retraining replaces the row. Holding multiple
-- horizons lets the system answer "what's the win probability at 15m vs
-- 60m hold?" — useful for options trades where premium decay differs.
DROP TABLE IF EXISTS models;
CREATE TABLE IF NOT EXISTS models (
  setup           TEXT NOT NULL,
  hold_minutes    INTEGER NOT NULL DEFAULT 30,
  trained_at      INTEGER NOT NULL,
  sample_count    INTEGER NOT NULL,
  train_accuracy  REAL NOT NULL,
  val_accuracy    REAL NOT NULL,
  train_baseline  REAL NOT NULL,
  weights_json    TEXT NOT NULL,
  PRIMARY KEY (setup, hold_minutes)
);

-- Meta (ensemble) model that stacks on top of the per-setup models. One
-- row per hold_minutes horizon. Takes per-setup probability + setup
-- one-hot + direction + base features as input and outputs a unified
-- calibrated probability for that horizon.
DROP TABLE IF EXISTS meta_model;
CREATE TABLE IF NOT EXISTS meta_model (
  hold_minutes    INTEGER PRIMARY KEY,
  trained_at      INTEGER NOT NULL,
  sample_count    INTEGER NOT NULL,
  train_accuracy  REAL NOT NULL,
  val_accuracy    REAL NOT NULL,
  train_baseline  REAL NOT NULL,
  weights_json    TEXT NOT NULL
);

-- Seed the default watchlist. ^VIX and ^TNX are included so the ingest
-- worker pulls their bars too; the API worker uses the latest values as
-- regime features on every signal (calm vs. panic market filter, plus
-- yield-driven style rotation).
INSERT OR IGNORE INTO tickers(symbol) VALUES
  ('SPY'), ('QQQ'), ('AAPL'), ('NVDA'), ('TSLA'), ('^VIX'), ('^TNX');

-- Reddit posts pulled from r/wallstreetbets (and any other subs we add). One
-- row per Reddit post id ('t3_xxxx'), upserted on each scrape so score and
-- num_comments stay fresh while the post is hot.
CREATE TABLE IF NOT EXISTS reddit_posts (
  id            TEXT PRIMARY KEY,             -- Reddit fullname or id
  subreddit     TEXT NOT NULL,
  author        TEXT,
  title         TEXT NOT NULL,
  selftext      TEXT,
  flair         TEXT,
  score         INTEGER NOT NULL DEFAULT 0,
  num_comments  INTEGER NOT NULL DEFAULT 0,
  permalink     TEXT,
  url           TEXT,
  created_utc   INTEGER NOT NULL,             -- post creation, unix seconds
  fetched_at    INTEGER NOT NULL              -- last time we refreshed it
);
CREATE INDEX IF NOT EXISTS reddit_posts_created
  ON reddit_posts(created_utc DESC);
CREATE INDEX IF NOT EXISTS reddit_posts_sub_created
  ON reddit_posts(subreddit, created_utc DESC);

-- Ticker mentions extracted from a post's title + selftext. mention_count is
-- how many times the symbol appears in that single post; sentiment is a
-- bullish-minus-bearish keyword score in [-1, 1].
CREATE TABLE IF NOT EXISTS reddit_mentions (
  post_id        TEXT NOT NULL REFERENCES reddit_posts(id) ON DELETE CASCADE,
  symbol         TEXT NOT NULL,
  mention_count  INTEGER NOT NULL DEFAULT 1,
  sentiment      REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (post_id, symbol)
);
CREATE INDEX IF NOT EXISTS reddit_mentions_symbol
  ON reddit_mentions(symbol);

-- Heartbeat for the reddit scraper, parallel to ingest_runs.
CREATE TABLE IF NOT EXISTS reddit_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at    INTEGER NOT NULL,
  finished_at   INTEGER,
  posts_seen    INTEGER NOT NULL DEFAULT 0,
  posts_new     INTEGER NOT NULL DEFAULT 0,
  mentions      INTEGER NOT NULL DEFAULT 0,
  errors        INTEGER NOT NULL DEFAULT 0,
  error_text    TEXT
);
