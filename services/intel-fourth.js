'use strict';
/**
 * Fourth Analytics — exports Labor and OT reports via GoodData Classic REST API.
 *
 * Auth: browser login establishes a GoodData session. ALL API calls are made
 * from within the browser context via page.evaluate(fetch) so the browser's
 * native cookie jar handles auth. Cookie replay via node-fetch fails because
 * GoodData binds the session to the browser context.
 *
 * Export flow (all inside browser context):
 *   GET  /gdc/md/{project}/objects/{dashboardId}  → parse report URIs
 *   POST /gdc/app/projects/{project}/execute/raw/ → get result URI
 *   GET  result URI (poll until 200)              → xlsx bytes as base64
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

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

async function downloadFourthReport(reportKey, targetDate) {
  const tmpDir  = '/tmp/uploads';
  fs.mkdirSync(tmpDir, { recursive: true });
  const outPath = path.join(tmpDir, `intel-fourth-${reportKey.toLowerCase()}-${targetDate}.xlsx`);

  const dashInfo = DASHBOARDS[reportKey];
  if (!dashInfo) throw new Error(`Unknown report key: ${reportKey}`);

  const user = process.env.FOURTH_USER || '';
  const pass = process.env.FOURTH_PASSWORD || '';
  if (!user || !pass) throw new Error('FOURTH_USER / FOURTH_PASSWORD env vars not set');

  try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch (_) {}
  const browser = await launchContext(PROFILE_DIR, {});

  try {
    const page = await browser.newPage();

    // ── Login ─────────────────────────────────────────────────────────────
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
    console.log(`[Fourth] Post-login URL: ${page.url()}`);

    // ── Verify session via in-browser fetch ────────────────────────────────
    const profileCheck = await page.evaluate(async (api) => {
      try {
        const res = await fetch(`${api}/gdc/account/profile/current`, {
          headers: { Accept: 'application/json' },
          credentials: 'include',
        });
        return { status: res.status };
      } catch (e) { return { status: -1, error: e.message }; }
    }, FOURTH_API);
    console.log(`[Fourth] Browser profile check: ${profileCheck.status}`);
    if (profileCheck.status !== 200) {
      throw new Error(`Auth check failed: profile returned ${profileCheck.status}`);
    }

    // ── Navigate to dashboard and intercept the SPA's own metadata request ──
    // Our own fetch to /gdc/md/.../objects/{id} returns 403 because GoodData
    // Classic binds metadata permission to the SPA session context.
    // Solution: let the SPA navigate to the dashboard (which it CAN do) and
    // intercept the XHR it makes internally to fetch the same metadata.
    const dashUrl = `${FOURTH_API}/#s=/gdc/workspaces/${PROJECT_ID}|workspaceDashboardPage|/gdc/md/${PROJECT_ID}/obj/${dashInfo.obj}|${dashInfo.tab}`;
    const metaPattern = new RegExp(`/gdc/md/${PROJECT_ID}/objects/${dashInfo.obj}`);

    let dashBody = '';
    try {
      const [response] = await Promise.all([
        page.waitForResponse(
          r => metaPattern.test(r.url()) && r.status() === 200,
          { timeout: 25000 }
        ),
        page.goto(dashUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }),
      ]);
      dashBody = await response.text();
      console.log(`[Fourth] Intercepted SPA metadata (${dashBody.length} bytes)`);
    } catch (e) {
      console.log(`[Fourth] SPA metadata intercept failed: ${e.message} — will try query/reports`);
    }

    // ── Parse report URIs from intercepted dashboard JSON ─────────────────
    let reportUris = [];
    if (dashBody) {
      try {
        const data = JSON.parse(dashBody);
        const tabs = data.projectDashboard?.content?.tabs || [];
        console.log('[Fourth] Tabs:', tabs.map(t => `${t.title || '?'}(${t.identifier})`).join(', '));
        const tab = tabs.find(t => t.identifier === dashInfo.tab) || tabs[0];
        if (tab) {
          const tabRaw = JSON.stringify(tab);
          reportUris = [...new Set((tabRaw.match(/\/gdc\/md\/[^"]+\/obj\/\d+/g) || []))];
          console.log(`[Fourth] Report URIs from tab:`, JSON.stringify(reportUris));
        }
      } catch (_) {}

      if (reportUris.length === 0) {
        reportUris = [...new Set((dashBody.match(/\/gdc\/md\/[^"]+\/obj\/\d+/g) || []))];
        console.log('[Fourth] Fallback URIs from body scan:', JSON.stringify(reportUris));
      }
    }

    if (reportUris.length === 0) throw new Error('No report URIs found');

    // ── Execute + poll + download each URI until one succeeds ──────────────
    for (const reportUri of reportUris) {
      try {
        console.log(`[Fourth] Executing: ${reportUri}`);
        const execResult = await page.evaluate(async ({ api, projId, uri }) => {
          try {
            const res = await fetch(`${api}/gdc/app/projects/${projId}/execute/raw/`, {
              method: 'POST',
              headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({ report_req: { report: uri, format: 'xlsx' } }),
            });
            return { status: res.status, body: await res.text() };
          } catch (e) { return { status: -1, body: '', error: e.message }; }
        }, { api: FOURTH_API, projId: PROJECT_ID, uri: reportUri });

        if (execResult.status !== 200) {
          console.log(`[Fourth] Execute ${execResult.status} — ${execResult.body.slice(0, 200)}`);
          continue;
        }
        const resultUri = JSON.parse(execResult.body).uri;
        if (!resultUri) { console.log('[Fourth] No result URI'); continue; }
        console.log(`[Fourth] Export queued → ${resultUri}`);

        // Poll until ready
        let base64data = null;
        for (let i = 1; i <= 30; i++) {
          await sleep(3000);
          const pollResult = await page.evaluate(async (url) => {
            try {
              const res = await fetch(url, { credentials: 'include' });
              if (res.status === 200) {
                const ab = await res.arrayBuffer();
                const bytes = new Uint8Array(ab);
                let binary = '';
                for (let j = 0; j < bytes.length; j++) binary += String.fromCharCode(bytes[j]);
                return { status: 200, data: btoa(binary) };
              }
              return { status: res.status, data: null };
            } catch (e) { return { status: -1, data: null, error: e.message }; }
          }, `${FOURTH_API}${resultUri}`);

          console.log(`[Fourth] Poll ${i}: ${pollResult.status}`);
          if (pollResult.status === 200 && pollResult.data) {
            base64data = pollResult.data;
            break;
          }
          if (pollResult.status !== 202 && pollResult.status !== -1) {
            console.log(`[Fourth] Poll unexpected status ${pollResult.status}`);
            break;
          }
        }

        if (!base64data) { console.log(`[Fourth] ${reportUri} — no data`); continue; }

        const buf = Buffer.from(base64data, 'base64');
        if (buf.length < 500) { console.log(`[Fourth] Too small (${buf.length}b)`); continue; }
        if (buf.slice(0, 4).toString() === '%PDF') { console.log('[Fourth] Got PDF — skip'); continue; }

        fs.writeFileSync(outPath, buf);
        console.log(`[Fourth] ${reportKey} → ${outPath} (${buf.length} bytes)`);
        return { success: true, filePath: outPath };

      } catch (e) {
        console.log(`[Fourth] ${reportUri} failed: ${e.message}`);
      }
    }

    throw new Error('All report URIs failed or returned unusable data');

  } catch (err) {
    console.error(`[Fourth] ${reportKey} FAILED:`, err.message);
    return { success: false, error: err.message };
  } finally {
    try { await browser.close(); } catch (_) {}
  }
}

module.exports = { downloadFourthReport };
