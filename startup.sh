#!/bin/bash
echo "==> Starting PAi server..."
echo "==> PLAYWRIGHT_BROWSERS_PATH: ${PLAYWRIGHT_BROWSERS_PATH:-not set}"

BROWSER_DIR="${PLAYWRIGHT_BROWSERS_PATH:-/opt/render/project/src/playwright-browsers}"
CHROME_BIN=$(find "$BROWSER_DIR" -name "chrome" -o -name "chrome-headless-shell" 2>/dev/null | head -1)
if [ -n "$CHROME_BIN" ]; then
  echo "==> Browser ready: $CHROME_BIN"
else
  echo "==> Chromium not found — installing now..."
  npx playwright install chromium 2>&1
  CHROME_BIN=$(find "$BROWSER_DIR" -name "chrome" -o -name "chrome-headless-shell" 2>/dev/null | head -1)
  if [ -n "$CHROME_BIN" ]; then
    echo "==> Browser installed: $CHROME_BIN"
  else
    echo "==> WARNING: Chromium install failed — Fourth/scraping will be unavailable"
  fi
fi

exec node server.js
