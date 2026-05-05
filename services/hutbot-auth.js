'use strict';
/**
 * hutbot-auth.js
 * SP-initiated OAuth2 + SAML SSO flow for the Byte Coach Admin API.
 *
 * Flow:
 *   1. GET admin.superapp.yum.com/login  → 307 → Cognito OAuth2 authorize
 *      (admin app generates PKCE verifier, stores in its session cookie)
 *   2. Cognito OAuth2 authorize → 302 → Ping Identity with SAMLRequest
 *   3. Load Ping Identity login page
 *   4. Submit credentials (single-step or two-step)
 *   5. Ping returns auto-submit form → POST SAMLResponse to Cognito ACS
 *   6. Cognito ACS → 302 → admin.superapp.yum.com/auth?code=...
 *   7. GET /auth?code=... with admin session cookie → app exchanges code+verifier → session cookies
 *   8. Cache in DB; reuse until 401/403
 *
 * Env vars:
 *   HUTBOT_USER     — Yum network username (e.g. Hgl2743)
 *   HUTBOT_PASSWORD — Yum network password
 */
const db        = require('./db');
const nodeFetch = require('node-fetch');

const ADMIN_BASE      = 'https://admin.superapp.yum.com';
const ADMIN_LOGIN_URL = 'https://admin.superapp.yum.com/login?redirectTo=%2Fmapp%2Fauthorize';
const COGNITO_ACS_URL = 'https://auth.superapp.yum.com/saml2/idpresponse';
const API_BASE        = 'https://api.superapp.yum.com';
const PING_BASE       = 'https://portalsso.yum.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function fetch(...args) { return nodeFetch(...args); }

// ── Cookie helpers ────────────────────────────────────────────────────────────
function parseCookies(response) {
  const raw = (response.headers.raw ? response.headers.raw()['set-cookie'] : null)
    || (response.headers.getSetCookie ? response.headers.getSetCookie() : []);
  return (raw || []).map(c => c.split(';')[0]);
}
function mergeCookies(...items) {
  const all = items.flatMap(x => (Array.isArray(x) ? x : x ? x.split('; ') : []));
  const map = new Map();
  all.forEach(c => { const eq = c.indexOf('='); if (eq > 0) map.set(c.slice(0, eq), c); });
  return Array.from(map.values()).join('; ');
}

