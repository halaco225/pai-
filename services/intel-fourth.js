'use strict';
/**
 * Fourth Analytics — exports Labor and OT reports via GoodData Classic REST API.
 *
 * Pure HTTP approach — no Playwright/browser needed.
 *
 * Auth flow:
 *   1. POST /gdc/account/login   → sets GDCAuthSST cookie
 *   2. GET  /gdc/account/token   → sets GDCAuthTT cookie
 *
 * Export flow:
 *   3. GET  /gdc/md/{project}/query/reports  → list all reports
 *   4. POST /gdc/app/projects/{project}/execute/raw/ { report_req: { report: uri } }
 *      → returns { uri: resultUri }
 *   5. GET resultUri (poll until 200) → xlsx bytes
 */
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const FOURTH_HOST = 'analytics.na1.fourth.com';
const PROJECT_ID  = 'q0t16mq5dgsreqiq8macw3ghv3k1iuqc';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── HTTP helper with cookie jar ───────────────────────────────────────────────

function httpRequest(method, urlPath, { headers = {}, body, binary = false, cookieJar = [] } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const cookieHeader = cookieJar.length ? cookieJar.join('; ') : undefined;
    const reqHeaders = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(cookieHeader ? { Cookie: cookieHeader } : {}),
      ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
      ...headers,
    };

    const req = https.request({
      hostname: FOURTH_HOST,
      path: urlPath,
      method,
      headers: reqHeaders,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => {
        // Extract Set-Cookie headers and add to jar
        const setCookies = res.headers['set-cookie'] || [];
        const newCookies = setCookies.map(c => c.split(';')[0]);
        resolve({
          status:     res.statusCode,
          headers:    res.headers,
          newCookies,
          body:       binary ? Buffer.concat(chunks) : Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    const timer = setTimeout(() => req.destroy(new Error(`Fourth timeout: ${method} ${urlPath}`)), 60000);
    req.on('error', e => { clearTimeout(timer); reject(e); });
    req.on('close', () => clearTimeout(timer));
    if (data) req.write(data);
    req.end();
  });
}

// ── Step 1: Login → get GDCAuthSST + GDCAuthTT cookies ───────────────────────

async function getAuthCookies(user, pass) {
  console.log('[Fourth] Logging in via REST API...');
  const loginResp = await httpRequest('POST', '/gdc/account/login', {
    body: { postUserLogin: { login: user, password: pass, remember: 1, captcha: '', verifyCaptcha: '' } },
  });

  if (loginResp.status !== 200 && loginResp.status !== 201) {
    throw new Error(`Fourth login failed: HTTP ${loginResp.status} — ${loginResp.body.slice(0, 200)}`);
  }

  const sstCookies = loginResp.newCookies.filter(c => c.startsWith('GDCAuthSST'));
  if (!sstCookies.length) {
    throw new Error(`Fourth login: no GDCAuthSST cookie in response. Cookies: ${loginResp.newCookies.join(', ')}`);
  }
  const jar = [...sstCookies];
  console.log('[Fourth] Got GDCAuthSST — refreshing token...');

  // Step 2: GET /gdc/account/token to get GDCAuthTT
  const tokenResp = await httpRequest('GET', '/gdc/account/token', { cookieJar: jar });
  if (tokenResp.status !== 200) {
    throw new Error(`Fourth token refresh failed: HTTP ${tokenResp.status}`);
  }
  const ttCookies = tokenResp.newCookies.filter(c => c.startsWith('GDCAuthTT'));
  if (ttCookies.length) jar.push(...ttCookies);

  console.log(`[Fourth] Auth cookies ready (${jar.length} cookies)`);
  return jar;
}

// ── Step 2: List reports, filter by keyword ───────────────────────────────────

async function findReportUris(jar, reportKey) {
  console.log('[Fourth] Querying report list...');
  const resp = await httpRequest('GET', `/gdc/md/${PROJECT_ID}/query/reports`, { cookieJar: jar });
  if (resp.status !== 200) {
    throw new Error(`Failed to list reports: HTTP ${resp.status} — ${resp.body.slice(0, 200)}`);
  }

  const data    = JSON.parse(resp.body);
  const entries = data.query?.entries || [];
  console.log(`[Fourth] Total reports in project: ${entries.length}`);

  const keywords = reportKey === 'LABOR'
    ? ['labor', 'labour']
    : ['overtime', 'over time', ' ot '];

  let uris = entries
    .filter(e => keywords.some(kw => (e.title || '').toLowerCase().includes(kw)))
    .map(e => e.link);

  if (!uris.length) {
    console.log('[Fourth] No keyword matches — trying all reports');
    uris = entries.map(e => e.link);
  }

  console.log(`[Fourth] Using ${uris.length} report URI(s) for ${reportKey}`);
  return uris;
}

// ── Step 3: Execute report → poll → download xlsx ─────────────────────────────

async function executeAndDownload(jar, reportUri, outPath) {
  console.log(`[Fourth] Executing report: ${reportUri}`);

  const execResp = await httpRequest('POST', `/gdc/app/projects/${PROJECT_ID}/execute/raw/`, {
    cookieJar: jar,
    body: { report_req: { report: reportUri } },
  });

  if (execResp.status !== 200 && execResp.status !== 201) {
    throw new Error(`Execute failed: HTTP ${execResp.status} — ${execResp.body.slice(0, 200)}`);
  }

  const resultUri = JSON.parse(execResp.body).uri;
  if (!resultUri) throw new Error('Execute response missing result URI');
  console.log(`[Fourth] Export queued → ${resultUri}`);

  // Poll until ready
  for (let i = 1; i <= 40; i++) {
    await sleep(3000);
    const pollResp = await httpRequest('GET', resultUri, { cookieJar: jar, binary: true });
    console.log(`[Fourth] Poll ${i}: HTTP ${pollResp.status} (${pollResp.body.length} bytes)`);

    if (pollResp.status === 200) {
      const buf = pollResp.body;
      if (buf.length < 500) throw new Error(`Response too small (${buf.length} bytes) — likely an error page`);
      if (buf.slice(0, 4).toString() === '%PDF') throw new Error('Got PDF instead of xlsx');
      fs.writeFileSync(outPath, buf);
      console.log(`[Fourth] Saved → ${outPath} (${buf.length} bytes)`);
      return true;
    }
    if (pollResp.status !== 202) {
      throw new Error(`Unexpected poll status ${pollResp.status} — ${pollResp.body.toString().slice(0, 200)}`);
    }
  }
  throw new Error('Export timed out after 40 polls (2 min)');
}

// ── Main export function ───────────────────────────────────────────────────────

async function downloadFourthReport(reportKey, targetDate) {
  const tmpDir  = '/tmp/uploads';
  fs.mkdirSync(tmpDir, { recursive: true });
  const outPath = path.join(tmpDir, `intel-fourth-${reportKey.toLowerCase()}-${targetDate}.xlsx`);

  const user = process.env.FOURTH_USER     || '';
  const pass = process.env.FOURTH_PASSWORD || '';
  if (!user || !pass) {
    return { success: false, error: 'FOURTH_USER / FOURTH_PASSWORD env vars not set' };
  }

  try {
    const jar        = await getAuthCookies(user, pass);
    const reportUris = await findReportUris(jar, reportKey);

    for (const uri of reportUris) {
      try {
        await executeAndDownload(jar, uri, outPath);
        return { success: true, filePath: outPath };
      } catch (err) {
        console.warn(`[Fourth] ${uri} failed: ${err.message}`);
      }
    }

    return { success: false, error: 'All report URIs failed or returned unusable data' };

  } catch (err) {
    console.error(`[Fourth] ${reportKey} FAILED:`, err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { downloadFourthReport };
