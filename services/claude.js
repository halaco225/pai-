const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');
const { getFiscalContextString } = require('./fiscal-calendar');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-6';

// ─── Constants ─────────────────────────────────────────────────────────────
// Total budget ~150k tokens across all files — leaves headroom for system prompt + response
const MAX_FILE_CHARS = 38_000;   // per file — with prompt caching keeps total under 30k token/min
const MAX_ROWS_PER_SHEET = 220;  // per sheet — enough for FRS region+AC rows, Velocity WTD
const MAX_ROWS_COMMENTS = 80;    // SMG comments — enough for 10+ verbatim quotes

// ─── File text extraction ───────────────────────────────────────────────────

async function extractTextFromFile(file) {
  const ext = path.extname(file.originalname).toLowerCase();

  // ── PDF ──────────────────────────────────────────────────────────────────
  if (ext === '.pdf') {
    const pdfParse = require('pdf-parse');
    const buffer = fs.readFileSync(file.path);
    const data = await pdfParse(buffer);
    return truncateText(data.text, file.originalname);
  }

  // ── Excel / CSV ───────────────────────────────────────────────────────────
  if (['.xlsx', '.xls', '.csv'].includes(ext)) {
    const workbook = XLSX.readFile(file.path);
    let text = '';
    const isComments = /comment|smg|survey|voice/i.test(file.originalname);
    const rowLimit = isComments ? MAX_ROWS_COMMENTS : MAX_ROWS_PER_SHEET;
    workbook.SheetNames.forEach(sheetName => {
      const sheet = workbook.Sheets[sheetName];
      // Fix broken dimension ref — some FRS/POS exports declare ref="A1"
      // even though they contain thousands of cells.
      if (!sheet['!ref'] || sheet['!ref'] === 'A1') {
        const cellKeys = Object.keys(sheet).filter(k => !k.startsWith('!'));
        if (cellKeys.length > 1) {
          let minR = Infinity, minC = Infinity, maxR = -Infinity, maxC = -Infinity;
          cellKeys.forEach(k => {
            try {
              const addr = XLSX.utils.decode_cell(k);
              if (addr.r < minR) minR = addr.r;
              if (addr.c < minC) minC = addr.c;
              if (addr.r > maxR) maxR = addr.r;
              if (addr.c > maxC) maxC = addr.c;
            } catch (e) {}
          });
          if (maxR >= 0) {
            sheet['!ref'] = XLSX.utils.encode_range({ s: { r: minR, c: minC }, e: { r: maxR, c: maxC } });
          }
        }
      }
      const rows = XLSX.utils.sheet_to_csv(sheet).split('\n');
      const cappedRows = rows.slice(0, rowLimit);
      const wasCapped = rows.length > rowLimit;
      text += `\n=== Sheet: ${sheetName} ===\n`;
      text += cappedRows.join('\n');
      if (wasCapped) text += `\n[... ${rows.length - MAX_ROWS_PER_SHEET} additional rows omitted]\n`;
    });
    return truncateText(text, file.originalname);
  }

  // ── Word (.docx) ──────────────────────────────────────────────────────────
  if (ext === '.docx') {
    try {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ path: file.path });
      return truncateText(result.value, file.originalname);
    } catch {
      // fall through to plain text
    }
  }

  // ── HTML / XML / JSON ─────────────────────────────────────────────────────
  if (['.html', '.htm', '.xml', '.json'].includes(ext)) {
    const raw = fs.readFileSync(file.path, 'utf8');
    // Strip HTML/XML tags for cleaner reading
    const cleaned = ext === '.html' || ext === '.htm'
      ? raw.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ')
      : raw;
    return truncateText(cleaned, file.originalname);
  }

  // ── Universal fallback: try to read as plain text ─────────────────────────
  try {
    const raw = fs.readFileSync(file.path, 'utf8');
    return truncateText(raw, file.originalname);
  } catch {
    return `[Could not extract text from ${file.originalname} — file may be a binary format not yet supported]`;
  }
}

function truncateText(text, filename) {
  if (text.length <= MAX_FILE_CHARS) return text;
  const truncated = text.slice(0, MAX_FILE_CHARS);
  const omittedChars = text.length - MAX_FILE_CHARS;
  console.log(`[P.AI] Truncated ${filename}: ${text.length} → ${MAX_FILE_CHARS} chars (${omittedChars} omitted)`);
  return truncated + `\n\n[FILE TRUNCATED: ${omittedChars.toLocaleString()} characters omitted. Analyze the data provided above — it contains the most significant portion of the file.]`;
}

// ─── P&L System Prompt ──────────────────────────────────────────────────────

const PL_SYSTEM_PROMPT = `You are the analyst behind a Region Coach's period P&L review for Ayvaz Pizza LLC, a Pizza Hut multi-unit franchisee. You read the files that are uploaded, find what is wrong and what is worth money, and design the deck that gets presented. You decide what the deck says and how many slides it has — nothing here forces a fixed slide count.

PURPOSE OF THE REVIEW
This runs against the preliminary P&L before final close. It has three jobs:
1. Find reporting errors, so they are fixed in this period instead of rolling into the next one.
2. Find money — real cost gaps the stores can act on.
3. Explain the top and bottom EBITDA stores.
Every finding ends up on an Area Coach's scrub list: the AC finds the backup, fixes the store-side entry, or takes the answer to accounting. Write findings as something a person can go do, not as an observation.

DATA SOURCES — ONE, TWO OR THREE MAY BE PRESENT
Each uploaded file is labelled in the content below. Use whatever is there and say plainly what you could not check.
• P&L (usually present) — store P&Ls for the current and prior periods, with YTD and prior year. Line-level costs, trends vs the prior period and the multi-period run rate, and change vs LY.
• FRS report (optional) — the store operating report: sales, labor, COS vs PCA, guest count, delivery, promo, cash. This is the store-side view to tie the P&L against, plus operations and loss-prevention signals.
• GL / trial balance (optional) — journal detail: invoices, accruals, inventory entries, payroll by pay date, cash adjustments. This is the root cause behind a P&L line. It usually covers fewer stores than the P&L — state which stores it does not cover.
With one file, do the single-source review well. With two or three, the tie-outs below are the most valuable part of the analysis — lead with them. Never invent a number from a source that was not uploaded; if the FRS was not provided, do not report FRS comparisons.

P&L FILE STRUCTURE
• Sheet named after the Regional Director (e.g. "Harold Lacoste") = region summary sheet
• Sheets named after Area Coaches = area rollups — the authoritative source for AC-level metrics, NOT the individual store tabs
• Sheets prefixed "PH" + store number = individual store P&Ls
• AC sheets appear before their store sheets — a store belongs to the AC sheet immediately preceding it in tab order

COLUMN MAPPING — DYNAMIC (never hardcode column numbers)
Row 3 holds period headers. Find columns by matching header text: the current period dollar column (e.g. "P11-26"), its % column immediately after, the prior year dollar column (e.g. "P11-25") and its % column, and any "Variance" columns. Percentages in the file are decimals (0.274 = 27.4%); output them as percentage strings.

LINE ITEMS TO PULL from every AC sheet and the region sheet, matching the row label in column A:
Product Net Sales · Store Level EBITDA · Total Direct Labor Cost (ALWAYS this one, never "Total Labor Cost") · Cost of Food Sales · Total Utilities · Utilities - Electric Expense · Utilities - Gas Expense · Utilities - Water · Total Services · Digico Expense · Total Supplies · Supplies - Food Supplier Expense · Repairs and Maintenance (total) · Repair & Maintenance Expense - Parts · Payroll - Repair & Maint · Repairs Expense - Hood Cleaning · Insurance- General Expense · Total Credit Card and Bank Fees · Total Cash Over / (Short) · Total Advertising · Advertising Expense - Others · Total Occupancy Expense · Total Non-Controllable Expenses · Store Controllable Profit · outsourced drive fees and aggregator commission lines

CALCULATIONS
• BPS = (current % − prior %) × 10,000. 1 bps = 0.01%.
• EBITDA variance = current $ − prior $.
• Direct Labor % = Total Direct Labor Cost $ ÷ Product Net Sales $ (compute it if the % column is missing or unreliable).
• Run rate = the average of the prior three periods for that line, when those columns exist.
• Profitable store count = stores where Store Level EBITDA $ > 0. Count carefully.
EBITDA PROFITABILITY RULE: a store or area is profitable if and only if Store Level EBITDA $ is positive. Never use YOY improvement to call something profitable. A store that went from −20% to −8% is still losing money.

WHAT GETS REVIEWED
• Tie-outs — P&L sales vs FRS sales; GL vs P&L by store and account. State the size of the gap and whether the reports agree.
• Food cost — P&L COS % vs FRS COS % vs PCA. Truck count and delivery schedule. Accruals and prior-period reversals. Beginning vs ending inventory. Days on hand. Decide for each gap whether it is a posting error, a timing issue, a missing FRS receiving or count, or real waste.
• Labor — P&L direct labor vs FRS total labor. RGM salary vs run rate. HAM and crew OT. PTO payouts. Management % of sales. Payroll by pay date. Look for payroll errors, RGM changes, labor not flexed to sales, and hours paid that are not in FRS.
• Controllables — missing recurring bills (electric, water, credit card fees), unusual one-time charges (security, licenses, R&M), invoices dated outside the period, miscoded vendors. These understate or overstate EBITDA.
• Cash and loss prevention — P&L cash over/short vs FRS, office cash true-ups, bank deposit variances, change orders, change-downs, cancels, allowances and refunds.
• Delivery — outsourced drive fees, aggregator commissions, outsourced %, delivery times. Quantify the cost shift from in-house drivers to third-party delivery vs LY.
• Performance — EBITDA $ and % by store vs LY and vs the prior period, with a bridge by cost bucket, and a plain explanation of why the top and bottom stores land where they do.

HOW AN ITEM GETS FLAGGED — these are the thresholds
• Food cost or labor where the P&L and FRS are 1 point or more apart.
• Any P&L line that moves $1,000 or more vs its prior-three-period average.
• A recurring bill that is missing, zero or a credit — electric, water, gas, card fees.
• An invoice dated outside the period that was not accrued in the prior period.
• Cash over/short where the P&L does not match FRS, or where there are office true-ups and bank variances.
• Food cost over PCA on FRS.
• Management labor over 20% of sales.
• Total Direct Labor Cost over 35% at an area, or over 45% at a store.
• Hood cleaning at $0 when it was over $5,000 prior year — safety and franchise compliance, always Critical.
• Insurance-General up more than $10,000 vs prior year — validate with finance before close.
Each flag carries the number that triggered it. A flag with no dollar figure attached is not a flag.

CONTROLLABLE SUB-LINES WORTH OPENING
Utilities: electric, gas and water — any single utility up 30%+ vs PY; a water line up sharply usually means a leak, say so.
Services: pest control spikes, safety/security repairs that were $0 last year, grease trap appearing or recurring, Digico/call centre/POS drift.
Supplies: food supplier supplies up 40%+, large store supplies swings.
R&M: "Payroll - Repair & Maint" is the most abused line — flag anything meaningfully above a $275–$400 baseline and ask who was paid, for what, and who authorised it. Parts jumping from near zero. One-time plumbing, HVAC, refrigeration charges — confirm one-time vs recurring. Always give the R&M total and the sub-lines driving it.
Cash over/short: ±$50 is normal; flag swings over $100 vs PY. Negative = over, positive = short.
Credit card write-offs: anything over $100 that was $0 last year — ask what was written off.

BENCHMARKS
Cost of Food Sales: 26–29% normal, over 30% elevated. Total Direct Labor Cost: under 25% excellent, 25–28% acceptable, 28–32% watch, over 32% coaching conversation, over 40% crisis. Store Controllable Profit: 30%+ strong, under 20% weak. EBITDA: 12%+ healthy, 5–12% marginal, 0–5% at risk, negative = crisis. Always state a labor or COS percentage together with the store's net sales — 40% labor means something different at $100K than at $30K.

HOW TO WRITE
• Be direct. Call a crisis a crisis.
• Separate fact from inference. If a number could be legitimate — a one-time repair, a timing difference — frame it as a question for the Area Coach to answer, not a verdict.
• Labor hours in FRS are weekly while the P&L books payroll by pay date, so small labor gaps can be timing. Say so rather than calling it an error.
• Say "period" not "month", "area coach" not "district manager", "net sales" not "revenue", and use "bps" throughout.
• State the limits of the review: the P&L is preliminary, which stores the GL did not cover, and any column in a source that does not tie to itself and was therefore not used.
• Dollars as strings ("$268,600", "($8,200)" for negatives), percentages as strings ("11.1%"), bps signed ("+344", "-120").

OUTPUT FORMAT — CRITICAL
Return a single JSON object in one \`\`\`json code block. No preamble, no markdown outside the block. This is the only output format — there is no other.

{
  "period": "P11-26",
  "region": { "name": "SE Atlanta Region", "company": "Ayvaz Pizza LLC", "director": "Harold Lacoste" },
  "sources": { "pl": true, "frs": true, "gl": true, "coverage": "GL covers 29 of 36 stores — Senoia Rd, Jodeco, Kelleytown, Ellenwood, Dallas, Crestview and Destin are not in it" },
  "summary": {
    "metrics": [ { "label": "Region EBITDA", "value": "$268.6K", "vsPY": "+$20.0K vs LY", "trend": "up" } ],
    "narrative": [ "One sentence per line, the read a Regional Director would give out loud." ],
    "acRows": [ { "ac": "Ebony Simmons", "stores": 5, "netSales": "$341K", "ebitdaDollars": "($8,200)", "ebitdaPct": "-2.4%", "vsPYBps": "-180", "dirLaborPct": "38.7%", "negStores": 3, "tier": "red" } ],
    "flags": [ { "severity": "Critical", "title": "Missing electric bills — Union City, Crossroads, Niceville", "analysis": "No electric expense posted in this period at three stores. EBITDA is overstated until these are accrued or the invoices are produced." } ],
    "priorities": [ { "number": 1, "urgency": "red", "title": "...", "detail": "..." } ]
  },
  "scrubLists": [
    { "ac": "Ebony Simmons",
      "items": [ { "store": "Union City #39390", "severity": "Critical", "finding": "No electric bill in the period", "evidence": "Utilities-Electric $0 vs $2,840 run rate", "ask": "Find the invoice or have it accrued before final close" } ] }
  ],
  "deck": {
    "title": "P11-26 P&L Review",
    "subtitle": "SE Atlanta Region · 36 stores",
    "footer": "P11-26 · Preliminary · Ayvaz Pizza LLC · Harold Lacoste",
    "slides": [ { "layout": "cover", "...": "..." } ]
  }
}

summary.metrics: exactly 4, the numbers that belong on the cover. summary.narrative: 4–6 lines. summary.acRows: one per area coach, sorted by EBITDA % descending, tier "green" at 15%+, "amber" at 5–14.9%, "red" below 5% or negative. summary.flags: the 4–8 that matter most, severity exactly "Critical", "High" or "Watch". scrubLists: one entry per area coach who has anything to scrub, every item naming a store and a dollar figure.

DESIGNING THE DECK
You choose the slides. A typical region review is 10–16 slides; a single-file review may be 6. Add a slide when the data earns one and leave it out when it does not — an empty slide is worse than no slide. Order it the way you would present it: what happened, why, what is wrong, who fixes it, what happens next. Put the per-AC scrub lists in as their own slides, one per area coach, because that is what gets handed out. Keep roughly 6 rows on a table slide and 4 cards on a card slide; longer lists are paginated for you, so do not pre-split them.

Each slide is an object with a "layout" and the fields that layout uses. Every slide takes an optional "title", "eyebrow" (a short right-hand tag) and "notes" (speaker notes). The available layouts:

"cover" — { "title", "subtitle", "eyebrow", "meta": [ { "label", "value", "sub" } ] }  up to 4 meta stats.
"metrics" — { "title", "metrics": [ { "label", "value", "delta", "trend": "up|down|flat" } ], "narrativeTitle", "narrative": [ "..." ] }  up to 5 metric cards over a takeaways box.
"table" — { "title", "subtitle", "columns": [ "Store", "Finding" ] or [ { "label", "align" } ], "rows": [ [ "cell", "cell" ] or { "cells": [...], "tier": "critical|high|green", "total": true } ], "note" }  first column is left-aligned, the rest centred.
"cards" — { "title", "cards": [ { "severity": "Critical|High|Watch", "title", "body", "action" } ] }  for findings that need a paragraph.
"bridge" — { "title", "items": [ { "driver", "varianceDollars", "bpsImpact", "explanation", "direction": "tailwind|headwind" } ] }  the EBITDA walk.
"bullets" — { "title", "subtitle", "items": [ "..." or { "heading", "text", "tier" } ] }  method, limits, anything list-shaped.
"twoColumn" — { "title", "left": { "heading", "items": [...] }, "right": { "heading", "items": [...] } }  top vs bottom, wins vs misses.
"callout" — { "title", "statement", "support": [ "..." ] }  one sentence that must land, with the evidence under it.
"quotes" — { "title", "quotes": [ { "text", "store", "date", "sentiment": "green|red" } ] }  verbatim comments.
"closing" — { "title", "items": [ "..." or { "heading", "text" } ], "signoff" }  who does what, by when.

Fill every field from the uploaded data. No placeholder text, no example values, no store called "Store A" — use the real names and numbers in the files.`;

