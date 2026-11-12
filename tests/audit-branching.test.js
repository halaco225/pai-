// Two things a template can now say, and both of them can be got wrong in
// ways that only show up on somebody's phone halfway through a walk:
//
//   showIf    — ask this one only when an earlier answer went a certain way
//   compareTo — mark it against what a video was found to show
//
// The risk in the first is a question that waits on an answer nobody will
// ever give, which is a dead end on a phone. The risk in the second is a
// question scored out of a total that only some people were asked, which
// quietly makes two people's scores mean different things.

const { validateTemplate, cleanTemplate } = require('../services/audit-templates');
const { visible, missingAnswers, maxScore, grade } = require('../services/audits');
const { shape, compare } = require('../services/audit-video');

const walk = (...questions) => ({
  id: 'hand-wash',
  title: 'Hand washing',
  description: 'Film it, then say what you saw.',
  questions,
});

const clipQ    = (over = {}) => ({ title: 'Film the wash', type: 'video', points: 0, required: true, ...over });
const yesNoQ   = (over = {}) => ({ title: 'Was it all done?', type: 'single', points: 0, required: true,
                                   choices: ['Yes', 'No'], ...over });
const stepsQ   = (over = {}) => ({ title: 'Which steps were missed?', type: 'multi', points: 0, required: true,
                                   choices: ['Soap', 'Twenty seconds', 'Paper towel'], ...over });

const sound = () => walk(
  clipQ(),
  yesNoQ({ allDone: 0, compareTo: 1 }),
  stepsQ({ showIf: { n: 2, is: [1] }, compareTo: 1 }),
);

describe('validateTemplate: branching', () => {
  test('accepts a video, a yes/no and a step list wired together', () => {
    expect(validateTemplate(sound())).toEqual([]);
  });

  test('a question cannot wait on one below it', () => {
    const def = walk(
      stepsQ({ showIf: { n: 2, is: [1] } }),
      yesNoQ(),
    );
    expect(validateTemplate(def).join(' ')).toMatch(/not above it/);
  });

  test('a question cannot wait on itself', () => {
    const def = walk(yesNoQ({ showIf: { n: 1, is: [0] } }));
    expect(validateTemplate(def).join(' ')).toMatch(/not above it/);
  });

  test('a question cannot wait on something with no answers to pick from', () => {
    const def = walk(
      { title: 'Your name', type: 'text', points: 0, required: true },
      stepsQ({ showIf: { n: 1, is: [0] } }),
    );
    expect(validateTemplate(def).join(' ')).toMatch(/no answers to choose from/);
  });

  test('a question cannot wait on an answer that is not there', () => {
    const def = walk(yesNoQ(), stepsQ({ showIf: { n: 1, is: [7] } }));
    expect(validateTemplate(def).join(' ')).toMatch(/not in question 1/);
  });

  test('a question that waits on nothing in particular is a dead end', () => {
    const def = walk(yesNoQ(), stepsQ({ showIf: { n: 1, is: [] } }));
    expect(validateTemplate(def).join(' ')).toMatch(/which answer/);
  });

  test('a compared question must point at a video above it', () => {
    const def = walk(stepsQ({ compareTo: 1 }), clipQ());
    expect(validateTemplate(def).join(' ')).toMatch(/video question above it/);
  });

  test('a yes/no checked against a video must say which answer means all done', () => {
    const def = walk(clipQ(), yesNoQ({ compareTo: 1 }), stepsQ({ compareTo: 1 }));
    expect(validateTemplate(def).join(' ')).toMatch(/every step was done/);
  });

  test('a yes/no checked against a video needs the step list somewhere', () => {
    const def = walk(clipQ(), yesNoQ({ allDone: 0, compareTo: 1 }));
    expect(validateTemplate(def).join(' ')).toMatch(/pick-all question with the steps/);
  });

  test('a video has to be a length worth reading', () => {
    expect(validateTemplate(walk(clipQ({ maxSeconds: 4 }))).join(' ')).toMatch(/10 and 180/);
    expect(validateTemplate(walk(clipQ({ maxSeconds: 600 }))).join(' ')).toMatch(/10 and 180/);
  });
});

