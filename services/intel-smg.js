'use strict';
/**
 * SMG download helper — logs in via the referrerUri SSO flow and downloads
 * the previous-day "Comments By Comment" Excel export from SMG360.
 *
 * Auth flow:
 *   1. Navigate to 360.smg.com report card URL
 *   2. Wait up to 20 s for 360.smg.com SPA to redirect to
 *      reporting.smg.com/index.aspx?referrerUri=<card_url>
 *      (360.smg.com sets auth state before redirecting — going there directly
 *       would skip that state and break the session handoff)
 *   3. If still on 360.smg.com after 20 s → cached session, skip login
 *   4. Otherwise fill credentials + submit on reporting.smg.com
 *   5. Wait for redirect back to 360.smg.com — SPA session now established
 *   6. Navigate to card URL, find export button, download Excel
 */
const { launchContext } = require('./browser-launch');
const fs   = require('fs');
const path = require('path');

const SMG_REPORT_URL = 'https://360.smg.com/#/card/5b621d617485e95d90e0a370?languageiso=en-US&view=comments&id=5b621d617485e95d90e0a370';
const PROFILE_DIR    = process.env.SMG_PROFILE_DIR || '/tmp/smg-profile';

async function screenshot(page, label, full = false) {
  try {
    const dir = '/tmp/smg-debug';
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, `${label}-${Date.now()}.png`), fullPage: full });
    console.log(`[SMG] Screenshot: ${label}`);
  } catch (_) {}
}

