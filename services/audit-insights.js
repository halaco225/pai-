// services/audit-insights.js
//
// What the walks are telling you, beyond the scores.
//
// A percentage says a question is being missed. It does not say what people
// think the answer is, which store keeps missing the same thing, or whether
// any of it is getting better. That is the difference between a report and a
// number, and it is all this file does.
//
// Pure: everything takes rows and graded results and returns plain objects,
// so none of it needs a database to test.

/** How many responses before a percentage is worth printing at all. */
const ENOUGH = 3;

/**
 * Per question: how often it is right, what people pick instead, and which
 * right answer they most often leave out.
 *
 * "What people pick instead" is the useful half. A question at 40% tells you
 * to go and teach something; the wrong answer three quarters of them chose
 * tells you what to teach.
 */
function byQuestion(graded) {
  const map = new Map();

  for (const g of graded) {
    for (const r of g.results) {
      let q = map.get(r.n);
      if (!q) {
        q = {
          n: r.n, title: r.title, type: r.type, points: r.points,
          right: 0, total: 0,
          wrongPicks: new Map(),     // a choice chosen that is not correct
          missedRight: new Map(),    // a correct choice left out
          missedSpots: new Map(),    // for a picture question
          labels: [],                // every choice on offer, as authored
          key: new Set(),            // which of those are correct
          picks: new Map(),          // index -> how many times it was chosen
        };
        map.set(r.n, q);
      }
      q.total += 1;

      // Every pick, right or wrong. The wrong ones alone say a question is
      // being missed; the whole spread says which wrong answer people
      // believe, and how far ahead of the rest it is.
      if (r.choices) {
        if (!q.labels.length) {
          q.labels = r.choices;
          for (const i of (r.correctChoices || [])) q.key.add(i);
        }
        for (const i of (r.given || [])) q.picks.set(i, (q.picks.get(i) || 0) + 1);
      }

      if (r.correct) { q.right += 1; continue; }

      if (r.type === 'hotspot') {
        (r.hotspots || []).forEach((h, i) => {
          if ((r.found || []).includes(i)) return;
          q.missedSpots.set(h.label, (q.missedSpots.get(h.label) || 0) + 1);
        });
        continue;
      }

      const given = r.given || [];
      const correct = r.correctChoices || [];
      for (const i of given) {
        if (correct.includes(i)) continue;
        const label = (r.choices || [])[i];
        if (label) q.wrongPicks.set(label, (q.wrongPicks.get(label) || 0) + 1);
      }
      for (const i of correct) {
        if (given.includes(i)) continue;
        const label = (r.choices || [])[i];
        if (label) q.missedRight.set(label, (q.missedRight.get(label) || 0) + 1);
      }
    }
  }

  const top = m => {
    let best = null;
    for (const [label, count] of m) if (!best || count > best.count) best = { label, count };
    return best;
  };

  return [...map.values()].map(q => ({
    n: q.n, title: q.title, type: q.type, points: q.points,
    right: q.right, total: q.total,
    percent: q.total ? Math.round((q.right / q.total) * 100) : 0,
    choices: q.labels.map((label, i) => ({
      label, count: q.picks.get(i) || 0, correct: q.key.has(i),
    })),
    commonWrong: top(q.wrongPicks),
    commonMissed: top(q.missedRight),
    commonMissedSpot: top(q.missedSpots),
  })).sort((a, b) => a.percent - b.percent || a.n - b.n);
}

/** Stores that have missed the same question on more than one walk. */
function repeatMisses(rows, graded) {
  const seen = new Map();   // store|n -> { store, n, title, times }

  rows.forEach((row, i) => {
    for (const r of graded[i].results) {
      if (r.correct) continue;
      const key = row.store_number + '|' + r.n;
      const hit = seen.get(key) || { store_number: row.store_number, n: r.n, title: r.title, times: 0 };
      hit.times += 1;
      seen.set(key, hit);
    }
  });

  return [...seen.values()]
    .filter(h => h.times > 1)
    .sort((a, b) => b.times - a.times || a.n - b.n);
}

/** Average score by the day the walk was done, oldest first. */
function trend(rows) {
  const days = new Map();
  for (const r of rows) {
    const day = String(r.created_at).slice(0, 10);
    const d = days.get(day) || { day, responses: 0, total: 0, max: r.max_score };
    d.responses += 1;
    d.total += r.score;
    days.set(day, d);
  }
  return [...days.values()]
    .map(d => ({ day: d.day, responses: d.responses, maxScore: d.max,
                 averageScore: +(d.total / d.responses).toFixed(1) }))
    .sort((a, b) => a.day.localeCompare(b.day));
}

