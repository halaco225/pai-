# Cheese Variance In The Brief — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The morning brief text shows cheese usage variance — `chz +1.90` — on the reader's own summary line and on each of their breakdown rows, scoped so every person sees only the stores that report to them.

**Architecture:** The ODS report `SUS_DBS` carries a "Daily Critical Items" block per store with an `Ideal Usage / Actual Usage / Variance` row for CHEESE. `services/intel-ods.js` already logs into ODS and pulls reports over REST, so SUS_DBS is one more entry in its `REPORTS` map plus a set of per-report parameters. A new pure parser reads the CHEESE row per store and emits rows into the existing `dbs_soft_indicators` table — which already stores `(store_id, metric_date, indicator, value, target)` and already holds labor hours — so there is no new table and no migration. `services/scorecard.js` joins that indicator the same way it joins labor, which makes the per-person rollup automatic: a VP's cheese is their territory's, an Area Coach's is their stores'. `services/brief-sms.js` then prints one field on two existing lines.

**Tech Stack:** Node 18+, `xlsx`, `pg`, jest.

**Deadline:** The intel pull runs at 6:00 AM Eastern and the text goes at 8:05. Tasks 1–6 must be merged and deployed before 6:00 AM for the first real text to carry cheese. Tasks 7–8 read the same stored rows and can land afterwards without affecting the text.

**Confirmed ODS parameters** (captured from a live run on 2026-10-13):

```
date                   : <target date>   — the control also accepts the literal "YESTERDAY"
orgType                : territory
orgTypeValue           : 26              — Matt Hester (27 = Tracy Krumwiede)
storeIdsPH             : []              — empty means every store in the territory
groupBy                : store_number
includeDeliveryCharges : false
showHistoricalGrowth   : false
```

**Sign convention:** `Variance = Ideal − Actual`. Positive means the store used *less* cheese than ideal, which is favorable, and prints as `chz +1.90`. Negative prints as `chz -1.90`.

---

## File Structure

### Created

| File | Responsibility |
|---|---|
| `services/parsers/sus-dbs-parser.js` | Pure parse of the SUS_DBS workbook into `cheese_usage` soft-indicator rows. No I/O beyond reading the file it is handed. |
| `tests/sus-dbs-parser.test.js` | Column-by-name lookup, store pairing, blank handling, variance arithmetic. |
| `tests/fixtures/sus-dbs-sample.xlsx` | A real SUS_DBS export, committed so the parser has a regression fixture. |
| `tests/brief-cheese.test.js` | The rendered `chz` field, both signs, and the absent case. |

### Modified

| File | Change |
|---|---|
| `services/intel-ods.js` | Add `SUS_DBS` to `REPORTS`; let a report carry extra parameters alongside `date`. |
| `services/intel-pipeline.js` | New step that pulls and processes SUS_DBS, with the same `logStep` and try/catch as every other source. |
| `services/scorecard.js` | Join `cheese_usage`, accumulate it, expose `cheese_var` and `cheese_coverage`. |
| `services/brief-sms.js` | Print `chz` on the own-summary line and on each breakdown row. |
| `services/claude.js` | Cheese in the full morning brief memo (Task 7). |
| `public/intel.html` | Cheese in the daily intel view (Task 8). |

---

## Task 1: Let an ODS report carry its own parameters

`downloadReport()` hardcodes a single `date` parameter. SUS_DBS needs six more. The four existing reports must keep sending exactly what they send today.

**Files:**
- Modify: `services/intel-ods.js:16-22` (the `REPORTS` map) and `services/intel-ods.js:72-88` (`downloadReport`)

- [ ] **Step 1: Widen the REPORTS map**

Replace lines 16–22:

```js
const REPORTS = {
  DBS:            '/Reports/Pizza_Hut/Operations/PH_DGIDBS_1',
  SOS:            '/Reports/Pizza_Hut/Operations/PH_Speed_Of_Service',
  PAYROLL:        '/Reports/Pizza_Hut/Payroll/PH_ForgotToClockOut',
  CHANGE_DOWN:    '/Reports/Pizza_Hut/Operations/PH_ChangeDownReport',
  CANCEL_TENDER:  '/Reports/Pizza_Hut/Operations/PH_Cancels_After_Tender',
};
```

