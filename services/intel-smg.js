'use strict';
/**
 * SMG download helper — logs in and downloads previous-day comments export.
 *
 * SMG360 uses a hash-based SPA. The export button may be an icon-only button
 * (SVG, no text). This scraper logs all interactive elements to the console
 * so we can identify the correct selector when the first attempts fail.
 */
const { launchContext } = require('./browser-launch');
const fs   = require('fs');
const path = require('path');

const SMG_LOGIN_URL  = 'https://reporting.smg.com/index.aspx';
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

/**
 * Dumps all visible interactive elements to console so we can find the export button.
 */
async function logPageElements(page, label) {
  try {
    const elements = await page.evaluate(() => {
      const out = [];
      const candidates = document.querySelectorAll(
        'button, a[href], [role="button"], [role="menuitem"], ' +
        '[class*="download"], [class*="export"], [class*="icon"], ' +
        'svg[class*="icon"], [aria-label], [title]'
      );
      for (const el of candidates) {
        const text      = (el.innerText || el.textContent || '').trim().slice(0, 60);
        const title     = el.getAttribute('title') || '';
        const aria      = el.getAttribute('aria-label') || '';
        const cls       = (el.className || '').toString().slice(0, 80);
        const tag       = el.tagName;
        const visible   = el.offsetParent !== null || el.getBoundingClientRect().width > 0;
        if ((text || title || aria) && visible) {
          out.push({ tag, text, title, aria, cls });
        }
      }
      return out.slice(0, 60);
    });
    console.log(`[SMG] ${label} elements (${elements.length}):`, JSON.stringify(elements, null, 2));
  } catch (e) {
    console.log(`[SMG] logPageElements failed: ${e.message}`);
  }
}

