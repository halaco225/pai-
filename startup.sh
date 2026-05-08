#!/bin/bash
echo "==> Starting PAi server..."
echo "==> PLAYWRIGHT_BROWSERS_PATH: ${PLAYWRIGHT_BROWSERS_PATH:-not set}"

BROWSER_DIR="${PLAYWRIGHT_BROWSERS_PATH:-/opt/render/project/src/playwright-browsers}"
CHROME_BIN=$(find "$BROWSER_DIR" -name "chrome" -o -name "chrome-headless-shell" 2>/dev/null | head -1)
if [ -n "$CHROME_BIN" ]; then
  echo "==> Browser ready: $CHROME_BIN"
else
  echo "==> WARNING: Chromium not found at $BROWSER_DIR — scraping will be unavailable"
fi

exec node server.js