describe('cleanTemplate: branching', () => {
  test('a branch and a comparison survive a save', () => {
    const [, yes, steps] = cleanTemplate(sound()).questions;
    expect(yes.compareTo).toBe(1);
    expect(yes.allDone).toBe(0);
    expect(steps.showIf).toEqual({ n: 2, is: [1] });
    expect(steps.compareTo).toBe(1);
  });

  test('neither a branch nor a comparison can carry points', () => {
    // Otherwise two people are marked out of different totals: one of them
    // saw the branch and one of them never did.
    const def = walk(
      clipQ(),
      yesNoQ({ allDone: 0, compareTo: 1, points: 5 }),
      stepsQ({ showIf: { n: 2, is: [1] }, points: 9 }),
    );
    const [, yes, steps] = cleanTemplate(def).questions;
    expect(yes.points).toBe(0);
    expect(steps.points).toBe(0);
    expect(maxScore(cleanTemplate(def))).toBe(0);
  });
});

describe('visible', () => {
  const def = cleanTemplate(sound());
  const steps = def.questions[2];

  test('a question with no condition is always asked', () => {
    expect(visible(def.questions[0], {})).toBe(true);
  });

  test('the step list is asked of somebody who said something was missed', () => {
    expect(visible(steps, { 2: [1] })).toBe(true);
    expect(visible(steps, { 2: 1 })).toBe(true);        // a one-answer pick arrives bare
  });

  test('it is not asked of somebody who said it was all done', () => {
    expect(visible(steps, { 2: [0] })).toBe(false);
  });

  test('it is not asked before the question it waits on is answered', () => {
    expect(visible(steps, {})).toBe(false);
  });
});

describe('missingAnswers', () => {
  const def = cleanTemplate(sound());

  test('a question nobody was shown is not missing', () => {
    // They said it was all done, so the step list never came up. Demanding an
    // answer to it is how a walk gets stuck on a question that is not there.
    const missing = missingAnswers(def, { 2: [0] }, { 1: ['frame.jpg'] });
    expect(missing.map(m => m.n)).not.toContain(3);
  });

  test('a question they were shown is missing when unanswered', () => {
    const missing = missingAnswers(def, { 2: [1] }, { 1: ['frame.jpg'] });
    expect(missing.map(m => m.n)).toContain(3);
  });

  test('a video question needs a video, and says so', () => {
    const missing = missingAnswers(def, { 2: [0] }, {});
    expect(missing.find(m => m.n === 1).message).toMatch(/needs a video/);
  });

  test('a video the phone could not read is not missing', () => {
    // They recorded it; the stills are what failed. Sending the walk back as
    // unfinished leaves them on a question they can never get past.
    const missing = missingAnswers(def, { 2: [0] }, {}, { 1: 'would not play' });
    expect(missing.map(m => m.n)).not.toContain(1);
  });
});

describe('grade', () => {
  test('nothing checked against a video reaches the score', () => {
    const def = cleanTemplate(sound());
    const out = grade(def, { 2: [1], 3: [0, 1] });
    expect(out.maxScore).toBe(0);
    expect(out.results).toEqual([]);
  });
});

