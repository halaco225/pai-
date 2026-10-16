// Put-in-order questions, added for the hand-washing test where the steps of
// washing your hands are themselves the answer.

const { publicForm, grade, checkOne, missingAnswers, shuffle } = require('../services/audits');

const STEPS = ['Wet Hands', 'Apply Soap', 'Lather Hands and Wrists', 'Rinse Hands',
               'Dry Hands', 'Turn Off Faucets', 'Apply Sanitizer'];

const def = {
  id: 'handwash', title: 'Hand washing', description: '',
  questions: [{
    n: 1, type: 'order', title: 'Put these in the correct order', points: 20, required: true,
    steps: STEPS, explanation: 'Wet, soap, lather, rinse, dry, faucet, sanitizer.',
  }],
};

const rightOrder = STEPS.map((_, i) => i);

describe('what goes out to the phone', () => {
  const form = publicForm(def);
  const q = form.questions[0];

  test('the steps go out, the order does not', () => {
    expect(q.steps).toHaveLength(7);
    expect(q.steps.map(s => s.was).sort((a, b) => a - b)).toEqual(rightOrder);
    expect(q.steps.map(s => s.was)).not.toEqual(rightOrder);   // shuffled
  });

  test('no explanation and no answer leaks with it', () => {
    const json = JSON.stringify(form);
    expect(json).not.toContain('explanation');
    expect(json).not.toContain('rightOrder');
  });

  // A list that reshuffles under them while they are working is unusable.
  test('the shuffle is the same every time it is drawn', () => {
    expect(publicForm(def).questions[0].steps.map(s => s.was))
      .toEqual(publicForm(def).questions[0].steps.map(s => s.was));
  });

  test('shuffle keeps every step exactly once', () => {
    const out = shuffle(STEPS);
    expect(out.map(s => s.text).sort()).toEqual([...STEPS].sort());
  });
});

describe('grading an order', () => {
  test('the right order earns the points', () => {
    const result = grade(def, { 1: rightOrder });
    expect(result.score).toBe(20);
    expect(result.results[0].correct).toBe(true);
  });

  test('two steps swapped earns nothing', () => {
    expect(grade(def, { 1: [1, 0, 2, 3, 4, 5, 6] }).score).toBe(0);
  });

  // The one that matters: sanitizer before drying is a real mistake, not a
  // near miss, and it should score the same as any other wrong order.
  test('sanitizing before drying earns nothing', () => {
    expect(grade(def, { 1: [0, 1, 2, 3, 6, 4, 5] }).score).toBe(0);
  });

  test('a half-finished order earns nothing', () => {
    expect(grade(def, { 1: [0, 1, 2] }).score).toBe(0);
  });

  test('nothing placed earns nothing and does not crash', () => {
    expect(grade(def, {}).score).toBe(0);
    expect(grade(def, { 1: [] }).score).toBe(0);
  });
});

describe('marking it on the spot', () => {
  test('a right order is confirmed, with the explanation', () => {
    const v = checkOne(def, 1, rightOrder);
    expect(v.correct).toBe(true);
    expect(v.explanation).toMatch(/Wet, soap, lather/);
  });

  test('a wrong order comes back with the right one', () => {
    const v = checkOne(def, 1, [6, 5, 4, 3, 2, 1, 0]);
    expect(v.correct).toBe(false);
    expect(v.rightOrder).toEqual(rightOrder);
  });

  test('nothing placed reveals nothing', () => {
    expect(checkOne(def, 1, [])).toBeNull();
    expect(checkOne(def, 1, null)).toBeNull();
  });
});

describe('finishing it', () => {
  test('every step has to be placed', () => {
    expect(missingAnswers(def, { 1: [0, 1, 2] }, {})[0].message)
      .toBe('Question 1 needs every step put in order.');
  });

  test('a full order is finished', () => {
    expect(missingAnswers(def, { 1: rightOrder }, {})).toEqual([]);
  });

  // Wrong is still finished — it gets marked, not refused.
  test('a full but wrong order is still finished', () => {
    expect(missingAnswers(def, { 1: [6, 5, 4, 3, 2, 1, 0] }, {})).toEqual([]);
  });
});
