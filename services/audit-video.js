/**
 * Reading a video on a walk.
 *
 * The phone takes one still a second off the video and sends the strip here.
 * Claude takes images, not video, so the strip IS the video as far as this
 * goes — and because each still arrives named with its own second, what comes
 * back can say when it saw something, which is the only thing that makes a
 * disagreement worth having: "I did not see soap" is an argument, "I did not
 * see soap, watch 0:06" is something they can go and settle themselves.
 *
 * Nothing here marks anybody. It reports what it saw, step by step, and the
 * route turns that into a comparison with what the walker said they saw.
 */
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-6';

// Enough to see every step of a hand wash at one a second, and a ceiling on
// what one reading can cost. A longer video is read at its first 90 seconds.
const MAX_FRAMES = 90;

/**
 * t014.jpg -> 14, t014_5.jpg -> 14.5.
 *
 * The second a still came from travels in its name, which is how a reading can
 * say when it saw something and so what to tell somebody to go back and watch.
 * A short clip is sampled twice a second — a pump of sanitizer can pass
 * between two whole ones — and the half is the `_5`. An underscore and not a
 * dash because `-` sorts before `.`, which would file every half second ahead
 * of the whole one it follows. Anything named some other way has no second
 * and is dropped.
 */
function frameSecond(name) {
  const m = String(name || '').match(/^t0*(\d+)(?:_(\d))?\./);
  return m ? Number(m[1]) + (m[2] ? Number(m[2]) / 10 : 0) : NaN;
}

/**
 * @param frames [{ second, data (base64), mediaType }]
 * @param steps  the step list to judge, in the walker's own wording
 * @returns { seconds, steps: [{ i, done, at, note }] }
 */
async function readSteps(frames, steps, what) {
  const strip = (frames || [])
    .filter(f => f && f.data)
    .sort((a, b) => a.second - b.second)
    .slice(0, MAX_FRAMES);

  if (strip.length < 2) throw new Error('not enough frames to read');
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('nothing to look for');

  const list = steps.map((s, i) => `${i}. ${s}`).join('\n');
  const content = [];
  for (const f of strip) {
    content.push({ type: 'text', text: `${f.second}s` });
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: f.mediaType || 'image/jpeg', data: f.data },
    });
  }
  content.push({ type: 'text', text:
    `Those are stills from one video, one a second, each labelled with its second.\n\n`
    + `${what || 'Say what the person in the video did.'}\n\n`
    + `For each item below, say whether the video shows it happening.\n\n${list}\n\n`
    + `Reply with JSON and nothing else:\n`
    + `{"seconds": <how many seconds the whole thing took, from the first step to the last>,\n`
    + ` "steps": [{"i": <the number above>, "done": true|false|null,\n`
    + `            "at": <the second you saw it, or null>,\n`
    + `            "note": "<one short sentence, what you saw or did not see>"}]}\n\n`
    + `One entry per item, in the same order. Three answers:\n`
    + `- done: true when the stills show it happening.\n`
    + `- done: false ONLY when the stills show it being skipped — they move on `
    + `to the next thing without it, or walk away, or do something that rules `
    + `it out. You have to be able to point at what they did instead.\n`
    + `- done: null when you cannot tell. Out of frame, hands out of shot, too `
    + `blurred, obscured, over before the next still, or simply not shown.\n\n`
    + `The line between false and null is the one that matters, and it is easy `
    + `to get wrong. "I cannot see a sanitizer bottle" is null, not false. Not `
    + `seeing a thing is not the same as seeing it not happen. If your own note `
    + `would say "no X is visible" or "I cannot see", the answer is null.\n\n`
    + `These are one still a second, so anything quick can land between two of `
    + `them: a pump of sanitizer, a tap turned off with a towel, a quick rinse. `
    + `A step you would expect to take a second or two and cannot find is null. `
    + `The stills also stop when the recording stopped, and something may have `
    + `been underway at the last one — the end of the strip is not the end of `
    + `the wash.\n\n`
    + `Somebody is about to be told whether they and you read the same wash the `
    + `same way, and they were standing there. "I could not see it" is a useful `
    + `thing to tell them. "They did not do it" when they did is not.`,
  });

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: 'You read kitchen camera stills for a restaurant food safety test. '
      + 'You are careful about what the pictures actually show, you never guess '
      + 'at something out of frame, and you hold "I did not see it" firmly '
      + 'apart from "it did not happen" — the first is about the stills and the '
      + 'second is about the person. You answer in JSON exactly as asked.',
    messages: [{ role: 'user', content }],
  });

  const text = (res.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  return shape(text, steps.length);
}

/**
 * The reply, as something safe to show a phone.
 *
 * A model asked for JSON and nothing else mostly obliges and sometimes wraps
 * it in a sentence or a fence, so this takes the outermost braces rather than
 * trusting the whole string. Anything missing or out of range reads as "I
 * could not tell", which is a true thing to say and the safe way to be wrong:
 * nobody is told they missed a step on the strength of a broken reply, and
 * nobody is told a step was done on the strength of one either. That second
 * half used to be untrue — a missing answer came back as done — and it meant
 * a video of the ceiling could be reported as a perfect wash.
 */
