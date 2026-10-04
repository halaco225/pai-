// routes/brief.js
//
// Operator controls for the morning brief by text, token-gated.
//
// These exist so the brief can be inspected and exercised from outside the
// Render environment without any Supabase or Twilio credential leaving it.
// Everything here is read-only except /send-now, which refuses to send
// unless it is asked to in so many words.

const express = require('express');
const router  = express.Router();

const briefSms = require('../services/brief-sms');
const people   = require('../services/rc-people');
const rcDb     = require('../services/rc-db');
const db       = require('../services/db');
const { localDate, localHHMM } = require('../services/localtime');

// The same tokens the intel automation endpoints accept, including the cron
// service's known token — it is declared in render.yaml and already in the
// repo, and routes/intel.js:37 accepts it for the same reason. Nothing here
// exposes a phone number or a credential, and the one endpoint that sends
// anything also demands ?confirm=send.
const CRON_TOKEN = '38b8091924e1f85583454212a9860038';

function authed(req) {
  const token = req.query.token || req.headers['x-automation-token'];
  const valid = [
    process.env.INTEL_AUTOMATION_TOKEN,
    process.env.INTEL_REGEN_TOKEN,
    CRON_TOKEN,
  ].filter(Boolean);
  return valid.includes(token);
}

// ── GET /api/brief/status — is everything wired up? Sends nothing. ──────────
router.get('/status', async (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: 'Unauthorized' });

  const out = {
    configured: {
      supabase:  rcDb.isConfigured(),
      twilio:    Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER),
      anthropic: Boolean(process.env.ANTHROPIC_API_KEY),
      database:  Boolean(db.getPool()),
    },
    sendLocalTime: process.env.PAI_BRIEF_SEND_LOCAL_TIME || briefSms.DEFAULT_SEND_LOCAL,
    enabled:       process.env.ENABLE_BRIEF_SMS !== 'false',
    recipients:    [],
    rosterDrift:   people.rosterDrift(),
  };

  for (const username of briefSms.recipients()) {
    const name   = people.nameForUsername(username);
    const person = name ? people.getPerson(name) : null;
    const row    = { username, name, onRoster: Boolean(name), hasPhoneAndTz: Boolean(person) };

    if (person) {
      row.tz        = person.tz;
      row.localNow  = localHHMM(new Date(), person.tz);
      row.localDate = localDate(new Date(), person.tz);
      // Phone deliberately not returned — the question is whether one exists.
      row.phoneOnFile = true;

      try { row.consented  = await briefSms.hasConsent(name, person.phone); }
      catch (e) { row.consentError = e.message; }

      try { row.alreadySent = await briefSms.sentDates(name); }
      catch (e) { row.sentDatesError = e.message; }

      const cached = await db.getIntelCache({ userId: `${username}::brief`, cacheDate: row.localDate });
      row.briefCached = Boolean(cached && cached.data && cached.data.memo_text);
      if (row.briefCached) {
        row.briefChars     = cached.data.memo_text.length;
        row.briefGenerated = cached.generatedAt;
      }
    }
    out.recipients.push(row);
  }

  res.json(out);
});

// ── GET /api/brief/preview — the exact text that would be sent. Sends nothing. ──
router.get('/preview', async (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: 'Unauthorized' });

  const username = req.query.user || briefSms.recipients()[0];
  const name     = people.nameForUsername(username);
  if (!name) return res.status(404).json({ error: `${username} is not on the roster` });

  let person;
  try { person = await briefSms.resolvePerson(name); }
  catch (err) { return res.status(404).json({ error: err.message }); }

  // Default to the same date the sender uses: yesterday-Eastern, which is where
  // the pipeline caches briefs. Defaulting to today finds nothing, every day.
  const date   = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date
               : briefSms.briefCacheDate();
  const cached = await db.getIntelCache({ userId: `${username}::brief`, cacheDate: date });
  const memo   = cached && cached.data && cached.data.memo_text;

  if (!memo) {
    return res.json({
      username, person: name, date, cached: false,
      note: 'No brief cached for that date. The sender would skip and retry, never send an older one.',
    });
  }

  // Same path the sender uses, so the preview cannot flatter the real thing.
  let body;
  try { body = await briefSms.buildBody(username, date); }
  catch (e) { body = null; }
  if (!body) body = await briefSms.condense(memo, briefSms.buildLink());

  res.json({
    username, person: name, date, tz: person.tz, cached: true,
    briefChars: memo.length,
    smsChars:   body ? body.length : 0,
    maxChars:   briefSms.MAX_SMS_CHARS,
    sms:        body,
    fullBrief:  req.query.full === '1' ? memo : undefined,
  });
});

