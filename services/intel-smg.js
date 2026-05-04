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

    // ── Step 1: Always log in first — /tmp profile is ephemeral on Render ────
    // Rather than detecting login redirect, always hit the login page directly.
    // SMG360 will skip the form if the session cookie is still valid.
    const user = process.env.SMG_USER || '';
    const pass = process.env.SMG_PASSWORD || '';
    if (!user || !pass) throw new Error('SMG_USER / SMG_PASSWORD env vars not set');

    console.log('[SMG] Navigating to login page...');
    await page.goto(SMG_LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(2000);
    const loginUrl = page.url();
    console.log(`[SMG] Login page URL: ${loginUrl}`);
    await screenshot(page, 'step1-login-page');

    // Fill credentials if a login form is present
    const userField = await page.$('#UserName, input[name="Username"], input[type="email"], input[type="text"]');
    if (userField) {
      console.log('[SMG] Login form detected — filling credentials');
      await userField.fill(user);

      const passField = await page.$('#Password, input[name="Password"], input[type="password"]');
      if (passField) {
        await passField.fill(pass);
        await page.click('input[type="submit"], button[type="submit"], #LoginButton, .btn-primary');
        await page.waitForTimeout(4000);
        console.log(`[SMG] Post-login URL: ${page.url()}`);
        await screenshot(page, 'step1-post-login');
      }
    } else {
      console.log('[SMG] No login form — session may already be valid');
    }

    // ── Step 2: Navigate to report ────────────────────────────────────────────
    console.log('[SMG] Navigating to report URL...');
    await page.goto(SMG_REPORT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);
    const reportUrl = page.url();
    const reportTitle = await page.title().catch(() => '?');
    console.log(`[SMG] Report URL: ${reportUrl} | Title: ${reportTitle}`);
    await screenshot(page, 'step2-report-initial', true);

    // If still on login/reporting domain, session didn't stick — abort clearly
    if (!reportUrl.includes('360.smg.com') || reportUrl.includes('login') || reportUrl.includes('reporting.smg')) {
      await screenshot(page, 'step2-still-on-login', true);
      throw new Error(`SMG login failed — stuck on: ${reportUrl}. Check SMG_USER / SMG_PASSWORD.`);
    }

    // ── Step 3: Wait for SPA to fully render ─────────────────────────────────
    try {
      await page.waitForLoadState('networkidle', { timeout: 25000 });
      console.log('[SMG] Network idle');
    } catch (_) { console.log('[SMG] networkidle timeout — continuing'); }

    // Extra settle for React/Angular SPA re-renders
    await page.waitForTimeout(3000);
    await screenshot(page, 'step3-settled', true);

    // Dump a body snippet so we can see what's actually on the page
    try {
      const bodyInfo = await page.evaluate(() => ({
        title: document.title,
        url: location.href,
        bodyText: document.body.innerText.slice(0, 500),
        buttonCount: document.querySelectorAll('button').length,
        linkCount:   document.querySelectorAll('a').length,
      }));
      console.log('[SMG] Page info:', JSON.stringify(bodyInfo));
    } catch (_) {}

    // Log all interactive elements
    await logPageElements(page, 'pre-export');
    await screenshot(page, 'step3-before-export', true);

    // ── Step 4: Find export / download button ─────────────────────────────────
    const downloadSelectors = [
      // aria-label / title — most reliable for icon-only buttons
      'button[aria-label*="Download" i]',
      'button[aria-label*="Export" i]',
      'button[aria-label*="export" i]',
      '[aria-label*="Download" i]',
      '[aria-label*="Export" i]',
      'button[title*="Download" i]',
      'button[title*="Export" i]',
      // data-* attributes
      '[data-testid*="export" i]',
      '[data-testid*="download" i]',
      '[data-qa*="export" i]',
      '[data-qa*="download" i]',
      '[data-track*="export" i]',
      '[data-cy*="export" i]',
      // Text buttons
      'button:has-text("Download")',
      'button:has-text("Export")',
      'button:has-text("CSV")',
      'button:has-text("Excel")',
      'a:has-text("Export")',
      'a:has-text("Download")',
      // Class patterns
      '[class*="download-btn"]',
      '[class*="export-btn"]',
      '[class*="downloadButton"]',
      '[class*="exportButton"]',
      '[class*="DownloadButton"]',
      '[class*="ExportButton"]',
      '[class*="export-button"]',
      '[class*="download-button"]',
      // Anchor patterns
      'a[href*="export"]',
      'a[href*="download"]',
      // Icon class patterns inside buttons
      'button [class*="icon-download"]',
      'button [class*="fa-download"]',
      'button [class*="icon-export"]',
      'button [class*="download"]',
    ];

    let exportEl = null;
    for (const sel of downloadSelectors) {
      try {
        exportEl = await page.waitForSelector(sel, { state: 'visible', timeout: 2000 });
        if (exportEl) { console.log(`[SMG] Found export element: ${sel}`); break; }
      } catch (_) {}
    }

    // Evaluate fallback — tag any element with "download"/"export" in class, aria, or title
    if (!exportEl) {
      console.log('[SMG] Standard selectors failed — trying evaluate fallback');
      await page.evaluate(() => {
        const kws = ['download', 'export'];
        for (const el of document.querySelectorAll('button, [role="button"], a, [class*="icon"]')) {
          const cls  = (el.className || '').toString().toLowerCase();
          const aria = (el.getAttribute('aria-label') || '').toLowerCase();
          const ttl  = (el.getAttribute('title') || '').toLowerCase();
          const text = (el.innerText || el.textContent || '').toLowerCase().trim();
          for (const kw of kws) {
            if (cls.includes(kw) || aria.includes(kw) || ttl.includes(kw) || text === kw) {
              el.setAttribute('data-smg-export-target', 'true');
              break;
            }
          }
        }
      });
      exportEl = await page.$('[data-smg-export-target="true"]');
      if (exportEl) console.log('[SMG] Found export element via evaluate fallback');
    }

    // Hover-to-reveal: SMG360 sometimes hides export button until card is hovered
    if (!exportEl) {
      console.log('[SMG] Trying hover-to-reveal...');
      const hoverTargets = [
        '[class*="card-header"]', '[class*="cardHeader"]',
        '[class*="widget-header"]', '[class*="report-header"]',
        '[class*="CardOptions"]', '[class*="card-options"]',
        '[class*="OptionsBar"]', '[class*="toolbar"]',
        'h1', 'h2', 'h3',
      ];
      for (const hSel of hoverTargets) {
        try {
          const hoverEl = await page.$(hSel);
          if (!hoverEl) continue;
          await hoverEl.hover();
          await page.waitForTimeout(1200);
          for (const sel of downloadSelectors) {
            try {
              exportEl = await page.waitForSelector(sel, { state: 'visible', timeout: 1500 });
              if (exportEl) { console.log(`[SMG] Found export after hovering ${hSel}: ${sel}`); break; }
            } catch (_) {}
          }
          if (exportEl) break;
        } catch (_) {}
      }
      if (!exportEl) await screenshot(page, 'step4-after-hover-attempts', true);
    }

    if (!exportEl) {
      await logPageElements(page, 'no-export-found');
      await screenshot(page, 'step4-no-export-found', true);
      throw new Error(`SMG: No export/download button found. Page: ${reportUrl} | Title: ${reportTitle}`);
    }

    // ── Step 5: Click export and wait for download ────────────────────────────
    const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
    await exportEl.click();
    console.log('[SMG] Clicked export element');
    await page.waitForTimeout(600);
    await screenshot(page, 'step5-after-export-click');

    // May need a secondary click for format picker (CSV / Excel submenu)
    try {
      await page.click(
        'li:has-text("Excel"), li:has-text("XLSX"), button:has-text("XLSX"), li:has-text("CSV"), [role="menuitem"]:has-text("Excel"), [role="menuitem"]:has-text("XLSX")',
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
