'use strict';
/**
 * browser-launch.js
 * Resolves the Playwright Chromium binary path at runtime so scrapers work on
 * Render (where the executable lives under PLAYWRIGHT_BROWSERS_PATH) and
 * locally (where `playwright` manages the path itself).
 *
 * Usage:
 *   const { launchContext } = require('./browser-launch');
 *   const browser = await launchContext(PROFILE_DIR, { acceptDownloads: true });
 */
const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

/**
 * Resolves the chromium executable path from PLAYWRIGHT_BROWSERS_PATH.
 * Returns undefined when running locally (playwright finds it automatically).
 */
function resolveExecutablePath() {
  const base = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!base) return undefined;

  // Binary lives at:  <base>/chromium-<build>/chrome-linux/chrome
  try {
    const entries = fs.readdirSync(base);
    for (const entry of entries) {
      if (!entry.startsWith('chromium')) continue;
      const candidate = path.join(base, entry, 'chrome-linux', 'chrome');
      if (fs.existsSync(candidate)) {
        console.log(`[browser-launch] Using executablePath: ${candidate}`);
        return candidate;
      }
      // Some builds use 'chrome' at the top of the entry dir
      const candidate2 = path.join(base, entry, 'chrome');
      if (fs.existsSync(candidate2)) {
        console.log(`[browser-launch] Using executablePath: ${candidate2}`);
        return candidate2;
      }
    }
  } catch (e) {
    console.warn('[browser-launch] Could not resolve executablePath:', e.message);
  }
  return undefined;
}

const BASE_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
];

/**
 * Wraps chromium.launchPersistentContext with Render-safe defaults.
 * @param {string} profileDir  - persistent profile directory path
 * @param {object} extraOpts   - any additional launchPersistentContext options (e.g. acceptDownloads)
 */
async function launchContext(profileDir, extraOpts = {}) {
  const executablePath = resolveExecutablePath();
  const opts = {
    headless: true,
    args: BASE_ARGS,
    ...extraOpts,
  };
  if (executablePath) opts.executablePath = executablePath;
  return chromium.launchPersistentContext(profileDir, opts);
}

module.exports = { launchContext };
