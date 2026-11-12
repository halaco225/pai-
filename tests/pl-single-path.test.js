// The P&L analyzer used to ask Harold four questions before it would look at a
// file — analysis level, which target, which deck theme, which cover logo —
// and then rendered whichever of four fixed templates the level pointed at.
// He wants it to behave like dropping a P&L into a chat: read the file, work
// out what it covers, review it against the review parameters, then offer a
// deck or a 1-pager. These tests exist so a picker cannot creep back in.

const fs = require('fs');
const path = require('path');

const read = f => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
const page  = read('public/pl-analyzer.html');
const route = read('routes/pl.js');
const svc   = read('services/claude.js');

test('the page asks nothing about the deck', () => {
  for (const gone of ['level-btn', 'Analysis Level', 'themePanel', 'THEME_OPTIONS',
                      'selectLogo', 'logo-option', 'Cover Logo', 'targetSelect']) {
    expect(page).not.toContain(gone);
  }
});

test('the page still takes the optional sources and the focus note', () => {
  for (const kept of ['id="frsFile"', 'id="ledgerFile"', 'id="analysisInstructions"']) {
    expect(page).toContain(kept);
  }
});

test('the page offers both downloads after the analysis', () => {
  expect(page).toContain('downloadPPTX()');
  expect(page).toContain('downloadOnePager()');
  expect(page).toMatch(/PowerPoint or a 1-pager/);
});

test('one analysis path — the file decides the scope, not a button', () => {
  expect(page).toMatch(/let currentLevel = 'auto'/);
  expect(route).toMatch(/req\.body\.level\s*\|\|\s*'auto'/);
  expect(svc).toMatch(/levelInstructions\[level\] \|\| levelInstructions\.auto/);
  expect(svc).toMatch(/^\s{4}auto: `/m);
});

test('a Claude-designed deck renders as its own slides whoever asked for it', () => {
  // Before this, an area coach's request went to the fixed AC template on role
  // alone, which drops every slide Claude designed.
  const { hasDeckSpec } = require('../services/pptx-deck');
  expect(route).toContain('hasDeckSpec(analysis)');
  expect(route.indexOf('hasDeckSpec(analysis)'))
    .toBeLessThan(route.indexOf("role === 'area_coach'"));
  expect(hasDeckSpec({ deck: { slides: [{ layout: 'cover' }] } })).toBe(true);
  expect(hasDeckSpec({ summary: {} })).toBe(false);
});
