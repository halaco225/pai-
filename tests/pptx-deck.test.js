// Claude now decides what slides a deck has, so the renderer gets handed shapes
// nobody wrote by hand: a layout name that does not exist, a table with ragged
// rows, forty scrub items where the template had six. The deck still has to
// come out of the other side, because the alternative is a Regional Director
// with no deck half an hour before a call.

const JSZip = require('jszip');
const PptxGenJS = require('pptxgenjs');
const { renderDeck, hasDeckSpec, LAYOUTS, fit } = require('../services/pptx-deck');
const { applyTheme } = require('../services/pptx-theme');

async function slideCount(buffer) {
  const zip = await JSZip.loadAsync(buffer);
  return Object.keys(zip.files).filter(f => /^ppt\/slides\/slide\d+\.xml$/.test(f)).length;
}

async function render(deck, options = {}) {
  applyTheme(options.theme || 'default');
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  renderDeck(pptx, deck, options);
  return pptx.write({ outputType: 'nodebuffer' });
}

const everyLayout = {
  title: 'P11-26 P&L Review',
  subtitle: 'SE Atlanta Region · 36 stores',
  footer: 'P11-26 · Preliminary · Ayvaz Pizza LLC',
  slides: [
    { layout: 'cover', eyebrow: 'Region Coach Review', meta: [{ label: 'EBITDA', value: '$268.6K', sub: '11.1% of sales' }] },
    { layout: 'metrics', title: 'Headline', metrics: [{ label: 'EBITDA', value: '$268.6K', delta: '+$20.0K vs LY', trend: 'up' }], narrative: ['Margin down 0.3 points on +11.0% sales.'] },
    { layout: 'table', title: 'AC scrub list', columns: ['Store', 'Item', 'Owner'], rows: [['Union City', 'No electric bill in P11', 'Accounting'], { cells: ['Lithia Springs', 'Water up 3x — check for a leak', 'AC'], tier: 'critical' }], note: 'Confirm before final close.' },
    { layout: 'cards', title: 'What to challenge', cards: [{ severity: 'Critical', title: 'Missing electric bills', body: 'Union City, Crossroads and Niceville have no electric in P11.', action: 'Accrue or produce the invoice' }] },
    { layout: 'bridge', title: 'EBITDA bridge', items: [{ driver: 'Food cost', varianceDollars: '-$27,000', bpsImpact: '-110', explanation: 'P&L 27.5% vs PCA 26.4%.', direction: 'headwind' }] },
    { layout: 'bullets', title: 'Method', items: ['Tie P&L sales to FRS.', { heading: 'Labor', text: 'Payroll by pay date, FRS by week — small gaps are timing.' }] },
    { layout: 'twoColumn', title: 'Top and bottom', left: { heading: 'Top', items: ['Wells Street 25.2%'] }, right: { heading: 'Bottom', items: ['Store D -18.4%'] } },
    { layout: 'callout', title: 'The point', statement: 'Most of the P&L vs FRS gap is FRS receiving and counts, not P&L error.', support: ['GL ties to the dollar for 29 stores.'] },
    { layout: 'quotes', title: 'Customer voice', quotes: [{ text: 'Pizza was cold.', store: '#39390', sentiment: 'red' }] },
    { layout: 'closing', title: 'What happens next', items: ['Area Coaches work their scrub list this week.'] },
  ],
};

test('renders one slide per spec entry, covering every layout', async () => {
  const buf = await render(everyLayout);
  expect(await slideCount(buf)).toBe(everyLayout.slides.length);
  // Every layout in the vocabulary is exercised above — if one is added and not
  // covered here, this catches it before Claude starts emitting it.
  const used = new Set(everyLayout.slides.map(s => s.layout));
  LAYOUTS.forEach(l => expect(used.has(l)).toBe(true));
});

test('long lists spill onto extra slides instead of off the page', async () => {
  const rows = Array.from({ length: 48 }, (_, i) => [`Store ${i}`, 'Food over PCA', 'AC']);
  const buf = await render({ slides: [{ layout: 'table', title: 'Scrub', columns: ['Store', 'Item', 'Owner'], rows }] });
  expect(await slideCount(buf)).toBeGreaterThan(1);

  const cards = Array.from({ length: 9 }, (_, i) => ({ severity: 'High', title: `Finding ${i}`, body: 'x'.repeat(400) }));
  const cardBuf = await render({ slides: [{ layout: 'cards', title: 'Findings', cards }] });
  expect(await slideCount(cardBuf)).toBe(3);
});

test('an unknown layout still produces a slide', async () => {
  const buf = await render({ slides: [{ layout: 'sankey-diagram', title: 'Invented', items: ['still here'] }] });
  expect(await slideCount(buf)).toBe(1);
});

test('a malformed slide does not take the deck down with it', async () => {
  const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
  const buf = await render({ slides: [{ layout: 'table', title: 'Bad', columns: ['A'], rows: [null, 3] }, { layout: 'bullets', title: 'Good', items: ['ok'] }] });
  expect(await slideCount(buf)).toBe(2);
  spy.mockRestore();
});

test('empty and missing fields render rather than throw', async () => {
  const buf = await render({ slides: [{ layout: 'metrics' }, { layout: 'table' }, { layout: 'cards' }, { layout: 'twoColumn' }, { layout: 'closing' }] });
  expect(await slideCount(buf)).toBe(5);
});

test('hasDeckSpec only fires on a real spec', () => {
  expect(hasDeckSpec({ deck: { slides: [{ layout: 'cover' }] } })).toBe(true);
  expect(hasDeckSpec({ deck: { slides: [] } })).toBe(false);
  expect(hasDeckSpec({ slide2: {} })).toBe(false);
  expect(hasDeckSpec(null)).toBe(false);
});

test('font size shrinks with length but never below the floor', () => {
  expect(fit('short', 60, 12)).toBe(12);
  expect(fit('x'.repeat(240), 60, 12)).toBeLessThan(12);
  expect(fit('x'.repeat(5000), 60, 12, 7)).toBe(7);
});
