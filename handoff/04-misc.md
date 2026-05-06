
## D1 schema

The full schema is already on `chriswebb-cmyk/stock-tracker` at branch
`claude/skywake-export`, path `skywake/db/schema.sql`. Copy it verbatim.

Key tables: `users`, `aircraft`, `flights`, `segments`, `events`,
`annotations`, `shares`, `api_tokens`, `airports`. All FKs cascade. ULIDs
as TEXT primary keys. Each `flights` row carries R2 keys for raw blob,
1 Hz preview track, and optional audio.

---

## Files already on the bridge

`chriswebb-cmyk/stock-tracker` branch `claude/skywake-export` has:
- `README.md` (the bridge instructions)
- `skywake/.gitignore`
- `skywake/.env.example`
- `skywake/README.md`
- `skywake/db/schema.sql`
- (and partial docs)

Pull those down rather than re-spec'ing them from scratch:

```
git clone -b claude/skywake-export https://github.com/chriswebb-cmyk/stock-tracker.git tmp
cp -r tmp/skywake/* ~/skywake/
rm -rf tmp
```

---

## Build & run

```bash
# 1) Generate the synthetic flight + verify parsers
node fixtures/generate.mjs
node fixtures/parsers/test.mjs

# 2) iOS — open project.yml in XcodeGen, then Xcode
xcodegen generate
open Skywake.xcodeproj

# 3) Workers
cd workers/api && npm install && npx wrangler d1 create skywake
# fill database_id into all three workers' wrangler.toml
npx wrangler d1 execute skywake --file=../../db/schema.sql
npm run dev      # :8787

cd ../analyze && npm install && npm run dev   # :8788
cd ../ingest  && npm install && npm run dev   # :8789

# 4) Web
cd ../../web && npm install && npm run dev    # :5173
```

Set `VITE_CESIUM_ION_TOKEN` (https://ion.cesium.com), `VITE_API_URL`,
worker secrets `JWT_SIGNING_KEY`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
`R2_SECRET_ACCESS_KEY` via `wrangler secret put`.

---

## What's tested

- All 4 parsers green against fixture samples (`node fixtures/parsers/test.mjs`).
- Demo flight encodes to ~64 KB `.skywake` blob, decodes back to 4097 samples.

What still needs hands-on work after the rebuild:
- Cesium token configuration end-to-end.
- Real `wrangler deploy` for all three workers.
- Xcode signing + on-device IMU calibration.
- Vitest specs for the analyzer pipeline (scaffold present, no specs yet).

---

## Style and conventions

- TypeScript strict mode on all packages. `noUnusedLocals: true`.
- Comments only when WHY is non-obvious. No "added by X" markers.
- Logs: `console.error` for genuine errors, never `console.log` debug spam.
- Don't pull in dependencies for things you can write in 50 lines (XML walker).
- Each Worker is a separate npm package with its own `package.json` and
  `tsconfig.json`. They all share types via `import from '../../../shared/types.js'`.

End of spec.
