'use strict';
/**
 * hutbot-auth.js
 * Automates the Yum! SSO login flow to obtain a Cognito session for the
 * Byte Coach Admin API (api.superapp.yum.com/admin-proxy).
 *
 * Flow (mirrors what ODS does for onedatasource.com):
 *   1. Build SAML AuthnRequest → GET portalsso.yum.com login page
 *   2. POST username (Ping Identity step 1)
 *   3. POST password (Ping Identity step 2)
 *   4. Parse SAMLResponse from the auto-submit form
 *   5. POST SAMLResponse → auth.superapp.yum.com (Cognito ACS)
 *   6. Follow Cognito redirect → capture session cookies
 *   7. Cache session in DB; reuse until 401/403
 *
 * Env vars:
 *   HUTBOT_USER     — Yum network username (e.g. Hgl2743)
 *   HUTBOT_PASSWORD — Yum network password
 */
const zlib   = require('zlib');
const crypto = require('crypto');
const db     = require('./db');

const SAML_IDP_URL    = 'https://portalsso.yum.com/idp/SSO.saml2';
const SAML_SP_ENTITY  = 'urn:amazon:cognito:sp:eu-west-1_5wpN4DCgk';
const COGNITO_ACS_URL = 'https://auth.superapp.yum.com/saml2/idpresponse';
const API_BASE        = 'https://api.superapp.yum.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

// ── Cookie helpers (same pattern as intel-ods.js) ─────────────────────────────
function parseCookies(response) {
  const raw = response.headers.raw ? response.headers.raw()['set-cookie'] : [];
  return (raw || []).map(c => c.split(';')[0]);
}
function mergeCookies(...arrays) {
  const map = new Map();
  arrays.flat().forEach(c => { const eq = c.indexOf('='); if (eq > 0) map.set(c.slice(0, eq), c); });
  return Array.from(map.values()).join('; ');
}

// ── HTML parsing helpers ───────────────────────────────────────────────────────
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

// ── Build SAML AuthnRequest ────────────────────────────────────────────────────
async function buildSAMLRequest() {
  const id  = '_' + crypto.randomUUID().replace(/-/g, '');
  const now = new Date().toISOString();
  const xml = `<?xml version="1.0" encoding="UTF-8"?><saml2p:AuthnRequest AssertionConsumerServiceURL="${COGNITO_ACS_URL}" Destination="${SAML_IDP_URL}" ID="${id}" IssueInstant="${now}" Version="2.0" xmlns:saml2p="urn:oasis:names:tc:SAML:2.0:protocol"><saml2:Issuer Format="urn:oasis:names:tc:SAML:2.0:nameid-format:entity" xmlns:saml2="urn:oasis:names:tc:SAML:2.0:assertion">${SAML_SP_ENTITY}</saml2:Issuer></saml2p:AuthnRequest>`;
  return new Promise((resolve, reject) => {
    zlib.deflateRaw(Buffer.from(xml, 'utf8'), (err, buf) => {
      if (err) reject(err);
      else resolve(encodeURIComponent(buf.toString('base64')));
    });
  });
}

