'use strict';
/**
 * Reads the OWASP CSRF token out of OneDataSource's /asp/JavaScriptServlet
 * response, which is a bare "name:value" line.
 *
 * Why this is its own file: both intel-ods.js and velocity-ods.js split that
 * response on the first colon, and neither checked what it was splitting. On
 * 2026-10-08 the servlet answered with a 404 HTML page, whose first colon sits
 * inside "body {font-family: ...". That handed back a token NAME 120 characters
 * long which was then set as a request header, so node-fetch threw
 *
 *   <!doctype html>...<style type="text/css">body {font-family
 *   is not a legal HTTP header name
 *
 * and that string became the error for DBS, SOS, clock-out, cancel-after-tender
 * and change-down alike. Four unrelated steps reporting the same nonsense hides
 * the one fact that matters: ODS did not answer. The morning text then went out
 * with no sales and no growth and said nothing about it.
 */

// The servlet returns an OWASP CSRFGuard token name — a short identifier, never
// markup. Anything else means we are looking at an error page.
const TOKEN_NAME = /^[A-Za-z0-9_.-]{1,64}$/;

function parseCsrf(text, status) {
  const body = String(text == null ? '' : text);

  if (status != null && (status < 200 || status >= 300)) {
    throw new Error(`ODS CSRF endpoint returned HTTP ${status}: ${summarize(body)}`);
  }

  const colon = body.indexOf(':');
  if (colon < 0) throw new Error(`Unexpected CSRF response: ${summarize(body)}`);

  const name  = body.substring(0, colon).trim();
  const value = body.substring(colon + 1).trim();

  if (!TOKEN_NAME.test(name) || !value) {
    throw new Error(`ODS returned a page, not a CSRF token: ${summarize(body)}`);
  }
  return { name, value };
}

// Error pages are long and mostly markup. Pull the human part out when there is
// one so the log says "HTTP Status 404 - Not Found" rather than a doctype.
function summarize(body) {
  const title = body.match(/<title>([^<]{1,120})<\/title>/i);
  if (title) return title[1].replace(/\s+/g, ' ').trim();
  return body.replace(/\s+/g, ' ').trim().substring(0, 120) || '(empty response)';
}

module.exports = { parseCsrf, summarize };
