#!/bin/bash
# Double-clickable wrapper for Chronos forecast.py. Drop a copy on your
# Desktop and double-click to refresh Chronos forecasts.

set -u

CHRONOS_DIR="$HOME/Desktop/options trading/Stock-tracker/tools/chronos_forecast"

cd "$CHRONOS_DIR" || {
  echo "❌ Could not find $CHRONOS_DIR"
  echo "Edit this file and update CHRONOS_DIR if the repo lives elsewhere."
  exec "$SHELL"
}

if [ ! -x "./.venv/bin/python" ]; then
  echo "❌ Python venv not found at ./.venv/bin/python"
  echo "Run the one-time setup in tools/chronos_forecast/README.md first."
  exec "$SHELL"
fi

echo "▶ Running Chronos forecast from $CHRONOS_DIR"
echo "──────────────────────────────────────────────────────────────"
./.venv/bin/python forecast.py
STATUS=$?
echo "──────────────────────────────────────────────────────────────"
if [ $STATUS -eq 0 ]; then
  echo "✅ Done. Refresh the Chronos tab in the dashboard."
else
  echo "❌ forecast.py exited with status $STATUS"
fi
echo ""
echo "(Close this Terminal window when finished.)"
exec "$SHELL"
