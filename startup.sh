#!/bin/bash
set -e

export PLAYWRIGHT_BROWSERS_PATH=/opt/render/project/src

echo "==> Installing Playwright Chromium browser to $PLAYWRIGHT_BROWSERS_PATH ..."
./node_modules/.bin/playwright install --with-deps chromium

echo "==> Verifying browser binary..."
CHROME_BIN=$(find "$PLAYWRIGHT_BROWSERS_PATH" -name "chrome-headless-shell" -o -name "chromium_headless_shell" -o -name "chrome" 2>/dev/null | head -1)
if [ -z "$CHROME_BIN" ]; then
  echo "==> WARNING: Could not find chromium binary — listing $PLAYWRIGHT_BROWSERS_PATH:"
  ls -la "$PLAYWRIGHT_BROWSERS_PATH" 2>/dev/null || true
else
  echo "==> Found browser at: $CHROME_BIN"
fi

echo "==> Starting server..."
exec node server.js