function shape(text, count) {
  const body = String(text || '');
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('no JSON in the reply');

  const raw = JSON.parse(body.slice(start, end + 1));
  const given = Array.isArray(raw.steps) ? raw.steps : [];

  const steps = Array.from({ length: count }, (_, i) => {
    const s = given.find(x => Number(x && x.i) === i) || {};
    // Number(null) is 0, and a second of 0 would have them watching the start
    // of the video for a step that was never given a time at all.
    const at = s.at == null ? NaN : Number(s.at);
    return {
      i,
      // Three states, and anything that is not plainly true or false is the
      // third one. null means "I could not tell", not "fine".
      done: s.done === true ? true : s.done === false ? false : null,
      at: Number.isFinite(at) && at >= 0 ? Math.round(at) : null,
      note: String(s.note || '').trim().slice(0, 220),
    };
  });

  const seconds = Number(raw.seconds);
  return { seconds: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : null, steps };
}

/**
 * Their reading of the clip against mine.
 *
 * The walker ticks the steps they think were missed, and my `done: false`
 * means the same thing, so agreeing is the two of us saying the same thing
 * about one step. Where we disagree the second is the argument and they go and
 * watch it. Nothing here is right or wrong: my side is a model's look at a
 * phone video, which is worth talking about and not worth marking anybody on.
 *
 * @param q        the question being answered — 'single' is the yes/no in
 *                 front of the list, 'multi' is the list itself
 * @param choices  the step list, in the walker's own wording
 * @param answer   what they picked, as choice indexes
 * @param reading  what readSteps() found, as stored against the walk
 */
function compare(q, choices, answer, reading) {
  if (!reading || !Array.isArray(reading.steps) || reading.steps.length !== choices.length) {
    // A reading of a different step list is not a reading of this question:
    // the template was edited between the clip going up and this answer.
    return { compare: true, unread: reading
      ? 'The questions changed while you were partway through, so I cannot line my reading up with this list. Your answer is saved.'
      : 'I did not manage to read the video. Your answer is saved — carry on.' };
  }

  const ticked = new Set([].concat(answer == null ? [] : answer).map(Number));

  // The yes/no in front of the list asks one thing, so it gets one answer.
  // Somebody who says every step was done and is right learns they read it
  // the way I did; somebody who says it and is wrong is shown the steps I did
  // not see, with the second to go and watch. That second case is the reason
  // the question exists, so it cannot be the one that gets skipped.
  if (q.type === 'single') {
    const theySaidClean = ticked.has(Number(q.allDone));
    const iSawMissed = reading.steps.filter(s => s.done === false);
    return {
      compare: true, overall: true, seconds: reading.seconds,
      agreed: theySaidClean === (iSawMissed.length === 0),
      // Counted and said out loud. Agreeing that nothing was missed means
      // something quite different when four of the eight were never visible,
      // and the walker is the one who knows whether that is the camera angle
      // or the wash. Named as well as counted, so the walk can end by saying
      // which ones to be sure of rather than leaving them a number.
      unsure: reading.steps.filter(s => s.done == null).length,
      unsureSteps: reading.steps.filter(s => s.done == null)
        .map(s => (choices[s.i] == null ? `Step ${s.i + 1}` : choices[s.i])),
      steps: iSawMissed.map(s => ({
        text: choices[s.i] == null ? `Step ${s.i + 1}` : choices[s.i],
        at: s.at, agreed: false, note: s.note || 'I did not see this one happen.',
      })),
    };
  }

  const steps = choices.map((text, i) => {
    const mine = reading.steps[i] || {};
    const theyMissed = ticked.has(i);
    const iMissed = mine.done === false;
    // A step I could not make out is not a step we agree on and not one we
    // disagree on. Ticking it as agreed was the bug: it put a ✔ beside a step
    // nobody had seen.
    if (mine.done == null) return {
      text, at: mine.at, agreed: null, unsure: true,
      note: (mine.note || 'I could not make this one out in the video.')
        + (theyMissed ? ' You had it as missed.' : ''),
    };
    return {
      text,
      at: mine.at,
      agreed: theyMissed === iMissed,
      note: theyMissed === iMissed
        ? (mine.note || (iMissed ? 'We both have this one as missed.' : 'We both have this one as done.'))
        : theyMissed
          ? `You marked this missed. I think it happened${mine.at == null ? '' : ' at ' + mine.at + 's'} — ${mine.note || 'have another look.'}`
          : `You did not mark this. I did not see it happen — ${mine.note || 'have another look.'}`,
    };
  });

  return { compare: true, seconds: reading.seconds, steps };
}

module.exports = { readSteps, shape, compare, frameSecond, MAX_FRAMES };
