// A one-answer question where more than one answer is acceptable.
//
// Some questions have two right answers and no favourite. Seeing wings over
// the fryer with no timer, temping them before saucing and binning them for
// a fresh drop are both correct; marking one and failing the other teaches
// the wrong thing. The walker still picks one — this is not pick-all.

const { grade } = require('../services/audits');
const { validateTemplate } = require('../services/audit-templates');

const WINGS = {
  n: 1,
  title: 'Wings are sitting over the fryer with no timer running. What do you do?',
  type: 'single',
  choices: [
    'You remember a timer beeping, so assume these are those wings and sauce them',
    'Look at them and see whether they look cooked',
    'Ask whoever is around if they pulled them up and if they are ready',
    'Temp them to make sure they are done, then sauce them',
    'Throw them away and drop a fresh batch',
  ],
  correct: [3, 4],
  points: 5,
};

const DEF = { id: 'wings', title: 'Wings', kind: 'test', questions: [WINGS] };
const scoreFor = pick => grade(DEF, { 1: pick }).score;

describe('a one-answer question with two acceptable answers', () => {
  test('the validator allows it', () => {
    expect(validateTemplate({ ...DEF, questions: [{ ...WINGS, title: 'x', type: 'single' }] }))
      .toEqual([]);
  });

  test('either of the right answers earns full marks', () => {
    expect(scoreFor([3])).toBe(5);
    expect(scoreFor([4])).toBe(5);
  });

  test('a wrong answer earns nothing', () => {
    for (const bad of [[0], [1], [2]]) expect(scoreFor(bad)).toBe(0);
  });

  test('picking both does not score — it is one answer, not pick-all', () => {
    expect(scoreFor([3, 4])).toBe(0);
  });

  test('picking everything does not score', () => {
    expect(scoreFor([0, 1, 2, 3, 4])).toBe(0);
  });

  test('answering nothing earns nothing', () => {
    expect(scoreFor([])).toBe(0);
    expect(grade(DEF, {}).score).toBe(0);
  });

  test('a single right answer still behaves as it always did', () => {
    const one = { ...DEF, questions: [{ ...WINGS, correct: [4] }] };
    expect(grade(one, { 1: [4] }).score).toBe(5);
    expect(grade(one, { 1: [3] }).score).toBe(0);
  });
});

describe('pick-all is untouched by this', () => {
  const MULTI = {
    n: 1, title: 'Pick everything that applies', type: 'multi',
    choices: ['a', 'b', 'c', 'd'], correct: [1, 3], points: 4,
  };
  const def = { id: 'm', title: 'M', kind: 'test', questions: [MULTI] };

  test('still wants the whole set', () => {
    expect(grade(def, { 1: [1, 3] }).score).toBe(4);
  });

  test('half of it still earns nothing', () => {
    expect(grade(def, { 1: [1] }).score).toBe(0);
    expect(grade(def, { 1: [3] }).score).toBe(0);
  });

  test('the whole set plus a wrong one earns nothing', () => {
    expect(grade(def, { 1: [1, 2, 3] }).score).toBe(0);
  });
});
