'use strict';
/**
 * SMG comment export — pure HTTP, OAuth2 implicit flow.
 *
 * Auth flow:
 *   1. GET reporting.smg.com/Index.aspx → scrape hidden fields
 *   2. POST credentials → receive .ASPXAUTH cookie (Domain=.smg.com)
 *   3. OAuth2 implicit flow: GET auth.smg.com/connect/authorize (sends .ASPXAUTH)
 *      → redirects through reporting.smg.com back to 360.smg.com#access_token=xxx
 *   4. Parse Bearer token from final redirect URL fragment
 *   5. POST 360.smg.com/api/export/v2/commentreport with Authorization: Bearer <token>
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

// Single-step HTTP request — does NOT follow redirects, stores cookies, returns status + location + body
function httpReqStep(jar, method, reqUrl, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed  = new url.URL(reqUrl);
    const domain  = parsed.hostname;
    const cookies = jar ? jar.get(domain) : '';
    const isHttps = parsed.protocol === 'https:';
    const lib     = isHttps ? https : http;

    const headers = {
      'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept':          'text/html,application/xhtml+xml,*/*;q=0.9',
      'Accept-Language': 'en-US,en;q=0.9',
      ...(cookies ? { Cookie: cookies } : {}),
      ...opts.headers,
    };

    const body = opts.body || null;
    if (body) {
      headers['Content-Type']   = opts.headers?.['Content-Type'] || 'application/x-www-form-urlencoded';
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
      const chunks = [];
      res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => resolve({
        status:   res.statusCode,
        location: res.headers.location || null,
        body:     Buffer.concat(chunks).toString('utf8'),
      }));
    });

    const timer = setTimeout(() => req.destroy(new Error('SMG auth timeout 30s')), 30000);
    req.on('error', (e) => { clearTimeout(timer); reject(e); });
    req.on('close', () => clearTimeout(timer));
    if (body) req.write(body);
    req.end();
  });
}

function extractTokenFromUrl(loc) {
  const fragment = loc.includes('#') ? loc.split('#')[1] : '';
  const query    = loc.includes('?') ? loc.split('?')[1].split('#')[0] : '';
  for (const part of [fragment, query]) {
    if (!part || !part.includes('access_token=')) continue;
    const params = {};
    for (const p of part.split('&')) {
      const eq = p.indexOf('=');
      if (eq > 0) params[p.slice(0, eq)] = decodeURIComponent(p.slice(eq + 1));
    }
    if (params.access_token) return params.access_token;
  }
  return null;
}

// OAuth2 implicit flow with interactive login:
// Follows the full OIDC redirect chain, detects auth.smg.com login form,
// posts credentials, then captures the access_token from the redirect fragment.
async function getBearer(jar, user, pass) {
  const AUTH_BASE = 'https://auth.smg.com';
  const CLIENT_ID = 'smg360';
  const SCOPE     = 'feedback openid email smg360 offline_access';

  // Try redirect URIs in order — first match registered in auth.smg.com wins
  const REDIRECT_URIS = [
    'https://360.smg.com/auth-callback',
    'https://360.smg.com/',
    'https://360.smg.com',
  ];

  let lastErr = 'unknown';
  for (const REDIRECT_URI of REDIRECT_URIS) {
    const nonce = Math.random().toString(36).slice(2);
    const state = Math.random().toString(36).slice(2);
    const authorizeUrl = `${AUTH_BASE}/connect/authorize?` + [
      'response_type=token%20id_token',
      `client_id=${encodeURIComponent(CLIENT_ID)}`,
      `scope=${encodeURIComponent(SCOPE)}`,
      `redirect_uri=${encodeURIComponent(REDIRECT_URI)}`,
      `nonce=${nonce}`,
      `state=${state}`,
    ].join('&');

    console.log(`[SMG] OAuth trying redirect_uri=${REDIRECT_URI}`);
    try {
      const token = await _followOAuthFlow(jar, authorizeUrl, user, pass);
      if (token) return token;
    } catch (e) {
      console.log(`[SMG] OAuth redirect_uri=${REDIRECT_URI} failed: ${e.message}`);
      lastErr = e.message;
    }
  }
  throw new Error(`OAuth2 failed for all redirect URIs — last error: ${lastErr}. Cannot get Bearer token.`);
}