with:

```js
// A value may be a plain URI, or { uri, params } when the report needs more than
// a date. SUS_DBS is scoped by an organizational level rather than by the login,
// so without its parameters it returns the viewer's own region instead of the
// territory -- a quiet wrong answer rather than an error.
const REPORTS = {
  DBS:            '/Reports/Pizza_Hut/Operations/PH_DGIDBS_1',
  SOS:            '/Reports/Pizza_Hut/Operations/PH_Speed_Of_Service',
  PAYROLL:        '/Reports/Pizza_Hut/Payroll/PH_ForgotToClockOut',
  CHANGE_DOWN:    '/Reports/Pizza_Hut/Operations/PH_ChangeDownReport',
  CANCEL_TENDER:  '/Reports/Pizza_Hut/Operations/PH_Cancels_After_Tender',
  SUS_DBS: {
    uri: '/Reports/Pizza_Hut/Operations/SUS_DBS',
    params: {
      orgType:                'territory',
      orgTypeValue:           process.env.ODS_TERRITORY_ID || '26',   // 26 = Matt Hester
      groupBy:                'store_number',
      includeDeliveryCharges: 'false',
      showHistoricalGrowth:   'false',
      // storeIdsPH is deliberately absent: empty means every store in the
      // territory, so no store list has to be maintained as the market changes.
    },
  },
};

function reportUri(key)    { const r = REPORTS[key]; return typeof r === 'string' ? r : r && r.uri; }
function reportParams(key) { const r = REPORTS[key]; return (typeof r === 'string' ? null : r && r.params) || {}; }
```

- [ ] **Step 2: Send those parameters**

In `downloadReport`, replace lines 74–75:

```js
  const reportURI = REPORTS[reportKey];
  if (!reportURI) throw new Error(`Unknown report key: ${reportKey}`);
```

with:

```js
  const reportURI = reportUri(reportKey);
  if (!reportURI) throw new Error(`Unknown report key: ${reportKey}`);
  const extra = reportParams(reportKey);
```

and replace line 86:

```js
      parameters: { reportParameter: [{ name: 'date', value: [targetDate] }] },
```

with:

```js
      parameters: {
        reportParameter: [
          // The real target date rather than the report's own "YESTERDAY" token,
          // so a backfill or a re-run of a missed day gets that day's numbers
          // instead of whatever yesterday is at the moment it reruns.
          { name: 'date', value: [targetDate] },
          ...Object.entries(extra).map(([name, v]) => ({ name, value: [v] })),
        ],
      },
```

- [ ] **Step 3: Confirm the existing reports are unchanged**

Run:
```bash
node -e "
const o = require('./services/intel-ods');
console.log(Object.keys(o.REPORTS).join(' '));
"
```
Expected: `DBS SOS PAYROLL CHANGE_DOWN CANCEL_TENDER SUS_DBS`.

The four existing keys are still plain strings, so `reportParams` returns `{}` for them and their request body is byte-for-byte what it was.

- [ ] **Step 4: Commit**

```bash
git add services/intel-ods.js
git commit -m "Let an ODS report carry parameters beyond the date

SUS_DBS is scoped by organizational level rather than by who is logged
in, so pulling it with only a date returns the viewer's own region and
calls it the territory. That is a wrong answer that looks like a right
one, which is worse than a failure.

The four existing reports stay plain strings and their request bodies
are unchanged.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: Save a real export as a test fixture

The parser's tests are worthless against invented data — the point is to survive this report's actual layout.

**Files:**
- Create: `tests/fixtures/sus-dbs-sample.xlsx`

- [ ] **Step 1: Copy the known-good export**

```bash
mkdir -p tests/fixtures
cp "/c/Users/Precision 3551/Downloads/SUS_DBS (1).xlsx" tests/fixtures/sus-dbs-sample.xlsx
```

- [ ] **Step 2: Confirm it is the file the plan was written against**

```bash
node -e "
const XLSX = require('xlsx');
const wb = XLSX.readFile('tests/fixtures/sus-dbs-sample.xlsx', { raw: true });
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: null });
console.log('date row:', rows[1][0]);
console.log('header row 74:', JSON.stringify(rows[74]));
console.log('cheese row 79:', JSON.stringify(rows[79]));
"
```
Expected:
```
date row: Business Date:  10/11/2026
header row 74: ["","Ideal Usage","Actual Usage","Variance","","WTD Actual Variance","WTD Absolute Variance","","PTD Actual Variance","PTD Absolute Variance"]
cheese row 79: ["CHEESE",81.9,80,1.9,"",-7.15,18.68,"",-7.15,18.68]
```

**If the header row does not match, stop.** The parser finds its column by that header text; a different layout means the real report changed and the column indices in this plan are no longer the ones to assert against.

- [ ] **Step 3: Commit**

```bash
git add tests/fixtures/sus-dbs-sample.xlsx
git commit -m "Add a real SUS_DBS export as a parser fixture

