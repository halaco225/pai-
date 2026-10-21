// routes/audits.js
//
// The readiness walks, in two halves with different doors:
//
//   PUBLIC  — /api/audits/form, /stores and /submit. No login, because shift
//             leaders have no P.AI account; Harold texts them the link. These
//             are the only endpoints without requireAuth in this file.
//
//   SCOPED  — responses, summary, photos, exports and the template editor sit
//             behind P.AI's login. Responses are filtered to the viewer's
//             stores, in the query, so out-of-scope walks never reach the
//             browser. Editing a template changes what every store is asked,
//             so that is held to RDOs and VPs.
//
// Grading happens here, never in the browser: services/audits.js holds the
// answer key and publicForm() is what goes out before submit.

const express = require('express');
const multer  = require('multer');
const crypto  = require('crypto');
const fs      = require('fs');
const ExcelJS = require('exceljs');

const router = express.Router();

const rcDb = require('../services/rc-db');
const db   = require('../services/db');
const templates = require('../services/audit-templates');
const walks = require('../services/audit-walks');
const { requireAuth, requireRole } = require('../middleware/auth');
const { visibleStores, canSee } = require('../services/rc-scope');
const { USER_ROSTER } = require('./auth');
const insights = require('../services/audit-insights');
const agent = require('../services/pai-agent');
const claude = require('../services/claude');
const { publicForm, grade, missingAnswers, checkOne } = require('../services/audits');

const DEFAULT_AUDIT = 'steritech-readiness';
const BUCKET        = 'audit-photos';
const PHOTO_TTL     = 60 * 10; // signed URL lifetime, seconds

// The page shrinks photos before upload (longest side ~1600px, JPEG ~0.7).
// This ceiling is for the HEIC fall-back, which uploads the original.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 12 * 1024 * 1024, files: 20 },
});

function serviceClient(res) {
  const c = rcDb.getServiceClient();
  if (!c) res.status(503).json({ error: 'Audits are not set up yet. Tell Harold.' });
  return c;
}

/**
 * The score as it was when the walk was taken.
 *
 * Templates are editable, so re-grading an old response against today's
 * questions would quietly change a score somebody already saw. Every response
 * freezes its own result at submit; the fallback is only for any row written
 * before that column existed.
 */
async function frozenGrade(row) {
  if (row.graded && Array.isArray(row.graded.results)) return row.graded;
  const def = await templates.getTemplate(row.audit_id);
  return def ? grade(def, row.answers) : { score: row.score, maxScore: row.max_score, results: [] };
}

// ── Public: the question set, with no answer key ────────────────────────────
router.get('/form', async (req, res) => {
  const def = await templates.getTemplate(req.query.id || DEFAULT_AUDIT);
  if (!def || !def.active) return res.status(404).json({ error: 'That walk does not exist.' });
  res.json(publicForm(def));
});

// ── Public: the store dropdown ──────────────────────────────────────────────
router.get('/stores', async (req, res) => {
  const assignments = await db.getStoreAssignments();
  const stores = Object.values(assignments)
    .map(s => ({ num: String(s.store_id), name: s.store_name || '' }))
    .sort((a, b) => a.num.localeCompare(b.num, undefined, { numeric: true }));
  res.json(stores);
});

// ── Public: mark one question, as soon as it is answered ────────────────────
//
// A walk is for teaching, so the wrong answer is worth more at the moment it
// is given than in a list at the end. That means the key has to reach the
// phone — but only for a question already answered, and only one at a time.
// The form itself still goes out without it.
// The answer is written down before it is marked, and the first one written
// is the one that counts — so reading the verdict and going back to change
// the pick achieves nothing. submit() grades what was written down.
router.post('/check', async (req, res) => {
  const def = await templates.getTemplate(req.body.auditId || DEFAULT_AUDIT);
  if (!def || !def.active) return res.status(404).json({ error: 'That walk does not exist.' });

  const q = def.questions.find(x => x.n === Number(req.body.n));
  if (!q) return res.status(400).json({ error: 'That question is not in this walk.' });

  let answer = req.body.answer;
  try {
    const onRecord = await walks.recordAnswer(req.body.walkId, def.id, def.version, req.body.n, answer);
    // Only use what was written down if it is still an answer to this
    // question. A walk left open across an edit can hold an answer to the
    // question that used to be here.
    if (onRecord !== undefined && walks.fits(q, onRecord)) answer = onRecord;
  } catch (err) {
    // No database is not a reason to stop a shift leader mid-walk.
    console.error('audit walk record failed:', err.message);
  }

  const result = checkOne(def, req.body.n, answer);
  if (!result) {
    return res.status(400).json({ error: 'Answer this one before checking it.' });
  }
  res.json(result);
});

