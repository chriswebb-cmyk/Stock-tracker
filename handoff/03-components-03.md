### ios/Skywake/

iOS 17+ SwiftUI app, XcodeGen project (`project.yml`).

- **SkywakeApp.swift**: app entry, `@main`, instantiates `Recorder`,
  `FlightStore`, `UploadCoordinator` as `@StateObject`. RootView with
  `TabView` (Record / Flights / Settings).
- **Config.swift**: motionRateHz=25, locationRateHz=1, baroRateHz=5,
  apiBaseURL from env or default.
- **Telemetry/TelemetrySample.swift**: Swift `Codable struct` mirroring
  TypeScript `TelemetrySample` exactly (so JSON encoding matches).
- **Telemetry/LocationStreamer.swift**: `CLLocationManager` with
  `kCLLocationAccuracyBestForNavigation`, `activityType = .airborne`,
  `allowsBackgroundLocationUpdates = true`. `CMAltimeter` for baro.
  Subscriber pattern: `subscribe((TelemetrySample) -> Void)`.
- **Telemetry/MotionStreamer.swift**: `CMMotionManager.startDeviceMotionUpdates(
  using: .xMagneticNorthZVertical)`. Mount calibration: capture current
  `CMAttitude`, subsequent samples call `.multiply(byInverseOf: mount)`.
  Yaw → heading (0-360), gz from `-(userAcceleration.z + gravity.z)`.
- **Telemetry/Recorder.swift**: `@MainActor ObservableObject`. State:
  idle/armed/recording/stopping. 4 Hz `Timer` fuses latest GPS + IMU into
  one row, JSON-encodes, writes NDJSON to
  `Documents/flights/{ULID}/raw.ndjson`. On stop: `BlobPacker.pack`
  (.skywake binary) + `BlobPacker.previewTrack(hz: 1)` (gzipped JSON).
