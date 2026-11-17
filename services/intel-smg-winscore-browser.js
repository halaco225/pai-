// services/intel-smg-winscore-browser.js
//
// Pulls Win Score period-to-date, per store, by driving reporting.smg.com the
// way Harold does by hand. See docs/SMG_WIN_SCORE.md for the recipe he walked
// me through on 2026-10-03.
//
// Why this replaces the saved-favorite approach in intel-smg-winscore.js:
// that favorite (033C5385…) is a REGION-level, rolling-30-day, two-metric
// report. A region-level report returns a single aggregate row with no store
// id, so the parser found no store rows and wrote nothing — smg_win_scores has
// sat at 0 rows since it was built. The scraper was fine; its source was wrong.
//
// Rebuilding the report in the page rather than over raw HTTP is deliberate:
// the level and group-by dropdowns are ASP.NET cascading postbacks that only
// populate after the report type posts back, each needing a fresh __VIEWSTATE.
// Reproducing that by hand is exactly the brittleness that broke this before.

const { launchContext } = require('./browser-launch');
const db = require('./db');

const BASE  = 'https://reporting.smg.com';
const LOGIN = `${BASE}/Index.aspx`;

// Harold's recipe, by the visible text of each option — never by index, which
// shifts whenever SMG reorders a dropdown.
const WANT = {
  reportType: 'Comparison',
  // Survey Date counts when the guest answered; Visit Date counts when they
  // came in. The same period gives different numbers under each, which is the
  // usual reason a Win Score here does not match one read off SMG's own
  // dashboard. docs/SMG_WIN_SCORE.md records Survey Date, captured watching
  // Harold run the report by hand. Change this one string to switch.
  dateType:   'Survey Date',
  dateRange:  'Current Fiscal Period',
  level:      'Store',
  groupBy:    'Area',
  item:       'Win Score',
};

// Pick a <select> option by its exact visible text. Returns the value chosen.
async function selectByText(page, selector, text) {
  const value = await page.$eval(selector, (el, t) => {
    const opt = [...el.options].find(o => o.text.trim() === t);
    return opt ? opt.value : null;
  }, text);
  if (value === null) {
    const available = await page.$eval(selector, el => [...el.options].map(o => o.text.trim()));
    throw new Error(`${selector}: no option "${text}". Available: ${available.join(' | ')}`);
  }
  await page.selectOption(selector, value);
  return value;
}

// ASP.NET repopulates half the form on each change; give it a beat to settle.
// Find a radio by the text sitting next to it — its <label for>, its wrapping
// label, its aria-label or title, or the text immediately after it — check it,
// and confirm it took. Throws naming what was on offer, because a date type
// that silently stays on SMG's default is the failure this exists to stop.
async function checkRadioByLabel(page, text) {
  const wanted = String(text).trim().toLowerCase();
  const labelled = await page.$$eval('input[type=radio]', (radios) => radios.map((el, i) => {
    const bits = [];
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) bits.push(l.innerText);
    }
    const wrap = el.closest('label');
    if (wrap) bits.push(wrap.innerText);
    if (el.getAttribute('aria-label')) bits.push(el.getAttribute('aria-label'));
    if (el.title) bits.push(el.title);
    if (el.nextSibling && el.nextSibling.textContent) bits.push(el.nextSibling.textContent);
    if (el.parentElement) bits.push(el.parentElement.innerText);
    const label = bits.map(b => String(b).replace(/\s+/g, ' ').trim()).find(Boolean) || '';
    return { i, label, name: el.name || '', value: el.value || '' };
  }));

  const hit = labelled.find(r => r.label.toLowerCase().includes(wanted));
  if (!hit) {
    const offered = labelled.map(r => r.label || `[${r.name}=${r.value}]`).filter(Boolean);
    throw new Error(
      `SMG report builder has no "${text}" option — the date type could not be set, `
      + `so the pull was stopped rather than counted the wrong way. On offer: ${offered.join(' | ') || 'no radios found'}`
    );
  }

  const ok = await page.$$eval('input[type=radio]', (radios, i) => {
    const el = radios[i];
    if (!el) return false;
    el.click();
    return el.checked;
  }, hit.i);
  if (!ok) throw new Error(`Could not select "${text}" on the SMG report builder.`);
}

async function settle(page) {
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
  await page.waitForTimeout(600);
}

async function login(page, user, pass) {
  await page.goto(LOGIN, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.fill('input[type=text]', user);
  await page.fill('input[type=password]', pass);
  await Promise.all([
    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {}),
    page.click('input[type=submit], button[type=submit]'),
  ]);
  if (await page.$('input[type=password]')) {
    throw new Error('SMG login failed — check SMG_USER / SMG_PASSWORD');
  }
}

async function buildReport(page) {
  await page.goto(`${BASE}/ReportBuilder.aspx?report=Comparison`,
                  { waitUntil: 'domcontentloaded', timeout: 45000 });
  await settle(page);

  await selectByText(page, 'select[name=rbReportTypeSEL]', WANT.reportType);
  await settle(page);

  // This used to hunt for a radio by its value attribute and shrug if it found
  // nothing, so a renamed input left SMG's own default date type in place and
  // the pull returned real-looking numbers counted the wrong way. Pick it by
  // the label the operator reads, the way every dropdown here is picked, and
  // refuse the run if it cannot be set.
  await checkRadioByLabel(page, WANT.dateType);
  await settle(page);

  // The Current Fiscal Period option carries its own dates and period id
  // (e.g. "9/8/2026|10/5/2026|False|95"), so it has to be read at run time.
  const dateValue = await selectByText(page, 'select[name=rbDateRangeSEL]', WANT.dateRange);
  await settle(page);

  await selectByText(page, 'select[name=rbLevelSEL]', WANT.level);
  await settle(page);

  // Store level grouped by Area is what returns the per-store rows AND the
  // area aggregate in one pull.
  await selectByText(page, 'select[name=rbGroupBySEL]', WANT.groupBy).catch(async err => {
    console.warn('[WinScore] group-by Area unavailable:', err.message);
  });
  await settle(page);

  // Every unit the account can see.
  const selectAll = await page.$('a:has-text("Select all"), #rbUnitSelectAll');
  if (selectAll) { await selectAll.click().catch(() => {}); await settle(page); }

  await page.click('text=Build Report').catch(async () => {
    await page.click('input[value="Build Report"], button:has-text("Build Report")');
  });
  await page.waitForTimeout(3000);
  await settle(page);

  return { dateValue };
}