/** Average score by Area Coach, worst first. */
function byCoach(rows, assignments) {
  const map = new Map();
  for (const r of rows) {
    const coach = (assignments[r.store_number] || {}).area_coach || 'Nobody assigned';
    const c = map.get(coach) || { coach, responses: 0, total: 0, stores: new Set(), maxScore: r.max_score };
    c.responses += 1;
    c.total += r.score;
    c.stores.add(r.store_number);
    map.set(coach, c);
  }
  return [...map.values()]
    .map(c => ({ coach: c.coach, responses: c.responses, stores: c.stores.size,
                 maxScore: c.maxScore, averageScore: +(c.total / c.responses).toFixed(1) }))
    .sort((a, b) => a.averageScore - b.averageScore);
}

/**
 * The things worth saying out loud, as sentences.
 *
 * Deliberately conservative: nothing is claimed off one or two walks, because
 * a report that cries wolf at n=1 stops being read. Each line is something
 * you could act on this week.
 */
function standouts({ rows, questions, repeats, coaches, days, averageScore, maxScore }) {
  const out = [];
  if (rows.length === 0) return out;

  if (rows.length < ENOUGH) {
    out.push({
      kind: 'thin',
      text: `Only ${rows.length} walk${rows.length === 1 ? '' : 's'} so far. Numbers here will not mean much until about ${ENOUGH}.`,
    });
  }

  // The questions the region is actually failing.
  for (const q of questions.filter(q => q.total >= ENOUGH && q.percent < 60).slice(0, 3)) {
    let text = `${q.percent}% got question ${q.n} right — ${shorten(q.title)}`;
    if (q.commonWrong && q.commonWrong.count > 1) {
      text += `. ${q.commonWrong.count} of them chose "${shorten(q.commonWrong.label, 70)}"`;
    } else if (q.commonMissed && q.commonMissed.count > 1) {
      text += `. ${q.commonMissed.count} left out "${shorten(q.commonMissed.label, 70)}"`;
    } else if (q.commonMissedSpot && q.commonMissedSpot.count > 1) {
      text += `. ${q.commonMissedSpot.count} walked past "${shorten(q.commonMissedSpot.label, 70)}"`;
    }
    out.push({ kind: 'question', n: q.n, text });
  }

  // A store missing the same thing twice is a habit, not a bad day.
  for (const h of repeats.slice(0, 3)) {
    out.push({
      kind: 'repeat', store: h.store_number,
      text: `Store ${h.store_number} has missed question ${h.n} on ${h.times} walks — ${shorten(h.title)}`,
    });
  }

  // Whether any of it is moving.
  if (days.length >= 2) {
    const first = days[0], last = days[days.length - 1];
    const shift = +(last.averageScore - first.averageScore).toFixed(1);
    if (Math.abs(shift) >= 1) {
      out.push({
        kind: 'trend',
        text: shift > 0
          ? `Scores are up ${shift} points since ${first.day} (${first.averageScore} then, ${last.averageScore} now).`
          : `Scores are down ${Math.abs(shift)} points since ${first.day} (${first.averageScore} then, ${last.averageScore} now).`,
      });
    }
  }

  // An Area Coach well below the rest, only once there is enough to say so.
  const real = coaches.filter(c => c.responses >= 2 && c.coach !== 'Nobody assigned');
  if (real.length >= 2 && rows.length >= ENOUGH) {
    const worst = real[0];
    if (averageScore - worst.averageScore >= 2) {
      out.push({
        kind: 'coach', coach: worst.coach,
        text: `${worst.coach}'s stores average ${worst.averageScore} of ${maxScore}, against ${averageScore} across everyone.`,
      });
    }
  }

  // Nothing wrong is also worth saying.
  if (out.length === 0 || (out.length === 1 && out[0].kind === 'thin')) {
    out.push({ kind: 'clear', text: 'Nothing stands out yet. No question is being failed across the region.' });
  }
  return out;
}

function shorten(s, max = 90) {
  const text = String(s || '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : text.slice(0, max - 1).trimEnd() + '…';
}

/** Everything above, in one object, from rows plus their frozen scores. */
function build(rows, graded, assignments) {
  const questions = byQuestion(graded);
  const repeats = repeatMisses(rows, graded);
  const days = trend(rows);
  const coaches = byCoach(rows, assignments);
  const averageScore = rows.length
    ? +(rows.reduce((s, r) => s + r.score, 0) / rows.length).toFixed(1) : 0;
  const maxScore = rows.length ? rows[0].max_score : 0;

  return {
    questions, repeats, days, coaches, averageScore, maxScore,
    standouts: standouts({ rows, questions, repeats, coaches, days, averageScore, maxScore }),
  };
}

module.exports = { build, byQuestion, repeatMisses, trend, byCoach, standouts, ENOUGH };
