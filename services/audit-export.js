// services/audit-export.js
//
// The workbook behind Export Excel.
//
// The old export wrote Right/Wrong per question, which is the whole story for
// a test and nothing at all for a questionnaire: an unscored walk has no
// graded results, so every question column came back empty. This builds the
// sheet from the answers themselves and leaves the marking as colour on top.
//
// Pure — def, rows and the frozen grades in, a workbook out — so it can be
// checked without Supabase. routes/audits.js only hands it what it read.
//
// Sheet order is deliberate: Responses first, because that is the one people
// filter and pivot. Everything after it is a cut of the same answers.

const ExcelJS = require('exceljs');
const { whoAndWhere, visible } = require('./audits');

const TEXTY = new Set(['text', 'longtext']);
const CHOICE = new Set(['single', 'multi']);

// A choice that is the absence of a rating rather than a low one.
const NOT_RATED = /^\s*(n\/?a|not applicable|don'?t know|no opinion)\s*$/i;

// A rating choice carries its number in front of its wording — "4 — Agree",
// "0 — Not at all satisfied" — so the number is what goes in the cell and
// what gets averaged. "N/A" has none and stays text, which is how it drops
// out of an average instead of counting as a zero.
function numOf(label) {
  const m = /^\s*(-?\d+(?:\.\d+)?)\s*(?:$|[^\d%])/.exec(String(label == null ? '' : label));
  return m ? Number(m[1]) : null;
}

// "HR — They respond in a reasonable time" is a function and a statement, and
// the matrix is built out of the two. A title without the dash is all item.
function splitTitle(title) {
  const t = String(title == null ? '' : title);
  const at = t.indexOf(' — ');
  return at > 0
    ? { group: t.slice(0, at).trim(), item: t.slice(at + 3).trim() }
    : { group: '', item: t };
}

// JSONB comes back keyed by strings; answers written server-side are keyed by
// number. Both are the same question.
//
// An answer to a question that ended up hidden does not count. Rate HR six
// ways, then go back and say you never work with HR, and the six ratings are
// still in the payload — they are an answer to a question this walk did not
// end up asking, and averaging them is reporting something nobody said.
function answerFor(row, q) {
  const a = row.answers || {};
  if (!visible(q, a)) return undefined;
  return a[q.n] !== undefined ? a[q.n] : a[String(q.n)];
}

const indexes = v => (Array.isArray(v) ? v : v == null || v === '' ? [] : [v])
  .map(Number).filter(Number.isInteger);

/** The labels a choice answer picked, in the order the question lists them. */
function labelsOf(q, given) {
  const choices = q.choices || [];
  return indexes(given).filter(i => i >= 0 && i < choices.length).map(i => choices[i]);
}

/**
 * One answer as a cell.
 *
 * A single rating becomes the number so the column can be averaged and
 * filtered; everything else becomes the wording, which is what someone
 * reading down the column needs to see.
 */
function cellOf(q, row) {
  const given = answerFor(row, q);
  if (q.type === 'photo' || q.type === 'video') {
    const shots = (row.photos || {})[q.n] || (row.photos || {})[String(q.n)] || [];
    return shots.length ? `${shots.length} file${shots.length === 1 ? '' : 's'}` : '';
  }
  if (CHOICE.has(q.type)) {
    const picked = labelsOf(q, given);
    if (!picked.length) return '';
    if (q.type === 'single') {
      const n = numOf(picked[0]);
      return n == null ? picked[0] : n;
    }
    return picked.join('; ');
  }
  if (q.type === 'scale' || q.type === 'number') {
    return Number.isFinite(Number(given)) ? Number(given) : '';
  }
  if (TEXTY.has(q.type)) return String(given == null ? '' : given).trim();
  // order, assign, hotspot: the answer is a shape, not a value. The score and
  // the walk itself carry those; a spreadsheet cell cannot.
  return given == null ? '' : 'Answered';
}

/**
 * Every number anyone gave to this question, with its scale.
 *
 * `scale` is read off the choices rather than declared, so a 1–5 statement
 * and a 0–10 satisfaction question sort themselves into different averages
 * without either being named here.
 */
function numericQuestions(def, rows) {
  const out = [];
  for (const q of def.questions) {
    let values = [];
    let na = 0;
    let lo = null, hi = null;

    if (q.type === 'single') {
      const nums = (q.choices || []).map(numOf).filter(n => n != null);
      // Every choice is a number, or says there is nothing to rate. One
      // numbered choice among words is not a scale: "1 week / 2 weeks /
      // 30 days / More than 30 days" averages to nonsense.
      if (nums.length < 2) continue;
      if (nums.length + (q.choices || []).filter(c => NOT_RATED.test(c)).length
          !== (q.choices || []).length) continue;
      lo = Math.min(...nums); hi = Math.max(...nums);
      for (const row of rows) {
        const picked = labelsOf(q, answerFor(row, q));
        if (!picked.length) continue;
        const n = numOf(picked[0]);
        if (n == null) na += 1; else values.push(n);
      }
    } else if (q.type === 'scale' || q.type === 'number') {
      lo = Number(q.min); hi = Number(q.max);
      for (const row of rows) {
        const v = Number(answerFor(row, q));
        if (Number.isFinite(v)) values.push(v);
      }
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = null; hi = null; }
    } else {
      continue;
    }

    out.push({ q, ...splitTitle(q.title), values, na, lo, hi });
  }
  return out;
}

