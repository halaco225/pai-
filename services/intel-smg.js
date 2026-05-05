'use strict';
/**
 * SMG download helper — logs in via the referrerUri SSO flow and downloads
 * the previous-day "Comments By Comment" Excel export from SMG360.
 *
 * Auth flow (discovered from browser tab inspection):
 *   1. Navigate to the 360.smg.com report card URL
 *   2. 360.smg.com redirects to reporting.smg.com/index.aspx?referrerUri=<card_url>
 *   3. Login on reporting.smg.com
 *   4. reporting.smg.com redirects back to 360.smg.com via referrerUri — session established
 *   5. SPA loads the card, find the export button, download Excel
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

  const browser = await launchContext(PROFILE_DIR, { acceptDownloads: true });

  try {
    const page = await browser.newPage();
    page.on('console', m => { if (m.type() === 'error') console.log('[SMG] JS error:', m.text().slice(0, 200)); });

    // ── Step 1: Navigate to the 360.smg.com report — it will redirect to
    //           reporting.smg.com login with referrerUri pointing back to the card.
    console.log('[SMG] Step 1: navigating to 360.smg.com report to trigger SSO redirect...');
    await page.goto(SMG_REPORT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(3000);

    let currentUrl = page.url();
    console.log(`[SMG] After initial nav: ${currentUrl}`);
    await screenshot(page, 'step1-initial');

    // If we're already on 360.smg.com (cached session), skip login
    if (currentUrl.includes('360.smg.com') && !currentUrl.includes('reporting.smg.com')) {
      console.log('[SMG] Already authenticated on 360.smg.com — skipping login');
    } else {
      // Should now be on reporting.smg.com/index.aspx?referrerUri=...
      // Fill credentials
      console.log(`[SMG] On login page: ${currentUrl}`);
      await screenshot(page, 'step1-login');

      const userField = await page.$('#UserName, input[name="UserName"], input[name="Username"], input[type="email"], input[type="text"]');
      if (!userField) throw new Error(`SMG login form not found at: ${currentUrl}`);

      console.log('[SMG] Filling credentials...');
      await userField.fill(user);
      const passField = await page.$('#Password, input[name="Password"], input[type="password"]');
      if (!passField) throw new Error('SMG password field not found');
      await passField.fill(pass);
      await passField.dispatchEvent('input');
      await passField.dispatchEvent('change');
      await page.waitForTimeout(1500);

      // Enable and click submit
      try {
        await page.waitForSelector(
          'input[type="submit"]:not([disabled]), button[type="submit"]:not([disabled]), #LoginButton:not([disabled]), .btn-primary:not([disabled])',
          { state: 'visible', timeout: 8000 }
        );
      } catch (_) { console.log('[SMG] Submit not enabled — pressing Enter'); }
      const clicked = await page.click(
        'input[type="submit"]:not([disabled]), button[type="submit"]:not([disabled]), #LoginButton:not([disabled]), .btn-primary:not([disabled])',
        { timeout: 3000 }
      ).then(() => true).catch(() => false);
      if (!clicked) await passField.press('Enter');

      // Wait for redirect back to 360.smg.com via referrerUri
      console.log('[SMG] Waiting for redirect back to 360.smg.com...');
      try {
        await page.waitForURL('**/360.smg.com/**', { timeout: 20000 });
      } catch (_) {
        // May land on MultiLanguage.aspx first — wait for it and follow
        const midUrl = page.url();
        console.log(`[SMG] Intermediate URL: ${midUrl}`);
        await screenshot(page, 'step1-mid', true);
        if (midUrl.includes('MultiLanguage')) {
          // Click the first non-js link to proceed past language selection
          const firstLink = await page.$('a[href]:not([href="#"]):not([href^="javascript"])');
          if (firstLink) {
            const href = await firstLink.getAttribute('href');
            console.log(`[SMG] Clicking past MultiLanguage: ${href}`);
            await firstLink.click();
            await page.waitForTimeout(5000);
          }
        }
      }

      currentUrl = page.url();
      console.log(`[SMG] Post-login URL: ${currentUrl}`);
      await screenshot(page, 'step1-post-login');
    }

    // ── Step 2: Navigate to the report card (in case we're at a different 360 URL) ─
    if (!currentUrl.includes('5b621d617485e95d90e0a370')) {
      console.log('[SMG] Navigating to report card...');
      await page.goto(SMG_REPORT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
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
      // Embed truncated diagnostics in the error so they appear in DB job logs
      const diagSnippet = JSON.stringify(els.slice(0, 20)).slice(0, 800);
      const reqSnippet  = JSON.stringify(capturedRequests).slice(0, 200);
      throw new Error(`SMG: No export button found. els=${diagSnippet} reqs=${reqSnippet}`);
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
