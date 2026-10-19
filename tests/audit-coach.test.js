// Every guide the editor offers has to survive being saved.
//
// Picking Pepper looked like it worked and came back as Adam: she was added
// to the list in the browser and not to the list on the server, which quietly
// dropped her on the way into the database. Nothing said so — the save
// succeeded, it just forgot. This reads the editor's own list and checks each
// one makes it through, so the next guide cannot be half-added.

const fs = require('fs');
const path = require('path');
const { cleanTemplate } = require('../services/audit-templates');

const editor = fs.readFileSync(path.join(__dirname, '..', 'public', 'audits.html'), 'utf8');

function guidesTheEditorOffers() {
  const block = editor.match(/const COACHES = \[([\s\S]*?)\];/);
  if (!block) throw new Error('the editor no longer has a COACHES list');
  return [...block[1].matchAll(/\['([a-z]+)',/g)].map(m => m[1]);
}

const base = {
  id: 't', title: 'T', description: '',
  questions: [{ title: 'Name', type: 'text', points: 0 }],
};

describe('choosing a guide', () => {
  const offered = guidesTheEditorOffers();

  test('the editor offers the ones we expect', () => {
    expect(offered).toEqual(expect.arrayContaining(['adam', 'krystina', 'pepper', 'none']));
  });

  test.each(offered)('saving keeps %s', coach => {
    expect(cleanTemplate({ ...base, coach }).coach).toBe(coach);
  });

  test('something that is not a guide is dropped rather than stored', () => {
    expect(cleanTemplate({ ...base, coach: 'gary' }).coach).toBeUndefined();
  });
});
