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
    + ` "steps": [{"i": <the number above>, "done": true|false,\n`
    + `            "at": <the second you saw it, or null>,\n`
    + `            "note": "<one short sentence, what you saw or did not see>"}]}\n\n`
    + `One entry per item, in the same order. Say done: false only when the `
    + `stills actually show it not happening or show it skipped — not when you `
    + `are unsure, and not when it may have happened off camera. If you cannot `
    + `tell, say done: true and say so in the note.`,
  });

  const res = await client.messages.create({
    model: MODEL,
    max_tokens: 2000,
    system: 'You read kitchen camera stills for a restaurant food safety test. '
      + 'You are careful about what the pictures actually show, you never guess '
      + 'at something out of frame, and you answer in JSON exactly as asked.',
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
 * nobody is told they missed a step on the strength of a broken reply.
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
      done: s.done !== false,
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

module.exports = { readSteps, shape, compare, MAX_FRAMES };