Parsing tests written against invented rows prove the parser agrees
with its author. This is the file the report actually produces.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: Parse the cheese row

**Files:**
- Create: `services/parsers/sus-dbs-parser.js`
- Create: `tests/sus-dbs-parser.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// tests/sus-dbs-parser.test.js
const path = require('path');
const { parseSusDbs, cheeseFromRows, STORE_RE } = require('../services/parsers/sus-dbs-parser');

const FIXTURE = path.join(__dirname, 'fixtures', 'sus-dbs-sample.xlsx');
const DATE    = '2026-10-11';

describe('parseSusDbs', () => {
  const out = parseSusDbs(FIXTURE, DATE);

  test('emits one cheese_usage row per store that reported', () => {
    expect(out.softIndicators.length).toBe(36);          // 37 blocks, one blank
    expect(out.softIndicators.every(r => r.indicator === 'cheese_usage')).toBe(true);
  });

  test('value is actual usage and target is ideal usage', () => {
    const first = out.softIndicators.find(r => r.store_id === '038876');
    expect(first).toEqual({
      store_id: '038876', metric_date: DATE,
      indicator: 'cheese_usage', value: 80, target: 81.9, source: 'ODS',
    });
  });

  test('strips the leading S so ids match store_assignments', () => {
    expect(out.softIndicators.every(r => /^\d{6}$/.test(r.store_id))).toBe(true);
  });

  test('skips a store whose cheese row is blank rather than calling it zero', () => {
    expect(out.softIndicators.find(r => r.store_id === '039389')).toBeUndefined();
    expect(out.skipped).toContain('039389');
  });

  test('target minus value reproduces the report\'s own Variance column', () => {
    const s = out.softIndicators.find(r => r.store_id === '038876');
    expect(Number((s.target - s.value).toFixed(2))).toBe(1.9);
  });
});

describe('cheeseFromRows', () => {
  const header = ['', 'Ideal Usage', 'Actual Usage', 'Variance'];

  test('finds the columns by header name, not by position', () => {
    const rows = [
      ['S012345 (Somewhere)'],
      ['DAILY CRITICAL ITEMS'],
      ['', 'Actual Usage', 'Ideal Usage', 'Variance'],   // columns swapped
      ['CHEESE', 50, 60, 10],
    ];
    const out = cheeseFromRows(rows, '2026-10-11');
    expect(out.softIndicators[0]).toMatchObject({ store_id: '012345', value: 50, target: 60 });
  });

  test('emits nothing when the header has no Ideal/Actual columns', () => {
    const rows = [
      ['S012345 (Somewhere)'],
      ['DAILY CRITICAL ITEMS'],
      ['', 'Something Else', 'Another Thing'],
      ['CHEESE', 50, 60, 10],
    ];
    const out = cheeseFromRows(rows, '2026-10-11');
    expect(out.softIndicators).toHaveLength(0);
    expect(out.skipped).toContain('012345');
  });

  test('a cheese row before any store header is ignored', () => {
    const out = cheeseFromRows([header, ['CHEESE', 1, 2, 3]], '2026-10-11');
    expect(out.softIndicators).toHaveLength(0);
  });

  test('STORE_RE reads the id and name out of a block header', () => {
    expect(STORE_RE.exec('S038876 (Wells Street)').slice(1, 3)).toEqual(['038876', 'Wells Street']);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx jest tests/sus-dbs-parser.test.js`
Expected: FAIL — `Cannot find module '../services/parsers/sus-dbs-parser'`.

