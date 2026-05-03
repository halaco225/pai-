'use strict';
/**
 * Fourth Analytics Playwright helper.
 * Downloads Labor and OT reports from analytics.na1.fourth.com (GoodData).
 *
 * Confirmed working from production logs:
 *   - Login via account.html → redirects correctly ✓
 *   - Report URL loads: Title = "Labor Overview - 03. Labor Optimization" ✓
 *   - networkidle reached ✓
 *
 * Remaining issue: finding "Labor %" column header
 *   - GoodData likely uses AG Grid (divs with role="columnheader", NOT <th>)
 *   - Text may be split across child spans — :has-text() fails on split text
 *   - Fix: TreeWalker finds any text node containing "Labor %", walks up to
 *     a visible parent element regardless of class names or structure
 */
const { launchContext } = require('./browser-launch');
const fs   = require('fs');
const path = require('path');

const FOURTH_URL  = 'https://analytics.na1.fourth.com';
const PROFILE_DIR = process.env.FOURTH_PROFILE_DIR || '/tmp/fourth-profile';

const REPORTS = {
  LABOR: `${FOURTH_URL}/#s=/gdc/workspaces/q0t16mq5dgsreqiq8macw3ghv3k1iuqc|workspaceDashboardPage|/gdc/md/q0t16mq5dgsreqiq8macw3ghv3k1iuqc/obj/607717|8e923313686e`,
  OT:    `${FOURTH_URL}/#s=/gdc/workspaces/q0t16mq5dgsreqiq8macw3ghv3k1iuqc|workspaceDashboardPage|/gdc/md/q0t16mq5dgsreqiq8macw3ghv3k1iuqc/obj/607556|9103c1ea9b50`,
};

async function screenshot(page, label, full = false) {
  try {
    const dir = '/tmp/fourth-debug';
    fs.mkdirSync(dir, { recursive: true });
    await page.screenshot({ path: path.join(dir, `${label}-${Date.now()}.png`), fullPage: full });
    console.log(`[Fourth] Screenshot: ${label}`);
  } catch (_) {}
}

async function logPageState(page, label) {
  try {
    const url   = page.url();
    const title = await page.title().catch(() => '?');
    console.log(`[Fourth] ${label} — URL: ${url} | Title: ${title}`);
  } catch (_) {}
}

/**
 * Dumps DOM class names + all text nodes containing "Labor" so we know
 * exactly what GoodData rendered. Called when element-finding fails.
 */
async function logDomInfo(page, label) {
  try {
    const info = await page.evaluate(() => {
      // All unique class names that look like GoodData or AG Grid
      const classSet = new Set();
      for (const el of document.querySelectorAll('[class]')) {
        const cls = (el.className || '').toString();
        for (const c of cls.split(' ')) {
          if (c && (c.startsWith('gd-') || c.startsWith('ag-') || c.startsWith('s-') || c.includes('dash') || c.includes('visual') || c.includes('widget'))) {
            classSet.add(c);
          }
        }
      }

      // Text nodes containing "Labor"
      const laborTexts = [];
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (node.textContent && node.textContent.includes('Labor')) {
          const p = node.parentElement;
          if (p) laborTexts.push({
            text: node.textContent.trim().slice(0, 60),
            parentTag: p.tagName,
            parentClass: (p.className || '').toString().slice(0, 80),
            parentRole: p.getAttribute('role') || '',
            visible: p.getBoundingClientRect().width > 0,
          });
        }
      }

      // Body HTML snippet
      const bodySnippet = document.body.innerHTML.slice(0, 3000);

      return {
        gdClasses: [...classSet].slice(0, 60),
        laborTexts: laborTexts.slice(0, 15),
        bodySnippet,
      };
    });
    console.log(`[Fourth] ${label} gdClasses:`, JSON.stringify(info.gdClasses));
    console.log(`[Fourth] ${label} laborTexts:`, JSON.stringify(info.laborTexts, null, 2));
    console.log(`[Fourth] ${label} bodySnippet:`, info.bodySnippet.slice(0, 1000));
  } catch (e) {
    console.log(`[Fourth] logDomInfo error: ${e.message}`);
  }
}

/**
 * Finds the element containing "Labor %" text using DOM TreeWalker.
 * Works regardless of class names, split text, or AG Grid structure.
 * Returns a Playwright ElementHandle or null.
 */
