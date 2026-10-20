// tests/dm-tracker.test.js
//
// The DM (Area Coach) view of Tracker. Two things are worth pinning down:
//
//   1. A DM's matrix rows are their own stores, built from the same ORG literal
//      the RDO view uses. Get that wrong and the board is empty or, worse, shows
//      somebody else's stores.
//   2. Scope on a send. The recipient check used to compare a LIST of names
//      against one name, which refused every multi-recipient send outright and
//      is the reason a DM's "remind me" had nowhere to go.
//
// dmOrgEntry lives in the page, so it is lifted out of the HTML rather than
// copied here — a copy would keep passing after the page changed.

const fs = require('fs');
const path = require('path');

const { outOfScope } = require('../routes/tracker');
const { USER_ROSTER } = require('../routes/auth');

const darian = USER_ROSTER.find(u => u.username === 'dspikes');   // area coach / DM
const harold = USER_ROSTER.find(u => u.username === 'hlacoste');  // their RDO

// ── Lift dmOrgEntry and the ORG literal out of tracker.html ─────────────────
function loadFromPage() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'tracker.html'), 'utf8');

  const fnStart = html.indexOf('function dmOrgEntry(');
  expect(fnStart).toBeGreaterThan(-1);          // renamed or deleted → fix this test with it
  const fnEnd = html.indexOf('\n}', fnStart) + 2;
  const fnSrc = html.slice(fnStart, fnEnd);

  const orgStart = html.indexOf('const ORG');
  expect(orgStart).toBeGreaterThan(-1);
  const orgEnd = html.indexOf('\n};', orgStart) + 3;
  const orgSrc = html.slice(orgStart, orgEnd);

  // eslint-disable-next-line no-new-func
  return new Function(`${orgSrc}\n${fnSrc}\nreturn { ORG, dmOrgEntry };`)();
}

const { ORG, dmOrgEntry } = loadFromPage();

describe("a DM's matrix rows", () => {
  const entry = dmOrgEntry('Darian Spikes');
  const hisStores = ORG['Harold Lacoste'].acs.find(a => a.name === 'Darian Spikes').stores;

  test('is one row per store they own, and no more', () => {
    expect(entry.acs).toHaveLength(hisStores.length);
    expect(hisStores.length).toBeGreaterThan(0);
  });

  test('labels each row with the store number and name', () => {
    const s = hisStores[0];
    expect(entry.acs[0].name).toBe(`${s.num} · ${s.name}`);
  });

  test('row names are unique, because notes and flags are keyed by them', () => {
    const names = entry.acs.map(r => r.name);
    expect(new Set(names).size).toBe(names.length);
  });

  test('carries no sub-label, so no row claims to be an Area', () => {
    expect(entry.acs.every(r => r.sub === '')).toBe(true);
  });

  test('names the area it belongs to', () => {
    expect(entry.region).toBe('Area 2011');
  });

  test('holds no other area coach, and nobody else’s stores', () => {
    const mine = new Set(hisStores.map(s => s.num));
    expect(entry.acs.every(r => mine.has(r.stores[0].num))).toBe(true);
  });

  test('matches a roster name that carries a parenthetical', () => {
    // The roster says "Imran Awan (Kiosks-Express)"; ORG says "Imran Awan".
    expect(dmOrgEntry('Imran Awan (Kiosks-Express)').acs.length).toBeGreaterThan(0);
  });

  test('an unknown name gets an empty board, not a crash or somebody else’s', () => {
    expect(dmOrgEntry('Nobody At All')).toEqual({ region: '', acs: [] });
  });
});

describe('scope on a send', () => {
  test('a DM may text themselves', () => {
    expect(outOfScope(darian, { to: ['Darian Spikes'] })).toBeNull();
  });

  test('a DM may not text a peer in another area', () => {
    expect(outOfScope(darian, { to: ['Ebony Simmons'] })).toBe('Ebony Simmons');
  });

  test('a list of recipients is allowed when every one is in scope', () => {
    expect(outOfScope(harold, { to: ['Darian Spikes', 'Ebony Simmons'] })).toBeNull();
  });

  test('one out-of-scope name refuses the whole list', () => {
    expect(outOfScope(harold, { to: ['Darian Spikes', 'Brenda Marta'] })).toBe('Brenda Marta');
  });

  test('a single name still works, list or not', () => {
    expect(outOfScope(harold, { to: 'Darian Spikes' })).toBeNull();
    expect(outOfScope(harold, { person: 'Brenda Marta' })).toBe('Brenda Marta');
  });

  test('no recipient is nothing to refuse — the send fails on its own merits', () => {
    expect(outOfScope(darian, {})).toBeNull();
  });
});
