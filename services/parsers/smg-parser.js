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

  // ── Find header row dynamically ──────────────────────────────────────────
  // Look for a row that contains recognizable SMG column headers.
  // Fallback to hardcoded row 5 / col indices if not found.
  const HEADER_KEYWORDS = ['comment', 'unit', 'source', 'overall', 'feedback'];
  let headerRowIdx = 5; // default
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const r = rows[i];
    if (!r) continue;
    const cells = r.map(c => (c ? String(c).toLowerCase() : ''));
    const matches = HEADER_KEYWORDS.filter(kw => cells.some(c => c.includes(kw)));
    if (matches.length >= 2) { headerRowIdx = i; break; }
  }
  const headerRow = rows[headerRowIdx] || [];
  const dataStartIdx = headerRowIdx + 1;

  // Map column name → index (case-insensitive, partial match)
  function colIdx(keywords) {
    for (const kw of keywords) {
      const idx = headerRow.findIndex(h => h && String(h).toLowerCase().includes(kw));
      if (idx !== -1) return idx;
    }
    return -1;
  }

  const COL = {
    response_id:          colIdx(['responseid', 'response id', 'response_id'])          !== -1 ? colIdx(['responseid', 'response id', 'response_id']) : 0,
    feedback_date:        colIdx(['feedbackdate', 'feedback date', 'feedback_date'])     !== -1 ? colIdx(['feedbackdate', 'feedback date', 'feedback_date']) : 1,
    event_date:           colIdx(['eventdate', 'event date', 'event_date', 'visitdate']) !== -1 ? colIdx(['eventdate', 'event date', 'event_date', 'visitdate']) : 2,
    unit:                 colIdx(['unit'])                                               !== -1 ? colIdx(['unit']) : 3,
    source:               colIdx(['source'])                                             !== -1 ? colIdx(['source']) : 4,
    open_end:             colIdx(['openend', 'open end', 'open_end'])                   !== -1 ? colIdx(['openend', 'open end', 'open_end']) : 5,
    comment:              colIdx(['comment'])                                            !== -1 ? colIdx(['comment']) : 6,
    social_rating:        colIdx(['socialrating', 'social rating', 'social_rating'])    !== -1 ? colIdx(['socialrating', 'social rating', 'social_rating']) : 13,
    overall_satisfaction: colIdx(['overall'])                                            !== -1 ? colIdx(['overall']) : 18,
  };

  console.log(`[SMG Parser] Header row ${headerRowIdx}, data starts ${dataStartIdx}, col map:`, JSON.stringify(COL));
  console.log(`[SMG Parser] Header row contents:`, JSON.stringify(headerRow.slice(0, 25)));

  const comments = [];
  for (let i = dataStartIdx; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    const store_id = parseStoreId(row[COL.unit]);
    if (!store_id) continue;
    const comment = row[COL.comment] ? String(row[COL.comment]).trim() : null;
    if (!comment || comment.length < 5) continue;
    const overallRaw = row[COL.overall_satisfaction];
    const socialRaw  = row[COL.social_rating];
    comments.push({
      store_id,
      response_id:          row[COL.response_id]   ? String(row[COL.response_id]).trim()   : null,
      feedback_date:        row[COL.feedback_date]  ? String(row[COL.feedback_date]).trim()  : null,
      event_date:           row[COL.event_date]     ? String(row[COL.event_date]).trim()     : null,
      source:               row[COL.source]         ? String(row[COL.source]).trim()         : null,
      open_end:             row[COL.open_end]       ? String(row[COL.open_end]).trim()       : null,
      comment,
      overall_satisfaction: overallRaw != null ? parseFloat(String(overallRaw)) : null,
      social_rating:        socialRaw  != null ? parseFloat(String(socialRaw))  : null,
    });
  }
  return comments;
}

