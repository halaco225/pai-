#!/bin/bash
echo "==> Starting PAi server..."

# Install Playwright Chromium at startup if not already present.
# Stored in /tmp/ms-playwright (first candidate in browser-launch.js).
# Takes ~60s on first start after a deploy; subsequent starts are instant.
BROWSERS_PATH="/tmp/ms-playwright"
CHROME_BIN=$(find "$BROWSERS_PATH" -name "chrome-headless-shell" -o -name "chrome" 2>/dev/null | head -1)

if [ -n "$CHROME_BIN" ]; then
  echo "==> Chromium already installed: $CHROME_BIN"
else
  echo "==> Chromium not found — installing via playwright (this takes ~60s)..."
  PLAYWRIGHT_BROWSERS_PATH="$BROWSERS_PATH" npx playwright install chromium
  CHROME_BIN=$(find "$BROWSERS_PATH" -name "chrome-headless-shell" -o -name "chrome" 2>/dev/null | head -1)
  if [ -n "$CHROME_BIN" ]; then
    echo "==> Chromium installed: $CHROME_BIN"
  else
    echo "==> WARNING: Chromium install may have failed — scrapers that need a browser will error"
  fi
fi

exec node server.js
