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
 * Finds the element containing "Labor %" text.
 * GoodData often splits "Labor" and "%" across child <span> elements, so
 * TreeWalker on individual text nodes never sees "Labor %" as a whole.
 * Every strategy here reads el.textContent (combined child text) instead.
 * Returns a Playwright ElementHandle or null.
 */
async function findLaborHeader(page) {
  // Before searching, scroll the header row right so AG Grid renders
  // any virtualised columns that are off-screen to the right.
  try {
    await page.evaluate(() => {
      const scroller = document.querySelector(
        '.ag-header-viewport, .ag-body-horizontal-scroll-viewport, ' +
        '[class*="tableScrollView"], [class*="ScrollPane"], [class*="scrollContainer"]'
      );
      if (scroller) scroller.scrollLeft = 99999;
    });
    await page.waitForTimeout(800);
  } catch (_) {}

  // Strategy 1: combined textContent on known header-element types.
  // Covers AG Grid, GoodData pivot tables, plain <th>, and any *header* class.
  const headerHandle = await page.evaluateHandle(() => {
    const HEADER_SELECTORS = [
      '[role="columnheader"]',
      '.ag-header-cell',
      'th',
      '[class*="header-cell"]',
      '[class*="headerCell"]',
      '[class*="HeaderCell"]',
      '[class*="column-header"]',
      '[class*="ColumnHeader"]',
      '[class*="pivot-table-header"]',
      '[class*="tableHeader"]',
    ];
    function normalize(t) { return (t || '').replace(/\s+/g, ' ').trim(); }
    for (const sel of HEADER_SELECTORS) {
      for (const el of document.querySelectorAll(sel)) {
        const t = normalize(el.textContent);
        if (t.includes('Labor %') || t === 'Labor%') {
          // Prefer elements that are actually visible
          const rect = el.getBoundingClientRect();
          if (rect.width > 0 || rect.height > 0) return el;
        }
      }
    }
    return null;
  });
  const headerEl = headerHandle.asElement();
  if (headerEl) { console.log('[Fourth] Found Labor % via textContent header search'); return headerEl; }

  // Strategy 2: aria-label / title attribute
  for (const attr of [
    '[aria-label*="Labor %"]', '[aria-label*="Labor%"]',
    '[title*="Labor %"]',     '[title*="Labor%"]',
    '[aria-label*="Labor"]',  '[title*="Labor"]',
  ]) {
    try {
      const el2 = await page.$(attr);
      if (el2) { console.log(`[Fourth] Found Labor % via attr: ${attr}`); return el2; }
    } catch (_) {}
  }

  // Strategy 3: broad textContent sweep — any element whose full combined text
  // includes "Labor" and is positioned in the upper portion of the page
  // (likely a header, not a data cell).
  const broadHandle = await page.evaluateHandle(() => {
    function normalize(t) { return (t || '').replace(/\s+/g, ' ').trim(); }
    const candidates = [];
    for (const el of document.querySelectorAll('span, div, td, th, li, button')) {
      const t = normalize(el.textContent);
      if (t === 'Labor %' || t === 'Labor%') {
        const rect = el.getBoundingClientRect();
        candidates.push({ el, top: rect.top, w: rect.width, h: rect.height });
      }
    }
    // Prefer elements closest to top of page (column headers are above data)
    candidates.sort((a, b) => a.top - b.top);
    return candidates[0]?.el || null;
  });
  const broadEl = broadHandle.asElement();
  if (broadEl) { console.log('[Fourth] Found Labor % via broad exact-text sweep'); return broadEl; }

  // Strategy 4: TreeWalker — catches cases where the text IS a single node
  const twHandle = await page.evaluateHandle(() => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      const t = (node.textContent || '').replace(/\s+/g, ' ').trim();
      if (t === 'Labor %' || t === 'Labor%' || t.includes('Labor %')) {
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
  const twEl = twHandle.asElement();
  if (twEl) { console.log('[Fourth] Found Labor % via TreeWalker (single text node)'); return twEl; }

  // Strategy 5: GoodData Classic uses iframes for embedded reports — search inside each iframe
  for (const frame of page.frames()) {
    if (frame === page.mainFrame()) continue;
    try {
      const iframeEl = await frame.evaluateHandle(() => {
        function norm(t) { return (t || '').replace(/\s+/g, ' ').trim(); }
        for (const el of document.querySelectorAll('[role="columnheader"], th, td, span, div')) {
          const t = norm(el.textContent);
          if (t.includes('Labor %') || t === 'Labor%') {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 || rect.height > 0) return el;
          }
        }
        return null;
      });
      const iframeFoundEl = iframeEl.asElement();
      if (iframeFoundEl) { console.log(`[Fourth] Found Labor % inside iframe: ${frame.url().slice(0, 80)}`); return iframeFoundEl; }
    } catch (_) {}
  }
  console.log(`[Fourth] Checked ${page.frames().length} frames — Labor % not found anywhere`);

  return null;
}

async function downloadFourthReport(reportKey, targetDate) {
  const tmpDir  = '/tmp/uploads';
  fs.mkdirSync(tmpDir, { recursive: true });
  const outPath = path.join(tmpDir, `intel-fourth-${reportKey.toLowerCase()}-${targetDate}.xlsx`);

  const reportUrl = REPORTS[reportKey];
  if (!reportUrl) throw new Error(`Unknown report key: ${reportKey}`);

  // Clear stale profile cache — accumulated GoodData/YUI3 cache files bloat
  // browser startup RAM and hit the 512MB Render limit within seconds of launch.
  try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch (_) {}

  const browser = await launchContext(PROFILE_DIR, { acceptDownloads: true });

  try {
    const page = await browser.newPage();

    // ── Step 1: Navigate to report; GoodData redirects to login if needed ─────
    console.log(`[Fourth] Navigating to ${reportKey} report URL`);
    await page.goto(reportUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(5000);
    await logPageState(page, 'after-initial-nav');

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

      await page.click('button[type="submit"], .s-login-button, button:has-text("Log In"), button:has-text("Sign In")');
      await page.waitForTimeout(5000);
      await logPageState(page, 'after-login-submit');

      console.log('[Fourth] Navigating to report post-login');
      await page.goto(reportUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(5000);
      await logPageState(page, 'after-report-nav-post-login');
    }

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

    // ── Step 4: Find "Labor %" header ────────────────────────────────────────
    console.log('[Fourth] Searching for Labor % header...');
    const laborHeader = await findLaborHeader(page);

    if (!laborHeader) {
      await logDomInfo(page, 'labor-not-found');
      await screenshot(page, 'step4-labor-not-found', true);
      console.log('[Fourth] Labor % header not found — will try widget-level export fallback');
    }

    // ── Step 4b: Widget-level export fallback ────────────────────────────────
    // If we couldn't find "Labor %" column header, hover the whole visualization
    // widget and use GoodData's three-dot menu export — which works on ANY widget.
    let optionsBtn = null;

    if (laborHeader) {
      // Scroll into view (AG Grid virtualizes — element may be off-screen)
      await laborHeader.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center' }));
      await page.waitForTimeout(800);

      let hoverOk = false;
      try {
        await laborHeader.hover({ timeout: 8000 });
        hoverOk = true;
      } catch (hoverErr) {
        console.log(`[Fourth] Labor % header not hoverable (${hoverErr.message.split('\n')[0]}) — falling through to widget export`);
      }

      if (hoverOk) {
      await page.waitForTimeout(1500);
      console.log('[Fourth] Hovered Labor % — looking for column options menu');

      const COLUMN_MENU_SELECTORS = [
        '.s-options-menu',
        'button[class*="optionsMenu"]',
        '[class*="s-options-menu"]',
        'button[aria-label*="option" i]',
        'button[title*="option" i]',
        'button[aria-label*="more" i]',
        '[class*="HeaderMenu"]',
        '[class*="headerMenu"]',
        '.ag-header-cell-menu-button',
      ];

      for (const sel of COLUMN_MENU_SELECTORS) {
        try {
          optionsBtn = await page.waitForSelector(sel, { state: 'visible', timeout: 3000 });
          if (optionsBtn) { console.log(`[Fourth] Column options button via: ${sel}`); break; }
        } catch (_) {}
      }

      // Re-hover if not found yet
      if (!optionsBtn) {
        await page.mouse.move(0, 0);
        await page.waitForTimeout(500);
        try { await laborHeader.hover({ timeout: 5000 }); } catch (_) {}
        await page.waitForTimeout(2000);
        for (const sel of COLUMN_MENU_SELECTORS) {
          try {
            optionsBtn = await page.waitForSelector(sel, { state: 'visible', timeout: 3000 });
            if (optionsBtn) { console.log(`[Fourth] Column options button (2nd hover): ${sel}`); break; }
          } catch (_) {}
        }
      }
      } // end if (hoverOk)
    }

    // Widget-level export menu — hover the widget container, then click the export button.
    // GoodData Classic (YUI3): widgets are .yui3-c-dashboardwidget / .widgetContent / .c-widgetcontent
    // GoodData BUI (React):    widgets are .s-dash-item / .gd-widget-content
    if (!optionsBtn) {
      console.log('[Fourth] Trying widget-level export menu...');
      const WIDGET_SELECTORS = [
        // GoodData Classic (YUI3) — confirmed via gdClasses in logs
        '.yui3-c-dashboardwidget',
        '.c-widgetcontent',
        '.widgetContent',
        '.yui3-c-iframedashboardwidget',
        '.c-projectdashboard-items',
        // GoodData BUI (React)
        '.s-dash-item',
        '.gd-widget-content',
        '[class*="DashboardItem"]',
        '[class*="visualization"]',
        '[class*="widget-body"]',
        'main, .gd-content-div',
      ];
      // Log all frame URLs for diagnostics — needed to identify iframe report pages
      const frameUrls = page.frames().map(f => ({ url: f.url().slice(0, 100) }));
      console.log('[Fourth] Frame URLs:', JSON.stringify(frameUrls));

      for (const wSel of WIDGET_SELECTORS) {
        try {
          const widget = await page.$(wSel);
          if (!widget) continue;
          // Try both Playwright hover AND JS event dispatch.
          // GoodData Classic uses JS mouseenter/mouseover listeners — .hover() alone
          // may not trigger them in headless mode.
          try { await widget.hover({ timeout: 3000 }); } catch (_) {}
          await page.evaluate(el => {
            ['mouseenter', 'mouseover', 'mousemove'].forEach(evt =>
              el.dispatchEvent(new MouseEvent(evt, { bubbles: true, cancelable: true, view: window })));
          }, widget);
          await page.waitForTimeout(2000);
          const WIDGET_MENU_SELECTORS = [
            // GoodData Classic download/export button (appears on widget hover)
            '.s-gdw-s3download-button',
            '[class*="s-gdw-"][class*="download"]',
            '[class*="gdw-download"]',
            '[class*="s-download"]',
            '.gd-report-download',
            '[class*="report-download"]',
            // GoodData Classic options menu
            '.s-options-menu',
            '[class*="s-options-menu"]',
            // GoodData BUI
            '.s-dash-item-action-menu-button',
            'button[class*="DashboardItemActionMenu"]',
            '.gd-icon-more',
            '.gd-icon-kebab-horizontal',
            'button[aria-label*="more" i]',
            'button[aria-label*="option" i]',
            'button[title*="more" i]',
            '[class*="ActionMenu"] button',
            '[class*="actionMenu"] button',
          ];
          for (const mSel of WIDGET_MENU_SELECTORS) {
            try {
              optionsBtn = await page.waitForSelector(mSel, { state: 'visible', timeout: 2000 });
              if (optionsBtn) { console.log(`[Fourth] Widget menu button via ${wSel} → ${mSel}`); break; }
            } catch (_) {}
          }
          if (optionsBtn) break;
        } catch (_) {}
      }
    }

    // Strategy: search inside iframes for export buttons
    // GoodData Classic uses yui3-c-iframedashboardwidget — content lives in child frames
    if (!optionsBtn) {
      console.log(`[Fourth] Searching ${page.frames().length} frames for export buttons...`);
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        try {
          // Trigger hover inside frame to reveal any hover-only toolbars
          await frame.evaluate(() => document.body.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })));
          await page.waitForTimeout(600);
          const IFRAME_EXPORT_SELS = [
            '[title*="Export" i]', '[title*="Download" i]',
            '[aria-label*="Export" i]', '[aria-label*="Download" i]',
            '.s-export', '.s-download', '.s-reportExport', '.s-xls-export',
            'button:has-text("Export")', 'a:has-text("Export")',
            'button:has-text("Download")', 'a:has-text("Download")',
            '[class*="exportButton"]', '[class*="export-button"]',
          ];
          for (const sel of IFRAME_EXPORT_SELS) {
            try {
              const el = await frame.waitForSelector(sel, { state: 'visible', timeout: 800 });
              if (el) {
                console.log(`[Fourth] Iframe export button: ${sel} (${frame.url().slice(0, 80)})`);
                optionsBtn = el;
                break;
              }
            } catch (_) {}
          }
          if (optionsBtn) break;
        } catch (_) {}
      }
    }

    if (!optionsBtn) {
      await logDomInfo(page, 'no-options-btn');
      await screenshot(page, 'step5-no-options-btn', true);
      throw new Error(`No export menu found via column header OR widget-level hover. DOM info logged above. [page_url=${page.url()}]`);
    }

    // ── Step 5: Export ───────────────────────────────────────────────────────
    const downloadPromise = page.waitForEvent('download', { timeout: 30000 });
    await optionsBtn.click();
    await page.waitForTimeout(600);

    // Try "Export" submenu item first (column-header path), then XLSX/CSV directly
    // Also handles GoodData Classic dashboard actions menu (s-actionsButton)
    try {
      await page.click(
        '.s-options-menu-export, li:has-text("Export"), button:has-text("Export"), [role="menuitem"]:has-text("Export"), .s-export, li.s-export',
        { timeout: 5000 }
      );
      console.log('[Fourth] Clicked Export');
    } catch (_) { console.log('[Fourth] No separate Export item — trying XLSX/CSV directly'); }

    await page.waitForTimeout(400);
    try {
      await page.click(
        'li:has-text("XLSX"), button:has-text("XLSX"), li:has-text("Excel"), [role="menuitem"]:has-text("XLSX"), [role="menuitem"]:has-text("Excel"), li:has-text("XLS"), li:has-text("CSV"), .s-csv-export, .s-xls-export',
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
