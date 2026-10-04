'use strict';
/**
 * browser-launch.js
 * Resolves the Playwright Chromium binary path at runtime so scrapers work on
 * Render (where startup.sh installs Chromium to /tmp/ms-playwright) and
 * locally (where `playwright` manages the path itself).
 *
 * Supports both old and new Playwright directory structures:
 *   Old (< 1.40): chromium-NNN/chrome-linux/chrome
 *   New (>= 1.40): chromium_headless_shell-NNN/chrome-headless-shell-linux64/chrome-headless-shell
 *   Chrome for Testing: chromium-NNN/chrome-linux64/chrome  (npx playwright install chromium)
 *
 * CRITICAL: PLAYWRIGHT_BROWSERS_PATH must be set BEFORE requiring playwright.
 * Playwright's internal Registry reads this env var at module-load time and
 * caches it — any override after require('playwright') has no effect on the
 * path Playwright uses for its own fallback resolution.
 */

// Set the browsers path BEFORE requiring playwright — Playwright's internal
// Registry reads this env var at module-load time and caches it.
// The build command installs chromium-headless-shell to playwright-browsers/
// (non-hidden directory in the project root — guaranteed to be in the
// Render deployment artifact).  Hidden dirs (.playwright-browsers inside
// node_modules) are stripped by Render's packager and never reach the VM.
// Two candidates, in order: the project directory the build is meant to fill,
// and /tmp, which is always writable at runtime. Whichever already holds a
// chromium wins; if neither does, ensureBrowser() installs into /tmp below.
//
// This has to happen before require('playwright'), because Playwright reads
// the variable at import time -- a later change is ignored, which is why
// clearing it inside launchContext did nothing.
const _fsBoot = require('fs');
const BUILD_BROWSERS = '/opt/render/project/src/playwright-browsers';
const TMP_BROWSERS   = '/tmp/ms-playwright';

function _hasChromium(dir) {
  try { return _fsBoot.readdirSync(dir).some(e => e.startsWith('chromium')); } catch (_) { return false; }
}

process.env.PLAYWRIGHT_BROWSERS_PATH =
  _hasChromium(BUILD_BROWSERS) ? BUILD_BROWSERS
  : _hasChromium(TMP_BROWSERS) ? TMP_BROWSERS
  : TMP_BROWSERS;   // nothing installed yet — ensureBrowser() will fill this

const { chromium } = require('playwright');
const fs   = require('fs');
const path = require('path');

const _browsersPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
console.log(`[browser-launch] PLAYWRIGHT_BROWSERS_PATH=${_browsersPath} (exists: ${fs.existsSync(_browsersPath)})`);

/**
 * Resolves the chromium executable path from PLAYWRIGHT_BROWSERS_PATH.
 * Returns undefined when running locally (playwright finds it automatically).
 */
function resolveExecutablePath() {
  // Search candidate paths in priority order for an installed Chromium browser
  // PLAYWRIGHT_BROWSERS_PATH=0 means the browser lives inside node_modules and
  // Playwright resolves it itself. Returning undefined lets it do that; forcing
  // a path here would point at a directory that does not exist.
  if (process.env.PLAYWRIGHT_BROWSERS_PATH === '0') return undefined;

  // Self-heal a stale PLAYWRIGHT_BROWSERS_PATH. Render keeps dashboard env
  // values over render.yaml, so this can still point at the old directory that
  // no browser was ever installed into -- and Playwright trusts that variable
  // over anything we pass, failing with "Executable doesn't exist". Clearing it
  // when it leads nowhere lets Playwright fall back to its own default, which
  // is where the build now installs chromium.
  const configured = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (configured) {
    let usable = false;
    try { usable = fs.readdirSync(configured).some(e => e.startsWith('chromium')); } catch (_) {}
    if (!usable) {
      console.warn(`[browser] PLAYWRIGHT_BROWSERS_PATH=${configured} has no chromium; ignoring it`);
      delete process.env.PLAYWRIGHT_BROWSERS_PATH;
      return undefined;
    }
  }

  const candidates = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,                         // hardcoded above (playwright-browsers/)
    '/opt/render/project/src/playwright-browsers',                 // explicit fallback (same path, belt+suspenders)
    '/opt/render/project/src/node_modules/.playwright-browsers',   // old node_modules path fallback
    '/tmp/ms-playwright',                                          // runtime install fallback
  ].filter(Boolean);
  const base = candidates.find(p => { try { return fs.readdirSync(p).some(e => e.startsWith('chromium')); } catch(_) { return false; } });
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

  // Log what we found to help debug missing binary
  console.warn(`[browser-launch] Could not resolve executablePath in ${base}. Dirs found:`, entries.filter(e => e.startsWith('chromium')));
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
// Install chromium on demand. The build is supposed to do this, but on this
// service it never has -- every browser-driven feature (WIN score, SMG
// comments, HutBot) has been dead since it was written. Installing at runtime
// costs a minute on the first call after a deploy and then nothing, and it
// does not depend on a build command or a dashboard setting being right.
let _installPromise = null;

function ensureBrowser() {
  if (_hasChromium(process.env.PLAYWRIGHT_BROWSERS_PATH)) return Promise.resolve(true);
  if (_installPromise) return _installPromise;

  _installPromise = new Promise((resolve) => {
    const { spawn } = require('child_process');
    console.log(`[browser-launch] no chromium found; installing into ${process.env.PLAYWRIGHT_BROWSERS_PATH}`);
    // require.resolve('playwright-core/cli.js') is blocked by that package's
    // "exports" map, so go at the CLI the way a shell would. Try each in turn.
    const pathMod = require('path');
    const root    = pathMod.join(__dirname, '..', 'node_modules');
    const tries   = [
      [pathMod.join(root, '.bin', 'playwright'),        ['install', 'chromium-headless-shell']],
      [process.execPath, [pathMod.join(root, 'playwright-core', 'cli.js'), 'install', 'chromium-headless-shell']],
      [process.execPath, [pathMod.join(root, 'playwright', 'cli.js'),      'install', 'chromium-headless-shell']],
      ['npx', ['--yes', 'playwright', 'install', 'chromium-headless-shell']],
    ];

    const attempt = (i) => {
      if (i >= tries.length) { console.error('[browser-launch] every install method failed'); _installPromise = null; return resolve(false); }
      const [cmd, args] = tries[i];
      console.log(`[browser-launch] install attempt ${i + 1}: ${cmd}`);
      const c = spawn(cmd, args, { env: process.env, stdio: 'inherit' });
      c.on('error', (e) => { console.warn(`[browser-launch] ${cmd} failed: ${e.message}`); attempt(i + 1); });
      c.on('exit', (code) => {
        if (_hasChromium(process.env.PLAYWRIGHT_BROWSERS_PATH)) {
          console.log('[browser-launch] chromium installed');
          _installPromise = null; return resolve(true);
        }
        console.warn(`[browser-launch] ${cmd} exited ${code} without installing`);
        attempt(i + 1);
      });
    };
    attempt(0);
  });
  return _installPromise;
}

async function launchContext(profileDir, extraOpts = {}) {
  await ensureBrowser();
  const executablePath = resolveExecutablePath();
  const opts = {
    headless: true,
    args: BASE_ARGS,
    ...extraOpts,
  };
  if (executablePath) opts.executablePath = executablePath;
  return chromium.launchPersistentContext(profileDir, opts);
}

module.exports = { launchContext, ensureBrowser };
