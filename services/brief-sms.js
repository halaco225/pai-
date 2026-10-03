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
const { localDate, localHHMM } = require('./localtime');

// 320 = two concatenated GSM-7 segments. Enough for a headline, a few numbers
// and a link; short enough that it does not arrive as a wall of text.
const MAX_SMS_CHARS = 320;

// The rest of P.AI is on claude-sonnet-4-6 (services/claude.js:8). This picks
// its own model so that changing the brief does not change P&L analysis
// output, and vice versa.
const BRIEF_MODEL = process.env.BRIEF_MODEL || 'claude-sonnet-5';

// How late a send may still go out. A tick that is delayed, or an app that
// restarts at 8:07, should still send. An app that boots at 4pm should not.
const SEND_WINDOW_MINUTES = 30;

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

// ── Who is due ───────────────────────────────────────────────────────────────

function recipients(env = process.env) {
  // Deliberately explicit: an empty setting sends to nobody. Defaulting an
  // empty value to "everyone" is how 62 people get an unexpected text.
  if (env.PAI_BRIEF_RECIPIENTS === undefined) return ['hlacoste'];
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
  if (!person || !person.phone || !person.tz) return false;
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
    // 23505 = unique_violation: another tick holds today's claim. Not an error.
    if (error.code === '23505') return null;
    console.error('[BriefSMS] claim failed:', error.message);
    return null;
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

// ── One person ───────────────────────────────────────────────────────────────

/**
 * Send one person their brief if they are due it.
 * Returns a short reason string for the tick to log, or null when there is
 * nothing to say. Never throws.
 */
async function sendOne(username, now = new Date()) {
  const personName = people.nameForUsername(username);
  if (!personName) return `${username}: not on the roster`;

  const person = people.getPerson(personName);
  if (!person) return `${personName}: no phone or timezone on file`;

  const today = localDate(now, person.tz);

  const [consented, already] = await Promise.all([
    hasConsent(personName, person.phone),
    sentDates(personName),
  ]);

  if (!isDue({
    person: { ...person, name: personName }, now,
    sendLocal: process.env.PAI_BRIEF_SEND_LOCAL_TIME || DEFAULT_SEND_LOCAL,
    consented, alreadySentDates: already,
  })) return null;   // not due — silent, which is most ticks

  // The brief describes yesterday, and the pipeline caches it under today's
  // date (the date it was generated for).
  const cached = await db.getIntelCache({ userId: `${username}::brief`, cacheDate: today });
  const memo   = cached && cached.data && cached.data.memo_text;

  // No brief yet: say so and try again next tick. Never reach back to an older
  // cache_date — a late text is recoverable, yesterday's numbers labelled as
  // today's go into someone's decisions.
  if (!memo) return `${personName}: brief for ${today} not cached yet — will retry`;

  const body = await condense(memo, buildLink());
  if (!body) return `${personName}: brief condensed to nothing`;

  const claimId = await claim(personName, person.phone, today, body);
  if (!claimId) return null;   // someone else holds today's claim

  try {
    const sid = await sendText(person.phone, body);
    await recordClaimResult(claimId, { twilioSid: sid });
    await logMessage({ personName, phone: person.phone, body, twilioSid: sid, status: 'sent' });
    return `${personName}: sent (${sid})`;
  } catch (err) {
    // Release the claim so the next tick can retry inside the window. Holding a
    // claim for a send that never happened means a silently skipped day.
    await releaseClaim(claimId);
    await logMessage({ personName, phone: person.phone, body, status: 'failed', errorText: err.message });
    return `${personName}: send failed — ${err.message}`;
  }
}

async function tick(now = new Date()) {
  if (!rcDb.isConfigured()) return;
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
  condense, buildLink, clip, isDue, recipients, sendOne, tick,
  hasConsent, sentDates, claim, releaseClaim, recordClaimResult, logMessage,
  MAX_SMS_CHARS, BRIEF_MODEL, SEND_WINDOW_MINUTES, DEFAULT_SEND_LOCAL,
  CONDENSE_TIMEOUT_MS,
};