// ── Public: submit a walk ───────────────────────────────────────────────────
//
// Photos arrive as files named photo_<question number>. Everything else comes
// as one JSON field so the shapes survive multipart intact.
router.post('/submit', upload.any(), async (req, res) => {
  // Deliberately not checking `active`. Pausing a walk stops new ones being
  // started — /form is what refuses — but somebody who was already part way
  // through it when it was paused has done the work, and throwing it away at
  // the last step is how you teach people not to bother next time.
  const def = await templates.getTemplate(req.body.auditId || DEFAULT_AUDIT);
  if (!def) return res.status(404).json({ error: 'That walk does not exist.' });

  let answers;
  try {
    answers = JSON.parse(req.body.answers || '{}');
  } catch {
    return res.status(400).json({ error: 'Your answers did not come through. Try submitting again.' });
  }

  // Scored questions are taken from what the walk wrote down as each one was
  // answered, not from this request. The phone was told the right answers
  // along the way, so it does not get to report the score as well.
  try {
    const recorded = await walks.getAnswers(req.body.walkId, def.version);
    answers = walks.sealed(recorded, answers, def);
  } catch (err) {
    console.error('audit walk read failed:', err.message);
  }

  const files = req.files || [];
  const byQuestion = {};
  for (const f of files) {
    const n = Number(String(f.fieldname).replace(/^photo_/, ''));
    if (!Number.isInteger(n)) continue;
    (byQuestion[n] = byQuestion[n] || []).push(f);
  }

  // Check completeness against the files in hand, before uploading any of
  // them — a rejected submission should not leave orphan photos behind.
  const pending = {};
  for (const [n, list] of Object.entries(byQuestion)) pending[n] = list.map(() => 'pending');
  const missing = missingAnswers(def, answers, pending);
  if (missing.length) return res.status(400).json({ error: 'Some questions are not finished.', missing });

  const nameQ  = def.questions.find(q => q.type === 'text');
  const storeQ = def.questions.find(q => q.type === 'text' && q !== nameQ);
  const fixesQ = def.questions.find(q => q.type === 'longtext');

  const name  = String(answers[nameQ ? nameQ.n : 1] || '').trim();
  const store = String(answers[storeQ ? storeQ.n : 2] || '').trim();
  const fixes = String(answers[fixesQ ? fixesQ.n : 20] || '').trim();

  const c = serviceClient(res); if (!c) return;

  // Random file names: never the store number or the person's name, so a path
  // that leaks says nothing about who or where.
  const photos = {};
  for (const [n, list] of Object.entries(byQuestion)) {
    photos[n] = [];
    for (const f of list) {
      const ext  = (f.mimetype && f.mimetype.split('/')[1] || 'jpg').replace(/[^a-z0-9]/gi, '').slice(0, 5);
      const path = `${def.id}/${crypto.randomUUID()}.${ext || 'jpg'}`;
      const { error } = await c.storage.from(BUCKET)
        .upload(path, f.buffer, { contentType: f.mimetype || 'image/jpeg', upsert: false });
      if (error) {
        return res.status(502).json({ error: 'The pictures did not finish uploading. Your answers are still here — hit submit again.' });
      }
      photos[n].push(path);
    }
  }

  const graded = grade(def, answers);

  // One row per walk. A submission that saved but whose reply never got back
  // to the phone looks like a failure, so people press the button again —
  // and a double tap sends two at once. Either way the walk only lands once.
  const walkId = walks.isUuid(req.body.walkId) ? req.body.walkId : null;

  const { data, error } = await c.from('audit_responses').insert({
    walk_id: walkId,
    audit_id: def.id,
    respondent_name: name,
    store_number: store,
    answers,
    photos,
    score: graded.score,
    max_score: graded.maxScore,
    fixes,
    user_agent: String(req.get('user-agent') || '').slice(0, 300),
    graded,                       // frozen, so a later edit cannot re-score this walk
    template_version: def.version,
  }).select('id').single();

  if (error) {
    // 23505 is the unique index on walk_id: this walk is already in. Hand
    // back what was saved the first time rather than a second row or a
    // scary red message about something that actually worked.
    if (error.code === '23505' && walkId) {
      const { data: already } = await c.from('audit_responses')
        .select('id, graded, score, max_score').eq('walk_id', walkId).single();
      if (already) {
        const frozen = already.graded && Array.isArray(already.graded.results) ? already.graded : graded;
        return res.json({
          id: already.id,
          score: already.score, maxScore: already.max_score,
          results: frozen.results,
          alreadyIn: true,
        });
      }
    }
    return res.status(502).json({ error: 'That did not save. Your answers are still here — hit submit again.' });
  }

  // Only now does the answer key go out, for the results screen.
  res.json({ id: data.id, score: graded.score, maxScore: graded.maxScore, results: graded.results });
});

// ───────────────────────────── everything below needs a login ───────────────
router.use(requireAuth);

/**
 * One walk, by its id, if this viewer may read it.
 *
 * Opening a walk has nothing to do with which audit the filters happen to be
 * showing, but it used to go through scopedRows — which fetches one audit,
 * defaulting to the Steritech one. So clicking a row on any other test went
 * looking for it among the wrong audit's walks and came back "Not found".
 *
 * Asking for the row itself removes the whole class of bug: the filters stay
 * a filter, and permission is still checked, just against the row in hand.
 */
async function walkForViewer(req, res, id) {
  const user = req.session.user;
  const c = serviceClient(res); if (!c) return null;

  const { data, error } = await c.from('audit_responses').select('*').eq('id', id).maybeSingle();
  if (error) { res.status(500).json({ error: error.message }); return null; }
  if (!data) { res.status(404).json({ error: 'Not found' }); return null; }

  const maySeeAll = user.role === 'rdo' || user.role === 'vp';
  const stores = visibleStores(user, await db.getStoreAssignments());
  // Out of scope and not there look the same from outside, on purpose.
  if (!maySeeAll && !stores.has(String(data.store_number))) {
    res.status(404).json({ error: 'Not found' });
    return null;
  }
  return data;
}

