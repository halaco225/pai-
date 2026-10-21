// parseDraft is the one place a model's reply is turned into something the
// template editor will load. Everything else in services/pai-agent.js is a
// prompt; this is the part that can be wrong on good input.
//
// The drafts a model actually returns are checked against the real validator,
// because a draft that parses but fails validateTemplate() is the failure the
// user would see as an editor full of red.

const { parseDraft } = require('../services/pai-agent');
const { validateTemplate } = require('../services/audit-templates');

const DRAFT = {
  title: 'Food Safety Walk',
  description: 'Walk your store while you complete this.',
  questions: [
    { n: 1, title: 'Your first and last name', type: 'text', points: 0, required: true },
    { n: 2, title: 'Your store number', type: 'text', points: 0, required: true },
    { n: 3, title: 'Walk-in cooler temperature', type: 'number', points: 0, min: 0, max: 60, unit: '°F' },
    { n: 4, title: 'Photograph the temperature log', type: 'photo', points: 0 },
  ],
};

const json = JSON.stringify(DRAFT, null, 2);

describe('parseDraft', () => {
  test('reads a bare JSON object', () => {
    expect(parseDraft(json).title).toBe('Food Safety Walk');
  });

  test('reads it out of a ```json fence', () => {
    expect(parseDraft('```json\n' + json + '\n```').questions).toHaveLength(4);
  });

  test('reads it out of an unlabelled fence', () => {
    expect(parseDraft('```\n' + json + '\n```').title).toBe('Food Safety Walk');
  });

  test('survives a sentence before and after the object', () => {
    const chatty = `Here is the audit you asked for:\n\n${json}\n\nLet me know if you want more questions.`;
    expect(parseDraft(chatty).questions).toHaveLength(4);
  });

  test('keeps a brace that is inside a question title', () => {
    const tricky = JSON.stringify({
      title: 'Odd one',
      questions: [{ n: 1, title: 'Is the {walk-in} door sealing?', type: 'text', points: 0 }],
    });
    expect(parseDraft(tricky).questions[0].title).toBe('Is the {walk-in} door sealing?');
  });

  test('refuses prose with no object in it', () => {
    expect(() => parseDraft('I cannot build that audit.')).toThrow(/unreadable/i);
  });

  test('refuses broken JSON', () => {
    expect(() => parseDraft('{"title":"x","questions":[')).toThrow(/unreadable/i);
  });

  test('refuses an object with no questions', () => {
    expect(() => parseDraft('{"title":"Empty","questions":[]}')).toThrow(/no questions/i);
  });

  test('refuses an object whose questions are not a list', () => {
    expect(() => parseDraft('{"title":"Bad","questions":"lots"}')).toThrow(/no questions/i);
  });

  test('refuses an empty reply', () => {
    expect(() => parseDraft('')).toThrow();
  });

  // The validator reads a bare number as "nothing marked", so left alone this
  // would put a red error on every scored question of a good draft.
  test('wraps a bare "correct" index in an array', () => {
    const def = parseDraft(JSON.stringify({
      title: 'Scored', questions: [
        { n: 1, title: 'Is it cold enough?', type: 'single', choices: ['Yes', 'No'], correct: 0, points: 2 },
      ],
    }));
    expect(def.questions[0].correct).toEqual([0]);
  });

  test('leaves an array of indexes alone', () => {
    const def = parseDraft(JSON.stringify({
      title: 'Scored', questions: [
        { n: 1, title: 'Which are wrong?', type: 'multi', choices: ['a', 'b', 'c'], correct: [0, 2], points: 2 },
      ],
    }));
    expect(def.questions[0].correct).toEqual([0, 2]);
  });
});

// The route sets id, version and kind on the draft before validating with a
// placeholder id, so a draft shaped like the prompt asks for should come back
// with nothing to fix.
describe('a draft the prompt describes passes the real validator', () => {
  test('an unscored audit has no problems', () => {
    const def = { ...parseDraft(json), id: 'draft', version: 0, kind: 'audit', coach: 'none' };
    expect(validateTemplate(def)).toEqual([]);
  });

  test('a scored test with points and answers has no problems', () => {
    const def = {
      id: 'draft', version: 0, kind: 'test', coach: 'adam',
      title: 'Food Safety Test',
      description: 'Answer from what you can see in the store.',
      questions: [
        { n: 1, title: 'Your first and last name', type: 'text', points: 0, required: true },
        { n: 2, title: 'Your store number', type: 'text', points: 0, required: true },
        { n: 3, title: 'Is the walk-in at or below 41°F?', type: 'single', variant: 'yesno',
          choices: ['Yes', 'No'], correct: [0], points: 2,
          explanation: 'Above 41°F is a hold-and-correct.' },
      ],
    };
    expect(validateTemplate(def)).toEqual([]);
  });

  test('the validator still catches a question type the model invented', () => {
    const def = {
      id: 'draft', version: 0, kind: 'audit', coach: 'none',
      title: 'Bad types', description: '',
      questions: [{ n: 1, title: 'Rate the lobby', type: 'starrating', points: 0 }],
    };
    expect(validateTemplate(def).join(' ')).toMatch(/question type/i);
  });
});
