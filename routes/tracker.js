// routes/tracker.js
//
// Tracker inside P.AI: Region matrix, 1:1, AOP, Inbox, Follow-ups and the
// Message Center, behind P.AI's login and filtered to the viewer's scope.
//
// Two kinds of endpoint, deliberately:
//
//   DATA  — read and written straight against RC Tracker's Supabase. Scoped
//           here, in the query, so out-of-scope rows never reach the browser.
//
//   ACTIONS — anything with a side effect (sending a text, scheduling one,
//           uploading an image, polling Gmail) is PROXIED to RC Tracker. That
//           keeps the Twilio and reminder logic in exactly one place: the
//           engine that already sends Harold's daily follow-up texts every
//           morning. Duplicating it is how you end up double-texting people.
//
// Maintenance and the Resume tracker are deliberately absent — they stay on
// the RC Tracker site.

const express = require('express');
const router  = express.Router();

const rcDb  = require('../services/rc-db');
const { requireAuth } = require('../middleware/auth');
const { visiblePeople, canSee } = require('../services/rc-scope');

const RC_BASE = (process.env.RC_TRACKER_URL || 'https://rc-tracker-hos2.onrender.com').replace(/\/+$/, '');

router.use(requireAuth);

function sb(res) {
  const c = rcDb.getServiceClient() || rcDb.getClient();
  if (!c) res.status(503).json({ error: 'Tracker data is not configured' });
  return c;
}

// ── Who am I, and who can I see? ────────────────────────────────────────────
router.get('/me', (req, res) => {
  const u = req.session.user;
  res.json({
    username: u.username, name: u.name, role: u.role,
    scope: visiblePeople(u),
    rcBase: RC_BASE,
  });
});

// ── Tracker data blob (Region matrix, 1:1, AOP) ─────────────────────────────
//
// One JSON blob per person. P.AI owns the region / one-on-one / aop keys;
// RC Tracker still owns maintenance and resume in the same blob, which is why
// the write below merges by key instead of replacing the document. Replacing
// it would silently erase whatever the other app had just written.
const PAI_KEYS = ['regionTopics', 'region', 'one-on-one', 'oneOnOne', 'aop', 'aopPeriod', 'topics', 'matrix', 'notes'];

router.get('/data/:userId', async (req, res) => {
  const userId = decodeURIComponent(req.params.userId);
  if (userId !== req.session.user.name && !canSee(req.session.user, userId)) {
    return res.status(403).json({ error: 'Out of scope' });
  }
  const c = sb(res); if (!c) return;

  const { data, error } = await c.from('user_data').select('data').eq('user_id', userId).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });

  const blob = data ? data.data : {};
  // Maintenance and resume belong to the other app; do not ship them here.
  delete blob.maintenance; delete blob.resume;
  res.json(blob);
});

router.post('/data/:userId', async (req, res) => {
  const userId = decodeURIComponent(req.params.userId);
  // Writing someone else's board is a different thing from reading it.
  if (userId !== req.session.user.name) {
    return res.status(403).json({ error: 'You can only save your own tracker data' });
  }
  const c = sb(res); if (!c) return;

  const { data: existing, error: readErr } = await c
    .from('user_data').select('data').eq('user_id', userId).maybeSingle();
  if (readErr) return res.status(500).json({ error: readErr.message });

  const current = (existing && existing.data) || {};
  const incoming = req.body || {};

  // Merge only the keys this app owns. maintenance/resume survive untouched
  // even though the browser never saw them.
  const merged = { ...current };
  for (const k of Object.keys(incoming)) {
    if (k === 'maintenance' || k === 'resume') continue;
    merged[k] = incoming[k];
  }

  const { error } = await c.from('user_data')
    .upsert({ user_id: userId, data: merged, updated_at: new Date().toISOString() },
            { onConflict: 'user_id' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, keysWritten: Object.keys(incoming).filter(k => k !== 'maintenance' && k !== 'resume') });
});

