#!/bin/bash
cd /opt/render/project/src

export PLAYWRIGHT_BROWSERS_PATH=/opt/render/project/src

echo "==> CWD: $(pwd)"
echo "==> PLAYWRIGHT_BROWSERS_PATH: $PLAYWRIGHT_BROWSERS_PATH"
echo "==> Installing Playwright Chromium browser..."

# Use local playwright binary (no --with-deps at runtime — build handles system deps)
./node_modules/.bin/playwright install chromium 2>&1 || echo "==> playwright install exited non-zero (may still work)"

# Show what was installed
echo "==> Chromium dirs in $PLAYWRIGHT_BROWSERS_PATH:"
ls "$PLAYWRIGHT_BROWSERS_PATH"/chromium* 2>/dev/null || echo "  (none found)"

echo "==> Starting server..."
exec node server.js
