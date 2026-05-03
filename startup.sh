#!/bin/bash
echo "==> Starting PAi server..."
echo "==> PLAYWRIGHT_BROWSERS_PATH: ${PLAYWRIGHT_BROWSERS_PATH:-not set}"
echo "==> PWD: $(pwd)"

BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-/opt/render/project/src/playwright-browsers}"
CHROME_BIN=$(find "$BROWSERS_PATH" -name "chrome-headless-shell" -o -name "chrome" 2>/dev/null | head -1)

if [ -z "$CHROME_BIN" ]; then
  echo "==> Browser missing — installing synchronously to $BROWSERS_PATH"
  PLAYWRIGHT_BROWSERS_PATH="$BROWSERS_PATH" npx --yes playwright install chromium
  echo "==> Install exit code: $?"
  ls -la "$BROWSERS_PATH" 2>&1 || echo "==> Path still doesn't exist after install"
else
  echo "==> Browser ready: $CHROME_BIN"
fi

exec node server.js
