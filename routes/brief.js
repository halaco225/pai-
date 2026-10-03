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

// Same token the intel automation endpoints accept.
function authed(req) {
  const token = req.query.token || req.headers['x-automation-token'];
  const valid = [process.env.INTEL_AUTOMATION_TOKEN, process.env.INTEL_REGEN_TOKEN].filter(Boolean);
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

  const person = people.getPerson(name);
  if (!person) return res.status(404).json({ error: `No phone or timezone on file for ${name}` });

  const date   = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date
               : localDate(new Date(), person.tz);
  const cached = await db.getIntelCache({ userId: `${username}::brief`, cacheDate: date });
  const memo   = cached && cached.data && cached.data.memo_text;

  if (!memo) {
    return res.json({
      username, person: name, date, cached: false,
      note: 'No brief cached for that date. The sender would skip and retry, never send an older one.',
    });
  }

  const body = await briefSms.condense(memo, briefSms.buildLink());
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

  const person = people.getPerson(name);
  if (!person) return res.status(404).json({ error: `No phone or timezone on file for ${name}` });

  // Consent is never bypassed — that row is the TCPA record.
  if (!await briefSms.hasConsent(name, person.phone)) {
    return res.status(403).json({ error: `${name} has no opted_in consent record` });
  }

  const date   = localDate(new Date(), person.tz);
  const cached = await db.getIntelCache({ userId: `${username}::brief`, cacheDate: date });
  const memo   = cached && cached.data && cached.data.memo_text;
  if (!memo) return res.status(409).json({ error: `No brief cached for ${date}`, sent: false });

  const body = await briefSms.condense(memo, briefSms.buildLink());
  if (!body) return res.status(500).json({ error: 'Brief condensed to nothing', sent: false });

  const claimId = await briefSms.claim(name, person.phone, date, body);
  if (!claimId) {
    return res.status(409).json({
      error: `A brief is already claimed for ${name} on ${date}`,
      sent: false,
      note: 'This is the one-per-day guard working, not a failure.',
    });
  }

  try {
    const twilio = require('twilio')(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    const msg = await twilio.messages.create({
      to: person.phone, from: process.env.TWILIO_FROM_NUMBER, body,
    });
    await briefSms.recordClaimResult(claimId, { twilioSid: msg.sid });
    await briefSms.logMessage({
      personName: name, phone: person.phone, body, twilioSid: msg.sid, status: 'sent',
    });
    res.json({ sent: true, person: name, date, chars: body.length, sid: msg.sid, sms: body });
  } catch (err) {
    await briefSms.releaseClaim(claimId);
    await briefSms.logMessage({
      personName: name, phone: person.phone, body, status: 'failed', errorText: err.message,
    });
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

module.exports = router;
