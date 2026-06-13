'use strict';
/**
 * SMG Win Score — pure HTTP rewrite (no Playwright)
 * Scrapes reporting.smg.com Comparison Report (Current Fiscal Period)
 * and stores per-store Win Score PTD in smg_win_scores table.
 *
 * Credentials: SMG_USER / SMG_PASSWORD env vars
 */
const https  = require('https');
const http   = require('http');
const url    = require('url');
const db     = require('./db');

const BASE   = 'https://reporting.smg.com';
const LOGIN  = `${BASE}/Index.aspx`;
const RB_URL = `${BASE}/handlers/ReportBuilder.ashx`;
const RV_URL = `${BASE}/handlers/ReportViewer.ashx`;

// Unit IDs are built dynamically from store_assignments: format is 1P{store_id}
// Cached at module load time and refreshed each processWinScore run
let _unitIds = null;
async function getUnitIds() {
  const assignments = await db.getStoreAssignments();
  const ids = Object.keys(assignments).map(id => `1P${id}`);
  return ids.join(';'); // report builder uses semicolons
}

const WIN_SCORE_ITEM = '699308';
const LEVEL_STORE    = '10';

// Saved SMG favorite report that auto-renders the Win Score Comparison table as HTML.
// reporting.smg.com has NO clean JSON data API — the only way to get the numbers is to
// load a saved favorite (Report.aspx?ID=...), which restores the full report definition
// into session and renders the data table in the returned HTML (see parseReportResponse).
//
// Default = "Win Score - Last 30 Days" (region-aggregate, rolling dates). To get per-store
// numbers instead, build a Store-level comparison favorite in SMG, then set
// SMG_WINSCORE_REPORT_ID to its ID — no code change needed; the parser handles both shapes.
const WIN_SCORE_REPORT_ID = process.env.SMG_WINSCORE_REPORT_ID || '033C5385EEA0F79D08857C066EDF71D7';

// ── HTTP helpers ──────────────────────────────────────────────────────────────

function rand() { return Math.random().toString(); }

