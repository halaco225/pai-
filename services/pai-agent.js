// The in-app assistant: the thing that answers "where do I find…" and "what
// does this say", all day, in short bursts.
//
// It runs on the cheap model on purpose. services/claude.js does the heavy,
// infrequent work — a P&L review, a 13-slide recap — where output quality is
// the whole product and a few cents a run does not matter. This file is the
// opposite shape: hundreds of two-sentence answers, where the Sonnet bill
// would be the only thing anyone noticed. Same API key, same account, one
// model name apart.
//
// PAI_AGENT_MODEL overrides the model without a deploy, which is also how you
// A/B a better one when it ships.

const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = process.env.PAI_AGENT_MODEL || 'claude-haiku-5-5';

// Template drafting is the exception: it has to emit valid JSON against a
// 20-type question schema, and a malformed draft wastes the user's time
// instead of a fraction of a cent. It gets the model the rest of P.AI uses.
const DRAFT_MODEL = process.env.PAI_DRAFT_MODEL || 'claude-sonnet-4-6';

// Haiku 5.5 thinks by default, and thinking tokens come out of max_tokens. Ask
// for too few and the whole budget goes on thinking: the reply comes back 200
// OK, stop_reason "max_tokens", content [thinking] and not one text block. That
// is what "No answer came back." was -- 700 tokens was enough for a hand-made
// test summary and nowhere near enough for 26k tokens of real region data.
//
// So the budgets below are generous rather than tight, and effort is what
// actually holds the cost down. Nothing here is free to shrink.
async function chat({ system, messages, maxTokens = 4000, model = MODEL, effort = 'low' }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('P.AI has no Claude key configured. Tell Harold.');
  }

  const res = await client.messages.create({
    model, max_tokens: maxTokens, system, messages,
    output_config: { effort },
  });

  const text = res.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
  if (text) return text;

  // Never hand back an empty string. The page would show it as "no answer",
  // which reads like the data was missing rather than the budget being short,
  // and that cost an evening to track down once already.
  const kinds = [...new Set(res.content.map(b => b.type))].join(', ') || 'nothing';
  console.error(`pai-agent: no text from ${model} — stop_reason=${res.stop_reason}, ` +
    `blocks=[${kinds}], max_tokens=${maxTokens}, output=${res.usage?.output_tokens}`);
  if (res.stop_reason === 'max_tokens') {
    throw new Error('That needed more room to answer than P.AI allows. Narrow the filters and ask again.');
  }
  throw new Error('P.AI did not answer that one. Try asking it a different way.');
}

// ── The navigator ───────────────────────────────────────────────────────────
//
// What P.AI is, in the order someone would look for it. Keeping this as prose
// rather than a tool schema is deliberate: the questions are "where is X" and
// "can P.AI do Y", which a map answers directly. No tool call, no round trip,
// no model that has to be good at tool use.

const SITE_MAP = `
P.AI is the AI command centre for Ayvaz Pizza LLC — a Pizza Hut franchisee.
Users are VPs, RDOs (Regional Directors of Operations) and Area Coaches.

Pages and what each one is for:

/dashboard — Home. Tiles for every module, plus the Master Alignment File
  upload (the document that tells every AI module the region's goals and
  standards).

/intel — Daily Intel. Yesterday's numbers across the region.
  Tabs: Dashboard (KPI tiles — sales, DBS, speed of service, labour),
  Morning Brief (the 8:30am text, on screen: urgent / watch / wins),
  Flags (stores that broke a threshold), Guest Comments (SMG verbatims).
  Data arrives by automated pull at 5am; files can also be uploaded by hand.

/velocity — Speed of Service. IST and OTF by store, area and region, with
  day-of-week patterns and AI coaching notes. Auto-updated daily.

/tracker — Follow-ups, one-on-ones, the region matrix, and two-way texting
  with store leaders. Scoped: Area Coaches see their stores, RDOs their
  region, VPs their territory.

/audits — Auditor. Readiness walks and tests sent to shift leaders by text.
  Tabs: Overview (what is out there and who has done it),
  Reporting (Responses, Summary, By store, and Ask P.AI — the AI that reads
    the results for you),
  Create (describe an audit and the AI drafts it, attach files to work from),
  Templates (the walks you send out; edit or make one by hand).

/pl-analyzer — P&L Analyzer. Upload a period-end P&L and get a financial
  review with actions, exportable as a branded PowerPoint.

/weekly-recap — Weekly Recap Deck. Upload the six weekly report files and
  P.AI builds the 13-slide region recap.

Things worth knowing:
- Only RDOs and VPs can edit audit templates or create audits.
- Daily Intel's Trends, Accountability and Weekly Digest tabs are
  temporarily off the menu while they are rebuilt. Do not send anyone there.
- Everything a user sees is already filtered to the stores they own.
`.trim();

