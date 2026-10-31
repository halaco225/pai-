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

// Who can be a guide. The editor offers these and this list is what a save
// is allowed to keep — adding one in the browser and forgetting it here is
// why picking Pepper looked like it saved and came back as Adam.
const COACHES = ['adam', 'krystina', 'pepper', 'none'];

const TYPES = new Set(['text', 'longtext', 'single', 'multi', 'photo', 'hotspot', 'order', 'scale',
                       'number', 'datetime', 'assign']);
const CHOICE_TYPES = new Set(['single', 'multi']);
const GRADED_TYPES = new Set(['single', 'multi', 'hotspot', 'order', 'assign']);

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

  // Who made it, so the list can be cut down to what each person should see.
  // Rows from before this existed have no owner and stay visible to everyone
  // who could already see them.
  await p.query(`ALTER TABLE audit_templates ADD COLUMN IF NOT EXISTS created_by VARCHAR(100)`);

  // Whether it is a test or an audit, and who walks them through it. Both
  // were worked out from the questions before they could be chosen; rows
  // from then have them null and still fall back to that.
  await p.query(`ALTER TABLE audit_templates ADD COLUMN IF NOT EXISTS kind  VARCHAR(10)`);
  await p.query(`ALTER TABLE audit_templates ADD COLUMN IF NOT EXISTS coach VARCHAR(20)`);

  // Which seed files have been lifted already. Counting templates instead
  // meant the first deploy took everything and every later one took nothing,
  // so a new file in data/audits never reached the live site.
  await p.query(`
    CREATE TABLE IF NOT EXISTS audit_template_seeds (
      file      VARCHAR(200) PRIMARY KEY,
      seeded_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);

  await seedFromFiles();
}

// Lift each file in data/audits into the table once, ever. The files stay the
// origin of a walk; the table is what gets served and what the editor writes.
//
// Recording the file, rather than counting rows, is what lets a new test ship
// by deploy. Recording it even when the insert conflicts is what stops one
// Harold deleted in the Audits tab from coming back on the next restart.
//
// shortcut: a template deleted before this ledger existed reappears once, on
// the deploy that creates it. Delete it again and it stays gone.
async function seedFromFiles() {
  const p = getPool();
  if (!p) return;

  let files = [];
  try {
    files = fs.readdirSync(SEED_DIR).filter(f => f.endsWith('.json'));
  } catch { return; }

  const { rows: seeded } = await p.query('SELECT file FROM audit_template_seeds');
  const already = new Set(seeded.map(r => r.file));

  for (const file of files) {
    if (already.has(file)) continue;
    try {
      const def = JSON.parse(fs.readFileSync(path.join(SEED_DIR, file), 'utf8'));
      await p.query(
        `INSERT INTO audit_templates (id, title, description, questions, updated_by)
         VALUES ($1, $2, $3, $4, 'seed') ON CONFLICT (id) DO NOTHING`,
        [def.id, def.title, def.description || '', JSON.stringify(def.questions || [])]
      );
      await p.query(
        'INSERT INTO audit_template_seeds (file) VALUES ($1) ON CONFLICT DO NOTHING', [file]
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
    createdBy: row.created_by,
    kind: row.kind
      || (row.questions && row.questions.some(q => Number(q.points) > 0) ? 'test' : 'audit'),
    coach: row.coach || null,
  };
}

async function listTemplates() {
  const p = getPool();
  if (!p) return [];
  const { rows } = await p.query('SELECT * FROM audit_templates ORDER BY active DESC, title');
  return rows.map(rowToDef);
}

async function getTemplate(id) {
  if (!id) return null;
  const p = getPool();
  if (!p) return seedDef(id);          // no database configured: serve the file
  const { rows } = await p.query('SELECT * FROM audit_templates WHERE id = $1', [String(id)]);
  return rowToDef(rows[0]);
}

/**
 * The walk as it ships in data/audits.
 *
 * Only used when there is no database at all — on a developer's machine, or
 * if pai-db is unreachable at startup. A shift leader standing in a kitchen
 * should get the questions either way; what they lose is any edit made since,
 * which is better than a page that says come back later.
 */
function seedDef(id) {
  if (!/^[a-z0-9-]{1,80}$/.test(String(id))) return null;
  const file = path.join(SEED_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    const def = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...def, version: 0, active: true, updatedBy: 'file' };
  } catch {
    return null;
  }
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

    if (q.type === 'order') {
      const steps = Array.isArray(q.steps) ? q.steps : [];
      if (steps.length < 2) problems.push(`${where}: needs at least two steps to put in order.`);
      if (steps.some(x => !String(x || '').trim())) problems.push(`${where}: one of the steps is blank.`);
      return;
    }

    if (q.type === 'hotspot') {
      if (!String(q.image || '').trim()) problems.push(`${where}: needs a picture.`);
      const spots = Array.isArray(q.hotspots) ? q.hotspots : [];
      if (spots.length === 0) problems.push(`${where}: needs at least one thing to find in the picture.`);
      if (spots.some(h => !h || !Number.isFinite(Number(h.x)) || !Number.isFinite(Number(h.y)))) {
        problems.push(`${where}: one of the things to find has no place in the picture.`);
      }
      if (spots.some(h => !String((h && h.label) || '').trim())) {
        problems.push(`${where}: one of the things to find has no name.`);
      }
      return;                       // inside forEach, so return is the skip
    }

    // A slider records a judgement on a scale. It is never scored: there is no
    // right number, which is the point of asking for one.
    if (q.type === 'scale') {
      const lo = Number(q.min), hi = Number(q.max), step = Number(q.step || 1);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) {
        problems.push(`${where}: the slider needs a low number and a higher one.`);
      } else if (!(step > 0) || (hi - lo) / step > 100) {
        problems.push(`${where}: that step leaves too many stops on the slider.`);
      }
    }

    if (q.type === 'number') {
      const lo = q.min === '' || q.min == null ? null : Number(q.min);
      const hi = q.max === '' || q.max == null ? null : Number(q.max);
      if (lo != null && hi != null && hi < lo) {
        problems.push(`${where}: the highest number is below the lowest.`);
      }
    }

    if (q.type === 'assign') {
      const layout = q.layout || 'buckets';
      const targets = Array.isArray(q.targets) ? q.targets : [];
      const items = Array.isArray(q.items) ? q.items : [];
      if (targets.length < 2) problems.push(`${where}: needs at least two places to put things.`);
      if (items.length < 2) problems.push(`${where}: needs at least two things to put.`);
      if (layout === 'picture') {
        if (!String(q.image || '').trim()) problems.push(`${where}: needs a picture.`);
        if (targets.some(t => !Number.isFinite(Number(t && t.x)) || !Number.isFinite(Number(t && t.y)))) {
          problems.push(`${where}: one of the places is not on the picture.`);
        }
      }
      if (targets.some(t => !String((t && t.label) || '').trim())) {
        problems.push(`${where}: one of the places has no name.`);
      }
      if (items.some(it => !String((it && it.text) || '').trim())) {
        problems.push(`${where}: one of the things to put has no wording.`);
      }
      if (items.some(it => !(Number(it && it.target) >= 0) || Number(it.target) >= targets.length)) {
        problems.push(`${where}: say where each one belongs.`);
      }
    }

    if (CHOICE_TYPES.has(q.type)) {
      const choices = Array.isArray(q.choices) ? q.choices : [];
      if (choices.length < 2) problems.push(`${where}: needs at least two answers to choose from.`);
      if (choices.some(c => !String(c || '').trim())) problems.push(`${where}: one of the answers is blank.`);

      const correct = Array.isArray(q.correct) ? q.correct : [];
      // Only a question worth points needs a right answer. One worth nothing
      // is recording what was seen, and there is nothing to mark.
      if (points > 0 && correct.length === 0) {
        problems.push(`${where}: mark which answer is right, or set it to 0 points.`);
      }
      if (correct.some(n => !Number.isInteger(n) || n < 0 || n >= choices.length)) {
        problems.push(`${where}: the right answer points at an answer that is not there.`);
      }
      // A one-answer question may have more than one acceptable answer. They
      // still pick one; any of the marked ones earns the points. "Temp them
      // first" and "throw them out and drop fresh" are both right, and
      // forcing a single key would mark half the people who know that wrong.
    } else if (points > 0) {
      problems.push(`${where}: only scored questions can be worth points.`);
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
    // A test is marked and tells them how they did; an audit records what was
    // there. Older templates carry no kind, so having points still decides it.
    kind: def.kind === 'audit' ? 'audit' : def.kind === 'test' ? 'test' : undefined,
    // Who walks them through it. Left out means Adam on a test and nobody on
    // an audit, which is how it behaved before there was a choice.
    coach: COACHES.includes(def.coach) ? def.coach : undefined,
    questions: (def.questions || []).map((q, i) => {
      const out = {
        n: i + 1,                       // numbering always follows the order on screen
        title: String(q.title || '').trim(),
        type: q.type,
        points: GRADED_TYPES.has(q.type) ? Number(q.points || 0) : 0,
        required: q.required !== false,
      };
      // What to look for, shown with the question while it is still open. Not
      // an answer, so it reaches the phone with the rest of the wording.
      const help = String(q.help || '').trim();
      if (help) out.help = help;

      // A clip to watch before answering. Any question type can have one:
      // "what did she miss" is an ordinary pick-all with a video above it,
      // which is why this is a field rather than a type of its own.
      const video = String(q.video || '').trim();
      if (video) out.video = video;

      // A picture to look at before answering. Any question type can have one,
      // for the same reason as the clip above. hotspot and picture-assign set
      // this themselves further down, where the picture IS the answer surface.
      const image = String(q.image || '').trim();
      if (image) out.image = image;

      if (q.type === 'number') {
        if (q.min !== '' && q.min != null) out.min = Number(q.min);
        if (q.max !== '' && q.max != null) out.max = Number(q.max);
        out.unit = String(q.unit || '').trim();
      }

      if (q.type === 'assign') {
        out.layout = ['buckets', 'match', 'picture'].includes(q.layout) ? q.layout : 'buckets';
        if (out.layout === 'picture') out.image = String(q.image || '');
        out.targets = (q.targets || []).map(t => ({
          label: String((t && t.label) || ''),
          ...(out.layout === 'picture' ? { x: Number(t.x), y: Number(t.y) } : {}),
        }));
        out.items = (q.items || []).map(it => ({
          text: String((it && it.text) || ''), target: Number(it && it.target),
        }));
        out.explanation = String(q.explanation || '').trim();
      }

      if (q.type === 'scale') {
        out.min = Number(q.min ?? 1);
        out.max = Number(q.max ?? 10);
        out.step = Number(q.step || 1);
        out.minLabel = String(q.minLabel || '').trim();
        out.maxLabel = String(q.maxLabel || '').trim();
      }
      if (CHOICE_TYPES.has(q.type)) {
        out.choices = (q.choices || []).map(c => String(c));
        out.correct = [...new Set((q.correct || []).map(Number))].sort((a, b) => a - b);
        out.explanation = String(q.explanation || '').trim();
      }
      if (q.type === 'photo') {
        out.maxPhotos = Number(q.maxPhotos || 3);
        // Let them draw on what they photographed — circle the thing they
        // mean, rather than describing where it is in a text box.
        if (q.annotate) out.annotate = true;
      }
      // The steps are stored in the order they belong in; that order is the
      // answer, and the page shuffles a copy for the walker.
      if (q.type === 'order') {
        out.steps = (q.steps || []).map(x => String(x));
        out.explanation = String(q.explanation || '').trim();
      }
      // The editor cannot draw hotspots yet, so it carries them through
      // exactly as they are. Dropping them here would empty the question the
      // next time anything else on the form was saved.
      if (q.type === 'hotspot') {
        out.image = String(q.image || '');
        // Spot-what-changed: the same question with a "before" shown beside
        // it. What is wrong is still marked on the "now" picture only.
        if (q.beforeImage) out.beforeImage = String(q.beforeImage);
        out.extraTaps = Number(q.extraTaps || 0);
        out.explanation = String(q.explanation || '').trim();
        // Things they can go and read before they answer: temp the pepperoni,
        // check the gauge. The reading is not the answer, it is what the
        // answer is worked out from — so it goes out with the form, unlike
        // the hotspots, which are the answer key.
        if (Array.isArray(q.probes) && q.probes.length) {
          out.probes = q.probes
            .filter(p => p && String(p.label || '').trim())
            .map(p => ({
              label: String(p.label).trim().slice(0, 80),
              value: String(p.value == null ? '' : p.value).trim().slice(0, 40),
            }));
        }
        out.hotspots = (q.hotspots || []).map(h => ({
          x: Number(h.x), y: Number(h.y),
          rx: Number(h.rx || 5), ry: Number(h.ry || 5),
          label: String(h.label || ''), why: String(h.why || ''),
        }));
      }
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
    INSERT INTO audit_templates
      (id, title, description, questions, version, updated_at, updated_by, created_by, kind, coach)
    VALUES ($1, $2, $3, $4, 1, NOW(), $5, $5, $6, $7)
    ON CONFLICT (id) DO UPDATE SET
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      questions = EXCLUDED.questions,
      version = audit_templates.version + 1,
      updated_at = NOW(),
      updated_by = EXCLUDED.updated_by,
      kind = EXCLUDED.kind,
      coach = EXCLUDED.coach
    RETURNING *
  `, [clean.id, clean.title, clean.description, JSON.stringify(clean.questions),
      String(username || ''), clean.kind || null, clean.coach || null]);

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