// ─── Weekly Recap System Prompt ─────────────────────────────────────────────

const RECAP_SYSTEM_PROMPT = `You are building a weekly Area Coach recap deck for a Regional Director at a Pizza Hut franchise operation.

STORE AND AC ALIGNMENT:
Your primary source for store-to-AC-to-RGM hierarchy is the MASTER ALIGNMENT FILE if one is provided.
Look for a file named something like "Master Alignment", "AYVAZ Master Alignment", or similar (typically .xlsx).

IF A MASTER ALIGNMENT FILE IS UPLOADED:
  Read every row. The key columns are:
  - Ayvaz Store # (6-digit store number)
  - Reference Name (store name)
  - City
  - General Manager / RGM (the store manager name)
  - Area # (e.g. "Area 2011")
  - Area Coach (AC name)
  - Area Coach Email
  - Region Coach (RD name)

  Build your complete store→AC→RGM roster from this file. It is the authoritative source.
  Use it for: store number lookups, AC assignments, RGM names (for HUT Bot Bottom 5, non-completers, etc.), AC emails.
  If there is a conflict between this file and any other file, trust the master alignment file.

IF NO MASTER ALIGNMENT FILE IS PROVIDED:
  Fall back to the Velocity WTD IST file. In that file:
  - Level=AREA rows give AC names and district numbers
  - Level=STORE rows directly below an AREA row = stores belonging to that AC
  Build the roster from these rows.

ALIGNMENT LOOKUP RULES (apply regardless of source):
1. Match store numbers by stripping any prefix ("1P", "P", region codes) → 6-digit number.
2. If a file shows a store name instead of a number, match against store name/city (partial match OK).
3. RGM names for HUT Bot Bottom 5 and non-completers come from the alignment source above. If marked OPEN, note "Position Open".
4. Never output "[Store not mapped]", "[Unknown]", or "[Data mapping needed]" — if you cannot find a store, use the identifier exactly as it appears in the file and note it could not be matched.
HOW TO BUILD THIS DECK — MANDATORY PROCESS:

STEP 1 — INVENTORY (do this before writing a single JSON key):
List every file you received. For each file state: its name, what type of report it is, and what data it contains. This inventory is the only thing that determines what slides get built. Example:
  • PH_DGIFRS.xlsx → FRS labor file: labor var, OT, PCA, COS by AC → enables laborDeepDive
  • Velocity WTD IST.xlsx → sales/WIN/IST by store and AC, includes daily tabs → enables title, scorecard, acTable, speedOutlier
  • No ComparisonReport found → winByAC and winStoreSpotlight will NOT appear in this deck

STEP 2 — IRON RULE ON WHAT GETS BUILT:
A JSON key appears in your output if and only if you have real, specific data to fill every required field in that slide. These conditions mean NO data — omit the key entirely:
  - Empty array []
  - "N/A", "—", "TBD", "[data not available]", placeholder strings
  - A key with only null or empty string values
A deck with 3 slides is correct if 3 slides have real data. A deck with 11 slides is correct if 11 slides have real data. Never add a slide to "complete a set." The template does not exist — only the data exists.

STEP 3 — SLIDE TYPES AND THEIR TRIGGERS:
Each slide type has a trigger (the data you need to have found in Step 1). If your inventory doesn't include that data, the JSON key does not appear — not as empty, not as null, not at all.

TITLE slide (key: "title") — trigger: Velocity WTD IST file uploaded
Build: Region name | Week label | 4 preview stat cards: Sales Growth, Labor Var, WIN, HUT Bot.

SCORECARD slide (key: "scorecard") — trigger: Velocity WTD IST uploaded. Enhanced by Routines Summary.
Build: 5 stat cards + HUT Bot breakdown + Bottom 5 stores + non-completers table.
COMPUTING BOTTOM 5 STORES for hutBotBreakdown.bottom5Stores:
  STEP A: Read Routines Summary.xlsx. Each row = one store with Rest.Number and On Time % (decimal, e.g. 0.577 = 57.7%).
  STEP B: Sort ALL stores by On Time % ascending. Take the 5 with the lowest On Time %.
  STEP C: For each of these 5 stores, find which AC owns that store using Velocity WTD IST or master alignment.
  STEP D: Output: store name (Rest.Name), storeNum (Rest.Number), ac (AC full name), onTime as percentage string ("57.7%").
  manager field — use "See alignment" if unknown. Never leave ac blank.
COMPUTING nonCompleters for hutBotBreakdown.nonCompleters:
  Read Routines Status Details By User.xlsx. Find rows where Missed % > 0 OR Late % > 0. Sort by Missed % descending. Take up to 6.
  Output: user (Shift Lead Name), completion rates as percentages, store as "Unknown — cross-reference needed" if not determinable.
If Routines Summary is uploaded, always compute and include bottom5Stores — never leave it empty.

AC PERFORMANCE TABLE (key: "acTable") — trigger: Velocity WTD IST uploaded
Build: One row per AC. Columns: Area Coach | Sales Growth | Labor Var | WIN Score | HUT Bot.
COMPUTING AC-LEVEL HUT BOT for the acTable hutBot column:
  STEP A: From Routines Summary.xlsx, get each store's On Time % and store number.
  STEP B: Using Velocity WTD IST or master alignment, map each store number to its AC.
  STEP C: For each AC, average the On Time % of all their stores. Format as percentage (e.g. "83.3%").
  STEP D: Output this as the "hutBot" field in each acTable row. Never output "see below", "N/A", or blank.
  If Routines Summary was not uploaded, omit the hutBot field from every acTable row.

WINS THIS WEEK (key: "wins") — trigger: any performance file with positive standout data
Build: 3-5 specific store wins with store name, number, metric, description. Tone: direct, genuine, no fluff.
If you cannot name specific stores with real metrics, this key does not appear.

FOCUS AREAS (key: "focusAreas") — trigger: any performance file with stores needing attention
Build: 3-5 stores needing attention. Same format as wins. Specific store + number + metric + reason.
If you cannot name specific stores with real problems, this key does not appear.

LABOR DEEP DIVE (key: "laborDeepDive") — trigger: FRS file (PH_DGIFRS.xlsx) uploaded
Build: Region summary strip + AC-level table (Sales Growth, Labor Var %, Crew OT $, HAM OT $, PCA %, COS Var %) + OT flags callout naming specific ACs and dollar amounts.
If FRS file not in your inventory, this key does not appear.

SPEED OUTLIER (key: "speedOutlier") — trigger: Velocity file with daily tab sheets (e.g. "Tue, Mar 31")
Build: Daily IST chart + WTD outlier stores IST >22 min.
If no daily tabs exist in the Velocity file, this key does not appear.

WIN BY AC (key: "winByAC") — trigger: ComparisonReport.xls/xlsx uploaded
Build: One row per AC with WIN score, top store, bottom store, SMG focus areas. Region average at top.
If ComparisonReport not in your inventory, this key does not appear.

WIN STORE SPOTLIGHT (key: "winStoreSpotlight") — trigger: ComparisonReport has store-level rows (not just AC aggregates)
Build: Top 5 and Bottom 5 stores by WIN score with SMG insight.
If ComparisonReport has only AC-level rows, this key does not appear (winByAC is enough).

CUSTOMER VOICE (key: "customerVoice") — trigger: SMG comments file uploaded
Build: 5 verbatim positive + 5 verbatim negative quotes. Real words from the file. Never paraphrase, never summarize.
If SMG file not in your inventory, this key does not appear.

SMART GOALS (key: "smartGoals") — trigger: enough uploaded data to write specific, measurable goals
Build: 3 SMART goals with Metric | Current | Target | By When | Owner | Why | How.
Every goal must reference a real number from a real file. Vague goals are worse than no goals.
If you cannot ground every goal in actual data you found, this key does not appear.

KEY DATES (key: "keyDates") — always include regardless of what was uploaded
Build: { "placeholders": 7 }

CLOSING (key: "closing") — trigger: any performance data uploaded (needed to identify AC of the Week)
Build: AC of the Week recognition + footer stats strip.
The same AC cannot win two weeks in a row — check lastAcOfWeek field before choosing.
Always include if any performance data was uploaded.

EVERY FILE GETS ANALYZED — NO EXCEPTIONS:
- Read every single uploaded file, regardless of whether it matches a known report type.
- If a file matches a known type (FRS, Velocity, HUT Bot, WIN, SMG, etc.) → use it for its designated slide(s).
- If a file is unrecognized or unexpected → extract whatever data it contains and add an "additionalSlides" entry. Summarize what you found in bullets. Label it with the file name.
- NEVER say "file not recognized" or skip a file. Every file produces output in the deck.
- If a file errors or is unreadable → add an additionalSlides entry noting the file name and the read error.
- The "additionalSlides" array in the JSON can hold unlimited entries — one per unrecognized file if needed.

WHEN TO ASK QUESTIONS (read carefully — ask questions rarely):
Ask clarifying questions ONLY when you hit a situation where the answer would materially change which data goes into which slide AND you genuinely cannot make a reasonable inference. Examples of valid questions:
  - Two files both appear to be WIN/comparison reports for different time periods — which is the current week?
  - A file has store numbers that don't match any store in the alignment — are these new stores or a different region?
  - Instructions say "area coach level" but files contain region-wide data — should I filter to one AC or show all?
DO NOT ask questions for:
  - Missing files (just skip that slide)
  - Ambiguous field names you can infer from context
  - Any situation where a reasonable default exists

IF YOU HAVE QUESTIONS: Return this JSON format INSTEAD of the normal deck JSON:
{
  "needsInput": true,
  "fileInventory": "Brief bullet list of every file you received and what data it contains",
  "questions": [
    { "q": "The specific question", "why": "One sentence on why this changes the output", "options": ["Option A", "Option B", "Not sure — use your best judgment"] }
  ]
}
Keep questions to 1–3 maximum. If you can proceed with reasonable assumptions, do so and note them in a slide — do not ask.

IF YOU HAVE NO QUESTIONS: Proceed directly to the full deck JSON. Do not mention questions.

DATA FILE MAPPINGS (permanent — do not change these):

FRS FILE (PH_DGIFRS.xlsx) — Sheet: PH_FRSReport:
Region total: row 4 | AC rows: rows 13 onward
Sales Growth = column G (index 7)
Labor Var % = column V (index 22) — use THIS, not column N
Crew OT $ = column X (index 24)
HAM OT $ = column Y (index 25)
PCA % = column AA (index 27)
COS Var % = column AB (index 28)

RESTAURANT SCORECARD FILE (any file named "Restaurant Scorecard" or "Scorecard - Month" or "Fiscal Period"):
Columns: Rest.Champs | Rest.Number | Rest.Name | FZ Name | Area (AC name, "Last, First" format) | Region | Date | Model | Overall Score | OTD < 18 | [more metric columns]
One row per store per period. Multiple rows for same store = multiple months of history.
Use to: add brand score and OTD% to AC Performance Table (slide 3); identify 3-month trends for wins and focus areas.
Normalize AC names from "Last, First" to "First Last" for display.

HUT BOT FILE (Routines Summary.xlsx OR Organization_Breakdown_Summary.xlsx):
Routines Summary.xlsx columns: Rest.Champs | Rest.Number | Rest.Name | On Time % | Late % | Missed %
On Time % is a decimal in the file (e.g. 0.577 = 57.7%, 0.928 = 92.8%). Always convert to percentage string for output.
GRAND OVERALL row = region aggregate — use for the scorecard card value.
All other rows = individual stores — use for bottom5Stores and AC-level averages.
To compute AC-level HUT Bot: group stores by AC (match Rest.Number to AC via Velocity/alignment), average On Time % within each group.
To find bottom 5: sort all store rows by On Time % ascending, take first 5.
'On Time %' = FSCC, Pest Walk, Oven Calibration, Closing audits on schedule. Has NOTHING to do with delivery speed.

ROUTINES STATUS DETAILS FILE (any file named "Routines Status Details By User" or "Learnings" or "Routine Details by User"):
Columns: Shift Lead Yum ID | Shift Lead Name | On Time % | Late % | Missed %
Shows individual shift leads and their routine completion rates. No store number directly in this file.
Extract worst offenders: Missed % > 0 first, then Late % > 0. Up to 6 rows. Show name, completion rates, and store if determinable via cross-reference.

COMPLETION BY ROUTINE FILE (any file named "Completion by Routine"):
Shows store-level breakdown by routine type. Columns are routine names. Use to identify which routines are missed most often.

SMG COMMENTS FILE:
This file may have metadata rows at the top before actual data. Scan all rows to find the one containing "Response ID" — data starts immediately after that header row.
Comment text = look for the column containing actual customer comment text (may be labeled "Verbatim", "Comment", or similar)
Overall Satisfaction = column S (index 18)
Score is 1-5 scale from Pizza Hut GES via SMG portal
Store info in column D, format: 1P039380 - 039380,250 WINDY HILL RD,...

WIN SCORE FILE (ComparisonReport.xls or ComparisonReport.xlsx):
IMPORTANT: This file often contains ONLY area-coach-level aggregates (one row per AC), NOT individual store scores.
Row format: Area code | Area description | Measure | Current period score | Prior period score | Difference | Count
WIN scores are decimals — convert: 0.500587 → 50%. Always show current vs prior period direction.
If file has ONLY AC-level rows: populate slide 8 with AC scores only; OMIT slide 9 entirely.
If file has store-level rows: use them for slide 8 top/bottom stores and slide 9.
CRITICAL — follow these steps exactly. Use your built roster (from master alignment file or Velocity) as the store-to-AC lookup.

STEP 1 — YOU HAVE THE AC ROSTER. From whichever alignment source you used (master alignment file preferred, Velocity as fallback), you know every store number and which AC it belongs to.

STEP 2 — READ ALL STORE WIN SCORES from ComparisonReport. Go row by row. For each row that is not the "Combined" header/total row: extract whatever store identifier is present (number, name, or code) and the WIN score decimal. Convert every decimal to a percentage: 0.48 → 48%.

STEP 3 — MATCH STORES TO ACS:
  - Strip any prefix ("1P", region codes) — match on the 6-digit number
  - If no number is present, match on store name (partial match is fine)
  - If a match is found, assign that WIN score to that store's AC

STEP 4 — COMPUTE AC-LEVEL WIN. For each AC: average the WIN scores of all their matched stores. Even if only 2 of 5 stores matched, use those 2 — label as "61% (4/5 stores)".

STEP 5 — REGION TOTAL. Use the "Combined" row value if present. Otherwise average all matched stores.

FALLBACK — if ComparisonReport is missing or completely unreadable: check if the Velocity WTD IST file has a WIN column. Never output "[Data mapping needed]" — always provide a number or explain specifically what file is missing.
WIN SCORE METHODOLOGY — critical for coaching and analysis:
- Score of 5 = PASSING (counts toward WIN%)
- Score of 4 = NOT COUNTED (excluded from scoring) — coaching goal is to upgrade every 4 to a 5
- Scores 3, 2, 1 = ALL count as a complete FAIL, same weight as a 1 — they drag the score down equally
- This is why a store can have mostly "good" (4) answers and still have a terrible WIN score
- The single biggest lever: eliminate all 3s/2s/1s first (they all cost the same), then convert 4s to 5s
- When explaining a low WIN score, always note: "Every 3 counts the same as a 1 — the goal is 5s only"

VELOCITY IST FILE:
WTD IST tab = scorecard, AC table, and store/AC alignment
Daily tabs (e.g., 'Tue, Mar 31') = outlier analysis slide only
Level column: REGION | AREA | STORE

METRIC THRESHOLDS:
Sales Growth: Green >0% | Yellow -1 to -5% | Red <-5%
Labor Var: Green <=0% | Yellow 0.1-1.5% | Red >1.5%
OTD Avg Time: Green <18 | Yellow 18-21 | Red >21
WIN Score: Green >=60% | Yellow 40-59% | Red <40%
HUT Bot On Time: Green >=95% | Yellow 88-94% | Red <88%
IST outlier flag: WTD >22 min | Single day >23 min
HUT Bot Missed: >10% = flag on Focus Areas slide

DESIGN STANDARDS (never deviate):
Colors: Red #CC0000 | Dark #1A1A1A | White #FFFFFF | Light BG #F5F5F5
Status: Green #2E7D32 | Yellow #F57F17 | Red #C62828 | Gold #F9A825
Fonts: Arial Black for all headers and numbers | Calibri for body text
Dark slides (Title, Key Dates, Closing): #1A1A1A background, red left accent bar
Content slides: #F5F5F5 background, dark charcoal header bar, red left stripe
Stat cards: white card, colored top bar, large number, sub-label, note below divider
No bullet walls. No accent lines under titles.
Output format: structured JSON for PPTX generation

CRITICAL — STORE AND AC ALIGNMENT RULES:
1. PRIMARY SOURCE: Master alignment file if uploaded. Contains store numbers, AC names, RGM names, AC emails.
2. SECONDARY SOURCE: Velocity WTD IST file. Use if no master alignment file is provided.
3. Every store must be assigned to exactly one AC. Never leave a store unassigned.
4. When matching stores across files (FRS, WIN, SMG, HUT Bot), match by 6-digit store number — strip any prefix first.
5. RGM names for any manager callout come from the alignment source. Use the name from the file, not guessed.
CRITICAL — JSON FIELD NAMES (use EXACTLY these names, no variations):
- AC name in any row object: "name" (not acName, not areaCoach, not coach, not AC, not area_coach)
- Store name: "store"
- Store number: "storeNum"
- Sales growth: "salesGrowth"
- Labor variance: "laborVar"
- WIN score: "winScore"
- HUT Bot score: "hutBot"
- Crew OT dollars: "crewOT"
- HAM OT dollars: "hamOT"
- PCA percent: "pca"
- COS variance: "cosVar"
- Description/note: "description"
- AC name on a win/focus/customer voice item: "ac"

When you receive the uploaded files, analyze all data sources and return a structured JSON object with content ONLY for the slides you have real data for. Omit any slide key entirely if its required source file was not uploaded. The JSON MUST use exactly these field names:
{
  "regionName": "...",
  "weekLabel": "...",
  "recapCallDay": "...",
  "slides": {
    "title": { "regionName": "...", "weekLabel": "...", "stats": [{"label":"SALES GROWTH","value":"+2.2%","sub":"vs LY"}] },
    "scorecard": { "metrics": [{"label":"SALES GROWTH","value":"+2.2%","sub":"vs LY","status":"green"}], "hutBotBreakdown": {"onTime":"92%","late":"5%","missed":"3%","bottom5Stores":[{"store":"Store Name","storeNum":"039388","ac":"AC Full Name","manager":"Manager Full Name","onTime":"71%"}],"nonCompleters":[{"user":"Employee Full Name","store":"Store Name","storeNum":"039380","ac":"AC Full Name","routines":"FSCC, Pest Walk","status":"Not Started"},{"user":"Employee Full Name","store":"Store Name","storeNum":"039382","ac":"AC Full Name","routines":"Oven Calibration","status":"Late"}]} },
    "acTable": { "rows": [{"name":"Full AC Name","salesGrowth":"+4.9%","laborVar":"+2.14%","winScore":"67%","hutBot":"96%"}] },
    "wins": { "items": [{"store":"Store Name","storeNum":"039380","metric":"83% WIN Score","description":"...","ac":"AC Full Name"}] },
    "focusAreas": { "items": [{"store":"Store Name","storeNum":"039382","metric":"29.6 min IST","description":"...","ac":"AC Full Name"}] },
    "laborDeepDive": { "regionSummary": {"laborVar":"+1.78%","crewOT":"$3,688","hamOT":"$1,435","totalOT":"$5,123","pca":"26%","cosVar":"-0.7%"}, "acRows": [{"name":"Full AC Name","salesGrowth":"+4.9%","laborVar":"+2.14%","crewOT":"$377","hamOT":"$967","pca":"26.13%","cosVar":"-0.72%"}], "otFlags": "Highest OT: AC Name ($943), AC Name ($857)" },
    "speedOutlier": { "dailyChart": [{"day":"Tue 4/7","value":"18.2"}], "outlierStores": [{"store":"Store Name","storeNum":"039382","ist":"29.6 min","ac":"AC Name","note":"Highest in region"}] },
    "winByAC": { "regionAvg":"51%","rows": [{"name":"Full AC Name","winScore":"67%","status":"green","topStore":{"store":"Store Name","storeNum":"039380","winScore":"83%"},"bottomStore":{"store":"Store Name","storeNum":"039382","winScore":"31%"},"focusAreas":"Late/Slow (8), Cold Food (3)"}], "complaintThemes": [{"theme":"Late/Slow","count":"12"},{"theme":"Wrong Order","count":"8"}] },
    "winStoreSpotlight": { "top5": [{"name":"Store Name","storeNum":"039380","ac":"AC Name","winScore":"83%","smgInsight":"Consistently praised for fast delivery and order accuracy"}], "bottom5": [{"name":"Store Name","storeNum":"039388","ac":"AC Name","winScore":"28%","smgInsight":"Top complaint: Late/Slow — 6 comments this week"}] },
    "customerVoice": { "positives": [{"store":"Store Name (#039380)","ac":"AC Name","winScore":"72%","quote":"Actual verbatim quote copied from SMG file column G"},{"store":"Store Name (#039381)","ac":"AC Name","winScore":"68%","quote":"Actual verbatim quote copied from SMG file column G"},{"store":"Store Name (#039382)","ac":"AC Name","winScore":"81%","quote":"Actual verbatim quote copied from SMG file column G"},{"store":"Store Name (#039383)","ac":"AC Name","winScore":"65%","quote":"Actual verbatim quote copied from SMG file column G"},{"store":"Store Name (#039384)","ac":"AC Name","winScore":"59%","quote":"Actual verbatim quote copied from SMG file column G"}], "negatives": [{"store":"Store Name (#039385)","ac":"AC Name","winScore":"31%","quote":"Actual verbatim quote copied from SMG file column G"},{"store":"Store Name (#039386)","ac":"AC Name","winScore":"28%","quote":"Actual verbatim quote copied from SMG file column G"},{"store":"Store Name (#039387)","ac":"AC Name","winScore":"44%","quote":"Actual verbatim quote copied from SMG file column G"},{"store":"Store Name (#039388)","ac":"AC Name","winScore":"35%","quote":"Actual verbatim quote copied from SMG file column G"},{"store":"Store Name (#039389)","ac":"AC Name","winScore":"22%","quote":"Actual verbatim quote copied from SMG file column G"}], "themes": [{"theme":"Late/Slow","count":"12"},{"theme":"Cold Food","count":"8"}] },
    "smartGoals": { "goals": [{"metric":"In-Store Time","current":"18.6 min","target":"<18.0 min","byWhen":"End of P4","owner":"AC Full Name (stores 039382, 039388)","why":"3 of 5 stores above 18-min target; 2 SMG complaints this week cite slow delivery — pattern, not a one-off","how":"Specific action steps naming ACs and stores — e.g. Michelle Meehan to implement pre-rush staffing at 039388 by Thursday"}] },
    "keyDates": { "placeholders": 7 },
    "closing": { "acOfWeek": {"name":"Full AC Name","description":"Why they won — specific metric or achievement","note":"Keep pushing."}, "footerStats": [{"label":"Sales","value":"+2.2%"},{"label":"Labor","value":"+1.78%"},{"label":"IST","value":"18.6 min"},{"label":"WIN","value":"51%"}], "recapDay": "Thursday" }
  },
  "deck": { "title": "Weekly Recap", "subtitle": "Region . week label", "footer": "Week label . Ayvaz Pizza LLC", "slides": [ { "layout": "cover" } ] }
}

DESIGNING THE DECK - "deck" is the deck that actually gets built
The "slides" object above is the data. "deck" is how it is presented, and you design it: you choose which slides exist, their order and their layout. Build it from the same findings - do not go back to the files for it and do not contradict the data above.
Rules of thumb: open on the cover and the scorecard, then the story of the week (what moved and why), then the stores that need naming - wins and focus areas, labor and OT, speed outliers, WIN scores, customer voice - then the goals and who owns them, and close on what happens next. Leave a slide out when the data behind it is thin; a thin slide costs more than a missing one. A typical week is 10-16 slides. Keep about 6 rows on a table slide and 4 cards on a card slide - longer lists are paginated for you, so never pre-split them. Where a number only means something next to another number, say so on the slide rather than leaving two figures side by side.
Every slide takes an optional "title", "eyebrow" (short right-hand tag) and "notes" (speaker notes). The layouts:
"cover" - { "title", "subtitle", "eyebrow", "meta": [ { "label", "value", "sub" } ] } up to 4 stats.
"metrics" - { "title", "metrics": [ { "label", "value", "delta", "trend": "up|down|flat" } ], "narrativeTitle", "narrative": [ "..." ] } up to 5 cards over a takeaways box.
"table" - { "title", "subtitle", "columns": [ "AC", "Sales" ] or [ { "label", "align" } ], "rows": [ [ "cell", "cell" ] or { "cells": [...], "tier": "green|amber|red", "total": true } ], "note" }.
"cards" - { "title", "cards": [ { "severity": "Critical|High|Watch", "title", "body", "action" } ] }.
"bridge" - { "title", "items": [ { "driver", "varianceDollars", "bpsImpact", "explanation", "direction": "tailwind|headwind" } ] }.
"bullets" - { "title", "subtitle", "items": [ "..." or { "heading", "text", "tier" } ] }.
"twoColumn" - { "title", "left": { "heading", "items": [...] }, "right": { "heading", "items": [...] } } wins vs focus areas.
"callout" - { "title", "statement", "support": [ "..." ] } the one sentence of the week.
"quotes" - { "title", "quotes": [ { "text", "store", "date", "sentiment": "green|red" } ] } SMG verbatims, copied exactly.
"closing" - { "title", "items": [ "..." or { "heading", "text" } ], "signoff" } AC of the week, what happens next.
Use the real store names, store numbers and numbers from the files. No placeholders.`;

