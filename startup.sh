#!/bin/bash
echo "==> Starting PAi server..."

BROWSERS_PATH="/opt/render/project/src/playwright-browsers"
echo "==> Playwright browsers path: $BROWSERS_PATH"
echo "==> Directory exists: $(test -d $BROWSERS_PATH && echo YES || echo NO)"
echo "==> Contents: $(ls $BROWSERS_PATH 2>/dev/null || echo '(empty or missing)')"

BINARY=$(find "$BROWSERS_PATH" -name "chrome-headless-shell" -type f 2>/dev/null | head -1)
if [ -z "$BINARY" ]; then
  echo "==> chrome-headless-shell binary NOT found — running playwright install..."
  rm -rf "$BROWSERS_PATH"
  PLAYWRIGHT_BROWSERS_PATH="$BROWSERS_PATH" npx playwright install chromium-headless-shell
  INSTALL_EXIT=$?
  echo "==> Install exit code: $INSTALL_EXIT"
  BINARY=$(find "$BROWSERS_PATH" -name "chrome-headless-shell" -type f 2>/dev/null | head -1)
  echo "==> Binary after install: ${BINARY:-(not found)}"
else
  echo "==> Playwright binary found: $BINARY"
fi

exec node server.js
