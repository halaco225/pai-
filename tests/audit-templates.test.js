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
    expect(problems).toContain('Question 2: mark which answer is right, or set it to 0 points.');
  });

  // The dangerous one: an index past the end of the list would make the
  // question impossible to get right, and nobody would see why.
  test('rejects a right answer that points at nothing', () => {
    const def = ok(); def.questions[1].correct = [5];
    expect(validateTemplate(def))
      .toContain('Question 2: the right answer points at an answer that is not there.');
  });

  // This used to be refused. Some questions genuinely have two right
  // answers and no favourite — temping wings before saucing them and
  // binning them for a fresh drop are both correct — and marking one of
  // them wrong teaches the opposite of the point. The walker still picks
  // one; services/audits.js gives the points for any marked answer.
  test('a one-answer question may mark more than one answer acceptable', () => {
    const def = ok(); def.questions[1].correct = [0, 1];
    expect(validateTemplate(def)).toEqual([]);
  });

  test('those answers still have to exist', () => {
    const def = ok(); def.questions[1].correct = [0, 9];
    expect(validateTemplate(def))
      .toContain('Question 2: the right answer points at an answer that is not there.');
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

// Not every audit is a quiz. "Did the order include a dip?" has no right
// answer — it records what the customer got.
describe('questions that are not scored', () => {
  const { isScored, grade, maxScore } = require('../services/audits');

  const observation = {
    id: 'cheesy', title: 'Cheesy Bites', description: '',
    questions: [
      { n: 1, title: 'Your name', type: 'text', points: 0, required: true },
      { n: 2, title: 'Did it include a dip?', type: 'single', points: 0,
        choices: ['Yes', 'No', 'Not applicable'], correct: [], explanation: '', required: true },
      { n: 3, title: 'Rate it out of 10', type: 'single', points: 0,
        choices: ['1','2','3','4','5','6','7','8','9','10'], correct: [], explanation: '', required: true },
    ],
  };

  test('a choice question worth nothing with no right answer is allowed', () => {
    expect(validateTemplate(observation)).toEqual([]);
  });

  test('it is never marked', () => {
    expect(isScored(observation.questions[1])).toBe(false);
    const result = grade(observation, { 2: [1], 3: [3] });
    expect(result.results).toEqual([]);
    expect(result.score).toBe(0);
    expect(maxScore(observation)).toBe(0);
  });

  // The guard that keeps a real quiz honest: points without a right answer
  // would be a question nobody can pass.
  test('but points without a right answer is still refused', () => {
    const scored = JSON.parse(JSON.stringify(observation));
    scored.questions[1].points = 5;
    expect(validateTemplate(scored))
      .toContain('Question 2: mark which answer is right, or set it to 0 points.');
  });

  test('and a scored question still has to be answerable', () => {
    const scored = JSON.parse(JSON.stringify(observation));
    scored.questions[1].points = 5;
    scored.questions[1].correct = [0];
    expect(validateTemplate(scored)).toEqual([]);
    expect(isScored(scored.questions[1])).toBe(true);
  });
});

// A picture used to survive only on the two types where you tap it. Everywhere
// else the editor would accept an image, drop it on save, and the walker would
// get a question about a photograph it could not see. `video` was already a
// field any question could carry; this is the same idea for stills.
describe('a picture on an ordinary question', () => {
  const { publicForm } = require('../services/audits');

  const withPicture = () => ({
    id: 'mitt', title: 'Food Safety Mitt', description: '',
    questions: [
      { title: 'Where is the mitt now?', type: 'single', points: 5, required: true,
        image: '/audits/pepper-step-5-drop.webp',
        choices: ['Still on her hand', 'In the bin with the bag'],
        correct: [1], explanation: 'It goes in the bin with the bag.' },
    ],
  });

  test('survives a save', () => {
    const clean = cleanTemplate(withPicture());
    expect(clean.questions[0].image).toBe('/audits/pepper-step-5-drop.webp');
  });

  test('reaches the walker', () => {
    const form = publicForm(cleanTemplate(withPicture()));
    expect(form.questions[0].image).toBe('/audits/pepper-step-5-drop.webp');
  });

  test('but the answer key does not travel with it', () => {
    const form = publicForm(cleanTemplate(withPicture()));
    expect(form.questions[0].correct).toBeUndefined();
    expect(form.questions[0].explanation).toBeUndefined();
  });

  test('a question with no picture gains no empty one', () => {
    const def = withPicture();
    delete def.questions[0].image;
    expect(cleanTemplate(def).questions[0].image).toBeUndefined();
  });
});