function makeCookieJar() {
  const store = new Map();
  return {
    set(domain, cookieHeader) {
      if (!cookieHeader) return;
      const headers = Array.isArray(cookieHeader) ? cookieHeader : [cookieHeader];
      for (const h of headers) {
        const parts = h.split(';');
        const pair  = parts[0].trim();
        const eq    = pair.indexOf('=');
        if (eq < 1) continue;
        const name  = pair.slice(0, eq).trim();
        const value = pair.slice(eq + 1).trim();
        let cookieDomain = domain;
        for (const p of parts.slice(1)) {
          const t = p.trim();
          if (/^domain=/i.test(t)) { cookieDomain = t.slice(7).trim().toLowerCase(); break; }
        }
        if (!store.has(cookieDomain)) store.set(cookieDomain, new Map());
        store.get(cookieDomain).set(name, value);
      }
    },
    get(domain) {
      const result = new Map();
      const parts = domain.split('.');
      for (let i = 1; i < parts.length; i++) {
        const jar = store.get('.' + parts.slice(i).join('.'));
        if (jar) for (const [k, v] of jar) result.set(k, v);
      }
      const jar = store.get(domain);
      if (jar) for (const [k, v] of jar) result.set(k, v);
      return [...result.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
  };
}

function httpReq(jar, method, reqUrl, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed  = new url.URL(reqUrl);
    const domain  = parsed.hostname;
    const cookies = jar.get(domain);
    const isHttps = parsed.protocol === 'https:';
    const lib     = isHttps ? https : http;

    const headers = {
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      ...(cookies ? { Cookie: cookies } : {}),
      ...opts.headers,
    };

    const body = opts.body || null;
    if (body) {
      headers['Content-Type']   = headers['Content-Type'] || 'application/x-www-form-urlencoded';
      headers['Content-Length'] = Buffer.byteLength(body);
    }

    const reqOpts = {
      method,
      hostname: parsed.hostname,
      port:     parsed.port || (isHttps ? 443 : 80),
      path:     parsed.pathname + parsed.search,
      headers,
    };

    const req = lib.request(reqOpts, (res) => {
      const setCookies = res.headers['set-cookie'];
      if (setCookies) jar.set(domain, setCookies);

      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const next = new url.URL(res.headers.location, reqUrl).href;
        res.resume();
        return resolve(httpReq(jar, 'GET', next, {}));
      }

      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({
        status:  res.statusCode,
        headers: res.headers,
        body:    Buffer.concat(chunks).toString('utf8'),
      }));
    });

    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── HTML helpers ──────────────────────────────────────────────────────────────

function extractHidden(html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = html.match(new RegExp(`<input[^>]+name="${escaped}"[^>]+value="([^"]*)"`, 'i')) ||
            html.match(new RegExp(`<input[^>]+value="([^"]*)"[^>]+name="${escaped}"`, 'i'));
  return m ? m[1] : '';
}

function formEncode(obj) {
  return Object.entries(obj)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v ?? '')}`)
    .join('&');
}

// ── Login ─────────────────────────────────────────────────────────────────────

// httpReqNoFollow — same as httpReq but stops at first redirect and returns location
function httpReqNoFollow(jar, method, reqUrl, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed  = new url.URL(reqUrl);
    const domain  = parsed.hostname;
    const cookies = jar.get(domain);
    const isHttps = parsed.protocol === 'https:';
    const lib     = isHttps ? https : http;
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      ...(cookies ? { Cookie: cookies } : {}),
      ...opts.headers,
    };
    const body = opts.body || null;
    if (body) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; headers['Content-Length'] = Buffer.byteLength(body); }
    const req = lib.request({ method, hostname: parsed.hostname, port: parsed.port || (isHttps ? 443 : 80), path: parsed.pathname + parsed.search, headers }, (res) => {
      const setCookies = res.headers['set-cookie'];
      if (setCookies) jar.set(domain, setCookies);
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, location: res.headers.location, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function login(jar, user, pass) {
  console.log('[WinScore] GET login page');
  const r1 = await httpReq(jar, 'GET', LOGIN, {});
  if (r1.status !== 200) throw new Error(`Login page returned HTTP ${r1.status}`);

  const fields = {
    __LASTFOCUS:          '',
    __EVENTTARGET:        '',
    __EVENTARGUMENT:      '',
    __VIEWSTATE:          extractHidden(r1.body, '__VIEWSTATE'),
    __VIEWSTATEGENERATOR: extractHidden(r1.body, '__VIEWSTATEGENERATOR'),
    __EVENTVALIDATION:    extractHidden(r1.body, '__EVENTVALIDATION'),
    ctl00_TheScriptManager_HiddenField: extractHidden(r1.body, 'ctl00_TheScriptManager_HiddenField'),
    'ctl00$cphMain$txtUserName': user,
    'ctl00$cphMain$txtPassword': pass,
  };

  console.log('[WinScore] POST credentials');
  const r2 = await httpReq(jar, 'POST', LOGIN, {
    body: formEncode(fields),
    headers: { Referer: LOGIN, Origin: BASE },
  });

  if (r2.status === 200 && r2.body.includes('txtPassword')) {
    throw new Error('Login failed — check SMG_USER / SMG_PASSWORD');
  }

  // MultiLanguage.aspx = language selection page. Must submit English (value=3) to unlock session.
  const mlUrl = `${BASE}/MultiLanguage.aspx`;
  const mlPage = await httpReqNoFollow(jar, 'GET', mlUrl, {});
  if (mlPage.status === 200 && mlPage.body.includes('rblSelections')) {
    console.log('[WinScore] Submitting language selection (English)');
    const langFields = {
      ctl00_TheScriptManager_HiddenField: '',
      __EVENTTARGET:        '',
      __EVENTARGUMENT:      '',
      __VIEWSTATE:          extractHidden(mlPage.body, '__VIEWSTATE'),
      __VIEWSTATEGENERATOR: extractHidden(mlPage.body, '__VIEWSTATEGENERATOR'),
      __EVENTVALIDATION:    extractHidden(mlPage.body, '__EVENTVALIDATION'),
      'ctl00$cphMain$rblSelections': '3', // English
      'ctl00$cphMain$BtnSubmit':     'Continue',
    };
    await httpReq(jar, 'POST', mlUrl, {
      body:    formEncode(langFields),
      headers: { Referer: mlUrl, Origin: BASE, 'Content-Type': 'application/x-www-form-urlencoded' },
    });
    console.log('[WinScore] Language selection submitted');
  }

  console.log('[WinScore] Login OK');
}

// ── Fiscal period ─────────────────────────────────────────────────────────────

async function getFiscalPeriod(jar) {
  // Load ReportBuilder.aspx first so the server initialises the session state
  console.log('[WinScore] Loading ReportBuilder.aspx to init session');
  await httpReq(jar, 'GET', `${BASE}/ReportBuilder.aspx`, {
    headers: { Referer: LOGIN },
  });

  const qs = `function=getreportcontroller&reporttype=27&reportsubtype=0&r=${rand()}&periodId=`;
  const r  = await httpReq(jar, 'GET', `${RB_URL}?${qs}`, {
    headers: { Accept: 'application/json, text/javascript, */*', Referer: `${BASE}/ReportBuilder.aspx` },
  });
  if (r.status !== 200) throw new Error(`getreportcontroller HTTP ${r.status}`);
  console.log('[WinScore] getreportcontroller raw (500):', r.body.slice(0, 500));

  let data;
  try { data = JSON.parse(r.body); }
  catch (e) { throw new Error(`getreportcontroller parse error: ${r.body.slice(0, 200)}`); }

  // Response may be array or object
  const obj = Array.isArray(data) ? data[0] : data;
  console.log('[WinScore] getreportcontroller keys:', Object.keys(obj || {}));
  const ranges = obj.DateRanges || obj.dateRanges || [];
  const cur    = ranges.find(d => /current fiscal period/i.test(d.T || d.text || d.Text));

  if (!cur) {
    // Fallback: compute a 28-day window ending yesterday (approximates current fiscal period)
    console.warn('[WinScore] Current Fiscal Period not found — using 28-day fallback window');
    const end   = new Date();
    end.setDate(end.getDate() - 1);
    const start = new Date(end);
    start.setDate(start.getDate() - 27);
    const fmt = d => `${d.getMonth()+1}/${d.getDate()}/${d.getFullYear()}`;
    const startDate      = fmt(start);
    const endDate        = fmt(end);
    const quickDateValue = `${startDate}|${endDate}|False|`;
    console.log(`[WinScore] Fallback period: ${startDate} – ${endDate}`);
    return { startDate, endDate, quickDateValue };
  }

  const val   = cur.V || cur.value || cur.Value; // "5/19/2026|6/15/2026|False|95"
  const parts = val.split('|');
  if (parts.length < 2) throw new Error(`Unexpected fiscal period value: ${val}`);

  const startDate      = parts[0];
  const endDate        = parts[1];
  const quickDateValue = val;
  console.log(`[WinScore] Fiscal period: ${startDate} – ${endDate}`);
  return { startDate, endDate, quickDateValue };
}

// ── Report fetch ──────────────────────────────────────────────────────────────

// Load the saved favorite report. Report.aspx?ID=... restores the report definition into
// the session and redirects to ReportBuilder.aspx?report=Comparison, which renders the
// Win Score data table directly in the returned HTML. Returns that HTML for parseReportResponse.
async function fetchReportData(jar) {
  const reportUrl = `${BASE}/Report.aspx?ID=${WIN_SCORE_REPORT_ID}`;
  console.log(`[WinScore] Loading saved report ${WIN_SCORE_REPORT_ID}`);
  const r = await httpReq(jar, 'GET', reportUrl, {
    headers: { Referer: `${BASE}/ReportsAndAnalytics.aspx` },
  });
  console.log(`[WinScore] Report response: HTTP ${r.status}, ${r.body.length} bytes`);
  if (r.status !== 200) throw new Error(`Report.aspx HTTP ${r.status}`);
  return r.body;
}

// ── Response parser ───────────────────────────────────────────────────────────

// Extract a 6-digit store id from a unit label, but ONLY when it is a real store unit.
// Store rows look like "1P039429 - 039429,1660 HWY 81 EAST,..." → 039429.
// Region/Area rows look like "R-KDGI08-LACOSTE, HAROLD - PPP1393282REGNKDGI08" → no store id
// (we must NOT grab the 6 digits out of PPP1393282 — those are not a store).
function parseStoreIdFromUnit(unit) {
  if (!unit) return null;
  const m = String(unit).match(/\b1P(\d{6})\b/);
  return m ? m[1] : null;
}

function parseWinScore(val) {
  if (val == null || val === '') return null;
  const n = parseFloat(String(val).replace('%', '').trim());
  return isNaN(n) ? null : n;
}

// Parse the rendered Comparison Report HTML table.
// Returns { stores: [{store_id, win_score, survey_count}], aggregate: {win_score, survey_count}|null }.
// A Store-level favorite yields per-store rows; the region favorite yields a single aggregate row.
function parseReportResponse(raw) {
  return parseHtmlTable(raw);
}

function parseHtmlTable(html) {
  const trRe  = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const tdRe  = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
  const strip = s => s.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ').trim();

  const allRows = [];
  let trMatch;
  while ((trMatch = trRe.exec(html))) {
    const cells = [];
    let tdMatch;
    tdRe.lastIndex = 0;
    while ((tdMatch = tdRe.exec(trMatch[1]))) cells.push(strip(tdMatch[1]));
    if (cells.length) allRows.push(cells);
  }
  if (!allRows.length) return [];

  // The data table is the one whose header row contains "Win Score".
  let headerIdx = allRows.findIndex(r => r.some(c => /win score/i.test(c)));
  if (headerIdx < 0) return { stores: [], aggregate: null };

  const headers   = allRows[headerIdx].map(h => h.toLowerCase());
  // Unit column header is "Store"/"Region"/"Area"/"Market"/"Unit" depending on report level.
  let   unitCol   = headers.findIndex(h => /store|region|area|market|unit|name/i.test(h));
  if (unitCol < 0) unitCol = 0;
  const scoreCol  = headers.findIndex(h => /win score/i.test(h));
  const countCol  = headers.findIndex(h => /count|survey/i.test(h));

  const stores    = [];
  let   aggregate = null;
  for (let i = headerIdx + 1; i < allRows.length; i++) {
    const row     = allRows[i];
    const unitRaw = row[unitCol] != null ? row[unitCol] : row[0];
    if (!unitRaw) continue;
    const win_score = parseWinScore(scoreCol >= 0 ? row[scoreCol] : null);
    if (win_score == null) continue;
    const survey_count = parseInt(String(countCol >= 0 ? row[countCol] : '0').replace(/\D/g, '')) || 0;

    const store_id = parseStoreIdFromUnit(unitRaw);
    if (store_id) {
      stores.push({ store_id, win_score, survey_count });
    } else if (!aggregate) {
      // No store id → region/area aggregate row (first one wins)
      aggregate = { win_score, survey_count };
    }
  }
  return { stores, aggregate };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function processWinScore(targetDate) {
  const user = process.env.SMG_USER     || '';
  const pass = process.env.SMG_PASSWORD || '';
  if (!user || !pass) return { success: false, error: 'SMG_USER / SMG_PASSWORD env vars not set' };

  const jar = makeCookieJar();

  try {
    await login(jar, user, pass);
  } catch (err) {
    console.error('[WinScore] Login failed:', err.message);
    return { success: false, error: `Login: ${err.message}` };
  }

  let raw;
  try {
    raw = await fetchReportData(jar);
  } catch (err) {
    console.error('[WinScore] fetchReportData failed:', err.message);
    return { success: false, error: `fetchReportData: ${err.message}` };
  }

  const { stores, aggregate } = parseReportResponse(raw);
  console.log(`[WinScore] Parsed ${stores.length} store rows, aggregate=${aggregate ? aggregate.win_score + '%' : 'none'}`);

  const pool = db.getPool();
  if (!pool) return { success: false, error: 'No DB pool' };

  // period_end_date: the report's "to" date (rolling Last 30 Days), falling back to today.
  const periodEnd = extractPeriodEnd(raw) || targetDate || new Date().toISOString().slice(0, 10);

  // Build the rows to write. Prefer per-store data; if the favorite is region-level (no
  // store rows, just an aggregate), apply the region Win Score to every assigned store so
  // each store card populates with the real region number until a Store-level favorite is set.
  let toWrite = stores;
  if (!toWrite.length && aggregate) {
    const assignments = await db.getStoreAssignments();
    toWrite = Object.keys(assignments).map(store_id => ({
      store_id, win_score: aggregate.win_score, survey_count: aggregate.survey_count,
    }));
    console.log(`[WinScore] Region aggregate applied to ${toWrite.length} assigned stores`);
  }

  if (!toWrite.length) {
    console.warn('[WinScore] No scores parsed. Raw (first 2000 chars):\n' + raw.slice(0, 2000));
    return { success: false, error: 'No scores parsed from response' };
  }

  let written = 0;
  for (const s of toWrite) {
    await pool.query(`
      INSERT INTO smg_win_scores (store_id, period_end_date, win_score, survey_count, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (store_id, period_end_date)
      DO UPDATE SET win_score=$3, survey_count=$4, updated_at=NOW()
    `, [s.store_id, periodEnd, s.win_score, s.survey_count]);
    written++;
  }

  const mode = stores.length ? 'per-store' : 'region-aggregate';
  console.log(`[WinScore] ${written} scores written (period end: ${periodEnd}, mode: ${mode})`);
  return { success: true, storesProcessed: toWrite.length, scoresWritten: written, periodEnd, mode };
}

// Pull the report period end ("Comparison Report: M/D/YYYY to M/D/YYYY") as ISO YYYY-MM-DD.
function extractPeriodEnd(html) {
  const m = html.match(/to\s+(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (!m) return null;
  const [, mm, dd, yyyy] = m;
  return `${yyyy}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}

