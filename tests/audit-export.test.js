// The RSC questionnaire and the workbook it exports.
//
// The questionnaire is unscored and anonymous, which is where both halves of
// the old export fell over: grade() returns no results for a question worth
// nothing, so the answer columns came back empty, and the sheet carried a
// name and a store column for a form that asks for neither.

const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

const { cleanTemplate, validateTemplate } = require('../services/audit-templates');
const { whoAndWhere } = require('../services/audits');
const { buildWorkbook } = require('../services/audit-export');

const def = cleanTemplate(JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'data', 'audits', 'rsc-alignment.json'), 'utf8')));

describe('the RSC alignment questionnaire', () => {
  test('is a valid template with nobody walking it through', () => {
    expect(validateTemplate(def)).toEqual([]);
    expect(def.coach).toBe('none');
    expect(def.kind).toBe('audit');
  });

  test('is not a test — nothing in it is scored', () => {
    expect(def.questions.every(q => Number(q.points) === 0)).toBe(true);
  });

  test('asks for nothing that says who answered it', () => {
    // Including the fallback: it opens with a choice, not a text box, so
    // there is nothing for /submit to file a name or a store under.
    expect(whoAndWhere(def)).toEqual({ nameQ: null, storeQ: null });
    expect(def.questions.some(q => /position|store|name|which store/i.test(q.title)))
      .toBe(false);
  });

  test('carries the whole paper form, flattened', () => {
    expect(def.questions.filter(q =>
      q.title.includes('How often do you work with this function?'))).toHaveLength(8);
    expect(def.questions.filter(q =>
      (q.choices || []).includes('5 — Strongly agree'))).toHaveLength(54);
    expect(def.questions.filter(q =>
      (q.choices || []).includes('10 — Extremely satisfied'))).toHaveLength(9);
    expect(def.questions).toHaveLength(87);
  });

  test('every statement block but Legal waits on how often they work with it', () => {
    const gated = def.questions.filter(q => q.showIf && (q.choices || []).includes('N/A'));
    expect(gated).toHaveLength(48);               // 8 functions, 6 statements each
    for (const q of gated) {
      const on = def.questions[q.showIf.n - 1];
      expect(on.title).toContain('How often');
      expect(q.showIf.is).toEqual([0, 1, 2, 3]);  // anything but Never
    }
  });

  test('the conflicting-answers follow-ups only come up if there were any', () => {
    for (const n of [72, 74]) {
      expect(def.questions[n - 1].showIf).toEqual({ n: 71, is: [1, 2, 3] });
    }
  });
});

// Answers are keyed by question number. HR is Q1 (frequency) and Q9–Q14
// (statements); Facilities is Q5 and Q33–Q38; Legal is Q45–Q50; HR
// satisfaction is Q77 and the RSC overall score is Q85.
const row = (id, answers, at) => ({
  id, created_at: at, respondent_name: 'Anonymous', store_number: '',
  answers, photos: {}, score: 0, max_score: 0, template_version: 1,
});

const rows = [
  row('a', {
    1: [0], 2: [1], 3: [4], 4: [4], 5: [0], 6: [4], 7: [4], 8: [1],
    9: [3], 10: [2], 11: [1], 12: [4], 13: [2], 14: [5],    // Q14 answered N/A
    33: [0], 34: [1], 35: [0], 36: [2], 37: [0], 38: [1],
    45: [5], 46: [5], 47: [5], 48: [5], 49: [5], 50: [5],
    63: 'Payroll correction took nine days.',
    66: [1], 68: [0, 2], 70: [2], 71: [1], 72: [3],
    75: 'Permits.', 76: 'One contact.',
    77: [8], 81: [2], 85: [6],
  }, '2026-11-18T15:00:00.000Z'),
  row('b', {
    1: [1], 2: [0], 3: [1], 4: [2], 5: [0], 6: [3], 7: [2], 8: [2],
    9: [1], 10: [1], 11: [0], 12: [3], 13: [1], 14: [2],
    45: [2], 46: [2], 47: [1], 48: [3], 49: [2], 50: [2],
    63: 'Two answers on the same permit.',
    66: [3], 67: 'Within four hours', 68: [1, 5], 69: 'A phone number',
    70: [1], 71: [3], 72: [1, 5], 73: 'Call the RDO', 74: 'Two permits, two answers.',
    75: 'Repair tickets.', 76: 'Say who owns it.',
    77: [3], 85: [4],
  }, '2026-11-17T12:00:00.000Z'),
  row('c', {
    1: [4],                                        // never works with HR
    // Rated HR, then went back and said Never: the ratings are still in the
    // payload and belong to a question this walk did not end up asking.
    9: [0], 10: [0], 11: [0], 12: [0], 13: [0], 14: [0],
    2: [1], 3: [3], 4: [3], 5: [1], 6: [4], 7: [3], 8: [3],
    45: [3], 46: [3], 47: [3], 48: [3], 49: [3], 50: [3],
    66: [0], 68: [3], 70: [0], 71: [0],            // never gets conflicting answers
    75: 'Nothing.', 76: 'Fewer emails.',
    85: [10],
  }, '2026-11-16T09:00:00.000Z'),
];

