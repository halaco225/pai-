// services/audits.js
//
// Grading an audit walk: stripping the answer key for the browser, checking a
// submission is complete, and scoring it.
//
// Pure — every function takes the question set as an argument — so the grading
// boundaries are testable without a database or a running server. The
// questions themselves live in services/audit-templates.js, because Harold
// edits them in the Audits tab.
//
// The answer key never leaves this file except through grade(). publicForm()
// is what the browser gets before submit; if `correct` or `explanation` ever
// appears there, a shift leader can read the answers out of devtools.

const CHOICE = new Set(['single', 'multi']);          // answered by picking
const SCORED = new Set(['single', 'multi', 'hotspot', 'order']); // answered and worth points

// How much wider than the drawn circle still counts as a hit. A thumb on a
// phone is not a cursor, and the point of the question is whether they spotted
// the problem, not whether they tapped its centre.
const TAP_TOLERANCE = 1.3;

/**
 * Is this question actually being marked?
 *
 * An audit is not always a quiz. A choice question worth nothing with no
 * right answer -- "did the order include a dip?" -- is an observation: it is
 * asked and kept, but there is nothing to get wrong.
 */
function isScored(q) {
  if (!SCORED.has(q.type)) return false;
  if (!(Number(q.points) > 0)) return false;
  if (CHOICE.has(q.type)) return Array.isArray(q.correct) && q.correct.length > 0;
  if (q.type === 'hotspot') return (q.hotspots || []).length > 0;
  if (q.type === 'order') return (q.steps || []).length > 1;
  return true;
}

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
      // A hotspot question gets the picture and how many problems are in it.
      // Where they are is the answer key and stays on the server.
      // A put-in-order question ships the steps, never the order they go in.
      // The order IS the answer, so the list is shuffled on the way out.
      ...(q.type === 'order' ? { steps: shuffle(q.steps || []) } : {}),
      ...(q.type === 'hotspot' ? {
        image: q.image,
        toFind: (q.hotspots || []).length,
        maxTaps: (q.hotspots || []).length + (q.extraTaps || 0),
      } : {}),
    })),
  };
}

/**
 * A stable shuffle of the steps, so the list is not the answer.
 *
 * Seeded off the question text rather than random, so the same walk shows the
 * same order every time it is drawn — a list that reshuffles under them while
 * they are working is unusable.
 */