async function downloadSMGComments(targetDate) {
  const tmpDir  = '/tmp/uploads';
  fs.mkdirSync(tmpDir, { recursive: true });
  const outPath = path.join(tmpDir, `intel-smg-${targetDate}.xlsx`);

  const user = process.env.SMG_USER     || '';
  const pass = process.env.SMG_PASSWORD || '';
  if (!user || !pass) throw new Error('SMG_USER / SMG_PASSWORD env vars not set');

  // Clear stale profile to avoid corrupted cached state from prior failed runs
  try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch (_) {}
  fs.mkdirSync(PROFILE_DIR, { recursive: true });

  const browser = await launchContext(PROFILE_DIR, { acceptDownloads: true });

  try {
    const page = await browser.newPage();
    // Patch navigator.webdriver before any page scripts — most common headless
    // detection trigger.  Without this, SPAs like 360.smg.com refuse to render.
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      // Some sites also check for chrome runtime object
      if (!window.chrome) window.chrome = { runtime: {} };
    });
    page.on('console', m => { if (m.type() === 'error') console.log('[SMG] JS error:', m.text().slice(0, 200)); });

    // Track URLs at each auth step — embedded in error for DB log visibility
    const urlLog = [];

    // ── Step 1: Navigate to 360.smg.com — detect login mechanism ─────────────
    // The 360.smg.com SPA internally navigates to #/ when unauthenticated
    // (hash navigation, not a top-level redirect).  The login widget at #/ is
    // likely an iframe loading reporting.smg.com — invisible to waitForURL and
    // querySelectorAll on the main frame.  We must detect frames explicitly.
    console.log('[SMG] Step 1: navigating to 360.smg.com...');
    await page.goto(SMG_REPORT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Give SPA time to initialise and load the #/ login route + any iframes
    try {
      await page.waitForLoadState('networkidle', { timeout: 20000 });
    } catch (_) {}
    await page.waitForTimeout(5000);

    let currentUrl = page.url();
    urlLog.push(`after-initial-nav:${currentUrl}`);
    console.log(`[SMG] After initial nav: ${currentUrl}`);
    await screenshot(page, 'step1-initial', true);

    // Log ALL frames so we can see if an iframe loaded reporting.smg.com
    const allFrameUrls = page.frames().map(f => f.url());
    urlLog.push(`frames:${JSON.stringify(allFrameUrls)}`);
    console.log('[SMG] Page frames:', JSON.stringify(allFrameUrls));

    // Determine which frame (or top-level) has the login form
    async function findLoginFrame() {
      // Check for a top-level reporting.smg.com URL
      if (page.url().includes('reporting.smg.com')) return page.mainFrame();
      // Check all frames for reporting.smg.com or a login form
      for (const frame of page.frames()) {
        const fUrl = frame.url();
        if (fUrl.includes('reporting.smg.com') || fUrl.includes('/login') || fUrl.includes('/Login')) {
          console.log('[SMG] Login frame found:', fUrl);
          return frame;
        }
      }
      // Last resort: scan every frame for an input[type="password"]
      for (const frame of page.frames()) {
        try {
          const pw = await frame.$('input[type="password"]');
          if (pw) { console.log('[SMG] Found password field in frame:', frame.url()); return frame; }
        } catch (_) {}
      }
      return null;
    }

    let loginFrame = await findLoginFrame();

    // If no login frame yet, wait up to 15 more seconds for it to appear
    if (!loginFrame) {
      console.log('[SMG] No login frame yet — waiting 15 s more...');
      await page.waitForTimeout(15000);
      urlLog.push(`after-extra-wait:${page.url()}`);
      const allFrameUrls2 = page.frames().map(f => f.url());
      urlLog.push(`frames2:${JSON.stringify(allFrameUrls2)}`);
      console.log('[SMG] Frames after extra wait:', JSON.stringify(allFrameUrls2));
      loginFrame = await findLoginFrame();
    }

    currentUrl = page.url();
    const isAlreadyOnCard = currentUrl.includes('5b621d617485e95d90e0a370') &&
                            !loginFrame;

    if (isAlreadyOnCard) {
      console.log('[SMG] Already authenticated on report card — skipping login');
    } else if (!loginFrame) {
      urlLog.push(`no-login-frame:${currentUrl}`);
      throw new Error(`SMG: Could not find login form. urls=${JSON.stringify(urlLog)}`);
    } else {
      // Fill credentials in whichever frame has the login form
      console.log(`[SMG] Filling login form in frame: ${loginFrame.url()}`);
      await screenshot(page, 'step1-login', true);

      const inputSel = '#UserName, input[name="UserName"], input[name="Username"], input[type="email"], input[type="text"]';
      const userField = await loginFrame.$(inputSel);
      if (!userField) throw new Error(`SMG: username field not found in frame ${loginFrame.url()}`);

      await userField.fill(user);
      const passField = await loginFrame.$('#Password, input[name="Password"], input[type="password"]');
      if (!passField) throw new Error('SMG: password field not found');
      await passField.fill(pass);
      await passField.dispatchEvent('input');
      await passField.dispatchEvent('change');
      await page.waitForTimeout(1500);

      // Click submit
      const submitSel = 'input[type="submit"]:not([disabled]), button[type="submit"]:not([disabled]), #LoginButton:not([disabled]), .btn-primary:not([disabled])';
      try {
        await loginFrame.waitForSelector(submitSel, { state: 'visible', timeout: 8000 });
      } catch (_) { console.log('[SMG] Submit not enabled — pressing Enter'); }
      const clicked = await loginFrame.click(submitSel, { timeout: 3000 }).then(() => true).catch(() => false);
      if (!clicked) await passField.press('Enter');
      console.log('[SMG] Submitted login form, clicked:', clicked);

      // Wait for redirect to 360.smg.com card (top-level or frame navigation)
      console.log('[SMG] Waiting for authenticated card to appear...');
      try {
        await page.waitForURL('**/360.smg.com/**', { timeout: 25000 });
      } catch (_) {
        const midUrl = page.url();
        urlLog.push(`post-login-mid:${midUrl}`);
        console.log(`[SMG] Post-submit URL: ${midUrl}`);
        await screenshot(page, 'step1-mid', true);
        if (midUrl.includes('MultiLanguage')) {
          const firstLink = await page.$('a[href]:not([href="#"]):not([href^="javascript"])');
          if (firstLink) { await firstLink.click(); await page.waitForTimeout(5000); }
        }
      }

      currentUrl = page.url();
      urlLog.push(`post-login:${currentUrl}`);
      console.log(`[SMG] Post-login URL: ${currentUrl}`);
      await screenshot(page, 'step1-post-login');
    }

    // ── Step 2: Navigate to the report card (in case we're at a different 360 URL) ─
    if (!currentUrl.includes('5b621d617485e95d90e0a370')) {
      console.log('[SMG] Navigating to report card...');
      await page.goto(SMG_REPORT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      urlLog.push(`after-step2-nav:${page.url()}`);
    }

    // Intercept XHR/fetch so we can see what export API the SPA calls
    const capturedRequests = [];
    page.on('request', req => {
      const u = req.url();
      if (/export|download|report|excel|xlsx|csv/i.test(u)) capturedRequests.push({ method: req.method(), url: u });
    });

    // Wait for SPA to fully render the card
    console.log('[SMG] Waiting for report card to render...');
    try {
      await page.waitForLoadState('networkidle', { timeout: 30000 });
    } catch (_) { console.log('[SMG] networkidle timeout — continuing'); }
    await page.waitForTimeout(10000); // extra time for Angular digest

    const reportUrl = page.url();
    console.log(`[SMG] Report URL after wait: ${reportUrl}`);
    await screenshot(page, 'step2-report', true);

    if (!reportUrl.includes('360.smg.com')) {
      throw new Error(`SMG auth failed — stuck at: ${reportUrl}`);
    }

    // Dump page diagnostics (full HTML prefix + button inventory)
    try {
      const info = await page.evaluate(() => ({
        title: document.title,
        bodyText: document.body.innerText.slice(0, 600),
        buttonCount: document.querySelectorAll('button').length,
        html: document.body.innerHTML.slice(0, 4000),
      }));
      console.log('[SMG] Page info title:', info.title, '| buttons:', info.buttonCount);
      console.log('[SMG] Body text:', info.bodyText);
      console.log('[SMG] HTML prefix:', info.html);
    } catch (_) {}

    // Try to click the "Comments" tab if we're not already on it
    try {
      const commentTab = await page.$('[role="tab"]:has-text("Comment"), button:has-text("Comments"), a:has-text("Comments")');
      if (commentTab) {
        console.log('[SMG] Clicking Comments tab');
        await commentTab.click();
        await page.waitForTimeout(4000);
        await screenshot(page, 'step2b-comments-tab', true);
      }
    } catch (_) {}

    // ── Step 3: Find and click the export/download button ─────────────────────
    const downloadSelectors = [
      // Text / aria
      'button[aria-label*="Download" i]', 'button[aria-label*="Export" i]',
      '[aria-label*="Download" i]',        '[aria-label*="Export" i]',
      'button[title*="Download" i]',       'button[title*="Export" i]',
      '[title*="Download" i]',             '[title*="Export" i]',
      '[data-testid*="export" i]',         '[data-testid*="download" i]',
      'button:has-text("Download")',       'button:has-text("Export")',
      'button:has-text("CSV")',            'button:has-text("Excel")',
      'a:has-text("Export")',              'a:has-text("Download")',
      // Class patterns
      '[class*="download"]',              '[class*="export"]',
      '[class*="Download"]',              '[class*="Export"]',
      // href patterns
      'a[href*="export"]',                'a[href*="download"]',
      // ng-click / Angular patterns
      '[ng-click*="download" i]',         '[ng-click*="export" i]',
      '[(click)*="download" i]',
    ];

    let exportEl = null;
    for (const sel of downloadSelectors) {
      try {
        exportEl = await page.waitForSelector(sel, { state: 'visible', timeout: 1500 });
        if (exportEl) { console.log(`[SMG] Found export element: ${sel}`); break; }
      } catch (_) {}
    }

    // Hover-to-reveal on card header areas
    if (!exportEl) {
      console.log('[SMG] Trying hover-to-reveal...');
      const hoverTargets = [
        '[class*="card-header"]', '[class*="cardHeader"]', '[class*="card__header"]',
        '[class*="widget-header"]', '[class*="report-header"]',
        'h1', 'h2', 'h3', '[class*="title"]',
      ];
      for (const hSel of hoverTargets) {
        try {
          const hoverEl = await page.$(hSel);
          if (!hoverEl) continue;
          await hoverEl.hover();
          await page.waitForTimeout(1500);
          for (const sel of downloadSelectors) {
            try {
              exportEl = await page.waitForSelector(sel, { state: 'visible', timeout: 1000 });
              if (exportEl) { console.log(`[SMG] Found export after hovering ${hSel}`); break; }
            } catch (_) {}
          }
          if (exportEl) break;
        } catch (_) {}
      }
    }

    // Try expanding kebab / "..." menus
    if (!exportEl) {
      console.log('[SMG] Trying kebab/ellipsis menus...');
      const menuSelectors = [
        'button[aria-label*="more" i]', 'button[aria-label*="action" i]',
        'button[aria-label*="option" i]', 'button[aria-label*="menu" i]',
        '[class*="kebab"]', '[class*="ellipsis"]', '[class*="more-options"]',
        '[class*="moreOptions"]', '[class*="dropdown-toggle"]',
        'button:has-text("...")', 'button:has-text("⋮")', 'button:has-text("•••")',
      ];
      for (const mSel of menuSelectors) {
        try {
          const menu = await page.$(mSel);
          if (!menu) continue;
          await menu.click();
          await page.waitForTimeout(1500);
          await screenshot(page, 'step3-menu-open', true);
          for (const sel of downloadSelectors) {
            try {
              exportEl = await page.waitForSelector(sel, { state: 'visible', timeout: 1500 });
              if (exportEl) { console.log(`[SMG] Found export in menu opened via ${mSel}`); break; }
            } catch (_) {}
          }
          if (exportEl) break;
          // Close menu with Escape before trying next
          await page.keyboard.press('Escape');
          await page.waitForTimeout(500);
        } catch (_) {}
      }
    }

    // Broad evaluate fallback — scan all elements for download/export hints
    if (!exportEl) {
      await page.evaluate(() => {
        for (const el of document.querySelectorAll('*')) {
          const cls  = (el.className||'').toString().toLowerCase();
          const aria = (el.getAttribute('aria-label')||'').toLowerCase();
          const text = (el.innerText||'').toLowerCase().trim();
          const title= (el.getAttribute('title')||'').toLowerCase();
          const ngc  = (el.getAttribute('ng-click')||'').toLowerCase();
          if (
            cls.includes('download') || cls.includes('export') ||
            aria.includes('download') || aria.includes('export') ||
            title.includes('download') || title.includes('export') ||
            ngc.includes('download') || ngc.includes('export') ||
            text === 'download' || text === 'export'
          ) el.setAttribute('data-smg-export-target', 'true');
        }
      });
      exportEl = await page.$('[data-smg-export-target="true"]');
      if (exportEl) console.log('[SMG] Found export via broad evaluate fallback');
    }

    if (!exportEl) {
      // Full element dump for diagnosis
      const els = await page.evaluate(() =>
        Array.from(document.querySelectorAll('button, [role="button"], [role="menuitem"], a, [class*="btn"], [class*="icon"]'))
          .slice(0, 80)
          .map(e => ({
            tag: e.tagName, text: (e.innerText||'').trim().slice(0, 50),
            aria: e.getAttribute('aria-label')||'', title: e.getAttribute('title')||'',
            cls: (e.className||'').toString().slice(0, 80),
            ngClick: e.getAttribute('ng-click')||'',
          }))
      );
      console.log('[SMG] Full element dump:', JSON.stringify(els));
      console.log('[SMG] Captured export-related requests:', JSON.stringify(capturedRequests));
      await screenshot(page, 'step3-no-export', true);
      // Embed diagnostics in error so they appear in DB job logs
      urlLog.push(`at-step3:${page.url()}`);
      const diagSnippet = JSON.stringify(els.slice(0, 20)).slice(0, 600);
      const reqSnippet  = JSON.stringify(capturedRequests).slice(0, 200);
      throw new Error(`SMG: No export button. urls=${JSON.stringify(urlLog)} els=${diagSnippet} reqs=${reqSnippet}`);
    }

    // ── Step 4: Click and download ─────────────────────────────────────────────
    const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
    await exportEl.click();
    console.log('[SMG] Clicked export');
    await page.waitForTimeout(800);

    // Handle format picker submenu
    try {
      await page.click(
        'li:has-text("Excel"), li:has-text("XLSX"), button:has-text("XLSX"), [role="menuitem"]:has-text("Excel"), [role="menuitem"]:has-text("XLSX")',
        { timeout: 4000 }
      );
      console.log('[SMG] Clicked Excel format option');
    } catch (_) {}

    const download = await downloadPromise;
    const dlPath   = await download.path();
    if (!dlPath) throw new Error('SMG download path null');
    fs.copyFileSync(dlPath, outPath);
    console.log(`[SMG] Downloaded → ${outPath}`);
    return { success: true, filePath: outPath };

  } catch (err) {
    console.error('[SMG] FAILED:', err.message);
    return { success: false, error: err.message };
  } finally {
    try { await browser.close(); } catch (_) {}
  }
}

module.exports = { downloadSMGComments };
