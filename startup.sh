#!/bin/bash
echo "==> Starting PAi server..."
echo "==> PLAYWRIGHT_BROWSERS_PATH: ${PLAYWRIGHT_BROWSERS_PATH:-not set}"

# Verify browser binary is present — install happens at BUILD time, not here
BROWSER_DIR="${PLAYWRIGHT_BROWSERS_PATH:-/opt/render/project/src/playwright-browsers}"
CHROME_BIN=$(find "$BROWSER_DIR" -name "chrome-headless-shell" -o -name "chrome" 2>/dev/null | head -1)
if [ -n "$CHROME_BIN" ]; then
  echo "==> Browser ready: $CHROME_BIN"
else
  echo "==> WARNING: No browser binary found in $BROWSER_DIR"
  echo "==> Directory contents:"
  ls -la "$BROWSER_DIR" 2>/dev/null || echo "   (directory does not exist)"
fi

exec node server.js
