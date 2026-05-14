#!/bin/bash
echo "==> Starting PAi server..."

# Install Playwright browser at startup so it survives Render build cache
if [ -n "$PLAYWRIGHT_BROWSERS_PATH" ]; then
  echo "==> Installing Playwright browser to $PLAYWRIGHT_BROWSERS_PATH..."
  PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS_PATH" npx playwright install chromium-headless-shell 2>&1 | tail -5
  PLAYWRIGHT_BROWSERS_PATH="$PLAYWRIGHT_BROWSERS_PATH" npx playwright install-deps chromium-headless-shell 2>&1 | tail -5 || true
  echo "==> Playwright install done"
fi

exec node server.js
