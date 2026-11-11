/**
 * The third answer: "I could not tell".
 *
 * A reading used to have two states, and anything that was not a plain "no"
 * became a yes. So a model that said "cannot tell, no hands visible" marked
 * the step done, and the walker was told the two of them had seen the same
 * perfect wash on a video of the ceiling. These are the cases that stop that.
 */
const { shape, compare, frameSecond } = require('../services/audit-video');

describe('which second a still came from', () => {
  test('a whole second and a half second', () => {
    expect(frameSecond('t014.jpg')).toBe(14);
    expect(frameSecond('t014_5.jpg')).toBe(14.5);
    expect(frameSecond('t000.jpg')).toBe(0);
    expect(frameSecond('t000_5.jpg')).toBe(0.5);
  });

  test('the strip reads in the order it was filmed', () => {
    // Whatever order the phone's JPEG encoder finished them in, the second is
    // what puts them back in order — on the phone before they go, and here
    // again before they are read.
    const names = ['t010.jpg', 't009_5.jpg', 't000.jpg', 't009.jpg', 't010_5.jpg'];
    expect([...names].sort((a, b) => frameSecond(a) - frameSecond(b)))
      .toEqual(['t000.jpg', 't009.jpg', 't009_5.jpg', 't010.jpg', 't010_5.jpg']);
  });

  test('anything named some other way has no second', () => {
    for (const name of ['IMG_8531.jpg', 'frame.jpg', '', null, 'tXX.jpg']) {
      expect(Number.isFinite(frameSecond(name))).toBe(false);
    }
  });
});

const reply = steps => JSON.stringify({ seconds: 20, steps });

describe('reading a step three ways', () => {
  test('seen, not seen and could not tell each survive the shaping', () => {
    const got = shape(reply([
      { i: 0, done: true,  at: 3, note: 'Soap went on.' },
      { i: 1, done: false, at: null, note: 'No paper towel.' },
      { i: 2, done: null,  at: null, note: 'Hands out of shot.' },
    ]), 3);
    expect(got.steps.map(s => s.done)).toEqual([true, false, null]);
  });

  test('a step the reply never mentions is unknown, not done', () => {
    const got = shape(reply([{ i: 0, done: true, at: 1, note: 'Saw it.' }]), 3);
    expect(got.steps.map(s => s.done)).toEqual([true, null, null]);
  });

  test('anything that is not plainly true or false is unknown', () => {
    const got = shape(reply([
      { i: 0, done: 'yes',  note: '' },
      { i: 1, done: 1,      note: '' },
      { i: 2, done: 'true', note: '' },
    ]), 3);
    expect(got.steps.map(s => s.done)).toEqual([null, null, null]);
  });
});

describe('what the walker is shown', () => {
  const choices = ['Wet their hands', 'Used soap', 'Dried on a paper towel'];
  const reading = { seconds: 20, steps: [
    { i: 0, done: true,  at: 2, note: 'Water on.' },
    { i: 1, done: null,  at: null, note: 'Could not see the soap.' },
    { i: 2, done: false, at: null, note: 'Wiped on the apron.' },
  ] };

  test('a step nobody could see is neither agreed nor disagreed', () => {
    const out = compare({ type: 'multi' }, choices, [2], reading);
    expect(out.steps[1]).toMatchObject({ unsure: true, agreed: null });
    expect(out.steps[1].note).toMatch(/could not see the soap/i);
  });

  test('the other two steps are still judged normally', () => {
    const out = compare({ type: 'multi' }, choices, [2], reading);
    expect(out.steps[0].agreed).toBe(true);     // neither of us marked it missed
    expect(out.steps[2].agreed).toBe(true);     // both of us did
    expect(out.steps[0].unsure).toBeUndefined();
  });

  test('ticking a step I could not see is not turned into a disagreement', () => {
    const out = compare({ type: 'multi' }, choices, [1], reading);
    expect(out.steps[1].agreed).toBeNull();
    expect(out.steps[1].note).toMatch(/you had it as missed/i);
  });

  test('the steps that were never in shot come back by name', () => {
    // A walker told "2 of the steps" can do nothing with that. Told which
    // two, they know what to hold the phone on next time.
    const out = compare({ type: 'single', allDone: 0 }, choices, [0], reading);
    expect(out.unsureSteps).toEqual(['Used soap']);
  });

  test('the yes/no carries how many steps were never in shot', () => {
    // They picked "No — something was missed", and so did I: that is agreement
    // on the yes/no, and the count of what I could not see rides alongside it
    // rather than changing it.
    const out = compare({ type: 'single', allDone: 0 }, choices, [1], reading);
    expect(out.unsure).toBe(1);
    expect(out.agreed).toBe(true);
  });

  test('saying every step was done still loses to a step I saw skipped', () => {
    const out = compare({ type: 'single', allDone: 0 }, choices, [0], reading);
    expect(out.agreed).toBe(false);
    expect(out.steps).toHaveLength(1);          // the one I watched them skip
    expect(out.unsure).toBe(1);
  });

  test('a clean reading reports nothing unseen', () => {
    const seen = { seconds: 20, steps: choices.map((_, i) => ({ i, done: true, at: i, note: '' })) };
    const out = compare({ type: 'single', allDone: 0 }, choices, [0], seen);
    expect(out.unsure).toBe(0);
    expect(out.agreed).toBe(true);
  });

  test('a reading that saw nothing at all agrees with nobody', () => {
    const blind = { seconds: 11, steps: choices.map((_, i) => ({ i, done: null, at: null, note: 'Cannot tell.' })) };
    const out = compare({ type: 'single', allDone: 0 }, choices, [0], blind);
    expect(out.unsure).toBe(3);
    expect(out.steps).toEqual([]);              // nothing I can say was missed
    const detail = compare({ type: 'multi' }, choices, [], blind);
    expect(detail.steps.every(s => s.unsure)).toBe(true);
  });
});