// ── Full login flow ────────────────────────────────────────────────────────────
async function login() {
  const user = process.env.HUTBOT_USER     || '';
  const pass = process.env.HUTBOT_PASSWORD || '';
  if (!user || !pass) throw new Error('HUTBOT_USER / HUTBOT_PASSWORD env vars not set');

  console.log('[HutBotAuth] Starting SSO login for', user);

  const samlReq = await buildSAMLRequest();
  const idpUrl  = `${SAML_IDP_URL}?SAMLRequest=${samlReq}`;

  // ── Step 1: Load Ping Identity login page ─────────────────────────────────
  console.log('[HutBotAuth] Step 1: loading IDP login page');
  const r1 = await fetch(idpUrl, { headers: { 'User-Agent': UA } });
  if (!r1.ok) throw new Error(`IDP login page returned ${r1.status}`);
  const html1    = await r1.text();
  const cookies1 = parseCookies(r1);
  console.log(`[HutBotAuth] IDP page loaded (${html1.length} bytes), cookies: ${cookies1.length}`);

  const action1  = extractFormAction(html1, SAML_IDP_URL);
  const hidden1  = extractHiddenFields(html1);

  // Ping Identity step 1: POST username
  // Field names vary — try common Ping Identity patterns
  const usernameField = html1.match(/name=["'](pf\.username|username|USER|j_username)["']/i)?.[1] || 'pf.username';
  const body1 = encodeForm({ ...hidden1, [usernameField]: user });

  const postUrl1 = action1.startsWith('http') ? action1 : `https://portalsso.yum.com${action1}`;
  console.log(`[HutBotAuth] Step 2: posting username to ${postUrl1}`);

  const r2 = await fetch(postUrl1, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: mergeCookies(cookies1), 'User-Agent': UA, Referer: idpUrl },
    body: body1,
  });
  const cookies2 = parseCookies(r2);
  const allCookies2 = mergeCookies(cookies1, cookies2);

  // Follow redirect if needed
  let html2 = '';
  let action2 = '';
  let hidden2 = {};
  if (r2.status === 302 || r2.status === 301) {
    const loc = r2.headers.get('location');
    console.log(`[HutBotAuth] Redirect to: ${loc}`);
    const r2b = await fetch(loc.startsWith('http') ? loc : `https://portalsso.yum.com${loc}`, {
      headers: { 'User-Agent': UA, Cookie: allCookies2 },
    });
    const extra = parseCookies(r2b);
    html2 = await r2b.text();
    Object.assign(cookies2, extra);
  } else {
    html2 = await r2.text();
  }
  console.log(`[HutBotAuth] Password page loaded (${html2.length} bytes)`);
  action2 = extractFormAction(html2, postUrl1);
  hidden2 = extractHiddenFields(html2);

  // ── Step 3: POST password ──────────────────────────────────────────────────
  const passField = html2.match(/name=["'](pf\.pass|password|PASS|j_password|currentPassword)["']/i)?.[1] || 'pf.pass';
  const body2 = encodeForm({ ...hidden2, [passField]: pass });
  const postUrl2 = action2.startsWith('http') ? action2 : `https://portalsso.yum.com${action2}`;

  console.log(`[HutBotAuth] Step 3: posting password to ${postUrl2}`);
  const r3 = await fetch(postUrl2, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: mergeCookies(cookies1, cookies2), 'User-Agent': UA, Referer: postUrl1 },
    body: body2,
  });
  const cookies3 = parseCookies(r3);

  let html3 = '';
  if (r3.status === 302 || r3.status === 301) {
    const loc = r3.headers.get('location');
    console.log(`[HutBotAuth] Redirect after password: ${loc}`);
    const r3b = await fetch(loc.startsWith('http') ? loc : `https://portalsso.yum.com${loc}`, {
      headers: { 'User-Agent': UA, Cookie: mergeCookies(cookies1, cookies2, cookies3) },
    });
    parseCookies(r3b).forEach(c => cookies3.push(c));
    html3 = await r3b.text();
  } else {
    html3 = await r3.text();
  }
  console.log(`[HutBotAuth] Post-password page (${html3.length} bytes)`);

  // ── Step 4: Extract SAMLResponse ──────────────────────────────────────────
  const samlResponseMatch = html3.match(/name=["']SAMLResponse["'][^>]*value=["']([^"']+)["']/i)
    || html3.match(/value=["']([^"']{100,})["'][^>]*name=["']SAMLResponse["']/i);
  if (!samlResponseMatch) {
    // Log page snippet to help diagnose
    console.error('[HutBotAuth] SAMLResponse not found. Page snippet:', html3.slice(0, 600));
    throw new Error('SAMLResponse not found in IDP response — login may have failed or MFA required');
  }
  const samlResponse = samlResponseMatch[1];
  const relayState   = (html3.match(/name=["']RelayState["'][^>]*value=["']([^"']+)["']/i) || [])[1] || '';
  const acsUrl       = extractFormAction(html3, COGNITO_ACS_URL);
  console.log('[HutBotAuth] SAMLResponse captured, posting to Cognito ACS');

  // ── Step 5: POST SAMLResponse to Cognito ──────────────────────────────────
  const allCookies = mergeCookies(cookies1, cookies2, cookies3);
  const r4 = await fetch(acsUrl.startsWith('http') ? acsUrl : `https://auth.superapp.yum.com${acsUrl}`, {
    method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: allCookies, 'User-Agent': UA },
    body: encodeForm({ SAMLResponse: samlResponse, RelayState: relayState }),
  });
  const cookies4 = parseCookies(r4);
  console.log(`[HutBotAuth] Cognito ACS response: ${r4.status}, cookies: ${cookies4.length}`);

  // ── Step 6: Follow Cognito → app redirects, collecting cookies ────────────
  let finalCookies = mergeCookies(cookies1, cookies2, cookies3, cookies4);
  let nextUrl = r4.headers.get('location');
  let hops = 0;

  while (nextUrl && hops < 8) {
    hops++;
    const absUrl = nextUrl.startsWith('http') ? nextUrl : `https://auth.superapp.yum.com${nextUrl}`;
    console.log(`[HutBotAuth] Redirect hop ${hops}: ${absUrl.slice(0, 80)}`);
    const rN = await fetch(absUrl, {
      redirect: 'manual',
      headers: { 'User-Agent': UA, Cookie: finalCookies },
    });
    const newCookies = parseCookies(rN);
    if (newCookies.length) finalCookies = mergeCookies(finalCookies, newCookies);
    nextUrl = rN.headers.get('location');
    if (!nextUrl) break;
  }

  if (!finalCookies) throw new Error('No session cookies obtained after login');
  console.log('[HutBotAuth] Login complete — session cookies obtained');
  return finalCookies;
}

// ── Public: get valid cookie (from DB cache or fresh login) ───────────────────
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