- [ ] **Step 3: Write the parser**

```js
// services/parsers/sus-dbs-parser.js
'use strict';
/**
 * SUS_DBS parser — the CHEESE row of each store's "Daily Critical Items" block.
 *
 * Layout, confirmed against a real export:
 *
 *   S038876 (Wells Street)                     <- block header
 *   ...
 *   DAILY CRITICAL ITEMS
 *   "", Ideal Usage, Actual Usage, Variance, ...   <- column header
 *   CHEESE, 81.9, 80, 1.9, ...
 *
 * Columns are located by header text rather than by index. dbs-parser.js takes
 * the index approach and carries two columns it never identified; a report that
 * gains a column there starts reading the wrong number silently. Here, a header
 * that cannot be understood yields no row at all, so the brief omits cheese for
 * that store rather than printing something confident and wrong.
 *
 * Variance is Ideal - Actual: positive means the store used less than ideal.
 * It is not stored. Storing a number that is the difference of two other stored
 * numbers is how the three of them drift apart.
 */
const XLSX = require('xlsx');

// "S038876 (Wells Street)" -> id without the S, and the name.
// store_assignments, intel_dbs_metrics and dbs_soft_indicators all key stores
// as "038876"; only this report and velocity_daily_records carry the S.
const STORE_RE = /^S(\d{6})\s*\((.+)\)\s*$/;

const CRITICALS_HEADING = 'DAILY CRITICAL ITEMS';
const ITEM              = 'CHEESE';

const txt = v => String(v == null ? '' : v).trim();
const num = v => (typeof v === 'number' && isFinite(v) ? v : null);

// The header row names its columns; find them rather than counting them.
function columnsFrom(row) {
  const find = label => row.findIndex(c => txt(c).toLowerCase() === label);
  const ideal  = find('ideal usage');
  const actual = find('actual usage');
  return ideal >= 0 && actual >= 0 ? { ideal, actual } : null;
}

/**
 * Walk the sheet rows. Pure — no file access, so the odd layouts are testable.
 * Returns { softIndicators, skipped } where skipped names the stores that had a
 * block but no usable cheese number.
 */
function cheeseFromRows(rows, targetDate) {
  const softIndicators = [];
  const skipped = [];

  let store = null;      // the block we are inside
  let cols  = null;      // that block's column positions
  let seen  = false;     // did this block yield a row

  const closeBlock = () => {
    if (store && !seen) skipped.push(store);
  };

  for (const row of rows) {
    const a = txt(row[0]);

    const m = STORE_RE.exec(a);
    if (m) { closeBlock(); store = m[1]; cols = null; seen = false; continue; }

    if (!store) continue;                       // content before the first block
    if (a === CRITICALS_HEADING) { cols = null; continue; }

    if (!cols) { cols = columnsFrom(row); }     // the row after the heading names the columns

    if (a === ITEM) {
      const ideal  = cols ? num(row[cols.ideal])  : null;
      const actual = cols ? num(row[cols.actual]) : null;
      // A store that has not posted yet shows blanks. Writing 0/0 would report
      // a perfect variance for a store that reported nothing at all.
      if (ideal == null || actual == null) continue;
      softIndicators.push({
        store_id:    store,
        metric_date: targetDate,
        indicator:   'cheese_usage',
        value:       actual,
        target:      ideal,
        source:      'ODS',
      });
      seen = true;
    }
  }
  closeBlock();

  return { softIndicators, skipped };
}

function parseSusDbs(filePath, targetDate) {
  const wb = XLSX.readFile(filePath, { cellDates: false, raw: true });
  // Concatenated for the same reason dbs-parser.js concatenates: this report
  // splits across tabs once it covers enough stores.
  const rows = wb.SheetNames.flatMap(name =>
    XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: null })
  );
  return cheeseFromRows(rows, targetDate);
}

module.exports = { parseSusDbs, cheeseFromRows, STORE_RE };
```

- [ ] **Step 4: Run the tests**

Run: `npx jest tests/sus-dbs-parser.test.js`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add services/parsers/sus-dbs-parser.js tests/sus-dbs-parser.test.js
git commit -m "Parse the cheese row out of SUS_DBS