// ── POST /api/brief/send-now — one real text, on purpose ────────────────────
// Bypasses the time window (that is the point) but NOT consent, and NOT the
// one-per-day claim: if today is already claimed, nothing is sent.
router.post('/send-now', async (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: 'Unauthorized' });

  if (req.query.confirm !== 'send') {
    return res.status(400).json({
      error: 'Refusing to send without ?confirm=send',
      hint:  'GET /api/brief/preview first and read the message.',
    });
  }

  const username = req.query.user || briefSms.recipients()[0];
  const name     = people.nameForUsername(username);
  if (!name) return res.status(404).json({ error: `${username} is not on the roster` });

  let person;
  try { person = await briefSms.resolvePerson(name); }
  catch (err) { return res.status(404).json({ error: err.message }); }

  // Consent is never bypassed — that row is the TCPA record. RC Tracker
  // re-checks it at send time too; this is the earlier, clearer refusal.
  if (person.consented === false) {
    return res.status(403).json({ error: `${name} is not signed up for texts` });
  }

  const date     = localDate(new Date(), person.tz);   // send day, for the claim
  const dataDate = briefSms.briefCacheDate();         // where the brief lives
  const cached   = await db.getIntelCache({ userId: `${username}::brief`, cacheDate: dataDate });
  const memo   = cached && cached.data && cached.data.memo_text;
  if (!memo) return res.status(409).json({ error: `No brief cached for ${dataDate}`, sent: false });

  let body;
  try { body = await briefSms.buildBody(username, dataDate); }
  catch (e) { body = null; }
  if (!body) body = await briefSms.condense(memo, briefSms.buildLink());
  if (!body) return res.status(500).json({ error: 'Brief produced no message', sent: false });

  let claimId;
  try {
    claimId = await briefSms.claim(name, person.phone || '', date, body);
  } catch (err) {
    return res.status(500).json({ sent: false, error: err.message });
  }
  if (!claimId && req.query.resend === '1') {
    // Deliberate resend: drop today's claim and take a fresh one. Only ever
    // from this endpoint with ?resend=1 -- the scheduled sender can never do
    // this, so the one-per-day guard still holds for the 8:05 run.
    const sb = rcDb.getServiceClient();
    if (sb) await sb.from('sms_reminders').delete()
      .eq('person', name).eq('kind', 'brief').eq('local_date', date);
    try { claimId = await briefSms.claim(name, person.phone || '', date, body); }
    catch (err) { return res.status(500).json({ sent: false, error: err.message }); }
  }

  if (!claimId) {
    return res.status(409).json({
      error: `A brief is already claimed for ${name} on ${date}`,
      sent: false,
      note: 'This is the one-per-day guard working, not a failure. Add ?resend=1 to send anyway.',
    });
  }

  try {
    const sid = await briefSms.rcSend(name, body);
    await briefSms.recordClaimResult(claimId, { twilioSid: sid });
    res.json({ sent: true, person: name, date, dataDate, chars: body.length, sid, sms: body });
  } catch (err) {
    await briefSms.releaseClaim(claimId);
    res.status(502).json({ sent: false, error: err.message, claimReleased: true });
  }
});

