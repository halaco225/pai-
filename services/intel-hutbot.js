'use strict';
/**
 * HutBot — Yum SuperApp Routines via REST API.
 *
 * Auth: stored Cookie header in hutbot_auth DB table.
 * When the cookie expires the API returns 401/403; we mark it invalid
 * and the UI shows a flashing "Authorize HutBot" button so the user can
 * paste a fresh cookie from Chrome DevTools.
 *
 * API endpoint (reachable from Render via CloudFront, no VPN needed):
 *   POST https://api.superapp.yum.com/admin-proxy/checklists/search?offset=0&pageSize=100
 *   Body: { statuses: ['late', 'missed'] }
 *   Auth: Cookie: <stored value>
 */
const db = require('./db');

const YUM_API = 'https://api.superapp.yum.com/admin-proxy/checklists/search';

// ─────────────────────────────────────────────────────────────────────────────
//  Scrape via REST API
// ─────────────────────────────────────────────────────────────────────────────

async function scrapeHutBot(targetDate) {
  const auth = await db.getHutBotAuth();

  if (!auth || !auth.cookie_value) {
    console.warn('[HutBot] No session cookie stored — authorization required');
    return { success: false, needsReauth: true, error: 'No HutBot session cookie stored — click Authorize HutBot in the dashboard' };
  }
  if (!auth.is_valid) {
    console.warn('[HutBot] Session cookie marked invalid — re-authorization required');
    return { success: false, needsReauth: true, error: 'HutBot session expired — click Authorize HutBot in the dashboard' };
  }

  console.log(`[HutBot] Calling Yum API for ${targetDate}`);

  let respData;
  try {
    const response = await fetch(`${YUM_API}?offset=0&pageSize=100`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Cookie': auth.cookie_value,
      },
      body: JSON.stringify({ statuses: ['late', 'missed'] }),
    });

    console.log(`[HutBot] API response: ${response.status}`);

    if (response.status === 401 || response.status === 403) {
      await db.markHutBotAuthInvalid();
      return { success: false, needsReauth: true, error: `HutBot session expired (HTTP ${response.status}) — click Authorize HutBot in the dashboard` };
    }

    if (!response.ok) {
      const text = await response.text();
      console.error(`[HutBot] API error ${response.status}: ${text.slice(0, 300)}`);
      return { success: false, error: `Yum API returned ${response.status}: ${text.slice(0, 200)}` };
    }

    respData = await response.json();
  } catch (err) {
    console.error('[HutBot] API request failed:', err.message);
    return { success: false, error: `HutBot API request failed: ${err.message}` };
  }

  const allItems = respData.items || [];
  console.log(`[HutBot] API returned ${allItems.length} items (totalElements=${respData.totalElements})`);

  // Build store name → store_id reverse lookup from store assignments
  const assignments = await db.getStoreAssignments();
  const nameToId = new Map();
  for (const [storeId, asgn] of Object.entries(assignments)) {
    if (asgn.store_name) {
      nameToId.set(asgn.store_name.toLowerCase().trim(), storeId);
    }
  }

  // Filter to target date and map to records
  const records = [];
  for (const item of allItems) {
    // item: { id, status, dueDate, submitTimestamp, lead, submittedBy, storeName, shiftType }

    // Date filter — API may return more than one day; keep only targetDate
    const itemDate = (item.dueDate || item.submitTimestamp || '').slice(0, 10);
    if (itemDate && itemDate !== targetDate) continue;

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

    const status = item.status === 'missed' ? 'missed' : 'late';
    const minutesLate = (item.submitTimestamp && item.dueDate)
      ? Math.round((new Date(item.submitTimestamp) - new Date(item.dueDate)) / 60000)
      : null;

    records.push({
      store_id,
      store_name:    item.storeName || null,
      routine_name:  item.shiftType || item.checklistName || 'Routine',
      status,
      scheduled_time: item.dueDate || null,
      minutes_late:  minutesLate,
      submitted_by:  item.submittedBy || item.lead || null,
      report_date:   targetDate,
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
        routine_name:   rec.routine_name,
        status:         rec.status,
        scheduled_time: rec.scheduled_time || null,
        minutes_late:   rec.minutes_late   || null,
        submitted_by:   rec.submitted_by   || null,
      },
      consecutive_days_out: prevDays + 1,
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
