'use strict';
/**
 * Fourth Analytics — exports Labor and OT reports via GoodData Classic REST API.
 *
 * Auth: browser login extracts GDCAuthSST + GDCAuthTT cookies (direct API login
 * returns 403 on metadata endpoints; browser-established session passes).
 * Browser closes after login (~10s). All data work is done via REST API.
 *
 * Export flow:
 *   GET  /gdc/md/{project}/objects/{dashboardId}  → parse report URIs
 *   POST /gdc/app/projects/{project}/execute/raw/ → get result URI
 *   GET  result URI (poll until 200)              → xlsx bytes
 */
const { launchContext } = require('./browser-launch');
const fs   = require('fs');
const path = require('path');

const FOURTH_API  = 'https://analytics.na1.fourth.com';
const PROJECT_ID  = 'q0t16mq5dgsreqiq8macw3ghv3k1iuqc';
const PROFILE_DIR = process.env.FOURTH_PROFILE_DIR || '/tmp/fourth-profile';

const DASHBOARDS = {
  LABOR: { obj: '607717', tab: '8e923313686e' },
  OT:    { obj: '607556', tab: '9103c1ea9b50' },
};

function fetch(...args) { return require('node-fetch')(...args); }
function parseCookies(r) { return (r.headers.raw()['set-cookie'] || []).map(c => c.split(';')[0]); }
function mergeCookies(...arrs) {
  const map = new Map();
  arrs.flat().forEach(c => { const k = c.split('=')[0]; if (k) map.set(k, c); });
  return Array.from(map.values()).join('; ');
}
function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

/**
 * Logs into analytics.na1.fourth.com via the web UI, extracts GDCAuthSST and
 * GDCAuthTT cookies from the browser context, then closes the browser.
 * Returns a cookie string usable for subsequent REST API calls.
 */
