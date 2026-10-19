// Put-it-where-it-goes: sorting into buckets, matching two lists and dropping
// labels on a picture are one question type underneath, so they are graded in
// one place and tested in one place.

const { publicForm, grade, missingAnswers, checkOne, assignScore } = require('../services/audits');

const sort = {
  n: 3,
  title: 'Sort these into raw and ready to eat.',
  type: 'assign',
  layout: 'buckets',
  points: 8,
  targets: [{ label: 'Raw' }, { label: 'Ready to eat' }],
  items: [
    { text: 'Raw wings', target: 0 },
    { text: 'Shredded cheese', target: 1 },
    { text: 'Raw dough', target: 0 },
    { text: 'Cut lettuce', target: 1 },
  ],
  explanation: 'Raw goes below ready-to-eat, always.',
  required: true,
};

const onPicture = {
  n: 4,
  title: 'Drag each label onto the right sink.',
  type: 'assign',
  layout: 'picture',
  points: 6,
  image: '/audits/sinks.webp',
  targets: [{ label: 'Hand sink', x: 20, y: 40 }, { label: '3-compartment', x: 70, y: 45 }],
  items: [{ text: 'Wash your hands here', target: 0 }, { text: 'Wash dishes here', target: 1 }],
  explanation: 'The hand sink is only ever for hands.',
  required: true,
};

const def = { id: 't', title: 'T', description: '', questions: [sort, onPicture] };

describe('what reaches the phone', () => {
  const form = publicForm(def);
  const json = JSON.stringify(form);

  test('never says where anything belongs', () => {
    expect(json).not.toContain('"target"');
    expect(json).not.toContain('explanation');
  });

  test('sends the buckets by name, so they can be dropped on', () => {
    const q = form.questions.find(x => x.n === 3);
    expect(q.targets.map(t => t.label)).toEqual(['Raw', 'Ready to eat']);
  });

  test('on a picture the targets are places, not names', () => {
    const q = form.questions.find(x => x.n === 4);
    expect(q.image).toBe('/audits/sinks.webp');
    for (const t of q.targets) {
      expect(t.label).toBeUndefined();     // a labelled circle would be the answer
      expect(typeof t.x).toBe('number');
    }
  });

  test('the tray is shuffled, and each item still knows its own place', () => {
    const q = form.questions.find(x => x.n === 3);
    expect(q.items.map(x => x.text).sort()).toEqual(
      ['Cut lettuce', 'Raw dough', 'Raw wings', 'Shredded cheese']);
    expect(q.items.map(x => x.i).sort()).toEqual([0, 1, 2, 3]);
  });
});

describe('scoring', () => {
  test('all four in the right place is full marks', () => {
    expect(assignScore(sort, [0, 1, 0, 1]).earned).toBe(8);
    expect(grade(def, { 3: [0, 1, 0, 1] }).score).toBe(8);
  });

  test('one in the wrong place is the whole question wrong', () => {
    expect(assignScore(sort, [0, 1, 0, 0]).earned).toBe(0);   // three of four earns nothing
    expect(assignScore(sort, [1, 0, 1, 0]).earned).toBe(0);   // every one swapped
  });

  test('what they did get right is still counted, for the explanation', () => {
    const m = assignScore(sort, [0, 1, null, null]);
    expect(m.right).toBe(2);
    expect(m.of).toBe(4);
    expect(m.earned).toBe(0);
  });

  test('right means every item, not most of them', () => {
    const r = grade(def, { 3: [0, 1, 0, 0] }).results.find(x => x.n === 3);
    expect(r.correct).toBe(false);
    expect(r.right).toBe(3);
    expect(r.of).toBe(4);
  });
});

describe('marking one as they go', () => {
  test('says nothing until something has been placed', () => {
    expect(checkOne(def, 3, [])).toBeNull();
    expect(checkOne(def, 3, [null, null, null, null])).toBeNull();
  });

  test('once marked it shows where each one belonged', () => {
    const v = checkOne(def, 3, [0, 1, 0, 0]);
    expect(v.correct).toBe(false);
    expect(v.items[3]).toEqual({ text: 'Cut lettuce', target: 1, put: 0 });
    expect(v.targets).toEqual(['Raw', 'Ready to eat']);
    expect(v.explanation).toBeTruthy();
  });
});

describe('finishing the walk', () => {
  test('every item has to be somewhere', () => {
    const missing = missingAnswers(def, { 3: [0, 1, null, null], 4: [0, 1] }, {});
    expect(missing).toEqual([{ n: 3, message: 'Question 3 still has 2 to place.' }]);
  });

  test('a full board is finished', () => {
    expect(missingAnswers(def, { 3: [0, 1, 0, 1], 4: [0, 1] }, {})).toEqual([]);
  });
});
