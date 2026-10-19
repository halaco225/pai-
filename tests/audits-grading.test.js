// Grading boundaries for the Steritech readiness walk.
//
// The two that matter most: a multi-select must be exact (a partial pick is
// worth nothing, as in the Forms quiz this replaces), and the answer key must
// never reach the browser before submit.

const { publicForm, grade, missingAnswers, maxScore } = require('../services/audits');

// The seed file, which is what the table is first filled from.
const def = require('../data/audits/steritech-readiness.json');

describe('the audit definition', () => {
  test('loads', () => {
    expect(def).toBeTruthy();
    expect(def.questions).toHaveLength(21);
  });

  // Guards the total against a future edit to the seed.
  test('is worth exactly 23 points', () => {
    expect(maxScore(def)).toBe(23);
  });
});

describe('publicForm', () => {
  const form = publicForm(def);
  const json = JSON.stringify(form);

  test('never ships the answer key', () => {
    expect(json).not.toContain('correct');
    expect(json).not.toContain('explanation');
    for (const q of form.questions) {
      expect(q.correct).toBeUndefined();
      expect(q.explanation).toBeUndefined();
    }
  });

  test('keeps what the page needs to render', () => {
    const q6 = form.questions.find(q => q.n === 6);
    expect(q6.choices).toHaveLength(4);
    expect(q6.type).toBe('multi');
    expect(form.questions.find(q => q.n === 4).maxPhotos).toBe(3);
  });
});

// Every question answered the right way, including tapping each problem in
// the picture question.
function perfectAnswers() {
  const answers = {};
  for (const q of def.questions) {
    if (q.correct) answers[q.n] = q.correct;
    else if (q.type === 'hotspot') answers[q.n] = q.hotspots.map(h => ({ x: h.x, y: h.y }));
  }
  return answers;
}

describe('grade', () => {
  test('single choice is all or nothing', () => {
    expect(grade(def, { 3: [2] }).score).toBe(1);
    expect(grade(def, { 3: [0] }).score).toBe(0);
  });

  test('multi-select is all or nothing', () => {
    // Q6 is worth 1, correct = [0,1,2] out of 4 choices.
    expect(grade(def, { 6: [0, 1, 2] }).score).toBe(1);
    expect(grade(def, { 6: [2, 0, 1] }).score).toBe(1);      // order does not matter
    expect(grade(def, { 6: [0, 1] }).score).toBe(0);         // one short is wrong
    expect(grade(def, { 6: [0, 1, 2, 3] }).score).toBe(0);   // one extra is wrong
    expect(grade(def, { 6: [3] }).score).toBe(0);
  });

  test('a perfect walk scores 23', () => {
    const result = grade(def, perfectAnswers());
    expect(result.score).toBe(23);
    expect(result.maxScore).toBe(23);
  });

  test('an empty submission scores 0 and still explains every scored question', () => {
    const result = grade(def, {});
    expect(result.score).toBe(0);
    expect(result.results).toHaveLength(13);
    for (const r of result.results) {
      expect(r.explanation).toBeTruthy();
      // A picture question answers with hotspots rather than choices.
      if (r.type === 'hotspot') expect(r.hotspots.length).toBeGreaterThan(0);
      else expect(r.correctChoices.length).toBeGreaterThan(0);
    }
  });

  test('ungraded questions never add points', () => {
    expect(grade(def, { 1: 'Harold Lacoste', 21: 'Clean the hood' }).score).toBe(0);
  });
});

describe('missingAnswers', () => {
  const complete = () => {
    const answers = {};
    const photos = {};
    for (const q of def.questions) {
      if (q.type === 'photo') photos[q.n] = ['audit-photos/x.jpg'];
      else if (q.correct) answers[q.n] = q.correct;
      else if (q.type === 'hotspot') answers[q.n] = q.hotspots.map(h => ({ x: h.x, y: h.y }));
      else answers[q.n] = 'something';
    }
    return { answers, photos };
  };

  test('a complete walk has nothing missing', () => {
    const { answers, photos } = complete();
    expect(missingAnswers(def, answers, photos)).toEqual([]);
  });

  test('every question is required', () => {
    expect(missingAnswers(def, {}, {})).toHaveLength(21);
  });

  test('a photo question needs at least one picture', () => {
    const { answers, photos } = complete();
    photos[9] = [];
    const missing = missingAnswers(def, answers, photos);
    expect(missing).toEqual([{ n: 9, message: 'Question 9 needs at least one picture.' }]);
  });

  test('blank text does not count as an answer', () => {
    const { answers, photos } = complete();
    answers[1] = '   ';
    expect(missingAnswers(def, answers, photos).map(m => m.n)).toEqual([1]);
  });
});

