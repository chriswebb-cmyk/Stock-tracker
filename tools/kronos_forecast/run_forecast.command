#!/bin/bash
# Double-clickable wrapper for forecast.py. Drop a copy on your Desktop
# (or anywhere) and double-click to run a fresh Kronos forecast.
#
# Terminal will open, the script will run, and the window will stay open
# (running an interactive shell) so you can read the output. Close the
# Terminal tab/window when you're done.

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

echo "▶ Running Kronos forecast from $KRONOS_DIR"
echo "──────────────────────────────────────────────────────────────"
./.venv/bin/python forecast.py
STATUS=$?
echo "──────────────────────────────────────────────────────────────"
if [ $STATUS -eq 0 ]; then
  echo "✅ Done. Refresh the Kronos tab in the dashboard to see new forecasts."
else
  echo "❌ forecast.py exited with status $STATUS"
fi
echo ""
echo "(Close this Terminal window when finished.)"
exec "$SHELL"