async function classifyComment(client, comment) {
  try {
    const msg = await client.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{
        role:    'user',
        content: `Analyze this Pizza Hut customer comment. Return JSON only — no other text:
{
  "sentiment": "POSITIVE|NEGATIVE|NEUTRAL",
  "summary": "core issue or highlight in 10 words or less",
  "categories": ["rude_staff","poor_food","poor_service","wait_time","wrong_order","cleanliness","positive_staff","great_food","other"],
  "name_mentioned": "employee first name if named in comment, else null",
  "severity": "high|medium|low"
}

Rules: NEGATIVE if complaint, rude experience, bad food, names called out negatively. HIGH severity if employee named negatively or very rude. Only pick categories that apply.

Comment: "${comment.replace(/"/g, "'").substring(0, 500)}"`,
      }],
    });
    const text = msg.content[0].text.trim();
    const json = JSON.parse(text.match(/\{.*?\}/s)[0]);
    return {
      sentiment:      json.sentiment     || 'NEUTRAL',
      summary:        json.summary       || '',
      categories:     Array.isArray(json.categories) ? json.categories : [],
      name_mentioned: json.name_mentioned || null,
      severity:       json.severity      || 'medium',
    };
  } catch (err) {
    console.warn('[SMG] Classification error:', err.message);
    return { sentiment: 'NEUTRAL', summary: '', categories: [], name_mentioned: null, severity: 'medium' };
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

  // Track per-store counts and complaint details for survey log
  const storeCounts = {};
  let flagsWritten = 0, shoutoutsWritten = 0;

  for (const c of comments) {
    if (!storeCounts[c.store_id]) {
      storeCounts[c.store_id] = { total: 0, positive: 0, negative: 0, complaints: [] };
    }
    storeCounts[c.store_id].total++;

    const { sentiment, summary, categories, name_mentioned, severity } = await classifyComment(client, c.comment);

    if (sentiment === 'POSITIVE') {
      storeCounts[c.store_id].positive++;
      await db.insertShoutout({
        store_id:      c.store_id,
        shoutout_date: targetDate,
        summary,
        full_comment:  c.comment,
        source:        c.source,
      });
      shoutoutsWritten++;
    } else if (sentiment === 'NEGATIVE') {
      storeCounts[c.store_id].negative++;
      storeCounts[c.store_id].complaints.push({
        summary,
        categories,
        name_mentioned,
        severity,
        event_date:           c.event_date || c.feedback_date,
        source:               c.source,
        overall_satisfaction: c.overall_satisfaction,
        comment:              c.comment.substring(0, 400), // cap length
      });
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
    const complaints = counts.complaints;

    // High if any complaint names an employee negatively or has rude_staff, else by count
    const hasHighSeverity = complaints.some(c => c.name_mentioned || c.categories.includes('rude_staff') || c.severity === 'high');
    const flagSeverity = hasHighSeverity ? 'high' : counts.negative >= 3 ? 'high' : 'medium';

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
      details: {
        negative_count:    counts.negative,
        total_comments:    counts.total,
        names_mentioned:   complaints.filter(c => c.name_mentioned).map(c => c.name_mentioned),
        top_categories:    [...new Set(complaints.flatMap(c => c.categories))],
        complaints,
        trend_days:        prevDays + 1,
        trend_note:        prevDays >= 1 ? `${prevDays + 1}-day trend of complaints` : null,
      },
      consecutive_days_out: prevDays + 1,
      severity:     flagSeverity,
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

/**
 * Map a raw SMG API comment object → our internal comment shape.
 * SMG API returns varied field names — handle gracefully.
 */
function mapAPIComment(raw) {
  // Store ID: look for location field with a 6-digit number
  const locStr = raw.locationName || raw.location || raw.locationId || raw.storeName || '';
  const storeMatch = String(locStr).match(/(\d{6})/);
  const store_id = storeMatch ? storeMatch[1] : null;

  // Comment text
  const comment = raw.comment || raw.commentText || raw.text || raw.verbatim || raw.responseText || '';

  // Source
  const srcRaw = raw.sourceName || raw.source || raw.surveyType || raw.channel || 'SMG';
  let source = 'SMG';
  if (/ges|guest exp/i.test(srcRaw))         source = 'GES';
  else if (/social|google|yelp/i.test(srcRaw)) source = 'Social';
  else if (/doordash/i.test(srcRaw))          source = 'DoorDash';
  else if (/uber/i.test(srcRaw))              source = 'Uber Eats';
  else if (/grubhub/i.test(srcRaw))           source = 'GrubHub';
  else if (srcRaw)                             source = srcRaw;

  // Date
  const event_date = (raw.visitDate || raw.eventDate || raw.feedbackDate || raw.createdDate || '').slice(0, 10);

  // Rating
  const overall_satisfaction = raw.overallSatisfaction ?? raw.rating ?? raw.score ?? null;

  return { store_id, comment: comment.trim(), source, event_date, overall_satisfaction };
}

/**
 * Process SMG comments fetched from the API (no file needed).
 * Accepts the raw array from downloadSMGCommentsAPI().
 */
async function processSMGFromComments(apiComments, targetDate) {
  console.log(`[SMG] Processing ${apiComments.length} API comments for ${targetDate}`);

  // Map to internal format and filter out entries missing store/comment
  const comments = apiComments
    .map(mapAPIComment)
    .filter(c => c.store_id && c.comment.length > 3);

  console.log(`[SMG] ${comments.length} valid comments after mapping`);
  if (!comments.length) return { success: true, commentsProcessed: 0, flagsWritten: 0, shoutoutsWritten: 0 };

  const assignments = await db.getStoreAssignments();
  const client = new Anthropic();

  const storeCounts = {};
  let flagsWritten = 0, shoutoutsWritten = 0;

  for (const c of comments) {
    // Skip non-Ayvaz stores
    if (!assignments[c.store_id]) continue;

    if (!storeCounts[c.store_id]) storeCounts[c.store_id] = { total: 0, positive: 0, negative: 0, complaints: [] };
    storeCounts[c.store_id].total++;

    const { sentiment, summary, categories, name_mentioned, severity } = await classifyComment(client, c.comment);

    if (sentiment === 'POSITIVE') {
      storeCounts[c.store_id].positive++;
      await db.insertShoutout({ store_id: c.store_id, shoutout_date: targetDate, summary, full_comment: c.comment, source: c.source });
      shoutoutsWritten++;
    } else if (sentiment === 'NEGATIVE') {
      storeCounts[c.store_id].negative++;
      storeCounts[c.store_id].complaints.push({
        summary, categories, name_mentioned, severity,
        event_date: c.event_date || targetDate,
        source: c.source,
        overall_satisfaction: c.overall_satisfaction,
        comment: c.comment.substring(0, 400),
      });
    }
  }

  // Survey log + flags — reuse same logic as processSMG
  for (const [store_id, counts] of Object.entries(storeCounts)) {
    await db.upsertSurveyLog({ store_id, survey_date: targetDate, comment_count: counts.total, positive_count: counts.positive, negative_count: counts.negative });
  }
  for (const [store_id, counts] of Object.entries(storeCounts)) {
    if (!counts.negative) continue;
    const asgn = assignments[store_id] || {};
    const complaints = counts.complaints;
    const hasHigh = complaints.some(c => c.name_mentioned || c.categories.includes('rude_staff') || c.severity === 'high');
    const flagSeverity = hasHigh ? 'high' : counts.negative >= 3 ? 'high' : 'medium';
    const prevDays = await db.getConsecutiveDays(store_id, 'GUEST_COMPLAINT', targetDate);
    await db.insertIntelFlag({
      store_id, store_name: asgn.store_name, area_coach: asgn.area_coach,
      region_coach: asgn.region_coach, territory_vp: asgn.vp,
      metric_type: 'GUEST_COMPLAINT', metric_date: targetDate,
      value: counts.negative, target: 0, variance: counts.negative,
      source: 'SMG', tier: 1,
      details: { negative_count: counts.negative, total_comments: counts.total,
        names_mentioned: complaints.filter(c => c.name_mentioned).map(c => c.name_mentioned),
        top_categories: [...new Set(complaints.flatMap(c => c.categories))],
        complaints, trend_days: prevDays + 1,
        trend_note: prevDays >= 1 ? `${prevDays + 1}-day trend of complaints` : null },
      consecutive_days_out: prevDays + 1, severity: flagSeverity, is_new: prevDays === 0,
    });
    flagsWritten++;
  }

  console.log(`[SMG API] Done — ${flagsWritten} flags, ${shoutoutsWritten} shoutouts`);
  return { success: true, commentsProcessed: comments.length, flagsWritten, shoutoutsWritten };
}

module.exports = { processSMG, parseSMGFile, processSMGFromComments };