describe('a reading of the frames', () => {
  const three = ['Soap', 'Twenty seconds', 'Paper towel'];

  test('reads the JSON a model sends back', () => {
    const out = shape(`{"seconds": 24, "steps": [
      {"i": 0, "done": true, "at": 6, "note": "Soap at the dispenser."},
      {"i": 1, "done": false, "at": null, "note": "About eleven seconds."},
      {"i": 2, "done": true, "at": 21, "note": "Paper towel."}]}`, 3);
    expect(out.seconds).toBe(24);
    expect(out.steps.map(s => s.done)).toEqual([true, false, true]);
    expect(out.steps[0].at).toBe(6);
    expect(out.steps[1].at).toBeNull();
  });

  test('a sentence wrapped around the JSON does not throw it away', () => {
    const out = shape('Here you go:\n{"seconds": 30, "steps": [{"i":0,"done":false}]}\nHope that helps.', 1);
    expect(out.seconds).toBe(30);
    expect(out.steps[0].done).toBe(false);
  });

  test('a step the model did not mention is unknown, neither done nor missed', () => {
    // It used to read as done, which told somebody their wash was clean on the
    // strength of a reply that said nothing about it. Saying it was missed
    // would be the same mistake pointed the other way. Neither: unknown.
    const out = shape('{"seconds": 25, "steps": [{"i":0,"done":false,"note":"no soap"}]}', three.length);
    expect(out.steps).toHaveLength(3);
    expect(out.steps.map(s => s.done)).toEqual([false, null, null]);
    expect(out.steps[2].note).toBe('');
  });

  test('a length that makes no sense is no length at all', () => {
    expect(shape('{"seconds": "ages", "steps": []}', 1).seconds).toBeNull();
    expect(shape('{"steps": []}', 1).seconds).toBeNull();
  });

  test('a reply with no JSON in it is an error, not an empty reading', () => {
    expect(() => shape('I cannot see the pictures.', 3)).toThrow();
  });
});

describe('their reading against mine', () => {
  const steps = ['Soap', 'Twenty seconds', 'Paper towel'];
  const list = { type: 'multi', compareTo: 1 };
  const yesNo = { type: 'single', compareTo: 1, allDone: 0 };

  // Soap done at 6s, the twenty seconds missed, the towel done at 21s.
  const reading = {
    seconds: 24,
    steps: [
      { i: 0, done: true,  at: 6,    note: 'Soap at the dispenser.' },
      { i: 1, done: false, at: null, note: 'About eleven seconds.' },
      { i: 2, done: true,  at: 21,   note: 'Paper towel.' },
    ],
  };

  test('the step list: ticking the one I also saw missed is agreement', () => {
    const out = compare(list, steps, [1], reading);
    expect(out.steps.map(s => s.agreed)).toEqual([true, true, true]);
    expect(out.seconds).toBe(24);
  });

  test('a step they ticked and I saw happen is a disagreement, with the second', () => {
    const out = compare(list, steps, [0, 1], reading);
    expect(out.steps[0].agreed).toBe(false);
    expect(out.steps[0].note).toMatch(/at 6s/);
    expect(out.steps[0].at).toBe(6);
  });

  test('a step I saw missed and they did not tick is a disagreement too', () => {
    const out = compare(list, steps, [], reading);
    expect(out.steps.map(s => s.agreed)).toEqual([true, false, true]);
    expect(out.steps[1].note).toMatch(/did not see it happen/);
  });

  test('the yes/no: saying it was all done when I saw a miss is the case that matters', () => {
    const out = compare(yesNo, steps, [0], reading);
    expect(out.overall).toBe(true);
    expect(out.agreed).toBe(false);
    expect(out.steps.map(s => s.text)).toEqual(['Twenty seconds']);
  });

  test('the yes/no: saying something was missed when I saw one too is agreement', () => {
    expect(compare(yesNo, steps, [1], reading).agreed).toBe(true);
  });

  test('the yes/no: a clean wash both of us read as clean', () => {
    const clean = { seconds: 25, steps: steps.map((_, i) => ({ i, done: true, at: i * 5, note: '' })) };
    const out = compare(yesNo, steps, [0], clean);
    expect(out.agreed).toBe(true);
    expect(out.steps).toEqual([]);
  });

  test('the yes/no: saying a step was missed when I saw none is a disagreement', () => {
    const clean = { seconds: 25, steps: steps.map((_, i) => ({ i, done: true, at: i * 5, note: '' })) };
    expect(compare(yesNo, steps, [1], clean).agreed).toBe(false);
  });

  test('no reading says so rather than marking them against nothing', () => {
    const out = compare(list, steps, [1], null);
    expect(out.unread).toMatch(/did not manage to read/);
    expect(out.steps).toBeUndefined();
  });

  test('a reading of a different step list is not a reading of this one', () => {
    // The template was edited between the clip going up and this answer, so
    // lining the two lists up by position would compare the wrong steps.
    const out = compare(list, steps, [1], { seconds: 24, steps: reading.steps.slice(0, 2) });
    expect(out.unread).toMatch(/questions changed/);
  });

  test('an unanswered question does not read as "nothing was missed"', () => {
    const out = compare(list, steps, undefined, reading);
    expect(out.steps[1].agreed).toBe(false);
  });
});

