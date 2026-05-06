# Skywake — Handoff Spec

**Purpose:** Give this file to a fresh Claude Code session so it can rebuild
the entire Skywake project. Aimed at a session with `chriswebb-cmyk/skywake`
in the GitHub MCP allowlist; the agent should write the source tree and
push to that repo.

This is a complete, self-contained spec. The agent should not need to
guess; if anything is ambiguous, prefer the simpler answer.

---

## Mission

Build a flight debrief & analysis platform for general aviation that competes
head-to-head with **CloudAhoy** (cloudahoy.com, now part of ForeFlight) and
**Flysto** (flysto.net). The competitive wedge is the union of what those
two leave open:

- Native cross-platform recorder (CloudAhoy iOS-only; Flysto has none).
- Editable ACS scoring rubrics (CloudAhoy's are inflexible).
- Threaded time-anchored debrief annotations.
- Two-way logbook sync (ForeFlight, LogTen, MyFlightbook).
- Open data export (`.skywake`, GPX, KML, CSV).
- Self-hosted Cloudflare stack ≈ $5/mo vs CloudAhoy's $70/yr.

Cesium ion provides world terrain + imagery for the 3D viewer (the user's
explicit choice).

---

## Architecture

```
   ┌──────────┐   .skywake (gzipped NDJSON, 12-byte header)
   │  iOS     ├────────────────────────────────────────┐
   │ recorder │                                        │
   └──────────┘                                        ▼
                                          ┌──────────────────────┐
                                          │  Cloudflare R2       │
                                          │   raw + audio blobs  │
                                          └──────────┬───────────┘
                                                     │ key
   ┌──────────┐  POST /v1/flights         ┌──────────▼───────────┐
   │   web    │ ◄────────────────────────►│  Worker: api (Hono)  │
   │ debrief  │   GET  /v1/flights/:id    │  D1 metadata,        │
   └────▲─────┘   GET  /v1/share/:token   │  segments, events,   │
        │ track                            │  annotations         │
        │                                  └──────────┬───────────┘
        │                                             │ enqueue
        │                                             ▼
        │                                  ┌──────────────────────┐
        │                                  │  Worker: analyze     │
        │                                  │  resample → phases   │
        │                                  │  → pattern legs      │
        │                                  │  → approaches        │
        │ segments + events                │  → maneuvers         │
        │ + 1 Hz track ◄───────────────────┤  → ACS scoring       │
        └──────────────────────────────────┴──────────────────────┘
```

Plus a fourth worker `workers/ingest/` that exposes `POST /v1/import` and
accepts GPX/KML/CSV/IGC track logs from non-iOS pilots.

**Tech stack (non-negotiable):**
- iOS: SwiftUI, iOS 17+, XcodeGen project, CoreLocation + CoreMotion + AVAudio.
- Backend: Cloudflare Workers (Hono framework), D1 (SQLite), R2 (blob), Queues.
- Web: React 18 + Vite + TypeScript + Tailwind + CesiumJS (via Resium).
- Shared: TypeScript types in `shared/types.ts`, parsers in `shared/parsers/`.

---

## Repo layout

```
skywake/
├── .env.example
├── .gitignore
├── README.md
├── docs/
│   ├── ARCHITECTURE.md
│   ├── COMPETITIVE.md
│   └── ROADMAP.md
├── shared/
│   ├── types.ts                  # wire contract — see below for full source
│   └── parsers/
│       ├── types.ts              # ParseResult shape
│       ├── xml.ts                # tiny pull-style XML walker
│       ├── gpx.ts
│       ├── kml.ts
│       ├── csv.ts                # generic + G1000 + ForeFlight dialects
│       ├── igc.ts                # glider tracks
│       └── index.ts              # parseAny() dispatcher
├── db/schema.sql                 # Cloudflare D1 schema — already on bridge
├── workers/
│   ├── api/                      # Hono REST API
│   │   ├── package.json wrangler.toml tsconfig.json
│   │   └── src/{index,auth,r2,rowmap,ids,compress}.ts
│   ├── analyze/                  # Queue consumer + detection pipeline
│   │   ├── package.json wrangler.toml tsconfig.json
│   │   └── src/{index,codec,ids}.ts
│   │       detect/{index,smooth,phases,pattern,approach,maneuvers,events,score}.ts
│   └── ingest/                   # POST /v1/import
│       └── src/{index,auth,codec,util}.ts
├── web/
│   ├── package.json index.html vite.config.ts tsconfig.json
│   ├── tailwind.config.js postcss.config.js
│   └── src/
│       ├── main.tsx styles.css
│       ├── lib/{api,units,playback,segmentColors}.ts
│       ├── components/{Shell,TrackMap,Timeline,InstrumentPanel,
│       │              SegmentList,ScoreCard,ImportDialog}.tsx
│       └── pages/{LandingPage,FlightsPage,DebriefPage}.tsx
├── ios/
│   ├── README.md project.yml
│   └── Skywake/
│       ├── SkywakeApp.swift Config.swift
│       ├── Telemetry/{TelemetrySample,LocationStreamer,MotionStreamer,
│       │              Recorder,BlobPacker,ULID}.swift
│       ├── Persistence/{PendingFlight,FlightStore}.swift
│       ├── Networking/{Keychain,UploadCoordinator}.swift
│       └── Views/{RecordingView,FlightsListView,SettingsView,
│                   MountCalibrationView}.swift
└── fixtures/
    ├── generate.mjs              # synthesizes a 17-min KPAO→KSQL demo
    ├── parsers/{sample.gpx,sample.kml,sample.csv,sample.igc,test.mjs}
    └── (demo.skywake + demo-track.json + demo-full.json — generated)
```

---

## Core conventions

- **Units in transit are SI.** Meters, m/s, degrees, hPa, Celsius, ms epoch.
  Imperial conversions (ft, kt, fpm, NM) live in the UI only.
- **IDs are Crockford-base32 ULIDs.** 26 chars, lex-sortable, embed timestamp.
  Same algorithm in iOS, all three workers (each with their own copy).
- **`.skywake` blob format:** 12-byte header (`SKWK` magic, u16 LE version=1,
  u16 LE flags, u32 LE sample count) followed by gzip(NDJSON of TelemetrySample).
- **Each Worker is independently deployable.** Some helpers (auth, ids,
  codec) are duplicated rather than shared, on purpose.