// Extract access_token from a 200 response body.
// IdentityServer often delivers tokens via a self-submitting hidden form (form_post),
// a JSON body, or a JS variable assignment rather than a URL fragment.
function extractTokenFromBody(body) {
  if (!body) return null;
  // Hidden form field: <input type="hidden" name="access_token" value="...">
  const formMatch = body.match(/<input[^>]+name=["']?access_token["']?[^>]+value=["']([^"']+)["']/i)
                 || body.match(/<input[^>]+value=["']([^"']+)["'][^>]+name=["']?access_token["']?/i);
  if (formMatch) return formMatch[1];
  // JSON body: {"access_token":"..."}
  try {
    const json = JSON.parse(body);
    if (json.access_token) return json.access_token;
  } catch (_) {}
  // JS variable: access_token = "..." or access_token:"..."
  const jsMatch = body.match(/access_token['":\s=]+["']([A-Za-z0-9._\-]+)["']/);
  if (jsMatch) return jsMatch[1];
  return null;
}

async function _followOAuthFlow(jar, startUrl, user, pass) {
  let cur = startUrl;
  let credPosted = false;

  for (let i = 0; i < 15; i++) {
    const r = await httpReqStep(jar, 'GET', cur);
    const shortUrl = cur.replace(/[#?].*/, '').slice(0, 80);
    console.log(`[SMG] OAuth step ${i+1}: HTTP ${r.status} url=${shortUrl} loc=${r.location ? r.location.slice(0, 80) : '—'}`);

    // Token in redirect Location header (standard implicit flow fragment)
    if (r.location) {
      const loc = new url.URL(r.location, cur).href;
      const token = extractTokenFromUrl(loc);
      if (token) { console.log('[SMG] Bearer token obtained from redirect fragment'); return token; }
      if (r.status >= 400) throw new Error(`HTTP ${r.status} at ${shortUrl}`);
      cur = loc;
      continue;
    }

    // 200 response — could be login form, form_post token delivery, or error page
    if (r.status === 200) {
      // Always check for token in body first (form_post / JS delivery)
      const bodyToken = extractTokenFromBody(r.body);
      if (bodyToken) { console.log('[SMG] Bearer token obtained from response body (form_post)'); return bodyToken; }

      // auth.smg.com login form — post credentials
      if (!credPosted && cur.includes('auth.smg.com')) {
        const hasPassField = /name=["']?password["']?/i.test(r.body) || r.body.includes('txtPassword');
        const hasUserField = /name=["']?(username|email|txtUser)/i.test(r.body);
        if (hasPassField && hasUserField) {
          console.log('[SMG] OAuth: auth.smg.com login form detected — posting credentials');
          const rvt      = extractHidden(r.body, '__RequestVerificationToken') || '';
          const signinId = new url.URL(cur).searchParams.get('signin') || extractHidden(r.body, 'signin') || '';
          const userField = /name=["']?email["']?/i.test(r.body) ? 'email' : 'username';
          const fields = {
            [userField]: user,
            password:    pass,
            ...(rvt      ? { __RequestVerificationToken: rvt } : {}),
            ...(signinId ? { signin: signinId } : {}),
          };
          console.log('[SMG] Auth form fields:', Object.keys(fields).join(', '));
          const post = await httpReqStep(jar, 'POST', cur, {
            body: formEncode(fields),
            headers: { Referer: cur, Origin: 'https://auth.smg.com' },
          });
          credPosted = true;
          console.log(`[SMG] OAuth login POST: HTTP ${post.status} loc=${post.location ? post.location.slice(0, 80) : '—'}`);
          // Check body of POST response for token (some servers respond with form_post directly)
          const postBodyToken = extractTokenFromBody(post.body);
          if (postBodyToken) { console.log('[SMG] Bearer token obtained from POST response body'); return postBodyToken; }
          if (post.location) {
            const loc   = new url.URL(post.location, cur).href;
            const token = extractTokenFromUrl(loc);
            if (token) { console.log('[SMG] Bearer token obtained from POST redirect'); return token; }
            cur = loc;
            continue;
          }
          if (post.body && (post.body.includes('Invalid') || post.body.includes('incorrect') || post.body.includes('txtPassword'))) {
            throw new Error('auth.smg.com rejected credentials — check SMG_USER/SMG_PASSWORD');
          }
          throw new Error('Credentials posted but received no redirect and no token in body');
        }
        // auth.smg.com 200 but no login form — log body snippet for diagnosis
        const snippet = r.body.slice(0, 300).replace(/\s+/g, ' ');
        console.log(`[SMG] OAuth: auth.smg.com 200 with no login form — body: ${snippet}`);
        throw new Error(`auth.smg.com returned 200 without login form (redirect_uri may be unregistered)`);
      }

      // 200 at a non-auth.smg.com URL (e.g. reporting.smg.com/signin-oidc after creds posted)
      // Log body snippet so we can diagnose what the server returned
      const snippet = r.body.slice(0, 300).replace(/\s+/g, ' ');
      console.log(`[SMG] OAuth: 200 at ${shortUrl} — body: ${snippet}`);
      throw new Error(`Unexpected 200 at ${shortUrl} — no token in body. Check logs for body snippet.`);
    }

    if (r.status >= 400) throw new Error(`HTTP ${r.status} at ${shortUrl}`);
  }
  throw new Error('OAuth: access_token not found after 15 steps');
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

  // OAuth2 implicit flow — throws if all redirect URIs fail
  const bearer = await getBearer(jar, user, pass);
  return bearer;
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

async function exportComments(jar, bearer, targetDate) {
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
  console.log(`[SMG] Export POST — bearer=${bearer ? 'yes' : 'no (cookie-only)'}`);
  const resp = await httpReq(jar, 'POST', EXPORT_URL, {
    body,
    binary: true,
    headers: {
      'AccountId':        ACCOUNT_ID,
      'Content-Type':     'application/json',
      'accept':           'application/xlsx',
      'SMG-LanguageIso':  'en-US',
      'TimeZone':         'America/New_York',
      'Origin':           BASE_360,
      'Referer':          `${BASE_360}/`,
      'X-Requested-With': 'XMLHttpRequest',
      ...(bearer ? { 'Authorization': `Bearer ${bearer}` } : {}),
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

  let bearer;
  try {
    bearer = await login(jar, user, pass);
    // bearer may be null — will attempt cookie-only export
  } catch (err) {
    console.error('[SMG] Login failed:', err.message);
    return { success: false, error: `Login: ${err.message}` };
  }

  let xlsxBuffer;
  try {
    xlsxBuffer = await exportComments(jar, bearer, targetDate);
  } catch (err) {
    console.error('[SMG] Export failed:', err.message);
    return { success: false, error: `Export: ${err.message}` };
  }

  fs.writeFileSync(outPath, xlsxBuffer);
  console.log(`[SMG] Saved → ${outPath} (${xlsxBuffer.length} bytes)`);
  return { success: true, filePath: outPath };
}

module.exports = { downloadSMGComments };
