'use strict';
/**
 * browser-launch.js
 * Resolves the Playwright Chromium binary path at runtime so scrapers work on
 * Render (where the executable lives under PLAYWRIGHT_BROWSERS_PATH) and
 * locally (where `playwright` manages the path itself).
 *
 * Supports both old and new Playwright directory structures:
 *   Old (< 1.40): chromium-NNN/chrome-linux/chrome
 *   New (>= 1.40): chromium_headless_shell-NNN/chrome-headless-shell-linux64/chrome-headless-shell
 */
const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

// Force PLAYWRIGHT_BROWSERS_PATH to where the build installs Chromium (node_modules, preserved by
// Render's build cache). The Render dashboard env var still points to the old path — override it
// unconditionally so Playwright always looks in the right place.
const _nodeBrowsersPath = path.join(__dirname, '..', 'node_modules', '.playwright-browsers');
process.env.PLAYWRIGHT_BROWSERS_PATH = _nodeBrowsersPath;
console.log(`[browser-launch] PLAYWRIGHT_BROWSERS_PATH set to: ${_nodeBrowsersPath} (exists: ${fs.existsSync(_nodeBrowsersPath)}`);

/**
 * Resolves the chromium executable path from PLAYWRIGHT_BROWSERS_PATH.
 * Returns undefined when running locally (playwright finds it automatically).
 */
function resolveExecutablePath() {
  // Check multiple candidate paths — node_modules path is inside Render's build cache
  const candidates = [
    '/tmp/ms-playwright',
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    path.join(__dirname, '..', 'node_modules', '.playwright-browsers'),
  ].filter(Boolean);
  const base = candidates.find(p => { try { return require('fs').readdirSync(p).some(e => e.startsWith('chromium')); } catch(_) { return false; } })
    || process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!base) return undefined;

  // Sub-directory patterns Playwright uses (checked in priority order)
  const subDirs = [
    'chrome-headless-shell-linux64', // Playwright >= 1.40 (chromium_headless_shell-*)
    'chrome-linux64',                // Chrome for Testing (npx playwright install chromium)
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
  '--disable-http2',            // prevents ERR_HTTP2_PROTOCOL_ERROR on some sites
  '--ignore-certificate-errors', // needed for some enterprise portals (Yum SSO)
  '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  // Memory reduction for Render Starter (512MB RAM)
  '--single-process',           // all renderer/GPU work in main process — eliminates subprocess overhead (~100MB)
  '--disable-extensions',
  '--disable-default-apps',
  '--no-first-run',
  '--disable-sync',
  '--disable-background-networking',
  '--disable-client-side-phishing-detection',
  '--disable-component-extensions-with-background-pages',
  '--disable-hang-monitor',
  '--disable-prompt-on-repost',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--metrics-recording-only',
  '--no-default-browser-check',
  '--safebrowsing-disable-auto-update',
  '--mute-audio',
  '--window-size=1280,800',
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
