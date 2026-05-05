'use strict';
/**
 * hutbot-auth.js
 * SP-initiated OAuth2 + SAML SSO flow for the Byte Coach Admin API.
 *
 * Flow:
 *   1. GET Cognito OAuth2 authorize → 302 to Ping Identity with real SAMLRequest
 *   2. Submit credentials to Ping Identity (single-step or two-step)
 *   3. Ping Identity returns auto-submit form → action = auth.superapp.yum.com/saml2/idpresponse
 *   4. POST SAMLResponse (+ Cognito cookies) to Cognito ACS
 *   5. Follow redirects through admin.superapp.yum.com until session cookies obtained
 *   6. Cache in DB; reuse until 401/403
 *
 * Env vars:
 *   HUTBOT_USER     — Yum network username (e.g. Hgl2743)
 *   HUTBOT_PASSWORD — Yum network password
 */
const db        = require('./db');
const nodeFetch = require('node-fetch');

const COGNITO_OAUTH2_BASE = 'https://auth.superapp.yum.com/oauth2/authorize';
const CLIENT_ID           = '1af5fq82f1908ncch';
const REDIRECT_URI        = 'https://admin.superapp.yum.com/auth';
const COGNITO_ACS_URL     = 'https://auth.superapp.yum.com/saml2/idpresponse';
const API_BASE            = 'https://api.superapp.yum.com';
const PING_BASE           = 'https://portalsso.yum.com';
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

  // ── Step 1: Cognito OAuth2 authorize → redirect to Ping Identity ──────────
  const oauth2Url = `${COGNITO_OAUTH2_BASE}?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code`;
  console.log('[HutBotAuth] Step 1: Cognito OAuth2 authorize');
  const r0 = await fetch(oauth2Url, { redirect: 'manual', headers: { 'User-Agent': UA } });
  const cognitoCookies = parseCookies(r0);
  let pingUrl = r0.headers.get('location');
  console.log(`[HutBotAuth] Cognito → ${(pingUrl || 'none').slice(0, 100)}, cookies: ${cognitoCookies.length}`);
  if (!pingUrl) throw new Error(`Cognito OAuth2 did not redirect (status ${r0.status})`);

  // Cognito may redirect through its own login page first — follow until we reach portalsso
  if (!pingUrl.includes('portalsso.yum.com')) {
    // Follow one more hop (Cognito login → IDP redirect)
    const rMid = await fetch(pingUrl.startsWith('http') ? pingUrl : `https://auth.superapp.yum.com${pingUrl}`, {
      redirect: 'manual',
      headers: { 'User-Agent': UA, Cookie: mergeCookies(cognitoCookies) },
    });
    parseCookies(rMid).forEach(c => cognitoCookies.push(c));
    const loc2 = rMid.headers.get('location');
    console.log(`[HutBotAuth] Cognito mid-hop ${rMid.status} → ${(loc2 || 'none').slice(0, 100)}`);
    if (loc2) pingUrl = loc2;
  }

  // ── Step 2: Load Ping Identity login page ────────────────────────────────
  console.log('[HutBotAuth] Step 2: loading Ping Identity login page');
  const r1 = await fetch(pingUrl.startsWith('http') ? pingUrl : `${PING_BASE}${pingUrl}`, {
    headers: { 'User-Agent': UA },
  });
  const cookies1 = parseCookies(r1);
  const html1 = await r1.text();
  console.log(`[HutBotAuth] Ping login page (${html1.length} bytes), cookies: ${cookies1.length}`);

  const action1       = extractFormAction(html1, pingUrl);
  const hidden1       = extractHiddenFields(html1);
  const usernameField = html1.match(/name=["'](pf\.username|username|USER|j_username)["']/i)?.[1] || 'pf.username';
  const allCookies1   = mergeCookies(cognitoCookies, cookies1);

  // ── Single-step: username + password on same page ─────────────────────────
  const passFieldOnPage1 = html1.match(/name=["'](pf\.pass|password|PASS|j_password|currentPassword)["']/i)?.[1];
  if (passFieldOnPage1) {
    console.log(`[HutBotAuth] Single-step form — submitting username+password (field: ${passFieldOnPage1})`);
    const postUrl1 = action1.startsWith('http') ? action1 : `${PING_BASE}${action1}`;
    const body = encodeForm({ ...hidden1, [usernameField]: user, [passFieldOnPage1]: pass });
    const r2 = await fetch(postUrl1, {
      method: 'POST', redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: allCookies1, 'User-Agent': UA, Referer: pingUrl },
      body,
    });
    const cookies2 = parseCookies(r2);
    console.log(`[HutBotAuth] Single-step POST → ${r2.status}, loc: ${r2.headers.get('location') || 'none'}`);
    return await _finishAfterCredentials(r2, cookies2, mergeCookies(allCookies1, cookies2), postUrl1);
  }

  // ── Two-step: username first ──────────────────────────────────────────────
  const postUrl1 = action1.startsWith('http') ? action1 : `${PING_BASE}${action1}`;
  console.log(`[HutBotAuth] Step 3: posting username to ${postUrl1}`);
  const r2 = await fetch(postUrl1, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: allCookies1, 'User-Agent': UA, Referer: pingUrl },
    body: encodeForm({ ...hidden1, [usernameField]: user }),
  });
  const cookies2 = parseCookies(r2);
  console.log(`[HutBotAuth] Username POST → ${r2.status}, loc: ${r2.headers.get('location') || 'none'}`);
  let allCookies2 = mergeCookies(allCookies1, cookies2);

  let html2 = '';
  if (r2.status === 302 || r2.status === 301) {
    const loc = r2.headers.get('location');
    const r2b = await fetch(loc.startsWith('http') ? loc : `${PING_BASE}${loc}`, {
      headers: { 'User-Agent': UA, Cookie: allCookies2 },
    });
    parseCookies(r2b).forEach(c => { cookies2.push(c); });
    html2 = await r2b.text();
    allCookies2 = mergeCookies(allCookies2, cookies2);
  } else {
    html2 = await r2.text();
  }

  const passField = html2.match(/name=["'](pf\.pass|password|PASS|j_password|currentPassword)["']/i)?.[1] || 'pf.pass';
  const action2   = extractFormAction(html2, postUrl1);
  const hidden2   = extractHiddenFields(html2);
  const postUrl2  = action2.startsWith('http') ? action2 : `${PING_BASE}${action2}`;

  console.log(`[HutBotAuth] Step 4: posting password to ${postUrl2} (field: ${passField})`);
  const r3 = await fetch(postUrl2, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: allCookies2, 'User-Agent': UA, Referer: postUrl1 },
    body: encodeForm({ ...hidden2, [passField]: pass }),
  });
  const cookies3 = parseCookies(r3);
  console.log(`[HutBotAuth] Password POST → ${r3.status}, loc: ${r3.headers.get('location') || 'none'}`);
  let allCookies3 = mergeCookies(allCookies2, cookies3);

  let html3 = '';
  if (r3.status === 302 || r3.status === 301) {
    const loc = r3.headers.get('location');
    const r3b = await fetch(loc.startsWith('http') ? loc : `${PING_BASE}${loc}`, {
      headers: { 'User-Agent': UA, Cookie: allCookies3 },
    });
    parseCookies(r3b).forEach(c => cookies3.push(c));
    html3 = await r3b.text();
    allCookies3 = mergeCookies(allCookies3, cookies3);
  } else {
    html3 = await r3.text();
  }

  return await _extractAndPostSAML(html3, allCookies3);
}

