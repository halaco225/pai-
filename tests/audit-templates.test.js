// The editor is behind the login, but a saved template decides what every
// store is asked and how it is scored, so what comes back from the browser is
// checked rather than trusted. These are the boundaries that checking draws.

const { validateTemplate, cleanTemplate } = require('../services/audit-templates');
const { grade, maxScore } = require('../services/audits');

const ok = () => ({
  id: 'kitchen-walk',
  title: 'Kitchen walk',
  description: 'Walk the back.',
  questions: [
    { title: 'Your name', type: 'text', points: 0, required: true },
    { title: 'Is the hood clean?', type: 'single', points: 3, required: true,
      choices: ['Yes', 'No'], correct: [0], explanation: 'Hoods get checked.' },
  ],
});

describe('validateTemplate', () => {
  test('accepts a sound template', () => {
    expect(validateTemplate(ok())).toEqual([]);
  });

  test('rejects a link name that is not url-safe', () => {
    const def = ok(); def.id = 'Kitchen Walk!';
    expect(validateTemplate(def)[0]).toMatch(/lowercase letters, numbers and dashes/);
  });

  test('wants a title', () => {
    const def = ok(); def.title = '  ';
    expect(validateTemplate(def)).toContain('Give the audit a title.');
  });

  test('wants at least one question', () => {
    const def = ok(); def.questions = [];
    expect(validateTemplate(def)).toContain('Add at least one question.');
  });

  test('a multiple-choice question needs two answers and a right one', () => {
    const def = ok();
    def.questions[1].choices = ['Only one'];
    def.questions[1].correct = [];
    const problems = validateTemplate(def);
    expect(problems).toContain('Question 2: needs at least two answers to choose from.');
    expect(problems).toContain('Question 2: mark which answer is right.');
  });

  // The dangerous one: an index past the end of the list would make the
  // question impossible to get right, and nobody would see why.
  test('rejects a right answer that points at nothing', () => {
    const def = ok(); def.questions[1].correct = [5];
    expect(validateTemplate(def))
      .toContain('Question 2: the right answer points at an answer that is not there.');
  });

  test('a one-answer question cannot have two right answers', () => {
    const def = ok(); def.questions[1].correct = [0, 1];
    expect(validateTemplate(def))
      .toContain('Question 2: a one-answer question can only have one right answer.');
  });

  test('only a scored question can carry points', () => {
    const def = ok(); def.questions[0].points = 5;
    expect(validateTemplate(def))
      .toContain('Question 1: only scored questions can be worth points.');
  });

  test('points must be a sane whole number', () => {
    const def = ok(); def.questions[1].points = 2.5;
    expect(validateTemplate(def)[0]).toMatch(/whole number/);
  });

  test('a picture question allows between one and ten', () => {
    const def = ok();
    def.questions.push({ title: 'Photo', type: 'photo', points: 0, maxPhotos: 99 });
    expect(validateTemplate(def)).toContain('Question 3: allow between 1 and 10 pictures.');
  });

  test('nothing at all is a problem, not a crash', () => {
    expect(validateTemplate(null)).toEqual(['There is nothing to save.']);
    expect(validateTemplate({ id: 'x', title: 'X' })).toContain('The questions are missing.');
  });
});

describe('cleanTemplate', () => {
  test('numbers questions by the order they appear', () => {
    const clean = cleanTemplate(ok());
    expect(clean.questions.map(q => q.n)).toEqual([1, 2]);
  });

  test('renumbers after a question is moved', () => {
    const def = ok();
    def.questions.reverse();
    expect(cleanTemplate(def).questions.map(q => q.type)).toEqual(['single', 'text']);
    expect(cleanTemplate(def).questions.map(q => q.n)).toEqual([1, 2]);
  });

  test('strips points and choices off a question that is no longer scored', () => {
    const def = ok();
    def.questions[1].type = 'longtext';
    const q = cleanTemplate(def).questions[1];
    expect(q.points).toBe(0);
    expect(q.choices).toBeUndefined();
    expect(q.correct).toBeUndefined();
  });

  test('de-duplicates and sorts the right answers', () => {
    const def = ok();
    def.questions[1].choices = ['a', 'b', 'c'];
    def.questions[1].correct = [2, 0, 2];
    expect(cleanTemplate(def).questions[1].correct).toEqual([0, 2]);
  });

  test('the cleaned template grades the way the editor showed it', () => {
    const def = cleanTemplate(ok());
    expect(maxScore(def)).toBe(3);
    expect(grade(def, { 2: [0] }).score).toBe(3);
    expect(grade(def, { 2: [1] }).score).toBe(0);
  });
});