async function debugWinScore() {
  const out = {};
  const user = process.env.SMG_USER || '';
  const pass = process.env.SMG_PASSWORD || '';
  if (!user || !pass) return { error: 'SMG_USER / SMG_PASSWORD not set' };

  // Trace redirect chain and capture full MultiLanguage.aspx body
  const jar = makeCookieJar();
  out.redirectChain = [];
  try {
    const r1 = await httpReqNoFollow(jar, 'GET', LOGIN, {});
    out.redirectChain.push({ url: LOGIN, status: r1.status, location: r1.location || null });

    const fields = {
      __LASTFOCUS: '', __EVENTTARGET: '', __EVENTARGUMENT: '',
      __VIEWSTATE: extractHidden(r1.body, '__VIEWSTATE'),
      __VIEWSTATEGENERATOR: extractHidden(r1.body, '__VIEWSTATEGENERATOR'),
      __EVENTVALIDATION: extractHidden(r1.body, '__EVENTVALIDATION'),
      ctl00_TheScriptManager_HiddenField: extractHidden(r1.body, 'ctl00_TheScriptManager_HiddenField'),
      'ctl00$cphMain$txtUserName': user,
      'ctl00$cphMain$txtPassword': pass,
    };
    const r2 = await httpReqNoFollow(jar, 'POST', LOGIN, { body: formEncode(fields), headers: { Referer: LOGIN, Origin: BASE } });
    out.redirectChain.push({ url: LOGIN + ' POST', status: r2.status, location: r2.location || null });

    let next = r2.location;
    for (let i = 0; i < 6 && next; i++) {
      const nextUrl = next.startsWith('http') ? next : new url.URL(next, BASE).href;
      const rx = await httpReqNoFollow(jar, 'GET', nextUrl, {});
      const entry = { url: nextUrl, status: rx.status, location: rx.location || null };
      if (nextUrl.includes('MultiLanguage')) {
        // Capture full page to see form structure
        entry.fullBody = rx.body;
        // Extract all input names and values
        const inputs = [];
        const inputRe = /<input[^>]+>/gi;
        let m;
        while ((m = inputRe.exec(rx.body))) {
          const nameM = m[0].match(/name="([^"]*)"/i);
          const valM  = m[0].match(/value="([^"]*)"/i);
          const typeM = m[0].match(/type="([^"]*)"/i);
          if (nameM) inputs.push({ name: nameM[1], value: valM ? valM[1] : '', type: typeM ? typeM[1] : '' });
        }
        // Extract all select/option names
        const selects = [];
        const selRe = /<select[^>]+name="([^"]*)"[\s\S]*?<\/select>/gi;
        while ((m = selRe.exec(rx.body))) {
          const opts = [];
          const optRe = /<option[^>]*value="([^"]*)"[^>]*>(.*?)<\/option>/gi;
          let om;
          while ((om = optRe.exec(m[0]))) opts.push({ value: om[1], text: om[2].replace(/<[^>]+>/g,'').trim() });
          selects.push({ name: m[1], options: opts });
        }
        entry.inputs = inputs;
        entry.selects = selects;
      }
      out.redirectChain.push(entry);
      next = rx.location;
    }
  } catch (e) { out.redirectError = e.message; }

  const jar2 = makeCookieJar();
  try {
    await login(jar2, user, pass);
    out.formLogin = 'ok';
    await httpReq(jar2, 'GET', `${BASE}/ReportBuilder.aspx`, { headers: { Referer: LOGIN } });

    // Get controller — parse SurveyItems and date ranges
    const rc = await httpReq(jar2, 'GET',
      `${RB_URL}?function=getreportcontroller&reporttype=27&reportsubtype=0&r=${rand()}&periodId=`,
      { headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Referer: `${BASE}/ReportBuilder.aspx` } }
    );
    out.controllerLength = rc.body.length;
    try {
      const cd = JSON.parse(rc.body);
      const arr = Array.isArray(cd) ? cd : [cd];
      out.surveyItems = (arr[0].SurveyItems || arr[0].surveyItems || []).slice(0, 30);
      out.dateRanges  = (arr[0].DateRanges  || arr[0].dateRanges  || []).slice(0, 5);
    } catch (e) { out.controllerParseError = e.message; out.controllerSnippet = rc.body.slice(0, 500); }

    // Get units list
    const gu = await httpReq(jar2, 'GET',
      `${RB_URL}?function=getunits&reporttype=27&reportsubtype=0&r=${rand()}`,
      { headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest', Referer: `${BASE}/ReportBuilder.aspx` } }
    );
    out.unitsLength = gu.body.length;
    try { const ud = JSON.parse(gu.body); out.unitsSample = (ud.Units || ud.units || ud || []).slice(0, 5); }
    catch (e) { out.unitsSnippet = gu.body.slice(0, 500); }

    // Load the saved favorite report and parse the rendered HTML table.
    out.reportId = WIN_SCORE_REPORT_ID;
    const raw = await fetchReportData(jar2);
    out.reportLength = raw.length;
    out.periodEnd = extractPeriodEnd(raw);
    const parsed = parseReportResponse(raw);
    out.storeRows = parsed.stores.length;
    out.storeSample = parsed.stores.slice(0, 5);
    out.aggregate = parsed.aggregate;
  } catch (e) { out.error = e.message; }

  return out;
}

module.exports = { processWinScore, parseReportResponse, debugWinScore };
