'use strict';
/**
 * SMG Guest Comments Parser — 360.smg.com Excel export
 * Uses Claude Haiku API for per-comment sentiment classification.
 *
 * Col map (0-indexed, data starts row 6):
 *  0=ResponseID  1=FeedbackDate  2=EventDate
 *  3=Unit ("1P039375 - 039375,4221 BELLS FERRY...")
 *  4=Source  5=OpenEnd  6=Comment  13=SocialRating  18=OverallSatisfaction
 */
const XLSX      = require('xlsx');
const Anthropic = require('@anthropic-ai/sdk');
const db        = require('../db');

// "1P039375 - 039375,4221 BELLS FERRY DR..." → "039375"
function parseStoreId(unit) {
  if (!unit) return null;
  const m = String(unit).match(/1P(\d{6})\s*-\s*(\d{6})/);
  if (m) return m[2];
  const m2 = String(unit).match(/(\d{6})/);
  return m2 ? m2[1] : null;
}

function parseSMGFile(filePath) {
  const wb   = XLSX.readFile(filePath, { cellDates: false, raw: true });
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
  const comments = [];
  // Header is row index 5, data starts at index 6
  for (let i = 6; i < rows.length; i++) {
    const row = rows[i];
    if (!row[0] && !row[3]) continue;
    const store_id = parseStoreId(row[3]);
    if (!store_id) continue;
    const comment = row[6] ? String(row[6]).trim() : null;
    if (!comment || comment.length < 5) continue;
    comments.push({
      store_id,
      response_id:   row[0] ? String(row[0]).trim() : null,
      feedback_date: row[1] ? String(row[1]).trim() : null,
      source:        row[4] ? String(row[4]).trim() : null,
      comment,
    });
  }
  return comments;
}

async function classifyComment(client, comment) {
  try {
    const msg = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 80,
      messages: [{
        role:    'user',
        content: `Classify this Pizza Hut customer comment as POSITIVE, NEGATIVE, or NEUTRAL.\nIf NEGATIVE, extract the core issue in 8 words or less.\nIf POSITIVE, extract the highlight in 8 words or less.\nReturn JSON only: {"sentiment":"POSITIVE|NEGATIVE|NEUTRAL","summary":"..."}\n\nComment: "${comment}"`,
      }],
    });
    const text = msg.content[0].text.trim();
    const json = JSON.parse(text.match(/\{.*\}/s)[0]);
    return { sentiment: json.sentiment || 'NEUTRAL', summary: json.summary || '' };
  } catch (err) {
    console.warn('[SMG] Classification error:', err.message);
    return { sentiment: 'NEUTRAL', summary: '' };
  }
}

async function processSMG(filePath, targetDate) {
  console.log(`[SMG] Parsing ${filePath} for ${targetDate}`);
  let comments;
  try {
    comments = parseSMGFile(filePath);
  } catch (err) {
    console.error('[SMG] Parse error:', err.message);
    return { success: false, error: err.message };
  }

  console.log(`[SMG] ${comments.length} comments to classify`);
  const assignments = await db.getStoreAssignments();
  const client = new Anthropic();

  // Track per-store counts for survey log
  const storeCounts = {};
  let flagsWritten = 0, shoutoutsWritten = 0;

  for (const c of comments) {
    if (!storeCounts[c.store_id]) storeCounts[c.store_id] = { total: 0, positive: 0, negative: 0 };
    storeCounts[c.store_id].total++;

    const { sentiment, summary } = await classifyComment(client, c.comment);

    if (sentiment === 'POSITIVE') {
      storeCounts[c.store_id].positive++;
      await db.insertShoutout({
        store_id:     c.store_id,
        shoutout_date: targetDate,
        summary,
        full_comment: c.comment,
        source:       c.source,
      });
      shoutoutsWritten++;
    } else if (sentiment === 'NEGATIVE') {
      storeCounts[c.store_id].negative++;
    }
  }

  // Write survey log (one row per store per day)
  for (const [store_id, counts] of Object.entries(storeCounts)) {
    await db.upsertSurveyLog({
      store_id,
      survey_date:    targetDate,
      comment_count:  counts.total,
      positive_count: counts.positive,
      negative_count: counts.negative,
    });
  }

  // Create GUEST_COMPLAINT flags for stores with negative comments
  for (const [store_id, counts] of Object.entries(storeCounts)) {
    if (counts.negative === 0) continue;
    const asgn = assignments[store_id] || {};
    const severity = counts.negative >= 3 ? 'high' : 'medium';
    const prevDays = await db.getConsecutiveDays(store_id, 'GUEST_COMPLAINT', targetDate);
    await db.insertIntelFlag({
      store_id,
      store_name:   asgn.store_name,
      area_coach:   asgn.area_coach,
      region_coach: asgn.region_coach,
      territory_vp: asgn.vp,
      metric_type:  'GUEST_COMPLAINT',
      metric_date:  targetDate,
      value:        counts.negative,
      target:       0,
      variance:     counts.negative,
      source:       'SMG',
      tier:         1,
      details:      { negative_count: counts.negative, total_comments: counts.total },
      consecutive_days_out: prevDays + 1,
      severity,
      is_new:       prevDays === 0,
    });
    flagsWritten++;
  }

  // PUSH_SURVEYS: stores with no surveys for 2+ consecutive days
  const allStoreIds = Object.keys(assignments);
  const noSurveyStores = await db.getStoresWithNoRecentSurveys(allStoreIds, targetDate);
  for (const store_id of noSurveyStores) {
    const asgn = assignments[store_id] || {};
    const prevDays = await db.getConsecutiveDays(store_id, 'PUSH_SURVEYS', targetDate);
    await db.insertIntelFlag({
      store_id,
      store_name:   asgn.store_name,
      area_coach:   asgn.area_coach,
      region_coach: asgn.region_coach,
      territory_vp: asgn.vp,
      metric_type:  'PUSH_SURVEYS',
      metric_date:  targetDate,
      value:        2, target: 0, variance: 2,
      source:       'SMG',
      tier:         1,
      details:      { note: 'No survey comments received for 2+ consecutive days' },
      consecutive_days_out: prevDays + 1,
      severity:     'medium',
      is_new:       prevDays === 0,
    });
    flagsWritten++;
  }

  console.log(`[SMG] Done — ${flagsWritten} flags, ${shoutoutsWritten} shoutouts, ${noSurveyStores.length} push-survey flags`);
  return { success: true, commentsProcessed: comments.length, flagsWritten, shoutoutsWritten };
}

module.exports = { processSMG, parseSMGFile };
