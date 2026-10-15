// services/audits.js
//
// The Steritech readiness walk: loading the question set, stripping the answer
// key for the browser, checking a submission is complete, and grading it.
//
// Pure — no I/O beyond reading the JSON once — so the grading boundaries are
// testable without a database or a running server.
//
// The answer key never leaves this file except through grade(). publicForm()
// is what the browser gets before submit; if `correct` or `explanation` ever
// appears there, a shift leader can read the answers out of devtools.

const fs = require('fs');
const path = require('path');

const AUDIT_DIR = path.join(__dirname, '..', 'data', 'audits');

const cache = new Map();

function loadAudit(id) {
  // Reject anything that could climb out of data/audits.
  if (!/^[a-z0-9-]+$/.test(id)) return null;
  if (cache.has(id)) return cache.get(id);

  const file = path.join(AUDIT_DIR, `${id}.json`);
  if (!fs.existsSync(file)) return null;

  const def = JSON.parse(fs.readFileSync(file, 'utf8'));
  cache.set(id, def);
  return def;
}

const GRADED = new Set(['single', 'multi']);

function maxScore(def) {
  return def.questions.reduce((sum, q) => sum + (q.points || 0), 0);
}

/** The question set as the browser may see it — no answer key. */
function publicForm(def) {
  return {
    id: def.id,
    title: def.title,
    description: def.description,
    totalPoints: maxScore(def),
    questions: def.questions.map(q => ({
      n: q.n,
      title: q.title,
      type: q.type,
      points: q.points || 0,
      required: q.required !== false,
      ...(q.choices ? { choices: q.choices } : {}),
      ...(q.maxPhotos ? { maxPhotos: q.maxPhotos } : {}),
    })),
  };
}

function asIndexes(value) {
  if (Array.isArray(value)) return value.map(Number).filter(n => Number.isInteger(n));
  if (Number.isInteger(value)) return [value];
  return [];
}

function sameSet(a, b) {
  const x = [...new Set(a)].sort((m, n) => m - n);
  const y = [...new Set(b)].sort((m, n) => m - n);
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * What is missing, in words a shift leader can act on.
 * answers: { [n]: string | number[] }, photos: { [n]: string[] }
 */
function missingAnswers(def, answers = {}, photos = {}) {
  const missing = [];
  for (const q of def.questions) {
    if (q.required === false) continue;

    if (q.type === 'photo') {
      if (!Array.isArray(photos[q.n]) || photos[q.n].length === 0) {
        missing.push({ n: q.n, message: `Question ${q.n} needs at least one picture.` });
      }
      continue;
    }
    const given = answers[q.n];
    if (GRADED.has(q.type)) {
      if (asIndexes(given).length === 0) {
        missing.push({ n: q.n, message: `Question ${q.n} needs an answer.` });
      }
      continue;
    }
    if (typeof given !== 'string' || given.trim() === '') {
      missing.push({ n: q.n, message: `Question ${q.n} needs an answer.` });
    }
  }
  return missing;
}

/**
 * Grade a submission. Single and multi are all-or-nothing: a multi-select is
 * only right when the picked set is exactly the correct set, the same way the
 * Microsoft Forms quiz this replaces scored it. A partial pick earns 0.
 */
function grade(def, answers = {}) {
  let score = 0;
  const results = [];

  for (const q of def.questions) {
    if (!GRADED.has(q.type)) continue;

    const given = asIndexes(answers[q.n]);
    const correct = sameSet(given, q.correct || []);
    const earned = correct ? (q.points || 0) : 0;
    score += earned;

    results.push({
      n: q.n,
      title: q.title,
      type: q.type,
      points: q.points || 0,
      earned,
      correct,
      choices: q.choices,
      given,
      correctChoices: q.correct,
      explanation: q.explanation,
    });
  }

  return { score, maxScore: maxScore(def), results };
}

module.exports = { loadAudit, publicForm, grade, missingAnswers, maxScore };
