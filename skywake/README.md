# Skywake

A flight debrief & analysis platform for general aviation, built to compete
head-to-head with [CloudAhoy](https://www.cloudahoy.com/) (now part of
ForeFlight) and [Flysto](https://www.flysto.net).

> **Status:** scaffold complete, integration in progress. The recorder, API,
> analyzer, and web debrief platform all build and run; we ship a synthetic
> demo flight so you can see the full UX before recording your own.

## What it is

Three things in one repo:

- **Recorder** (`ios/`) — native iOS / iPadOS app that records GPS,
  attitude (CoreMotion device-motion fused gyro+accel+mag), barometer, and
  optional cabin audio at 4–25 Hz. Outputs the compact `.skywake` binary
  format and uploads to the API once back on Wi-Fi.
- **Backend** (`workers/`) — three Cloudflare Workers:
  - `api/` — REST surface for the recorder + web app, D1 + R2 backed.
  - `analyze/` — Queue consumer that runs phase-of-flight + maneuver
    detection + ACS scoring on each new flight.
  - `ingest/` — `POST /v1/import` accepts GPX, KML, CSV (generic +
    G1000 SD-card + ForeFlight) and IGC, normalizes to the standard
    sample stream, re-encodes as `.skywake`, and hands off to analyze.
- **Web debrief** (`web/`) — React + Vite + CesiumJS (Cesium ion world
  terrain + Bing imagery). 3D track over real terrain, scrubbable
  timeline, instrument panel, segment list with ACS scoring, threaded
  annotations.

Plus `shared/` — TypeScript types that are the wire contract across all
three. And `fixtures/demo.skywake` — a 17-minute synthetic flight (KPAO →
steep turn → stall → KSQL ILS approach → touch-and-go → pattern → full
stop) you can replay end-to-end without any sensors.

## Why another one

CloudAhoy and Flysto are both excellent and both leave gaps. From research
into pilot complaints (POA, BeechTalk, App Store reviews):

| Gap | Skywake's answer |
|-----|------------------|
| CloudAhoy is iOS-only; Flysto has no recorder | Native iOS today; Android on the roadmap; Flysto-style track import for everyone else |
| CloudAhoy scoring envelopes don't match ACS | Every grading criterion is editable JSON — schools and CFIs override defaults |
| Neither has true threaded time-anchored annotations | First-class threaded comments anchored to a timestamp or segment |
| Neither pushes to ForeFlight / LogTen / MyFlightbook | Two-way logbook sync (planned) |
| CloudAhoy is $70/yr | Self-host on Cloudflare for under $5/month, or use the free hosted tier |
| Pilots distrust ForeFlight locking their data | Export everything: GPX, KML, CSV, raw `.skywake`. No lock-in |
| Helicopter / glider / aerobatic libraries are weak | Maneuver vocabulary is open-ended; helicopter pack on the roadmap |

The competitive research that drove this is in `docs/COMPETITIVE.md`.

## Quickstart

```bash
# 1) Generate the synthetic flight
node fixtures/generate.mjs

# 2) Spin up the API worker (once you've filled in wrangler.toml)
cd workers/api && npm install && npm run dev          # :8787

# 3) Spin up the analyze worker
cd ../analyze && npm install && npm run dev           # :8788

# 4) Spin up the web debrief
cd ../../web && npm install && npm run dev            # :5173
```

For a full deployment walkthrough — D1, R2, Queues, secrets, Cesium ion
token — see `.env.example` and `docs/DEPLOY.md` (TODO).

## Repo layout

```
skywake/
├── ios/                     # SwiftUI recorder (XcodeGen project.yml)
│   └── Skywake/
│       ├── Telemetry/       # LocationStreamer, MotionStreamer, Recorder, BlobPacker
│       ├── Persistence/     # FlightStore, PendingFlight
│       ├── Networking/      # UploadCoordinator, Keychain
│       └── Views/           # RecordingView, FlightsListView, MountCalibrationView
├── web/                     # React + Vite + CesiumJS
│   └── src/
│       ├── components/      # TrackMap, Timeline, InstrumentPanel, SegmentList, ScoreCard, ImportDialog
│       ├── pages/           # FlightsPage, DebriefPage, LandingPage
│       └── lib/             # api client, units, playback store, segment colors
├── workers/
│   ├── api/                 # Hono on Workers; D1 + R2; flights, share, annotations
│   ├── analyze/             # Queue consumer; resample → phases → maneuvers → score
│   └── ingest/              # POST /v1/import for GPX/KML/CSV/IGC
├── shared/
│   ├── types.ts             # Wire types — the contract
│   └── parsers/             # GPX, KML, CSV, IGC importers (pure TS, run in browser+Worker+Node)
├── db/schema.sql            # D1 schema
├── fixtures/                # Synthetic demo flight + parser fixtures
└── docs/                    # ARCHITECTURE, COMPETITIVE, ROADMAP
```

## Honest scope

What works today: the schema, types, API surface, analyzer pipeline (phase
detection, pattern legs, approach classification, six maneuver detectors,
ACS scoring), the iOS recorder views and Telemetry/Recorder pipeline, the
ingest worker + parsers (verified against fixtures), and the web debrief
views with playback.

What still needs polish: the ULID/UInt128 helper in iOS hasn't been
exercised on-device; signed R2 PUTs need account ID + keys to test
end-to-end; Cesium ion needs a token; no vitest coverage in the workers
yet (wired but no specs).

What's out of scope for v0: Android recorder, ADS-B receiver pairing,
video upload with auto-sync (Flysto's signature), helicopter maneuver
library, ForeFlight/LogTen/MyFlightbook two-way sync. All sized in
`docs/ROADMAP.md`.

## License

Source available; commercial use TBD pending data-residency and FAA
certification considerations. The recorder is intentionally permissive
(MIT) to encourage panel-mount integration; the analysis engine and
hosted backend are AGPL until we settle on commercial terms.
