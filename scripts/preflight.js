#!/usr/bin/env node
/**
 * Is the live thing actually going to work when eighty people open it?
 *
 * Written the night four separate faults stacked on top of each other hours
 * before a launch, each one hiding the next: a phone that would not open a
 * video, an API key with no credit behind it, a reading that called a step it
 * could not see "done", and a video read against the wrong list of steps. The
 * tests passed through all four. They had to — every one of them lived in the
 * join between this code and something outside it.
 *
 * So this talks to the real site over the real network with the real key, and
 * it is the last thing to run before anybody says a walk is ready.
 *
 *   npm run preflight                     — the live site
 *   npm run preflight -- http://localhost:3000
 *   npm run preflight -- --no-model       — skip the one check that costs money
 *
 * Exits non-zero if anything fails, so it can gate a deploy later.
 */
const crypto = require('crypto');

const args = process.argv.slice(2);
const BASE = (args.find(a => /^https?:\/\//.test(a)) || 'https://pai-ayvaz.onrender.com')
  .replace(/\/+$/, '');
const SKIP_MODEL = args.includes('--no-model');

// A 1x1 white JPEG. The reading will have nothing to say about it, which is
// fine: this is asking whether the call is allowed to happen at all, which is
// the question that went unanswered for a whole evening.
const DOT = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a'
  + 'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAA'
  + 'AAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==', 'base64');

const results = [];
const ok   = (what, detail) => results.push({ pass: true,  what, detail });
const bad  = (what, detail) => results.push({ pass: false, what, detail });
const skip = (what, detail) => results.push({ skip: true,  what, detail });

const get = async path => {
  const res = await fetch(BASE + path);
  const type = res.headers.get('content-type') || '';
  return { res, body: type.includes('json') ? await res.json().catch(() => null) : null };
};

async function main() {
  // ── Is it up, and is it the build we think it is ──────────────────────────
  try {
    const { res, body } = await get('/health');
    if (!res.ok || !body) bad('server', `/health returned ${res.status}`);
    else ok('server', `up, ${body.uptimeSec}s since the last restart`);
  } catch (err) {
    bad('server', err.message);
    return report();                       // nothing else can pass
  }

  // ── Every walk a store could open ─────────────────────────────────────────
  const ids = require('fs').readdirSync(__dirname + '/../data/audits')
    .filter(f => f.endsWith('.json')).map(f => f.replace(/\.json$/, ''));

  let videoWalk = null;
  for (const id of ids) {
    const { res, body } = await get('/api/audits/form?id=' + encodeURIComponent(id));
    if (!res.ok || !body || !Array.isArray(body.questions)) {
      bad(id, `the form did not come back (${res.status})`);
      continue;
    }
    const qs = body.questions;

    // The answer key must never reach a phone. publicForm strips it; this is
    // the check that it kept doing so.
    const leaks = qs.filter(q => q.correct !== undefined || q.explanation !== undefined
      || q.allDone !== undefined).map(q => q.n);
    if (leaks.length) bad(id, `the answer key went out with questions ${leaks.join(', ')}`);

    // Every picture a question points at. A 404 here is a question nobody can
    // answer, and it only shows up on a phone.
    for (const q of qs.filter(q => q.image)) {
      const img = await fetch(BASE + q.image);
      if (!img.ok) bad(id, `question ${q.n}'s picture is missing (${q.image} → ${img.status})`);
    }

    // The trap that cost an evening: two questions can point at the same video
    // — the yes/no and the list of steps — and anything that picks one by
    // compareTo alone gets whichever comes first.
    for (const v of qs.filter(q => q.type === 'video')) {
      const pointing = qs.filter(q => Number(q.compareTo) === v.n);
      const lists = pointing.filter(q => q.type === 'multi');
      if (!lists.length) bad(id, `question ${v.n} takes a video with no list of steps to compare it against`);
      else if (lists.length > 1) bad(id, `question ${v.n} has ${lists.length} step lists pointing at it`);
      else if (!videoWalk) videoWalk = { id, n: v.n, steps: lists[0].choices.length };
    }

    if (!results.some(r => !r.pass && r.what === id)) {
      ok(id, `${qs.length} questions, nothing leaked`
        + (qs.some(q => q.type === 'video') ? ', video set up right' : ''));
    }
  }

  // ── The one that costs a penny, and the one that was broken ───────────────
  if (!videoWalk) skip('the reading', 'no walk takes a video');
  else if (SKIP_MODEL) skip('the reading', 'asked to skip it (--no-model)');
  else {
    const form = new FormData();
    form.append('auditId', videoWalk.id);
    form.append('walkId', crypto.randomUUID());
    form.append('n', String(videoWalk.n));
    for (let i = 0; i < 3; i++) {
      form.append('frames', new Blob([DOT], { type: 'image/jpeg' }), `t00${i}.jpg`);
    }
    const res = await fetch(BASE + '/api/audits/read-clip', { method: 'POST', body: form });
    const body = await res.json().catch(() => null);
    if (res.ok && body && body.read) {
      ok('the reading', `the model answered — ${videoWalk.steps} steps, ${videoWalk.id}`);
    } else {
      bad('the reading', `/read-clip returned ${res.status}. `
        + 'Nine times in ten this is the API key: check that an organisation is '
        + 'linked at claude.ai/settings/billing and that it is the one the key '
        + 'belongs to. The plan credit and the usage credit are different pots.');
    }
  }

  report();
}

function report() {
  const pad = Math.max(...results.map(r => r.what.length));
  console.log('\n' + BASE + '\n');
  for (const r of results) {
    console.log(`  ${r.skip ? '–' : r.pass ? '✔' : '✘'} ${r.what.padEnd(pad)}  ${r.detail}`);
  }
  const failed = results.filter(r => !r.pass && !r.skip);
  console.log(failed.length
    ? `\n${failed.length} thing${failed.length > 1 ? 's' : ''} to fix before anybody is sent the link.\n`
    : '\nReady.\n');
  process.exit(failed.length ? 1 : 0);
}

main().catch(err => { console.error('\npreflight fell over:', err.message, '\n'); process.exit(1); });