async function scopedRows(req, res) {
  const user = req.session.user;
  const stores = visibleStores(user, await db.getStoreAssignments());
  const auditId = req.query.auditId || DEFAULT_AUDIT;

  // A test being run across the whole company is not a regional thing: the
  // person who sent it out has to be able to read what came back, and open
  // it, whoever's store it came from. So an RDO or a VP sees everything by
  // default and narrows down with the filter — the other way round meant a
  // walk you could count on the overview was a 404 when you clicked it.
  // An Area Coach stays inside their own stores either way.
  const maySeeAll = user.role === 'rdo' || user.role === 'vp';
  const everywhere = maySeeAll && String(req.query.scope || '') !== 'mine';

  const c = serviceClient(res); if (!c) return null;

  // Everything for this audit, then split by what this viewer may read. The
  // count of the rest is reported without any detail: somebody who shares a
  // link needs to know a walk came back even when it came from a store that
  // is not theirs, or it looks like the link is broken.
  const { data, error } = await c.from('audit_responses')
    .select('*')
    .eq('audit_id', auditId)
    .order('created_at', { ascending: false });

  if (error) { res.status(500).json({ error: error.message }); return null; }

  const all = data || [];
  const rows = everywhere ? all : all.filter(r => stores.has(String(r.store_number)));
  const outside = all.length - rows.length;
  return { rows, stores, outside, everywhere, maySeeAll };
}

function withStoreInfo(rows, assignments) {
  return rows.map(r => {
    const s = assignments[r.store_number] || {};
    return {
      id: r.id,
      created_at: r.created_at,
      name: r.respondent_name,
      store_number: r.store_number,
      store_name: s.store_name || '',
      area_coach: s.area_coach || '',
      region_coach: s.region_coach || '',
      score: r.score,
      max_score: r.max_score,
    };
  });
}

function applyFilters(rows, query) {
  const { store, coach, region, from, to } = query;
  let out = rows;
  if (region) out = out.filter(r => r.region_coach === region);
  if (store) out = out.filter(r => r.store_number === String(store));
  if (coach) out = out.filter(r => r.area_coach === coach);
  if (from)  out = out.filter(r => r.created_at >= from);
  if (to)    out = out.filter(r => r.created_at <= `${to}T23:59:59Z`);
  return out;
}

// ── Templates ───────────────────────────────────────────────────────────────
//
/**
 * Who sees a template in the list.
 *
 * RDOs and VPs see everything: they are the ones who build these, and a test
 * that half the company is taking is not a secret from the people who run it.
 * Everyone else sees what they made themselves and what came from above them —
 * their own RDO's and VP's — and nothing from across the company.
 *
 * A template saved before owners existed has nobody to compare against, so it
 * stays visible rather than disappearing from under the people using it.
 */
function maySeeTemplate(user, t) {
  if (user.role === 'rdo' || user.role === 'vp') return true;
  if (!t.createdBy) return true;
  if (t.createdBy === user.username) return true;
  const maker = USER_ROSTER.find(u => u.username === t.createdBy);
  return maker ? canSee(maker, user.name) : false;
}

router.get('/templates', async (req, res) => {
  const list = await templates.listTemplates();
  res.json(list.filter(t => maySeeTemplate(req.session.user, t)).map(t => ({
    id: t.id, title: t.title, description: t.description,
    kind: t.kind,
    questions: t.questions.length,
    points: t.questions.reduce((s, q) => s + (q.points || 0), 0),
    version: t.version, active: t.active,
    updatedAt: t.updatedAt, updatedBy: t.updatedBy, createdBy: t.createdBy,
  })));
});

// The whole definition, answer key and all. That is the editor's copy, so it
// is held to the people who may edit — everyone else gets the form through
// /form, which strips the answers out.
router.get('/templates/:id', requireRole('rdo', 'vp'), async (req, res) => {
  const def = await templates.getTemplate(req.params.id);
  if (!def) return res.status(404).json({ error: 'Not found' });
  res.json(def);
});

router.post('/templates', requireRole('rdo', 'vp'), async (req, res) => {
  const problems = templates.validateTemplate(req.body);
  if (problems.length) return res.status(400).json({ error: problems[0], problems });

  const saved = await templates.saveTemplate(req.body, req.session.user.username);
  res.json(saved);
});

router.post('/templates/:id/active', requireRole('rdo', 'vp'), async (req, res) => {
  const saved = await templates.setActive(req.params.id, req.body.active);
  if (!saved) return res.status(404).json({ error: 'Not found' });
  res.json(saved);
});