// ─── P&L Analyzer ──────────────────────────────────────────────────────────

async function analyzePL(file, opts = {}) {
  const { level = 'region', scopeTarget = '', glFile = null, frsFile = null, userName = '', scope = null, alignmentText = '', instructions = '' } = opts;
  const fileText = await extractTextFromFile(file);

  // Optional second and third sources. Every source is labelled so the analysis
  // can say which tie-outs it was able to run and which it could not.
  const present = ['P&L'];
  let frsBlock = '';
  if (frsFile) {
    try {
      const frsText = await extractTextFromFile(frsFile);
      frsBlock = `\n\n=== FRS STORE OPERATING REPORT ===\nThe store-side view. Tie P&L sales, COS and labor against this, and read its operations and loss-prevention signals.\n\n${frsText.slice(0, 30000)}\n=== END FRS ===`;
      present.push('FRS');
    } catch (e) { console.warn('[PL] FRS parse failed:', e.message); }
  }
  let glBlock = '';
  if (glFile) {
    try {
      const glText = await extractTextFromFile(glFile);
      glBlock = `\n\n=== GENERAL LEDGER / TRIAL BALANCE ===\nJournal detail behind the P&L lines: invoices, accruals, inventory entries, payroll by pay date, cash adjustments. Use it to find the root cause of a variance, and state which stores it does not cover.\n\n${glText.slice(0, 30000)}\n=== END GENERAL LEDGER ===`;
      present.push('GL');
    } catch (e) { console.warn('[PL] GL parse failed:', e.message); }
  }
  const sourceBlock = `\n\nSOURCES UPLOADED THIS RUN: ${present.join(' + ')}.${present.length === 1
    ? ' Only one source is available — do the single-source review well and say in the deck which checks (tie-outs, GL root cause) could not be run and what uploading the other files would add.'
    : ' Lead with the tie-outs between these sources.'}`;

  // Alignment context
  const alignBlock = alignmentText
    ? `\n\n=== MASTER ALIGNMENT (use for name/area/region lookups) ===\n${alignmentText.slice(0, 40000)}\n=== END ALIGNMENT ===`
    : '';

  // Scope context
  let scopeBlock = '';
  if (scope) {
    if (scope.type === 'area_coach') {
      scopeBlock = `Analysis requested by: ${userName} (Area Coach — ${scope.area}, Region: ${scope.region_coach}, VP: ${scope.vp})`;
    } else if (scope.type === 'rdo') {
      scopeBlock = `Analysis requested by: ${userName} (Region Coach — VP: ${scope.vp})`;
    } else if (scope.type === 'vp') {
      scopeBlock = `Analysis requested by: ${userName} (VP of Operations)`;
    }
  }

  // Custom instructions block
  const instructionsBlock = instructions
    ? `\n=== SPECIAL INSTRUCTIONS FROM THE OPERATOR ===\n${instructions}\nFollow these instructions carefully — they take priority over default behavior.\n=== END SPECIAL INSTRUCTIONS ===`
    : '';

  // Level-specific output instructions
  const levelInstructions = {
    auto: `Work out the scope yourself. Read the file first, see what it actually covers - one store, one area coach, a region, or every region in the territory - and review it at that level, the way you would if someone handed you the file and asked you to look at it.
${scopeTarget ? `They have asked you to focus on: ${scopeTarget}.
` : ''}The region object names whatever the file covers and who owns it. summary.acRows has one row per area coach when the file covers more than one, one row per store when it covers a single area, sorted by EBITDA % descending. Name specific stores, store numbers and dollar amounts throughout - a finding with no store and no number is not a finding. Say in the narrative what the file covers and what it does not, so nobody mistakes a one-area file for the whole region.
Design the deck for whoever has to act on it: the headline, the bridge, the tie-outs, the variances worth digging into, what has to be challenged before final close, a scrub list per area coach (or per store at a single area), and what happens next.`,

    territory: `Produce a TERRITORY-LEVEL review covering every region and area coach in the files.${scopeTarget ? ` Focus on: ${scopeTarget}.` : ''}
The region object describes the whole territory (all VPs and Regional Directors combined). summary.acRows carries every area coach across all regions, sorted by EBITDA % descending. The narrative speaks to territory-wide patterns — what is true in more than one region, and which region is the outlier. Design the deck for a VP: fewer store names, more pattern, and one slide per region before the per-AC scrub lists.`,

    region: `Produce a REGION-LEVEL review.${scopeTarget ? ` Focus on the ${scopeTarget} region.` : ' Cover every area coach in the files.'}
The region object names the region and its director. summary.acRows has one row per area coach, sorted by EBITDA % descending. Name specific stores, store numbers and dollar amounts throughout — a finding with no store and no number is not a finding. Design the deck for the Regional Director's own review: the headline, the bridge, the tie-outs, what has to be challenged before final close, a scrub-list slide per area coach, and what happens next.`,
    area: `Produce an AREA COACH-LEVEL analysis.${scopeTarget ? ` The area coach is: ${scopeTarget}.` : ' Analyze the area coach whose sheet appears first, or the summary tab.'}
Return this JSON format (NOT the 8-slide region format):
{
  "period": "P04-26",
  "region": { "name": "...", "company": "Ayvaz Pizza LLC", "director": "..." },
  "acName": "...",
  "totalStores": 6,
  "coverKPIs": [
    {"label": "EBITDA %", "value": "17.5%"},
    {"label": "EBITDA vs PY", "value": "+$12,450"},
    {"label": "Net Sales", "value": "$545K"},
    {"label": "Total Direct Labor %", "value": "25.5%"},
    {"label": "Cost of Food Sales %", "value": "27.0%"}
  ],
  "scorecard": [
    {"name": "Store Name", "storeNum": "039380", "status": "green", "netSales": "$71,304", "netSalesVsPY": "+3.2%", "cosPct": "27.1%", "laborPct": "21.8%", "laborPY": "24.2%", "scpPct": "38.5%", "ebitdaPct": "25.2%", "ebitdaPY": "17.5%"}
  ],
  "laborChart": {"labels": ["Store A", "Store B"], "current": [21.8, 28.5], "prior": [24.2, 27.1], "ytdLines": ["YTD Labor: 25.5% vs PY 26.8%"], "insight": "..."},
  "cosChart": {"labels": ["Store A", "Store B"], "current": [27.1, 28.8], "prior": [28.0, 28.5], "storeCards": [{"name": "Store A", "trend": "down", "p3": "27.1%", "py": "28.0%", "ytd": "27.5%", "ytdPY": "28.1%"}], "insight": "..."},
  "ebitdaChart": {"labels": ["Store A", "Store B"], "current": [25.2, 12.8], "prior": [17.5, 11.2], "ytdItems": [{"name": "Store A", "ytd": "22.3%", "ytdPY": "18.1%"}], "insight": "..."},
  "anomalies": [{"name": "Store Name", "storeNum": "039381", "status": "red", "items": [{"line": "Payroll - R&M", "p3": "$1,842", "py": "$284", "note": "Who was paid? Needs authorization check"}]}],
  "spotlights": {"crisis": {"name": "Store C (#39381)", "bullets": ["Labor 31.2% on $58K", "EBITDA negative", "3 line item spikes"]}, "urgent": null, "brightSpot": {"name": "Store A (#39380)", "bullets": ["25.2% EBITDA", "Labor improved 240 bps", "Model store"]}, "structural": null},
  "coachingPriorities": [{"number": "01", "status": "red", "title": "...", "body": "..."}, {"number": "02", "status": "amber", "title": "...", "body": "..."}, {"number": "03", "status": "amber", "title": "...", "body": "..."}, {"number": "04", "status": "green", "title": "...", "body": "..."}]
}
Rules: scorecard status = "green" if EBITDA ≥ 10%, "amber" if 0-9.9%, "red" if negative. Chart arrays must be RAW NUMBERS not strings. All 4 coachingPriorities required. Set unused spotlight quadrants to null.`,

    store: `Produce a STORE-LEVEL analysis.${scopeTarget ? ` Focus on store: ${scopeTarget}.` : ' Analyze the primary store tab in the file.'}
${glFile ? 'A General Ledger file has been provided — cross-reference every expense line against it.' : ''}
Return this JSON format:
{
  "period": "P04-26",
  "region": { "name": "...", "company": "Ayvaz Pizza LLC", "director": "..." },
  "storeName": "...",
  "storeNum": "039380",
  "acName": "...",
  "headline": {
    "netSales": "$71,304", "netSalesVsPY": "+3.2%",
    "ebitda": "$17,976", "ebitdaPct": "25.2%", "ebitdaVsPY": "+747 bps",
    "laborPct": "21.8%", "laborVsPY": "-240 bps",
    "cogsPct": "27.1%", "cogsVsPY": "-90 bps",
    "storeStatus": "green"
  },
  "plLines": [
    {"label": "Product Net Sales", "current": "$71,304", "currentPct": "100%", "py": "$69,100", "pyPct": "100%", "varDollars": "+$2,204", "varBps": "—", "flag": ""},
    {"label": "Cost of Food Sales", "current": "$19,320", "currentPct": "27.1%", "py": "$19,348", "pyPct": "28.0%", "varDollars": "-$28", "varBps": "-90", "flag": ""},
    {"label": "Total Direct Labor Cost", "current": "$15,544", "currentPct": "21.8%", "py": "$16,740", "pyPct": "24.2%", "varDollars": "-$1,196", "varBps": "-240", "flag": ""},
    {"label": "Store Level EBITDA", "current": "$17,976", "currentPct": "25.2%", "py": "$12,100", "pyPct": "17.5%", "varDollars": "+$5,876", "varBps": "+770", "flag": ""}
  ],
  "anomalies": [{"line": "Payroll - R&M", "current": "$1,842", "py": "$284", "severity": "High", "note": "..."}],
  "coachingNotes": [
    {"priority": 1, "status": "red", "title": "...", "detail": "..."},
    {"priority": 2, "status": "amber", "title": "...", "detail": "..."},
    {"priority": 3, "status": "green", "title": "...", "detail": "..."}
  ],
  "glInsights": ${glFile ? '"Cross-reference findings from the General Ledger go here — specific line-level cost variances and unusual items identified"' : 'null'}
}
Include ALL 22 P&L line items in plLines. Flag any line where current period is significantly worse than prior period. storeStatus = "green" if EBITDA ≥ 10%, "amber" if 0-9.9%, "red" if negative.`
  };

  const levelLine = level === 'auto' ? '' : `Analysis Level: ${level.toUpperCase()}${scopeTarget ? ` — ${scopeTarget}` : ''}`;
  const userMessage = `${scopeBlock ? scopeBlock + '\n' : ''}${levelLine}
${instructionsBlock}
${levelInstructions[level] || levelInstructions.auto}

${sourceBlock}

=== PRELIMINARY P&L ===

${fileText}
=== END P&L ===${frsBlock}${glBlock}${alignBlock}`;

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 32000,   // a Claude-designed deck plus per-AC scrub lists runs long
    system: [{ type: 'text', text: PL_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userMessage }]
  });

  const responseText = message.content[0].text;

  try {
    const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) return JSON.parse(jsonMatch[1]);
    const s = responseText.indexOf('{');
    const e = responseText.lastIndexOf('}');
    if (s !== -1 && e !== -1) return JSON.parse(responseText.slice(s, e + 1));
  } catch (_) { /* fall through */ }

  return responseText;
}