async function reopen() {
  const book = buildWorkbook({ def, rows, graded: [], assignments: {} });
  const buffer = await book.xlsx.writeBuffer();
  const back = new ExcelJS.Workbook();
  await back.xlsx.load(buffer);
  return back;
}

const head = sheet => sheet.getRow(1).values.slice(1);

describe('the workbook', () => {
  test('leads with the responses and then the cuts of them', async () => {
    const book = await reopen();
    expect(book.worksheets.map(s => s.name)).toEqual([
      'Responses', 'Questions', 'Ratings', 'Rating matrix', 'Choices', 'Comments',
    ]);
  });

  test('has no column for anything the form did not ask', async () => {
    const book = await reopen();
    const responses = head(book.getWorksheet('Responses'));
    expect(responses.slice(0, 2)).toEqual(['Date', 'Version']);
    for (const bad of ['Name', 'Position', 'Store', 'Store name', 'Area Coach']) {
      expect(responses).not.toContain(bad);
    }
    expect(head(book.getWorksheet('Comments'))).toEqual(
      ['Date', 'Column', 'Question', 'Answer']);
    // Nothing to cut by, so the sheet that cuts by it is not there.
    expect(book.getWorksheet('By position')).toBeUndefined();
  });

  test('the answers are in the first sheet, ratings as numbers', async () => {
    const sheet = (await reopen()).getWorksheet('Responses');
    const cols = head(sheet);
    const q9 = cols.indexOf('Q9') + 1;
    const q14 = cols.indexOf('Q14') + 1;
    expect(sheet.getRow(2).getCell(q9).value).toBe(4);       // "4"
    expect(sheet.getRow(2).getCell(q14).value).toBe('N/A');  // no number in it

    const q68 = cols.indexOf('Q68') + 1;
    expect(sheet.getRow(2).getCell(q68).value)
      .toBe('Hands-on training; Guides in Spanish');
    // Not asked: the third walk ended on Never for HR, so its leftover HR
    // ratings are not an answer and the cell is empty rather than a 1.
    expect(sheet.getRow(4).getCell(q9).value == null
      || sheet.getRow(4).getCell(q9).value === '').toBe(true);
    expect(sheet.rowCount).toBe(4);
  });

  test('N/A is left out of the averages', async () => {
    const sheet = (await reopen()).getWorksheet('Ratings');
    const lines = [];
    sheet.eachRow((r, n) => { if (n > 1 && r.getCell(1).value === 'Q14') lines.push(r); });
    expect(lines).toHaveLength(1);
    expect(lines[0].getCell(2).value).toBe('HR');
    expect(lines[0].getCell(5).value).toBe(1);   // one number given, the second walk's 3
    expect(lines[0].getCell(6).value).toBe(3);   // the first walk's N/A is not a zero
    expect(lines[0].getCell(7).value).toBe(1);   // and is counted as N/A
  });

  test('the matrix averages each function against each statement', async () => {
    const sheet = (await reopen()).getWorksheet('Rating matrix');
    const cols = head(sheet);
    expect(cols[0]).toBe('');
    const respond = cols.indexOf('They respond in a reasonable time') + 1;
    expect(respond).toBeGreaterThan(1);

    const byName = {};
    sheet.eachRow((r, n) => { if (n > 1) byName[r.getCell(1).value] = r; });
    expect(byName.HR.getCell(respond).value).toBe(3);      // 4 and 2
    expect(byName.Legal.getCell(respond).value).toBe(3.5); // N/A, 3 and 4
    // Nobody answered for Payroll, so the cell is empty rather than a zero.
    expect(byName.Payroll.getCell(respond).value == null
      || byName.Payroll.getCell(respond).value === '').toBe(true);
  });

  test('every verbatim is its own row, and none of them is a name', async () => {
    const sheet = (await reopen()).getWorksheet('Comments');
    const said = [];
    sheet.eachRow((r, n) => { if (n > 1) said.push(r.values.slice(1)); });
    expect(said).toHaveLength(12);                // 3 + 7 + 2 written answers
    expect(said.some(r => r.includes('Payroll correction took nine days.'))).toBe(true);
    expect(JSON.stringify(said)).not.toContain('Anonymous');
  });
});

// The same heuristic decides what /submit files a response under, so the
// walks that do ask still land where they always did.
describe('the walks that do ask who and where', () => {
  const seeds = fs.readdirSync(path.join(__dirname, '..', 'data', 'audits'))
    .filter(f => f !== 'rsc-alignment.json');

  test.each(seeds)('%s still files under the same two questions', file => {
    const walk = cleanTemplate(JSON.parse(fs.readFileSync(
      path.join(__dirname, '..', 'data', 'audits', file), 'utf8')));
    const texts = walk.questions.filter(q => q.type === 'text');
    const { nameQ, storeQ } = whoAndWhere(walk);
    if (!texts.length) {                          // asks for neither, as it always did
      expect([nameQ, storeQ]).toEqual([null, null]);
      return;
    }
    // Where it always went: the first text question and the second.
    expect(nameQ).toBe(texts[0]);
    expect(storeQ).toBe(texts[1]);
  });
});
