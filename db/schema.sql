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

-- Seed the default watchlist.
INSERT OR IGNORE INTO tickers(symbol) VALUES
  ('SPY'), ('QQQ'), ('AAPL'), ('NVDA'), ('TSLA');
