#!/bin/bash
set -e
echo "==> Installing Playwright Chromium browser..."
npx playwright install chromium
echo "==> Playwright install complete. Starting server..."
exec node server.js
