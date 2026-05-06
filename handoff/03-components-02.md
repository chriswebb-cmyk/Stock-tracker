### workers/analyze/

Queue consumer, batch=5, retries=3. For each `{flightId}`:

1. Fetch raw blob from R2.
2. `decodeRawBlob(buf)`: read 12-byte header, gunzip if flag bit 0,
   parse NDJSON to `TelemetrySample[]`.
3. Run `detectAll(samples, { aircraft })`.
4. Wipe prior segments+events, batch-insert new ones in one D1 transaction,
   roll up flight-level summary fields.

Also exposes `POST /analyze/{flightId}` HTTP entry for re-analysis.

#### Detection pipeline (`detect/`)

- **smooth.ts**: `resampleAndSmooth(samples, { hz: 4 })`. Sort by t,
  drop duplicates within 5 ms, linear interpolate to 4 Hz grid (lerpAngle
  for headings/track), derive missing VS from altitude diff, low-pass VS
  (α=0.3), roll, pitch, gz.
- **phases.ts**: state machine `taxi → takeoff_roll → climb → cruise →
  descent → landing → taxi`. Thresholds: taxi GS<25 m/s, liftoff VS≥2 m/s,
  cruise |VS|<1 m/s sustained 60 s, landing AGL<50 m + GS>20 kt. AGL =
  altGeo - groundRefAlt where groundRefAlt = median of first 20 samples.
- **pattern.ts**: find low-altitude windows (AGL 100-600 m), estimate
  runway heading as circular mean of track around the lowest sustained
  point, classify each sample by relative bearing: ±30° = final, ±90° =
  base/crosswind (sign disambiguates), ±180° = downwind.
- **approach.ts**: walk descent/landing segments backward; find stable
  final start = window where |bank|<10° AND VS in `[-1200, -300]` fpm for
  20 s. SD of VS classifies: <1.5 = ILS-like, <3 = RNAV, else visual.
  Override with autopilot mode when present (`GS`/`APPR` → ILS, `LNAV`/
  `LPV` → RNAV).
- **maneuvers.ts**: 6 detectors run within climb/cruise/descent phases:
  - **Steep turn**: |roll|≥35° sustained, total heading change ≥270°.
    Bank, turn count, alt loss/gain in attrs.
  - **Stall**: GS or IAS < 45 kt with VS<-1, recovery within 15 s
    (sustained VS>0 for 3 s). Power-on if pitch >+10° at entry, else
    power-off.
  - **Slow flight**: 35-60 kt with altitude held ±30 m for ≥30 s.
  - **Chandelle**: 180° heading change with continuous climb ≥80 m,
    max bank 25-50°.
  - **Turns around a point**: 80-sample sliding window with centroid,
    radius 100-800 m, radius std/mean <0.25, total heading sweep ≥720°.
- **events.ts**: liftoff (first sustained VS≥1.5 m/s after takeoff_roll),
  touchdown (min altitude in landing/go_around/pattern_final segment),
  bank_exceeded (>60°), g_exceeded (>2.0 or <-0.5), speed_exceeded
  (IAS>200 kt). Collapse same-type events <1 s apart.
- **score.ts**: ACS/PTS scoring. Per-maneuver criteria with tolerance bands:
  - Steep turn: bank 45±5°, alt held ±100 ft, IAS held ±10 kt, rollout hdg ±10°.
  - Stall: alt loss <100 ft, bank during recovery ±10°, prompt recovery <5 s.
  - Slow flight: airspeed (stallDirty+5) ±10 kt, alt ±50 ft, hdg ±10°.
  - Chandelle: 180° heading at completion ±10°, continuous climb true.
  - Approach: VS mean -700±200 fpm, VS σ <100 fpm, IAS σ <5 kt.
  - Landing: sink rate at touchdown <200 fpm, GS 60±15 kt, bank ±5°.
  Each criterion: `{ label, key, target, tolerance, value, pass, unit }`.
  Score = (passed/total)×100. Pass = all criteria within tolerance.

### workers/ingest/

`POST /v1/import` accepts raw body up to 25 MB with `X-Filename`,
`X-Aircraft-Id`, `X-Title` headers. Calls `parseAny(filename, content)`,
re-encodes samples via `encodeRawBlob` to the same `.skywake` format the
iOS recorder produces, inserts flight metadata, uploads both blobs,
enqueues analyze. Maps source format → `RecordedWith`:
gpx→`gpx`, kml→`kml`, igc→`igc`, g1000_csv→`g1000`,
foreflight_csv→`foreflight_import`, csv→`csv`.