// Marking one question at a time, for the verdict shown the moment it is
// answered. This is the only way the answer key reaches a phone, so what it
// will and will not reveal is the thing worth pinning down.
describe('checkOne', () => {
  const { checkOne } = require('../services/audits');

  test('marks a right answer and explains it anyway', () => {
    const v = checkOne(def, 3, [2]);
    expect(v.correct).toBe(true);
    expect(v.correctChoices).toEqual([2]);
    expect(v.explanation).toMatch(/EVERY surface/);
  });

  test('marks a wrong answer and says what was right', () => {
    const v = checkOne(def, 3, [0]);
    expect(v.correct).toBe(false);
    expect(v.correctChoices).toEqual([2]);
  });

  test('a multi-select still has to be exact', () => {
    expect(checkOne(def, 6, [0, 1, 2]).correct).toBe(true);
    expect(checkOne(def, 6, [0, 1]).correct).toBe(false);
  });

  // The point of the endpoint: you only get the answer to a question you have
  // actually answered. An empty pick reveals nothing.
  test('reveals nothing for a question that was not answered', () => {
    expect(checkOne(def, 3, [])).toBeNull();
    expect(checkOne(def, 3, null)).toBeNull();
    expect(checkOne(def, 3, undefined)).toBeNull();
  });

  test('reveals nothing for a question that is not scored', () => {
    expect(checkOne(def, 1, 'Harold')).toBeNull();   // name
    expect(checkOne(def, 4, [0])).toBeNull();        // photo
    expect(checkOne(def, 21, 'fix the hood')).toBeNull();
  });

  test('reveals nothing for a question that does not exist', () => {
    expect(checkOne(def, 999, [0])).toBeNull();
    expect(checkOne(def, 'oops', [0])).toBeNull();
  });

  test('agrees with the final grade', () => {
    for (const q of def.questions.filter(x => x.type === 'single' || x.type === 'multi')){
      const v = checkOne(def, q.n, q.correct);
      expect(v.correct).toBe(true);
      expect(v.points).toBe(q.points);
    }
  });
});

// The tap-the-picture question. Taps are percentages of the picture, so they
// mean the same thing on any screen; what matters is which problems a set of
// taps claims, and whether tapping everywhere can pass.
describe('matchTaps', () => {
  const { matchTaps } = require('../services/audits');
  const q = def.questions.find(x => x.type === 'hotspot');
  const at = i => ({ x: q.hotspots[i].x, y: q.hotspots[i].y });

  test('the picture question is in the walk and worth points', () => {
    expect(q).toBeTruthy();
    expect(q.hotspots.length).toBe(7);
    expect(q.points).toBe(3);
    expect(q.image).toBe('/audits/kitchen-check-1.webp');
  });

  test('every problem tapped dead centre is found', () => {
    const m = matchTaps(q, q.hotspots.map((h, i) => at(i)));
    expect(m.found).toHaveLength(7);
    expect(m.correct).toBe(true);
  });

  test('a near miss still counts, because a thumb is not a cursor', () => {
    const h = q.hotspots[0];
    const m = matchTaps(q, [{ x: h.x + h.rx, y: h.y }]);
    expect(m.found).toEqual([0]);
  });

  test('a tap nowhere near anything is a stray', () => {
    const m = matchTaps(q, [{ x: 99, y: 1 }]);
    expect(m.found).toHaveLength(0);
    expect(m.strays).toHaveLength(1);
    expect(m.correct).toBe(false);
  });

  test('missing one means no points', () => {
    const m = matchTaps(q, q.hotspots.slice(0, 6).map((h, i) => at(i)));
    expect(m.found).toHaveLength(6);
    expect(m.correct).toBe(false);
  });

  // The reason there is a tap limit at all.
  test('tapping the whole picture does not pass', () => {
    const everywhere = [];
    for (let x = 2; x < 100; x += 6) for (let y = 2; y < 100; y += 6) everywhere.push({ x, y });
    const m = matchTaps(q, everywhere);
    expect(m.found).toHaveLength(7);        // it does find them all
    expect(m.tapsUsed).toBeGreaterThan(m.maxTaps);
    expect(m.correct).toBe(false);          // and it still fails
  });

  test('two taps on the same problem only claim it once', () => {
    const m = matchTaps(q, [at(0), at(0)]);
    expect(m.found).toEqual([0]);
    expect(m.tapsUsed).toBe(2);
  });

  test('the allowance is the problems plus the spare taps', () => {
    expect(matchTaps(q, [at(0)]).maxTaps).toBe(7 + q.extraTaps);
  });

  test('rubbish in the taps is ignored rather than crashing', () => {
    const m = matchTaps(q, [null, { x: 'no' }, {}, at(0)]);
    expect(m.found).toEqual([0]);
  });
});
