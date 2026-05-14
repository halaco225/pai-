'use strict';
/**
 * SMG comment export — pure HTTP, cookie-based auth.
 *
 * Auth: reporting.smg.com/Index.aspx ASP.NET Forms login.
 * The .ASPXAUTH cookie is scoped to *.smg.com, so it authenticates
 * both reporting.smg.com and 360.smg.com API calls without any OAuth.
 *
 * Export flow:
 *   1. GET reporting.smg.com/Index.aspx → scrape hidden fields
 *   2. POST credentials → receive .ASPXAUTH cookie
 *   3. GET 360.smg.com with those cookies → establish 360 session
 *   4. POST 360.smg.com/api/export/v2/commentreport → xlsx binary
 */
const https = require('https');
const http  = require('http');
const url   = require('url');
const fs    = require('fs');
const path  = require('path');

const LOGIN_URL   = 'https://reporting.smg.com/Index.aspx';
const BASE_360    = 'https://360.smg.com';
const EXPORT_URL  = `${BASE_360}/api/export/v2/commentreport`;
const ACCOUNT_ID  = '5b6205b27485e95d90e0a366';
const REPORT_ID   = '5b621d617485e95d90e0a36f';
const CARD_ID     = '5b621d617485e95d90e0a370';

// Survey sources included in the filter (from captured network request)
const FILTER_SOURCES = [
  '6684c1735040640c94fe34da',
  '5b522bf87485e96d80b2dfaf',
  '60ada0b4de7df021c003f620',
  '65807135e6485f00fc5c9fb4',
];

// All source IDs for sourceOffsets (pagination reset)
const ALL_SOURCES = [
  '5b73cc62f820781a3c28152c', '6684c1735040640c94fe34da',
  '644a8e03de7dee17c04fe327', '5b522bf87485e96d80b2dfaf',
  '661d4b6df820780f14f6fcf1', '65a0028a504064228089de85',
  '60ada0b4de7df021c003f620', '642dca8350406420fc9bb262',
  '6983e2725040640e14f8ebcf', '65807135e6485f00fc5c9fb4',
  '5d42044ef8207820d81c1169', '64ec730ce6485f17e494aa4d',
  '61e7494350406421a4ea9608', '5ed7b8d6f820782450e5d26f',
  '5b522969f8207835f04a3106', '5ad79fc0f82078451850a66b',
  '63f39d717485e921f0f4a405', '5f2ca93d7485e90bec6c7bda',
];

// ── HTTP / cookie helpers ─────────────────────────────────────────────────────

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
        // Honour Domain attribute so .smg.com cookies reach all subdomains
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
      // Walk parent domains: reporting.smg.com → .smg.com → .com
      const parts = domain.split('.');
      for (let i = 1; i < parts.length; i++) {
        const jar = store.get('.' + parts.slice(i).join('.'));
        if (jar) for (const [k, v] of jar) result.set(k, v);
      }
      const jar = store.get(domain);
      if (jar) for (const [k, v] of jar) result.set(k, v);
      return [...result.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    },
    dump() {
      const out = {};
      for (const [d, m] of store) out[d] = Object.fromEntries(m);
      return out;
    },
  };
}

function httpReq(jar, method, reqUrl, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed  = new url.URL(reqUrl);
    const domain  = parsed.hostname;
    const cookies = jar ? jar.get(domain) : '';
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
      if (setCookies && jar) jar.set(domain, setCookies);

      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const next = new url.URL(res.headers.location, reqUrl).href;
        res.resume();
        return resolve(httpReq(jar, 'GET', next, opts.followRedirectOpts || {}));
      }

      const chunks = [];
      res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => {
        resolve({
          status:  res.statusCode,
          headers: res.headers,
          body:    opts.binary ? Buffer.concat(chunks) : Buffer.concat(chunks).toString('utf8'),
        });
      });
    });

    const timer = setTimeout(() => req.destroy(new Error('SMG request timeout 60s')), 60000);
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.on('close', () => clearTimeout(timer));
    if (body) req.write(body);
    req.end();
  });
}

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

// ── Auth: login via reporting.smg.com ─────────────────────────────────────────

async function login(jar, user, pass) {
  console.log('[SMG] GET reporting.smg.com login page');
  const r1 = await httpReq(jar, 'GET', LOGIN_URL, {});
  if (r1.status !== 200) throw new Error(`Login page HTTP ${r1.status}`);

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

  console.log('[SMG] POST credentials to reporting.smg.com');
  const r2 = await httpReq(jar, 'POST', LOGIN_URL, {
    body: formEncode(fields),
    headers: { Referer: LOGIN_URL, Origin: 'https://reporting.smg.com' },
  });

  if (r2.status === 200 && r2.body.includes('txtPassword')) {
    throw new Error('Login failed — check SMG_USER / SMG_PASSWORD');
  }
  console.log('[SMG] Login OK at reporting.smg.com');

  // Establish 360.smg.com session with the same cookies (domain-wide .smg.com)
  console.log('[SMG] GET 360.smg.com to establish 360 session');
  await httpReq(jar, 'GET', BASE_360, {
    headers: { Accept: 'text/html', Referer: 'https://reporting.smg.com/' },
  });
  console.log('[SMG] 360.smg.com session ready');
  console.log('[SMG] Cookie jar after 360 session:', JSON.stringify(jar.dump()));
}

