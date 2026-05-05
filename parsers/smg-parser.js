'use strict';
/**
 * smg-parser.js
 * Parses SMG360 "Comments By Comment" Excel export.
 *
 * Classifies each comment for the targetDate (previous day):
 *   Overall Satisfaction >= 4  →  shoutout  (db.insertShoutout)
 *   Overall Satisfaction <= 3  →  follow-up (db.insertIntelFlag SURVEY_FOLLOWUP)
 *
 * Excel layout (header row index 5, data from row 6+):
 *   Col 1  Feedback Date  — "M/D/YYYY H:MM:SS AM/PM"
 *   Col 2  Event Date     — same format
 *   Col 3  Unit           — "1P038876 - 038876,8080 WELLS ST,CITY,GA"
 *   Col 6  Comment
 *   Col 18 Overall Satisfaction  (integer 1–5)
 */
const XLSX = require('xlsx');
const db   = require('../services/db');

const HEADER_ROW_IDX = 5;   // 0-based row index of the column header row
const COL = {
  FEEDBACK_DATE:        1,
  EVENT_DATE:           2,
  UNIT:                 3,
  COMMENT:              6,
  OVERALL_SATISFACTION: 18,
};

// "5/3/2026 5:07:10 PM" → "2026-05-03"
function parseDateStr(val) {
  if (!val) return null;
  const datePart = String(val).split(' ')[0];
  const parts = datePart.split('/');
  if (parts.length !== 3) return null;
  const [m, d, y] = parts;
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

// "1P038876 - 038876,8080 WELLS ST,SENOIA,GA" → "038876"
function extractSmgStoreNum(unit) {
  const m = String(unit || '').match(/-\s*(\d{5,6}),/);
  return m ? m[1].replace(/^0+/, '') : null; // strip leading zeros for comparison
}

function buildStoreIndex(assignments) {
  // Maps (lower-case store_name) → store_id  AND  (numeric store_id string) → store_id
  const byName   = new Map();
  const byNumber = new Map();
  for (const [storeId, asgn] of Object.entries(assignments)) {
    if (asgn.store_name) byName.set(asgn.store_name.toLowerCase().trim(), storeId);
    // store_id itself may be numeric like "38876" or "038876"
    byNumber.set(String(storeId).replace(/^0+/, ''), storeId);
    byNumber.set(String(storeId), storeId);
  }
  return { byName, byNumber };
}

function resolveStoreId(unit, idx) {
  const smgNum = extractSmgStoreNum(unit);
  if (smgNum) {
    const found = idx.byNumber.get(smgNum);
    if (found) return found;
  }
  // Fuzzy fallback: match last portion of unit against store names
  const unitLower = String(unit || '').toLowerCase();
  for (const [name, id] of idx.byName) {
    if (unitLower.includes(name) || name.includes(unitLower.split(',')[0])) return id;
  }
  return null;
}

async function processSMG(filePath, targetDate) {
  console.log(`[SMG Parser] Processing ${filePath} for date ${targetDate}`);

  let wb;
  try {
    wb = XLSX.readFile(filePath, { type: 'file', cellDates: false, raw: false });
  } catch (err) {
    return { success: false, error: `Failed to read Excel file: ${err.message}` };
  }

  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  // Find header row (should be HEADER_ROW_IDX, but search defensively)
  let headerIdx = HEADER_ROW_IDX;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    if (rows[i] && String(rows[i][COL.UNIT] || '').toLowerCase() === 'unit') {
      headerIdx = i;
      break;
    }
  }
  const dataRows = rows.slice(headerIdx + 1);
  console.log(`[SMG Parser] Header at row ${headerIdx}, data rows: ${dataRows.length}`);

  const assignments = await db.getStoreAssignments();
  const idx         = buildStoreIndex(assignments);

  let shoutouts = 0;
  let followups = 0;
  let skipped   = 0;

  const surveyTotals = new Map(); // store_id → { total, positive, negative }

  for (const row of dataRows) {
    if (!row || row.every(c => c === null)) continue;

    const eventDate = parseDateStr(row[COL.EVENT_DATE]);
    if (eventDate !== targetDate) {
      skipped++;
      continue;
    }

    const comment = String(row[COL.COMMENT] || '').trim();
    if (!comment) { skipped++; continue; }

    const satisfaction = Number(row[COL.OVERALL_SATISFACTION]);
    if (!satisfaction || isNaN(satisfaction)) { skipped++; continue; }

    const unit    = String(row[COL.UNIT] || '');
    const storeId = resolveStoreId(unit, idx);
    if (!storeId) {
      console.warn(`[SMG Parser] No store match for unit="${unit}" — skipping`);
      skipped++;
      continue;
    }

    const asgn = assignments[storeId] || {};

    // Track survey totals
    if (!surveyTotals.has(storeId)) surveyTotals.set(storeId, { total: 0, positive: 0, negative: 0 });
    const tally = surveyTotals.get(storeId);
    tally.total++;

    if (satisfaction === 5) {
      // Shoutout — only a 5 counts as positive
      tally.positive++;
      await db.insertShoutout({
        store_id:     storeId,
        shoutout_date: targetDate,
        summary:      `Overall Satisfaction: 5/5`,
        full_comment: comment,
        source:       'SMG',
      });
      shoutouts++;
    } else if (satisfaction <= 3) {
      // Follow-up flag — 3, 2, or 1 are negative; 4 is neutral and skipped
      tally.negative++;
      const prevDays = await db.getConsecutiveDays(storeId, 'SURVEY_FOLLOWUP', targetDate);
      await db.insertIntelFlag({
        store_id:     storeId,
        store_name:   asgn.store_name,
        area_coach:   asgn.area_coach,
        region_coach: asgn.region_coach,
        territory_vp: asgn.vp,
        metric_type:  'SURVEY_FOLLOWUP',
        metric_date:  targetDate,
        value:        satisfaction,
        target:       4,
        variance:     satisfaction - 4,
        source:       'SMG',
        tier:         1,
        details: {
          comment,
          overall_satisfaction: satisfaction,
          unit,
        },
        consecutive_days_out: prevDays + 1,
        severity:  satisfaction <= 2 ? 'high' : 'medium',
        is_new:    prevDays === 0,
      });
      followups++;
    }
  }

  // Write survey log summary per store
  for (const [storeId, t] of surveyTotals) {
    await db.upsertSurveyLog({
      store_id:       storeId,
      survey_date:    targetDate,
      comment_count:  t.total,
      positive_count: t.positive,
      negative_count: t.negative,
    });
  }

  console.log(`[SMG Parser] Done — shoutouts: ${shoutouts}, follow-ups: ${followups}, skipped: ${skipped}`);
  return { success: true, shoutouts, followups, skipped, storesHit: surveyTotals.size };
}

module.exports = { processSMG };
