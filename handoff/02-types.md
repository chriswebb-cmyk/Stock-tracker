
## shared/types.ts — full source

This is the wire contract. Reproduce exactly.

```typescript
// All units are SI in transit. Imperial conversions belong in the UI only.

export interface TelemetrySample {
  /** Unix epoch milliseconds. */
  t: number;
  lat?: number;
  lon?: number;
  /** Geometric altitude (WGS84), meters. */
  altGeo?: number;
  /** Pressure altitude (1013.25 hPa), meters. */
  altPress?: number;
  altDensity?: number;
  hAcc?: number;
  vAcc?: number;
  gs?: number;
  ias?: number;
  tas?: number;
  /** True track over ground, degrees 0..360. */
  trk?: number;
  /** Vertical speed, m/s. Positive = climb. */
  vs?: number;
  /** Magnetic heading, degrees. */
  hdg?: number;
  /** Pitch, degrees. Positive = nose up. */
  pitch?: number;
  /** Roll, degrees. Positive = right wing down. */
  roll?: number;
  yawRate?: number;
  acc?: { x: number; y: number; z: number };
  /** Total normal load factor, g. 1.0 = level. */
  gz?: number;
  pressHpa?: number;
  oatC?: number;
  flapDeg?: number;
  gearDown?: boolean;
  apEngaged?: boolean;
  apMode?: string;
  rpm?: number;
  manifoldInHg?: number;
  fuelLbs?: number;
  src?: 'gps' | 'imu' | 'baro' | 'adsb' | 'panel' | 'fused';
}

export interface DownsampledTrack {
  flightId: string;
  hz: number;
  startedAt: number;
  endedAt: number;
  samples: TelemetrySample[];
}

export type RecordedWith =
  | 'ios' | 'ipados' | 'stratus' | 'sentry' | 'gdl39'
  | 'g1000' | 'foreflight_import' | 'gpx' | 'kml' | 'igc' | 'csv';

export type FlightRules = 'VFR' | 'IFR' | 'SVFR' | 'mixed';
export type Visibility = 'private' | 'unlisted' | 'public';

export interface Flight {
  id: string;
  pilotId: string;
  aircraftId: string | null;
  title: string | null;
  description: string | null;
  recordedWith: RecordedWith;
  startedAt: number;
  endedAt: number;
  takeoffAt: number | null;
  landingAt: number | null;
  departureIcao: string | null;
  arrivalIcao: string | null;
  alternateIcao: string | null;
  flightRules: FlightRules | null;
  totalTimeSec: number;
  airTimeSec: number | null;
  distanceM: number | null;
  groundTrackM: number | null;
  maxAltM: number | null;
  maxGsMs: number | null;
  maxIasMs: number | null;
  landingsCount: number;
  trackBlobKey: string | null;
  rawBlobKey: string | null;
  audioBlobKey: string | null;
  bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number } | null;
  visibility: Visibility;
  createdAt: number;
  updatedAt: number;
}

export type SegmentType =
  | 'taxi' | 'takeoff_roll' | 'climb' | 'cruise' | 'descent'
  | 'go_around' | 'landing'
  | 'pattern_upwind' | 'pattern_crosswind' | 'pattern_downwind'
  | 'pattern_base' | 'pattern_final'
  | 'ils_approach' | 'rnav_approach' | 'visual_approach'
  | 'circle_to_land' | 'holding'
  | 'steep_turn_left' | 'steep_turn_right'
  | 'stall_power_off' | 'stall_power_on' | 'slow_flight'
  | 'chandelle_left' | 'chandelle_right'
  | 'lazy_8' | 'eights_on_pylons'
  | 'turns_around_point' | 's_turns_across_road' | 'rectangular_course'
  | 'unknown';

export interface Segment {
  id: string;
  flightId: string;
  type: SegmentType;
  startTs: number;
  endTs: number;
  attrs?: SegmentAttrs;
  score?: SegmentScore;
  confidence: number;
}

export type SegmentAttrs =
  | { type: 'climb'; avgVsMs: number; avgIasMs?: number; deltaAltM: number }
  | { type: 'cruise'; avgAltM: number; avgGsMs: number; altHoldStdM: number }
  | { type: 'descent'; avgVsMs: number; deltaAltM: number; targetAltM?: number }
  | { type: 'pattern_final'; runway?: string; touchdownLat?: number; touchdownLon?: number }
  | { type: 'landing'; runway?: string; touchdownGsMs: number; touchdownVsMs: number;
      stoppingDistanceM?: number; bounce?: boolean }
  | { type: 'go_around'; reasonGuess?: 'unstable' | 'high' | 'fast' | 'long' | 'unknown' }
  | { type: 'ils_approach'; runway?: string; locDeviationDegStd?: number;
      gsDeviationDotsStd?: number; minimaAltM?: number }
  | { type: 'rnav_approach'; runway?: string; vnavDeviationStd?: number }
  | { type: 'holding'; fix?: string; turns: number; inboundCourseDeg?: number }
  | { type: 'steep_turn'; bankDeg: number; turns: number; altLossM: number; altGainM: number }
  | { type: 'stall'; entryAltM: number; recoveryAltLossM: number; minIasMs?: number }
  | { type: 'slow_flight'; durationSec: number; minIasMs: number; altHoldStdM: number }
  | { type: 'chandelle'; entryAltM: number; topAltM: number; entryHdgDeg: number; exitHdgDeg: number }
  | { type: 'lazy_8'; cycles: number; entryAltM: number; altHoldStdM: number }
  | { type: 'turns_around_point'; centerLat: number; centerLon: number; radiusM: number;
      circleCount: number; radiusVarianceM: number };

export interface SegmentScore {
  pass: boolean;
  score: number;        // 0..100
  criteria: SegmentCriterion[];
}

export interface SegmentCriterion {
  label: string;
  key: string;
  target: number | string;
  tolerance?: number;
  value: number | string;
  pass: boolean;
  unit?: string;
}

export type EventType =
  | 'liftoff' | 'touchdown' | 'go_around'
  | 'bank_exceeded' | 'g_exceeded' | 'stall_warning'
  | 'gear_up' | 'gear_down' | 'flaps_change'
  | 'altitude_bust' | 'speed_exceeded'
  | 'frequency_change' | 'manual_marker' | 'audio_marker';

export interface FlightEvent {
  id: string;
  flightId: string;
  ts: number;
  type: EventType;
  attrs?: Record<string, unknown>;
  severity?: 'info' | 'warning' | 'critical';
}

export type AircraftCategory =
  | 'SEL' | 'MEL' | 'SES' | 'MES'
  | 'glider' | 'helicopter' | 'experimental';

export interface Aircraft {
  id: string;
  ownerId: string;
  registration: string;
  typeIcao: string | null;
  model: string | null;
  category: AircraftCategory;
  vneKt: number | null;
  vnoKt: number | null;
  vaKt: number | null;
  vfeKt: number | null;
  stallCleanKt: number | null;
  stallDirtyKt: number | null;
  createdAt: number;
}

export interface CreateFlightRequest {
  clientId: string;
  recordedWith: RecordedWith;
  startedAt: number;
  endedAt: number;
  aircraftId?: string;
  title?: string;
  description?: string;
  /** SHA-256 hex of the raw blob; server verifies. */
  rawBlobSha256: string;
  rawBlobBytes: number;
  /** Compressed downsampled track, base64. ≤ 200 KB. */
  trackBlobBase64: string;
}

export interface CreateFlightResponse {
  flightId: string;
  rawUploadUrl: string;
  finalizeUrl: string;
}

export interface ListFlightsQuery {
  cursor?: string;
  limit?: number;
  pilotId?: string;
  aircraftId?: string;
  visibility?: Visibility;
  fromTs?: number;
  toTs?: number;
}

export interface ListFlightsResponse {
  flights: FlightSummary[];
  nextCursor: string | null;
}

export type FlightSummary = Omit<Flight, 'trackBlobKey' | 'rawBlobKey' | 'audioBlobKey'>;

export interface GetFlightResponse {
  flight: Flight;
  segments: Segment[];
  events: FlightEvent[];
  track: TelemetrySample[];
}
```
