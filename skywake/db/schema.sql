-- Skywake flight tracker schema (Cloudflare D1 / SQLite).
--
-- Storage strategy:
--   D1 holds metadata, downsampled tracks (~1 Hz for fast web replay),
--   detected segments, events, annotations, and shares.
--   Raw full-rate telemetry (10-25 Hz) lives in R2 as a compact binary
--   blob keyed by flight_id; we never query it from D1.
--
-- All timestamps are unix epoch milliseconds (INTEGER).
-- All angles are degrees, distances meters, speeds m/s, pressures hPa,
-- temperatures Celsius. Conversions to imperial happen in the UI.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  email         TEXT UNIQUE NOT NULL,
  display_name  TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('pilot', 'instructor', 'admin')),
  certificates  TEXT,                       -- JSON array: ["PPL", "IR", "CFI", "CFII"]
  home_airport  TEXT,                       -- ICAO
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS aircraft (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  registration    TEXT NOT NULL,            -- e.g. "N12345"
  type_icao       TEXT,                     -- e.g. "C172", "SR22", "PA28"
  model           TEXT,                     -- "Skyhawk 172S"
  category        TEXT NOT NULL CHECK (category IN
                    ('SEL', 'MEL', 'SES', 'MES', 'glider', 'helicopter', 'experimental')),
  vne_kt          INTEGER,                  -- never-exceed speed
  vno_kt          INTEGER,                  -- max structural cruising
  va_kt           INTEGER,                  -- design maneuvering
  vfe_kt          INTEGER,                  -- max flap extended
  stall_clean_kt  INTEGER,                  -- Vs1
  stall_dirty_kt  INTEGER,                  -- Vso
  created_at      INTEGER NOT NULL,
  UNIQUE (owner_id, registration)
);

CREATE TABLE IF NOT EXISTS flights (
  id                TEXT PRIMARY KEY,
  pilot_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  aircraft_id       TEXT REFERENCES aircraft(id) ON DELETE SET NULL,
  title             TEXT,                   -- pilot-supplied, e.g. "IFR XC to KBED"
  description       TEXT,
  recorded_with     TEXT NOT NULL CHECK (recorded_with IN
                      ('ios', 'ipados', 'stratus', 'sentry', 'gdl39',
                       'g1000', 'foreflight_import', 'gpx', 'kml', 'igc', 'csv')),
  started_at        INTEGER NOT NULL,       -- engine start / first motion
  ended_at          INTEGER NOT NULL,       -- engine stop / last motion
  takeoff_at        INTEGER,                -- wheels-up
  landing_at        INTEGER,                -- wheels-down (last touchdown)
  departure_icao    TEXT,
  arrival_icao      TEXT,
  alternate_icao    TEXT,
  flight_rules      TEXT CHECK (flight_rules IN ('VFR', 'IFR', 'SVFR', 'mixed')),
  total_time_sec    INTEGER NOT NULL,       -- ended_at - started_at
  air_time_sec      INTEGER,                -- takeoff_at -> landing_at
  distance_m        REAL,                   -- great-circle from first to last fix
  ground_track_m    REAL,                   -- summed leg lengths
  max_alt_m         REAL,
  max_gs_ms         REAL,                   -- ground speed (m/s)
  max_ias_ms        REAL,                   -- indicated airspeed if available
  landings_count    INTEGER NOT NULL DEFAULT 0,
  -- compact downsampled track for web replay (~1 Hz, gzipped JSON)
  track_blob_key    TEXT,                   -- R2 key for downsampled track
  raw_blob_key      TEXT,                   -- R2 key for full-rate raw telemetry
  audio_blob_key    TEXT,                   -- R2 key for cabin audio if recorded
  bbox_min_lat      REAL,                   -- bounding box for map clustering
  bbox_min_lon      REAL,
  bbox_max_lat      REAL,
  bbox_max_lon      REAL,
  visibility        TEXT NOT NULL DEFAULT 'private'
                      CHECK (visibility IN ('private', 'unlisted', 'public')),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_flights_pilot     ON flights(pilot_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_flights_aircraft  ON flights(aircraft_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_flights_dep       ON flights(departure_icao);
CREATE INDEX IF NOT EXISTS idx_flights_arr       ON flights(arrival_icao);
CREATE INDEX IF NOT EXISTS idx_flights_visibility ON flights(visibility, started_at DESC);

-- Detected flight segments. The analysis worker writes these after ingest.
CREATE TABLE IF NOT EXISTS segments (
  id            TEXT PRIMARY KEY,
  flight_id     TEXT NOT NULL REFERENCES flights(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,
  start_ts      INTEGER NOT NULL,
  end_ts        INTEGER NOT NULL,
  attrs_json    TEXT,
  score_json    TEXT,
  confidence    REAL NOT NULL DEFAULT 1.0
);

CREATE INDEX IF NOT EXISTS idx_segments_flight ON segments(flight_id, start_ts);
CREATE INDEX IF NOT EXISTS idx_segments_type   ON segments(flight_id, type);

CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  flight_id   TEXT NOT NULL REFERENCES flights(id) ON DELETE CASCADE,
  ts          INTEGER NOT NULL,
  type        TEXT NOT NULL,
  attrs_json  TEXT,
  severity    TEXT CHECK (severity IN ('info', 'warning', 'critical'))
);

CREATE INDEX IF NOT EXISTS idx_events_flight ON events(flight_id, ts);

CREATE TABLE IF NOT EXISTS annotations (
  id            TEXT PRIMARY KEY,
  flight_id     TEXT NOT NULL REFERENCES flights(id) ON DELETE CASCADE,
  parent_id     TEXT REFERENCES annotations(id) ON DELETE CASCADE,
  author_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  segment_id    TEXT REFERENCES segments(id) ON DELETE SET NULL,
  ts            INTEGER,
  body          TEXT NOT NULL,
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_annot_flight  ON annotations(flight_id, ts);
CREATE INDEX IF NOT EXISTS idx_annot_parent  ON annotations(parent_id);

CREATE TABLE IF NOT EXISTS shares (
  token         TEXT PRIMARY KEY,
  flight_id     TEXT NOT NULL REFERENCES flights(id) ON DELETE CASCADE,
  created_by    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at    INTEGER,
  created_at    INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shares_flight ON shares(flight_id);

CREATE TABLE IF NOT EXISTS api_tokens (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,
  scopes        TEXT NOT NULL,
  last_used_at  INTEGER,
  created_at    INTEGER NOT NULL,
  revoked_at    INTEGER
);

CREATE TABLE IF NOT EXISTS airports (
  icao          TEXT PRIMARY KEY,
  iata          TEXT,
  name          TEXT NOT NULL,
  lat           REAL NOT NULL,
  lon           REAL NOT NULL,
  elev_m        REAL NOT NULL,
  country       TEXT,
  type          TEXT
);

CREATE INDEX IF NOT EXISTS idx_airports_pos ON airports(lat, lon);
