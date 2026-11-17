// The weekly recap read like a scoreboard: it coloured in the numbers the
// operator had just uploaded and called that the analysis. The P&L tab does the
// real thing, and the difference was never the deck machinery — both design
// their own slides from the same ten layouts — it was the brief.
//
// The recap prompt was a routing table (this file becomes that slide) with a
// colour-band lookup at the end. The P&L prompt tells the analyst what the
// review is for, what to look at, what makes something worth saying, and how to
// write it down. These keep that brief in the recap prompt, so it cannot quietly
// decay back into assembly instructions.

const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'claude.js'), 'utf8');

const between = (start, end) => {
  const a = src.indexOf(start);
  expect(a).toBeGreaterThan(-1);
  // Search past the start marker: it often begins with the same word as the end one.
  const b = src.indexOf(end, a + start.length);
  expect(b).toBeGreaterThan(a);
  return src.slice(a, b);
};

const recapPrompt = between('const RECAP_SYSTEM_PROMPT =', '\nasync function analyzeRecap');
const plPrompt    = between('const PL_SYSTEM_PROMPT =', '\nconst RECAP_SYSTEM_PROMPT');

describe('the recap is briefed as a review, not an assembly job', () => {
  test('it says what the review is for before it says what to build', () => {
    expect(recapPrompt).toContain('WHAT THIS REVIEW IS FOR');
    const purpose = recapPrompt.indexOf('WHAT THIS REVIEW IS FOR');
    const build   = recapPrompt.indexOf('HOW TO BUILD THIS DECK');
    expect(purpose).toBeLessThan(build);
  });

  test('it carries the same four briefing sections the P&L does', () => {
    for (const section of ['WHAT GETS REVIEWED', 'HOW AN ITEM GETS FLAGGED', 'HOW TO WRITE']) {
      expect(plPrompt).toContain(section);
      expect(recapPrompt).toContain(section);
    }
  });

  test('a finding without a store and a number is not a finding', () => {
    // The P&L says it about dollars; the recap says it about stores and figures.
    expect(plPrompt).toMatch(/A flag with no dollar figure attached is not a flag/);
    expect(recapPrompt).toMatch(/A finding with no store and no number is not a finding/);
  });

  test('restating an uploaded number is explicitly not analysis', () => {
    expect(recapPrompt).toMatch(/has done no work|not a finding/);
    expect(recapPrompt).toMatch(/already seen them|already uploaded/);
  });

  test('fact and inference stay apart, in both', () => {
    expect(plPrompt).toMatch(/Separate fact from inference/);
    expect(recapPrompt).toMatch(/Separate fact from inference/);
  });

  test('it must say what it could not check', () => {
    expect(recapPrompt).toMatch(/State the limits/);
  });

  test('it is told not to invent thresholds of its own', () => {
    expect(recapPrompt).toMatch(/Do not invent a threshold/);
    // The bands it may use are still the ones that were already agreed.
    expect(recapPrompt).toContain('METRIC THRESHOLDS');
  });

  test('one week is a data point, not a trend', () => {
    expect(recapPrompt).toMatch(/Do not call a single week a trend/);
  });
});

describe('the weeks already on record get used', () => {
  const historyBlock = between('=== HISTORICAL CONTEXT', '=== END HISTORICAL CONTEXT');

  test('history is not optional colour', () => {
    expect(historyBlock).toMatch(/not optional/);
  });

  test('a metric is a move, not a bare value', () => {
    expect(historyBlock).toMatch(/move against these weeks/);
  });

  test('recoveries get named, not just the repeat offenders', () => {
    expect(historyBlock).toMatch(/come off the list/);
  });

  test('the old opt-out is gone', () => {
    // "where relevant" let it skip the comparison whenever it liked.
    expect(historyBlock).not.toMatch(/where relevant/);
  });
});

describe('the instructions the model reads last', () => {
  const tail = between('CRITICAL INSTRUCTIONS FOR JSON OUTPUT', 'Return either the needsInput JSON');

  test('the review happens before any JSON is written', () => {
    expect(tail).toMatch(/Before you write a single JSON key, do the review/);
  });

  test('the no-fake-data rule survived', () => {
    expect(tail).toMatch(/NEVER use placeholder text/);
    expect(tail).toMatch(/A slide with fake data is always wrong/);
  });

  test('a slide that only repeats the scorecard is dropped', () => {
    expect(tail).toMatch(/only repeat the scorecard, leave it out/);
  });
});
