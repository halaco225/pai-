// Reading the results. These numbers are what gets coached from, so what they
// claim — and what they refuse to claim off two walks — matters more than
// that they add up.

const { build, byQuestion, repeatMisses, trend, byCoach } = require('../services/audit-insights');

const assignments = {
  '039155': { store_id: '039155', store_name: 'Cuero',    area_coach: 'Darian Spikes' },
  '039156': { store_id: '039156', store_name: 'Gonzales', area_coach: 'Darian Spikes' },
  '039157': { store_id: '039157', store_name: 'Yoakum',   area_coach: 'Ebony Simmons' },
};

// One graded question: n=3, four choices, the right answer is index 2.
const q3 = (given, correct) => ({
  n: 3, title: 'Will the store pass the kitchen cleaning check?', type: 'single', points: 1,
  earned: correct ? 1 : 0, correct,
  choices: ['Floor was mopped', 'Vents do not count', 'All surfaces must be clean', 'Only if bugs'],
  given, correctChoices: [2], explanation: 'Every surface.',
});

const walk = (store, day, score, results) => ({
  row: { id: store + day, store_number: store, created_at: day + 'T12:00:00Z', score, max_score: 20 },
  graded: { score, maxScore: 20, results },
});

const set = walks => ({ rows: walks.map(w => w.row), graded: walks.map(w => w.graded) });

describe('byQuestion', () => {
  test('names the wrong answer people actually chose', () => {
    const { graded } = set([
      walk('039155', '2026-10-01', 17, [q3([0], false)]),
      walk('039156', '2026-10-01', 18, [q3([0], false)]),
      walk('039157', '2026-10-01', 20, [q3([2], true)]),
    ]);
    const q = byQuestion(graded)[0];
    expect(q.percent).toBe(33);
    expect(q.commonWrong).toEqual({ label: 'Floor was mopped', count: 2 });
  });

  // The summary tab prints this list under every question, so a choice
  // nobody picked still has to come back — at zero, in its authored order.
  test('counts every choice, including the ones nobody picked', () => {
    const { graded } = set([
      walk('039155', '2026-10-01', 17, [q3([0], false)]),
      walk('039156', '2026-10-01', 18, [q3([0], false)]),
      walk('039157', '2026-10-01', 20, [q3([2], true)]),
    ]);
    expect(byQuestion(graded)[0].choices).toEqual([
      { label: 'Floor was mopped',           count: 2, correct: false },
      { label: 'Vents do not count',         count: 0, correct: false },
      { label: 'All surfaces must be clean', count: 1, correct: true },
      { label: 'Only if bugs',               count: 0, correct: false },
    ]);
  });

  test('a question everyone gets right has nothing to teach', () => {
    const { graded } = set([walk('039155', '2026-10-01', 20, [q3([2], true)])]);
    const q = byQuestion(graded)[0];
    expect(q.percent).toBe(100);
    expect(q.commonWrong).toBeNull();
  });

  test('on a pick-all question it names the right answer left out', () => {
    const multi = given => ({
      n: 6, title: 'Which get checked?', type: 'multi', points: 1, correct: false, earned: 0,
      choices: ['Hoods', 'Handles', 'Shelves', 'Office computer'],
      given, correctChoices: [0, 1, 2], explanation: '',
    });
    const { graded } = set([
      walk('039155', '2026-10-01', 17, [multi([0, 1])]),
      walk('039156', '2026-10-01', 17, [multi([0, 1])]),
    ]);
    expect(byQuestion(graded)[0].commonMissed).toEqual({ label: 'Shelves', count: 2 });
  });

  test('on a picture question it names the thing people walk past', () => {
    const shot = {
      n: 15, title: 'What is wrong here?', type: 'hotspot', points: 3, correct: false, earned: 0,
      hotspots: [{ label: 'On a phone with gloves on' }, { label: 'Towel on the table' }],
      found: [0], explanation: '',
    };
    const { graded } = set([
      walk('039155', '2026-10-01', 17, [shot]),
      walk('039156', '2026-10-01', 17, [shot]),
    ]);
    expect(byQuestion(graded)[0].commonMissedSpot).toEqual({ label: 'Towel on the table', count: 2 });
  });

  test('the worst question comes first', () => {
    const good = { ...q3([2], true), n: 9, title: 'Easy one' };
    const { graded } = set([walk('039155', '2026-10-01', 17, [q3([0], false), good])]);
    expect(byQuestion(graded).map(q => q.n)).toEqual([3, 9]);
  });
});

