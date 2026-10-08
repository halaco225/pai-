// services/brief-sms.js
//
// Texts P.AI's already-generated morning brief.
//
// The brief itself is not generated here — services/intel-pipeline.js caches one
// per person every morning. This file condenses that cached text, decides who is
// due, claims the send, calls Twilio and logs the result.
//
// Outbound only. RC Tracker owns the inbound webhook, so nothing here affects
// replies, STOP/START or delivery callbacks.

const Anthropic = require('@anthropic-ai/sdk');
const { localDate, localHHMM, minusDays } = require('./localtime');

// The pipeline computes its target date as "yesterday, Eastern" and caches each
// brief under THAT date, not the date it runs (intel-pipeline.js:493, via
// getYesterdayEST). So the brief a person reads on the 3rd lives at
// cache_date = the 2nd. Looking it up under today finds nothing, every day.
const PIPELINE_TZ = 'America/New_York';

function briefCacheDate(now = new Date()) {
  return minusDays(localDate(now, PIPELINE_TZ), 1);
}

// 320 = two concatenated GSM-7 segments. Enough for a headline, a few numbers
// and a link; short enough that it does not arrive as a wall of text.
const MAX_SMS_CHARS = 320;

// The rest of P.AI is on claude-sonnet-4-6 (services/claude.js:8). This picks
// its own model so that changing the brief does not change P&L analysis
// output, and vice versa.
const BRIEF_MODEL = process.env.BRIEF_MODEL || 'claude-sonnet-5';

// How late a send may still go out. Harold's requirement is "between 8 and 9",
// so the window is an hour from 08:05 -- that absorbs a slow pipeline morning
// without ever drifting into the afternoon. An app that boots at 4pm still
// sends nothing.
const SEND_WINDOW_MINUTES = Number(process.env.PAI_BRIEF_WINDOW_MINUTES || 60);

const DEFAULT_SEND_LOCAL = '08:05';

// ── Message building ─────────────────────────────────────────────────────────

function buildLink(env = process.env) {
  const base = (env.PAI_BASE_URL || 'https://pai-ayvaz.onrender.com').replace(/\/+$/, '');
  return `${base}/intel.html`;
}

// Cut to `max` on a word boundary where possible, never mid-word.
function clip(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const sp  = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trimEnd();
}

// Last resort when the model is unreachable: the brief's own opening lines.
// A plain, slightly clumsy text beats no text at 8:05.
function fallback(briefText, link) {
  const body = briefText
    .split('\n')
    .map(l => l.trim())
    .filter(l => l && !/^(MORNING BRIEF|Results from)/i.test(l))
    .join(' ');
  const room = MAX_SMS_CHARS - link.length - 'Morning brief: '.length - 1;
  return `Morning brief: ${clip(body, room)} ${link}`;
}

// The condense call has to finish inside the send window, so it gets an
// explicit deadline. The SDK's defaults are a 10-minute timeout and 2 retries
// with backoff, which is sane for a batch job and useless here: with a missing
// or bad key this function would sit there for minutes instead of handing back
// to the fallback, and the 8:05 text would simply not arrive on time.
const CONDENSE_TIMEOUT_MS = Number(process.env.BRIEF_CONDENSE_TIMEOUT_MS || 20000);

async function callClaude(prompt) {
  // Fail fast rather than letting the SDK retry its way through the window.
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');

  const client = new Anthropic({
    apiKey:     process.env.ANTHROPIC_API_KEY,
    timeout:    CONDENSE_TIMEOUT_MS,
    maxRetries: 1,
  });
  const res = await client.messages.create({
    model: BRIEF_MODEL,
    max_tokens: 300,
    messages: [{ role: 'user', content: prompt }],
  });
  return res.content.map(c => c.text || '').join('').trim();
}

/**
 * Condense a full morning brief into one short text, always ending in `link`.
 * Returns null when there is no brief to condense.
 * `deps.callModel` is injected by tests so no network call happens there.
 */
