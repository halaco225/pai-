#!/bin/bash
echo "==> Starting PAi server..."
echo "==> PLAYWRIGHT_BROWSERS_PATH (env): ${PLAYWRIGHT_BROWSERS_PATH:-not set}"

NODE_BROWSERS="/opt/render/project/src/node_modules/.playwright-browsers"
echo "==> node_modules browser path exists: $([ -d "$NODE_BROWSERS" ] && echo YES || echo NO)"
CHROME_BIN=$(find "$NODE_BROWSERS" -name "chrome-headless-shell" -o -name "chrome" 2>/dev/null | head -1)
if [ -n "$CHROME_BIN" ]; then
  echo "==> Chromium found: $CHROME_BIN"
else
  echo "==> WARNING: Chromium not found in node_modules path — build may not have installed it"
fi

exec node server.js