router.delete('/templates/:id', requireRole('rdo', 'vp'), async (req, res) => {
  // Responses keep their own frozen copy of the questions, so deleting a
  // template never blanks out a walk somebody already did.
  const gone = await templates.deleteTemplate(req.params.id);
  if (!gone) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

// ── The responses list ──────────────────────────────────────────────────────
router.get('/responses', async (req, res) => {
  const scoped = await scopedRows(req, res); if (!scoped) return;
  const assignments = await db.getStoreAssignments();

  const rows = applyFilters(withStoreInfo(scoped.rows, assignments), req.query);

  res.json({
    responses: rows,
    outside: scoped.outside || 0,
    maySeeAll: !!scoped.maySeeAll,
    everywhere: !!scoped.everywhere,
    coaches: [...new Set(rows.map(r => r.area_coach).filter(Boolean))].sort(),
    stores: [...new Set(rows.map(r => r.store_number))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
  });
});

// ── One response, with the score it got on the day ──────────────────────────
router.get('/responses/:id', async (req, res) => {
  const row = await walkForViewer(req, res, req.params.id); if (!row) return;

  const assignments = await db.getStoreAssignments();
  const store = assignments[row.store_number] || {};
  const graded = await frozenGrade(row);

  // Photo questions come from the response's own photo map, so a question
  // deleted from the template since does not hide the pictures it collected.
  const photoQuestions = Object.keys(row.photos || {})
    .map(Number).sort((a, b) => a - b)
    .map(n => ({ n, paths: row.photos[n] || [] }));

  res.json({
    id: row.id,
    created_at: row.created_at,
    name: row.respondent_name,
    store_number: row.store_number,
    store_name: store.store_name || '',
    area_coach: store.area_coach || '',
    fixes: row.fixes,
    templateVersion: row.template_version,
    photoQuestions,
    ...graded,
  });
});

// ── Throw a walk away ───────────────────────────────────────────────────────
//
// Test walks have to be clearable, or the first real round starts with
// rubbish in the averages. Scoped the same as reading one, so nobody can
// delete a walk they could not have opened, and the pictures go with it.
router.delete('/responses/:id', requireRole('rdo', 'vp'), async (req, res) => {
  const row = await walkForViewer(req, res, req.params.id); if (!row) return;

  const c = serviceClient(res); if (!c) return;

  const paths = Object.values(row.photos || {}).flat().filter(Boolean);
  if (paths.length) {
    const { error } = await c.storage.from(BUCKET).remove(paths);
    // A photo that will not delete is not a reason to keep the row; it would
    // leave the walk in the averages forever. Say so in the log instead.
    if (error) console.error('audit photo delete failed:', error.message);
  }

  const { error } = await c.from('audit_responses').delete().eq('id', row.id);
  if (error) return res.status(502).json({ error: error.message });

  res.json({ ok: true, photosRemoved: paths.length });
});

// ── A photo, through a short-lived signed URL ───────────────────────────────
router.get('/photo', async (req, res) => {
  const path = String(req.query.path || '');
  // The walk it belongs to is named, and checked, so a picture from any audit
  // opens for whoever may read that walk — and nobody else.
  const row = await walkForViewer(req, res, String(req.query.id || '')); if (!row) return;

  const allowed = Object.values(row.photos || {}).some(list => (list || []).includes(path));
  if (!allowed) return res.status(404).json({ error: 'Not found' });

  const c = serviceClient(res); if (!c) return;
  const { data, error } = await c.storage.from(BUCKET).createSignedUrl(path, PHOTO_TTL);
  if (error) return res.status(502).json({ error: error.message });
  res.redirect(data.signedUrl);
});

// ── Which questions the region keeps missing ────────────────────────────────
//
// Built from each response's frozen score, so a walk taken before a question
// was reworded still reports what that person actually answered.
async function summarise(req, res) {
  const scoped = await scopedRows(req, res); if (!scoped) return null;
  const assignments = await db.getStoreAssignments();

  const keep = new Set(applyFilters(withStoreInfo(scoped.rows, assignments), req.query).map(r => r.id));
  const rows = scoped.rows.filter(r => keep.has(r.id));

  const graded = [];
  for (const row of rows) graded.push(await frozenGrade(row));

  // How long a walk takes. The page writes its first answer down as soon as
  // one is given, so the gap between that row and the submitted one is the
  // time it took. Only walks since the id was recorded on the response can
  // be measured, so the count it is based on is reported with it.
  const started = await walks.startedAt(rows.map(r => r.walk_id).filter(Boolean));
  const spans = [];
  for (const r of rows) {
    const began = r.walk_id && started[r.walk_id];
    if (!began) continue;
    const mins = (Date.parse(r.created_at) - Date.parse(began)) / 60000;
    // A walk left open overnight and finished the next day is not a
    // completion time, it is a forgotten tab.
    if (mins > 0 && mins < 240) spans.push(mins);
  }
  const minutes = spans.length
    ? { average: Math.round((spans.reduce((a, b) => a + b, 0) / spans.length) * 10) / 10,
        fastest: Math.round(Math.min(...spans) * 10) / 10,
        from: spans.length }
    : { average: null, fastest: null, from: 0 };

  // Got everything right, first time they ever took it. Their first walk is
  // the one that counts: a perfect score on the third go is a different
  // thing, and the point of this list is who already knew it.
  const firstEach = new Map();
  for (const r of [...rows].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))) {
    const who = String(r.respondent_name || '').trim();
    if (!who || firstEach.has(who.toLowerCase())) continue;
    firstEach.set(who.toLowerCase(), r);
  }
  const perfect = [...firstEach.values()]
    .filter(r => Number(r.max_score) > 0 && Number(r.score) === Number(r.max_score))
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))
    .slice(0, 5)
    .map(r => ({
      name: r.respondent_name,
      store_number: r.store_number,
      store_name: (assignments[r.store_number] || {}).store_name || '',
      at: r.created_at,
    }));

  const byRegion = {};
  for (const r of rows) {
    const who = (assignments[r.store_number] || {}).region_coach || 'Not assigned';
    const g = byRegion[who] = byRegion[who] || { region_coach: who, responses: 0, totalScore: 0, stores: new Set() };
    g.responses += 1;
    g.totalScore += Number(r.score);
    g.stores.add(String(r.store_number));
  }

  const byArea = {};
  for (const r of rows) {
    const who = (assignments[r.store_number] || {}).area_coach || 'Not assigned';
    const a = byArea[who] = byArea[who] || { area_coach: who, responses: 0, totalScore: 0, stores: new Set() };
    a.responses += 1;
    a.totalScore += Number(r.score);
    a.stores.add(String(r.store_number));
  }

  const byStore = {};
  for (const r of rows) {
    const s = byStore[r.store_number] = byStore[r.store_number] || {
      store_number: r.store_number,
      store_name: (assignments[r.store_number] || {}).store_name || '',
      area_coach: (assignments[r.store_number] || {}).area_coach || '',
      responses: 0, totalScore: 0,
    };
    s.responses += 1;
    s.totalScore += r.score;
  }

  const read = insights.build(rows, graded, assignments);

  return {
    rows, assignments, graded,
    summary: {
      responses: rows.length,
      averageScore: read.averageScore,
      maxScore: read.maxScore,
      questions: read.questions,
      standouts: read.standouts,
      repeats: read.repeats,
      days: read.days,
      coaches: read.coaches,
      stores: Object.values(byStore)
        .map(s => ({ ...s, averageScore: +(s.totalScore / s.responses).toFixed(1) }))
        .sort((a, b) => a.averageScore - b.averageScore),
      minutes,
      perfect,
      regions: Object.values(byRegion)
        .map(g => ({
          region_coach: g.region_coach, responses: g.responses, stores: g.stores.size,
          averageScore: +(g.totalScore / g.responses).toFixed(1),
        }))
        .sort((a, b) => a.averageScore - b.averageScore),
      areas: Object.values(byArea)
        .map(a => ({
          area_coach: a.area_coach, responses: a.responses, stores: a.stores.size,
          averageScore: +(a.totalScore / a.responses).toFixed(1),
        }))
        .sort((a, b) => a.averageScore - b.averageScore),
    },
  };
}

