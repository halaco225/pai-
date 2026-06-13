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

async function fetchReportData(jar, startDate, endDate, quickDateValue, unitIds) {
  const xhrHdrs = {
    Accept: 'application/json, text/javascript, */*',
    'X-Requested-With': 'XMLHttpRequest',
    Referer: `${BASE}/ReportBuilder.aspx`,
    Origin:  BASE,
  };

  const postBody = formEncode({
    StartDate:                     startDate,
    EndDate:                       endDate,
    CustomQuickDateId:             '',
    CustomStartDate:               '',
    CustomEndDate:                 '',
    ReportLevel:                   LEVEL_STORE,
    Benchmarks:                    '',
    SurveyItems:                   WIN_SCORE_ITEM,
    Filters:                       '[]',
    CompareBy:                     '',
    BreakoutCompareType:           'undefined',
    MultiParentHierarchyLevelBy:   '0',
    ColumnWrap:                    'True',
    UnitCount:                     'false',
    DateType:                      'Survey',
    CCTypeList:                    '',
    HierarchyList:                 '',
    CompareToOtherDatesTimePeriod: '0',
    QuickDateValue:                quickDateValue,
    GroupByLevel:                  LEVEL_STORE,
    Units:                         unitIds,
    HierarchyStructureScoreType:   '',
    HierarchyStructureType:        '',
    LevelAlignment:                '',
  });

  // reporttype=0 is the comparison report data endpoint (browser DevTools confirmed)
  // reporttype=27 returns UI label translations — NOT score data
  const attempts = [
    { url: `${RB_URL}?function=getdata&reporttype=0&reportsubtype=0&disableunits=false&r=${rand()}`,  method: 'POST' },
    { url: `${RB_URL}?function=getdata&reporttype=27&reportsubtype=0&disableunits=false&r=${rand()}`, method: 'POST' },
    { url: `${RV_URL}?function=getdata&reporttype=0&reportsubtype=0&disableunits=false&r=${rand()}`,  method: 'POST' },
  ];

  for (const attempt of attempts) {
    console.log(`[WinScore] Trying ${attempt.method} ${attempt.url.split('?')[0].split('/').pop()} reporttype=${attempt.url.match(/reporttype=(\d+)/)?.[1]}`);
    const r = await httpReq(jar, attempt.method, attempt.url, { body: postBody, headers: xhrHdrs });
    console.log(`[WinScore] → HTTP ${r.status}, ${r.body.length} bytes, snippet: ${r.body.slice(0, 100)}`);
    // Reject error responses and UI-label responses (which have Title1 key, not score data)
    if (r.status === 200 && r.body.length > 30 && !r.body.includes('"Error"') && !r.body.includes('"Title1"')) {
      console.log('[WinScore] Report fetch succeeded');
      return r.body;
    }
  }

  // Return last response so the caller can log what we actually got
  const last = await httpReq(jar, 'POST', `${RB_URL}?function=getdata&reporttype=0&reportsubtype=0&r=${rand()}`, { body: postBody, headers: xhrHdrs });
  return last.body;
}

// ── Response parser ───────────────────────────────────────────────────────────

function parseStoreIdFromUnit(unit) {
  if (!unit) return null;
  const m  = String(unit).match(/1P(\d{6})\s*-\s*(\d{6})/);
  if (m) return m[2];
  const m2 = String(unit).match(/(\d{6})/);
  return m2 ? m2[1] : null;
}

function parseWinScore(val) {
  if (val == null || val === '') return null;
  const n = parseFloat(String(val).replace('%', '').trim());
  return isNaN(n) ? null : n;
}