async function findLaborHeader(page) {
  // Strategy 1: TreeWalker — find text node containing "Labor %",
  //             walk up to a visible ancestor with dimensions > 0
  const handle = await page.evaluateHandle(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const text = node.textContent || '';
      if (text.includes('Labor %') || text.trim() === 'Labor %') {
        let el = node.parentElement;
        while (el && el !== document.body) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) return el;
          el = el.parentElement;
        }
      }
    }
    return null;
  });
  const el = handle.asElement();
  if (el) { console.log('[Fourth] Found Labor % via TreeWalker text node'); return el; }

  // Strategy 2: aria-label / title attribute
  for (const attr of ['[aria-label*="Labor %"]', '[title*="Labor %"]', '[aria-label*="Labor"]']) {
    try {
      const el2 = await page.$(attr);
      if (el2) { console.log(`[Fourth] Found Labor % via attr: ${attr}`); return el2; }
    } catch (_) {}
  }

  // Strategy 3: AG Grid specific — .ag-header-cell containing "Labor"
  const agHandle = await page.evaluateHandle(() => {
    for (const el of document.querySelectorAll('.ag-header-cell, [role="columnheader"]')) {
      if ((el.textContent || '').includes('Labor')) return el;
    }
    return null;
  });
  const agEl = agHandle.asElement();
  if (agEl) { console.log('[Fourth] Found Labor % via AG Grid selector'); return agEl; }

  // Strategy 4: Any element whose combined text is exactly "Labor %"
  const exactHandle = await page.evaluateHandle(() => {
    for (const el of document.querySelectorAll('span, div, td, th, li')) {
      const t = (el.textContent || '').trim();
      if (t === 'Labor %' || t === 'Labor%') return el;
    }
    return null;
  });
  const exactEl = exactHandle.asElement();
  if (exactEl) { console.log('[Fourth] Found Labor % via exact text match'); return exactEl; }

  return null;
}