describe('repeatMisses', () => {
  test('a store missing the same question twice is a habit', () => {
    const { rows, graded } = set([
      walk('039155', '2026-10-01', 17, [q3([0], false)]),
      walk('039155', '2026-10-08', 17, [q3([1], false)]),
      walk('039156', '2026-10-01', 17, [q3([0], false)]),
    ]);
    const repeats = repeatMisses(rows, graded);
    expect(repeats).toHaveLength(1);
    expect(repeats[0]).toMatchObject({ store_number: '039155', n: 3, times: 2 });
  });

  test('missing it once is a bad day, not a pattern', () => {
    const { rows, graded } = set([walk('039155', '2026-10-01', 17, [q3([0], false)])]);
    expect(repeatMisses(rows, graded)).toEqual([]);
  });
});

describe('trend', () => {
  test('averages by day, oldest first', () => {
    const { rows } = set([
      walk('039155', '2026-10-08', 18, []),
      walk('039155', '2026-10-01', 12, []),
      walk('039156', '2026-10-01', 14, []),
    ]);
    const days = trend(rows);
    expect(days.map(d => d.day)).toEqual(['2026-10-01', '2026-10-08']);
    expect(days[0].averageScore).toBe(13);
    expect(days[1].averageScore).toBe(18);
  });
});

describe('byCoach', () => {
  test('groups stores under their coach, lowest average first', () => {
    const { rows } = set([
      walk('039155', '2026-10-01', 10, []),
      walk('039156', '2026-10-01', 12, []),
      walk('039157', '2026-10-01', 19, []),
    ]);
    const coaches = byCoach(rows, assignments);
    expect(coaches[0]).toMatchObject({ coach: 'Darian Spikes', responses: 2, stores: 2, averageScore: 11 });
    expect(coaches[1].coach).toBe('Ebony Simmons');
  });

  test('a store with no coach is named, not dropped', () => {
    const { rows } = set([walk('039999', '2026-10-01', 10, [])]);
    expect(byCoach(rows, assignments)[0].coach).toBe('Nobody assigned');
  });
});

describe('standouts', () => {
  const text = out => out.standouts.map(x => x.text).join(' | ');

  // The thing that stops the report crying wolf at one walk.
  test('says plainly when there is not enough to go on', () => {
    const { rows, graded } = set([walk('039155', '2026-10-01', 5, [q3([0], false)])]);
    const out = build(rows, graded, assignments);
    expect(text(out)).toMatch(/Only 1 walk so far/);
    expect(out.standouts.some(x => x.kind === 'question')).toBe(false);
  });

  test('calls out a failed question once enough walks are in', () => {
    const { rows, graded } = set([
      walk('039155', '2026-10-01', 5, [q3([0], false)]),
      walk('039156', '2026-10-01', 5, [q3([0], false)]),
      walk('039157', '2026-10-01', 5, [q3([0], false)]),
    ]);
    const out = build(rows, graded, assignments);
    expect(text(out)).toMatch(/0% got question 3 right/);
    expect(text(out)).toMatch(/3 of them chose "Floor was mopped"/);
  });

  test('says nothing is wrong when nothing is wrong', () => {
    const { rows, graded } = set([
      walk('039155', '2026-10-01', 20, [q3([2], true)]),
      walk('039156', '2026-10-01', 20, [q3([2], true)]),
      walk('039157', '2026-10-01', 20, [q3([2], true)]),
    ]);
    expect(text(build(rows, graded, assignments))).toMatch(/Nothing stands out yet/);
  });

  test('reports a real move in scores over time', () => {
    const { rows, graded } = set([
      walk('039155', '2026-10-01', 10, [q3([2], true)]),
      walk('039156', '2026-10-01', 10, [q3([2], true)]),
      walk('039157', '2026-10-01', 10, [q3([2], true)]),
      walk('039155', '2026-10-15', 18, [q3([2], true)]),
    ]);
    expect(text(build(rows, graded, assignments))).toMatch(/Scores are up 8 points/);
  });

  test('an empty set says nothing at all', () => {
    expect(build([], [], assignments).standouts).toEqual([]);
  });
});
