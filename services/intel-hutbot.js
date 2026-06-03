'use strict';
/**
 * HutBot — Byte Coach Admin routines via Yum API.
 *
 * Auth: fully automated via hutbot-auth.js (Ping Identity SSO → Cognito).
 * On 401/403 the session is marked invalid and automatically re-acquired
 * on the next run — no manual steps required.
 *
 * API endpoint:
 *   POST https://api.superapp.yum.com/admin-proxy/checklists/search?offset=0&pageSize=100
 *   Body: { statuses: ['late', 'missed'] }
 */
const db          = require('./db');
const { getOrRefreshCookie, login } = require('./hutbot-auth');

const YUM_API = 'https://api.superapp.yum.com/admin-proxy/checklists/search';

// ─────────────────────────────────────────────────────────────────────────────
//  Scrape via REST API
// ─────────────────────────────────────────────────────────────────────────────

async function callApi(cookieStr, offset = 0, pageSize = 200) {
  const response = await fetch(`${YUM_API}?offset=${offset}&pageSize=${pageSize}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Cookie: cookieStr,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
    body: JSON.stringify({ statuses: ['late', 'missed'] }),
  });
  return response;
}

async function scrapeHutBot(targetDate) {
  const user = process.env.HUTBOT_USER || '';
  const pass = process.env.HUTBOT_PASSWORD || '';
  if (!user || !pass) {
    return { success: false, error: 'HUTBOT_USER / HUTBOT_PASSWORD env vars not set' };
  }

  console.log(`[HutBot] Fetching routines for ${targetDate}`);

  let cookie;
  try {
    cookie = await getOrRefreshCookie();
  } catch (err) {
    console.error('[HutBot] Login failed:', err.message);
    return { success: false, error: `HutBot login failed: ${err.message}` };
  }

  // Helper: fetch one page, retry once on 401/403
  async function fetchPage(offset) {
    let resp = await callApi(cookie, offset);
    if (resp.status === 401 || resp.status === 403) {
      console.warn('[HutBot] Session expired — re-logging in');
      await db.markHutBotAuthInvalid();
      try {
        cookie = await login();
        await db.setHutBotAuth(cookie, 'auto-retry');
        resp = await callApi(cookie, offset);
      } catch (err) {
        throw new Error(`HutBot re-login failed: ${err.message}`);
      }
    }
    if (resp.status === 401 || resp.status === 403) throw new Error(`HutBot auth failed (HTTP ${resp.status})`);
    if (!resp.ok) {
      const t = await resp.text();
      throw new Error(`Yum API ${resp.status}: ${t.slice(0, 200)}`);
    }
    return resp.json();
  }

  // Paginate up to MAX_PAGES to collect late/missed items for targetDate or today
  const PAGE_SIZE = 200;
  const MAX_PAGES = 15;
  const allItems  = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    let data;
    try { data = await fetchPage(page * PAGE_SIZE); }
    catch (err) { return { success: false, error: err.message }; }

    const items = data.items || [];
    console.log(`[HutBot] Page ${page + 1}: ${items.length} items (total=${data.totalElements})`);
    if (!items.length) break;
    allItems.push(...items);
    if (allItems.length >= (data.totalElements || 0)) break;
  }
  console.log(`[HutBot] Collected ${allItems.length} items across pages`);

  // Convert an ISO timestamp to YYYY-MM-DD in EST (handles UTC offsets correctly)
  function toESTDate(isoStr) {
    if (!isoStr) return '';
    try {
      return new Date(isoStr).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    } catch (_) {
      return String(isoStr).slice(0, 10);
    }
  }

  // Build store name → store_id reverse lookup from store assignments
  const assignments = await db.getStoreAssignments();
  const nameToId = new Map();
  for (const [storeId, asgn] of Object.entries(assignments)) {
    if (asgn.store_name) {
      nameToId.set(asgn.store_name.toLowerCase().trim(), storeId);
    }
  }

  // Accept items for targetDate OR today (API is real-time; cron runs the next morning)
  const todayEST = toESTDate(new Date().toISOString());
  const acceptDates = new Set([targetDate, todayEST]);

  // Filter to accepted dates and map to records
  const records = [];
  for (const item of allItems) {
    // item: { id, status, dueDate, submitTimestamp, lead, submittedBy, storeName, shiftType }

    // Normalize status first — skip non-late/missed immediately
    const rawStatus = (item.status || '').toLowerCase().trim();
    const status = rawStatus === 'missed' ? 'missed' : rawStatus === 'late' ? 'late' : null;
    if (!status) continue;

    // Date filter — keep items for targetDate or today
    const itemDate = toESTDate(item.dueDate || item.submitTimestamp);
    if (itemDate && !acceptDates.has(itemDate)) continue;

    // Resolve store_id by name lookup
    const normalizedName = (item.storeName || '').toLowerCase().trim();
    let store_id = nameToId.get(normalizedName);

    // Fuzzy fallback: check if any assignment name contains or is contained by the item name
    if (!store_id && normalizedName) {
      for (const [name, id] of nameToId) {
        if (name.includes(normalizedName) || normalizedName.includes(name)) {
          store_id = id;
          break;
        }
      }
    }

    if (!store_id) {
      console.warn(`[HutBot] No store_id match for storeName="${item.storeName}" — skipping`);
      continue;
    }

    const minutesLate = (item.submitTimestamp && item.dueDate && status === 'late')
      ? Math.round((new Date(item.submitTimestamp) - new Date(item.dueDate)) / 60000)
      : null;

    // Normalize routine name: Opening / Shift Change / Close
    const rawShift = (item.shiftType || item.checklistName || '').toLowerCase();
    const routine_name = rawShift.includes('open') ? 'Opening' :
                         (rawShift.includes('close') || rawShift.includes('clos')) ? 'Close' :
                         (rawShift.includes('shift') || rawShift.includes('mid')) ? 'Shift Change' :
                         (item.shiftType || item.checklistName || 'Routine');

    records.push({
      store_id,
      store_name:    item.storeName || null,
      routine_name,
      status,
      scheduled_time: item.dueDate || null,
      minutes_late:  minutesLate,
      submitted_by:  item.submittedBy || item.lead || null,
      report_date:   itemDate || targetDate,
    });
  }

  console.log(`[HutBot] ${records.length} records matched to ${targetDate}`);
  return { success: true, records };
}

// ─────────────────────────────────────────────────────────────────────────────
//  Write flags to DB
// ─────────────────────────────────────────────────────────────────────────────

async function writeHutBotFlags(records, targetDate) {
  const assignments = await db.getStoreAssignments();
  const dow = new Date(targetDate + 'T12:00:00Z').getUTCDay();
  const isMonday = dow === 1;
  let flagsWritten = 0;

  for (const rec of records) {
    const asgn        = assignments[rec.store_id] || {};
    const isMissed    = rec.status === 'missed';
    const metric_type = isMissed ? 'ROUTINE_MISSED' : 'ROUTINE_LATE';
    const severity    = isMissed ? 'high' : 'medium';

    const prevDays = await db.getConsecutiveDays(rec.store_id, metric_type, targetDate);

    const trendDays = prevDays + 1;
    const lateNote = rec.minutes_late ? ` (${rec.minutes_late} min late)` : '';
    const flagDesc = isMissed
      ? `${rec.routine_name} — NOT COMPLETED`
      : `${rec.routine_name} — LATE${lateNote}`;

    await db.insertIntelFlag({
      store_id:     rec.store_id,
      store_name:   rec.store_name || asgn.store_name,
      area_coach:   asgn.area_coach,
      region_coach: asgn.region_coach,
      territory_vp: asgn.vp,
      metric_type,
      metric_date:  targetDate,
      value:        isMissed ? 1 : 0,
      target:       0,
      variance:     1,
      source:       'HUTBOT',
      tier:         1,
      details: {
        description:    flagDesc,
        routine_name:   rec.routine_name,
        status:         rec.status,
        scheduled_time: rec.scheduled_time || null,
        minutes_late:   rec.minutes_late   || null,
        responsible:    rec.submitted_by   || null,
        trend_days:     trendDays,
        trend_note:     trendDays >= 2 ? `${trendDays}-day trend for this routine` : null,
      },
      consecutive_days_out: trendDays,
      severity,
      is_new: prevDays === 0,
    });
    flagsWritten++;
  }

  // Monday: re-surface unacknowledged Sunday ROUTINE_MISSED flags
  if (isMonday) {
    const p = db.getPool();
    if (p) {
      const res = await p.query(`
        SELECT DISTINCT store_id FROM intel_flags
        WHERE metric_type = 'ROUTINE_MISSED'
          AND metric_date = $1::date - INTERVAL '1 day'
          AND status NOT IN ('addressed','resolved','archived')
          AND id NOT IN (SELECT flag_id FROM intel_acknowledgments WHERE flag_id IS NOT NULL)
      `, [targetDate]);

      for (const row of res.rows) {
        const asgn = assignments[row.store_id] || {};
        await db.insertIntelFlag({
          store_id:     row.store_id,
          store_name:   asgn.store_name,
          area_coach:   asgn.area_coach,
          region_coach: asgn.region_coach,
          territory_vp: asgn.vp,
          metric_type:  'ROUTINE_MISSED',
          metric_date:  targetDate,
          value: 1, target: 0, variance: 1,
          source: 'HUTBOT', tier: 1,
          details: { note: 'Monday reminder — unacknowledged Sunday routine miss' },
          consecutive_days_out: 1,
          severity: 'high',
          is_new: true,
        });
        flagsWritten++;
      }
    }
  }

  console.log(`[HutBot] ${flagsWritten} flags written for ${targetDate}`);
  return flagsWritten;
}

// ─────────────────────────────────────────────────────────────────────────────
//  Main entry point
// ─────────────────────────────────────────────────────────────────────────────

async function processHutBot(targetDate) {
  const result = await scrapeHutBot(targetDate);
  if (!result.success) return result;

  try {
    const flagsWritten = await writeHutBotFlags(result.records, targetDate);
    return {
      success: true,
      recordsProcessed: result.records.length,
      flagsWritten,
    };
  } catch (err) {
    console.error('[HutBot] DB write error:', err.message);
    return { success: false, error: `DB write failed: ${err.message}` };
  }
}

module.exports = { processHutBot, writeHutBotFlags };
