'use strict';
/**
 * SMG API Client — 360.smg.com
 *
 * Auth flow:
 *   1. POST https://auth.smg.com/connect/token  (refresh_token grant)
 *      → returns { access_token, refresh_token, expires_in }
 *   2. Store the new refresh_token back in DB so it stays fresh
 *
 * Comment fetch flow:
 *   1. GET /api/keys?dateFrom=X&dateTo=X&caseStatus=0&caseStatus=1  → list of comment IDs
 *   2. POST /api/comment/many  with those IDs  → full comment objects
 */

const https  = require('https');
const http   = require('http');
const db     = require('./db');

const SMG_AUTH_URL    = 'https://auth.smg.com/connect/token';
const SMG_API_BASE    = 'https://360.smg.com/api';
const SMG_CLIENT_ID   = 'smg360';

// ── helpers ─────────────────────────────────────────────────────────────────

function httpsPost(url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = Buffer.from(body);
    const opts = {
      hostname: u.hostname, path: u.pathname + u.search,
      method: 'POST', headers: { ...headers, 'Content-Length': data.length },
    };
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function httpsGet(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = { hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers };
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

// ── token management ─────────────────────────────────────────────────────────

/**
 * Get a fresh access token using the stored refresh token.
 * Saves the new refresh token to the DB (intel_cache key = 'smg::refresh_token').
 */
async function saveRefreshToken(p, token) {
  if (!p || !token) return;
  try {
    await p.query(`
      INSERT INTO intel_cache(key, value, generated_at)
      VALUES('smg::refresh_token', $1, NOW())
      ON CONFLICT(key) DO UPDATE SET value=$1, generated_at=NOW()
    `, [token]);
    console.log('[SMG API] Refresh token saved');
  } catch (e) { console.warn('[SMG API] Could not save refresh token:', e.message); }
}

async function loginWithPassword(p) {
  const user = process.env.SMG_USER;
  const pass = process.env.SMG_PASSWORD;
  if (!user || !pass) throw new Error('SMG_USER / SMG_PASSWORD not set — cannot auto-recover SMG token');

  const body = new URLSearchParams({
    grant_type: 'password',
    username:   user,
    password:   pass,
    client_id:  SMG_CLIENT_ID,
    scope:      'openid offline_access',
  }).toString();

  const res = await httpsPost(SMG_AUTH_URL, { 'Content-Type': 'application/x-www-form-urlencoded' }, body);
  if (res.status !== 200) throw new Error(`SMG password grant failed: ${res.status} ${res.body.slice(0, 300)}`);

  const data = JSON.parse(res.body);
  await saveRefreshToken(p, data.refresh_token);
  console.log('[SMG API] Token acquired via password grant — new refresh token saved');
  return data.access_token;
}

async function getAccessToken() {
  const p = db.getPool();

  // Try refresh token: DB (rotated daily) takes priority over env var
  let refreshToken = process.env.SMG_REFRESH_TOKEN;
  if (p) {
    try {
      const r = await p.query("SELECT value FROM intel_cache WHERE key='smg::refresh_token' LIMIT 1");
      if (r.rows.length && r.rows[0].value) {
        refreshToken = r.rows[0].value;
        console.log('[SMG API] Using refresh token from DB');
      }
    } catch (_) {}
  }

  if (refreshToken) {
    const body = new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
      client_id:     SMG_CLIENT_ID,
    }).toString();

    const res = await httpsPost(SMG_AUTH_URL, { 'Content-Type': 'application/x-www-form-urlencoded' }, body);
    if (res.status === 200) {
      const data = JSON.parse(res.body);
      await saveRefreshToken(p, data.refresh_token);
      console.log('[SMG API] Token acquired via refresh grant');
      return data.access_token;
    }
    console.warn(`[SMG API] Refresh token failed (${res.status}) — falling back to password grant`);
  }

  // Fallback: password grant using SMG_USER / SMG_PASSWORD
  return loginWithPassword(p);
}

// ── comment fetching ─────────────────────────────────────────────────────────

const ACCOUNT_ID = process.env.SMG_ACCOUNT_ID || '5b6205b27485e95d90e0a366';

function authHeaders(token) {
  return {
    'Authorization':   `Bearer ${token}`,
    'accountid':       ACCOUNT_ID,
    'Content-Type':    'application/json',
    'accept':          'application/json, text/plain, */*',
    'smg-languageiso': 'en-US',
    'timezone':        'America/New_York',
    'origin':          'https://360.smg.com',
    'referer':         'https://360.smg.com/',
    'user-agent':      'Mozilla/5.0 (compatible; PAi/1.0)',
  };
}