async function downloadFourthReport(reportKey, targetDate) {
  const tmpDir  = '/tmp/uploads';
  fs.mkdirSync(tmpDir, { recursive: true });
  const outPath = path.join(tmpDir, `intel-fourth-${reportKey.toLowerCase()}-${targetDate}.xlsx`);

  const reportUrl = REPORTS[reportKey];
  if (!reportUrl) throw new Error(`Unknown report key: ${reportKey}`);

  const browser = await launchContext(PROFILE_DIR, { acceptDownloads: true });

  try {
    const page = await browser.newPage();

    // ── Step 1: Navigate to report; GoodData redirects to login if needed ─────
    console.log(`[Fourth] Navigating to ${reportKey} report URL`);
    await page.goto(reportUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);
    await logPageState(page, 'after-initial-nav');
    await screenshot(page, 'step1-initial');

    // ── Step 2: Login if redirected ──────────────────────────────────────────
    const urlAfterNav = page.url();
    const needsLogin  = !urlAfterNav.includes('analytics.na1.fourth.com')
      || urlAfterNav.includes('account.html')
      || urlAfterNav.includes('/login')
      || urlAfterNav.includes('/sso')
      || urlAfterNav.includes('/auth');
    const hasLoginField = await page.$('input[type="email"], input[type="password"], input[name="username"], #username')
      .then(el => !!el).catch(() => false);

    if (needsLogin || hasLoginField) {
      console.log('[Fourth] Login required');
      const user = process.env.FOURTH_USER || '';
      const pass = process.env.FOURTH_PASSWORD || '';
      if (!user || !pass) throw new Error('FOURTH_USER / FOURTH_PASSWORD env vars not set');

      if (!hasLoginField) {
        await page.goto(`${FOURTH_URL}/account.html`, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(3000);
      }
      await screenshot(page, 'step2-login-page');

      const emailField = await page.waitForSelector(
        'input[type="email"], input[name="username"], #username, input[type="text"]',
        { timeout: 10000 }
      );
      await emailField.fill(user);

      let passField = await page.$('input[type="password"], input[name="password"], #password');
      if (!passField) {
        await page.click('button[type="submit"], button:has-text("Next"), button:has-text("Continue")').catch(() => {});
        await page.waitForTimeout(2000);
        passField = await page.waitForSelector('input[type="password"], #password', { timeout: 8000 });
      }
      await passField.fill(pass);
      await screenshot(page, 'step2-creds-filled');

      await page.click('button[type="submit"], .s-login-button, button:has-text("Log In"), button:has-text("Sign In")');
      await page.waitForTimeout(5000);
      await logPageState(page, 'after-login-submit');
      await screenshot(page, 'step2-post-login');

      console.log('[Fourth] Navigating to report post-login');
      await page.goto(reportUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(5000);
      await logPageState(page, 'after-report-nav-post-login');
    }

    await screenshot(page, 'step3-report-page');

    // ── Step 3: Wait for GoodData to fully render ─────────────────────────────
    // networkidle = all XHR complete. Then wait extra for React render cycle.
    console.log('[Fourth] Waiting for network idle...');
    try {
      await page.waitForLoadState('networkidle', { timeout: 45000 });
      console.log('[Fourth] Network idle reached');
    } catch (_) {
      console.log('[Fourth] networkidle timeout — proceeding');
    }

    // Wait for any GoodData loading spinner to disappear
    try {
      await page.waitForSelector(
        '.gd-loading-equalizer, .s-loading, [class*="loading-spinner"], [class*="loadingSpinner"]',
        { state: 'hidden', timeout: 20000 }
      );
      console.log('[Fourth] Loading spinner gone');
    } catch (_) {
      console.log('[Fourth] No loading spinner found (or already gone)');
    }

    // Extra settle time — GoodData React re-renders after data arrives
    console.log('[Fourth] Waiting 8s for GoodData React render...');
    await page.waitForTimeout(8000);
    await logPageState(page, 'after-settle');
    await screenshot(page, 'step3-after-settle', true); // fullPage

    // ── Step 4: Find "Labor %" header ────────────────────────────────────────
    console.log('[Fourth] Searching for Labor % header...');
    const laborHeader = await findLaborHeader(page);

    if (!laborHeader) {
      await logDomInfo(page, 'labor-not-found');
      await screenshot(page, 'step4-labor-not-found', true);
      throw new Error(`Labor % header not found in DOM after networkidle + settle. DOM info logged above. [page_url=${page.url()}]`);
    }

    // Scroll into view (AG Grid virtualizes — element may be off-screen)
    await laborHeader.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center' }));
    await page.waitForTimeout(800);
    await screenshot(page, 'step4-before-hover');

    await laborHeader.hover();
    await page.waitForTimeout(1500); // GoodData hover delay before showing menu
    await screenshot(page, 'step4-after-hover');
    console.log('[Fourth] Hovered Labor % — looking for options menu');

    // ── Step 5: Options menu ─────────────────────────────────────────────────
    const MENU_SELECTORS = [
      '.s-options-menu',
      'button[class*="optionsMenu"]',
      '[class*="s-options-menu"]',
      'button[aria-label*="option" i]',
      'button[title*="option" i]',
      'button[aria-label*="more" i]',
      '[class*="HeaderMenu"]',
      '[class*="headerMenu"]',
      '.ag-header-cell-menu-button',  // AG Grid native sort/menu button
    ];

    let optionsBtn = null;
    for (const sel of MENU_SELECTORS) {
      try {
        optionsBtn = await page.waitForSelector(sel, { state: 'visible', timeout: 3000 });
        if (optionsBtn) { console.log(`[Fourth] Options button via: ${sel}`); break; }
      } catch (_) {}
    }

    // Fallback: re-hover the laborHeader (sometimes needs two hovers) then try again
    if (!optionsBtn) {
      console.log('[Fourth] Menu not found on first hover — re-hovering...');
      await page.mouse.move(0, 0); // move away first
      await page.waitForTimeout(500);
      await laborHeader.hover();
      await page.waitForTimeout(2000);
      await screenshot(page, 'step5-second-hover');

      for (const sel of MENU_SELECTORS) {
        try {
          optionsBtn = await page.waitForSelector(sel, { state: 'visible', timeout: 3000 });
          if (optionsBtn) { console.log(`[Fourth] Options button (2nd hover) via: ${sel}`); break; }
        } catch (_) {}
      }
    }

    if (!optionsBtn) {
      await logDomInfo(page, 'no-options-btn');
      await screenshot(page, 'step5-no-options-btn', true);
      throw new Error(`Options menu not found after hover. [page_url=${page.url()}]`);
    }

    // ── Step 6: Export ───────────────────────────────────────────────────────
    const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
    await optionsBtn.click();
    await page.waitForTimeout(600);
    await screenshot(page, 'step6-menu-open');

    try {
      await page.click(
        '.s-options-menu-export, li:has-text("Export"), button:has-text("Export"), [role="menuitem"]:has-text("Export")',
        { timeout: 5000 }
      );
      console.log('[Fourth] Clicked Export');
    } catch (_) { console.log('[Fourth] No separate Export item'); }

    await page.waitForTimeout(400);
    try {
      await page.click(
        'li:has-text("XLSX"), button:has-text("XLSX"), li:has-text("Excel"), [role="menuitem"]:has-text("XLSX")',
        { timeout: 3000 }
      );
      console.log('[Fourth] Clicked XLSX');
    } catch (_) {}

    const download = await downloadPromise;
    const dlPath   = await download.path();
    if (!dlPath) throw new Error('Download path null');
    fs.copyFileSync(dlPath, outPath);
    console.log(`[Fourth] ${reportKey} downloaded → ${outPath}`);
    return { success: true, filePath: outPath };

  } catch (err) {
    let url = '?';
    try { url = browser.contexts()[0]?.pages()[0]?.url() || '?'; } catch (_) {}
    const errMsg = `${err.message} [page_url=${url}]`;
    console.error(`[Fourth] ${reportKey} FAILED:`, errMsg);
    return { success: false, error: errMsg };
  } finally {
    try { await browser.close(); } catch (_) {}
  }
}

module.exports = { downloadFourthReport };