const NAVIGATOR_SYSTEM = `You are P.AI's in-app guide. You help people find
their way around P.AI and understand what it can do for them.

${SITE_MAP}

How to answer:
- Two or three sentences. These are busy operators, not readers.
- Plain words. No markdown, no bullet lists, no headings.
- If a page is the answer, name it the way the menu does ("Daily Intel", not
  "/intel") and then put the route on its own last line as: GO: /intel
  Use GO at most once, and only for a route in the map above.
- If P.AI cannot do what they are asking, say so in one sentence and say what
  is closest. Never invent a page, a tab or a button.
- You do not have their numbers in front of you. For "what was my DBS
  yesterday", point them at the page that shows it rather than guessing.`;

async function navigate({ question, page, user }) {
  const who = user
    ? `The person asking is ${user.name || 'a user'}, role ${user.role || 'unknown'}.`
    : '';
  const where = page ? `They are on ${page} right now.` : '';
  return chat({
    system: NAVIGATOR_SYSTEM,
    maxTokens: 4000,          // the answer is three sentences; the rest is thinking room
    effort: 'low',            // it is a lookup in a map that is in the prompt
    messages: [{ role: 'user', content: [who, where, question].filter(Boolean).join(' ') }],
  });
}

// ── Reporting helper: answers questions about audit results ─────────────────
//
// Fed the summary bundle services/audit-insights.js already computes for the
// Reporting tab, for whatever filters are set. No new data layer, and the
// numbers it quotes are the same numbers on screen.

async function answerAboutAudits({ question, summary, scopeNote }) {
  const system = `You read readiness-walk results for a Pizza Hut franchisee
and answer questions about them.

You are given a JSON summary of the walks currently on screen. It holds the
average score, counts, per-question right/wrong tallies, repeat misses by
store, and breakdowns by Area Coach and region.

How to answer:
- Answer the question asked, with the actual numbers from the JSON.
- Four sentences at most unless they asked for a list; then up to six lines.
- Plain words, no markdown. Name stores and coaches as the data names them.
- If the JSON does not contain the answer, say which filter or tab would get
  it. Never estimate a number that is not there.
- Say "not enough responses yet" rather than drawing a conclusion from one or
  two walks.`;

  return chat({
    // Reading 25k tokens of region data is real work, and the answer is still
    // only a few sentences — almost all of this budget is thinking, which is
    // the point: these are analysis questions, not lookups.
    //
    // PAI_ASK_EFFORT raises or lowers how hard it thinks without a deploy:
    // low, medium, high, xhigh, max. Higher costs more and takes longer.
    maxTokens: 16000,
    effort: process.env.PAI_ASK_EFFORT || 'medium',
    system,
    messages: [{
      role: 'user',
      content: `${scopeNote ? scopeNote + '\n\n' : ''}Summary of the walks on screen:
\`\`\`json
${JSON.stringify(summary).slice(0, 60_000)}
\`\`\`

Question: ${question}`,
    }],
  });
}

// ── Template drafting: a described audit becomes an editable draft ──────────

// Only the types the editor can actually render and the validator accepts.
// Picture-based types are left out on purpose: they need an uploaded image
// with coordinates on it, which no amount of prose can supply.
const DRAFTABLE_TYPES = `
text        — short typed answer
longtext    — paragraph answer
single      — one answer from choices. Always write "choices" out in full;
              there is no shorthand for them. Where one of the house lists
              fits, use it exactly, "N/A" included:
                Yes / No / N/A
                True / False
                Pass / Fail / N/A
                Good / Fair / Poor / N/A
                Safe / At risk / N/A
                Compliant / Non-compliant / N/A
multi       — pick all that apply. "choices": ["…"]
number      — a number. Optional "min", "max", "unit".
scale       — a slider. Needs "min", "max", "step", and
              "minLabel"/"maxLabel". Never scored.
datetime    — a date and time
photo       — they take a picture. Optional "maxPhotos".
order       — put steps in the right order. "steps": ["…"] (two or more)
`.trim();

