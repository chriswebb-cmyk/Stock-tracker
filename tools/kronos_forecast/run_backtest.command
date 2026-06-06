#!/bin/bash
# Double-clickable wrapper for backtest.py. Slow — typically 30–90 min on
# M1 8GB with Kronos-mini. Run occasionally, not daily.

set -u

KRONOS_DIR="$HOME/Desktop/options trading/Stock-tracker/tools/kronos_forecast"

cd "$KRONOS_DIR" || {
  echo "❌ Could not find $KRONOS_DIR"
  echo "Edit this file and update KRONOS_DIR if the repo lives elsewhere."
  exec "$SHELL"
}

if [ ! -x "./.venv/bin/python" ]; then
  echo "❌ Python venv not found at ./.venv/bin/python"
  echo "Run the one-time setup in tools/kronos_forecast/README.md first."
  exec "$SHELL"
fi

echo "▶ Running Kronos backtest from $KRONOS_DIR"
echo "  (this typically takes 30–90 minutes — go grab coffee)"
echo "──────────────────────────────────────────────────────────────"
./.venv/bin/python backtest.py "$@"
STATUS=$?
echo "──────────────────────────────────────────────────────────────"
if [ $STATUS -eq 0 ]; then
  echo "✅ Done. Hit rate / MAE columns will populate in the Kronos tab."
else
  echo "❌ backtest.py exited with status $STATUS"
fi
echo ""
echo "(Close this Terminal window when finished.)"
exec "$SHELL"