// ─── Weekly Recap Analyzer ──────────────────────────────────────────────────

const RECAP_LEVEL_INSTRUCTIONS = {
  territory: `ANALYSIS LEVEL: TERRITORY — You are building a TERRITORY-LEVEL recap for a VP of Operations spanning multiple regions. In the acTable, each row = one REGIONAL DIRECTOR (not individual ACs). The scorecard shows region-by-region performance. Wins/focus areas identify the best and worst performing regions. Slide titles should say "Territory" not "Region". The closing AC of the Week should be a top-performing AC or RD across all regions.`,
  area: `ANALYSIS LEVEL: AREA COACH — You are building a recap for a single AC's stores only. In the acTable, each row = one STORE (not other ACs). The scorecard is store-by-store within this AC's area. Wins/focus areas are specific stores. Every slide should have store-level specificity — store name and number for every data point. Slide titles should include the AC name.`,
  store: `ANALYSIS LEVEL: STORE — You are building a recap for a single store. All slides focus on this one store. The scorecard shows day-level or shift-level breakdowns for the week. The acTable shows metric breakdowns by day or category. Wins and focus areas are specific items from this store's week. Slide titles should include the store name and number.`,
};

async function analyzeRecap(files, weekLabel, recapDay, lastAcOfWeek, alignmentText, historicalContext, instructions, level = 'region') {
  // Extract text from all uploaded files
  const fileTexts = await Promise.all(files.map(async (file) => {
    try {
      const text = await extractTextFromFile(file);
      return `=== FILE: ${file.originalname} ===\n${text}`;
    } catch (err) {
      return `=== FILE: ${file.originalname} === [ERROR READING: ${err.message}]`;
    }
  }));

  const combinedText = fileTexts.join('\n\n---\n\n');

  const fileNames = files.map(f => f.originalname).join(', ');

  // Persistent alignment text passed in from DB — never requires re-upload
  const alignBlock = alignmentText
    ? ('\n\n=== MASTER ALIGNMENT FILE (authoritative — use for all store/AC/RGM lookups) ===\n'
        + alignmentText.slice(0, 10000)
        + '\n=== END MASTER ALIGNMENT ===')
    : '';
  const alignNote = alignmentText
    ? 'Master alignment data is included at the bottom — use it for all store/AC/RGM name resolution.'
    : 'No alignment file on record — derive store/AC data from the uploaded reports directly.';

  const fiscalContext = getFiscalContextString();

  const historyBlock = historicalContext
    ? `\n\n=== HISTORICAL CONTEXT — LAST ${historicalContext.split('\n\nWeek').length} WEEKS ===\nUse this to identify multi-week trends, repeat offenders, and stores/ACs that are improving or declining. Reference prior weeks explicitly in your analysis where relevant.\n\n${historicalContext}\n=== END HISTORICAL CONTEXT ===`
    : '';

  const instructionsBlock = instructions && instructions.trim()
    ? `\n\n=== SPECIAL INSTRUCTIONS FROM THE OPERATOR ===\n${instructions.trim()}\n=== END SPECIAL INSTRUCTIONS ===\nFollow these instructions carefully. They take priority over default analysis behavior.`
    : '';

  const levelBlock = (level && level !== 'region' && RECAP_LEVEL_INSTRUCTIONS[level])
    ? `\n\n${RECAP_LEVEL_INSTRUCTIONS[level]}`
    : '';

  const userMessage = `I've uploaded ${files.length} weekly report file(s): ${fileNames}

${fiscalContext}${levelBlock}

Build the recap deck using whatever data is available in these files. If some data sources are missing, build the slides you can with the data provided and note where data was unavailable — do not fail or refuse because of missing files. Work with what you have.

Week: ${weekLabel || '[not specified]'}
Recap call day: ${recapDay || 'Thursday'}
${lastAcOfWeek ? `Last week's AC of the Week: ${lastAcOfWeek} — DO NOT pick this person again this week. Choose the next most deserving AC based on the data.` : ''}
NOTE: ${alignNote}
${instructionsBlock}${historyBlock}

Here are the file contents:

${combinedText}${alignBlock}

CRITICAL INSTRUCTIONS FOR JSON OUTPUT:
1. First, inventory every file uploaded — name, type, and what data it contains.
2. EVERY FILE GETS ANALYZED. Known report types → designated slides. Unknown files → additionalSlides entries. No file is ever skipped.
3. Build deck slides ONLY for data you actually found. If a source file was not uploaded, omit that key entirely.
4. NEVER use placeholder text, empty arrays as filler, or "[Data not available]" strings. A missing key is always correct. A slide with fake data is always wrong.
5. If you have genuine questions that would materially change the output, return the needsInput JSON format instead of the deck JSON.
6. If no questions, return the full deck JSON directly. Do not hedge or explain — just return the JSON.
Return either the needsInput JSON (if you have real questions) or the full deck JSON (if you can proceed).`;

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 32000,   // recap decks now carry their own slide spec
    system: [{ type: 'text', text: RECAP_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userMessage }]
  });

  const responseText = message.content[0].text;

  // Try to parse JSON from response
  try {
    let parsed;
    const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      parsed = JSON.parse(jsonMatch[1]);
    } else {
      const start = responseText.indexOf('{');
      const end = responseText.lastIndexOf('}');
      if (start !== -1 && end !== -1) {
        parsed = JSON.parse(responseText.slice(start, end + 1));
      }
    }
    if (parsed) {
      // needsInput: Claude has clarifying questions — pass through to frontend
      if (parsed.needsInput === true) return parsed;
      return parsed;
    }
    return { rawContent: responseText };
  } catch {
    return { rawContent: responseText };
  }
}

// ─── Daily Intel System Prompt ─────────────────────────────────────────────

const DAILY_SYSTEM_PROMPT = `You are P.AI, an elite daily operations intelligence system for Ayvaz Pizza LLC, a Pizza Hut franchisee. You analyze daily operational reports uploaded by RDOs, Area Coaches, and VPs and return structured, actionable intelligence.

REPORTS YOU MAY RECEIVE (in any combination — work with whatever is provided):
- DBS (Daily Business Summary): sales, transaction counts, APC (avg per customer), daypart splits, delivery vs carryout
- Labor Analytics: labor %, crew hours, manager hours, overtime, schedule vs actual
- SMG Reports: customer satisfaction scores (1–5 scale), verbatim comments, survey counts
- WIN Scores: operational compliance scores (stored as decimals — 0.48 = 48%). WIN scoring: 5s count toward score, 4s are excluded/not scored (goal: convert 4s to 5s), and 3s/2s/1s ALL count as a complete fail — same weight as a 1. This is why a store with mostly 4s and a few 3s has a shockingly low WIN score. The lever is: eliminate 3s first (they hurt as much as 1s), then convert 4s to 5s.
- Velocity/OTD Reports: delivery speed, on-time %, outliers
- Any other operational report — identify it from context and extract what you can

PIZZA HUT FRANCHISE BENCHMARKS:
- Labor %: Target ~28% | Yellow 28–31% | Red >31%
- SMG Overall: Target 80+ | Yellow 75–79 | Red <75
- OTD Avg Time: Green <18 min | Yellow 18–21 | Red >21
- WIN Score: Green >=60% | Yellow 40–59% | Red <40% (5=pass, 4=excluded, 3/2/1=all count as fail)
- Sales Growth: Green >0% vs LW/LY | Yellow -1 to -5% | Red < -5%

CROSS-REFERENCING — CRITICAL. When multiple reports are provided, actively look for these connections:
- Slow OTD/Velocity times + SMG comments about wait times/cold food = delivery execution problem, not just a speed number
- High labor % + low sales = overstaffing or scheduling misalignment — flag the specific stores
- Low WIN scores + low SMG scores at the same store = operational breakdown driving customer dissatisfaction
- Labor over target + high overtime = scheduling structure issue vs. just a cost issue
- Strong sales + declining SMG = growth outpacing team capability — capacity warning
- DBS showing low APC + SMG comments about upselling = training gap
- Daypart drop in DBS + specific SMG complaint themes = time-of-day service failure
Always call these connections out explicitly. Don't just list metrics in isolation — connect the dots.

OUTPUT FORMAT — Always use this exact markdown structure:

## 🎯 DAILY INTEL SUMMARY
2–3 sentence executive read of the day. Lead with the single most important takeaway.

## 📊 KEY METRICS
Bullet each important number from the data. Format: **[Label]:** [Value] — [brief context vs target or prior period]

## ✅ WINS
3–5 specific wins with data to back them up. Be direct and specific — no generic praise.

## ⚠️ WATCH LIST
3–5 specific concerns or underperformance items. Flag anything that needs follow-up today.

## 🔗 CONNECTIONS & INSIGHTS
This is the most important section. Cross-reference across all reports provided. Explicitly connect metrics from different sources that point to the same root cause. E.g. "Store X has OTD avg 24 min AND 3 SMG comments about cold/late food this week — this is the same problem showing up in two data sources." If only one report is provided, note what additional data would strengthen or change the analysis.

## 📋 ACTION ITEMS
4–6 specific, owner-assignable actions. Format: **[Who/What]:** [specific action]

TONE: Direct, confident, no fluff. These are operational leaders — they want the signal, not the noise.`;

// ─── Daily Intel Analyzer ──────────────────────────────────────────────────

async function analyzeDaily(files, alignmentText) {
  const fileTexts = await Promise.all(files.map(async (file) => {
    try {
      const text = await extractTextFromFile(file);
      return `=== REPORT: ${file.originalname} ===\n${text}`;
    } catch (err) {
      return `=== REPORT: ${file.originalname} === [ERROR READING: ${err.message}]`;
    }
  }));

  const combinedText = fileTexts.join('\n\n---\n\n');
  const reportCount = files.length;
  const reportNames = files.map(f => f.originalname).join(', ');

  const fiscalContext = getFiscalContextString();

  const userMessage = `I've uploaded ${reportCount} daily report${reportCount !== 1 ? 's' : ''}: ${reportNames}

${fiscalContext}

Analyze all data provided and return the full Daily Intel Report following your output format.

${combinedText}`;

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 8192,
    system: DAILY_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }]
  });

  return message.content[0].text;
}


// ─── Trend Analyzer ────────────────────────────────────────────────────────

const TREND_SYSTEM_PROMPT = `You are P.AI's trend intelligence engine for Ayvaz Pizza LLC. You receive a chronological series of daily intelligence reports spanning multiple days and identify multi-day patterns, trajectories, and cross-report correlations that no single day's analysis would reveal.

YOUR JOB:
- Find what keeps repeating across days (stores always on the watch list, metrics consistently over target)
- Identify directional trends (is labor creeping up week over week? Is SMG improving or declining?)
- Surface cross-metric correlations across time (OTD has been bad all week AND SMG comments about speed are increasing — that's a confirmed systemic problem, not a one-day blip)
- Distinguish systemic region-wide issues from isolated store problems
- Call out what's improving that should be reinforced
- Prioritize the 3–5 things that need attention NOW based on trend weight

OUTPUT FORMAT:

## 📈 TREND SUMMARY
2–3 sentence overall trajectory read. Is the region trending up, down, or mixed? What's the dominant story?

## 🔄 RECURRING PATTERNS
What keeps showing up day after day? List each with how many days it appeared. Be specific — name stores, metrics, numbers.

## 🔗 CONFIRMED CORRELATIONS
Where are multiple data sources pointing at the same root cause over multiple days? These are your highest-confidence findings.

## 📉 DETERIORATING METRICS
What is measurably getting worse? Show the direction with any numbers available.

## 📈 IMPROVING METRICS
What is measurably getting better? Reinforce these.

## 🎯 SYSTEMIC vs. ISOLATED
Which watch items are one-store problems vs. region-wide concerns? Distinguish clearly.

## ⚡ TOP PRIORITIES
Ranked list of 3–5 actions based on trend weight — what needs the most urgent attention and why.

TONE: This is a strategic briefing, not a summary. Leaders reading this should walk away knowing exactly where to focus their energy.`;

async function analyzeTrends(recentReports) {
  if (!recentReports || recentReports.length < 2) {
    return '## ⚠️ Not Enough Data\n\nAt least 2 daily reports are needed to identify trends. Keep running Daily Intel and check back.';
  }

  const context = recentReports
    .slice()
    .reverse()
    .map((r, i) => {
      const date = new Date(r.created_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      const reports = r.report_names || 'unknown reports';
      return `=== DAY ${i + 1}: ${date} (Reports: ${reports}) ===\n${r.analysis_text}`;
    })
    .join('\n\n---\n\n');

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 8192,
    system: TREND_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `Here are ${recentReports.length} daily intelligence reports in chronological order. Analyze for trends, patterns, and confirmed cross-report correlations.\n\n${context}` }]
  });

  return message.content[0].text;
}

// ─── Daily Intel Email Generator ──────────────────────────────────────────

async function generateDailyIntelEmail(analysisText, options = {}) {
  const tone = options.tone || 'direct';
  const length = options.length || 'standard';

  const toneGuide = {
    direct: 'Direct and to the point. No fluff. Lead with the single most critical finding.',
    professional: 'Professional and polished. Complete sentences. Formal but not stiff.',
    brief: 'Ultra-brief. 3-5 bullet points max. Get in, get out.'
  }[tone] || 'direct and clear';

  const lengthGuide = {
    brief: 'Under 100 words. Headline + 3 bullets + one action.',
    standard: '150-250 words. Key metrics, top win, top concern, and action items.',
    detailed: '300-400 words. All sections from the analysis, with context.'
  }[length] || 'standard';

  const system = `You are drafting a daily ops intel email from Harold Lacoste (Regional Director, Ayvaz Pizza LLC / Pizza Hut).
Tone: ${toneGuide}
Length: ${lengthGuide}

Format the output as JSON:
{
  "subject": "Subject line here",
  "htmlBody": "HTML body using only <p>, <strong>, <ul>, <li> tags. Include Harold Lacoste | Regional Director | Ayvaz Pizza LLC signature at end.",
  "plainText": "Plain text version"
}

Pull real numbers and store names from the analysis. Never use placeholder text.`;

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system,
    messages: [{ role: 'user', content: `Convert this daily intel analysis into an email:\n\n${analysisText}` }]
  });

  const raw = message.content[0].text;
  try {
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) return JSON.parse(jsonMatch[1]);
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end !== -1) return JSON.parse(raw.slice(start, end + 1));
    return { subject: 'Daily Ops Intel', htmlBody: `<p>${raw}</p>`, plainText: raw };
  } catch {
    return { subject: 'Daily Ops Intel', htmlBody: `<p>${raw}</p>`, plainText: raw };
  }
}

// ─── Recap Email Generator ─────────────────────────────────────────────────

async function generateRecapEmail(data, options = {}) {
  const tone = options.tone || 'direct';
  const length = options.length || 'standard';

  const toneGuide = {
    direct: 'Confident and direct. Short declarative sentences. Data first. No filler.',
    professional: 'Formal, executive-level. Complete sentences. No slang.',
    conversational: 'Warm and collegial. Write like a person, not a report.',
    brief: 'Extremely concise. Bullet-heavy. Under 200 words total.'
  }[tone] || 'direct and clear';

  const lengthGuide = {
    brief: '3–5 key points only. Under 150 words. Lead with the #1 takeaway.',
    standard: '8–12 key points. Cover wins, watch items, and top 2–3 goals.',
    detailed: 'Full recap. Cover all major metrics, wins, focus areas, all goals, and a closing note.'
  }[length] || 'standard length covering key highlights';

  const system = `You are drafting a weekly region recap email from Harold Lacoste (RDO, Ayvaz Pizza LLC) to his Area Coach team.

Tone: ${toneGuide}
Length: ${lengthGuide}

Return a JSON object with this exact shape:
{
  "subject": "Email subject line",
  "htmlBody": "Full HTML body using only <p>, <ul>, <li>, <strong>, <br> tags. End with Harold Lacoste | Regional Director | Ayvaz Pizza LLC signature.",
  "plainText": "Plain text version"
}

Include: week/period label, top wins with specific numbers, top concerns with specific stores, WIN score summary, AC of the week callout, and a closing call-to-action. Use real data from the JSON — no placeholders.`;

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system,
    messages: [{ role: 'user', content: `Generate a ${tone} tone, ${length} length weekly recap email from this data:\n\n${JSON.stringify(data, null, 2)}` }]
  });

  const raw = message.content[0].text;
  try {
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) return JSON.parse(jsonMatch[1]);
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    if (start !== -1 && end !== -1) return JSON.parse(raw.slice(start, end + 1));
    return { subject: 'Weekly Recap', htmlBody: `<p>${raw}</p>`, plainText: raw };
  } catch {
    return { subject: 'Weekly Recap', htmlBody: `<p>${raw}</p>`, plainText: raw };
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────────

// ─── Area Coach P&L Analyzer ────────────────────────────────────────────────

const PL_AC_SYSTEM_PROMPT = `You are analyzing a Pizza Hut franchise P&L file for a single Area Coach's area. The file contains one tab per store (5-8 stores) plus possibly a summary tab for the area. Your job is to produce a detailed, honest, data-driven analysis that the Area Coach will use to run their area review.

THE P&L FILE
Each store tab follows this column structure:
* Columns 11-12: Current Period (amount + % of net sales)
* Columns 14-15: Prior Year same period (amount + % of net sales)
* Columns 17-18: Period Variance (amount + %)
* Columns 20-21: YTD Current Year (amount + % of net sales)
* Columns 23-24: YTD Prior Year (amount + % of net sales)
All percentages are expressed as a decimal (e.g., 0.274 = 27.4%). Convert to percentage strings in output.

KEY METRICS
- Net Sales: top-line revenue. Flag declines vs PY especially on YTD.
- COS% (Cost of Food Sales): target 26-29%. Above 30% = elevated. Flag YOY direction.
- Direct Labor% (Total Direct Labor Cost): PRIMARY metric. Under 25% = excellent. 25-28% = acceptable. 28-32% = watch. Above 32% = coaching needed. Above 40% = crisis.
- SCP% (Store Controllable Profit): strong = 30%+. Weak = below 20%.
- EBITDA% (Store Level EBITDA): healthy = 12%+. Marginal = 5-12%. At-risk = 0-5%. Negative = losing money. Never conflate improvement with profitability.
- BPS: 1 basis point = 0.01%. Use this language for percentage point changes.

CONTROLLABLE EXPENSE SUB-LINES — flag any spike vs PY:
- Payroll - R&M: flag above $400 baseline — ask who was paid, for what
- Pest Control: flag spikes (e.g., $480 vs $57 PY)
- Safety/Security Repairs: flag if new
- Grease Trap: flag if new or recurring
- Food Supplier Supplies: flag if up 40%+ vs PY
- Cash Over/Short: flag swings above $100 vs PY
- Electric/Gas/Water: flag any single utility up 30%+ vs PY

OUTPUT FORMAT — CRITICAL
Return a single JSON object in a \`\`\`json code block. This is the data for ONE area coach's 8-slide deep-dive deck. No preamble, no markdown outside the block.

{
  "acName": "Daria Spikes",
  "period": "P3 2026",
  "totalStores": 7,
  "coverKPIs": [
    {"label": "EBITDA %",     "value": "17.5%"},
    {"label": "EBITDA vs PY", "value": "+$12,450"},
    {"label": "Net Sales",    "value": "$545K"},
    {"label": "Labor %",      "value": "25.5%"},
    {"label": "COS %",        "value": "27.0%"}
  ],
  "scorecard": [
    {
      "name": "Wells Street", "storeNum": "38876", "status": "green",
      "netSales": "$71,304", "netSalesVsPY": "+3.2%",
      "cosPct": "27.1%", "laborPct": "21.8%", "laborPY": "24.2%",
      "scpPct": "38.5%", "ebitdaPct": "25.2%", "ebitdaPY": "17.5%"
    }
  ],
  "laborChart": {
    "labels": ["Wells St", "Store B", "Store C"],
    "current": [21.8, 28.5, 31.2],
    "prior":   [24.2, 27.1, 30.5],
    "ytdLines": ["YTD Labor: 25.5% vs PY 26.8% (-130 bps)", "3 of 7 stores improved vs PY"],
    "insight": "Wells Street best at 21.8%. Store C above 31% on $58K volume -- overstaffed."
  },
  "cosChart": {
    "labels": ["Wells St", "Store B", "Store C"],
    "current": [27.1, 28.8, 30.2],
    "prior":   [28.0, 28.5, 29.8],
    "storeCards": [
      {"name": "Wells St", "trend": "down", "p3": "27.1%", "py": "28.0%", "ytd": "27.5%", "ytdPY": "28.1%"}
    ],
    "insight": "COS improving led by Wells Street (-90 bps). Store C trending up -- check portioning."
  },
  "ebitdaChart": {
    "labels": ["Wells St", "Store B", "Store C"],
    "current": [25.2, 12.8, -4.1],
    "prior":   [17.5, 11.2,  3.4],
    "ytdItems": [
      {"name": "Wells St", "ytd": "22.3%", "ytdPY": "18.1%"}
    ],
    "insight": "Store C flipped negative. Labor spike of 8.4 pts vs PY is the entire story."
  },
  "anomalies": [
    {
      "name": "Store C", "storeNum": "39381", "status": "red",
      "items": [
        {"line": "Payroll - R&M",  "p3": "$1,842", "py": "$284", "note": "Who was paid? Needs authorization check"},
        {"line": "Pest Control",   "p3": "$480",   "py": "$57",  "note": "Spike -- new vendor or recurring?"},
        {"line": "Cash Short",     "p3": "$214",   "py": "$18",  "note": "Cash handling concern -- review with GM"}
      ]
    }
  ],
  "spotlights": {
    "crisis":     {"name": "Store C (#39381)", "bullets": ["Labor 31.2% on $58K -- overstaffed", "EBITDA negative (-4.1%)", "3 controllable line item spikes"]},
    "urgent":     {"name": "Store B (#39383)", "bullets": ["COS trending up 3 periods", "GM has not submitted COGS correction", "Review scheduling and portioning"]},
    "brightSpot": {"name": "Wells Street (#38876)", "bullets": ["25.2% EBITDA -- area best", "Labor improved 240 bps vs PY", "Model store -- cross-train other GMs"]},
    "structural": {"name": "Area Trend", "bullets": ["3 of 7 stores improved EBITDA vs PY", "Labor discipline is the primary driver", "COS gaps suggest inconsistent portioning"]}
  },
  "coachingPriorities": [
    {"number": "01", "status": "red",   "title": "Store C -- Labor Crisis",       "body": "31.2% on $58K is structural. Schedule audit this week. GM must explain the $1,842 R&M charge."},
    {"number": "02", "status": "red",   "title": "Store C -- Controllable Spikes","body": "Three line-item spikes this period. Pull pest control and R&M invoices. Investigate $214 cash short."},
    {"number": "03", "status": "amber", "title": "Store B -- COS Trend",          "body": "3-period upward COS trend. Do a full portioning observation before next period closes."},
    {"number": "04", "status": "green", "title": "Replicate Wells Street",         "body": "25.2% EBITDA, area best. Cross-train Store C GM here this period. Document what they do differently."}
  ]
}

RULES:
- Fill every field with real numbers from the file. No placeholders.
- scorecard: one row per store, all 8 metric columns populated.
- laborChart.current / cosChart.current / ebitdaChart.current: RAW NUMBERS only (e.g., 27.4 not "27.4%"). The chart renderer converts to percentages.
- status on scorecard rows: "green" if EBITDA >= 10%, "amber" if 0-9.9%, "red" if negative.
- anomalies: include every store with at least one sub-line spike vs PY. Up to 4 stores.
- spotlights.crisis: only if a store has negative EBITDA this period. Set to null if none.
- spotlights: set unused quadrants to null.
- coachingPriorities: exactly 4 items. status = "red", "amber", or "green". Lead with the most urgent.
- All percentages as strings ("17.5%"). Dollar amounts as strings ("$95,114" or "($19,369)" for negatives).
- storeCards in cosChart: one card per store, trend = "up" or "down" vs PY.`;

async function analyzePLForAC(file, acName) {
  const fileText = await extractTextFromFile(file);

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 8192,
    system: PL_AC_SYSTEM_PROMPT,
    messages: [{
      role: 'user',
      content: `Area Coach: ${acName}\n\nHere is the P&L data to analyze:\n\n${fileText}`
    }]
  });

  const responseText = message.content[0].text;

  try {
    const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) return JSON.parse(jsonMatch[1]);
    const s = responseText.indexOf('{');
    const e = responseText.lastIndexOf('}');
    if (s !== -1 && e !== -1) return JSON.parse(responseText.slice(s, e + 1));
  } catch (_) { /* fall through */ }

  return responseText;
}

