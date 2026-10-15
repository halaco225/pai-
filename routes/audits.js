// routes/audits.js
//
// The Steritech readiness walk, in two halves with different doors:
//
//   PUBLIC  — /api/audits/form, /stores and /submit. No login, because shift
//             leaders have no P.AI account; Harold texts them the link. These
//             are the only endpoints without requireAuth in this file.
//
//   SCOPED  — everything under /responses, /summary, /photo and /export.csv
//             sits behind P.AI's login and is filtered to the viewer's stores,
//             in the query, so out-of-scope responses never reach the browser.
//
// Grading happens here, never in the browser: services/audits.js holds the
// answer key and publicForm() is what goes out before submit.

const express = require('express');
const multer  = require('multer');
const crypto  = require('crypto');

const router = express.Router();

const rcDb = require('../services/rc-db');
const db   = require('../services/db');
const { requireAuth } = require('../middleware/auth');
const { visibleStores } = require('../services/rc-scope');
const { loadAudit, publicForm, grade, missingAnswers } = require('../services/audits');

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

// ── Public: the question set, with no answer key ────────────────────────────
router.get('/form', (req, res) => {
  const def = loadAudit(req.query.id || DEFAULT_AUDIT);
  if (!def) return res.status(404).json({ error: 'That walk does not exist.' });
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

// ── Public: submit a walk ───────────────────────────────────────────────────
//
// Photos arrive as files named photo_<question number>. Everything else comes
// as one JSON field so the shapes survive multipart intact.
router.post('/submit', upload.any(), async (req, res) => {
  const def = loadAudit(req.body.auditId || DEFAULT_AUDIT);
  if (!def) return res.status(404).json({ error: 'That walk does not exist.' });

  let answers;
  try {
    answers = JSON.parse(req.body.answers || '{}');
  } catch {
    return res.status(400).json({ error: 'Your answers did not come through. Try submitting again.' });
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

  const name  = String(answers[1] || '').trim();
  const store = String(answers[2] || '').trim();
  const fixes = String(answers[20] || '').trim();

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

  const { data, error } = await c.from('audit_responses').insert({
    audit_id: def.id,
    respondent_name: name,
    store_number: store,
    answers,
    photos,
    score: graded.score,
    max_score: graded.maxScore,
    fixes,
    user_agent: String(req.get('user-agent') || '').slice(0, 300),
  }).select('id').single();

  if (error) {
    return res.status(502).json({ error: 'That did not save. Your answers are still here — hit submit again.' });
  }

  // Only now does the answer key go out, for the results screen.
  res.json({ id: data.id, score: graded.score, maxScore: graded.maxScore, results: graded.results });
});

// ───────────────────────────── everything below needs a login ───────────────
router.use(requireAuth);

async function scopedRows(req, res) {
  const stores = visibleStores(req.session.user, await db.getStoreAssignments());
  if (stores.size === 0) return { rows: [], stores };

  const c = serviceClient(res); if (!c) return null;
  const { data, error } = await c.from('audit_responses')
    .select('*')
    .eq('audit_id', req.query.auditId || DEFAULT_AUDIT)
    .in('store_number', [...stores])
    .order('created_at', { ascending: false });

  if (error) { res.status(500).json({ error: error.message }); return null; }
  return { rows: data || [], stores };
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
      score: r.score,
      max_score: r.max_score,
    };
  });
}

