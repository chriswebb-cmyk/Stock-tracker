# Skywake source export

Bridge branch — do not merge. Source tree for the Skywake flight debrief
project. See `skywake/README.md` for what's here.

## To move into a standalone repo on your laptop

```bash
git clone -b claude/skywake-export https://github.com/chriswebb-cmyk/stock-tracker.git skywake-export
cd skywake-export/skywake

# Regenerate the synthetic demo fixture (binary, not in this branch)
node fixtures/generate.mjs

# Verify the parsers (no install needed — pure node)
node fixtures/parsers/test.mjs

# Initialize a fresh repo and push
git init -b main
git add .
git commit -m 'Initial Skywake import'
git remote add origin https://github.com/chriswebb-cmyk/skywake.git
git push -u origin main
```

If your repo name still has the leading `-` (`-skywake`), rename it on
GitHub first — leading-dash repo names break many CLIs.

Delete this `claude/skywake-export` branch in stock-tracker once you've
pushed; it's transient.