/**
 * Fetch comment keys (IDs) for a date range.
 * Returns array of comment key strings.
 */
async function fetchCommentKeys(token, dateFrom, dateTo) {
  // caseStatus: 0=new, 1=in progress, 2=resolved — we want all
  const params = new URLSearchParams({
    dateFrom, dateTo,
    caseStatus: ['0', '1', '2'],
  });
  // URLSearchParams doesn't repeat keys for arrays — do it manually
  const qs = `dateFrom=${dateFrom}&dateTo=${dateTo}&caseStatus=0&caseStatus=1&caseStatus=2`;
  const url = `${SMG_API_BASE}/keys?${qs}`;

  console.log(`[SMG API] Fetching keys: ${url}`);
  const res = await httpsGet(url, authHeaders(token));
  if (res.status !== 200) throw new Error(`SMG /keys failed: ${res.status} ${res.body.slice(0, 200)}`);

  const data = JSON.parse(res.body);
  // Response is array of key strings or { keys: [...] }
  if (Array.isArray(data)) return data;
  if (data.keys) return data.keys;
  if (data.data) return data.data;
  console.warn('[SMG API] Unexpected keys response shape:', JSON.stringify(data).slice(0, 300));
  return [];
}

/**
 * Fetch full comment objects for an array of keys.
 * Batches in groups of 50.
 */
async function fetchCommentDetails(token, keys) {
  const all = [];
  const BATCH = 50;
  for (let i = 0; i < keys.length; i += BATCH) {
    const batch = keys.slice(i, i + BATCH);
    const res = await httpsPost(
      `${SMG_API_BASE}/comment/many`,
      authHeaders(token),
      JSON.stringify(batch)
    );
    if (res.status !== 200) {
      console.warn(`[SMG API] /comment/many batch failed: ${res.status}`);
      continue;
    }
    const data = JSON.parse(res.body);
    if (Array.isArray(data)) all.push(...data);
    else if (data.data) all.push(...data.data);
  }
  return all;
}

// ── source lookup ─────────────────────────────────────────────────────────────

/**
 * Map SMG source names → our source labels
 */
function mapSource(raw) {
  if (!raw) return 'SMG';
  const s = String(raw).toLowerCase();
  if (s.includes('ges') || s.includes('survey')) return 'GES';
  if (s.includes('social') || s.includes('google') || s.includes('yelp')) return 'Social';
  if (s.includes('doordash') || s.includes('door dash')) return 'DoorDash';
  if (s.includes('uber')) return 'Uber Eats';
  if (s.includes('grubhub')) return 'GrubHub';
  return raw;
}

/**
 * Parse store number from SMG location string like "1P039429 - 039429,1660 HWY 81 EAST"
 */
function parseStoreId(locationStr) {
  if (!locationStr) return null;
  const m = String(locationStr).match(/(\d{6})/);
  return m ? m[1] : null;
}

// ── main export ───────────────────────────────────────────────────────────────

/**
 * Download SMG comments for a given date (YYYY-MM-DD) using the REST API.
 * Returns { success, comments: [...], count }
 */
async function downloadSMGCommentsAPI(targetDate) {
  console.log(`[SMG API] Downloading comments for ${targetDate}`);

  let token;
  try {
    token = await getAccessToken();
    console.log('[SMG API] Token acquired');
  } catch (err) {
    console.error('[SMG API] Auth failed:', err.message);
    return { success: false, error: err.message };
  }

  let keys;
  try {
    keys = await fetchCommentKeys(token, targetDate, targetDate);
    console.log(`[SMG API] ${keys.length} comment keys for ${targetDate}`);
  } catch (err) {
    console.error('[SMG API] Key fetch failed:', err.message);
    return { success: false, error: err.message };
  }

  if (!keys.length) {
    console.log('[SMG API] No comments for date');
    return { success: true, comments: [], count: 0 };
  }

  let comments;
  try {
    comments = await fetchCommentDetails(token, keys);
    console.log(`[SMG API] ${comments.length} full comments fetched`);
  } catch (err) {
    console.error('[SMG API] Detail fetch failed:', err.message);
    return { success: false, error: err.message };
  }

  return { success: true, comments, count: comments.length, rawKeys: keys };
}

module.exports = { downloadSMGCommentsAPI, getAccessToken, parseStoreId, mapSource };
