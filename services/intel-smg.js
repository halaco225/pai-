'use strict';
/**
 * SMG comment export — pure HTTP approach.
 *
 * Auth flow:
 *   1. POST credentials to auth.smg.com/connect/token (OAuth2 password grant)
 *      → returns { access_token, refresh_token, expires_in }
 *   2. POST to 360.smg.com/api/export/v2/commentreport with Bearer token
 *      → returns xlsx binary
 */
const https = require('https');
const fs    = require('fs');
const path  = require('path');

const SMG_TOKEN_URL  = 'https://auth.smg.com/connect/token';
const SMG_EXPORT_URL = 'https://360.smg.com/api/export/v2/commentreport';
const ACCOUNT_ID     = '5b6205b27485e95d90e0a366';
const REPORT_ID      = '5b621d617485e95d90e0a36f';
const CARD_ID        = '5b621d617485e95d90e0a370';

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

// ── HTTP helper ─────────────────────────────────────────────────────────────

function httpRequest(method, url, { headers = {}, body, binary = false } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname,
      path:     u.pathname + u.search,
      method,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
        ...headers,
      },
    };
    if (body) opts.headers['Content-Length'] = Buffer.byteLength(body);
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          status:  res.statusCode,
          headers: res.headers,
          body:    binary ? buf : buf.toString('utf8'),
          buffer:  buf,
        });
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// ── Step 1: OAuth2 password grant → Bearer token ────────────────────────────

async function getAccessToken(user, pass) {
  console.log('[SMG] Requesting OAuth2 token...');
  const formBody = new URLSearchParams({
    grant_type: 'password',
    username:   user,
    password:   pass,
    client_id:  'smg360',
    scope:      'email feedback offline_access openid smg360',
  }).toString();

  const resp = await httpRequest('POST', SMG_TOKEN_URL, {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody,
  });

  console.log(`[SMG] Token response: HTTP ${resp.status}`);
  if (resp.status !== 200) {
    console.log('[SMG] Token error body:', resp.body.slice(0, 300));
    throw new Error(`SMG token request failed: HTTP ${resp.status} — ${resp.body.slice(0, 200)}`);
  }

  const data = JSON.parse(resp.body);
  if (!data.access_token) throw new Error('SMG token response missing access_token');
  console.log(`[SMG] Got access token (expires_in=${data.expires_in}s)`);
  return data.access_token;
}

// ── Step 2: Build date range (30-day window ending at targetDate) ────────────

function buildDateRange(targetDate) {
  // targetDate is "YYYY-MM-DD" in local time; ET midnight = UTC 04:00 or 05:00
  // Use 05:00 UTC (EST offset) as a safe midnight boundary
  const endMs   = new Date(targetDate + 'T05:00:00.000Z').getTime() + 86400000; // end of targetDate ET
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

// ── Step 3: POST export request → xlsx binary ───────────────────────────────

async function exportComments(accessToken, targetDate) {
  const dateRange = buildDateRange(targetDate);
  console.log(`[SMG] Exporting comments for date range ${dateRange.startDate} → ${dateRange.endDate}`);

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
      hierarchy:           {},
      socialSites:         [],
      attributeMeasures:   [],
      openEnds:            [],
      searchTerms:         null,
      aggregationPeriod:   null,
      ontologyGroups:      [],
    },
    exportFileType:    1,
    baseFileName:      'Comments_ByComment',
    timeZone:          'America/New_York',
    separateComments:  true,
  };

  const body = JSON.stringify(payload);
  const resp = await httpRequest('POST', SMG_EXPORT_URL, {
    headers: {
      'Authorization':  `Bearer ${accessToken}`,
      'AccountId':      ACCOUNT_ID,
      'Content-Type':   'application/json',
      'accept':         'application/xlsx',
      'SMG-LanguageIso': 'en-US',
      'TimeZone':       'America/New_York',
      'Origin':         'https://360.smg.com',
      'Referer':        'https://360.smg.com/',
    },
    body,
    binary: true,
  });

  console.log(`[SMG] Export response: HTTP ${resp.status}, size=${resp.buffer.length} bytes`);

  if (resp.status !== 200) {
    const msg = resp.buffer.toString('utf8').slice(0, 300);
    throw new Error(`SMG export failed: HTTP ${resp.status} — ${msg}`);
  }

  // Verify it looks like an xlsx (PK zip magic bytes)
  if (resp.buffer[0] !== 0x50 || resp.buffer[1] !== 0x4b) {
    const preview = resp.buffer.toString('utf8').slice(0, 200);
    throw new Error(`SMG export returned non-xlsx data: ${preview}`);
  }

  return resp.buffer;
}

// ── Main export function ────────────────────────────────────────────────────

async function downloadSMGComments(targetDate) {
  const tmpDir  = '/tmp/uploads';
  fs.mkdirSync(tmpDir, { recursive: true });
  const outPath = path.join(tmpDir, `intel-smg-${targetDate}.xlsx`);

  const user = process.env.SMG_USER     || '';
  const pass = process.env.SMG_PASSWORD || '';
  if (!user || !pass) throw new Error('SMG_USER / SMG_PASSWORD env vars not set');

  try {
    const accessToken = await getAccessToken(user, pass);
    const xlsxBuffer  = await exportComments(accessToken, targetDate);
    fs.writeFileSync(outPath, xlsxBuffer);
    console.log(`[SMG] Saved → ${outPath} (${xlsxBuffer.length} bytes)`);
    return { success: true, filePath: outPath };
  } catch (err) {
    console.error('[SMG] FAILED:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { downloadSMGComments };