Columns are found by header text. dbs-parser.js counts indices and has
carried two unidentified columns since it was written; when a report
gains a column that approach reads the wrong number and says nothing.
An unreadable header here produces no row, so the brief leaves cheese
out rather than printing a confident wrong number.

A store that has not posted shows blanks, and blanks are skipped rather
than stored as zero -- zero ideal against zero actual is a perfect
variance for a store that reported nothing.

Variance is not stored. It is Ideal - Actual, and storing a third
number alongside the two it comes from is how they drift apart.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: Pull SUS_DBS in the pipeline

**Files:**
- Modify: `services/intel-pipeline.js` — the require block near line 18, and a new step after Step 1 (DBS)

- [ ] **Step 1: Require the parser**

After line 19 (`const { processDBS } = require('./parsers/dbs-parser');`) add:

```js
const { parseSusDbs }          = require('./parsers/sus-dbs-parser');
```

- [ ] **Step 2: Add the step**

Immediately after the `await logStep('dbs', results.steps.dbs, targetDate);` line that closes Step 1, insert:

```js
  // ── Step 1b: SUS_DBS cheese usage ─────────────────────────────────────────
  // Its own step rather than part of Step 1: this is a different report with a
  // different scope, and a failure here must not cost us the DBS metrics that
  // the whole brief is built on.
  console.log('[Intel Pipeline] Step 1b: SUS_DBS cheese');
  try {
    const pull = await pullReport('SUS_DBS', targetDate);
    if (!pull.success) throw new Error(pull.error);
    const { softIndicators, skipped } = parseSusDbs(pull.filePath, targetDate);
    for (const si of softIndicators) await db.upsertSoftIndicator(si);
    cleanupFile(pull.filePath);
    if (skipped.length) {
      console.log(`[Intel Pipeline] SUS_DBS: ${skipped.length} store(s) had no cheese number: ${skipped.join(', ')}`);
    }
    results.steps.susDbs = { success: true, written: softIndicators.length, skipped: skipped.length };
  } catch (err) {
    results.errors.push(`SUS_DBS: ${err.message}`);
    results.steps.susDbs = { success: false, error: err.message };
    console.error('[Intel Pipeline] SUS_DBS failed:', err.message);
  }
  await logStep('susDbs', results.steps.susDbs, targetDate);
```

- [ ] **Step 3: Confirm `db` is already in scope**

```bash
grep -n "require('./db')" services/intel-pipeline.js
```
Expected: one line near the top. If there is none, add `const db = require('./db');` beside the other requires.

- [ ] **Step 4: Run it against live ODS for yesterday**

```bash
node -e "
const { pullReport } = require('./services/intel-ods');
const { parseSusDbs } = require('./services/parsers/sus-dbs-parser');
const d = process.argv[1];
pullReport('SUS_DBS', d).then(p => {
  if (!p.success) { console.error('PULL FAILED:', p.error); process.exit(1); }
  const r = parseSusDbs(p.filePath, d);
  console.log('stores with cheese:', r.softIndicators.length, '| skipped:', r.skipped.length);
  console.log('sample:', JSON.stringify(r.softIndicators[0]));
  const ideal = r.softIndicators.reduce((a,s)=>a+s.target,0);
  const act   = r.softIndicators.reduce((a,s)=>a+s.value,0);
  console.log('territory variance:', (ideal-act).toFixed(2));
});
" 2026-10-12
```

Expected: a store count well above the 37 of a single region, since this pulls Matt's whole territory.

**If this runs before the overnight numbers post, the skipped count will be high and the variance near zero.** That is the correct behaviour, not a bug — re-run it after 6:00 AM Eastern to see real numbers.

- [ ] **Step 5: Commit**

```bash
git add services/intel-pipeline.js
git commit -m "Pull cheese usage from SUS_DBS in the morning pipeline

Its own step, so a failure in a report nobody depended on yesterday
cannot cost us the DBS metrics the entire brief is built on.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: Roll cheese up per reader

This is the task that makes Darian see only his stores. `buildScorecard` already groups by whoever is reading; cheese joins the same way labor does and inherits that for free.

**Files:**
- Modify: `services/scorecard.js` — `STORE_SQL` (line 50), `blank` (line 108), `accumulate` (line 119), `finalize` (line 162)

- [ ] **Step 1: Join the indicator**

In `STORE_SQL`, after the `ls.value::float AS sch_hrs,` line add:

```sql
         chz.value::float         AS chz_actual,
         chz.target::float        AS chz_ideal,