// ── The responses list ──────────────────────────────────────────────────────
router.get('/responses', async (req, res) => {
  const scoped = await scopedRows(req, res); if (!scoped) return;
  const assignments = await db.getStoreAssignments();

  let rows = withStoreInfo(scoped.rows, assignments);
  const { store, coach, from, to } = req.query;
  if (store) rows = rows.filter(r => r.store_number === String(store));
  if (coach) rows = rows.filter(r => r.area_coach === coach);
  if (from)  rows = rows.filter(r => r.created_at >= from);
  if (to)    rows = rows.filter(r => r.created_at <= `${to}T23:59:59Z`);

  res.json({
    responses: rows,
    coaches: [...new Set(rows.map(r => r.area_coach).filter(Boolean))].sort(),
    stores: [...new Set(rows.map(r => r.store_number))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
  });
});

// ── One response, graded, with its photos ───────────────────────────────────
router.get('/responses/:id', async (req, res) => {
  const scoped = await scopedRows(req, res); if (!scoped) return;
  const row = scoped.rows.find(r => r.id === req.params.id);
  // Out of scope and not there look the same from outside, on purpose.
  if (!row) return res.status(404).json({ error: 'Not found' });

  const def = loadAudit(row.audit_id);
  const assignments = await db.getStoreAssignments();
  const store = assignments[row.store_number] || {};

  res.json({
    id: row.id,
    created_at: row.created_at,
    name: row.respondent_name,
    store_number: row.store_number,
    store_name: store.store_name || '',
    area_coach: store.area_coach || '',
    fixes: row.fixes,
    photoQuestions: def.questions.filter(q => q.type === 'photo')
      .map(q => ({ n: q.n, title: q.title, paths: row.photos[q.n] || [] })),
    ...grade(def, row.answers),
  });
});

// ── A photo, through a short-lived signed URL ───────────────────────────────
router.get('/photo', async (req, res) => {
  const path = String(req.query.path || '');
  const scoped = await scopedRows(req, res); if (!scoped) return;

  // Only paths that appear on a response this viewer can already see.
  const allowed = scoped.rows.some(r =>
    Object.values(r.photos || {}).some(list => (list || []).includes(path)));
  if (!allowed) return res.status(404).json({ error: 'Not found' });

  const c = serviceClient(res); if (!c) return;
  const { data, error } = await c.storage.from(BUCKET).createSignedUrl(path, PHOTO_TTL);
  if (error) return res.status(502).json({ error: error.message });
  res.redirect(data.signedUrl);
});

// ── Which questions the region keeps missing ────────────────────────────────
router.get('/summary', async (req, res) => {
  const scoped = await scopedRows(req, res); if (!scoped) return;
  const def = loadAudit(req.query.auditId || DEFAULT_AUDIT);
  const assignments = await db.getStoreAssignments();
  const rows = scoped.rows;

  const graded = rows.map(r => grade(def, r.answers));
  const byQuestion = {};
  for (const g of graded) {
    for (const r of g.results) {
      const q = byQuestion[r.n] = byQuestion[r.n] || { n: r.n, title: r.title, points: r.points, right: 0, total: 0 };
      q.total += 1;
      if (r.correct) q.right += 1;
    }
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

  res.json({
    responses: rows.length,
    averageScore: rows.length ? +(rows.reduce((s, r) => s + r.score, 0) / rows.length).toFixed(1) : 0,
    maxScore: rows.length ? rows[0].max_score : 20,
    questions: Object.values(byQuestion)
      .map(q => ({ ...q, percent: q.total ? Math.round((q.right / q.total) * 100) : 0 }))
      .sort((a, b) => a.percent - b.percent),
    stores: Object.values(byStore)
      .map(s => ({ ...s, averageScore: +(s.totalScore / s.responses).toFixed(1) }))
      .sort((a, b) => a.averageScore - b.averageScore),
  });
});

// ── One row per response, for a spreadsheet ─────────────────────────────────
router.get('/export.csv', async (req, res) => {
  const scoped = await scopedRows(req, res); if (!scoped) return;
  const def = loadAudit(req.query.auditId || DEFAULT_AUDIT);
  const assignments = await db.getStoreAssignments();
  const gradedQuestions = def.questions.filter(q => q.type === 'single' || q.type === 'multi');

  const cell = v => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
  const header = ['Date', 'Store', 'Store name', 'Area Coach', 'Name', 'Score', 'Out of',
    ...gradedQuestions.map(q => `Q${q.n}`), 'Top 3 fixes'];

  const lines = [header.map(cell).join(',')];
  for (const r of scoped.rows) {
    const s = assignments[r.store_number] || {};
    const results = grade(def, r.answers).results;
    lines.push([
      r.created_at, r.store_number, s.store_name || '', s.area_coach || '',
      r.respondent_name, r.score, r.max_score,
      ...gradedQuestions.map(q => {
        const hit = results.find(x => x.n === q.n);
        return hit && hit.correct ? 'Right' : 'Wrong';
      }),
      r.fixes || '',
    ].map(cell).join(','));
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="audits-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(lines.join('\n'));
});

module.exports = router;