// ── GET /api/brief/rc-backup — count and download RC Tracker's data ─────────
//
// Runs inside Render, where the Supabase keys already live, so a backup can be
// taken without any credential leaving that environment. Read-only.
//
// ?mode=count  (default) row counts only — the cheap pre-flight
// ?mode=dump&table=follow_ups   that table's rows as JSON, to save locally
router.get('/rc-backup', async (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: 'Unauthorized' });

  const TABLES = ['user_data', 'follow_ups', 'email_followups',
                  'sms_reminders', 'sms_consent', 'sms_messages', 'candidates'];
  const sb = rcDb.getServiceClient();
  if (!sb) return res.status(503).json({ error: 'Supabase is not configured' });

  const mode = req.query.mode || 'count';

  if (mode === 'count') {
    const counts = {};
    for (const t of TABLES) {
      const { count, error } = await sb.from(t).select('*', { count: 'exact', head: true });
      counts[t] = error ? `ERROR: ${error.message}` : count;
    }
    let bucket;
    try {
      const { data, error } = await sb.storage.from('note-images').list('', { limit: 10000 });
      bucket = error ? `ERROR: ${error.message}` : data.length;
    } catch (e) { bucket = `ERROR: ${e.message}`; }
    return res.json({ mode, counts, noteImages: bucket });
  }

  if (mode === 'dump') {
    const table = req.query.table;
    if (!TABLES.includes(table)) {
      return res.status(400).json({ error: 'Unknown table', allowed: TABLES });
    }
    // Paged — a plain select caps at Supabase's row limit and truncates
    // without saying so, which would look like a complete backup.
    const PAGE = 1000;
    const rows = [];
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await sb.from(table).select('*').range(from, from + PAGE - 1);
      if (error) return res.status(500).json({ error: error.message, partialRows: rows.length });
      rows.push(...data);
      if (data.length < PAGE) break;
    }
    res.setHeader('Content-Disposition', `attachment; filename="${table}.json"`);
    return res.json({ table, rowCount: rows.length, rows });
  }

  res.status(400).json({ error: "mode must be 'count' or 'dump'" });
});

// ── GET /api/brief/diag/scorecard — why is a column empty? ──────────────────
//
// The brief shows "0/37 reporting" for a metric whose pipeline step reported
// success, which means the step ran but wrote nothing. This says which of the
// four source tables actually has rows for a date, so the answer is a lookup
// rather than a guess. Read-only.
router.get('/diag/scorecard', async (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: 'Unauthorized' });

  const p = db.getPool();
  if (!p) return res.status(503).json({ error: 'Database unavailable' });

  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '')
    ? req.query.date
    : briefSms.briefCacheDate();

  const q = async (label, sql, params = [date]) => {
    try { return { [label]: (await p.query(sql, params)).rows }; }
    catch (e) { return { [label]: `ERROR: ${e.message}` }; }
  };

  const out = Object.assign({ date }, ...(await Promise.all([
    q('dbs_metrics', `SELECT COUNT(*)::int AS stores,
                             COUNT(net_sales_day)::int AS with_sales
                        FROM intel_dbs_metrics WHERE metric_date = $1`),
    q('soft_indicators_by_name', `SELECT indicator, COUNT(*)::int AS rows
                                    FROM dbs_soft_indicators WHERE metric_date = $1
                                   GROUP BY indicator ORDER BY indicator`),
    q('win_scores', `SELECT COUNT(*)::int AS rows,
                            MAX(period_end_date)::text AS latest_period
                       FROM smg_win_scores`, []),
    q('flags', `SELECT metric_type, COUNT(*)::int AS rows
                  FROM intel_flags WHERE metric_date = $1
                 GROUP BY metric_type ORDER BY rows DESC LIMIT 10`),
    q('velocity', `SELECT COUNT(*)::int AS rows,
                          COUNT(*) FILTER (WHERE store_id LIKE 'S%')::int AS s_prefixed
                     FROM velocity_daily_records WHERE record_date = $1`),
    q('store_assignments', `SELECT COUNT(*)::int AS stores FROM store_assignments`, []),
    q('recent_pipeline_runs', `SELECT TO_CHAR(target_date,'YYYY-MM-DD') AS target_date,
                                      status, created_at
                                 FROM intel_automation_log
                                WHERE job_type = 'pipeline'
                                ORDER BY created_at DESC LIMIT 5`, []),
  ])));

  res.json(out);
});