function parseReportResponse(raw) {
  // Try JSON first
  let data = null;
  try { data = JSON.parse(raw); } catch (_) {}

  if (data) {
    const rows = Array.isArray(data) ? data
      : (data.rows || data.Rows || data.data || data.Data || []);
    if (rows.length > 0) {
      const results = [];
      for (const row of rows) {
        const unitRaw   = row.Unit || row.unit || row.Store || row.store || row.Name || row.name || '';
        const scoreRaw  = row['Win Score'] || row.WinScore || row.winScore || row.Score || row.score;
        const countRaw  = row.Count || row.count || row.Surveys || row.surveys || 0;
        const store_id  = parseStoreIdFromUnit(unitRaw);
        const win_score = parseWinScore(scoreRaw);
        if (!store_id || win_score == null) continue;
        results.push({ store_id, win_score, survey_count: parseInt(String(countRaw).replace(/\D/g, '')) || 0 });
      }
      if (results.length > 0) return results;
    }
  }

  // HTML table fallback
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

  let headerIdx = allRows.findIndex(r => r.some(c => /win score/i.test(c)));
  if (headerIdx < 0) headerIdx = 0;

  const headers   = allRows[headerIdx].map(h => h.toLowerCase());
  const storeCol  = headers.findIndex(h => /store|unit|name/i.test(h));
  const scoreCol  = headers.findIndex(h => /win score/i.test(h));
  const countCol  = headers.findIndex(h => /count|survey/i.test(h));

  const results = [];
  for (let i = headerIdx + 1; i < allRows.length; i++) {
    const row      = allRows[i];
    const unitRaw  = storeCol >= 0 ? row[storeCol] : row[0];
    if (!unitRaw || /combined|total/i.test(unitRaw)) continue;
    const store_id  = parseStoreIdFromUnit(unitRaw);
    const win_score = parseWinScore(scoreCol >= 0 ? row[scoreCol] : row[row.length - 1]);
    if (!store_id || win_score == null) continue;
    const survey_count = parseInt(String(countCol >= 0 ? row[countCol] : '0').replace(/\D/g, '')) || 0;
    results.push({ store_id, win_score, survey_count });
  }
  return results;
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

  let startDate, endDate, quickDateValue;
  try {
    ({ startDate, endDate, quickDateValue } = await getFiscalPeriod(jar));
  } catch (err) {
    console.error('[WinScore] getFiscalPeriod failed:', err.message);
    return { success: false, error: `getFiscalPeriod: ${err.message}` };
  }

  const unitIds = await getUnitIds();
  let raw;
  try {
    raw = await fetchReportData(jar, startDate, endDate, quickDateValue, unitIds);
  } catch (err) {
    console.error('[WinScore] fetchReportData failed:', err.message);
    return { success: false, error: `fetchReportData: ${err.message}` };
  }

  const scores = parseReportResponse(raw);
  console.log(`[WinScore] Parsed ${scores.length} store scores`);
  if (!scores.length) {
    console.warn('[WinScore] No scores parsed. Raw (first 2000 chars):\n' + raw.slice(0, 2000));
    return { success: false, error: 'No scores parsed from response' };
  }

  const pool = db.getPool();
  if (!pool) return { success: false, error: 'No DB pool' };

  const periodEnd = endDate;
  let written = 0;
  for (const s of scores) {
    await pool.query(`
      INSERT INTO smg_win_scores (store_id, period_end_date, win_score, survey_count, updated_at)
      VALUES ($1, $2, $3, $4, NOW())
      ON CONFLICT (store_id, period_end_date)
      DO UPDATE SET win_score=$3, survey_count=$4, updated_at=NOW()
    `, [s.store_id, periodEnd, s.win_score, s.survey_count]);
    written++;
  }

  console.log(`[WinScore] ${written} scores written (period end: ${periodEnd})`);
  return { success: true, storesProcessed: scores.length, scoresWritten: written, periodEnd };
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

    // Try actual report fetch using ReportViewer.ashx POST
    const fp = await getFiscalPeriod(jar2);
    out.fiscalPeriod = fp;
    const unitIds = await getUnitIds();
    out.unitIdsSample = unitIds.split(';').slice(0, 5);
    const raw = await fetchReportData(jar2, fp.startDate, fp.endDate, fp.quickDateValue, unitIds);
    out.reportLength = raw.length;
    out.reportSnippet = raw.slice(0, 2000);
    out.parsedScores = parseReportResponse(raw).length;
    try { const d = JSON.parse(raw); out.reportTopKeys = Object.keys(Array.isArray(d) ? d[0] : d).slice(0, 20); } catch (_) {}
  } catch (e) { out.error = e.message; }

  return out;
}

module.exports = { processWinScore, parseReportResponse, debugWinScore };