// ── Follow-ups ──────────────────────────────────────────────────────────────
router.get('/follow-ups', async (req, res) => {
  const names = visiblePeople(req.session.user);
  if (!names.length) return res.json([]);
  const c = sb(res); if (!c) return;

  let q = c.from('follow_ups').select('*').order('created_at', { ascending: false });
  if (req.query.status) q = q.eq('status', req.query.status);
  q = q.in('assigned_to', names);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// Every write checks the row's assignee against scope first, so knowing an id
// is not enough to touch another area's item.
async function guardItem(req, res, c) {
  const { data, error } = await c.from('follow_ups')
    .select('assigned_to').eq('id', req.params.id).maybeSingle();
  if (error) { res.status(500).json({ error: error.message }); return null; }
  if (!data)  { res.status(404).json({ error: 'No such follow-up' }); return null; }
  if (!canSee(req.session.user, data.assigned_to)) {
    res.status(403).json({ error: 'Out of scope' }); return null;
  }
  return data;
}

router.post('/follow-ups', async (req, res) => {
  const c = sb(res); if (!c) return;
  const assignee = req.body.assigned_to;
  if (assignee && !canSee(req.session.user, assignee)) {
    return res.status(403).json({ error: `${assignee} is not in your scope` });
  }
  const row = {
    text: req.body.text, assigned_to: assignee || req.session.user.name,
    status: 'open', source: req.body.source || 'pai',
    due_date: req.body.due_date || null, due_time: req.body.due_time || null,
    notes: req.body.notes || [],
  };
  const { data, error } = await c.from('follow_ups').insert(row).select().single();
  if (error) return res.status(500).json({ error: error.message });
  res.json(data);
});

router.patch('/follow-ups/:id/done', async (req, res) => {
  const c = sb(res); if (!c) return;
  if (!await guardItem(req, res, c)) return;
  const { error } = await c.from('follow_ups')
    .update({ status: 'done', updated_at: new Date().toISOString() }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

router.patch('/follow-ups/:id', async (req, res) => {
  const c = sb(res); if (!c) return;
  if (!await guardItem(req, res, c)) return;
  if (req.body.assigned_to && !canSee(req.session.user, req.body.assigned_to)) {
    return res.status(403).json({ error: 'Cannot reassign outside your scope' });
  }
  const allowed = ['text', 'assigned_to', 'status', 'due_date', 'due_time',
                   'repeat_times', 'notes'];
  const updates = { updated_at: new Date().toISOString() };
  for (const k of allowed) if (k in req.body) updates[k] = req.body[k];

  const { error } = await c.from('follow_ups').update(updates).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

router.delete('/follow-ups/:id', async (req, res) => {
  const c = sb(res); if (!c) return;
  if (!await guardItem(req, res, c)) return;
  const { error } = await c.from('follow_ups').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

router.post('/follow-ups/:id/notes', async (req, res) => {
  const c = sb(res); if (!c) return;
  if (!await guardItem(req, res, c)) return;

  const { data: cur, error: readErr } = await c.from('follow_ups')
    .select('notes').eq('id', req.params.id).maybeSingle();
  if (readErr) return res.status(500).json({ error: readErr.message });

  const notes = Array.isArray(cur && cur.notes) ? cur.notes : [];
  notes.push({
    text: req.body.text || '', images: req.body.images || [],
    by: req.session.user.name, at: new Date().toISOString(),
  });
  const { error } = await c.from('follow_ups')
    .update({ notes, updated_at: new Date().toISOString() }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, notes });
});

// ── Inbox (email-sourced follow-ups) ────────────────────────────────────────
router.get('/email-followups', async (req, res) => {
  const c = sb(res); if (!c) return;
  let q = c.from('email_followups').select('*').order('received_at', { ascending: false });
  if (req.query.include_done !== 'true') q = q.eq('done', false);
  if (req.query.sms_only === 'true')     q = q.ilike('subject', 'SMS from%');
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

router.post('/email-followups/:id/done', async (req, res) => {
  const c = sb(res); if (!c) return;
  const { error } = await c.from('email_followups').update({ done: true }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── Message Center (reads) ──────────────────────────────────────────────────
router.get('/messages', async (req, res) => {
  const names = visiblePeople(req.session.user);
  if (!names.length) return res.json([]);
  const c = sb(res); if (!c) return;

  let q = c.from('sms_messages').select('*')
           .order('created_at', { ascending: false })
           .limit(Number(req.query.limit) || 200);
  if (req.query.person) {
    if (!canSee(req.session.user, req.query.person)) return res.status(403).json({ error: 'Out of scope' });
    q = q.eq('person', req.query.person);
  } else {
    q = q.in('person', names);
  }
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

router.get('/messages/threads', async (req, res) => {
  const names = visiblePeople(req.session.user);
  if (!names.length) return res.json([]);
  const c = sb(res); if (!c) return;

  const { data, error } = await c.from('sms_messages').select('*')
    .in('person', names).order('created_at', { ascending: false }).limit(1000);
  if (error) return res.status(500).json({ error: error.message });

  // Newest message per person — the thread list.
  const byPerson = new Map();
  for (const m of data || []) if (!byPerson.has(m.person)) byPerson.set(m.person, m);
  res.json([...byPerson.values()]);
});

// Proxied, not reimplemented. RC Tracker joins sms_consent against the roster
// and returns one row per PERSON with a computed status ('signed up' / 'opted
// out' / 'not signed up'). Returning raw consent rows here, as an earlier
// version did, gave the page no status field — so the Message Center showed
// everyone as not signed up when they were.
router.get('/sms-signups', (req, res) => proxy(req, res, '/api/sms-signups'));

// ── Actions — proxied to RC Tracker ─────────────────────────────────────────
//
// Sending, scheduling, image upload, the Gmail poll and the reminder preview
// all stay in RC Tracker. It is the one process that owns the Twilio number's
// outbound path and the reminder engine, and splitting that across two apps is
// how people get texted twice.
async function proxy(req, res, pathAndQuery, init = {}) {
  try {
    const r = await fetch(`${RC_BASE}${pathAndQuery}`, {
      method: init.method || 'GET',
      headers: init.body ? { 'Content-Type': 'application/json' } : undefined,
      body: init.body ? JSON.stringify(init.body) : undefined,
    });
    const text = await r.text();
    res.status(r.status);
    try { res.json(JSON.parse(text)); } catch { res.send(text); }
  } catch (err) {
    res.status(502).json({ error: `RC Tracker unreachable: ${err.message}` });
  }
}

router.post('/messages/send', async (req, res) => {
  const to = req.body.person || req.body.to;
  if (to && !canSee(req.session.user, to)) {
    return res.status(403).json({ error: `${to} is not in your scope` });
  }
  // Attribute the send to the signed-in user rather than an anonymous page.
  proxy(req, res, '/api/messages/send', {
    method: 'POST', body: { ...req.body, sent_by: req.session.user.name },
  });
});

router.post('/schedule-sms', async (req, res) => {
  const to = req.body.person || req.body.to;
  if (to && !canSee(req.session.user, to)) {
    return res.status(403).json({ error: `${to} is not in your scope` });
  }
  proxy(req, res, '/api/schedule-sms', {
    method: 'POST', body: { ...req.body, sent_by: req.session.user.name },
  });
});

router.get('/messages/scheduled', (req, res) =>
  proxy(req, res, '/api/messages/scheduled'));

router.post('/messages/scheduled/:sid/cancel', (req, res) =>
  proxy(req, res, `/api/messages/scheduled/${encodeURIComponent(req.params.sid)}/cancel`, { method: 'POST' }));

router.get('/reminders/preview', (req, res) => {
  const person = req.query.person;
  if (person && !canSee(req.session.user, person)) {
    return res.status(403).json({ error: 'Out of scope' });
  }
  const qs = new URLSearchParams({ person: person || '', ...(req.query.date ? { date: req.query.date } : {}) });
  proxy(req, res, `/api/reminders/preview?${qs}`);
});

router.get('/poll', (req, res) => proxy(req, res, '/api/poll'));

// Image upload is multipart; stream it through untouched rather than parsing.
router.post('/upload-image', express.raw({ type: '*/*', limit: '12mb' }), async (req, res) => {
  try {
    const r = await fetch(`${RC_BASE}/api/upload-image`, {
      method: 'POST',
      headers: { 'Content-Type': req.headers['content-type'] || 'application/octet-stream' },
      body: req.body,
    });
    const text = await r.text();
    res.status(r.status);
    try { res.json(JSON.parse(text)); } catch { res.send(text); }
  } catch (err) {
    res.status(502).json({ error: `RC Tracker unreachable: ${err.message}` });
  }
});

module.exports = router;
