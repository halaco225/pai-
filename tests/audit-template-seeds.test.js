// Seeding data/audits into the table, which used to happen exactly once per
// database and so never shipped a test added after the first deploy.

jest.mock('../services/db', () => ({ getPool: jest.fn() }));

const fs = require('fs');
const { getPool } = require('../services/db');
const { initAuditTemplates, validateTemplate } = require('../services/audit-templates');

// A pool that records what it was asked and answers the two SELECTs seeding
// makes. `seeded` is the ledger it starts with.
function fakePool(seeded = []) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('SELECT file FROM audit_template_seeds')) {
        return { rows: seeded.map(file => ({ file })) };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

// Which seed files landed in audit_templates, by id.
function inserted(pool) {
  return pool.calls
    .filter(c => c.sql.includes('INSERT INTO audit_templates'))
    .map(c => c.params[0]);
}

// Which files were written to the ledger.
function recorded(pool) {
  return pool.calls
    .filter(c => c.sql.includes('INSERT INTO audit_template_seeds'))
    .map(c => c.params[0]);
}

const files = fs.readdirSync(`${__dirname}/../data/audits`).filter(f => f.endsWith('.json'));

describe('seeding the audit templates', () => {
  afterEach(() => jest.clearAllMocks());

  test('does nothing at all without a database', async () => {
    getPool.mockReturnValue(null);
    await expect(initAuditTemplates()).resolves.toBeUndefined();
  });

  test('an empty ledger takes every file', async () => {
    const pool = fakePool([]);
    getPool.mockReturnValue(pool);
    await initAuditTemplates();

    expect(inserted(pool)).toHaveLength(files.length);
    expect(inserted(pool)).toContain('food-safety-mitt');
    expect(recorded(pool).sort()).toEqual(files.sort());
  });

  test('a file already in the ledger is left alone', async () => {
    const pool = fakePool(files);
    getPool.mockReturnValue(pool);
    await initAuditTemplates();

    expect(inserted(pool)).toEqual([]);
    expect(recorded(pool)).toEqual([]);
  });

  // The case this change exists for: an older database has every template but
  // no ledger, and the one new file has to reach it.
  test('a new file ships on a database that already has the others', async () => {
    const pool = fakePool(files.filter(f => f !== 'food-safety-mitt.json'));
    getPool.mockReturnValue(pool);
    await initAuditTemplates();

    expect(inserted(pool)).toEqual(['food-safety-mitt']);
    expect(recorded(pool)).toEqual(['food-safety-mitt.json']);
  });

  // ON CONFLICT (id) DO NOTHING is what protects a template Harold has since
  // edited in the Audits tab from being overwritten by the file it came from.
  test('the insert never overwrites an existing template', async () => {
    const pool = fakePool([]);
    getPool.mockReturnValue(pool);
    await initAuditTemplates();

    for (const call of pool.calls.filter(c => c.sql.includes('INSERT INTO audit_templates'))) {
      expect(call.sql).toMatch(/ON CONFLICT \(id\) DO NOTHING/);
    }
  });

  // Only templates belong in the seed folder; anything else logs an error on
  // every boot, because a failed insert never reaches the ledger.
  test('every file in the seed folder is a template', () => {
    for (const file of files) {
      const def = JSON.parse(fs.readFileSync(`${__dirname}/../data/audits/${file}`, 'utf8'));
      expect(typeof def.id).toBe('string');
      expect(def.id).not.toHaveLength(0);
      expect(Array.isArray(def.questions)).toBe(true);
    }
  });

  // Every file in the folder is what stores get asked, so a file that would
  // not pass the editor's own checks should not reach the table either.
  test('every file in the seed folder would pass the editor', () => {
    for (const file of files) {
      const def = JSON.parse(fs.readFileSync(`${__dirname}/../data/audits/${file}`, 'utf8'));
      expect({ file, problems: validateTemplate(def) }).toEqual({ file, problems: [] });
    }
  });

  // This insert was written before the columns existed, so a test that
  // shipped by deploy arrived as an audit with nobody walking it: no coach,
  // and the score screen gone.
  test('a seeded walk keeps the kind and the coach its file asks for', async () => {
    const pool = fakePool([]);
    getPool.mockReturnValue(pool);
    await initAuditTemplates();

    const sent = pool.calls.filter(c => c.sql.includes('INSERT INTO audit_templates'));
    expect(sent.length).toBeGreaterThan(0);
    for (const call of sent) {
      expect(call.sql).toMatch(/kind/);
      expect(call.sql).toMatch(/coach/);
    }

    const file = files.find(f => {
      const def = JSON.parse(fs.readFileSync(`${__dirname}/../data/audits/${f}`, 'utf8'));
      return def.coach;
    });
    if (!file) return;                 // no file asks for one, nothing to check
    const want = JSON.parse(fs.readFileSync(`${__dirname}/../data/audits/${file}`, 'utf8'));
    const call = sent.find(c => c.params[0] === want.id);
    expect(call.params).toContain(want.coach);
    expect(call.params).toContain(want.kind);
  });
});