const mean = xs => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);

function bold(sheet) { sheet.getRow(1).font = { bold: true }; }

function filterable(sheet, columns) {
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns } };
}

/**
 * @param def      the template, as the editor holds it (answer key included)
 * @param rows     audit_responses rows, newest first
 * @param graded   frozen grades, one per row, same order
 * @param assignments  store_number → { store_name, area_coach }
 */
function buildWorkbook({ def, rows, graded = [], assignments = {} }) {
  const book = new ExcelJS.Workbook();
  book.creator = 'P.AI';
  book.created = new Date();

  const questions = def.questions || [];
  const isScored = questions.some(q => Number(q.points) > 0);

  // The second text question is what /submit files as store_number — a store
  // number on a walk, a position on a questionnaire. Its own wording is the
  // only honest heading for that column.
  // Nothing identifying goes in a sheet that the form never asked for. An
  // anonymous questionnaire has no name question and no store question, so
  // the workbook has no Name column, no Area Coach, and no cut by who sent
  // it — a column of blanks would be an invitation to fill it in later.
  const { nameQ, storeQ } = whoAndWhere(def);
  const asked = storeQ ? splitTitle(storeQ.title).item : '';
  const plain = asked.replace(/^your\s+/i, '');
  const whoLabel = plain ? plain.charAt(0).toUpperCase() + plain.slice(1) : '';

  // ── Responses ─────────────────────────────────────────────────────────────
  const meta = ['Date',
    ...(nameQ ? ['Name'] : []),
    ...(storeQ ? [whoLabel, 'Store name', 'Area Coach'] : []),
    ...(isScored ? ['Score', 'Out of'] : []), 'Version'];
  const sheet = book.addWorksheet('Responses');
  sheet.addRow([...meta, ...questions.map(q => `Q${q.n}`)]);
  bold(sheet);

  rows.forEach((row, i) => {
    const s = assignments[row.store_number] || {};
    const line = sheet.addRow([
      // To the minute on a walk, the day alone on an anonymous one: in a
      // group this size, the order people answered in is close enough to a
      // name for anybody who knows who was in the room.
      new Date(row.created_at).toISOString().replace('T', ' ').slice(0, nameQ ? 16 : 10),
      ...(nameQ ? [row.respondent_name || ''] : []),
      ...(storeQ ? [row.store_number || '', s.store_name || '', s.area_coach || ''] : []),
      ...(isScored ? [Number(row.score), Number(row.max_score)] : []),
      row.template_version == null ? '' : Number(row.template_version),
      ...questions.map(q => cellOf(q, row)),
    ]);

    // Marking stays as colour over the answer, so a test export still reads
    // at a glance without losing what was actually picked.
    const verdict = new Map(((graded[i] || {}).results || []).map(r => [r.n, r.correct]));
    questions.forEach((q, c) => {
      if (!verdict.has(q.n)) return;
      const cell = line.getCell(meta.length + c + 1);
      cell.font = verdict.get(q.n)
        ? { color: { argb: 'FF1CB145' } }
        : { color: { argb: 'FFB00020' }, bold: true };
    });
  });

  filterable(sheet, meta.length + questions.length);
  sheet.columns.forEach((col, i) => { col.width = i < meta.length ? 16 : 13; });

  // ── Questions: the wording the Q columns stand for ────────────────────────
  const key = book.addWorksheet('Questions');
  key.addRow(['Column', 'Question', 'Type', 'Group', 'Item', 'Points', 'Answered', 'Skipped']);
  bold(key);
  for (const q of questions) {
    const answered = rows.filter(r => cellOf(q, r) !== '').length;
    const { group, item } = splitTitle(q.title);
    key.addRow([`Q${q.n}`, q.title, q.type, group, item, Number(q.points) || 0,
      answered, rows.length - answered]);
  }
  filterable(key, 8);
  key.getColumn(2).width = 70;
  key.getColumn(2).alignment = { wrapText: true };
  key.getColumn(5).width = 45;
  for (const c of [1, 3, 4, 6, 7, 8]) key.getColumn(c).width = 13;

  const numerics = numericQuestions(def, rows);

  // ── Ratings: every scored-out-of-something question, averaged ─────────────
  if (numerics.length) {
    const rate = book.addWorksheet('Ratings');
    // The spread of answers matters as much as the average: a 3.0 made of
    // fives and ones is a different problem from a 3.0 made of threes.
    const stops = [...new Set(numerics.flatMap(x =>
      x.lo != null ? Array.from({ length: x.hi - x.lo + 1 }, (_, i) => x.lo + i) : x.values
    ))].sort((a, b) => a - b);
    rate.addRow(['Column', 'Group', 'Item', 'Scale', 'Answers', 'Average', 'N/A',
      ...stops.map(v => `${v}`)]);
    bold(rate);
    for (const x of numerics) {
      const counts = stops.map(v => x.values.filter(n => n === v).length || '');
      rate.addRow([`Q${x.q.n}`, x.group, x.item,
        x.lo == null ? '' : `${x.lo}–${x.hi}`,
        x.values.length, mean(x.values), x.na || '', ...counts]);
    }
    filterable(rate, 7 + stops.length);
    rate.getColumn(2).width = 16;
    rate.getColumn(3).width = 50;
    rate.getColumn(3).alignment = { wrapText: true };
    rate.getColumn(6).numFmt = '0.00';
    for (const c of [1, 4, 5, 6, 7]) rate.getColumn(c).width = 11;
    for (let c = 8; c < 8 + stops.length; c++) rate.getColumn(c).width = 6;

    // ── Rating matrix: function down the side, statement across the top ─────
    //
    // One scale only. A 1–5 statement and a 0–10 satisfaction score in the
    // same grid share a row and a row average, and that average means
    // nothing. The scale with the most questions is the one worth a matrix;
    // the rest are a column each on Ratings above.
    const tally = new Map();
    for (const x of numerics.filter(y => y.group && y.lo != null)) {
      const s = `${x.lo}–${x.hi}`;
      tally.set(s, (tally.get(s) || 0) + 1);
    }
    const scale = [...tally.entries()].sort((a, b) => b[1] - a[1]).map(e => e[0])[0];
    const grid1 = numerics.filter(x => x.group && `${x.lo}–${x.hi}` === scale);
    const groups = [...new Set(grid1.map(x => x.group))];
    const items = [...new Set(grid1.map(x => x.item))];
    if (groups.length > 1 && items.length > 1) {
      const grid = book.addWorksheet('Rating matrix');
      grid.addRow(['', ...items, 'Group average']);
      bold(grid);
      const at = new Map(grid1.map(x => [`${x.group}|${x.item}`, x]));
      for (const g of groups) {
        const mine = grid1.filter(x => x.group === g);
        grid.addRow([g,
          ...items.map(it => {
            const x = at.get(`${g}|${it}`);
            return x && x.values.length ? mean(x.values) : '';
          }),
          mean(mine.flatMap(x => x.values)),
        ]);
      }
      grid.addRow(['Item average',
        ...items.map(it => mean(grid1.filter(x => x.item === it).flatMap(x => x.values))),
        mean(grid1.flatMap(x => x.values)),
      ]);
      grid.getRow(grid.rowCount).font = { bold: true };
      grid.getColumn(1).width = 22;
      for (let c = 2; c <= items.length + 2; c++) {
        grid.getColumn(c).width = 15;
        grid.getColumn(c).numFmt = '0.00';
        grid.getColumn(c).alignment = { wrapText: true };
      }
      grid.views = [{ state: 'frozen', xSplit: 1, ySplit: 1 }];
    }
  }

  // ── Choices: what people picked, where there is nothing to average ────────
  const picky = questions.filter(q => CHOICE.has(q.type)
    && !numerics.some(x => x.q.n === q.n));
  if (picky.length) {
    const pick = book.addWorksheet('Choices');
    pick.addRow(['Column', 'Group', 'Question', 'Answer', 'Times chosen',
      '% of answers', 'Marked right']);
    bold(pick);
    for (const q of picky) {
      const { group, item } = splitTitle(q.title);
      // Pick-all counts boxes, not people, so the share is of the people who
      // answered it at all — not of the ticks.
      const answered = rows.filter(r => labelsOf(q, answerFor(r, q)).length).length;
      (q.choices || []).forEach((label, i) => {
        const count = rows.filter(r => indexes(answerFor(r, q)).includes(i)).length;
        pick.addRow([`Q${q.n}`, group, item, label, count,
          answered ? count / answered : '',
          (q.correct || []).includes(i) ? 'Yes' : '']);
      });
    }
    filterable(pick, 7);
    pick.getColumn(2).width = 16;
    pick.getColumn(3).width = 55;
    pick.getColumn(3).alignment = { wrapText: true };
    pick.getColumn(4).width = 40;
    pick.getColumn(6).numFmt = '0%';
    for (const c of [1, 5, 6, 7]) pick.getColumn(c).width = 13;
  }

  // ── By position: the cut the final report is written in ───────────────────
  //
  // No names here. The form promises results summarised by position, and a
  // sheet with one person per position is a name with extra steps — but that
  // is a judgement about who reads it, so Responses still carries them.
  if (numerics.length && storeQ) {
    const scales = [...new Set(numerics.filter(x => x.lo != null).map(x => `${x.lo}–${x.hi}`))];
    const who = book.addWorksheet(`By ${whoLabel.toLowerCase()}`.slice(0, 31));
    who.addRow([whoLabel, 'Respondents', ...scales.map(s => `Average, ${s} questions`)]);
    bold(who);

    const seen = new Map();
    for (const row of rows) {
      const name = String(row.store_number || '').trim() || 'Not given';
      const at = name.toLowerCase();
      const g = seen.get(at) || { name, rows: [] };
      g.rows.push(row);
      seen.set(at, g);
    }
    for (const g of [...seen.values()].sort((a, b) => b.rows.length - a.rows.length)) {
      who.addRow([g.name, g.rows.length, ...scales.map(s => {
        const values = numerics
          .filter(x => x.lo != null && `${x.lo}–${x.hi}` === s)
          .flatMap(x => g.rows.map(r => {
            const picked = labelsOf(x.q, answerFor(r, x.q));
            if (picked.length) return numOf(picked[0]);
            const v = Number(answerFor(r, x.q));
            return Number.isFinite(v) && (x.q.type === 'scale' || x.q.type === 'number') ? v : null;
          }))
          .filter(v => v != null);
        return mean(values);
      })]);
    }
    filterable(who, 2 + scales.length);
    who.getColumn(1).width = 28;
    for (let c = 2; c <= 2 + scales.length; c++) {
      who.getColumn(c).width = 20;
      if (c > 2) who.getColumn(c).numFmt = '0.00';
    }
  }

  // ── Comments: every verbatim, one row each ────────────────────────────────
  const written = questions.filter(q => TEXTY.has(q.type) && q !== nameQ && q !== storeQ);
  if (written.length) {
    const say = book.addWorksheet('Comments');
    say.addRow(['Date', ...(storeQ ? [whoLabel] : []), 'Column', 'Question', 'Answer']);
    bold(say);
    for (const row of rows) {
      for (const q of written) {
        const text = String(answerFor(row, q) || '').trim();
        if (!text) continue;
        say.addRow([
          new Date(row.created_at).toISOString().slice(0, 10),
          ...(storeQ ? [row.store_number || ''] : []),
          `Q${q.n}`, splitTitle(q.title).item, text,
        ]);
      }
    }
    const at = storeQ ? 1 : 0;                 // the columns after the date
    filterable(say, 4 + at);
    say.getColumn(1).width = 12;
    if (storeQ) say.getColumn(2).width = 22;
    say.getColumn(2 + at).width = 9;
    say.getColumn(3 + at).width = 50;
    say.getColumn(3 + at).alignment = { wrapText: true };
    say.getColumn(4 + at).width = 90;
    say.getColumn(4 + at).alignment = { wrapText: true };
  }

  return book;
}

module.exports = { buildWorkbook, numOf, splitTitle, cellOf, numericQuestions };