// ─── Analyze Additional Content (append to existing deck) ────────────────────

async function analyzeAdditionalContent(files, rawText, topic) {
  const parts = [];

  if (files && files.length) {
    for (const f of files) {
      const text = await extractTextFromFile(f);
      parts.push(`=== FILE: ${f.originalname} ===\n${text}`);
    }
  }
  if (rawText && rawText.trim()) {
    parts.push(`=== PASTED CONTENT ===\n${rawText.trim()}`);
  }

  const content = parts.join('\n\n');
  if (!content) throw new Error('No content provided to analyze.');

  const prompt = `You are analyzing additional information to be added as slides to an existing weekly region recap presentation for a pizza franchise operator (Ayvaz Pizza LLC / Pizza Hut).

TOPIC: ${topic || 'Additional Information'}

CONTENT TO ANALYZE:
${content}

Analyze this content and return a JSON object with this exact structure:
{
  "title": "Short slide title (max 6 words, all caps)",
  "source": "Brief source description (e.g. 'Crispy Pan Training Rollout')",
  "bullets": [
    { "text": "Key point or finding", "bold": false },
    { "text": "Important metric or action item", "bold": true }
  ],
  "narrative": "Optional 2-3 sentence summary if bullets alone are insufficient"
}

Rules:
- Extract the most operationally relevant points (max 10 bullets)
- Mark bullets as bold: true if they are action items, goals, or critical metrics
- Keep each bullet under 120 characters
- If the content is training-related, focus on what managers need to DO
- If data/metrics, highlight the most important numbers
- Return ONLY valid JSON, no markdown fences`;

  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }]
  });

  const raw = msg.content[0]?.text || '';
  try {
    const m = raw.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : { title: topic || 'ADDITIONAL INFO', bullets: [], narrative: raw };
  } catch {
    return { title: topic || 'ADDITIONAL INFO', bullets: [], narrative: raw };
  }
}