async function condense(briefText, link, deps = {}) {
  if (!briefText || !briefText.trim()) return null;

  const callModel = deps.callModel || callClaude;
  const room      = MAX_SMS_CHARS - link.length - 1;

  const prompt = `Condense this morning brief into a single SMS of at most ${room} characters.

Rules:
- Lead with the single most important number or problem.
- Then at most two more items, whichever a Region Coach would act on first.
- Plain text. No markdown, no emoji, no greeting, no sign-off.
- Do not include any URL — one is appended for you.
- Numbers exactly as given. Never round, never invent.

BRIEF:
${briefText}`;

  let body;
  try {
    body = await callModel(prompt);
  } catch (err) {
    console.error('[BriefSMS] condense failed, using fallback:', err.message);
    return clip(fallback(briefText, link), MAX_SMS_CHARS);
  }

  if (!body || !body.trim()) return clip(fallback(briefText, link), MAX_SMS_CHARS);

  // Strip any URL the model added despite the instruction, so the link is not
  // duplicated, then append the real one.
  body = body.replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();

  return `${clip(body, room)} ${link}`.trim();
}

// ── The message body ────────────────────────────────────────────────────────
//
// The text IS the scorecard, rendered from the same builder the brief page
// uses. It is not a model summary of it: the numbers go out exactly as the
// database holds them, with no chance of a paraphrase rounding something or
// inventing a store. renderScorecard already produces this layout.

// A table runs past one SMS segment; Twilio concatenates. This is the ceiling
// before rows get dropped, not a target.
const MAX_BODY_CHARS = Number(process.env.PAI_BRIEF_MAX_CHARS || 1200);

// Render for a phone, not a terminal.
//
// renderScorecard lays the brief out in fixed-width columns, which is right in
// a <pre> block and wrong in a text message: SMS is a proportional font that
// wraps around 30 characters, so the padding turns into ragged noise and a
// single area's numbers smear over four lines. This builds short self-
// describing lines instead, each one under about thirty characters, so a wrap
// is rare and never splits a number from its label.

// "Area 2034 — Michelle Meehan" -> "Meehan". "Jose Lozano Sr." -> "Lozano".
function shortLabel(label) {
  let t = String(label || '').trim();
  const dash = t.lastIndexOf('—');
  if (dash !== -1) t = t.slice(dash + 1).trim();
  const words = t.split(/\s+/).filter(w => !/^(jr\.?|sr\.?|ii|iii)$/i.test(w));
  return words.length > 1 ? words[words.length - 1] : (words[0] || t);
}

const m0 = n => n == null ? null : '$' + Math.round(n).toLocaleString('en-US');
const g0 = n => n == null ? null : (n >= 0 ? '+' : '') + n.toFixed(1) + '%';
const t0 = n => n == null ? null : n.toFixed(1) + 'm';