// ── Everyone's answers, one question at a time ──────────────────────────────
//
// A percentage you cannot click into is a dead end: it says a question is
// being missed and leaves you to guess by whom. This is the same scoped set
// the summary is built from, laid out per person per question, so the tab
// can open any number on it and show the walks behind it.
//
// Small by nature -- a round is tens of walks, not thousands -- so it goes
// in one payload rather than a request per drill-down.
router.get('/matrix', async (req, res) => {
  const result = await summarise(req, res);
  if (!result) return;
  const { rows, assignments, graded } = result;

  const seen = new Map();
  for (const g of graded) {
    for (const r of g.results) {
      if (!seen.has(r.n)) seen.set(r.n, { n: r.n, title: r.title, type: r.type, points: r.points });
    }
  }

  const label = r => {
    if (r.type === 'hotspot') {
      const missed = (r.hotspots || [])
        .filter((_, i) => !(r.found || []).includes(i))
        .map(h => h.label);
      return missed.length ? 'Walked past: ' + missed.join(', ') : 'Found all of them';
    }
    const names = (r.given || []).map(i => (r.choices || [])[i]).filter(Boolean);
    return names.length ? names.join(' · ') : 'No answer';
  };

  res.json({
    questions: [...seen.values()].sort((a, b) => a.n - b.n),
    responses: rows.map((row, i) => {
      const store = assignments[row.store_number] || {};
      return {
        id: row.id,
        created_at: row.created_at,
        name: row.respondent_name,
        store_number: row.store_number,
        store_name: store.store_name || '',
        area_coach: store.area_coach || '',
        score: row.score,
        max_score: row.max_score,
        answers: Object.fromEntries(graded[i].results.map(r => [r.n, {
          correct: r.correct, earned: r.earned, said: label(r),
        }])),
      };
    }),
  });
});

/**
 * Every test and audit on one screen, which is the question you actually
 * arrive with: what is out there, who has done it, and where is it going
 * wrong. Until this existed the whole tab reported on one hard-coded walk,
 * so results from everything else were invisible.
 *
 * Coverage is counted in stores, not people: a walk belongs to a store, and
 * "nine of my fourteen have done it" is the sentence worth reading.
 */
