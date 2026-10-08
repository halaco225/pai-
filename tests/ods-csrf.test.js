// tests/ods-csrf.test.js
const { parseCsrf, summarize } = require('../services/parsers/ods-csrf');

// The real 404 body from 2026-10-08, trimmed. Its first colon is inside the
// stylesheet, which is how a doctype ended up being used as a header name.
const PAGE_404 =
  '<!doctype html><html lang="en"><head><title>HTTP Status 404 – Not Found</title>' +
  '<style type="text/css">body {font-family: Tahoma, Arial, sans-serif;}</style></head>' +
  '<body><h1>HTTP Status 404</h1></body></html>';

describe('parseCsrf', () => {
  test('reads a real token', () => {
    expect(parseCsrf('OWASP_CSRFTOKEN:ABCD-1234-EFGH', 200))
      .toEqual({ name: 'OWASP_CSRFTOKEN', value: 'ABCD-1234-EFGH' });
  });

  test('trims surrounding whitespace', () => {
    expect(parseCsrf('  OWASP_CSRFTOKEN : ABCD \n', 200).value).toBe('ABCD');
  });

  // The bug: this used to succeed and return 120 characters of markup as the
  // token name.
  test('rejects an HTML error page even though it contains a colon', () => {
    expect(() => parseCsrf(PAGE_404, 200)).toThrow(/page, not a CSRF token/);
  });

  test('names the HTTP status when the response is not 2xx', () => {
    expect(() => parseCsrf(PAGE_404, 404)).toThrow(/HTTP 404/);
  });

  // Whatever is wrong, the message has to be readable in the automation log —
  // that log is the only place anyone sees why the morning numbers are absent.
  test('the message carries the page title, not the doctype', () => {
    try { parseCsrf(PAGE_404, 404); } catch (e) {
      expect(e.message).toContain('HTTP Status 404');
      expect(e.message).not.toContain('<!doctype');
    }
  });

  test('rejects a colonless response', () => {
    expect(() => parseCsrf('session expired', 200)).toThrow(/Unexpected CSRF response/);
  });

  test('rejects an empty value', () => {
    expect(() => parseCsrf('OWASP_CSRFTOKEN:', 200)).toThrow(/page, not a CSRF token/);
  });

  test('says so plainly when nothing came back at all', () => {
    expect(() => parseCsrf('', 200)).toThrow(/Unexpected CSRF response: \(empty response\)/);
  });
});

describe('summarize', () => {
  test('prefers the title', () => {
    expect(summarize(PAGE_404)).toBe('HTTP Status 404 – Not Found');
  });

  test('falls back to the first of the body, collapsed', () => {
    expect(summarize('a\n\n  b')).toBe('a b');
  });
});