- **Telemetry/BlobPacker.swift**: writes 12-byte header + gzip(NDJSON)
  via Apple `Compression` framework (raw deflate + custom gzip wrapper
  with CRC32 + ISIZE since `compression_encode_buffer` doesn't gzip-wrap).
  Computes SHA-256 over the framed blob.
- **Telemetry/ULID.swift**: 26-char Crockford-base32 ULID (mirror of TS impl).
  Includes a hand-rolled `UInt128` struct (Swift stdlib has none) supporting
  `<<`, `>>`, `|`, `&`. Don't import a UInt128 library.
- **Persistence/PendingFlight.swift**: `Codable struct` of pending uploads.
  `UploadState` enum: queued/uploadingMetadata/uploadingRaw/finalizing/done/failed.
- **Persistence/FlightStore.swift**: `@MainActor ObservableObject`. Backed
  by JSON file in `Documents/pending-flights.json`. Async writes off main.
- **Networking/Keychain.swift**: stores `skw_*` API key via
  `kSecClassGenericPassword` with `kSecAttrAccessibleAfterFirstUnlock`.
- **Networking/UploadCoordinator.swift**: `@MainActor ObservableObject`.
  `NWPathMonitor` for network, 30 s `Timer` kicks. Three-step protocol:
  POST /v1/flights → PUT signed R2 URL → POST /v1/flights/:id/finalize.
  Exponential backoff for retries (30s, 60s, 120s, 240s, cap 300s).
- **Views/RecordingView.swift**: dark UI, big REC button, ALT/GS/HDG/VS/
  PITCH/ROLL tiles + ELAPSED. Tap REC to start, tap STOP to hand to
  `FlightStore`. Mount calibration sheet accessible from header.
- **Views/MountCalibrationView.swift**: 3-step instructions ("mount it",
  "level the aircraft", "tap Capture"). Capture button → `motion.calibrate()`.
- **Views/FlightsListView.swift**: `List` of `FlightStore.pending` with
  upload-state pill (queued/uploading/done/failed).
- **Views/SettingsView.swift**: API key field (saves to Keychain), recording
  rate display.

### web/

React + Vite + Tailwind + CesiumJS via Resium. Cesium ion provides
terrain via `VITE_CESIUM_ION_TOKEN`.

- **package.json deps**: `react@18`, `react-dom`, `react-router-dom`,
  `@tanstack/react-query`, `cesium@^1.121`, `resium@^1.18`, `zustand`, `clsx`.
  devDeps: `vite`, `@vitejs/plugin-react`, `vite-plugin-cesium`,
  `tailwindcss`, `postcss`, `autoprefixer`, `typescript`.
- **vite.config.ts**: imports `vite-plugin-cesium` to copy Cesium static
  assets and set `CESIUM_BASE_URL`. Aliases `@` → `./src`, `@shared` → `../shared`.
- **lib/api.ts**: typed REST client. Bearer token from `localStorage`
  key `skywake.token`. Methods: `listFlights`, `getFlight`, `getShared`,
  `patchFlight`, `createShare`, `postAnnotation`, `listAnnotations`.
- **lib/units.ts**: `M_TO_FT`, `MS_TO_KT`, `MS_TO_FPM` constants;
  `ft(m)`, `kt(ms)`, `fpm(ms)`, `nm(m)`, `hms(seconds)`.
- **lib/playback.ts**: Zustand store. `samples`, `cursorTs`, `cursorIdx`,
  `speed`, `playing`. `seekTs(ts)` does binary search for `cursorIdx` (O(log n)).
  `startPlaybackLoop()` runs `requestAnimationFrame`, advancing cursorTs
  by `dt * speed`. Hotkeys: Space toggle, Arrow ±1 s.
- **lib/segmentColors.ts**: `segmentColor(type)` returns `[r,g,b]`,
  `segmentColorHex(type)`, `segmentLabel(type)`. Pattern legs blue, approaches
  purple, maneuvers cyan/green/amber, exceedances red.
- **components/Shell.tsx**: top nav with SKYWAKE wordmark + Flights link.
  Uses `<Outlet />` for routes.
- **components/TrackMap.tsx**: Resium `<Viewer>` with `Terrain.fromWorldTerrain`,
  Bing aerial imagery via `IonImageryProvider.fromAssetId(2)`. Render full
  track as `<PolylineGraphics>` (cyan), each segment as colored polyline
  on top, events as `<PointGraphics>` (color by severity), cursor entity
  at `closest(samples, cursorTs)` with heading/pitch/roll quaternion via
  `Transforms.headingPitchRollQuaternion`. Click → seek.
- **components/Timeline.tsx**: SVG sparklines (altitude cyan, GS amber)
  + segment ribbon at bottom 12% + event markers. Pointer drag scrubs.
  PLAY/PAUSE button + speed buttons (1/2/4/8/16×).
- **components/InstrumentPanel.tsx**: 4 stat tiles + SVG attitude indicator.
  ADI: rotate group by `-roll`, translate by `pitch*2` (clamped ±60),
  blue sky / brown ground rects, fixed cyan reference marks, roll triangle
  at top.
- **components/SegmentList.tsx**: 3 sections (Maneuvers / Pattern legs /
  Phases) + Events. Each row: color dot + label + score (if present) +
  duration. Click → seek.
- **components/ScoreCard.tsx**: composite avg of all `Segment.score.score`,
  passed count, color-coded badge (green ≥90, amber ≥70, red).
- **components/ImportDialog.tsx**: drag-drop, calls `parseAny` client-side
  for instant preview (sample count, max alt, max speed, NM, warnings).
  On confirm POSTs raw body to `/api/v1/import` with `X-Filename` header.
- **pages/LandingPage.tsx**: marketing copy with feature grid.
- **pages/FlightsPage.tsx**: table of flights + Import button.
- **pages/DebriefPage.tsx**: 2-col 2-row grid:
  `[TrackMap | (InstrumentPanel + SegmentList + ScoreCard)] / Timeline`.
  React Query fetches `getFlight`. `useEffect` pumps samples into Zustand
  playback store. `shareMode` prop swaps to `getShared(token)`.