// The review at the end is built from every compared question the walker was
// actually shown. Somebody who said every step was done never sees the list,
// so their review has to come off the yes/no alone — and must not include a
// pick-all they were never asked, which would read as "you ticked nothing".
describe('which questions the end-of-walk review is built from', () => {
  const live = cleanTemplate(JSON.parse(
    require('fs').readFileSync('data/audits/handwashing-video.json', 'utf8')));

  const compared = answers => live.questions
    .filter(q => q.compareTo && visible(q, answers))
    .map(q => q.n);

  test('saying something was missed brings the list into the review', () => {
    expect(compared({ 4: 1 })).toEqual([4, 5]);
  });

  test('saying every step was done leaves the list out of it', () => {
    expect(compared({ 4: 0 })).toEqual([4]);
  });

  test('the scored half of the walk is never part of the review', () => {
    // Six points of written questions sit after the video. None of them is
    // compared against it, so none of them can turn up in the side-by-side.
    expect(compared({ 4: 1 }).every(n => n <= 5)).toBe(true);
    expect(maxScore(live)).toBe(6);
  });

  // Two questions point at the video: the yes/no and the list of steps. The
  // reading has to be made against the list. It used to take whichever came
  // first, which is the yes/no, so the video was read against "Yes, every
  // step" and "No, something was missed" as though those were the steps of a
  // hand wash — and then the comparison, which does pick the list, found a
  // reading two entries long where it wanted eight and told the walker the
  // questions had changed under them.
  describe('which list a video is read against', () => {
    const vid = live.questions.find(q => q.type === 'video');

    const pickedBy = fn => {
      const asked = live.questions.find(x => fn(x));
      return ((asked && asked.choices) || []).length;
    };

    test('the step list is what gets read, not the yes/no in front of it', () => {
      expect(pickedBy(x => x.type === 'multi' && Number(x.compareTo) === vid.n)).toBe(8);
    });

    test('the two questions that point at the video are the yes/no and the list', () => {
      const pointing = live.questions.filter(x => Number(x.compareTo) === vid.n);
      expect(pointing.map(q => q.type)).toEqual(['single', 'multi']);
      // The yes/no comes first, which is exactly why picking by compareTo
      // alone took the wrong one.
      expect(pointing[0].choices).toHaveLength(2);
    });

    test('the reading and the comparison measure the same list', () => {
      const read = live.questions.find(x => x.type === 'multi' && Number(x.compareTo) === vid.n);
      const shown = live.questions.find(x => x.type === 'multi' && Number(x.compareTo) === Number(vid.n));
      expect(read.choices).toEqual(shown.choices);
      // A reading of that length lines up; the old two-entry one did not.
      const reading = { seconds: 20, steps: read.choices.map((_, i) => ({ i, done: true, at: i, note: '' })) };
      expect(compare({ type: 'multi' }, shown.choices, [], reading).unread).toBeUndefined();
      const short = { seconds: 20, steps: [{ i: 0, done: true, at: 0, note: '' }, { i: 1, done: true, at: 1, note: '' }] };
      expect(compare({ type: 'multi' }, shown.choices, [], short).unread).toMatch(/questions changed/i);
    });
  });
});