// ── Build date range (30-day window ending at targetDate) ─────────────────────

function buildDateRange(targetDate) {
  const endMs   = new Date(targetDate + 'T05:00:00.000Z').getTime() + 86400000;
  const startMs = endMs - 30 * 86400000;
  const bmEndMs = startMs - 1;
  const bmStartMs = bmEndMs - 30 * 86400000 + 1;
  return {
    startDate:          new Date(startMs).toISOString(),
    endDate:            new Date(endMs - 1).toISOString(),
    benchmarkStartDate: new Date(bmStartMs).toISOString(),
    benchmarkEndDate:   new Date(bmEndMs).toISOString(),
    appliedByUser:      false,
  };
}

// ── Export comments ───────────────────────────────────────────────────────────

async function exportComments(jar, targetDate) {
  const dateRange = buildDateRange(targetDate);
  console.log(`[SMG] Exporting comments ${dateRange.startDate} → ${dateRange.endDate}`);

  const payload = {
    reportId:              REPORT_ID,
    cardId:                CARD_ID,
    sortBy:                1,
    sourceOffsets:         ALL_SOURCES.map(sourceId => ({ sourceId, offset: 0 })),
    showCommentTranslation: false,
    includeSubcategories:  true,
    text:                  '',
    topics:                [],
    filter: {
      sources:   FILTER_SOURCES,
      dateFilter: {
        dateRange,
        dateType:        0,
        reportGenerated: null,
      },
      hierarchy:         {},
      socialSites:       [],
      attributeMeasures: [],
      openEnds:          [],
      searchTerms:       null,
      aggregationPeriod: null,
      ontologyGroups:    [],
    },
    exportFileType:   1,
    baseFileName:     'Comments_ByComment',
    timeZone:         'America/New_York',
    separateComments: true,
  };

  const body = JSON.stringify(payload);
  const resp = await httpReq(jar, 'POST', EXPORT_URL, {
    body,
    binary: true,
    headers: {
      'AccountId':       ACCOUNT_ID,
      'Content-Type':    'application/json',
      'accept':          'application/xlsx',
      'SMG-LanguageIso': 'en-US',
      'TimeZone':        'America/New_York',
      'Origin':          BASE_360,
      'Referer':         `${BASE_360}/`,
      'X-Requested-With': 'XMLHttpRequest',
    },
  });

  console.log(`[SMG] Export HTTP ${resp.status}, ${resp.body?.length ?? 0} bytes`);

  if (resp.status !== 200) {
    const preview = Buffer.isBuffer(resp.body) ? resp.body.toString('utf8').slice(0, 300) : String(resp.body).slice(0, 300);
    throw new Error(`SMG export failed: HTTP ${resp.status} — ${preview}`);
  }

  const buf = Buffer.isBuffer(resp.body) ? resp.body : Buffer.from(resp.body);
  if (buf[0] !== 0x50 || buf[1] !== 0x4b) {
    throw new Error(`SMG export returned non-xlsx data: ${buf.toString('utf8').slice(0, 200)}`);
  }

  return buf;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function downloadSMGComments(targetDate) {
  const user = process.env.SMG_USER     || '';
  const pass = process.env.SMG_PASSWORD || '';
  if (!user || !pass) {
    return { success: false, error: 'SMG_USER / SMG_PASSWORD env vars not set' };
  }

  const tmpDir  = '/tmp/uploads';
  fs.mkdirSync(tmpDir, { recursive: true });
  const outPath = path.join(tmpDir, `intel-smg-${targetDate}.xlsx`);

  const jar = makeCookieJar();

  try {
    await login(jar, user, pass);
  } catch (err) {
    console.error('[SMG] Login failed:', err.message);
    return { success: false, error: `Login: ${err.message}` };
  }

  let xlsxBuffer;
  try {
    xlsxBuffer = await exportComments(jar, targetDate);
  } catch (err) {
    console.error('[SMG] Export failed:', err.message);
    return { success: false, error: `Export: ${err.message}` };
  }

  fs.writeFileSync(outPath, xlsxBuffer);
  console.log(`[SMG] Saved → ${outPath} (${xlsxBuffer.length} bytes)`);
  return { success: true, filePath: outPath };
}

module.exports = { downloadSMGComments };