router.get('/overview', async (req, res) => {
  const user = req.session.user;
  const assignments = await db.getStoreAssignments();
  const stores = visibleStores(user, assignments);
  const maySeeAll = user.role === 'rdo' || user.role === 'vp';
  const everywhere = maySeeAll && String(req.query.scope || '') !== 'mine';

  const c = serviceClient(res); if (!c) return;

  const list = (await templates.listTemplates()).filter(t => maySeeTemplate(user, t));
  const { data, error } = await c
    .from('audit_responses')
    .select('id, audit_id, store_number, respondent_name, score, max_score, created_at')
    .order('created_at', { ascending: false });
  if (error) return res.status(502).json({ error: error.message });

  const inScope = (data || []).filter(r => everywhere || stores.has(String(r.store_number)));
  // Same filters as everywhere else, so what the overview counts is what the
  // tabs underneath it will show.
  const keep = new Set(applyFilters(withStoreInfo(inScope, assignments), req.query).map(r => r.id));
  const mine = inScope.filter(r => keep.has(r.id));

  const out = list.map(t => {
    const rows = mine.filter(r => r.audit_id === t.id);
    const scored = rows.filter(r => Number(r.max_score) > 0);
    const share = scored.length
      ? scored.reduce((sum, r) => sum + (Number(r.score) / Number(r.max_score)), 0) / scored.length
      : null;
    const done = new Set(rows.map(r => String(r.store_number)));

    // Stores that owe one. Only meaningful inside a region: "everywhere"
    // counts against every store in the company, which nobody is chasing.
    const owed = everywhere ? [] : [...stores].filter(n => !done.has(n));

    return {
      id: t.id,
      title: t.title,
      kind: t.kind,
      active: t.active,
      coach: t.coach || null,
      questions: t.questions.length,
      points: t.questions.reduce((sum, q) => sum + (q.points || 0), 0),
      walks: rows.length,
      average: share == null ? null : Math.round(share * 1000) / 10,
      lastAt: rows.length ? rows[0].created_at : null,
      lastBy: rows.length ? rows[0].respondent_name : null,
      storesDone: done.size,
      storesInScope: everywhere ? null : stores.size,
      owed: owed.slice(0, 200).map(n => ({
        store_number: n,
        store_name: (assignments[n] || {}).store_name || '',
        area_coach: (assignments[n] || {}).area_coach || '',
      })),
    };
  });

  // Most recently used first; anything nobody has taken sinks to the bottom.
  out.sort((a, b) => (b.lastAt ? Date.parse(b.lastAt) : 0) - (a.lastAt ? Date.parse(a.lastAt) : 0));

  const seen = withStoreInfo(inScope, assignments);
  const uniq = (list, key) => [...new Set(list.map(x => x[key]).filter(Boolean))].sort();

  res.json({
    audits: out, maySeeAll, everywhere,
    regions: uniq(seen, 'region_coach'),
    coaches: uniq(seen, 'area_coach'),
    stores: [...new Map(seen.map(r => [r.store_number,
      { store_number: r.store_number, store_name: r.store_name }])).values()]
      .sort((a, b) => String(a.store_number).localeCompare(String(b.store_number))),
  });
});

router.get('/summary', async (req, res) => {
  const result = await summarise(req, res);
  if (result) res.json(result.summary);
});

// ── Ask P.AI: the same summary, answered in words ───────────────────────────
//
// Deliberately built on summarise() rather than its own query. The AI is
// handed exactly the bundle the Reporting tab is drawing, for exactly the
// filters that are set, so it can never quote a number that is not on screen
// — and it can never see a store the viewer is not scoped to, because
// scopedRows() has already done that filtering.
router.post('/ask', async (req, res) => {
  const question = String(req.body?.question || '').trim();
  if (!question) return res.status(400).json({ error: 'Ask something first.' });
  if (question.length > 1000) {
    return res.status(400).json({ error: 'That is too long. Ask it in a sentence or two.' });
  }

  const result = await summarise(req, res);
  if (!result) return;                       // summarise already answered

  if (!result.rows.length) {
    return res.json({ answer: 'There are no responses in this filter yet, so there is nothing to read. Widen the dates or pick a different audit.' });
  }

  try {
    const answer = await agent.answerAboutAudits({
      question,
      summary: result.summary,
      scopeNote: `These are the ${result.rows.length} walk(s) currently filtered on screen.`,
    });
    res.json({ answer });
  } catch (e) {
    console.error('audits/ask:', e);
    res.status(500).json({ error: e.message || 'P.AI could not read that right now.' });
  }
});

// ── Create: a described audit comes back as an unsaved draft ────────────────
//
// Nothing is written. The draft is validated with the same validateTemplate()
// the Save button uses and handed to the browser, which drops it into the
// normal editor — so a draft the AI got slightly wrong is fixed the same way
// any hand-built audit is, and nothing reaches a store until someone saves it.
const DRAFT_UPLOAD_DIR = '/tmp/uploads';
fs.mkdirSync(DRAFT_UPLOAD_DIR, { recursive: true });
const draftUpload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, DRAFT_UPLOAD_DIR),
    filename: (req, file, cb) => cb(null, `draft_${Date.now()}_${file.originalname}`),
  }),
  // An area's Steritech round is eight or nine stores, so six was the wrong
  // number for the thing people actually want to upload.
  limits: { fileSize: 25 * 1024 * 1024, files: 12 },
});

// Reading a dozen PDFs takes real time, and the asking pass exists so the
// second pass can use the same text without the browser sending it again.
// Held in memory, keyed to the user who uploaded it, and dropped after half an
// hour or when the next plan pushes it out.
//
// shortcut: in-process, so a plan does not survive a restart and would not be
// found by a second instance. P.AI runs as one process (server.js says so at
// startup); move this to the database if it is ever scaled out.
const PLANS = new Map();
const PLAN_TTL_MS = 30 * 60 * 1000;
const PLAN_MAX = 40;

function putPlan(username, payload) {
  const id = crypto.randomBytes(16).toString('hex');
  PLANS.set(id, { ...payload, username, at: Date.now() });
  // Oldest out first, and expired ones out whenever we touch the map, so a
  // quiet week does not leave a dozen regions' audit text sitting in memory.
  for (const [key, held] of PLANS) {
    if (Date.now() - held.at > PLAN_TTL_MS) PLANS.delete(key);
  }
  while (PLANS.size > PLAN_MAX) PLANS.delete(PLANS.keys().next().value);
  return id;
}