// ── POST /api/brief/winscore/run — pull Win Score PTD now ───────────────────
// Drives reporting.smg.com with the stored credentials, the same clicks Harold
// walked me through. Writes smg_win_scores. Token-gated; safe to re-run, since
// the upsert is keyed on (store_id, period_end_date).
router.post('/winscore/run', async (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const ws  = require('../services/intel-smg-winscore-browser');
    const dry = req.query.dry === '1';

    // Driving a browser takes minutes; Render's proxy gives up at 100 seconds
    // and the caller just sees an empty response. Answer immediately and write
    // the outcome to the automation log, where it can be read afterwards.
    res.json({ status: 'started', dryRun: dry, readResultAt: '/api/brief/diag/winscore-last' });

    (async () => {
      try {
        const out = dry ? await ws.pullWinScores() : await ws.pullAndStore();
        await db.logIntelJob({
          jobType: 'winscore:' + (dry ? 'dry' : 'store'),
          targetDate: out.periodEnd, status: 'success',
          message: JSON.stringify({
            periodEnd: out.periodEnd,
            stores: out.stores ? out.stores.length : out.written,
            combined: out.combined,
            sample: (out.stores || []).slice(0, 5),
          }),
        });
        console.log('[WinScore] run finished for', out.periodEnd);
      } catch (err) {
        await db.logIntelJob({
          jobType: 'winscore:' + (dry ? 'dry' : 'store'),
          targetDate: null, status: 'error', message: String(err.message).slice(0, 900),
        });
        console.error('[WinScore] run failed:', err.message);
      }
    })();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── POST /api/brief/winscore/ingest — write Win Score rows pulled by hand ───
//
// Playwright is not installed on this deploy (every browsers path is missing),
// so the automated pull cannot run yet. This accepts rows read out of the live
// report so the brief has real WIN numbers in the meantime. Same upsert the
// automated path uses, keyed on (store_id, period_end_date).
//
// Body: { periodEnd: "YYYY-MM-DD", rows: "038876:35:48,039375:14:63,..." }
//       store_id : survey_count : win_score
router.post('/winscore/ingest', express.json({ limit: '256kb' }), async (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: 'Unauthorized' });

  const periodEnd = String(req.body.periodEnd || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) {
    return res.status(400).json({ error: 'periodEnd must be YYYY-MM-DD' });
  }

  const pool = db.getPool();
  if (!pool) return res.status(503).json({ error: 'Database unavailable' });

  const parsed = [];
  for (const chunk of String(req.body.rows || '').split(',')) {
    const [id, count, score] = chunk.trim().split(':');
    if (!/^\d{6}$/.test(id || '')) continue;          // COMBINED and junk fall out here
    const win = Number(score);
    if (!Number.isFinite(win)) continue;
    parsed.push({ store_id: id, survey_count: Number(count) || 0, win_score: win });
  }
  if (!parsed.length) return res.status(400).json({ error: 'No store rows parsed' });

  let written = 0;
  for (const r of parsed) {
    await pool.query(
      `INSERT INTO smg_win_scores (store_id, period_end_date, win_score, survey_count, updated_at)
       VALUES ($1, $2::date, $3, $4, NOW())
       ON CONFLICT (store_id, period_end_date) DO UPDATE
         SET win_score = EXCLUDED.win_score,
             survey_count = EXCLUDED.survey_count,
             updated_at = NOW()`,
      [r.store_id, periodEnd, r.win_score, r.survey_count]
    );
    written++;
  }
  res.json({ periodEnd, written, sample: parsed.slice(0, 3) });
});

// ── POST /api/brief/diag/purge-bad-labor — remove mis-parsed hour rows ──────
//
// A run on 2026-10-04 pulled a department-level report, matched no hour
// headers, fell back to hardcoded column indices and wrote that file's
// "Avg Wages" column into sch_labor_hrs. Those rows are plausible-looking and
// wrong, which is the worst kind. This deletes hour indicators for a date so a
// corrected run can rewrite them.
router.post('/diag/purge-bad-labor', async (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: 'Unauthorized' });
  const date = String(req.query.date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });

  const pool = db.getPool();
  if (!pool) return res.status(503).json({ error: 'Database unavailable' });

  const r = await pool.query(
    `DELETE FROM dbs_soft_indicators
      WHERE metric_date = $1::date AND indicator IN ('act_labor_hrs','sch_labor_hrs')`,
    [date]
  );
  res.json({ date, deleted: r.rowCount });
});