// ── Pass one: read the files, then ask before building ──────────────────────
//
// Drafting straight from "review these and build a test" means guessing the
// length, the question types and what matters — and a 20-question test built
// on the wrong guess is worse than no test, because someone has to read all
// of it to find that out.
//
// So this pass only reads. It comes back with what it found and the themes
// worth testing, which the Create tab turns into a short form. The themes are
// the part that has to come from the files; the length and the types are
// asked the same way every time, so they are fixed in the UI rather than
// spent on a model.

const MAX_THEMES = 8;

async function planTemplate({ ask, kind, referenceText }) {
  const system = `You read a franchisee's completed store audits and work out
what a new ${kind === 'test' ? 'test' : 'audit'} built from them should cover.
You return JSON only — no prose, no code fence.

Shape:
{
  "found": "two sentences on what these documents are and what they show",
  "themes": [
    { "id": "walk-in-temps",
      "label": "Walk-in cooler temperatures",
      "why": "failed in 6 of the 9 audits, usually 3-5 degrees over" }
  ]
}

Rules:
- "themes" are the things worth asking about, worst or most common first.
  Between 3 and ${MAX_THEMES} of them.
- "why" cites what is actually in the documents — how often it failed, which
  stores, the wording the standard uses. One line. If the documents do not
  support a count, describe what they do show instead of inventing one.
- "id" is lowercase letters, numbers and dashes.
- "label" is what an Area Coach would call it, not the document's jargon.
- If the documents are not audits, or you cannot tell what they are, say so
  plainly in "found" and return the themes you can justify, even if none.
- Output the JSON object and nothing else.`;

  const raw = await chat({
    model: DRAFT_MODEL,
    maxTokens: 8000,
    effort: 'medium',
    system,
    messages: [{
      role: 'user',
      content: `What they asked for: ${ask || 'Build something useful from these documents.'}

The documents:

${String(referenceText || '').slice(0, 120_000)}`,
    }],
  });

  const plan = parseJsonObject(raw, 'P.AI could not read those files. Try describing what you want instead.');
  plan.found = String(plan.found || '').trim();
  plan.themes = (Array.isArray(plan.themes) ? plan.themes : [])
    .filter(t => t && String(t.label || '').trim())
    .slice(0, MAX_THEMES)
    .map((t, i) => ({
      id: String(t.id || `theme-${i + 1}`).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 60),
      label: String(t.label).trim().slice(0, 120),
      why: String(t.why || '').trim().slice(0, 300),
    }));
  return plan;
}

async function draftTemplate({ ask, kind, referenceText, answers }) {
  const scoring = kind === 'test'
    ? `This is a TEST: answers have right answers and it is scored. Give each
real question "points" (usually 1, up to 5 for something critical) and write a
one-line "explanation" of why that is the answer.

"correct" is ALWAYS an array of zero-based indexes into "choices", even when
there is one right answer: "correct": [0], not "correct": 0. A "single"
question may have exactly one entry; a "multi" may have more.

Only choice questions can be scored. Give "points": 0 to text, longtext,
number, photo, datetime and scale questions, and no "correct" — there is
nothing to mark them against.`
    : `This is an AUDIT: it records what was actually there and is NOT scored.
Every question must have "points": 0. Do not set "correct" or "explanation".`;

  const system = `You draft readiness-walk question sets for a Pizza Hut
franchisee's store walks. You return JSON only — no prose, no code fence.

Shape:
{
  "title": "…",
  "description": "what the shift leader reads before they start",
  "questions": [ { "n": 1, "title": "the question", "type": "…", "points": 0 } ]
}

Question types you may use:
${DRAFTABLE_TYPES}

${scoring}

Rules:
- Questions 1 and 2 are always, exactly:
  {"n":1,"title":"Your first and last name","type":"text","points":0,"required":true}
  {"n":2,"title":"Your store number","type":"text","points":0,"required":true}
  Then the real questions from n=3.
- "n" counts up from 1 with no gaps.
- 8 to 20 questions unless they asked for a different size.
- Word each question so a shift leader standing in the store can answer it
  without interpreting it. Ask about one thing at a time.
- Set "required": true on anything that must not be skipped.
- Never use a type that is not in the list above.
- Output the JSON object and nothing else.`;

  const parts = [`What they asked for: ${ask}`];

  // Answers from the asking pass. They are decisions, not suggestions: the
  // whole point of asking was to stop the model guessing the length and the
  // shape, so they are stated as requirements and put before the material.
  if (answers) {
    const want = [];
    if (answers.count) want.push(`Write exactly ${answers.count} real questions, after the two about name and store number.`);
    if (answers.types && answers.types.length) {
      want.push(`Use only these question types: ${answers.types.join(', ')}. Vary them across the set rather than using one throughout.`);
    }
    if (answers.focus && answers.focus.length) {
      want.push(`Cover these, and weight the set towards them:\n${answers.focus.map(f => `  - ${f}`).join('\n')}`);
    }
    if (answers.notes) want.push(`Also: ${answers.notes}`);
    if (want.length) parts.push(`What they decided when asked:\n${want.join('\n')}`);
  }

  if (referenceText) {
    parts.push(`Material to build it from — use its actual standards, numbers
and wording wherever it has them:

${referenceText.slice(0, 120_000)}`);
  }

  const raw = await chat({
    model: DRAFT_MODEL,
    maxTokens: 16000,
    // A few drafts a month, each one a schema a region then walks on. This is
    // the call worth paying for; the navigator is the one worth pinching.
    effort: 'high',
    system,
    messages: [{ role: 'user', content: parts.join('\n\n') }],
  });

  return parseDraft(raw);
}