```

and after the `ls` LEFT JOIN block add:

```sql
    LEFT JOIN dbs_soft_indicators chz
           ON chz.store_id = sa.store_id AND chz.metric_date = $1
          AND chz.indicator = 'cheese_usage'
```

- [ ] **Step 2: Add the accumulator fields**

In `blank()`, after `act_hrs: 0, sch_hrs: 0, labor_n: 0,` add:

```js
    chz_ideal: 0, chz_actual: 0, chz_n: 0,
```

- [ ] **Step 3: Accumulate**

In `accumulate()`, after the labor block that ends `acc.labor_n++; }` add:

```js
  // Usage in units, so a group's variance is the sum of its stores' -- unlike
  // WIN, which has to be survey-weighted. Both sides must be present: half a
  // pair is not a variance.
  if (r.chz_ideal != null && r.chz_actual != null) {
    acc.chz_ideal  += r.chz_ideal;
    acc.chz_actual += r.chz_actual;
    acc.chz_n++;
  }
```

- [ ] **Step 4: Expose it**

In `finalize()`, after the `labor_partial:` line add:

```js
    // Ideal - actual: positive means less cheese used than ideal, which is good.
    cheese_var:      acc.chz_n ? r2(acc.chz_ideal - acc.chz_actual) : null,
    cheese_coverage: `${acc.chz_n}/${acc.stores}`,
```

and beside `const r1 = ...` on line 156 add:

```js
// Cheese is reported to the cent; r1 would turn 1.90 into 1.9 and lose the
// precision the report itself publishes.
const r2 = n => Math.round(n * 100) / 100;
```

- [ ] **Step 5: Confirm nothing regressed**

Run: `npm test`
Expected: PASS. Cheese is additive and null-safe, so every existing assertion holds.

- [ ] **Step 6: Commit**

```bash
git add services/scorecard.js
git commit -m "Roll cheese usage up to whoever is reading

buildScorecard already groups by the reader's scope, so joining the
indicator here is what makes an Area Coach's text carry his stores and
a VP's carry the territory -- without a second scoping mechanism that
could disagree with the first one.

Summed rather than averaged: usage is in units, so a group's variance
is the sum of its stores'. Averaging percentages across stores of
different volumes would be wrong, which is why WIN next door is
survey-weighted instead.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: Print it

**Files:**
- Modify: `services/brief-sms.js:208-224` (the own-summary line) and `services/brief-sms.js:252-259` (the per-row detail)
- Create: `tests/brief-cheese.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// tests/brief-cheese.test.js
const { renderForSms } = require('../services/brief-sms');

const own = (over = {}) => ({
  label: 'REGION', stores: 3, sales: 93614, growth_pct: 19.6,
  ist: 19.9, act_hrs: 100, sch_hrs: 72, hrs_variance: 28, labor_partial: false,
  win: 56, missed_routines: 6, cheese_var: -48.22, ...over,
});

describe('cheese in the sms', () => {
  test('favorable variance carries a plus', () => {
    const body = renderForSms({ level: 'region', childLevel: 'area', own: own({ cheese_var: 1.9 }), rows: [] });
    expect(body).toContain('chz +1.90');
  });

  test('unfavorable variance carries a minus', () => {
    const body = renderForSms({ level: 'region', childLevel: 'area', own: own(), rows: [] });
    expect(body).toContain('chz -48.22');
  });

  test('it sits on the labor line, after WIN', () => {
    const body = renderForSms({ level: 'region', childLevel: 'area', own: own(), rows: [] });
    expect(body).toMatch(/Labor \+28h · WIN 56\.0% PTD · chz -48\.22/);
  });

  test('each breakdown row carries its own', () => {
    const body = renderForSms({
      level: 'region', childLevel: 'area', own: own(),
      rows: [{ label: 'Darian Spikes', sales: 18224, growth_pct: 3.3, ist: 19.0, win: 50,
               hrs_variance: -7, missed_routines: 1, cheese_var: 1.9 }],
    });
    expect(body).toContain('chz +1.90');
  });

  test('absent cheese prints nothing and is named as not reporting', () => {
    const body = renderForSms({ level: 'region', childLevel: 'area', own: own({ cheese_var: null }), rows: [] });
    expect(body).not.toContain('chz');
    expect(body).toContain('Chz not reporting');
  });

  test('a row with no cheese simply omits the field', () => {
    const body = renderForSms({
      level: 'region', childLevel: 'area', own: own(),
      rows: [{ label: 'Darian Spikes', sales: 18224, growth_pct: 3.3, ist: 19.0, win: 50,
               hrs_variance: -7, missed_routines: 1, cheese_var: null }],
    });
    expect(body.split('\n').filter(l => l.includes('chz')).length).toBe(1);   // the own line only
  });

  test('zero is a real variance, not an absence', () => {
    const body = renderForSms({ level: 'region', childLevel: 'area', own: own({ cheese_var: 0 }), rows: [] });
    expect(body).toContain('chz +0.00');
    expect(body).not.toContain('Chz not reporting');
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx jest tests/brief-cheese.test.js`
Expected: FAIL — the `chz` assertions find nothing.

