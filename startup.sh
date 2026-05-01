#!/bin/bash
set -e
export PLAYWRIGHT_BROWSERS_PATH=/opt/render/project/src
echo "==> Installing Playwright Chromium browser to $PLAYWRIGHT_BROWSERS_PATH ..."
npx playwright install chromium
echo "==> Playwright install complete. Starting server..."
exec node server.js