// "1P038876 - 038876,8080 WELLS STREET,SENOIA,GA" -> "038876".
// "Combined" and area rows carry no store id and must not be mistaken for one;
// in particular PPP1393282 must never be read as a store number.
function storeIdFrom(label) {
  const m = String(label || '').match(/^\s*\d*P?0?(\d{6})\s*-\s*(\d{6})\s*,/);
  if (m && m[2]) return m[2];
  const alt = String(label || '').match(/\((\d{6})\)/);
  return alt ? alt[1] : null;
}

function pctFrom(v) {
  const m = String(v == null ? '' : v).match(/(-?\d+(?:\.\d+)?)\s*%/);
  return m ? Number(m[1]) : null;
}

// Read every page of the result table, not just the first — this report
// paginates, and a first-page-only read silently loses half the stores.
async function readAllPages(page) {
  const rows = [];
  const seen = new Set();

  for (let guard = 0; guard < 25; guard++) {
    const pageRows = await page.$$eval('table tr', trs => trs.map(tr =>
      [...tr.querySelectorAll('td,th')].map(td => td.innerText.trim())
    ));
    for (const r of pageRows) {
      if (r.length < 3) continue;
      const key = r.join('|');
      if (seen.has(key)) continue;
      seen.add(key);
      rows.push(r);
    }

    const next = await page.$('a:has-text("Next")');
    if (!next) break;
    const disabled = await next.evaluate(el =>
      el.getAttribute('disabled') !== null ||
      el.className.toLowerCase().includes('disabled') ||
      el.getAttribute('href') === null);
    if (disabled) break;
    await next.click().catch(() => {});
    await page.waitForTimeout(2500);
    await settle(page);
  }
  return rows;
}

/**
 * Pull Win Score PTD per store.
 * Returns { periodEnd, stores: [{store_id, win_score, survey_count}], combined }.
 */
async function pullWinScores() {
  const user = process.env.SMG_USER;
  const pass = process.env.SMG_PASSWORD;
  if (!user || !pass) throw new Error('SMG_USER / SMG_PASSWORD are not set');

  // launchContext returns a persistent context, not { browser, context }, and
  // it needs a profile directory. /tmp is writable on Render; the dir is reused
  // across runs so a warm profile does not have to be rebuilt each morning.
  const profileDir = process.env.SMG_PROFILE_DIR || '/tmp/smg-winscore-profile';
  const context = await launchContext(profileDir);
  const page = await context.newPage();

  try {
    await login(page, user, pass);
    const { dateValue } = await buildReport(page);

    // "9/8/2026|10/5/2026|False|95" -> period end 10/5/2026
    const parts = String(dateValue || '').split('|');
    const periodEnd = parts[1] ? new Date(parts[1]).toISOString().slice(0, 10) : null;
    if (!periodEnd) throw new Error(`Could not read a period end from "${dateValue}"`);

    const raw = await readAllPages(page);

    const stores = [];
    let combined = null;
    for (const r of raw) {
      const label = r[0];
      const win   = pctFrom(r[r.length - 1]);
      const count = Number(String(r[1]).replace(/[^\d]/g, '')) || 0;
      if (win == null) continue;

      if (/^combined$/i.test(label)) { combined = { win_score: win, survey_count: count }; continue; }
      const store_id = storeIdFrom(label);
      if (store_id) stores.push({ store_id, win_score: win, survey_count: count });
    }

    if (!stores.length) {
      throw new Error(`Report produced no store rows (${raw.length} raw rows read). ` +
                      'Writing nothing rather than an empty period.');
    }

    return { periodEnd, stores, combined };
  } finally {
    // Closing a persistent context shuts its browser down too.
    await context.close().catch(() => {});
  }
}

async function pullAndStore() {
  const { periodEnd, stores, combined } = await pullWinScores();
  const pool = db.getPool();
  if (!pool) throw new Error('Database unavailable');

  let written = 0;
  for (const s of stores) {
    await pool.query(
      `INSERT INTO smg_win_scores (store_id, period_end_date, win_score, survey_count, updated_at)
       VALUES ($1, $2::date, $3, $4, NOW())
       ON CONFLICT (store_id, period_end_date) DO UPDATE
         SET win_score = EXCLUDED.win_score,
             survey_count = EXCLUDED.survey_count,
             updated_at = NOW()`,
      [s.store_id, periodEnd, s.win_score, s.survey_count]
    );
    written++;
  }

  console.log(`[WinScore] ${written} store(s) written for period ending ${periodEnd}` +
              (combined ? ` (combined ${combined.win_score}% of ${combined.survey_count})` : ''));
  return { periodEnd, written, combined };
}

module.exports = { pullWinScores, pullAndStore, storeIdFrom, pctFrom, WANT };
