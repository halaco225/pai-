// What the walk record is for: the score comes from what was written down as
// each question was answered, never from what the phone sends at the end.

const { sealed, isUuid } = require('../services/audit-walks');

const def = { questions: [
  { n: 1, type: 'text' },
  { n: 2, type: 'single', choices: ['a','b'], correct: [0], points: 1 },
  { n: 3, type: 'multi',  choices: ['a','b'], correct: [1], points: 3 },
  { n: 4, type: 'photo' },
  { n: 5, type: 'longtext' },
]};

describe('sealed', () => {
  test('a scored answer comes from the record, not the phone', () => {
    const out = sealed({ '2': [1] }, { 2: [0] }, def);
    expect(out[2]).toEqual([1]);          // the wrong answer they first gave
  });

  test('every scored question on record overrides what was sent', () => {
    const out = sealed({ '2': [1], '3': [0] }, { 2: [0], 3: [1] }, def);
    expect(out[2]).toEqual([1]);
    expect(out[3]).toEqual([0]);
  });

  test('unscored answers are left alone — the record never holds them', () => {
    const sent = { 1: 'Harold', 4: 'ignored', 5: 'fix the hood' };
    const out = sealed({ '2': [0] }, sent, def);
    expect(out[1]).toBe('Harold');
    expect(out[5]).toBe('fix the hood');
  });

  test('a scored question not on record keeps what was sent', () => {
    const out = sealed({ '2': [0] }, { 2: [0], 3: [1] }, def);
    expect(out[3]).toEqual([1]);
  });

  test('no record at all means the phone is all there is', () => {
    const sent = { 2: [0] };
    expect(sealed(null, sent, def)).toBe(sent);
  });

  test('does not mutate what it was given', () => {
    const sent = { 2: [0] };
    sealed({ '2': [1] }, sent, def);
    expect(sent[2]).toEqual([0]);
  });
});

describe('isUuid', () => {
  test('accepts a real one and refuses anything else', () => {
    expect(isUuid('3f2504e0-4f89-41d3-9a0c-0305e82c3301')).toBe(true);
    expect(isUuid('')).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(isUuid("' OR 1=1 --")).toBe(false);
    expect(isUuid('3f2504e0-4f89-41d3-9a0c')).toBe(false);
  });
});

// The bug this exists to stop: a walk left open while the questions were
// edited. Question 15 was a multiple choice; it became a tap-the-picture
// question. The answer written down against the old one is not an answer to
// the new one, and marking it as though it were told the walker there was no
// signal when the real problem was a stale record.
describe('fits', () => {
  const { fits } = require('../services/audit-walks');

  const choice  = { n: 15, type: 'single' };
  const picture = { n: 15, type: 'hotspot' };

  test('a choice answer does not fit a picture question', () => {
    expect(fits(picture, [2])).toBe(false);
  });

  test('taps do not fit a choice question', () => {
    expect(fits(choice, [{ x: 10, y: 20 }])).toBe(false);
  });

  test('each shape fits its own question', () => {
    expect(fits(choice, [2])).toBe(true);
    expect(fits(picture, [{ x: 10, y: 20 }])).toBe(true);
  });

  test('nothing recorded fits nothing', () => {
    expect(fits(picture, null)).toBe(false);
    expect(fits(picture, [])).toBe(false);
    expect(fits(choice, [])).toBe(false);
  });

  test('half-formed taps do not fit', () => {
    expect(fits(picture, [{ x: 10 }])).toBe(false);
    expect(fits(picture, [{ x: 'a', y: 'b' }])).toBe(false);
  });

  test('a question with no stored shape to check is left alone', () => {
    expect(fits({ type: 'text' }, 'Harold')).toBe(true);
    expect(fits({ type: 'photo' }, 'anything')).toBe(true);
  });
});
