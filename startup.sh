#!/bin/bash
echo "==> Starting PAi server..."

# SMG OAuth2 is now handled by GitHub Actions (smg-pull.js).
# Playwright on Render is no longer required — skip browser install.

exec node server.js
