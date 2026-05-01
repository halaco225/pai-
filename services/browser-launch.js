'use strict';
/**
 * browser-launch.js
 * Resolves the Playwright Chromium binary path at runtime so scrapers work on
 * Render (where the executable lives under PLAYWRIGHT_BROWSERS_PATH) and
 * locally (where `playwright` manages the path itself).
 *
 * Supports both old and new Playwright directory structures:
 *   Old (< 1.40): chromium-*/chrome-linux/chrome
 *   New (>= 1.40): chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell
 */
const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

/**
 * Resolves the chromium executable path from PLAYWRIGHT_BROWSERS_PATH.
 * Returns undefined when running locally (playwright finds it automatically).
 */
function resolveExecutablePath() {
  // Check /tmp/ms-playwright first (runtime install target), then env var path
  const candidates = ['/tmp/ms-playwright', process.env.PLAYWRIGHT_BROWSERS_PATH].filter(Boolean);
  const base = candidates.find(p => { try { return require('fs').readdirSync(p).some(e => e.startsWith('chromium')); } catch(_) { return false; } })
    || process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!base) return undefined;

  // Sub-directory patterns Playwright uses (checked in priority order)
  const subDirs = [
    'chrome-headless-shell-linux64', // Playwright >= 1.40 (chromium_headless_shell-*)
    'chrome-linux',                  // Playwright <  1.40 (chromium-*)
    '',                              // binary directly in the versioned dir
  ];
  // Binary names to try within each subDir
  const binaryNames = [
    'chrome-headless-shell',
    'chromium_headless_shell',
    'chrome',
    'chromium',
  ];

  let entries;
  try {
    entries = fs.readdirSync(base);
  } catch (e) {
    console.warn('[browser-launch] Cannot read PLAYWRIGHT_BROWSERS_PATH:', e.message);
    return undefined;
  }

  // Look in any directory starting with "chromium"
  const chromiumDirs = entries
    .filter(e => e.startsWith('chromium'))
    .map(e => path.join(base, e));

  for (const dir of chromiumDirs) {
    for (const sub of subDirs) {
      const searchDir = sub ? path.join(dir, sub) : dir;
      for (const bin of binaryNames) {
        const candidate = path.join(searchDir, bin);
        if (fs.existsSync(candidate)) {
          console.log(`[browser-launch] Using executablePath: ${candidate}`);
          return candidate;
        }
      }
    }
  }

  // Log what we found to help debug
  console.warn('[browser-launch] Could not resolve executablePath. Dirs found:', entries.filter(e => e.startsWith('chromium')));
  if (chromiumDirs.length > 0) {
    try {
      const firstDir = chromiumDirs[0];
      console.warn('[browser-launch] Contents of', firstDir + ':', fs.readdirSync(firstDir));
      for (const sub of subDirs.filter(Boolean)) {
        const subPath = path.join(firstDir, sub);
        if (fs.existsSync(subPath)) {
          console.warn('[browser-launch] Contents of', subPath + ':', fs.readdirSync(subPath));
        }
      }
    } catch (_) {}
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
 * @param {object} extraOpts   - any additional launchPersistentContext options
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
