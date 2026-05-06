
## Component briefs

### shared/parsers/

Pure TS, runs in browser + Worker + Node — no DOMParser, no fast-xml-parser.

- **types.ts**: `ParseResult { format, samples, meta, warnings }`,
  `ParseMeta { startedAt, endedAt, pilotName?, aircraftRegistration?,
  aircraftType?, producer?, departureIcao?, arrivalIcao? }`,
  `ParseError extends Error`, `isValidPosSample(s)`.
- **xml.ts**: ~250-line pull-style walker. `parseXml(src) -> XmlEl`,
  `findAll(el, name)`, `findFirst`, `childText`. Lowercases tag/attr names.
  Handles CDATA, entities (`&amp;`, `&#x...`), strips `<?xml ?>` + comments.
  Throws on unbalanced tags.
- **gpx.ts**: `parseGpx(src) -> ParseResult`. Walks every `<trk>/<trkseg>/<trkpt>`,
  reads `<ele>`, `<time>`, sniffs `<extensions>` loosely for speed/course
  (kt vs m/s by tag name). Derives missing GS/track/VS from successive
  positions (haversine + bearing). Extracts pilot from `<metadata><author>`,
  registration from `<trk><name>` if it looks like an N-number regex.
- **kml.ts**: prefers `<gx:Track>` (parallel `<when>` + `<gx:coord>`), falls
  back to `<LineString><coordinates>` with synthesized 1 Hz timestamps.
  Coords are space-separated `lon lat alt` triples.
- **csv.ts**: dispatches on first line: `#airframe_info` → G1000;
  `timestamp,lat,lon,...` → ForeFlight; else generic. G1000 reads
  `Lcl Date + Lcl Time + UTCOfst` for time, converts ft→m and kt→m/s,
  source = `panel`. Generic sniffs columns by keyword (time/lat/lon/alt/
  speed/course/heading) and unit hints in header (`ft`, `kt`).
- **igc.ts**: line-oriented. `H` records: `HFDTE` for date (DDMMYY → 2000+
  if YY<70), `HFPLT*` pilot, `HFGTY*` aircraft type, `HFGID*` registration.
  `B` records (35 chars): `B HHMMSS DDMMmmm[NS] DDDMMmmm[EW] [AV] PPPPP GGGGG`
  — parse lat as 7-digit DDMMmmm + hemi, lon as 8-digit DDDMMmmm + hemi.
  Detect midnight wrap: if t < prev, add 86400000 ms.
- **index.ts**: `parseAny(filename, content)` sniffs format from first 4 KB
  (IGC by `^A[A-Z]{3}` + `B\d{6}` line, GPX/KML by root tag, else CSV by
  comma + newline) before falling back to extension.

### workers/api/

Hono on Workers. Bindings: `DB` (D1), `BLOBS` (R2), optional
`ANALYZE_QUEUE` (Queue producer). All `/v1/*` require auth except
`/v1/share/:token`.

Routes:
- `POST /v1/flights` — validates `CreateFlightRequest`, idempotent on
  `(pilot_id, client_id)`. Stores 1 Hz preview to R2 immediately, returns
  signed PUT URL for raw blob.
- `POST /v1/flights/:id/finalize` — verifies raw blob landed (`BLOBS.head`),
  enqueues `{flightId}` to `ANALYZE_QUEUE`.
- `GET /v1/flights` — cursor-paginated (cursor = `${startedAt}_${id}`).
- `GET /v1/flights/:id` — returns `Flight` + segments + events + 1 Hz track
  (decompressed from R2 gzip).
- `PATCH /v1/flights/:id`, `DELETE /v1/flights/:id`.
- `GET /v1/flights/:id/raw` — streams full-rate blob.
- `POST /v1/flights/:id/annotations`, `GET /v1/flights/:id/annotations`.
- `POST /v1/flights/:id/share` → token, `GET /v1/share/:token` (public).
- `GET/POST /v1/aircraft`.
- `GET /v1/me`.

**auth.ts**: Bearer; tokens starting `skw_` are API keys (sha256-hashed
against `api_tokens.token_hash`); else HS256 JWT signed with `JWT_SIGNING_KEY`.

**r2.ts**: thin wrappers + custom V4 presigned PUT URL signer (no AWS SDK
in Workers). Falls back to dev proxy URL if R2 creds missing.

**ids.ts**: ULID generator (Crockford-base32, 26 chars).

**compress.ts**: `gunzipBase64(b64)` and `gzipString(s)` via
`DecompressionStream`/`CompressionStream`.

**rowmap.ts**: `rowToFlight`, `rowToSegment`, `rowToEvent` — D1 row → domain
object. Centralized so column changes touch one file.