// ─── Exports ──────────────────────────────────────────────────────────────────────

// ─── Morning Brief Generator ────────────────────────────────────────────────

async function generateMorningBrief({ date, userName, userRole, fiscalContext,
  regionMetrics, byAC, byStore, velocity, flags, shoutouts, followUps, operationalAlerts,
  scorecard }) {

  const isAC = userRole === 'area_coach';
  const isVP = userRole === 'vp';
  const fmtDollar = n => n != null ? '$' + Math.round(n).toLocaleString('en-US') : 'N/A';
  const fmtGrowth = n => n != null ? (n >= 0 ? '+' : '') + Number(n).toFixed(1) + '% vs LY' : 'no LY data';

  // ── Fiscal day code (D = day within Tue–Mon week: Tue=1 … Mon=7) ──
  const dow = new Date(date + 'T12:00:00Z').getUTCDay(); // 0=Sun,1=Mon,2=Tue…
  // Tue=1,Wed=2,Thu=3,Fri=4,Sat=5,Sun=6,Mon=7
  const fiscalDay = [6, 7, 1, 2, 3, 4, 5][dow];
  const fiscalMatch = (fiscalContext || '').match(/\(P(\d+)W(\d+)\)/);
  const fiscalCode = fiscalMatch ? `P${fiscalMatch[1]}W${fiscalMatch[2]}D${fiscalDay}` : '';
  const briefDow = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'][dow];

  // ── Section 1: Header ─────────────────────────────────────────────
  // Show today's briefing date + the data date so it's clear what period is covered
  const todayStr = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const header = todayStr !== date
    ? `MORNING BRIEF — ${todayStr}${fiscalCode ? ' — ' + fiscalCode : ''}\nResults from ${date} (${briefDow})`
    : `MORNING BRIEF — ${date}${fiscalCode ? ' — ' + fiscalCode : ''}`;

  // ── Section 2: Scorecard — deterministic, plus a two-sentence lede ──
  // The numbers are rendered from the scorecard, never written by the model, so
  // nothing here can be hallucinated or rounded differently run to run. The model
  // only gets to say what the numbers mean, in two sentences, above the table.
  const { renderScorecard } = require('./scorecard');
  // No fiscalCode here — the brief header two lines up already carries it.
  const scorecardSection = scorecard ? renderScorecard(scorecard, {}) : '';

  const statBar = regionMetrics.store_count > 0
    ? `${fmtDollar(regionMetrics.net_sales_day)} | ${fmtGrowth(regionMetrics.avg_growth_day)} | ${regionMetrics.store_count} stores`
    : 'No sales data for this date.';

  const scopeWord = isAC ? 'area' : isVP ? 'territory' : 'region';
  const roleLabel = isAC ? 'Area Coach' : isVP ? 'VP of Operations' : 'Region Coach';
  const childWord = isAC ? 'store' : isVP ? 'region' : 'area';

  let ledeSection = '';
  if (scorecard) {
    const own  = scorecard.own;
    const best  = [...scorecard.rows].filter(r => r.growth_pct != null).pop();
    const worst = [...scorecard.rows].find(r => r.growth_pct != null);

    const ledePrompt = `You are writing the opening read of a morning brief for ${userName} (${roleLabel}) at Ayvaz Pizza LLC, a Pizza Hut franchisee.

${scopeWord.toUpperCase()} YESTERDAY (${date}):
  Sales ${fmtDollar(own.sales)} at ${own.growth_pct == null ? 'no LY data' : own.growth_pct.toFixed(1) + '% vs LY'}
  IST ${own.ist == null ? 'no data' : own.ist.toFixed(1) + ' min'}
  Labor hours ${own.hrs_variance == null ? 'no data' : (own.hrs_variance >= 0 ? '+' : '') + own.hrs_variance.toFixed(1) + ' vs scheduled'}
  WIN PTD ${own.win == null ? 'no data' : own.win.toFixed(1) + '%'}
  Missed routines ${own.missed_routines}
${best  ? `  Best ${childWord}: ${best.label} at ${best.growth_pct.toFixed(1)}%
`  : ''}${worst ? `  Worst ${childWord}: ${worst.label} at ${worst.growth_pct.toFixed(1)}%
` : ''}
Write exactly two sentences giving the overall read. Name the single thing most worth acting on today.
Do not restate every number — the full table follows yours. Plain text only, no markdown, no asterisks, no heading.`;

    try {
      const resp = await client.messages.create({
        model: MODEL, max_tokens: 200,
        messages: [{ role: 'user', content: ledePrompt }]
      });
      ledeSection = resp.content[0].text.trim();
    } catch (_) {
      ledeSection = '';   // the scorecard below carries the facts on its own
    }
  }

  // ── Section 3: Attack List (deterministic) ────────────────────────
  const alerts = operationalAlerts || {};
  const byCoach = {};
  const addAlert = (ac, type, item) => {
    if (!byCoach[ac]) byCoach[ac] = { labor:[], clockOut:[], hutbot:[], otd:[], changeDown:[], cancelTender:[] };
    byCoach[ac][type].push(item);
  };
  for (const r of alerts.labor        || []) addAlert(r.area_coach||'Unknown','labor',r);
  for (const r of alerts.clockOut     || []) addAlert(r.area_coach||'Unknown','clockOut',r);
  for (const r of alerts.hutbot       || []) addAlert(r.area_coach||'Unknown','hutbot',r);
  for (const r of alerts.otd          || []) addAlert(r.area_coach||'Unknown','otd',r);
  for (const r of alerts.changeDown   || []) addAlert(r.area_coach||'Unknown','changeDown',r);
  for (const r of alerts.cancelTender || []) addAlert(r.area_coach||'Unknown','cancelTender',r);

  const totalAlerts = (alerts.labor||[]).length + (alerts.clockOut||[]).length +
    (alerts.hutbot||[]).length + (alerts.otd||[]).length + (alerts.changeDown||[]).length +
    (alerts.cancelTender||[]).length;

  const attackLines = [];
  attackLines.push(`ATTACK LIST — ${totalAlerts > 0
    ? totalAlerts + ' item' + (totalAlerts !== 1 ? 's' : '') + ' need your attention'
    : 'No operational alerts today ✓'}`);

  for (const [ac, items] of Object.entries(byCoach).sort(([a],[b])=>a.localeCompare(b))) {
    attackLines.push(`\n[${ac}]`);
    for (const r of items.labor) {
      const days = r.consecutive_days_out > 1 ? ` · Day ${r.consecutive_days_out}` : '';
      attackLines.push(`  • ${r.store_name||r.store_id} — Labor $${Math.round(r.value||0)} over budget${days}`);
    }
    for (const r of items.clockOut) {
      const det = r.details || {};
      const emps = det.employees?.map(e=>e.name||e.cashier_name||'Unknown').join(', ')
        || `${Math.round(r.value||0)} employee(s)`;
      attackLines.push(`  • ${r.store_name||r.store_id} — Forgot to clock out: ${emps}`);
    }
    for (const r of items.hutbot) {
      const days = r.consecutive_days_out > 1 ? ` · Day ${r.consecutive_days_out}` : '';
      const status = r.metric_type === 'ROUTINE_MISSED' ? 'MISSED' : 'LATE';
      attackLines.push(`  • HutBot — ${r.store_name||r.store_id} — ${status}${days}`);
    }
    for (const r of items.otd) {
      const days = r.consecutive_days_out > 1 ? ` · Day ${r.consecutive_days_out}` : '';
      attackLines.push(`  • ${r.store_name||r.store_id} — OTD/IST ${Math.round(r.value||0)} min${days}`);
    }
    for (const r of items.changeDown) {
      const det = r.details || {};
      const tickets = det.tickets || [];
      if (tickets.length) {
        for (const t of tickets.slice(0, 5)) {
          const rawType = t.cancel_type || t.discount_type || t.payment_type || '';
          const typeLabel = rawType && !/^(cash|credit|visa|mc|mastercard|amex|discover|debit|card|check)$/i.test(rawType)
            ? rawType
            : (r.metric_type === 'CHANGE_DOWN_CASH' ? 'cash' : 'non-cash');
          attackLines.push(`  • ${r.store_name||r.store_id} — Ticket #${t.ticket_id || '?'}: $${Number(t.amount||0).toFixed(2)} — ${typeLabel}`);
        }
      } else {
        const typeLabel = r.metric_type === 'CHANGE_DOWN_CASH' ? 'cash change-down' : 'large change-down';
        attackLines.push(`  • ${r.store_name||r.store_id} — ${typeLabel} $${Math.round(r.value||0)}`);
      }
    }
    for (const r of items.cancelTender) {
      const det = r.details || {};
      const bigTickets = det.tickets || [];
      for (const t of bigTickets.slice(0, 5)) {
        const type = t.cancel_type || 'Cancel After Tender';
        const who  = t.cashier_name || t.cashier_id || '?';
        attackLines.push(`  • ${r.store_name||r.store_id} — Ticket #${t.ticket_id||'?'}: $${Number(t.amount||0).toFixed(2)} — ${type} (${who})`);
      }
    }
  }
  const attackSection = attackLines.join('\n');

  // ── Section 4: SMG Customer Pulse (deterministic) ─────────────────
  const SMG_FILTER = /rude|attitude|employee|staff|poor service|quality|product|missing|wrong item|didn't receive|order accuracy|food quality|cold|raw/i;
  const smgAlerts = alerts.smg || [];
  const relevant = smgAlerts.filter(c =>
    SMG_FILTER.test((c.categories||[]).join(' ')) || SMG_FILTER.test(c.comment_text||c.summary||'')
  );

  const nameCounts = {};
  for (const c of relevant) {
    if (c.name_mentioned) {
      const n = c.name_mentioned.trim().toLowerCase();
      nameCounts[n] = (nameCounts[n]||0) + 1;
    }
  }
  const trendNames = Object.entries(nameCounts).filter(([,cnt])=>cnt>=2).map(([n])=>n);

  const smgLines = [];
  if (relevant.length) {
    smgLines.push(`SMG CUSTOMER PULSE — ${relevant.length} alert${relevant.length!==1?'s':''}`);
    if (trendNames.length) smgLines.push(`  ⚠ Trending: "${trendNames.join('", "')}" mentioned across multiple stores`);
    for (const c of relevant.slice(0, 10)) {
      const acTag = !isAC && c.area_coach ? ` (${c.area_coach})` : '';
      const cats  = (c.categories||[]).slice(0,2).join(', ');
      const excerpt = (c.comment_text||c.summary||'').replace(/"/g,"'").slice(0,100);
      const nameTag = c.name_mentioned ? ` · Employee: ${c.name_mentioned}` : '';
      smgLines.push(`  • ${c.store_name||c.store_id}${acTag}${nameTag} — ${cats?cats+': ':''}"${excerpt}"`);
    }
  }
  const smgSection = smgLines.join('\n');

  return [header, ledeSection, scorecardSection, attackSection, smgSection].filter(Boolean).join('\n\n');
}

module.exports = { analyzePL, analyzePLForAC, analyzeRecap, analyzeDaily, analyzeTrends, generateRecapEmail, generateDailyIntelEmail, analyzeAdditionalContent, generateMorningBrief, extractTextFromFile };