function takePlan(id, username) {
  const held = PLANS.get(String(id || ''));
  if (!held) return null;
  if (Date.now() - held.at > PLAN_TTL_MS) { PLANS.delete(id); return null; }
  // The uploaded text is one person's; another signed-in user holding the id
  // must not be able to read it back.
  if (held.username !== username) return null;
  return held;
}

// The answers come back through a multipart form, so everything is a string.
// Types are checked against the list the drafting prompt offers rather than
// passed through: a type the editor cannot render is a question nobody can
// answer, and the validator would only catch it after the model had spent a
// minute writing twenty of them.
const ANSWERABLE_TYPES = new Set(['text', 'longtext', 'single', 'multi', 'number',
                                  'scale', 'datetime', 'photo', 'order']);
const MAX_DRAFT_QUESTIONS = 40;

function readAnswers(body) {
  const list = v => {
    if (Array.isArray(v)) return v;
    const s = String(v || '').trim();
    if (!s) return [];
    if (s.startsWith('[')) { try { return JSON.parse(s); } catch { return []; } }
    return s.split(',').map(x => x.trim()).filter(Boolean);
  };

  const count = Number(body?.count);
  return {
    count: Number.isInteger(count) && count > 0 && count <= MAX_DRAFT_QUESTIONS ? count : null,
    types: list(body?.types).map(String).filter(t => ANSWERABLE_TYPES.has(t)),
    focus: list(body?.focus).map(s => String(s).slice(0, 160)).slice(0, 12),
    notes: String(body?.notes || '').trim().slice(0, 1000) || null,
  };
}

// Reads the uploaded files to text and deletes them. A file that cannot be
// read is reported by name rather than failing the batch — eight good PDFs
// and one scanned image should still produce a plan.
async function readReferenceFiles(files) {
  const skipped = [];
  const read = [];
  const chunks = [];
  for (const f of files) {
    try {
      const text = await claude.extractTextFromFile(f);
      if (text && text.trim()) {
        chunks.push(`--- ${f.originalname} ---\n${text}`);
        read.push(f.originalname);
      } else {
        skipped.push(f.originalname);
      }
    } catch (e) {
      console.error('draft extract', f.originalname, e.message);
      skipped.push(f.originalname);
    } finally {
      fs.unlink(f.path, () => {});
    }
  }
  return { referenceText: chunks.join('\n\n') || null, read, skipped };
}

// ── Create, pass one: read the files and ask before building ────────────────
router.post('/templates/draft/plan', requireRole('rdo', 'vp'),
  draftUpload.array('files', 12), async (req, res) => {
  const ask = String(req.body?.ask || '').trim();
  const kind = req.body?.kind === 'test' ? 'test' : 'audit';
  const files = req.files || [];

  if (!files.length) {
    return res.status(400).json({ error: 'Attach the audits you want it to read.' });
  }

  try {
    const { referenceText, read, skipped } = await readReferenceFiles(files);
    if (!referenceText) {
      return res.status(400).json({
        error: `Could not read any text from ${skipped.join(', ')}. Scanned images and photos will not work — P.AI needs the text.`,
      });
    }

    const plan = await agent.planTemplate({ ask, kind, referenceText });
    const planId = putPlan(req.session.user.username, { referenceText, ask, kind });

    res.json({ planId, kind, read, skipped, found: plan.found, themes: plan.themes });
  } catch (e) {
    console.error('audits/templates/draft/plan:', e);
    for (const f of files) fs.unlink(f.path, () => {});
    res.status(500).json({ error: e.message || 'P.AI could not read those files.' });
  }
});

// ── Create, pass two: build it ──────────────────────────────────────────────
//
// Two ways in. With a planId it uses the text pass one already read and the
// answers given to its questions. Without one it is the original single-shot
// path: a description, optionally with files, and no questions asked — still
// the right flow for "a short opening checklist" with nothing to attach.
router.post('/templates/draft', requireRole('rdo', 'vp'),
  draftUpload.array('files', 12), async (req, res) => {
  const ask = String(req.body?.ask || '').trim();
  const files = req.files || [];
  const planId = String(req.body?.planId || '').trim();

  const plan = planId ? takePlan(planId, req.session.user.username) : null;
  if (planId && !plan) {
    for (const f of files) fs.unlink(f.path, () => {});
    return res.status(410).json({
      error: 'That reading has expired. Upload the files again.',
    });
  }

  const kind = plan ? plan.kind : (req.body?.kind === 'test' ? 'test' : 'audit');

  if (!plan && !ask && !files.length) {
    return res.status(400).json({ error: 'Say what you want it to cover, or attach something to build it from.' });
  }

  try {
    let referenceText = plan ? plan.referenceText : null;
    let skipped = [];
    if (!plan) {
      const got = await readReferenceFiles(files);
      referenceText = got.referenceText;
      skipped = got.skipped;
    }

    const def = await agent.draftTemplate({
      ask: ask || (plan && plan.ask) || 'Build it from the attached material.',
      kind,
      referenceText,
      answers: plan ? readAnswers(req.body) : null,
    });

    // The model is not asked for an id — the editor slugs one from the title
    // on first save, and an id it invented could collide with a live audit.
    def.id = '';
    def.version = 0;
    def.kind = kind;
    def.coach = kind === 'test' ? 'adam' : 'none';

    // Validated with a placeholder id, because a blank id is the one problem
    // that is correct at this stage and would otherwise be the only thing
    // reported back.
    const problems = templates.validateTemplate({ ...def, id: 'draft' });

    res.json({ template: def, problems, skipped });
  } catch (e) {
    console.error('audits/templates/draft:', e);
    for (const f of files) fs.unlink(f.path, () => {});
    res.status(500).json({ error: e.message || 'P.AI could not draft that. Try describing it again.' });
  }
});