**If `renderForSms` is not exported, add it to the `module.exports` list in `services/brief-sms.js` before running.**

- [ ] **Step 3: Add the shared formatter**

Near the other small formatters at the top of `services/brief-sms.js`, add:

```js
// Signed to two places: "+1.90" reads as favorable at a glance, matching the
// L+30 two fields earlier on the same line. Zero is a real reading and prints
// as +0.00; only null means the report had nothing.
const chz = v => 'chz ' + (v >= 0 ? '+' : '') + v.toFixed(2);
```

- [ ] **Step 4: Print it on the own-summary line**

In `renderForSms`, after the `if (o.win != null) have.push(...)` line add:

```js
  if (o.cheese_var != null) have.push(chz(o.cheese_var));
```

and in the `missing` block, after `if (o.win == null) missing.push('WIN');` add:

```js
  if (o.cheese_var == null) missing.push('Chz');
```

- [ ] **Step 5: Print it on each row**

In the `for (const r of ordered)` loop, after the `hrs_variance` push and before the `missed_routines` push, add:

```js
      if (r.cheese_var != null) detail.push(chz(r.cheese_var));
```

Order matters: cheese sits between labor and the missed-routines count so the row reads money, speed, quality, labor, cheese, exceptions — exceptions stay last, where the eye already looks for them.

- [ ] **Step 6: Run the tests**

Run: `npx jest tests/brief-cheese.test.js`
Expected: PASS, 7 tests.

- [ ] **Step 7: Run the whole suite**

Run: `npm test`
Expected: PASS, including the existing brief-condense and brief-due tests.

- [ ] **Step 8: Read a real composed text before anything sends**

```bash
node -e "
require('./services/brief-sms').buildBody('hlacoste', '2026-10-12')
  .then(b => { console.log('--- %d chars ---', (b||'').length); console.log(b); })
  .catch(e => console.error('FAILED:', e.message));
"
```

Expected: the familiar text with `chz` on the summary line and on each area row. Confirm the character count stays under `PAI_BRIEF_MAX_CHARS` (1200).

**Read this output before arming the sender.** It is the last point at which a wrong sign or a misplaced field costs nothing.

- [ ] **Step 9: Commit**

```bash
git add services/brief-sms.js tests/brief-cheese.test.js
git commit -m "Put cheese variance in the morning text

One field on the summary line and one on each breakdown row, so each
reader sees their own stores' number and nobody gets a per-store list
they did not ask for.

Signed to two places: +1.90 means less cheese used than ideal, which
is favorable, and reads at a glance the way L+30 does two fields
earlier. Zero prints as +0.00 because zero is a reading; only a null
means the report had nothing, and that says so rather than going quiet.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 7: Cheese in the full morning brief memo

Everything from here reads rows Task 4 already stored, so it cannot affect the 8:05 text.

**Files:**
- Modify: `services/claude.js:1503-1572` (`generateMorningBrief`, the scorecard section)

- [ ] **Step 1: Add it to the deterministic scorecard block**

`generateMorningBrief` receives `scorecard`, whose `own` and `rows` now carry `cheese_var` from Task 5. In the rendered scorecard table — not in the model's lede — add a cheese column alongside the labor one, formatted `+1.90` / `-48.22`.

- [ ] **Step 2: Keep it out of the lede prompt**

Add one line to the `ledePrompt` numbers block:

```js
  Cheese variance ${own.cheese_var == null ? 'no data' : (own.cheese_var >= 0 ? '+' : '') + own.cheese_var.toFixed(2)}
