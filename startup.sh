#!/bin/bash
echo "==> Starting PAi server..."
echo "==> PLAYWRIGHT_BROWSERS_PATH: ${PLAYWRIGHT_BROWSERS_PATH:-not set}"

BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/render/project/src/playwright-browsers}"
CHROME_BIN=$(find "$BROWSERS_PATH" -name "chrome-headless-shell" -o -name "chrome" 2>/dev/null | head -1)

if [ -n "$CHROME_BIN" ]; then
  echo "==> Browser ready: $CHROME_BIN"
else
  echo "==> Browser missing — installing in background to $BROWSERS_PATH"
  (PLAYWRIGHT_BROWSERS_PATH="$BROWSERS_PATH" node_modules/.bin/playwright install chromium 2>&1 | sed 's/^/[playwright-install] /' &)
fi

exec node server.js
