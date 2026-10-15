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
      created_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
    )
  `);

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
async function recordAnswer(walkId, auditId, n, answer) {
  const p = getPool();
  if (!p || !isUuid(walkId)) return undefined;

  const key = String(Number(n));
  if (key === 'NaN') return undefined;

  const { rows } = await p.query(`
    INSERT INTO audit_walks (walk_id, audit_id, answers)
    VALUES ($1, $2, jsonb_build_object($3::text, $4::jsonb))
    ON CONFLICT (walk_id) DO UPDATE SET
      answers = CASE
        WHEN jsonb_exists(audit_walks.answers, $3::text) THEN audit_walks.answers
        ELSE audit_walks.answers || jsonb_build_object($3::text, $4::jsonb)
      END
    RETURNING answers -> $3::text AS stored
  `, [walkId, String(auditId), key, JSON.stringify(answer ?? null)]);

  return rows[0] ? rows[0].stored : undefined;
}

/** Everything written down for this walk, keyed by question number. */
async function getAnswers(walkId) {
  const p = getPool();
  if (!p || !isUuid(walkId)) return null;

  const { rows } = await p.query('SELECT answers FROM audit_walks WHERE walk_id = $1', [walkId]);
  return rows[0] ? rows[0].answers : null;
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

async function deleteWalk(walkId) {
  const p = getPool();
  if (!p || !isUuid(walkId)) return;
  await p.query('DELETE FROM audit_walks WHERE walk_id = $1', [walkId]);
}

module.exports = { initAuditWalks, recordAnswer, getAnswers, sealed, deleteWalk, isUuid };
