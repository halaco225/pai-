// services/audit-templates.js
//
// The audits themselves, as rows rather than a file on disk, so Harold can
// edit them in the Audits tab instead of in the repository.
//
// They live in pai-db, not Supabase: they hold no files, and keeping them here
// means a new audit needs no SQL pasted into a dashboard.
//
// Every save bumps `version`. A response records the version it was taken
// against and freezes its own score, so editing a question never re-scores a
// walk somebody already did.

const fs = require('fs');
const path = require('path');
const { getPool } = require('./db');

const SEED_DIR = path.join(__dirname, '..', 'data', 'audits');

const TYPES = new Set(['text', 'longtext', 'single', 'multi', 'photo']);
const GRADED_TYPES = new Set(['single', 'multi']);

async function initAuditTemplates() {
  const p = getPool();
  if (!p) return;

  await p.query(`
    CREATE TABLE IF NOT EXISTS audit_templates (
      id          VARCHAR(80)  PRIMARY KEY,
      title       TEXT         NOT NULL,
      description TEXT,
      questions   JSONB        NOT NULL DEFAULT '[]'::jsonb,
      version     INT          NOT NULL DEFAULT 1,
      active      BOOLEAN      NOT NULL DEFAULT TRUE,
      updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
      updated_by  VARCHAR(100)
    )
  `);

  await seedFromFiles();
}

// First run only: lift whatever is in data/audits into the table. The files
// stay as the origin of the Steritech walk; the table is what gets served.
async function seedFromFiles() {
  const p = getPool();
  if (!p) return;

  const { rows } = await p.query('SELECT count(*)::int AS n FROM audit_templates');
  if (rows[0].n > 0) return;

  let files = [];
  try {
    files = fs.readdirSync(SEED_DIR).filter(f => f.endsWith('.json'));
  } catch { return; }

  for (const file of files) {
    try {
      const def = JSON.parse(fs.readFileSync(path.join(SEED_DIR, file), 'utf8'));
      await p.query(
        `INSERT INTO audit_templates (id, title, description, questions, updated_by)
         VALUES ($1, $2, $3, $4, 'seed') ON CONFLICT (id) DO NOTHING`,
        [def.id, def.title, def.description || '', JSON.stringify(def.questions || [])]
      );
    } catch (err) {
      console.error('audit template seed failed for', file, err.message);
    }
  }
}

function rowToDef(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    description: row.description || '',
    questions: row.questions || [],
    version: row.version,
    active: row.active,
    updatedAt: row.updated_at,
    updatedBy: row.updated_by,
  };
}

async function listTemplates() {
  const p = getPool();
  if (!p) return [];
  const { rows } = await p.query('SELECT * FROM audit_templates ORDER BY active DESC, title');
  return rows.map(rowToDef);
}

async function getTemplate(id) {
  const p = getPool();
  if (!p || !id) return null;
  const { rows } = await p.query('SELECT * FROM audit_templates WHERE id = $1', [String(id)]);
  return rowToDef(rows[0]);
}

/**
 * Check a template coming from the browser. The editor is behind the login,
 * but a template drives grading for everyone who takes the walk, so it is
 * checked here rather than trusted.
 *
 * Returns a list of plain-English problems; empty means it is good.
 */
