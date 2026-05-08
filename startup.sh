#!/bin/bash
echo "==> Starting PAi server..."

# Install Playwright Chromium at startup if not already present.
# Stored in /tmp/ms-playwright (first candidate in browser-launch.js).
# Takes ~60s on first start after a deploy; subsequent starts are instant.
BROWSERS_PATH="/tmp/ms-playwright"
CHROME_BIN=$(find "$BROWSERS_PATH" -name "chrome-headless-shell" -o -name "chrome" 2>/dev/null | head -1)

if [ -n "$CHROME_BIN" ]; then
  echo "==> Chromium already installed: $CHROME_BIN"
else
  # Install in the background so node server.js can bind its port immediately.
  # Render's port-scan timeout is ~5 min; Chromium extraction can take longer
  # on the Starter instance. The background process survives exec below.
  # Scrapers that need Chromium will work once the install finishes (~2-3 min).
  echo "==> Chromium not found — starting background install (logs: /tmp/chromium-install.log)..."
  PLAYWRIGHT_BROWSERS_PATH="$BROWSERS_PATH" npx playwright install chromium \
    > /tmp/chromium-install.log 2>&1 &
  echo "==> Chromium install running in background (PID: $!)"
fi

exec node server.js
