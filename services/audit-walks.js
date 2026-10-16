// services/audit-walks.js
//
// A walk in progress, recorded as it happens.
//
// Marking a question tells the phone the right answer, so the phone cannot be
// the one holding the score. Each answer is written down here the first time
// it is given and never changed after that; submit grades what is written
// here, not what the phone sends at the end. Seeing the verdict and then
// changing your pick does nothing.
//
// Not a login, and not pretending to be one: clearing the browser and
// starting again gets a new walk. What this stops is the easy version —
// answer, read the verdict, go back and fix it.

const { getPool } = require('./db');

async function initAuditWalks() {
  const p = getPool();
  if (!p) return;

  await p.query(`
    CREATE TABLE IF NOT EXISTS audit_walks (
      walk_id    UUID         PRIMARY KEY,
      audit_id   VARCHAR(80)  NOT NULL,
      answers    JSONB        NOT NULL DEFAULT '{}'::jsonb,
      version    INT          NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);

  await p.query(`ALTER TABLE audit_walks ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 0`);

  await p.query(`
    CREATE INDEX IF NOT EXISTS idx_audit_walks_created
    ON audit_walks (created_at DESC)
  `);
}

const isUuid = s => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(s || ''));

/**
 * Write down an answer, first one wins.
 *
 * Returns the answer now on record for that question — which is the earlier
 * one if this question has already been answered. The caller marks THAT,
 * so a second attempt is told about the first attempt's answer.
 *
 * Returns undefined when there is no database, and the caller falls back to
 * marking whatever was sent.
 */
async function recordAnswer(walkId, auditId, version, n, answer) {
  const p = getPool();
  if (!p || !isUuid(walkId)) return undefined;

  const key = String(Number(n));
  if (key === 'NaN') return undefined;

  // A walk started before the questions were edited is not the same walk any
  // more: question 15 might have been a multiple choice an hour ago and a
  // picture now, and the answer written down then means nothing against the
  // question being asked now. A new version starts the record clean.
  const { rows } = await p.query(`
    INSERT INTO audit_walks (walk_id, audit_id, answers, version)
    VALUES ($1, $2, jsonb_build_object($3::text, $4::jsonb), $5)
    ON CONFLICT (walk_id) DO UPDATE SET
      version = $5,
      answers = CASE
        WHEN audit_walks.version <> $5 THEN jsonb_build_object($3::text, $4::jsonb)
        WHEN jsonb_exists(audit_walks.answers, $3::text) THEN audit_walks.answers
        ELSE audit_walks.answers || jsonb_build_object($3::text, $4::jsonb)
      END
    RETURNING answers -> $3::text AS stored
  `, [walkId, String(auditId), key, JSON.stringify(answer ?? null), Number(version) || 0]);

  return rows[0] ? rows[0].stored : undefined;
}

/** Everything written down for this walk, keyed by question number. */
async function getAnswers(walkId, version) {
  const p = getPool();
  if (!p || !isUuid(walkId)) return null;

  const { rows } = await p.query('SELECT answers, version FROM audit_walks WHERE walk_id = $1', [walkId]);
  if (!rows[0]) return null;
  // Written against a different set of questions: not this walk's answers.
  if (version != null && rows[0].version !== Number(version)) return null;
  return rows[0].answers;
}

/**
 * The answers to submit: whatever the walk recorded for scored questions,
 * and the phone's own for everything else (names, store, pictures, the
 * write-up at the end — none of which are scored, and none of which the
 * walk records).
 */
function sealed(recorded, sent, def) {
  if (!recorded) return sent;

  const out = { ...sent };
  for (const q of def.questions) {
    if (q.type !== 'single' && q.type !== 'multi') continue;
    // A question answered without the walk being recorded keeps what was
    // sent; one that was recorded can only be what was recorded.
    if (Object.prototype.hasOwnProperty.call(recorded, String(q.n))) {
      out[q.n] = recorded[String(q.n)];
    }
  }
  return out;
}

/**
 * Could this recorded answer still be an answer to this question?
 *
 * The version check should already have cleared anything stale, but a stored
 * answer of the wrong shape would otherwise be marked as if it were real —
 * which is how a picture question came to be handed a multiple-choice answer
 * and told the walker there was no signal.
 */
function fits(q, answer) {
  if (answer == null) return false;
  if (q.type === 'hotspot') {
    return Array.isArray(answer) && answer.length > 0
      && answer.every(t => t && typeof t === 'object' && !Array.isArray(t)
        && Number.isFinite(Number(t.x)) && Number.isFinite(Number(t.y)));
  }
  // Put-it-where-it-goes: a slot per item, each holding a target or nothing.
  if (q.type === 'assign') {
    return Array.isArray(answer)
      && answer.some(v => v != null)
      && answer.every(v => v == null || Number.isInteger(Number(v)));
  }
  if (q.type === 'single' || q.type === 'multi') {
    return Array.isArray(answer) && answer.length > 0 && answer.every(n => Number.isInteger(n));
  }
  return true;
}

async function deleteWalk(walkId) {
  const p = getPool();
  if (!p || !isUuid(walkId)) return;
  await p.query('DELETE FROM audit_walks WHERE walk_id = $1', [walkId]);
}

module.exports = { initAuditWalks, recordAnswer, getAnswers, sealed, deleteWalk, isUuid, fits };