// The editor's ready-made answer lists, copied from addQuestion() in
// public/audits.html. They are only a saving of typing there -- a question is
// an ordinary one-answer question once the list is in it -- so nothing is
// stored to say which list was used.
//
// A model shown those six lists tends to reach for the shorthand anyway and
// name the list instead of writing it out, which leaves a choice question with
// no choices: five of seventeen on the first real draft. Writing the list in
// for it costs four lines and turns that into a draft that opens clean.
const PRESET_CHOICES = {
  yesno:        ['Yes', 'No', 'N/A'],
  truefalse:    ['True', 'False'],
  passfail:     ['Pass', 'Fail', 'N/A'],
  goodfairpoor: ['Good', 'Fair', 'Poor', 'N/A'],
  safeatrisk:   ['Safe', 'At risk', 'N/A'],
  compliant:    ['Compliant', 'Non-compliant', 'N/A'],
};

function expandPreset(q) {
  if (!q || (q.type !== 'single' && q.type !== 'multi')) return;
  if (Array.isArray(q.choices) && q.choices.length >= 2) return;
  const named = String(q.variant || q.preset || q.choiceSet || '')
    .toLowerCase().replace(/[^a-z]/g, '');
  const list = PRESET_CHOICES[named];
  if (list) q.choices = list.slice();
  delete q.variant; delete q.preset; delete q.choiceSet;
}

// The model is told to return bare JSON, and usually does. A fenced block or
// a leading sentence is the common miss, so recover from both rather than
// making the user ask again.
// Both passes ask for a bare JSON object and both occasionally get a fenced
// block or a sentence in front of it, so the recovery lives in one place.
function parseJsonObject(raw, failure) {
  let text = String(raw || '').trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();
  else {
    const open = text.indexOf('{');
    const close = text.lastIndexOf('}');
    if (open > 0 || close < text.length - 1) {
      if (open === -1 || close <= open) throw new Error(failure);
      text = text.slice(open, close + 1);
    }
  }
  try {
    const out = JSON.parse(text);
    if (!out || typeof out !== 'object' || Array.isArray(out)) throw new Error(failure);
    return out;
  } catch (e) {
    throw new Error(e.message === failure ? failure : failure);
  }
}

function parseDraft(raw) {
  const def = parseJsonObject(raw, 'The draft came back unreadable. Try describing it again.');
  if (!def || !Array.isArray(def.questions) || !def.questions.length) {
    throw new Error('The draft came back with no questions. Try describing it again.');
  }
  // "correct": 0 instead of [0] is the slip a model makes most often here, and
  // the validator reads a bare number as "nothing marked" — which would put a
  // red error on every scored question of an otherwise good draft.
  for (const q of def.questions) {
    if (Number.isInteger(q.correct)) q.correct = [q.correct];
    expandPreset(q);
  }
  return def;
}

module.exports = { chat, navigate, answerAboutAudits, planTemplate, draftTemplate,
                   parseDraft, parseJsonObject, MODEL, DRAFT_MODEL, MAX_THEMES };
