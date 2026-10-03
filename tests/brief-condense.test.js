// tests/brief-condense.test.js
const { condense, MAX_SMS_CHARS, buildLink } = require('../services/brief-sms');

const FAKE_BRIEF = `MORNING BRIEF — Oct 3, 2026 — P8W2
Results from Oct 2 (Friday)

PERFORMANCE
Sales: $412,880 — up 3.2% vs LY. Transactions down 1.1%.
Labor: 27.4% vs 26.0% target — 1.4 points over, driven by Area 2016.

FLAGS
3 stores with Cancel After Tender over threshold: 39393 Lovejoy,
39461 County Line, 39521 Kellytown.
Forgot Clock Out: 11 instances, 7 at 39383 Stockbridge.

SHOUTOUTS
Jadon McNeil's area hit 100% on Crispy Pan execution.`;

// The model is not called in unit tests — it is injected.
function fakeModel(text) {
  return async () => text;
}

describe('condense', () => {
  test('stays within one concatenated message', async () => {
    const out = await condense(FAKE_BRIEF, 'https://pai-ayvaz.onrender.com/intel.html', {
      callModel: fakeModel('Sales +3.2%, labor 1.4pts over. 3 CAT stores, 11 forgot clock-outs.'),
    });
    expect(out.length).toBeLessThanOrEqual(MAX_SMS_CHARS);
  });

  test('always carries the link, even if the model omits it', async () => {
    const out = await condense(FAKE_BRIEF, 'https://pai-ayvaz.onrender.com/intel.html', {
      callModel: fakeModel('Sales +3.2%, labor over.'),
    });
    expect(out).toContain('https://pai-ayvaz.onrender.com/intel.html');
  });

  // A model that ignores the length instruction must not produce a 7-part text.
  test('truncates an over-long model response rather than sending it', async () => {
    const out = await condense(FAKE_BRIEF, 'https://x.co/b', {
      callModel: fakeModel('x'.repeat(2000)),
    });
    expect(out.length).toBeLessThanOrEqual(MAX_SMS_CHARS);
    expect(out).toContain('https://x.co/b');
  });

  // A model that echoes a URL must not cost us a third of the message.
  test('strips a URL the model added and appends the real one once', async () => {
    const out = await condense(FAKE_BRIEF, 'https://x.co/b', {
      callModel: fakeModel('Sales up. See https://wrong.example.com/page for detail.'),
    });
    expect(out).not.toContain('wrong.example.com');
    expect(out.match(/https?:\/\//g)).toHaveLength(1);
  });

  // If the model is unreachable at 8:05 the brief still goes out.
  test('falls back to the brief first lines when the model throws', async () => {
    const out = await condense(FAKE_BRIEF, 'https://x.co/b', {
      callModel: async () => { throw new Error('rate limit'); },
    });
    expect(out.length).toBeLessThanOrEqual(MAX_SMS_CHARS);
    expect(out).toContain('https://x.co/b');
    expect(out.toLowerCase()).toContain('brief');
  });

  test('falls back when the model returns nothing usable', async () => {
    const out = await condense(FAKE_BRIEF, 'https://x.co/b', { callModel: fakeModel('   ') });
    expect(out.length).toBeLessThanOrEqual(MAX_SMS_CHARS);
    expect(out).toContain('https://x.co/b');
  });

  // Found by running it: with no key the SDK retried with backoff against its
  // 10-minute default timeout, so the fallback never fired and the 8:05 text
  // would just not arrive. callClaude now fails fast instead.
  test('falls back immediately when no API key is configured', async () => {
    const saved = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const started = Date.now();
      const out = await condense(FAKE_BRIEF, 'https://x.co/b');   // real callClaude
      expect(out).toContain('https://x.co/b');
      expect(out.length).toBeLessThanOrEqual(MAX_SMS_CHARS);
      expect(Date.now() - started).toBeLessThan(2000);
    } finally {
      if (saved !== undefined) process.env.ANTHROPIC_API_KEY = saved;
    }
  });

  test('the condense deadline is well inside the send window', () => {
    const { CONDENSE_TIMEOUT_MS, SEND_WINDOW_MINUTES } = require('../services/brief-sms');
    expect(CONDENSE_TIMEOUT_MS).toBeLessThan(SEND_WINDOW_MINUTES * 60 * 1000);
  });

  test('returns null for an empty brief rather than texting nothing', async () => {
    expect(await condense('', 'https://x.co/b', { callModel: fakeModel('hi') })).toBeNull();
    expect(await condense(null, 'https://x.co/b', { callModel: fakeModel('hi') })).toBeNull();
  });
});

describe('buildLink', () => {
  test('uses PAI_BASE_URL when set', () => {
    expect(buildLink({ PAI_BASE_URL: 'https://example.com' })).toBe('https://example.com/intel.html');
  });

  test('falls back to the known deployment', () => {
    expect(buildLink({})).toBe('https://pai-ayvaz.onrender.com/intel.html');
  });

  test('does not double the slash', () => {
    expect(buildLink({ PAI_BASE_URL: 'https://example.com/' })).toBe('https://example.com/intel.html');
  });
});
