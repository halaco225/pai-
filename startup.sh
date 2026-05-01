#!/bin/bash
export PLAYWRIGHT_BROWSERS_PATH=/tmp/ms-playwright

echo "==> Installing Playwright Chromium to $PLAYWRIGHT_BROWSERS_PATH ..."
./node_modules/.bin/playwright install chromium
echo "Exit code: $?"

CHROME_BIN=$(find "$PLAYWRIGHT_BROWSERS_PATH" -name "chrome-headless-shell" -o -name "chrome" 2>/dev/null | head -1)
if [ -n "$CHROME_BIN" ]; then
  echo "==> Browser ready: $CHROME_BIN"
else
  echo "==> WARNING: Browser not found after install. Listing $PLAYWRIGHT_BROWSERS_PATH:"
  ls -la "$PLAYWRIGHT_BROWSERS_PATH" 2>/dev/null || echo "  (dir missing)"
fi

echo "==> Starting server..."
exec node server.js
