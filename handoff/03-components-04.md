### fixtures/generate.mjs

Synthesizes a 17-min KPAO→KSQL demo flight at 4 Hz. Profile:
1. Taxi 90 s @ 8 kt
2. Takeoff roll 12 s
3. Climb to 3500 ft @ 900 fpm
4. Steep turn left 360° @ 45° bank
5. Cruise 30 s
6. Power-off stall + recovery
7. Cruise to KSQL pointing at airport bearing
8. ILS-like approach RWY 30 @ 700 fpm
9. Touch-and-go
10. Pattern: crosswind/downwind/base/final
11. Full-stop landing + taxi

Output:
- `fixtures/demo.skywake` (binary .skywake)
- `fixtures/demo-track.json.gz` (1 Hz gzipped preview)
- `fixtures/demo-track.json` (1 Hz preview JSON)
- `fixtures/demo-full.json` (full-rate JSON for testing)

### fixtures/parsers/

One sample file per format + `test.mjs` that asserts:
- ≥4 samples
- t > 0 ascending
- |lat| ≤ 90, |lon| ≤ 180
- meta.startedAt > 0, meta.endedAt ≥ startedAt
- GPX/IGC: aircraftRegistration extracted as "N12345"

Sample IGC must use **7-digit lat** (DDMMmmm) + 1 hemi letter, **8-digit lon**
(DDDMMmmm) + 1 hemi letter — total 35 chars per B-record. Lat slice
indices 7-14, lon 15-23, validity at 24, pressure alt 25-29, GNSS alt 30-34.
This bit me; don't use 8-digit lat.