// ── Exports: one row per response ───────────────────────────────────────────
async function exportRows(req, res) {
  const result = await summarise(req, res);
  if (!result) return null;

  const { rows, assignments, graded } = result;
  const stats = result.summary.questions || [];

  // Columns follow the union of every question seen, so a response taken
  // before a question was added still lines up under the right heading.
  const questions = [];
  const seen = new Set();
  for (const g of graded) {
    for (const r of g.results) {
      if (seen.has(r.n)) continue;
      seen.add(r.n);
      questions.push({ n: r.n, title: r.title });
    }
  }
  questions.sort((a, b) => a.n - b.n);

  const header = ['Date', 'Store', 'Store name', 'Area Coach', 'Name', 'Score', 'Out of',
    ...questions.map(q => `Q${q.n}`), 'Top 3 fixes'];

  const body = rows.map((row, i) => {
    const s = assignments[row.store_number] || {};
    const byN = new Map(graded[i].results.map(r => [r.n, r]));
    return [
      new Date(row.created_at).toISOString().replace('T', ' ').slice(0, 16),
      row.store_number, s.store_name || '', s.area_coach || '',
      row.respondent_name, row.score, row.max_score,
      ...questions.map(q => {
        const hit = byN.get(q.n);
        return hit ? (hit.correct ? 'Right' : 'Wrong') : '';
      }),
      row.fixes || '',
    ];
  });

  return { header, body, questions, stats };
}

router.get('/export.csv', async (req, res) => {
  const data = await exportRows(req, res);
  if (!data) return;

  const cell = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const lines = [data.header.map(cell).join(',')];
  for (const row of data.body) lines.push(row.map(cell).join(','));

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="audits-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(lines.join('\n'));
});

router.get('/export.xlsx', async (req, res) => {
  const data = await exportRows(req, res);
  if (!data) return;

  const book = new ExcelJS.Workbook();
  book.creator = 'P.AI';
  const sheet = book.addWorksheet('Responses', { views: [{ state: 'frozen', ySplit: 1 }] });

  sheet.addRow(data.header);
  sheet.getRow(1).font = { bold: true };
  for (const row of data.body) sheet.addRow(row);

  // The question columns are Right/Wrong, so colour them — this is the view
  // Harold scans down looking for a pattern across stores.
  const firstQ = 8;
  sheet.eachRow((row, n) => {
    if (n === 1) return;
    for (let c = firstQ; c < firstQ + data.questions.length; c++) {
      const cell = row.getCell(c);
      if (cell.value === 'Wrong') cell.font = { color: { argb: 'FFB00020' }, bold: true };
      if (cell.value === 'Right') cell.font = { color: { argb: 'FF1CB145' } };
    }
  });

  sheet.columns.forEach((col, i) => {
    col.width = i < 7 ? 16 : (i < 7 + data.questions.length ? 9 : 60);
  });

  // The full question wording goes on its own sheet; as column headings it
  // would make every column too wide to scan.
  // The full question wording, and underneath each one what people actually
  // answered -- the same breakdown the summary tab shows, one row per choice
  // so it can be filtered and pivoted rather than only read.
  const key = book.addWorksheet('Questions');
  key.addRow(['Column', 'Question', 'Points', '% correct', 'Right', 'Walks',
    'Answer', 'Times chosen', 'Correct answer']);
  key.getRow(1).font = { bold: true };

  const statOf = new Map(data.stats.map(s => [s.n, s]));
  for (const q of data.questions) {
    const s = statOf.get(q.n);
    const head = [`Q${q.n}`, q.title, s ? s.points : '', s ? s.percent / 100 : '',
      s ? s.right : '', s ? s.total : ''];
    const choices = (s && s.choices) || [];
    if (!choices.length) { key.addRow(head); continue; }
    choices.forEach((c, i) => {
      // Only the first row of a question repeats the wording; the rest hang
      // under it, which is how you read it and how a pivot groups it.
      const row = key.addRow([...(i ? [`Q${q.n}`, '', '', '', '', ''] : head),
        c.label, c.count, c.correct ? 'Yes' : '']);
      if (c.correct) row.getCell(9).font = { color: { argb: 'FF1CB145' }, bold: true };
    });
  }

  key.getColumn(1).width = 10;
  key.getColumn(2).width = 70;
  key.getColumn(2).alignment = { wrapText: true };
  key.getColumn(4).numFmt = '0%';
  for (const c of [3, 4, 5, 6, 8, 9]) key.getColumn(c).width = 11;
  key.getColumn(7).width = 55;
  key.getColumn(7).alignment = { wrapText: true };

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="audits-${new Date().toISOString().slice(0, 10)}.xlsx"`);
  await book.xlsx.write(res);
  res.end();
});

module.exports = router;