// "2026-10-02" -> "Oct 2". Built from the string, not a Date, so no zone can
// shift it to the day before.
function dayLabel(dateStr) {
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const m = String(dateStr || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${M[Number(m[2]) - 1]} ${Number(m[3])}` : '';
}

function renderForSms(sc, opts) {
  if (!sc) return '';
  const o = sc.own;
  const L = [];

  const head = (sc.level || 'scorecard').toUpperCase();
  L.push([head, opts && opts.fiscalCode, opts && opts.dateLabel].filter(Boolean).join(' · '));

  const salesBits = [m0(o.sales), g0(o.growth_pct)].filter(Boolean);
  if (salesBits.length) L.push('Sales ' + salesBits.join(' ') + ' vs LY');

  const line2 = [];
  if (o.ist != null) line2.push('IST ' + t0(o.ist));
  if (o.missed_routines) line2.push(o.missed_routines + ' missed');
  if (line2.length) L.push(line2.join(' · '));

  // Say once that something is not reporting, rather than printing a dash in
  // every row and leaving the reader to work out whether it is a zero.
  //
  // Sales belongs in this list for the same reason the others do. On
  // 2026-10-08 the ODS pull 404'd, intel_dbs_metrics held nothing for the day,
  // and the renderer simply left the sales line out -- so the text read as a
  // normal brief that happened to be about IST, and nobody could tell the two
  // headline numbers were missing rather than flat.
  // Labor that is still arriving is worse than labor that is absent: -464h
  // reads as a catastrophe rather than as a half-read. Say which it is.
  const laborStillPosting = o.act_hrs != null && sc.own.labor_partial === true;

  const missing = [];
  if (o.sales == null) missing.push('Sales');
  if (o.act_hrs == null) missing.push('Labor');
  if (o.win == null) missing.push('WIN');
  // What did arrive still gets printed. Suppressing the whole line because one
  // of its metrics is absent is how a working labor number went missing from a
  // text whose only real problem was sales.
  const have = [];
  if (o.act_hrs != null && !laborStillPosting) {
    have.push('Labor ' + (o.hrs_variance >= 0 ? '+' : '') + o.hrs_variance.toFixed(0) + 'h');
  }
  // Marked PTD because it is the one metric on a different basis: sales,
  // growth, IST and labor are all the previous day, WIN is period-to-date.
  if (o.win != null) have.push('WIN ' + o.win.toFixed(1) + '% PTD');
  if (have.length) L.push(have.join(' · '));
  if (laborStillPosting) L.push('Labor still posting');
  if (missing.length) L.push(missing.join(' & ') + ' not reporting');

  if (sc.rows && sc.rows.length) {
    L.push('');
    // Named for whoever is reading: a VP sees REGIONS, an RDO AREAS, an Area
    // Coach STORES.
    const heading = { region: 'REGIONS', area: 'AREAS', store: 'STORES' }[sc.childLevel] || 'BREAKDOWN';
    L.push(heading + ' best first');
    // Two lines per row: who and the money, then the operational numbers
    // indented under it. One line fitted only while labor and WIN were
    // missing -- with both present a row reaches 39 characters and wraps,
    // which is the mess this whole renderer exists to avoid.
    const ordered = [...sc.rows].sort((a, b) => {
      if (a.growth_pct == null) return 1;      // no data sinks to the bottom
      if (b.growth_pct == null) return -1;
      return b.growth_pct - a.growth_pct;      // best growth first
    });

    // Coaches get their surname; stores keep their name. Taking the last word
    // of a store turned "Union City" into "City" and "Miracle Strip" into
    // "Strip", which is worse than useless to whoever has to act on it.
    const labelFor = r => sc.childLevel === 'store'
      ? String(r.label || '').trim().slice(0, 18)
      : shortLabel(r.label);

    for (const r of ordered) {
      L.push([labelFor(r), m0(r.sales), g0(r.growth_pct)].filter(Boolean).join(' '));

      const detail = [];
      if (r.ist != null) detail.push(t0(r.ist));
      if (r.win != null) detail.push('W' + r.win.toFixed(0) + '%');
      if (r.hrs_variance != null && !laborStillPosting) {
        detail.push('L' + (r.hrs_variance >= 0 ? '+' : '') + r.hrs_variance.toFixed(0));
      }
      if (r.missed_routines) detail.push('!' + r.missed_routines);
      if (detail.length) L.push('  ' + detail.join(' · '));
    }
  }

  return L.join(String.fromCharCode(10));
}

async function buildBody(username, targetDate) {
  const { USER_ROSTER } = require('../routes/auth');
  const user = USER_ROSTER.find(u => u.username === username);
  if (!user) throw new Error(`${username} is not on the roster`);

  const pool = db.getPool();
  if (!pool) throw new Error('Database unavailable');

  const { buildScorecard } = require('./scorecard');
  const sc = await buildScorecard({
    pool, targetDate, role: user.role, name: user.name, scope: user.scope,
  });
  if (!sc) return null;

  let fiscalCode = '';
  try {
    const { getCurrentFiscalPeriod } = require('./fiscal-calendar');
    const fp = getCurrentFiscalPeriod(new Date(targetDate + 'T12:00:00Z'));
    fiscalCode = (fp && (fp.code || fp.label)) || '';
  } catch { /* a missing period code is not worth failing the text over */ }

  let body = renderForSms(sc, { fiscalCode, dateLabel: dayLabel(targetDate) });
  if (!body || !body.trim()) return null;

  const NL = String.fromCharCode(10);
  const link = buildLink();
  if (body.length + link.length + 2 > MAX_BODY_CHARS) {
    // Drop whole rows from the end rather than cutting mid-number.
    const lines = body.split(NL);
    while (lines.length && lines.join(NL).length + link.length + 20 > MAX_BODY_CHARS) lines.pop();
    lines.push('…more in P.AI');
    body = lines.join(NL);
  }
  return body + NL + link;
}

// ── Who is due ───────────────────────────────────────────────────────────────

function recipients(env = process.env) {
  // Deliberately explicit: an empty setting sends to nobody. Defaulting an
  // empty value to "everyone" is how 62 people get an unexpected text.
  // Harold, Matt, and Harold's six area coaches. All eight have an opted-in
  // consent record; anyone who has not opted in is skipped at send time
  // regardless of being listed here.
  if (env.PAI_BRIEF_RECIPIENTS === undefined) {
    return ['hlacoste', 'mhester',
            'dspikes', 'esimmons', 'jmcneil', 'jgarcia', 'mgannon', 'mmeehan'];
  }
  return env.PAI_BRIEF_RECIPIENTS.split(',').map(s => s.trim()).filter(Boolean);
}

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

/**
 * Is this person due their brief right now?
 * Pure — every input is passed in, so no clock or network is needed to test it.
 */
function isDue({ person, now, sendLocal = DEFAULT_SEND_LOCAL, consented, alreadySentDates = [] }) {
  // A timezone decides when 8:05 is. The phone number lives in RC Tracker,
  // which is what actually sends, so P.AI does not need one.
  if (!person || !person.tz) return false;
  if (!consented) return false;

  const today = localDate(now, person.tz);
  if (alreadySentDates.includes(today)) return false;

  const nowMin = toMinutes(localHHMM(now, person.tz));
  const dueMin = toMinutes(sendLocal);
  return nowMin >= dueMin && nowMin < dueMin + SEND_WINDOW_MINUTES;
}

// ── Supabase reads/writes ────────────────────────────────────────────────────

const db     = require('./db');
const rcDb   = require('./rc-db');
const people = require('./rc-people');

// RC Tracker owns the roster, the phone numbers and the Twilio outbound path.
// P.AI asks it who someone is and tells it to send, by NAME -- so no phone
// number has to exist in P.AI at all, and there is still exactly one sender.
const RC_BASE = (process.env.RC_TRACKER_URL || 'https://rc-tracker-hos2.onrender.com').replace(/\/+$/, '');

async function rcPerson(name) {
  const url = `${RC_BASE}/api/reminders/preview?person=${encodeURIComponent(name)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`RC Tracker has no record for ${name} (HTTP ${r.status})`);
  const d = await r.json();
  return { name, tz: d.tz, signedUp: Boolean(d.signed_up) };
}

// Send by name through RC Tracker. track:false so the brief is a text, not a
// new follow-up item on Harold's list.
async function rcSend(name, body) {
  const r = await fetch(`${RC_BASE}/api/messages/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: [name], body, track: false, sent_by: 'pai-brief' }),
  });
  const out = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(out.error || `RC Tracker returned HTTP ${r.status}`);
  const result = (out.results || [])[0] || {};
  const ok = ['sent', 'queued', 'delivered', 'scheduled'].includes(result.status);
  if (!ok) throw new Error(result.status ? `RC Tracker: ${result.status}` : 'RC Tracker did not confirm the send');
  return result.sid || result.twilio_sid || null;
}

// Has this person opted in and not since opted out? Latest row wins, which is
// how RC Tracker's consent log is shaped — one append per event.
async function hasConsent(personName, phone) {
  const sb = rcDb.getServiceClient();
  if (!sb) return false;
  const { data, error } = await sb
    .from('sms_consent')
    .select('status')
    .eq('phone', phone)
    .order('created_at', { ascending: false })
    .limit(1);
  if (error) { console.error('[BriefSMS] consent lookup failed:', error.message); return false; }
  return Boolean(data && data[0] && data[0].status === 'opted_in');
}

async function sentDates(personName) {
  const sb = rcDb.getServiceClient();
  if (!sb) return [];
  const { data, error } = await sb
    .from('sms_reminders')
    .select('local_date')
    .eq('person', personName)
    .eq('kind', 'brief')
    .order('created_at', { ascending: false })
    .limit(7);
  if (error) { console.error('[BriefSMS] sent-date lookup failed:', error.message); return []; }
  return (data || []).map(r => r.local_date);
}

/**
 * Claim today's send by inserting before anything is sent.
 * Returns the claim row's id, or null if someone else already holds it.
 * Migration 008's unique index is what makes this atomic — a select-then-send
 * would let two overlapping ticks both send.
 */
async function claim(personName, phone, localDateStr, body) {
  const sb = rcDb.getServiceClient();
  if (!sb) return null;
  const { data, error } = await sb
    .from('sms_reminders')
    .insert({ person: personName, phone, kind: 'brief', local_date: localDateStr, body, item_ids: [] })
    .select('id')
    .single();

  if (error) {
    // 23505 = unique_violation: another tick holds today's claim. That is the
    // guard working and the only reason to come back empty-handed quietly.
    if (error.code === '23505') return null;
    // Anything else is a real failure. Returning null here too made a broken
    // insert indistinguishable from "already sent today", so a schema or
    // permission problem reported itself as the dedupe guard doing its job.
    throw new Error(`claim insert failed (${error.code || 'no code'}): ${error.message}`);
  }
  return data.id;
}

async function releaseClaim(id) {
  const sb = rcDb.getServiceClient();
  if (!sb || !id) return;
  const { error } = await sb.from('sms_reminders').delete().eq('id', id);
  if (error) console.error('[BriefSMS] claim release failed:', error.message);
}

async function recordClaimResult(id, { twilioSid, errorText }) {
  const sb = rcDb.getServiceClient();
  if (!sb || !id) return;
  await sb.from('sms_reminders')
    .update({ twilio_sid: twilioSid || null, error: errorText || null })
    .eq('id', id);
}

async function logMessage({ personName, phone, body, twilioSid, status, errorText }) {
  const sb = rcDb.getServiceClient();
  if (!sb) return;
  const { error } = await sb.from('sms_messages').insert({
    direction: 'outbound', person: personName, phone, body,
    kind: 'brief', status, twilio_sid: twilioSid || null,
    error: errorText || null, media: [], follow_up_ids: [], sent_by: 'pai-brief',
  });
  if (error) console.error('[BriefSMS] message log failed:', error.message);
}

// ── Twilio ───────────────────────────────────────────────────────────────────

async function sendText(to, body) {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_FROM_NUMBER) {
    throw new Error('Twilio is not configured');
  }
  const client = require('twilio')(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  const msg = await client.messages.create({ to, from: TWILIO_FROM_NUMBER, body });
  return msg.sid;
}

// Local roster copy if one is mounted, otherwise RC Tracker, which owns it.
// Returns { tz, phone?, consented } or throws with a reason worth reading.
async function resolvePerson(name) {
  const local = people.getPerson(name);
  if (local && local.tz) {
    const consented = local.phone ? await hasConsent(name, local.phone) : null;
    return { name, tz: local.tz, phone: local.phone, consented, source: 'people.json' };
  }
  const rc = await rcPerson(name);
  return { name, tz: rc.tz, phone: null, consented: rc.signedUp, source: 'rc-tracker' };
}

// ── One person ───────────────────────────────────────────────────────────────

/**
 * Send one person their brief if they are due it.
 * Returns a short reason string for the tick to log, or null when there is
 * nothing to say. Never throws.
 */
async function sendOne(username, now = new Date()) {
  const personName = people.nameForUsername(username);
  if (!personName) return `${username}: not on the roster`;

  let person;
  try { person = await resolvePerson(personName); }
  catch (err) { return `${personName}: ${err.message}`; }

  const today     = localDate(now, person.tz);
  const already   = await sentDates(personName);
  const consented = person.consented;

  if (!isDue({
    person: { ...person, name: personName }, now,
    sendLocal: process.env.PAI_BRIEF_SEND_LOCAL_TIME || DEFAULT_SEND_LOCAL,
    consented, alreadySentDates: already,
  })) return null;   // not due — silent, which is most ticks

  // Two different dates, deliberately. `today` is the send day and keys the
  // one-per-day claim. `dataDate` is yesterday-Eastern, which is where the
  // pipeline actually caches the brief.
  const dataDate = briefCacheDate(now);
  const cached   = await db.getIntelCache({ userId: `${username}::brief`, cacheDate: dataDate });
  const memo     = cached && cached.data && cached.data.memo_text;

  // No brief yet: say so and try again next tick. Never reach further back
  // than this morning's data date — a late text is recoverable, older numbers
  // labelled as today's go into someone's decisions.
  if (!memo) return `${personName}: brief for ${dataDate} not cached yet — will retry`;

  let body;
  try {
    body = await buildBody(username, dataDate);
  } catch (err) {
    console.error('[BriefSMS] scorecard build failed, falling back:', err.message);
  }
  if (!body) body = await condense(memo, buildLink());
  if (!body) return `${personName}: brief produced no message`;

  let claimId;
  try {
    claimId = await claim(personName, person.phone || '', today, body);
  } catch (err) {
    return `${personName}: ${err.message}`;
  }
  if (!claimId) return null;   // someone else holds today's claim

  try {
    // Sent by name through RC Tracker: it resolves the phone, re-checks
    // consent, sends on the one number and logs it to sms_messages itself.
    // P.AI does not log a second row — that would show the brief twice in the
    // Message Center.
    const sid = await rcSend(personName, body);
    await recordClaimResult(claimId, { twilioSid: sid });
    return `${personName}: sent${sid ? ` (${sid})` : ''}`;
  } catch (err) {
    // Release the claim so the next tick can retry inside the window. Holding a
    // claim for a send that never happened means a silently skipped day.
    await releaseClaim(claimId);
    return `${personName}: send failed — ${err.message}`;
  }
}

// ── Refresh labor before the text goes out ───────────────────────────────────
//
// Fourth posts the previous day's punches well after the 6am pipeline runs. On
// 2026-10-05 Senoia read 10.00 actual hours against 26.00 scheduled at 6am and
// 25.55 by mid-morning -- scheduled never moved, actual more than doubled. The
// 8:05 text went out saying the region was 535 hours under, when the day was
// roughly flat. The basis was right the whole time; the data was simply early.
//
// So labor is re-pulled shortly before the send. The scorecard is built live
// from the database at compose time, so a refresh here lands in the message.
const { LABOR_PLAUSIBLE_RATIO } = require('./scorecard');
const LABOR_REFRESH_LOCAL = process.env.PAI_LABOR_REFRESH_TIME || '07:30';
const REFRESH_TZ = 'America/New_York';
let _refreshedFor = null;

// Fourth keeps posting through the morning, so one pull at 07:30 is a guess at
// when it finishes. Pull again on each tick while the numbers still look like a
// half-read day, up to this many times, and stop at the send either way.
const MAX_LABOR_REFRESHES = Number(process.env.PAI_LABOR_REFRESH_TRIES || 5);
let _refreshCount = 0;

function laborRefreshDue(now) {
  const today = localDate(now, REFRESH_TZ);
  if (_refreshedFor === today && _refreshCount >= MAX_LABOR_REFRESHES) return false;
  if (_refreshedFor === today && _refreshCount > 0 && !_laborLookedPartial) return false;
  const nowMin = toMinutes(localHHMM(now, REFRESH_TZ));
  const dueMin = toMinutes(LABOR_REFRESH_LOCAL);
  // Between the refresh time and the send time. Later than that and the text
  // has already gone; earlier and Fourth has not caught up.
  return nowMin >= dueMin && nowMin < toMinutes(process.env.PAI_BRIEF_SEND_LOCAL_TIME || DEFAULT_SEND_LOCAL);
}

// One place to poke our own automation routes. Both the labor refresh and the
// sales backfill go through the app rather than calling the pipeline directly,
// so they take the same token check and logging as the cron does.
function postLocal(path, payload) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = require('http').request({
      hostname: '127.0.0.1', port: process.env.PORT || 3000,
      path, method: 'POST', timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'X-Automation-Token': process.env.INTEL_AUTOMATION_TOKEN || '38b8091924e1f85583454212a9860038',
      },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', (e) => { console.error(`[BriefSMS] ${path} failed:`, e.message); resolve(0); });
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.end(body);
  });
}

function refreshLabor(now = new Date()) {
  const today = localDate(now, REFRESH_TZ);
  if (_refreshedFor !== today) { _refreshedFor = today; _refreshCount = 0; }
  _refreshCount++;
  return postLocal('/api/intel/automation/run-labor-hutbot', { date: briefCacheDate(now) });
}

// Company-wide actual against scheduled for the day. Below the plausible ratio
// the punches are still arriving; a real day lands within a few percent.
let _laborLookedPartial = true;   // assume so until a read says otherwise

async function laborLooksPartial(dataDate) {
  const pool = db.getPool();
  if (!pool) return false;
  const { rows } = await pool.query(
    `SELECT SUM(CASE WHEN indicator = 'act_labor_hrs' THEN value ELSE 0 END)::float AS act,
            SUM(CASE WHEN indicator = 'sch_labor_hrs' THEN value ELSE 0 END)::float AS sch
       FROM dbs_soft_indicators
      WHERE metric_date = $1 AND indicator IN ('act_labor_hrs','sch_labor_hrs')`,
    [dataDate]
  );
  const act = rows[0] && rows[0].act, sch = rows[0] && rows[0].sch;
  if (!sch) return false;                       // nothing scheduled: nothing to judge
  return (act / sch) < LABOR_PLAUSIBLE_RATIO;
}

// ── Sales backfill ───────────────────────────────────────────────────────────
//
// On 2026-10-08 the 6am ODS pull got a 404 from the CSRF servlet, so DBS, SOS
// and three other steps wrote nothing and the 8:05 text had no sales or growth
// in it at all. Re-running the pipeline by hand at 14:03 filled the day in
// within ninety seconds, which is the whole argument for doing it here: a
// transient failure at 6am should not cost the two headline numbers.
//
// Same window as the labor refresh, and once per day either way -- a pipeline
// that fails twice is not a blip, and hammering ODS will not change its mind.

let _salesCheckedFor = null;

function salesBackfillDue(now) {
  const today = localDate(now, REFRESH_TZ);
  if (_salesCheckedFor === today) return false;
  const nowMin = toMinutes(localHHMM(now, REFRESH_TZ));
  const dueMin = toMinutes(LABOR_REFRESH_LOCAL);
  return nowMin >= dueMin && nowMin < toMinutes(process.env.PAI_BRIEF_SEND_LOCAL_TIME || DEFAULT_SEND_LOCAL);
}

// Does the day actually have sales? Asked of the table the scorecard reads,
// not of the pipeline's own status -- the run that produced nothing reported
// itself 'partial', which is also what a perfectly good day reports.
async function salesMissing(dataDate) {
  const pool = db.getPool();
  if (!pool) return false;
  const { rows } = await pool.query(
    'SELECT COUNT(net_sales_day)::int AS n FROM intel_dbs_metrics WHERE metric_date = $1',
    [dataDate]
  );
  return !rows[0] || rows[0].n === 0;
}

function backfillSales(now = new Date()) {
  _salesCheckedFor = localDate(now, REFRESH_TZ);
  return postLocal(`/api/intel/automation/run-batch?date=${briefCacheDate(now)}`,
                   { date: briefCacheDate(now) });
}

async function tick(now = new Date()) {
  if (!rcDb.isConfigured()) return;

  // Sales first: it is the slower of the two and the one whose absence guts
  // the message. Checking costs one COUNT; re-running only happens on a day
  // the morning pipeline actually came back empty.
  if (salesBackfillDue(now)) {
    const dataDate = briefCacheDate(now);
    let gone = false;
    try { gone = await salesMissing(dataDate); }
    catch (e) { console.error('[BriefSMS] sales check failed:', e.message); }
    _salesCheckedFor = localDate(now, REFRESH_TZ);
    if (gone) {
      const status = await backfillSales(now);
      console.log(`[BriefSMS] no sales for ${dataDate} — pipeline rerun -> HTTP ${status}`);
      return; // let it land before composing; the next tick sends
    }
  }

  if (laborRefreshDue(now)) {
    const dataDate = briefCacheDate(now);
    try { _laborLookedPartial = await laborLooksPartial(dataDate); }
    catch (e) { console.error('[BriefSMS] labor check failed:', e.message); }
    if (_refreshCount === 0 || _laborLookedPartial) {
      const status = await refreshLabor(now);
      console.log(`[BriefSMS] labor refresh ${_refreshCount}/${MAX_LABOR_REFRESHES} ` +
                  `for ${dataDate} (partial=${_laborLookedPartial}) -> HTTP ${status}`);
      return; // let it finish before composing; the next tick sends
    }
  }

  for (const username of recipients()) {
    try {
      const outcome = await sendOne(username, now);
      if (outcome) console.log(`[BriefSMS] ${outcome}`);
    } catch (err) {
      console.error(`[BriefSMS] ${username} failed:`, err.message);
    }
  }
}

module.exports = {
  condense, buildLink, clip, isDue, recipients, sendOne, tick, briefCacheDate,
  resolvePerson, rcPerson, rcSend, buildBody, MAX_BODY_CHARS,
  laborRefreshDue, refreshLabor, LABOR_REFRESH_LOCAL,
  salesBackfillDue, salesMissing, backfillSales,
  laborLooksPartial, MAX_LABOR_REFRESHES,
  renderForSms, shortLabel, dayLabel,
  hasConsent, sentDates, claim, releaseClaim, recordClaimResult, logMessage,
  MAX_SMS_CHARS, BRIEF_MODEL, SEND_WINDOW_MINUTES, DEFAULT_SEND_LOCAL,
  CONDENSE_TIMEOUT_MS,
};
