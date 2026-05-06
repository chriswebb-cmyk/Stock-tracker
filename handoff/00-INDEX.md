# Skywake Handoff — read these in order

This `handoff/` directory contains a complete spec for rebuilding the
Skywake flight-debrief platform in a fresh Claude Code session.

## How to use

1. Open a new Claude Code session that has `chriswebb-cmyk/skywake` in
   its GitHub MCP allowlist (or all repos).
2. Paste this prompt to the new agent:

> Read every file in https://github.com/chriswebb-cmyk/stock-tracker/tree/claude/skywake-export/handoff in order (00-INDEX, 01-overview, 02-types, 03-components-01..04, 04-misc). Then read https://github.com/chriswebb-cmyk/stock-tracker/tree/claude/skywake-export/skywake for the files I've already pushed (README, .gitignore, .env.example, db/schema.sql, partial docs). Implement the full Skywake project per spec and push it to chriswebb-cmyk/skywake on the main branch.

## Files in this directory

- `00-INDEX.md` — this file
- `01-overview.md` — mission, architecture, repo layout, conventions
- `02-types.md` — full source of `shared/types.ts` (the wire contract)
- `03-components-01.md` — `shared/parsers/` + `workers/api/`
- `03-components-02.md` — `workers/analyze/` (incl. detection algorithms +
  ACS scoring tolerances) + `workers/ingest/`
- `03-components-03.md` — `ios/Skywake/` SwiftUI recorder + `web/` React app
- `03-components-04.md` — `fixtures/generate.mjs` + parser fixtures
- `04-misc.md` — D1 schema reference, build/run, what's tested,
  conventions, and which files are already on the bridge

## Files already on the bridge (in `skywake/` sibling directory)

These are real source files the new session can copy directly without
re-spec'ing:

- `skywake/README.md`
- `skywake/.gitignore`
- `skywake/.env.example`
- `skywake/db/schema.sql` ← the full D1 schema
- `skywake/docs/ARCHITECTURE.md` (older draft, the spec supersedes it)
- `skywake/docs/COMPETITIVE.md` (research, still accurate)
- `skywake/docs/ROADMAP.md`

## What to push to `chriswebb-cmyk/skywake`

Only the contents of the `skywake/` directory plus everything specified in
the handoff files. Do NOT push the `handoff/` directory or this index —
they're transient bridge artifacts.

After pushing, delete the `claude/skywake-export` branch in stock-tracker.
