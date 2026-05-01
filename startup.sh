#!/bin/bash
cd /opt/render/project/src

echo "==> PLAYWRIGHT_BROWSERS_PATH: ${PLAYWRIGHT_BROWSERS_PATH:-not set}"
echo "==> Checking for chromium binary..."

# Check if browser already exists from build step
CHROME_BIN=$(find "${PLAYWRIGHT_BROWSERS_PATH:-/opt/render/project/src}" -name "chrome-headless-shell" -o -name "chrome" 2>/dev/null | head -1)

if [ -z "$CHROME_BIN" ]; then
  echo "==> Browser not found from build — attempting install..."
  ./node_modules/.bin/playwright install chromium 2>&1 || true
  CHROME_BIN=$(find "${PLAYWRIGHT_BROWSERS_PATH:-/opt/render/project/src}" -name "chrome-headless-shell" -o -name "chrome" 2>/dev/null | head -1)
fi

if [ -z "$CHROME_BIN" ]; then
  echo "==> WARNING: Chromium binary still not found. Playwright scrapers will fail."
  ls "${PLAYWRIGHT_BROWSERS_PATH:-/opt/render/project/src}"/chromium* 2>/dev/null || echo "  (no chromium dirs)"
else
  echo "==> Browser found: $CHROME_BIN"
fi

echo "==> Starting server..."
exec node server.js