function validateTemplate(def) {
  const problems = [];

  if (!def || typeof def !== 'object') return ['There is nothing to save.'];
  if (!/^[a-z0-9-]{1,80}$/.test(String(def.id || ''))) {
    problems.push('The link name can only use lowercase letters, numbers and dashes.');
  }
  if (!String(def.title || '').trim()) problems.push('Give the audit a title.');

  const questions = Array.isArray(def.questions) ? def.questions : null;
  if (!questions) return [...problems, 'The questions are missing.'];
  if (questions.length === 0) problems.push('Add at least one question.');

  questions.forEach((q, i) => {
    const where = `Question ${i + 1}`;
    if (!TYPES.has(q.type)) problems.push(`${where}: pick a question type.`);
    if (!String(q.title || '').trim()) problems.push(`${where}: needs wording.`);

    const points = Number(q.points || 0);
    if (!Number.isInteger(points) || points < 0 || points > 100) {
      problems.push(`${where}: points must be a whole number from 0 to 100.`);
    }

    if (GRADED_TYPES.has(q.type)) {
      const choices = Array.isArray(q.choices) ? q.choices : [];
      if (choices.length < 2) problems.push(`${where}: needs at least two answers to choose from.`);
      if (choices.some(c => !String(c || '').trim())) problems.push(`${where}: one of the answers is blank.`);

      const correct = Array.isArray(q.correct) ? q.correct : [];
      if (correct.length === 0) problems.push(`${where}: mark which answer is right.`);
      if (correct.some(n => !Number.isInteger(n) || n < 0 || n >= choices.length)) {
        problems.push(`${where}: the right answer points at an answer that is not there.`);
      }
      if (q.type === 'single' && correct.length > 1) {
        problems.push(`${where}: a one-answer question can only have one right answer.`);
      }
    } else if (points > 0) {
      problems.push(`${where}: only multiple-choice questions can be worth points.`);
    }

    if (q.type === 'photo') {
      const max = Number(q.maxPhotos || 3);
      if (!Number.isInteger(max) || max < 1 || max > 10) {
        problems.push(`${where}: allow between 1 and 10 pictures.`);
      }
    }
  });

  return problems;
}

/** Normalise what the editor sends into exactly the shape grading expects. */
function cleanTemplate(def) {
  return {
    id: String(def.id || '').trim().toLowerCase(),
    title: String(def.title || '').trim(),
    description: String(def.description || '').trim(),
    questions: (def.questions || []).map((q, i) => {
      const out = {
        n: i + 1,                       // numbering always follows the order on screen
        title: String(q.title || '').trim(),
        type: q.type,
        points: GRADED_TYPES.has(q.type) ? Number(q.points || 0) : 0,
        required: q.required !== false,
      };
      if (GRADED_TYPES.has(q.type)) {
        out.choices = (q.choices || []).map(c => String(c));
        out.correct = [...new Set((q.correct || []).map(Number))].sort((a, b) => a - b);
        out.explanation = String(q.explanation || '').trim();
      }
      if (q.type === 'photo') out.maxPhotos = Number(q.maxPhotos || 3);
      return out;
    }),
  };
}

/** Create or replace a template. Bumps version on every save. */
async function saveTemplate(def, username) {
  const p = getPool();
  if (!p) throw new Error('No database');

  const clean = cleanTemplate(def);
  const { rows } = await p.query(`
    INSERT INTO audit_templates (id, title, description, questions, version, updated_at, updated_by)
    VALUES ($1, $2, $3, $4, 1, NOW(), $5)
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      questions = EXCLUDED.questions,
      version = audit_templates.version + 1,
      updated_at = NOW(),
      updated_by = EXCLUDED.updated_by
    RETURNING *
  `, [clean.id, clean.title, clean.description, JSON.stringify(clean.questions), String(username || '')]);

  return rowToDef(rows[0]);
}

async function setActive(id, active) {
  const p = getPool();
  if (!p) return null;
  const { rows } = await p.query(
    'UPDATE audit_templates SET active = $2, updated_at = NOW() WHERE id = $1 RETURNING *',
    [String(id), Boolean(active)]
  );
  return rowToDef(rows[0]);
}

async function deleteTemplate(id) {
  const p = getPool();
  if (!p) return false;
  const { rowCount } = await p.query('DELETE FROM audit_templates WHERE id = $1', [String(id)]);
  return rowCount > 0;
}

module.exports = {
  initAuditTemplates, listTemplates, getTemplate, saveTemplate,
  setActive, deleteTemplate, validateTemplate, cleanTemplate,
};