function shuffle(steps) {
  let seed = 0;
  for (const c of steps.join('|')) seed = (seed * 31 + c.charCodeAt(0)) >>> 0;
  const out = steps.map((text, was) => ({ text, was }));
  for (let i = out.length - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) >>> 0;
    const j = seed % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function asIndexes(value) {
  if (Array.isArray(value)) return value.map(Number).filter(n => Number.isInteger(n));
  if (Number.isInteger(value)) return [value];
  return [];
}

function asTaps(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(t => t && Number.isFinite(Number(t.x)) && Number.isFinite(Number(t.y)))
    .map(t => ({ x: Number(t.x), y: Number(t.y) }));
}

/**
 * Which problems in the picture they found, and which taps hit nothing.
 *
 * Everything is a percentage of the picture's width and height, so it does not
 * matter what size screen it was tapped on. One tap can only claim one
 * problem, and a problem only needs one tap.
 */
function matchTaps(q, rawTaps) {
  const spots = q.hotspots || [];
  // Filtered here as well as at the call sites: this is exported, so it has
  // to cope with whatever it is handed.
  const taps = asTaps(rawTaps);
  const found = new Set();
  const strays = [];

  for (const tap of taps) {
    let hit = -1;
    for (let i = 0; i < spots.length; i++) {
      if (found.has(i)) continue;
      const s = spots[i];
      const dx = (tap.x - s.x) / ((s.rx || 5) * TAP_TOLERANCE);
      const dy = (tap.y - s.y) / ((s.ry || 5) * TAP_TOLERANCE);
      if (dx * dx + dy * dy <= 1) { hit = i; break; }
    }
    if (hit >= 0) found.add(hit); else strays.push(tap);
  }

  const allowed = spots.length + (q.extraTaps || 0);
  return {
    found: [...found].sort((a, b) => a - b),
    strays,
    tapsUsed: taps.length,
    maxTaps: allowed,
    // Everything found, without tapping the whole picture to get there.
    correct: found.size === spots.length && spots.length > 0 && taps.length <= allowed,
  };
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
    if (q.type === 'order') {
      if (asIndexes(given).length < (q.steps || []).length) {
        missing.push({ n: q.n, message: `Question ${q.n} needs every step put in order.` });
      }
      continue;
    }
    if (q.type === 'hotspot') {
      if (asTaps(given).length === 0) {
        missing.push({ n: q.n, message: `Question ${q.n} needs you to tap what is wrong.` });
      }
      continue;
    }
    if (CHOICE.has(q.type)) {
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
    if (!isScored(q)) continue;

    if (q.type === 'order') {
      const steps = q.steps || [];
      const given = asIndexes(answers[q.n]);
      // Right means every step, in the order it was authored in.
      const correct = given.length === steps.length
        && given.every((was, i) => was === i);
      const earned = correct ? (q.points || 0) : 0;
      score += earned;
      results.push({
        n: q.n, title: q.title, type: q.type, points: q.points || 0,
        earned, correct, steps, given,
        rightOrder: steps.map((_, i) => i),
        explanation: q.explanation,
      });
      continue;
    }

    if (q.type === 'order') {
      if (asIndexes(given).length < (q.steps || []).length) {
        missing.push({ n: q.n, message: `Question ${q.n} needs every step put in order.` });
      }
      continue;
    }
    if (q.type === 'hotspot') {
      const taps = asTaps(answers[q.n]);
      const m = matchTaps(q, taps);
      const earned = m.correct ? (q.points || 0) : 0;
      score += earned;
      results.push({
        n: q.n,
        title: q.title,
        type: q.type,
        points: q.points || 0,
        earned,
        correct: m.correct,
        image: q.image,
        taps,
        hotspots: q.hotspots,
        found: m.found,
        tapsUsed: m.tapsUsed,
        maxTaps: m.maxTaps,
        explanation: q.explanation,
      });
      continue;
    }

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

/**
 * Mark one question, for the feedback the walker sees straight away.
 *
 * This is how the answer key reaches the phone: one question at a time, only
 * after that question has been answered, and never as part of the form. The
 * page locks a question once it is marked, so what gets submitted is the
 * answer they gave before they saw the result.
 *
 * Returns null for a question that is not scored, or one that is not there.
 */
function checkOne(def, n, given) {
  const q = def.questions.find(x => x.n === Number(n));
  if (!q || !isScored(q)) return null;

  if (q.type === 'order') {
    const steps = q.steps || [];
    const picked = asIndexes(given);
    if (picked.length === 0) return null;
    return {
      n: q.n,
      correct: picked.length === steps.length && picked.every((was, i) => was === i),
      steps, given: picked, rightOrder: steps.map((_, i) => i),
      explanation: q.explanation,
      points: q.points || 0,
    };
  }

  if (q.type === 'hotspot') {
    const taps = asTaps(given);
    if (taps.length === 0) return null;    // nothing tapped, nothing to reveal
    const m = matchTaps(q, taps);
    return {
      n: q.n,
      correct: m.correct,
      // Now they have had their go, the circles can be drawn on the picture.
      hotspots: q.hotspots,
      found: m.found,
      taps,
      tapsUsed: m.tapsUsed,
      maxTaps: m.maxTaps,
      explanation: q.explanation,
      points: q.points || 0,
    };
  }

  const picked = asIndexes(given);
  if (picked.length === 0) return null;   // nothing answered, nothing to reveal

  return {
    n: q.n,
    correct: sameSet(picked, q.correct || []),
    correctChoices: q.correct,
    explanation: q.explanation,
    points: q.points || 0,
  };
}

module.exports = { publicForm, grade, missingAnswers, maxScore, checkOne, matchTaps, shuffle, isScored };
