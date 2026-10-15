// Grading boundaries for the Steritech readiness walk.
//
// The two that matter most: a multi-select must be exact (a partial pick is
// worth nothing, as in the Forms quiz this replaces), and the answer key must
// never reach the browser before submit.

const { loadAudit, publicForm, grade, missingAnswers, maxScore } = require('../services/audits');

const def = loadAudit('steritech-readiness');

describe('the audit definition', () => {
  test('loads', () => {
    expect(def).toBeTruthy();
    expect(def.questions).toHaveLength(20);
  });

  // Guards the total against a future edit to the JSON.
  test('is worth exactly 20 points', () => {
    expect(maxScore(def)).toBe(20);
  });

  test('rejects an id that climbs out of data/audits', () => {
    expect(loadAudit('../../package')).toBeNull();
    expect(loadAudit('nope')).toBeNull();
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

describe('grade', () => {
  test('single choice is all or nothing', () => {
    expect(grade(def, { 3: [2] }).score).toBe(1);
    expect(grade(def, { 3: [0] }).score).toBe(0);
  });

  test('multi-select needs the exact set', () => {
    // Q6 is worth 1, correct = [0,1,2].
    expect(grade(def, { 6: [0, 1, 2] }).score).toBe(1);
    expect(grade(def, { 6: [0, 1] }).score).toBe(0);       // partial earns nothing
    expect(grade(def, { 6: [0, 1, 2, 3] }).score).toBe(0); // one extra earns nothing
    expect(grade(def, { 6: [2, 0, 1] }).score).toBe(1);    // order does not matter
  });

  test('a perfect walk scores 20', () => {
    const answers = {};
    for (const q of def.questions) if (q.correct) answers[q.n] = q.correct;
    const result = grade(def, answers);
    expect(result.score).toBe(20);
    expect(result.maxScore).toBe(20);
  });

  test('an empty submission scores 0 and still explains every graded question', () => {
    const result = grade(def, {});
    expect(result.score).toBe(0);
    expect(result.results).toHaveLength(12);
    for (const r of result.results) {
      expect(r.explanation).toBeTruthy();
      expect(r.correctChoices.length).toBeGreaterThan(0);
    }
  });

  test('ungraded questions never add points', () => {
    expect(grade(def, { 1: 'Harold Lacoste', 20: 'Clean the hood' }).score).toBe(0);
  });
});

describe('missingAnswers', () => {
  const complete = () => {
    const answers = {};
    const photos = {};
    for (const q of def.questions) {
      if (q.type === 'photo') photos[q.n] = ['audit-photos/x.jpg'];
      else if (q.correct) answers[q.n] = q.correct;
      else answers[q.n] = 'something';
    }
    return { answers, photos };
  };

  test('a complete walk has nothing missing', () => {
    const { answers, photos } = complete();
    expect(missingAnswers(def, answers, photos)).toEqual([]);
  });

  test('every question is required', () => {
    expect(missingAnswers(def, {}, {})).toHaveLength(20);
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