// ── Extract SAMLResponse and complete the Cognito auth leg ───────────────────
async function _extractAndPostSAML(html3, allCookiesSoFar) {
  const samlMatch = html3.match(/name=["']SAMLResponse["'][^>]*value=["']([^"']+)["']/i)
    || html3.match(/value=["']([^"']{100,})["'][^>]*name=["']SAMLResponse["']/i);
  if (!samlMatch) {
    console.error('[HutBotAuth] SAMLResponse not found. Page snippet:', html3.slice(0, 2000));
    throw new Error('SAMLResponse not found — login may have failed or MFA required');
  }
  const samlResponse = samlMatch[1];
  const relayState   = (html3.match(/name=["']RelayState["'][^>]*value=["']([^"']*?)["']/i) || [])[1] || '';
  const acsUrl       = extractFormAction(html3, COGNITO_ACS_URL);
  const acsBase      = acsUrl.startsWith('http') ? new URL(acsUrl).origin : 'https://auth.superapp.yum.com';
  console.log(`[HutBotAuth] SAMLResponse (${samlResponse.length} chars), posting to ACS: ${acsUrl}`);

  const r4 = await fetch(acsUrl.startsWith('http') ? acsUrl : `${acsBase}${acsUrl}`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: allCookiesSoFar, 'User-Agent': UA },
    body: encodeForm({ SAMLResponse: samlResponse, RelayState: relayState }),
  });
  const cookies4 = parseCookies(r4);
  console.log(`[HutBotAuth] Cognito ACS → ${r4.status}, loc: ${r4.headers.get('location') || 'none'}, cookies: ${cookies4.length}`);
  if (r4.status >= 400) {
    const body4 = await r4.text();
    console.error(`[HutBotAuth] ACS error: ${body4.slice(0, 500)}`);
    throw new Error(`Cognito ACS returned ${r4.status}: ${body4.slice(0, 200)}`);
  }

  // Follow all redirects collecting cookies (Cognito → admin app → final session)
  let finalCookies = mergeCookies(allCookiesSoFar, cookies4);
  let nextUrl = r4.headers.get('location');
  let hops = 0;

  while (nextUrl && hops < 10) {
    hops++;
    const absUrl = nextUrl.startsWith('http') ? nextUrl : `${acsBase}${nextUrl}`;
    console.log(`[HutBotAuth] Hop ${hops}: ${absUrl.slice(0, 100)}`);
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
async function _finishAfterCredentials(r, cookies, allCookies, referer) {
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
  return await _extractAndPostSAML(html, mergeCookies(allCookies, cookies));
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