// ── HTML parsing helpers ──────────────────────────────────────────────────────
function extractFormAction(html, defaultUrl) {
  const m = html.match(/<form[^>]+action=["']([^"']+)["']/i);
  return m ? m[1] : defaultUrl;
}
function extractHiddenFields(html) {
  const fields = {};
  const re = /<input[^>]+type=["']?hidden["']?[^>]*>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const nameM  = m[0].match(/name=["']([^"']+)["']/i);
    const valueM = m[0].match(/value=["']([^"']*?)["']/i);
    if (nameM) fields[nameM[1]] = valueM ? valueM[1] : '';
  }
  return fields;
}
function encodeForm(fields) {
  return Object.entries(fields).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

// ── SP-initiated login flow ───────────────────────────────────────────────────
async function login() {
  const user = process.env.HUTBOT_USER     || '';
  const pass = process.env.HUTBOT_PASSWORD || '';
  if (!user || !pass) throw new Error('HUTBOT_USER / HUTBOT_PASSWORD env vars not set');

  console.log('[HutBotAuth] Starting SP-initiated OAuth2/SAML login for', user);

  // ── Step 1: GET admin /login — app generates PKCE verifier in its session ──
  // We follow 307 hops manually to collect admin session cookies at each hop,
  // then stop once we reach Cognito (external domain) to grab the real OAuth2 URL.
  console.log('[HutBotAuth] Step 1: GET admin login to start OAuth2 flow');
  let adminCookies = [];
  let cognitoUrl   = null;
  let url = ADMIN_LOGIN_URL;

  for (let hop = 0; hop < 6; hop++) {
    const r = await fetch(url, {
      redirect: 'manual',
      headers: { 'User-Agent': UA, Cookie: mergeCookies(adminCookies) },
    });
    const newCookies = parseCookies(r);
    if (newCookies.length) adminCookies = [...adminCookies, ...newCookies];
    const loc = r.headers.get('location');
    console.log(`[HutBotAuth] Hop ${hop + 1}: ${r.status} ${url.slice(0, 80)} → ${(loc || 'none').slice(0, 80)}`);

    if (!loc || r.status < 300 || r.status >= 400) break;

    const absLoc = loc.startsWith('http') ? loc : `${ADMIN_BASE}${loc}`;

    // Once we leave the admin domain we've hit Cognito
    if (!absLoc.includes('admin.superapp.yum.com')) {
      cognitoUrl = absLoc;
      break;
    }
    url = absLoc;
  }

  if (!cognitoUrl) throw new Error('Admin /login did not redirect to Cognito OAuth2');
  console.log(`[HutBotAuth] Cognito URL: ${cognitoUrl.slice(0, 120)}, adminCookies: ${adminCookies.length}`);

  // ── Step 2: Follow Cognito OAuth2 → Ping Identity ────────────────────────
  console.log('[HutBotAuth] Step 2: following Cognito OAuth2 authorize');
  const r1 = await fetch(cognitoUrl, { redirect: 'manual', headers: { 'User-Agent': UA } });
  const cognitoCookies = parseCookies(r1);
  let pingUrl = r1.headers.get('location');
  console.log(`[HutBotAuth] Cognito → ${(pingUrl || 'none').slice(0, 100)}, cognitoCookies: ${cognitoCookies.length}`);
  if (!pingUrl) throw new Error(`Cognito OAuth2 did not redirect (status ${r1.status})`);

  // ── Step 3: Load Ping Identity login page ────────────────────────────────
  console.log('[HutBotAuth] Step 3: loading Ping Identity login page');
  const r2 = await fetch(pingUrl.startsWith('http') ? pingUrl : `${PING_BASE}${pingUrl}`, {
    headers: { 'User-Agent': UA },
  });
  const pingCookies = parseCookies(r2);
  const html1 = await r2.text();
  console.log(`[HutBotAuth] Ping login page (${html1.length} bytes), cookies: ${pingCookies.length}`);

  const action1       = extractFormAction(html1, pingUrl);
  const hidden1       = extractHiddenFields(html1);
  const usernameField = html1.match(/name=["'](pf\.username|username|USER|j_username)["']/i)?.[1] || 'pf.username';
  const allPingCookies = mergeCookies(cognitoCookies, pingCookies);

  // ── Single-step: username + password on same page ─────────────────────────
  const passFieldOnPage1 = html1.match(/name=["'](pf\.pass|password|PASS|j_password|currentPassword)["']/i)?.[1];
  if (passFieldOnPage1) {
    console.log(`[HutBotAuth] Single-step form — submitting username+password (field: ${passFieldOnPage1})`);
    const postUrl1 = action1.startsWith('http') ? action1 : `${PING_BASE}${action1}`;
    const r3 = await fetch(postUrl1, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: allPingCookies, 'User-Agent': UA, Referer: pingUrl },
      body: encodeForm({ ...hidden1, [usernameField]: user, [passFieldOnPage1]: pass }),
    });
    const c3 = parseCookies(r3);
    console.log(`[HutBotAuth] Single-step POST → ${r3.status}`);
    return await _finishAfterCredentials(r3, c3, mergeCookies(allPingCookies, c3), postUrl1, adminCookies);
  }

  // ── Two-step: username first ──────────────────────────────────────────────
  const postUrl1 = action1.startsWith('http') ? action1 : `${PING_BASE}${action1}`;
  console.log(`[HutBotAuth] Step 4: posting username to ${postUrl1}`);
  const r3 = await fetch(postUrl1, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: allPingCookies, 'User-Agent': UA, Referer: pingUrl },
    body: encodeForm({ ...hidden1, [usernameField]: user }),
  });
  const c3 = parseCookies(r3);
  console.log(`[HutBotAuth] Username POST → ${r3.status}, loc: ${r3.headers.get('location') || 'none'}`);
  let allPingCookies2 = mergeCookies(allPingCookies, c3);

  let html2 = '';
  if (r3.status === 302 || r3.status === 301) {
    const loc = r3.headers.get('location');
    const rb = await fetch(loc.startsWith('http') ? loc : `${PING_BASE}${loc}`, {
      headers: { 'User-Agent': UA, Cookie: allPingCookies2 },
    });
    parseCookies(rb).forEach(c => c3.push(c));
    html2 = await rb.text();
    allPingCookies2 = mergeCookies(allPingCookies2, c3);
  } else {
    html2 = await r3.text();
  }

  const passField = html2.match(/name=["'](pf\.pass|password|PASS|j_password|currentPassword)["']/i)?.[1] || 'pf.pass';
  const action2   = extractFormAction(html2, postUrl1);
  const hidden2   = extractHiddenFields(html2);
  const postUrl2  = action2.startsWith('http') ? action2 : `${PING_BASE}${action2}`;

  console.log(`[HutBotAuth] Step 5: posting password to ${postUrl2} (field: ${passField})`);
  const r4 = await fetch(postUrl2, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: allPingCookies2, 'User-Agent': UA, Referer: postUrl1 },
    body: encodeForm({ ...hidden2, [passField]: pass }),
  });
  const c4 = parseCookies(r4);
  console.log(`[HutBotAuth] Password POST → ${r4.status}, loc: ${r4.headers.get('location') || 'none'}`);
  let allPingCookies3 = mergeCookies(allPingCookies2, c4);

  let html3 = '';
  if (r4.status === 302 || r4.status === 301) {
    const loc = r4.headers.get('location');
    const rb = await fetch(loc.startsWith('http') ? loc : `${PING_BASE}${loc}`, {
      headers: { 'User-Agent': UA, Cookie: allPingCookies3 },
    });
    parseCookies(rb).forEach(c => c4.push(c));
    html3 = await rb.text();
    allPingCookies3 = mergeCookies(allPingCookies3, c4);
  } else {
    html3 = await r4.text();
  }

  return await _extractAndPostSAML(html3, allPingCookies3, adminCookies);
}

// ── Extract SAMLResponse and complete the Cognito auth leg ───────────────────
async function _extractAndPostSAML(html, allCookiesSoFar, adminCookies) {
  const samlMatch = html.match(/name=["']SAMLResponse["'][^>]*value=["']([^"']+)["']/i)
    || html.match(/value=["']([^"']{100,})["'][^>]*name=["']SAMLResponse["']/i);
  if (!samlMatch) {
    console.error('[HutBotAuth] SAMLResponse not found. Page snippet:', html.slice(0, 2000));
    throw new Error('SAMLResponse not found — login may have failed or MFA required');
  }
  const samlResponse = samlMatch[1];
  const relayState   = (html.match(/name=["']RelayState["'][^>]*value=["']([^"']*?)["']/i) || [])[1] || '';
  const acsUrl       = extractFormAction(html, COGNITO_ACS_URL);
  const acsBase      = acsUrl.startsWith('http') ? new URL(acsUrl).origin : 'https://auth.superapp.yum.com';
  console.log(`[HutBotAuth] SAMLResponse (${samlResponse.length} chars), ACS: ${acsUrl}`);

  const r5 = await fetch(acsUrl.startsWith('http') ? acsUrl : `${acsBase}${acsUrl}`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: allCookiesSoFar, 'User-Agent': UA },
    body: encodeForm({ SAMLResponse: samlResponse, RelayState: relayState }),
  });
  const c5 = parseCookies(r5);
  console.log(`[HutBotAuth] Cognito ACS → ${r5.status}, loc: ${r5.headers.get('location') || 'none'}, cookies: ${c5.length}`);
  if (r5.status >= 400) {
    const body5 = await r5.text();
    console.error(`[HutBotAuth] ACS error: ${body5.slice(0, 500)}`);
    throw new Error(`Cognito ACS returned ${r5.status}: ${body5.slice(0, 200)}`);
  }

  // Follow redirects back to admin app — pass BOTH Cognito cookies AND admin session cookies
  // so the admin /auth endpoint can find the stored PKCE verifier and exchange the code.
  let finalCookies = mergeCookies(allCookiesSoFar, c5, adminCookies);
  let nextUrl = r5.headers.get('location');
  let hops = 0;

  while (nextUrl && hops < 10) {
    hops++;
    const absUrl = nextUrl.startsWith('http') ? nextUrl : `${acsBase}${nextUrl}`;
    console.log(`[HutBotAuth] Hop ${hops}: ${absUrl.slice(0, 120)}`);
    const rN = await fetch(absUrl, {
      redirect: 'manual',
      headers: { 'User-Agent': UA, Cookie: finalCookies },
    });
    const nc = parseCookies(rN);
    if (nc.length) finalCookies = mergeCookies(finalCookies, nc);
    nextUrl = rN.headers.get('location');
    if (!nextUrl) break;
  }

  if (!finalCookies) throw new Error('No session cookies after login');
  console.log('[HutBotAuth] Login complete — session obtained');
  return finalCookies;
}

// ── Follow post-credentials redirect to SAML page ───────────────────────────
async function _finishAfterCredentials(r, cookies, allCookies, referer, adminCookies) {
  let html = '';
  if (r.status === 302 || r.status === 301) {
    const loc = r.headers.get('location');
    console.log(`[HutBotAuth] Post-creds redirect: ${loc}`);
    const rb = await fetch(loc.startsWith('http') ? loc : `${PING_BASE}${loc}`, {
      headers: { 'User-Agent': UA, Cookie: allCookies },
    });
    parseCookies(rb).forEach(c => cookies.push(c));
    html = await rb.text();
  } else {
    html = await r.text();
  }
  console.log(`[HutBotAuth] Post-creds page (${html.length} bytes), title: ${(html.match(/<title>([^<]*)<\/title>/i)||[])[1]||'?'}`);
  return await _extractAndPostSAML(html, mergeCookies(allCookies, cookies), adminCookies);
}

// ── Public: get valid cookie (from DB cache or fresh login) ──────────────────
async function getOrRefreshCookie() {
  const auth = await db.getHutBotAuth();
  if (auth && auth.is_valid && auth.cookie_value) {
    console.log('[HutBotAuth] Using cached session cookie');
    return auth.cookie_value;
  }
  console.log('[HutBotAuth] No valid session — logging in');
  const cookie = await login();
  await db.setHutBotAuth(cookie, 'auto');
  return cookie;
}

// ── Verify the cookie works against the API ───────────────────────────────────
async function verifyCookie(cookieStr) {
  const r = await fetch(`${API_BASE}/admin-proxy/checklists/search?offset=0&pageSize=1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Cookie: cookieStr, 'User-Agent': UA },
    body: JSON.stringify({ statuses: ['missed'] }),
  });
  return r.status !== 401 && r.status !== 403;
}

module.exports = { getOrRefreshCookie, verifyCookie, login };
