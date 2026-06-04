#!/bin/bash
echo "==> Starting PAi server..."

# Install Playwright Chromium if the binary is missing.
# The build installs to playwright-browsers/ but the binary may not be present
# if the download was interrupted or the version directory is empty.
BROWSERS_PATH="/opt/render/project/src/playwright-browsers"
if ! find "$BROWSERS_PATH" -name "chrome-headless-shell" -type f 2>/dev/null | grep -q .; then
  echo "==> Playwright chrome-headless-shell not found — installing now..."
  PLAYWRIGHT_BROWSERS_PATH="$BROWSERS_PATH" npx playwright install chromium-headless-shell 2>&1 | tail -10
  echo "==> Playwright install complete"
fi

exec node server.js
