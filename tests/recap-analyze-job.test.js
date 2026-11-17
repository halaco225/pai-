// A full weekly recap takes two or three minutes. Cloudflare cuts any request
// at 100 seconds, so the old synchronous POST lost the connection every time and
// the page showed "Failed to fetch" while the analysis carried on and mockSaved
// itself — the operator had no way to see it had worked.
//
// The request now starts the work and hands back a ticket. These pin the ticket
// down: it comes back before the analysis does, it reports progress honestly,
// and it belongs to the person who asked for it.

const express = require('express');
const request = require('supertest');

// A session for whoever the current test is acting as.
let mockActingAs = 'tester';
jest.mock('../middleware/auth', () => ({
  requireAuth: (req, res, next) => {
    req.session = { user: { username: mockActingAs, name: 'Test Person', role: 'rdo' } };
    next();
  },
  requireRole: () => (req, res, next) => next(),
}));

// Hold the analysis open so we can look at the job while it is still running.
let mockAnalysis;
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

jest.mock('../services/claude', () => ({
  analyzeRecap: jest.fn(() => mockAnalysis.promise),
}));

const mockSaved = [];
jest.mock('../services/db', () => ({
  getAlignment: jest.fn(async () => null),
  getRecapSessions: jest.fn(async () => []),
  getRecapSessionById: jest.fn(async () => null),
  saveRecapSession: jest.fn(async (row) => { mockSaved.push(row); }),
}));

const app = express();
app.use('/api/recap', require('../routes/recap'));

const postAnalyze = () => request(app)
  .post('/api/recap/analyze')
  .attach('files', Buffer.from('a report'), 'week.xlsx');

const settle = () => new Promise(r => setImmediate(r));

beforeEach(() => {
  mockActingAs = 'tester';
  mockAnalysis = deferred();
  mockSaved.length = 0;
});

describe('starting an analysis', () => {
  test('hands back a ticket at once, without waiting for Claude', async () => {
    const res = await postAnalyze();
    expect(res.status).toBe(202);
    expect(typeof res.body.jobId).toBe('string');
    expect(res.body.jobId.length).toBeGreaterThan(0);
    // The mockAnalysis has not finished — the response did not wait for it.
    expect(res.body.data).toBeUndefined();
    mockAnalysis.resolve({ weekLabel: 'P11W3' });
  });

  test('refuses with nothing to read', async () => {
    const res = await request(app).post('/api/recap/analyze');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least one report file/i);
    mockAnalysis.resolve({});
  });
});

describe('asking for the result', () => {
  test('pending while it runs, then the analysis', async () => {
    const { body: { jobId } } = await postAnalyze();

    const mid = await request(app).get(`/api/recap/analyze/${jobId}`);
    expect(mid.status).toBe(200);
    expect(mid.body.status).toBe('pending');
    expect(mid.body.elapsedMs).toBeGreaterThanOrEqual(0);

    mockAnalysis.resolve({ weekLabel: 'P11W3', slides: { scorecard: {} } });
    await settle();

    const done = await request(app).get(`/api/recap/analyze/${jobId}`);
    expect(done.body.status).toBe('done');
    expect(done.body.data.weekLabel).toBe('P11W3');
    expect(done.body.fileCount).toBe(1);
    expect(done.body.fileNames).toBe('week.xlsx');
  });

  test('the finished analysis is still saved to history', async () => {
    const { body: { jobId } } = await postAnalyze();
    mockAnalysis.resolve({ weekLabel: 'P11W3' });
    await settle();
    await request(app).get(`/api/recap/analyze/${jobId}`);
    expect(mockSaved).toHaveLength(1);
    expect(mockSaved[0]).toMatchObject({ username: 'tester', fileNames: 'week.xlsx', weekLabel: 'P11W3' });
  });

  test('a failure comes back as the reason, not a dead connection', async () => {
    const { body: { jobId } } = await postAnalyze();
    mockAnalysis.reject(new Error('the model refused'));
    await settle();

    const res = await request(app).get(`/api/recap/analyze/${jobId}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('error');
    expect(res.body.error).toBe('the model refused');
  });

  test('clarifying questions come through and are not saved as a week', async () => {
    const { body: { jobId } } = await postAnalyze();
    mockAnalysis.resolve({ needsInput: true, questions: ['which area?'] });
    await settle();

    const res = await request(app).get(`/api/recap/analyze/${jobId}`);
    expect(res.body.status).toBe('done');
    expect(res.body.needsInput).toBe(true);
    expect(mockSaved).toHaveLength(0);
  });
});

describe('a ticket belongs to the person who asked', () => {
  test('somebody else cannot read it', async () => {
    const { body: { jobId } } = await postAnalyze();
    mockAnalysis.resolve({ weekLabel: 'P11W3' });
    await settle();

    mockActingAs = 'someone-else';
    const res = await request(app).get(`/api/recap/analyze/${jobId}`);
    expect(res.status).toBe(404);
    expect(res.body.status).toBe('unknown');
  });

  test('an id the server never issued says to check History rather than nothing', async () => {
    const res = await request(app).get('/api/recap/analyze/not-a-real-job');
    expect(res.status).toBe(404);
    // The restart case: the work may well have finished and mockSaved.
    expect(res.body.error).toMatch(/history/i);
    mockAnalysis.resolve({});
  });
});