```

The model may mention it; it never renders it. The rule the existing brief lives by is that numbers come from the scorecard and prose comes from the model.

- [ ] **Step 3: Verify against a real brief**

```bash
node scripts/test-brief-render.js 2026-10-12
```
Expected: the memo shows cheese in the scorecard table, and any mention in the lede matches that number exactly.

- [ ] **Step 4: Commit**

```bash
git add services/claude.js
git commit -m "Show cheese variance in the full morning brief

Rendered from the scorecard, not written by the model, for the same
reason every other number in this brief is: a model that can write a
number can write the wrong one.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 8: Cheese in the daily intel view

**Files:**
- Modify: `public/intel.html`

- [ ] **Step 1: Add the column**

Add cheese variance to the scorecard table, matching the labor column's formatting and its "—" treatment for a null.

- [ ] **Step 2: Check it in the browser**

Load `/intel.html` and confirm the column shows for a day that has data, and shows "—" rather than 0.00 for a store that reported nothing.

- [ ] **Step 3: Commit**

```bash
git add public/intel.html
git commit -m "Show cheese variance on the daily intel page

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Deployment, before 6:00 AM Eastern

- [ ] **Step 1: Full suite green**

Run: `npm test`
Expected: PASS — the 65 existing tests plus 16 new ones.

- [ ] **Step 2: Set the territory id on Render**

Add `ODS_TERRITORY_ID = 26` to the `pai-ayvaz` service. The code defaults to `26`, so this is only so the value can be changed without a deploy when the territory widens to the whole company.

- [ ] **Step 3: Push and confirm the deploy finished before 6:00 AM Eastern**

A deploy that lands at 6:05 misses the pull, and the 8:05 text goes out without cheese.

- [ ] **Step 4: After the 6:00 AM pull, confirm the rows landed**

```bash
node -e "
const db = require('./services/db');
db.getPool().query(\"SELECT COUNT(*) AS n, MIN(value) AS min_act, MAX(target) AS max_ideal FROM dbs_soft_indicators WHERE indicator='cheese_usage' AND metric_date=\$1\", ['2026-10-13'])
  .then(r => console.log(r.rows[0]));
"
```
Expected: a non-zero count. Zero means the pull failed — check the pipeline log for `SUS_DBS failed`.

- [ ] **Step 5: Read the text before 8:05**

Re-run Task 6 Step 8 against today's date. This is the last check before it sends to a phone.

---

## Self-Review

**Spec coverage.** Pull with the territory parameters — Task 1. Parse the cheese row — Task 3. Per-store lookup — Task 3. Scoped per reader so Darian sees only his stores — Task 5. `chz` after labor in the text — Task 6. Daily intel and the brief memo — Tasks 7 and 8. Run for yesterday — Task 1 Step 2 passes the real target date, and the pipeline already runs on yesterday. Blank numbers at 1am — Task 3 skips them and Task 6 says "Chz not reporting". Test on Harold's message only — `PAI_BRIEF_RECIPIENTS` already defaults to `['hlacoste']` and this plan does not change it.

**Placeholders.** Tasks 7 and 8 describe their edits without full code blocks, because both touch rendering whose surrounding markup has to be read first. They are after the deadline and not on the text path. Every task before them carries complete code.

**Type consistency.** `cheese_var` is the field name in `finalize()` (Task 5), the renderer (Task 6), the memo (Task 7) and the page (Task 8). The indicator string is `cheese_usage` in the parser (Task 3), the pipeline write (Task 4) and the SQL join (Task 5). `value` is always actual and `target` is always ideal, in all four.

**One deliberate gap.** Nothing writes the variance itself to the database; every consumer computes `target - value`. One subtraction repeated four times is cheaper than a stored third number that can disagree with the two it came from.
