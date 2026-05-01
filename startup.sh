#!/bin/bash
echo "==> Starting PAi server..."
echo "==> PLAYWRIGHT_BROWSERS_PATH: ${PLAYWRIGHT_BROWSERS_PATH:-not set}"

# Just verify — don't install at runtime (handled by build)
CHROME_BIN=$(find "${PLAYWRIGHT_BROWSERS_PATH:-/opt/render/project/src}" -name "chrome-headless-shell" -o -name "chrome" 2>/dev/null | head -1)
if [ -n "$CHROME_BIN" ]; then
  echo "==> Browser ready: $CHROME_BIN"
else
  echo "==> WARNING: No browser binary found. Playwright scrapers will fail."
fi

exec node server.js
