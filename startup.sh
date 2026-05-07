#!/bin/bash
echo "==> Starting PAi server..."
echo "==> PLAYWRIGHT_BROWSERS_PATH: ${PLAYWRIGHT_BROWSERS_PATH:-not set}"

BROWSER_DIR="${PLAYWRIGHT_BROWSERS_PATH:-/opt/render/project/src/playwright-browsers}"

# Install Chromium if not already present (handles cache miss without blocking build)
CHROME_BIN=$(find "$BROWSER_DIR" -name "chrome" -o -name "chrome-headless-shell" 2>/dev/null | head -1)
if [ -n "$CHROME_BIN" ]; then
  echo "==> Browser ready: $CHROME_BIN"
else
  echo "==> Chromium not found — installing now (first-time only, ~2-3 min)..."
  PLAYWRIGHT_BROWSERS_PATH="$BROWSER_DIR" npx playwright install chromium
  CHROME_BIN=$(find "$BROWSER_DIR" -name "chrome" -o -name "chrome-headless-shell" 2>/dev/null | head -1)
  if [ -n "$CHROME_BIN" ]; then
    echo "==> Browser installed: $CHROME_BIN"
  else
    echo "==> WARNING: Browser install may have failed — scraping will be unavailable"
  fi
fi

exec node server.js
