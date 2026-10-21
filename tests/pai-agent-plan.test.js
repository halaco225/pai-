// The asking pass, and the answers it produces.
//
// planTemplate's own prompt is only checkable against the live API, so what
// is tested here is everything around it that decides whether a draft comes
// out usable: the JSON recovery it shares with the drafting pass, and the
// normalising the route does to answers that arrive as form strings.

const { parseJsonObject, MAX_THEMES } = require('../services/pai-agent');

describe('parseJsonObject', () => {
  const FAIL = 'could not read that';

  test('reads a bare object', () => {
    expect(parseJsonObject('{"found":"x","themes":[]}', FAIL).found).toBe('x');
  });

  test('reads it out of a ```json fence', () => {
    expect(parseJsonObject('```json\n{"found":"y"}\n```', FAIL).found).toBe('y');
  });

  test('survives a sentence in front of it', () => {
    expect(parseJsonObject('Here you go:\n\n{"found":"z"}', FAIL).found).toBe('z');
  });

  test('refuses an array', () => {
    expect(() => parseJsonObject('[1,2,3]', FAIL)).toThrow(FAIL);
  });

  test('refuses prose', () => {
    expect(() => parseJsonObject('I could not read those files.', FAIL)).toThrow(FAIL);
  });

  test('refuses broken JSON', () => {
    expect(() => parseJsonObject('{"found":', FAIL)).toThrow(FAIL);
  });

  test('uses the caller\'s wording, so each pass can say its own thing', () => {
    expect(() => parseJsonObject('nope', 'files unreadable')).toThrow('files unreadable');
  });
});

// Mirrors readAnswers() in routes/audits.js. Everything arrives as a string
// from a multipart form, and a type the editor cannot render is a question
// nobody can answer, so the filtering is the part that matters.
const ANSWERABLE_TYPES = new Set(['text', 'longtext', 'single', 'multi', 'number',
                                  'scale', 'datetime', 'photo', 'order']);
const MAX_DRAFT_QUESTIONS = 40;

function readAnswers(body) {
  const list = v => {
    if (Array.isArray(v)) return v;
    const s = String(v || '').trim();
    if (!s) return [];
    if (s.startsWith('[')) { try { return JSON.parse(s); } catch { return []; } }
    return s.split(',').map(x => x.trim()).filter(Boolean);
  };
  const count = Number(body?.count);
  return {
    count: Number.isInteger(count) && count > 0 && count <= MAX_DRAFT_QUESTIONS ? count : null,
    types: list(body?.types).map(String).filter(t => ANSWERABLE_TYPES.has(t)),
    focus: list(body?.focus).map(s => String(s).slice(0, 160)).slice(0, 12),
    notes: String(body?.notes || '').trim().slice(0, 1000) || null,
  };
}

describe('readAnswers', () => {
  test('reads what the Create form actually sends', () => {
    expect(readAnswers({
      count: '15',
      types: '["single","photo","number"]',
      focus: '["Walk-in cooler temperatures","Date labelling"]',
      notes: '  Keep them answerable while walking.  ',
    })).toEqual({
      count: 15,
      types: ['single', 'photo', 'number'],
      focus: ['Walk-in cooler temperatures', 'Date labelling'],
      notes: 'Keep them answerable while walking.',
    });
  });

  test('accepts a plain comma list too', () => {
    expect(readAnswers({ types: 'single, photo' }).types).toEqual(['single', 'photo']);
  });

  test('drops a question type the editor cannot render', () => {
    // hotspot and the picture types need an image with coordinates on it.
    expect(readAnswers({ types: '["single","hotspot","assign","photo"]' }).types)
      .toEqual(['single', 'photo']);
  });

  test('ignores a count that is not a sane number of questions', () => {
    for (const bad of ['0', '-3', '500', 'lots', '', '7.5']) {
      expect(readAnswers({ count: bad }).count).toBeNull();
    }
    expect(readAnswers({ count: '25' }).count).toBe(25);
  });

  test('caps the focus list and the length of each entry', () => {
    const many = Array.from({ length: 30 }, (_, i) => `theme ${i}`);
    expect(readAnswers({ focus: JSON.stringify(many) }).focus).toHaveLength(12);
    expect(readAnswers({ focus: JSON.stringify(['x'.repeat(500)]) }).focus[0]).toHaveLength(160);
  });

  test('caps notes rather than passing a wall of text to the model', () => {
    expect(readAnswers({ notes: 'y'.repeat(5000) }).notes).toHaveLength(1000);
  });

  test('an empty form is all nulls and empties, not a crash', () => {
    expect(readAnswers({})).toEqual({ count: null, types: [], focus: [], notes: null });
    expect(readAnswers(undefined)).toEqual({ count: null, types: [], focus: [], notes: null });
  });

  test('survives malformed JSON in a list field', () => {
    expect(readAnswers({ types: '["single"' }).types).toEqual([]);
  });
});

test('the themes offered stay a short enough list to tick through', () => {
  expect(MAX_THEMES).toBeLessThanOrEqual(10);
});
