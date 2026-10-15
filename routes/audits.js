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
const ExcelJS = require('exceljs');

const router = express.Router();

const rcDb = require('../services/rc-db');
const db   = require('../services/db');
const templates = require('../services/audit-templates');
const { requireAuth, requireRole } = require('../middleware/auth');
const { visibleStores } = require('../services/rc-scope');
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
router.post('/check', async (req, res) => {
  const def = await templates.getTemplate(req.body.auditId || DEFAULT_AUDIT);
  if (!def || !def.active) return res.status(404).json({ error: 'That walk does not exist.' });

  const result = checkOne(def, req.body.n, req.body.answer);
  if (!result) return res.status(400).json({ error: 'Nothing to mark.' });
  res.json(result);
});

// ── Public: submit a walk ───────────────────────────────────────────────────
//
// Photos arrive as files named photo_<question number>. Everything else comes
// as one JSON field so the shapes survive multipart intact.
router.post('/submit', upload.any(), async (req, res) => {
  const def = await templates.getTemplate(req.body.auditId || DEFAULT_AUDIT);
  if (!def || !def.active) return res.status(404).json({ error: 'That walk does not exist.' });

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
    graded,                       // frozen, so a later edit cannot re-score this walk
    template_version: def.version,
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

function applyFilters(rows, query) {
  const { store, coach, from, to } = query;
  let out = rows;
  if (store) out = out.filter(r => r.store_number === String(store));
  if (coach) out = out.filter(r => r.area_coach === coach);
  if (from)  out = out.filter(r => r.created_at >= from);
  if (to)    out = out.filter(r => r.created_at <= `${to}T23:59:59Z`);
  return out;
}

// ── Templates ───────────────────────────────────────────────────────────────
//
// Reading the list is open to anyone signed in; changing one is not. An audit
// is what every store in the region gets asked, so it belongs to the RDO and
// VP rather than to whoever opens the page.
router.get('/templates', async (req, res) => {
  const list = await templates.listTemplates();
  res.json(list.map(t => ({
    id: t.id, title: t.title, description: t.description,
    questions: t.questions.length,
    points: t.questions.reduce((s, q) => s + (q.points || 0), 0),
    version: t.version, active: t.active,
    updatedAt: t.updatedAt, updatedBy: t.updatedBy,
  })));
});

router.get('/templates/:id', async (req, res) => {
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
    coaches: [...new Set(rows.map(r => r.area_coach).filter(Boolean))].sort(),
    stores: [...new Set(rows.map(r => r.store_number))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true })),
  });
});

// ── One response, with the score it got on the day ──────────────────────────
router.get('/responses/:id', async (req, res) => {
  const scoped = await scopedRows(req, res); if (!scoped) return;
  const row = scoped.rows.find(r => r.id === req.params.id);
  // Out of scope and not there look the same from outside, on purpose.
  if (!row) return res.status(404).json({ error: 'Not found' });

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
//
// Built from each response's frozen score, so a walk taken before a question
// was reworded still reports what that person actually answered.
async function summarise(req, res) {
  const scoped = await scopedRows(req, res); if (!scoped) return null;
  const assignments = await db.getStoreAssignments();

  const keep = new Set(applyFilters(withStoreInfo(scoped.rows, assignments), req.query).map(r => r.id));
  const rows = scoped.rows.filter(r => keep.has(r.id));

  const byQuestion = {};
  for (const row of rows) {
    const graded = await frozenGrade(row);
    for (const r of graded.results) {
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

  return {
    rows, assignments,
    summary: {
      responses: rows.length,
      averageScore: rows.length ? +(rows.reduce((s, r) => s + r.score, 0) / rows.length).toFixed(1) : 0,
      maxScore: rows.length ? rows[0].max_score : 0,
      questions: Object.values(byQuestion)
        .map(q => ({ ...q, percent: q.total ? Math.round((q.right / q.total) * 100) : 0 }))
        .sort((a, b) => a.percent - b.percent),
      stores: Object.values(byStore)
        .map(s => ({ ...s, averageScore: +(s.totalScore / s.responses).toFixed(1) }))
        .sort((a, b) => a.averageScore - b.averageScore),
    },
  };
}

router.get('/summary', async (req, res) => {
  const result = await summarise(req, res);
  if (result) res.json(result.summary);
});

// ── Exports: one row per response ───────────────────────────────────────────
async function exportRows(req, res) {
  const result = await summarise(req, res);
  if (!result) return null;

  const { rows, assignments } = result;
  const graded = [];
  for (const row of rows) graded.push(await frozenGrade(row));

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

  return { header, body, questions };
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
  const key = book.addWorksheet('Questions');
  key.addRow(['Column', 'Question']);
  key.getRow(1).font = { bold: true };
  for (const q of data.questions) key.addRow([`Q${q.n}`, q.title]);
  key.getColumn(1).width = 10;
  key.getColumn(2).width = 110;
  key.getColumn(2).alignment = { wrapText: true };

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="audits-${new Date().toISOString().slice(0, 10)}.xlsx"`);
  await book.xlsx.write(res);
  res.end();
});

module.exports = router;
