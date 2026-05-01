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

  // Playwright 1.40+ uses chromium_headless_shell; older builds use chrome
  // Binary lives at:  <base>/chromium-<build>/chrome-linux/<binary>
  const binaryNames = ['chromium_headless_shell', 'chrome', 'chromium'];
  try {
    const entries = fs.readdirSync(base);
    for (const entry of entries) {
      if (!entry.startsWith('chromium')) continue;
      const entryPath = path.join(base, entry);
      // Check chrome-linux subdirectory first (standard location)
      for (const bin of binaryNames) {
        const candidate = path.join(entryPath, 'chrome-linux', bin);
        if (fs.existsSync(candidate)) {
          console.log(`[browser-launch] Using executablePath: ${candidate}`);
          return candidate;
        }
      }
      // Also check directly in the entry dir (some builds)
      for (const bin of binaryNames) {
        const candidate = path.join(entryPath, bin);
        if (fs.existsSync(candidate)) {
          console.log(`[browser-launch] Using executablePath: ${candidate}`);
          return candidate;
        }
      }
    }
    // Log what IS in the base dir to help debug
    const entries2 = fs.readdirSync(base).filter(e => e.startsWith('chromium'));
    console.warn('[browser-launch] chromium dirs found:', entries2);
    if (entries2.length) {
      const sub = path.join(base, entries2[0], 'chrome-linux');
      try { console.warn('[browser-launch] chrome-linux contents:', fs.readdirSync(sub)); } catch(e2) {}
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