async function downloadSMGComments(targetDate) {
  const tmpDir  = '/tmp/uploads';
  fs.mkdirSync(tmpDir, { recursive: true });
  const outPath = path.join(tmpDir, `intel-smg-${targetDate}.xlsx`);

  const browser = await launchContext(PROFILE_DIR, { acceptDownloads: true });

  try {
    const page = await browser.newPage();

    // ── Step 1: Navigate to report — SMG360 redirects to login if expired ────
    console.log('[SMG] Navigating to report URL...');
    await page.goto(SMG_REPORT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(4000);

    const urlAfterNav = page.url();
    console.log(`[SMG] URL after nav: ${urlAfterNav}`);
    await screenshot(page, 'step1-initial');

    // Detect login redirect (360.smg.com will send to reporting.smg.com or /login if expired)
    const needsLogin = !urlAfterNav.includes('360.smg.com')
      || urlAfterNav.includes('login')
      || urlAfterNav.includes('reporting.smg')
      || urlAfterNav.includes('/auth')
      || urlAfterNav.includes('signin');

    if (needsLogin) {
      console.log(`[SMG] Login required — redirected to: ${urlAfterNav}`);
      const user = process.env.SMG_USER || '';
      const pass = process.env.SMG_PASSWORD || '';
      if (!user || !pass) throw new Error('SMG_USER / SMG_PASSWORD env vars not set');

      // Navigate to legacy login page (reporting.smg.com)
      if (!urlAfterNav.includes('reporting.smg')) {
        await page.goto(SMG_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(2000);
      }
      await screenshot(page, 'step2-login-page');

      const userField = await page.waitForSelector(
        '#UserName, input[name="Username"], input[type="email"], input[type="text"]',
        { timeout: 8000 }
      );
      await userField.fill(user);

      const passField = await page.waitForSelector(
        '#Password, input[name="Password"], input[type="password"]',
        { timeout: 5000 }
      );
      await passField.fill(pass);

      await page.click('input[type="submit"], button[type="submit"], #LoginButton, button:has-text("Sign In"), button:has-text("Log In")');
      await page.waitForTimeout(4000);
      console.log(`[SMG] Post-login URL: ${page.url()}`);
      await screenshot(page, 'step2-post-login');

      // Navigate to report now that we're authenticated
      console.log('[SMG] Navigating to report post-login...');
      await page.goto(SMG_REPORT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(5000);
    }

    await screenshot(page, 'step3-report-loaded', true); // fullPage
    console.log(`[SMG] On report — URL: ${page.url()}`);

    // ── Step 2: Wait for SPA to settle ───────────────────────────────────────
    try {
      await page.waitForLoadState('networkidle', { timeout: 20000 });
      console.log('[SMG] Network idle');
    } catch (_) { console.log('[SMG] networkidle timeout — continuing'); }

    // ── Step 3: Log all page elements so we know what export looks like ───────
    await logPageElements(page, 'pre-export');
    await screenshot(page, 'step3-before-export', true);

    // ── Step 4: Try date filter if present ───────────────────────────────────
    try {
      const dateInput = await page.$('input[type="date"]');
      if (dateInput) {
        await dateInput.fill(targetDate);
        await page.keyboard.press('Enter');
        await page.waitForTimeout(2000);
      }
    } catch (_) {}

    // ── Step 5: Find export / download button ─────────────────────────────────
    // SMG360 often uses icon-only buttons — try aria-label, title, class patterns
    const downloadSelectors = [
      // Icon buttons with labels
      'button[aria-label*="Download" i]',
      'button[aria-label*="Export" i]',
      'button[title*="Download" i]',
      'button[title*="Export" i]',
      // Text buttons
      'button:has-text("Download")',
      'button:has-text("Export")',
      'button:has-text("CSV")',
      'button:has-text("Excel")',
      // Data attribute patterns
      '[data-testid*="download"]',
      '[data-testid*="export"]',
      // Class patterns (SMG360 uses these)
      '[class*="download-btn"]',
      '[class*="export-btn"]',
      '[class*="downloadButton"]',
      '[class*="exportButton"]',
      // Anchor patterns
      'a[href*="export"]',
      'a[href*="download"]',
      // Generic icon class (SMG360 often nests a span with icon class inside a button)
      'button [class*="icon-download"]',
      'button [class*="fa-download"]',
      'button [class*="icon-export"]',
    ];

    let exportEl = null;
    for (const sel of downloadSelectors) {
      try {
        exportEl = await page.waitForSelector(sel, { state: 'visible', timeout: 3000 });
        if (exportEl) { console.log(`[SMG] Found export element: ${sel}`); break; }
      } catch (_) {}
    }

    // Fallback: search by evaluate for any element containing "download" or "export" in class/aria
    if (!exportEl) {
      console.log('[SMG] Standard selectors failed — trying evaluate fallback');
      const found = await page.evaluate(() => {
        const keywords = ['download', 'export'];
        const candidates = document.querySelectorAll('button, [role="button"], a');
        for (const el of candidates) {
          const cls  = (el.className || '').toString().toLowerCase();
          const aria = (el.getAttribute('aria-label') || '').toLowerCase();
          const ttl  = (el.getAttribute('title') || '').toLowerCase();
          for (const kw of keywords) {
            if (cls.includes(kw) || aria.includes(kw) || ttl.includes(kw)) {
              // Return a unique selector we can use
              el.setAttribute('data-smg-export-target', 'true');
              return true;
            }
          }
        }
        return false;
      });

      if (found) {
        exportEl = await page.$('[data-smg-export-target="true"]');
        console.log('[SMG] Found export element via evaluate fallback');
      }
    }

    if (!exportEl) {
      // Try hovering over the card header area first (some SPAs reveal export on hover)
      console.log('[SMG] Trying hover-to-reveal pattern...');
      try {
        const cardHeader = await page.$('[class*="card-header"], [class*="cardHeader"], [class*="widget-header"], [class*="report-header"], h1, h2, .title');
        if (cardHeader) {
          await cardHeader.hover();
          await page.waitForTimeout(1500);
          await screenshot(page, 'step5-after-hover', true);
          await logPageElements(page, 'after-hover');

          for (const sel of downloadSelectors) {
            try {
              exportEl = await page.waitForSelector(sel, { state: 'visible', timeout: 2000 });
              if (exportEl) { console.log(`[SMG] Found export after hover: ${sel}`); break; }
            } catch (_) {}
          }
        }
      } catch (_) {}
    }

    if (!exportEl) {
      await screenshot(page, 'step5-no-export-found', true);
      await logPageElements(page, 'no-export-found');
      throw new Error(`SMG: No export/download button found. Check screenshots at /tmp/smg-debug/ and page elements logged above.`);
    }

    // ── Step 6: Click export and wait for download ────────────────────────────
    const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
    await exportEl.click();
    console.log('[SMG] Clicked export element');
    await page.waitForTimeout(500);

    // May need a secondary click for format picker
    try {
      await page.click(
        'li:has-text("Excel"), li:has-text("XLSX"), button:has-text("XLSX"), li:has-text("CSV"), [role="menuitem"]:has-text("Excel")',
        { timeout: 4000 }
      );
      console.log('[SMG] Clicked format option');
    } catch (_) {}

    const download = await downloadPromise;
    const dlPath   = await download.path();
    if (!dlPath) throw new Error('SMG download path null after click');

    fs.copyFileSync(dlPath, outPath);
    console.log(`[SMG] Comments downloaded → ${outPath}`);
    return { success: true, filePath: outPath };

  } catch (err) {
    console.error('[SMG] FAILED:', err.message);
    return { success: false, error: err.message };
  } finally {
    try { await browser.close(); } catch (_) {}
  }
}

module.exports = { downloadSMGComments };
