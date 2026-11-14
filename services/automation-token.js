'use strict';
/**
 * The automation token, and the only place that decides whether a request
 * carries it.
 *
 * It used to be a literal — the same 32 characters in nine files and, worse,
 * in render.yaml — and this repo is public. Anyone who read the source could
 * run the pipeline, read its logs, regenerate the cache and post uploads. The
 * comments around those literals argued the endpoints were low risk, which
 * stopped being true once they grew to include the logs and the uploads.
 *
 * Now it comes from the environment and nowhere else. With no env var set, a
 * random token is made at boot: the callers inside this process (the
 * scheduler, the brief SMS sender) keep working, and anything outside it is
 * refused until INTEL_AUTOMATION_TOKEN is set in the Render dashboard.
 */
const crypto = require('crypto');

const BOOT_TOKEN = crypto.randomBytes(24).toString('hex');
let warned = false;

function automationToken() {
  const t = process.env.INTEL_AUTOMATION_TOKEN;
  if (t) return t;
  if (!warned) {
    warned = true;
    console.warn('[automation] INTEL_AUTOMATION_TOKEN is not set — external automation is refused for this boot.');
  }
  return BOOT_TOKEN;
}

// Constant-time, and length is compared first because timingSafeEqual throws
// on a length mismatch.
function sameToken(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/**
 * Does this request carry the automation token?
 * `regen: true` also accepts INTEL_REGEN_TOKEN, which the cache and log
 * endpoints have always taken.
 */
function tokenOk(req, { regen = false } = {}) {
  const given = (req && req.headers && req.headers['x-automation-token'])
             || (req && req.query && req.query.token);
  if (!given) return false;
  const accepted = [automationToken()];
  if (regen && process.env.INTEL_REGEN_TOKEN) accepted.push(process.env.INTEL_REGEN_TOKEN);
  return accepted.some(t => sameToken(given, t));
}

module.exports = { automationToken, tokenOk, sameToken };
