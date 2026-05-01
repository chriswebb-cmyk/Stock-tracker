# Stock Tracker — ML Pattern Signals for Options Swings

Intraday signal app for trading weekly/monthly options on a small watchlist.
Pulls bars + options chains from Alpha Vantage, computes technical indicators,
runs ML pattern detection, and pushes high-confidence setups to Discord.

> **Not financial advice.** This tool surfaces statistical setups; sizing,
> execution, and risk are entirely on you. Backtest before risking real money.

## Architecture

```
                     ┌─────────────────────────┐
                     │  Alpha Vantage REST API │
                     └────────────┬────────────┘
                                  │ poll (1m cron)
                                  ▼
   ┌─────────────────────────────────────────────────────────────┐
   │         Cloudflare Worker: ingest (workers/ingest)          │
   │  - Pulls 1m bars + options snapshots for watchlist          │
   │  - Throttles to AV rate limit                               │
   │  - Writes to D1                                             │
   └────────────────┬────────────────────────────────────────────┘
                    │
                    ▼
              ┌──────────────┐
              │ Cloudflare   │   ┌──────────────────────────────┐
              │     D1       │◄──│ Worker: signals (phase 2)    │
              │  (SQLite)    │   │  - Computes indicators       │
              └──────┬───────┘   │  - Runs rule + ML detection  │
                     │           │  - Posts Discord alerts      │
                     │           └──────────────────────────────┘
                     ▼
            ┌──────────────────┐
            │ Worker: api      │
            │ (read endpoints) │
            └────────┬─────────┘
                     │ JSON
                     ▼
            ┌──────────────────┐
            │ React + Vite     │  hosted on Netlify
            │   dashboard      │
            └──────────────────┘
```

## Repo layout

| Path                   | Purpose                                           |
|------------------------|---------------------------------------------------|
| `web/`                 | React + Vite + Tailwind dashboard                 |
| `workers/ingest/`      | Cloudflare Worker cron that polls Alpha Vantage   |
| `workers/api/`         | Cloudflare Worker exposing read endpoints to web  |
| `db/schema.sql`        | D1 schema                                         |
| `shared/`              | TS types shared between workers and web           |
| `notebooks/`           | Python notebooks for training ML models offline   |

## Phase plan

- **Phase 1 (this commit):** scaffold, ingest worker, read API, dashboard with
  live bars and indicators rendered. No ML yet.
- **Phase 2:** rule-based setup detection (VWAP reclaim, ORB breakout, BB
  squeeze) + Discord alerts.
- **Phase 3:** offline LightGBM training notebook + ML scoring layer + options
  contract picker.
- **Phase 4:** backtest harness with realistic slippage modelling.

## Setup

### 1. Install dependencies

```bash
cd web && npm install
cd ../workers/ingest && npm install
cd ../api && npm install
```

### 2. Local secrets

```bash
cp .env.example .env       # fill in ALPHAVANTAGE_API_KEY
```

For the ingest worker, also create `workers/ingest/.dev.vars`:

```
ALPHAVANTAGE_API_KEY=your_key_here
DISCORD_WEBHOOK_URL=
```

### 3. Create the D1 database

```bash
cd workers/ingest
npx wrangler d1 create stock-tracker
# copy the printed database_id into both wrangler.toml files
npx wrangler d1 execute stock-tracker --file=../../db/schema.sql
```

### 4. Run locally

```bash
# terminal 1
cd workers/ingest && npm run dev

# terminal 2
cd workers/api && npm run dev

# terminal 3
cd web && npm run dev
```

### 5. Deploy

```bash
# workers
cd workers/ingest && npx wrangler secret put ALPHAVANTAGE_API_KEY && npx wrangler deploy
cd ../api && npx wrangler deploy

# web (via Netlify CLI or git push to a connected repo)
cd web && npm run build
```

## Watchlist

Edit the `tickers` table in D1 to change which symbols are tracked. Defaults
seeded by `db/schema.sql`:

- SPY, QQQ, AAPL, NVDA, TSLA

## Honest limitations

- Polls every 1 minute; real-time websockets need a paid Workers plan.
- Alpha Vantage intraday history is limited to ~2 years.
- Free D1 is 5 GB — plenty for ~10 tickers, but not for the whole market.
- ML signals decay; the dashboard surfaces rolling backtest stats so you can
  see when a pattern stops working.