async function gdcLoginViaBrowser() {
  const user = process.env.FOURTH_USER || '';
  const pass = process.env.FOURTH_PASSWORD || '';
  if (!user || !pass) throw new Error('FOURTH_USER / FOURTH_PASSWORD env vars not set');

  try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch (_) {}
  const browser = await launchContext(PROFILE_DIR, {});

  try {
    const page = await browser.newPage();

    console.log('[Fourth] Browser login: navigating to account page...');
    await page.goto(`${FOURTH_API}/account.html`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(2000);

    const emailField = await page.waitForSelector(
      'input[type="email"], input[name="username"], #username, input[type="text"]',
      { timeout: 10000 }
    );
    await emailField.fill(user);

    let passField = await page.$('input[type="password"], input[name="password"], #password');
    if (!passField) {
      await page.click('button[type="submit"], button:has-text("Next"), button:has-text("Continue")').catch(() => {});
      await page.waitForTimeout(2000);
      passField = await page.waitForSelector('input[type="password"]', { timeout: 8000 });
    }
    await passField.fill(pass);
    await page.click('button[type="submit"], .s-login-button, button:has-text("Log In"), button:has-text("Sign In")');
    await page.waitForTimeout(5000);
    console.log(`[Fourth] Browser login post-submit URL: ${page.url()}`);

    // Get ALL cookies in context (no URL filter — GoodData sets cookies on /gdc
    // path and possibly sibling domains; a URL-scoped call misses them)
    const allCookies = await page.context().cookies();
    console.log('[Fourth] All cookies:', JSON.stringify(
      allCookies.map(c => ({ name: c.name, domain: c.domain, path: c.path }))
    ));

    if (allCookies.length === 0) throw new Error('No cookies found after browser login');

    // Use all cookies from fourth.com and related domains
    const authCookies = allCookies.filter(c =>
      c.domain.includes('fourth.com') || c.domain.includes('gooddata.com') || c.domain.includes('fourth.io')
    );
    const cookieStr = (authCookies.length > 0 ? authCookies : allCookies)
      .map(c => `${c.name}=${c.value}`).join('; ');
    console.log(`[Fourth] Browser login OK — ${allCookies.length} cookies, using ${(authCookies.length > 0 ? authCookies : allCookies).length} for API`);
    return cookieStr;

  } finally {
    try { await browser.close(); } catch (_) {}
  }
}

async function getDashboardReportUris(cookie, dashObjId, tabId) {
  const res = await fetch(`${FOURTH_API}/gdc/md/${PROJECT_ID}/objects/${dashObjId}`, {
    headers: { Cookie: cookie, Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Dashboard fetch failed: ${res.status} — ${body.slice(0, 200)}`);
  }
  const raw = await res.text();
  console.log('[Fourth] Dashboard JSON (first 1000):', raw.slice(0, 1000));

  let reportUris = [];
  try {
    const data = JSON.parse(raw);
    const tabs = data.projectDashboard?.content?.tabs || [];
    console.log('[Fourth] Dashboard tabs:', tabs.map(t => `${t.title || '?'} (${t.identifier})`));
    const tab = tabs.find(t => t.identifier === tabId) || tabs[0];
    if (tab) {
      const tabRaw = JSON.stringify(tab);
      reportUris = [...new Set((tabRaw.match(/\/gdc\/md\/[^"]+\/obj\/\d+/g) || []))];
      console.log(`[Fourth] Tab "${tab.title || tab.identifier}" report URIs:`, JSON.stringify(reportUris));
    }
  } catch (_) {}

  if (reportUris.length === 0) {
    // Regex scan across full dashboard JSON
    reportUris = [...new Set((raw.match(/\/gdc\/md\/[^"]+\/obj\/\d+/g) || []))];
    console.log('[Fourth] Fallback — all dashboard obj URIs:', JSON.stringify(reportUris));
  }

  return reportUris;
}

async function queryReportsByName(cookie, keywords) {
  const res = await fetch(`${FOURTH_API}/gdc/md/${PROJECT_ID}/query/reports`, {
    headers: { Cookie: cookie, Accept: 'application/json' },
  });
  if (!res.ok) {
    console.log('[Fourth] query/reports failed:', res.status);
    return [];
  }
  const data = await res.json();
  const entries = data.query?.entries || [];
  console.log('[Fourth] Project reports:', JSON.stringify(entries.slice(0, 20).map(r => ({ title: r.title, link: r.link }))));
  return entries
    .filter(r => keywords.some(k => (r.title || '').toLowerCase().includes(k)))
    .map(r => r.link);
}

async function executeAndExport(cookie, reportUri) {
  const execRes = await fetch(`${FOURTH_API}/gdc/app/projects/${PROJECT_ID}/execute/raw/`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ report_req: { report: reportUri, format: 'xlsx' } }),
  });
  if (!execRes.ok) {
    const t = await execRes.text().catch(() => '');
    throw new Error(`Execute ${execRes.status}: ${t.slice(0, 200)}`);
  }
  const body = await execRes.json();
  const resultUri = body.uri;
  if (!resultUri) throw new Error(`No result URI: ${JSON.stringify(body).slice(0, 200)}`);
  console.log(`[Fourth] Export queued → ${resultUri}`);

  for (let i = 1; i <= 30; i++) {
    await sleep(3000);
    const pollRes = await fetch(`${FOURTH_API}${resultUri}`, { headers: { Cookie: cookie } });
    console.log(`[Fourth] Poll ${i}: ${pollRes.status}`);
    if (pollRes.status === 200) return pollRes.buffer();
    if (pollRes.status !== 202) {
      const t = await pollRes.text().catch(() => '');
      throw new Error(`Poll ${pollRes.status}: ${t.slice(0, 100)}`);
    }
  }
  throw new Error('Export timeout after 90s');
}

async function downloadFourthReport(reportKey, targetDate) {
  const tmpDir  = '/tmp/uploads';
  fs.mkdirSync(tmpDir, { recursive: true });
  const outPath = path.join(tmpDir, `intel-fourth-${reportKey.toLowerCase()}-${targetDate}.xlsx`);

  const dashInfo = DASHBOARDS[reportKey];
  if (!dashInfo) throw new Error(`Unknown report key: ${reportKey}`);

  try {
    const cookie = await gdcLoginViaBrowser();

    let reportUris = await getDashboardReportUris(cookie, dashInfo.obj, dashInfo.tab);

    if (reportUris.length === 0) {
      const keywords = reportKey === 'LABOR'
        ? ['location', 'overview', 'labor']
        : ['overtime'];
      console.log('[Fourth] No URIs from dashboard — querying project reports by name');
      reportUris = await queryReportsByName(cookie, keywords);
    }

    if (reportUris.length === 0) throw new Error('No report URIs found via dashboard or query');

    for (const reportUri of reportUris) {
      try {
        console.log(`[Fourth] Trying export: ${reportUri}`);
        const buf = await executeAndExport(cookie, reportUri);
        if (buf.length < 500) {
          console.log(`[Fourth] Skip ${reportUri} — too small (${buf.length}b)`);
          continue;
        }
        if (buf.slice(0, 4).toString() === '%PDF') {
          console.log(`[Fourth] Skip ${reportUri} — got PDF`);
          continue;
        }
        fs.writeFileSync(outPath, buf);
        console.log(`[Fourth] ${reportKey} downloaded → ${outPath} (${buf.length} bytes)`);
        return { success: true, filePath: outPath };
      } catch (e) {
        console.log(`[Fourth] ${reportUri} failed: ${e.message}`);
      }
    }
    throw new Error('All report URIs failed or returned unusable data');

  } catch (err) {
    console.error(`[Fourth] ${reportKey} FAILED:`, err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { downloadFourthReport };