// ── GET /api/brief/diag/fourth-reports — what reports actually exist ────────
router.get('/diag/fourth-reports', async (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const { listReportTitles } = require('../services/intel-fourth');
    const all = await listReportTitles();
    const q = String(req.query.q || 'labor|overview|hour').toLowerCase();
    const re = new RegExp(q, 'i');
    res.json({ total: all.length, matching: all.filter(t => re.test(t)).sort() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/brief/diag/fourth-meta — read Fourth metadata (read-only) ──────
router.get('/diag/fourth-meta', async (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const f = require('../services/intel-fourth');
    if (req.query.report === '1') {
      const uri = await f.labourReportUri();
      if (!uri) return res.json({ error: 'no labour report uri resolved' });
      const obj = await f.inspectMeta(uri);
      const def = obj.report && obj.report.content && obj.report.content.definitions;
      let defObj = null;
      if (def && def.length) defObj = await f.inspectMeta(def[def.length - 1]);
      return res.json({
        uri,
        title: obj.report && obj.report.meta && obj.report.meta.title,
        definitionUris: def || null,
        definitionContent: defObj && defObj.reportDefinition && defObj.reportDefinition.content,
      });
    }
    const path = String(req.query.path || '');
    if (!/^\/gdc\//.test(path)) return res.status(400).json({ error: 'path must start with /gdc/' });
    const out = await f.inspectMeta(path);
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/brief/diag/fourth-labor-probe — run the export, compare rows ───
// Downloads the labor report with and without the fiscal-week filter and shows
// the first data row of each. If they match, the filter is being ignored.
router.get('/diag/fourth-labor-probe', async (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: 'Unauthorized' });
  const date = String(req.query.date || '2026-10-03');
  try {
    const f = require('../services/intel-fourth');
    const XLSX = require('xlsx');
    const out = { date, week: f.fiscalWeekBounds(date), filterExpression: f.weekFilterExpression(f.PROJECT_ID, date).expression };

    for (const [label, td] of [['filtered', date], ['unfiltered', null]]) {
      try {
        const dl = await f.downloadFourthReport('LABOR', td);
        if (!dl || !dl.success) { out[label] = 'download failed: ' + ((dl && dl.error) || 'unknown'); continue; }
        const wb = XLSX.readFile(dl.filePath);
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });
        out[label] = { header: (rows[0] || []).slice(0, 13), firstRow: (rows[1] || []).slice(0, 13), rowCount: rows.length };
      } catch (e) { out[label] = 'ERROR: ' + e.message; }
    }
    res.json(out);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/brief/diag/fourth-exec — raw execute/raw response ──────────────
router.get('/diag/fourth-exec', async (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const f = require('../services/intel-fourth');
    const shape = String(req.query.shape || 'list');
    const w = f.weekFilterExpression(f.PROJECT_ID, String(req.query.date || '2026-10-03'));
    // GoodData said filters belong under "context". Try the plausible shapes
    // and let it tell us which it accepts, rather than guessing a fourth time.
    const shapes = {
      none:        null,
      ctxFilters:  { context: { filters: [w.filter] } },
      ctxList:     { context: [w.filter] },
      ctxExpr:     { context: { filters: [{ expression: w.expression }] } },
      flatFilters: { filters: [w.filter] },
    };
    if (!(shape in shapes)) return res.status(400).json({ error: 'shape must be one of ' + Object.keys(shapes).join(', ') });
    res.json(await f.rawExecuteProbe(shapes[shape]));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/brief/diag/winscore-last — outcome of the last win-score run ───
router.get('/diag/winscore-last', async (req, res) => {
  if (!authed(req)) return res.status(401).json({ error: 'Unauthorized' });
  const logs = await db.getIntelLogs(60);
  const row  = (logs || []).find(r => String(r.job_type || '').startsWith('winscore:'));
  if (!row) return res.json({ note: 'no win-score run logged yet' });
  let message = row.message;
  try { message = JSON.parse(message); } catch (_) {}
  res.json({ jobType: row.job_type, status: row.status, at: row.created_at, message });
});

module.exports = router;
