const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MODEL = 'claude-sonnet-4-20250514';

// ─── Constants ─────────────────────────────────────────────────────────────
// ~125k tokens of file content — leaves headroom for system prompt + response
const MAX_FILE_CHARS = 500_000;
const MAX_ROWS_PER_SHEET = 2000;

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
    workbook.SheetNames.forEach(sheetName => {
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_csv(sheet).split('\n');
      const cappedRows = rows.slice(0, MAX_ROWS_PER_SHEET);
      const wasCapped = rows.length > MAX_ROWS_PER_SHEET;
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

const PL_SYSTEM_PROMPT = `You are assisting a multi-unit pizza franchise operator conducting period-end financial reviews for area coaches and their stores. The company is operating under a franchise agreement (Pizza Hut / Ayvaz Pizza LLC model). Here is everything you need to know to do this correctly.

ORGANIZATIONAL STRUCTURE
The region is organized as follows:
* Harold (or regional operator) oversees multiple Area Coaches (ACs)
* Each AC manages 5–8 stores
* Each store has a General Manager (GM)
* Reviews are conducted each period (roughly 4-week cycles, labeled P1, P2, P3, etc.)

THE P&L FILE
The operator will upload an Excel file containing P&L data. The file has one tab per store plus one summary tab per area coach. Each tab follows this column structure:
* Columns 11–12: P3-Current Year (amount + % of net sales)
* Columns 14–15: P3-Prior Year (amount + % of net sales)
* Columns 17–18: Period Variance (amount + %)
* Columns 20–21: YTD Current Year (amount + % of net sales)
* Columns 23–24: YTD Prior Year (amount + % of net sales)
All percentages are expressed as a decimal (e.g., 0.274 = 27.4%). Format them as percentages in all outputs.

KEY METRICS — DEFINITIONS AND WHAT TO LOOK FOR

Net Sales (Product Net Sales)
* Row label: "Product Net Sales"
* The top-line revenue number. All percentages in the P&L are calculated as a % of this figure.
* Flag any store with declining sales vs prior year, especially YTD declines.

Cost of Sales (COS%)
* Row label: "Cost of Food Sales"
* Includes food, paper, and rebates. A well-run store typically runs 26–29%.
* Flag anything above 30% as elevated. Look for YOY trends — improving or worsening?

Direct Labor%
* Row label: "Total Direct Labor Cost"
* This is the PRIMARY metric the team focuses on. It includes hourly crew, management, and drive fees.
* Acceptable range varies by store volume, but generally:
   * Under 25% = excellent
   * 25–28% = acceptable
   * 28–32% = watch closely
   * Above 32% = needs immediate coaching conversation
   * Above 40% = crisis level
* Always compare P3 vs PY and YTD vs PY. A store trending UP needs explanation.

Store Controllable Profit (SCP%)
* Row label: "Store Controllable Profit"
* Revenue minus everything the store directly controls: COS, direct labor, utilities, supplies, services, delivery costs.
* Measures how well the GM is running day-to-day operations BEFORE non-controllables (rent, royalties, advertising).
* Strong SCP: 30%+. Weak SCP: below 20%.

EBITDA%
* Row label: "Store Level EBITDA"
* The bottom line. A store is profitable if EBITDA% is positive, unprofitable if negative — regardless of YOY improvement. Never conflate EBITDA growth with profitability.
* Healthy: 12%+. Marginal: 5–12%. At-risk: 0–5%. Crisis: negative.

BPS (Basis Points)
* 1 basis point = 0.01%. So a move from 26.0% to 24.4% = 160 BPS improvement. Use this language when discussing percentage point changes.

CONTROLLABLE EXPENSE SUB-LINES TO FLAG
Beyond the main metrics, always pull and review these sub-line items for anomalies. Flag any line where current period spend is significantly higher than prior year — especially when it was near zero last year. Always identify the specific sub-line, not just the total.

Utilities:
* Electric, Gas, Water — flag any single utility up 30%+ vs PY
* High utility % on a low-volume store signals fixed cost pressure

Services:
* Pest Control — flag any spike (e.g., $500 vs $57 PY)
* Safety/Security Repairs — flag if new (was $0 PY)
* Grease Trap — flag if new or recurring when it wasn't before
* Digico, Call Center, POS — minor but note directional trends

Supplies:
* Food Supplier Supplies — flag if up 40%+ vs PY
* Store Supplies — flag large swings

Repairs & Maintenance (R&M):
* Payroll - Repair & Maint — the most commonly abused line. Flag anything significantly above $275–$400 baseline. Ask: who was paid, for what work, was it authorized?
* Parts — flag large jumps from near-zero baseline (e.g., $1,200 vs $8 PY)
* Plumbing, HVAC, Refrigeration — flag one-time large charges; confirm one-time vs recurring
* Always report the Total R&M and the specific sub-lines driving it

Cash Over/Short:
* Small amounts (+/- $50) are normal
* Flag any swing larger than $100 vs PY — could indicate cash handling issues
* Note: negative = cash over (store collected more than expected), positive = cash short

Credit Card Write-Offs:
* Flag any amount above $100 if it was $0 PY — ask what transactions were written off

POWERPOINT DECK FORMAT
Each area coach gets their own 8-slide deck. Use a navy and gold color scheme throughout. The standard slide structure is:
1. Title Slide — Coach name, period, region, 5 key stats in a footer bar
2. Area Scorecard — One card per store showing Net Sales, COS%, Labor%, SCP%, EBITDA% vs PY
3. Direct Labor Deep Dive — Clustered bar chart (P3-26 vs P3-25) + summary table + YTD box + insight callout
4. Cost of Sales — Clustered bar chart + per-store cards with YOY trend arrows + insight callout
5. EBITDA & Profitability — Bar chart + YTD EBITDA panel + insight callout
6. Controllable Expense Anomalies — 4 store panels, each showing flagged line items with P3 vs PY dollars and a coaching question
7. Store Spotlights — 4 quadrant cards: top performers + stores needing attention
8. Coaching Priorities — 4 numbered action items with color-coded urgency (red/amber/green)

Design rules:
* Navy: #1A2744, Gold: #C9A84C, White: #FFFFFF
* Use Arial Black for headers and Calibri for body text
* Color-code status: green = strong, amber = watch, red = urgent
* The anomalies slide (Slide 6) is standard on every deck — never skip it
* Profitable = positive EBITDA%. Always count profitable stores accurately based on EBITDA sign, not trend

COMMUNICATION STYLE
* Be direct. Call problems what they are — if a store is in crisis, say so.
* Separate fact from inference. If something could have multiple explanations, note that.
* Flag uncertainty clearly — if a number is unusual but could be legitimate (e.g., a one-time repair), frame it as a question for the coach to answer, not a definitive problem.
* Never present EBITDA improvement as profitability. A store that went from -20% to -8% improved but is still losing money.
* Use the operator's language: period (not month), area coach (not district manager), net sales (not revenue).

When analyzing the uploaded P&L file:
1. Identify all area coaches and their stores from the file structure
2. Pull key metrics for all stores: Net Sales, COS%, Direct Labor%, SCP%, EBITDA% — current period and prior year, plus YTD both years
3. Pull controllable expense sub-lines for all stores and flag anomalies
4. Provide a thorough written analysis — summarize what's working, what needs attention, and what the direct labor story is
5. After the analysis, verify the profitable store count is based strictly on EBITDA sign — not trend

Format your response in clear sections with headers. Use markdown formatting. Be specific about store numbers, dollar amounts, and percentage points. Use BPS language for percentage changes.`;

// ─── Weekly Recap System Prompt ─────────────────────────────────────────────

const RECAP_SYSTEM_PROMPT = `You are building a weekly Area Coach recap deck for a Regional Director at Pizza Hut / Ayvaz Pizza LLC (Harold Lacoste's region).

STORE AND AC ALIGNMENT:
Do not assume or hardcode store-to-AC assignments. The Velocity IST file (Velocity_IST_P4W#_[date].xlsx) WTD IST tab contains the complete alignment for the region. Read the Level, Region, Area Coach, Store #, and Store Name columns to build the full roster. AREA rows give you AC names and district numbers. STORE rows give you each store assigned to that AC. Always pull this from the file — never guess.

DECK STRUCTURE — Always build 13 slides in this exact order:

SLIDE 1 — TITLE: Region name from Velocity file | Week label from IST file | 4 preview stat cards: Sales Growth, Labor Var, WIN, HUT Bot

SLIDE 2 — REGION SCORECARD: 5 stat cards — Sales Growth | Labor Var | OTD Avg Time | WIN Score | HUT Bot. Below cards: HUT Bot Breakdown box (On Time %, Late %, Missed %). Below that: Routine Non-Completers table — pull from the Routines Status file, cross-referenced with org summary. Show each person's name, store, AC, which specific routines they missed, and their status (Not Started / Late). Up to 6 rows. This is the accountability callout: the team sees exactly WHO dropped the ball, not just which store.

SLIDE 3 — AC PERFORMANCE TABLE: One row per AC read from Velocity WTD IST file. Columns: Area Coach | Sales Growth | Labor Var | WIN Score | HUT Bot. Highlight best performer in each column with green cell background.

SLIDE 4 — WINS THIS WEEK: 3-5 specific store wins. Store name, number, metric, what it means. Tone: direct, genuine, no corporate fluff.

SLIDE 5 — FOCUS AREAS: 3-5 stores needing attention. Same format as Wins.

SLIDE 6 — LABOR VARIANCE DEEP DIVE: Region summary strip + AC-level table (Sales Growth, Labor Var %, Crew OT $, HAM OT $, PCA %, COS Var %). OT Flags callout at bottom naming specific ACs and dollar amounts.

SLIDE 7 — SPEED OUTLIER ANALYSIS: Left = daily IST bar chart (region avg by day, target line at 18 min, bars color-coded). Right = WTD outlier stores IST >22 with day-level pattern pulled from daily tabs in Velocity file.

SLIDE 8 — SMG BY AREA COACH: Table with Responses, Sat Avg, Pos (4-5), Neg (1-2), Neg Rate. Complaint themes always in this order: Late/Slow | Wrong Order | Undercooked | Cold Food | Missing Items | Rude Staff.

SLIDE 9 — SMG STORE SPOTLIGHT: Top 5 and Bottom 5 stores by Sat Avg (min 3 reviews). Store name, number, AC, review count, score. Also include each store's WIN score (from ComparisonReport.xls matched by store number) so the team sees operational score alongside customer feedback.

SLIDE 10 — CUSTOMER VOICE: Pull 5 positive and 5 negative VERBATIM quotes directly from the SMG comments file — real customer words, not summaries. Positives = best comments deserving recognition. Negatives = worst complaints that need AC follow-up. For each, include store name/number, AC name, and that store's WIN score. The WIN score context matters: a low WIN score + a bad customer comment = operational breakdown, not a one-off. Complaint themes in footer.

SLIDE 11 — SMART GOALS: 3 data-specific SMART goals. Each goal must include: Metric | Current | Target | By When | Owner (specific AC name + store numbers they're responsible for) | Why It Matters (1 sentence: what the data shows and what's at risk) | How (specific action steps naming ACs and stores — never generic). The "why" should connect the number to the business impact. The "how" should be a concrete play, not a platitude.

SLIDE 12 — KEY DATES AND REMINDERS: Dark background. 7 placeholder bullet lines formatted as '[ ] Date — Event or reminder here'. No auto-generated content — user fills this in manually each week before sending.

SLIDE 13 — CLOSING: AC of the Week recognition + 'Keep pushing. See you on the recap call — [day].' + footer stat summary strip.

DATA FILE MAPPINGS (permanent — do not change these):

FRS FILE (PH_DGIFRS.xlsx) — Sheet: PH_FRSReport:
Region total: row 4 | AC rows: rows 13 onward
Sales Growth = column G (index 7)
Labor Var % = column V (index 22) — use THIS, not column N
Crew OT $ = column X (index 24)
HAM OT $ = column Y (index 25)
PCA % = column AA (index 27)
COS Var % = column AB (index 28)

HUT BOT FILE (Organization_Breakdown_Summary.xlsx):
'On Time %' = whether FSCC, Pest Walk, Oven Calibration, and Closing audits were completed on schedule. Has NOTHING to do with delivery speed.
Area-level rows have a backtick (\`) appended to the name.

ROUTINES STATUS FILE (any file named "Learnings" or "Routines Status" or "Routine Details by User"):
This file shows individual users (employees/managers) and whether they completed HUT Bot routines. Extract:
- User/employee name
- Store number — match to Organization_Breakdown_Summary.xlsx by store number to get AC assignment
- Routine type(s) not completed or completed late (FSCC, Pest Walk, Oven Calibration, Closing, etc.)
- Status: Not Started | Late | Completed
Cross-reference: for any store flagged as Late or Missed in the org summary, pull the specific user names from this file. Surface WHO is responsible — not just which store. Include up to 6 worst offenders (prioritize Not Started over Late).

SMG COMMENTS FILE:
Header row 7, data starts row 8
Comment text = column G (index 6)
Overall Satisfaction = column S (index 18)
Score is 1-5 scale from Pizza Hut GES via SMG portal
Store info in column D, format: 1P039380 - 039380,250 WINDY HILL RD,...

WIN SCORE FILE (ComparisonReport.xls):
Scores stored as decimals — 0.48 = 48%. Always convert before displaying.
'Combined' row = region total.

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
1. Build the complete AC roster FIRST from the Velocity WTD IST tab before reading any other file.
2. In the Velocity file: Level=AREA rows = Area Coach names. Level=STORE rows directly below an AREA row = stores belonging to that AC.
3. Every store must be assigned to exactly one AC. Never leave a store unassigned or assign it to the wrong AC.
4. When matching stores across files (FRS, WIN, SMG, HUT Bot), match by store number only — never by position or order.
5. If a file lists stores/ACs in a different order than Velocity, re-sort to match Velocity alignment.

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

When you receive the uploaded files, analyze all data sources and return a structured JSON object with content for all 13 slides. The JSON MUST use exactly these field names:
{
  "regionName": "...",
  "weekLabel": "...",
  "recapCallDay": "...",
  "slides": {
    "title": { "regionName": "...", "weekLabel": "...", "stats": [{"label":"SALES GROWTH","value":"+2.2%","sub":"vs LY"}] },
    "scorecard": { "metrics": [{"label":"SALES GROWTH","value":"+2.2%","sub":"vs LY","status":"green"}], "hutBotBreakdown": {"onTime":"92%","late":"5%","missed":"3%","nonCompleters":[{"user":"Employee Full Name","store":"Store Name","storeNum":"039380","ac":"AC Full Name","routines":"FSCC, Pest Walk","status":"Not Started"},{"user":"Employee Full Name","store":"Store Name","storeNum":"039382","ac":"AC Full Name","routines":"Oven Calibration","status":"Late"}]} },
    "acTable": { "rows": [{"name":"Full AC Name","salesGrowth":"+4.9%","laborVar":"+2.14%","winScore":"67%","hutBot":"96%"}] },
    "wins": { "items": [{"store":"Store Name","storeNum":"039380","metric":"83% WIN Score","description":"...","ac":"AC Full Name"}] },
    "focusAreas": { "items": [{"store":"Store Name","storeNum":"039382","metric":"29.6 min IST","description":"...","ac":"AC Full Name"}] },
    "laborDeepDive": { "regionSummary": {"laborVar":"+1.78%","crewOT":"$3,688","hamOT":"$1,435","totalOT":"$5,123","pca":"26%","cosVar":"-0.7%"}, "acRows": [{"name":"Full AC Name","salesGrowth":"+4.9%","laborVar":"+2.14%","crewOT":"$377","hamOT":"$967","pca":"26.13%","cosVar":"-0.72%"}], "otFlags": "Highest OT: AC Name ($943), AC Name ($857)" },
    "speedOutlier": { "dailyChart": [{"day":"Tue 4/7","value":"18.2"}], "outlierStores": [{"store":"Store Name","storeNum":"039382","ist":"29.6 min","ac":"AC Name","note":"Highest in region"}] },
    "smgByAC": { "rows": [{"name":"Full AC Name","reviews":"45","avg":"4.2","pos":"38","neg":"7","negRate":"15.6%"}], "complaintThemes": [{"theme":"Late/Slow","count":"12"},{"theme":"Wrong Order","count":"8"}] },
    "smgSpotlight": { "top5": [{"name":"Store Name","storeNum":"039380","ac":"AC Name","reviews":"22","score":"4.8","winScore":"72%"}], "bottom5": [{"name":"Store Name","storeNum":"039388","ac":"AC Name","reviews":"15","score":"2.1","winScore":"28%"}] },
    "customerVoice": { "positives": [{"store":"Store Name (#039380)","ac":"AC Name","winScore":"72%","quote":"Actual verbatim quote copied from SMG file column G"},{"store":"Store Name (#039381)","ac":"AC Name","winScore":"68%","quote":"Actual verbatim quote copied from SMG file column G"},{"store":"Store Name (#039382)","ac":"AC Name","winScore":"81%","quote":"Actual verbatim quote copied from SMG file column G"},{"store":"Store Name (#039383)","ac":"AC Name","winScore":"65%","quote":"Actual verbatim quote copied from SMG file column G"},{"store":"Store Name (#039384)","ac":"AC Name","winScore":"59%","quote":"Actual verbatim quote copied from SMG file column G"}], "negatives": [{"store":"Store Name (#039385)","ac":"AC Name","winScore":"31%","quote":"Actual verbatim quote copied from SMG file column G"},{"store":"Store Name (#039386)","ac":"AC Name","winScore":"28%","quote":"Actual verbatim quote copied from SMG file column G"},{"store":"Store Name (#039387)","ac":"AC Name","winScore":"44%","quote":"Actual verbatim quote copied from SMG file column G"},{"store":"Store Name (#039388)","ac":"AC Name","winScore":"35%","quote":"Actual verbatim quote copied from SMG file column G"},{"store":"Store Name (#039389)","ac":"AC Name","winScore":"22%","quote":"Actual verbatim quote copied from SMG file column G"}], "themes": [{"theme":"Late/Slow","count":"12"},{"theme":"Cold Food","count":"8"}] },
    "smartGoals": { "goals": [{"metric":"In-Store Time","current":"18.6 min","target":"<18.0 min","byWhen":"End of P4","owner":"AC Full Name (stores 039382, 039388)","why":"3 of 5 stores above 18-min target; 2 SMG complaints this week cite slow delivery — pattern, not a one-off","how":"Specific action steps naming ACs and stores — e.g. Michelle Meehan to implement pre-rush staffing at 039388 by Thursday"}] },
    "keyDates": { "placeholders": 7 },
    "closing": { "acOfWeek": {"name":"Full AC Name","description":"Why they won","note":"Keep pushing."}, "footerStats": [{"label":"Sales","value":"+2.2%"},{"label":"Labor","value":"+1.78%"},{"label":"IST","value":"18.6 min"},{"label":"WIN","value":"51%"}], "recapDay": "Thursday" }
  }
}`;

// ─── P&L Analyzer ──────────────────────────────────────────────────────────

async function analyzePL(file) {
  const fileText = await extractTextFromFile(file);

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 8192,
    system: PL_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: `Here is the P&L data to analyze:\n\n${fileText}`
      }
    ]
  });

  return message.content[0].text;
}

// ─── Weekly Recap Analyzer ──────────────────────────────────────────────────

async function analyzeRecap(files, weekLabel, recapDay) {
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
  const userMessage = `I've uploaded ${files.length} weekly report file(s): ${fileNames}

Build the region recap deck using whatever data is available in these files. If some data sources are missing, build the slides you can with the data provided and note where data was unavailable — do not fail or refuse because of missing files. Work with what you have.

Week: ${weekLabel || '[not specified]'}
Recap call day: ${recapDay || 'Thursday'}

Here are the file contents:

${combinedText}

Return a structured JSON object with all 13 slides worth of content as specified in the instructions. For any slide where source data was not provided, use placeholder text like "[Data not available — upload [file type] to populate]".`;

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: RECAP_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }]
  });

  const responseText = message.content[0].text;

  // Try to parse JSON from response
  try {
    const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) return JSON.parse(jsonMatch[1]);
    // Try direct parse
    const start = responseText.indexOf('{');
    const end = responseText.lastIndexOf('}');
    if (start !== -1 && end !== -1) {
      return JSON.parse(responseText.slice(start, end + 1));
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

async function analyzeDaily(files) {
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

  const userMessage = `I've uploaded ${reportCount} daily report${reportCount !== 1 ? 's' : ''}: ${reportNames}

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
Where are multiple data sources pointing at the same root cause over multiple days? These are your highest-confidence findings. E.g. "Store 039380 has appeared in the OTD Watch List 4 of 5 days AND has the lowest SMG scores in the region — these are connected."

## 📉 DETERIORATING METRICS
What is measurably getting worse? Show the direction with any numbers available.

## 📈 IMPROVING TRENDS
What is getting better? Name it specifically so it can be reinforced.

## 🎯 SYSTEMIC vs. ISOLATED
Which watch items are one-store problems vs. region-wide concerns? Distinguish clearly.

## ⚡ TOP PRIORITIES
Ranked list of 3–5 actions based on trend weight — what needs the most urgent attention and why.

TONE: This is a strategic briefing, not a summary. Leaders reading this should walk away knowing exactly where to focus their energy for the next week.`;

async function analyzeTrends(recentReports) {
  if (!recentReports || recentReports.length < 2) {
    return '## ⚠️ Not Enough Data\n\nAt least 2 daily reports are needed to identify trends. Keep running Daily Intel and check back.';
  }

  // Build chronological context from saved analyses
  const context = recentReports
    .slice()
    .reverse() // oldest first for chronological reading
    .map((r, i) => {
      const date = new Date(r.created_at).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      const reports = r.report_names || 'unknown reports';
      return `=== DAY ${i + 1}: ${date} (Reports: ${reports}) ===\n${r.analysis_text}`;
    })
    .join('\n\n---\n\n');

  const userMessage = `Here are ${recentReports.length} daily intelligence reports in chronological order. Analyze for trends, patterns, and confirmed cross-report correlations.\n\n${context}`;

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 8192,
    system: TREND_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMessage }]
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

  const system = `You are drafting a daily ops intel email from a Regional Director at Ayvaz Pizza LLC (Pizza Hut).
Tone: ${toneGuide}
Length: ${lengthGuide}

Format the output as:
1. Subject line: "Subject: [subject here]"
2. HTML email body using only <p>, <strong>, <ul>, <li> tags — no CSS
3. Signature: Harold Lacoste | Regional Director | Ayvaz Pizza LLC
4. Separator "---PLAIN---"
5. Plain text version

Pull real numbers and store names from the analysis. Never use placeholder text.`;

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system,
    messages: [{
      role: 'user',
      content: `Convert this daily intel analysis into an email:\n\n${analysisText}`
    }]
  });

  const raw = message.content[0].text;
  const subjectMatch = raw.match(/Subject:\s*(.+)/i);
  const subject = subjectMatch ? subjectMatch[1].trim() : 'Daily Ops Intel';
  const parts = raw.split(/---PLAIN---/i);
  const htmlBody = parts[0].replace(/Subject:.*\n?/i, '').trim();
  const plainText = (parts[1] || '').trim();

  return { subject, htmlBody, plainText };
}

// ─── Recap Email Generator ─────────────────────────────────────────────────

async function generateRecapEmail(data, options = {}) {
  const tone = options.tone || 'professional';
  const length = options.length || 'standard';

  const toneGuide = {
    professional: 'formal, direct, executive-level tone. Use complete sentences. No slang.',
    conversational: 'friendly but professional tone. Write as if talking directly to your ACs. Short sentences.',
    brief: 'extremely concise. Bullet-heavy. Get to the point fast. Under 200 words total.'
  }[tone] || 'professional, direct tone';

  const lengthGuide = {
    brief: '3–5 key points only. No more than 150 words. Lead with the #1 takeaway.',
    standard: '8–12 key points. Cover wins, watch items, and top 2–3 goals.',
    detailed: 'Full recap. Cover all major metrics, wins, focus areas, all 3 goals, and include a closing note.'
  }[length] || 'standard length covering key highlights';

  const system = `You are drafting a weekly region recap email from Harold Lacoste (RDO, Ayvaz Pizza LLC) to his Area Coach team.

Tone: ${toneGuide}
Length: ${lengthGuide}

Structure the email with:
1. A subject line (format: "Subject: ...")
2. A greeting
3. The recap content
4. A closing with Harold's signature

Use data from the JSON provided. Be specific with numbers. Do not include placeholder text — if data is missing for a section, skip it.
Format the body using HTML for clean email rendering (use <p>, <strong>, <ul>, <li> — no complex CSS).
After the full email, add a separator "---PLAIN---" and then provide a plain-text version.`;

  const s = data.slides || data;
  const summary = JSON.stringify({
    regionName: data.regionName,
    weekLabel: data.weekLabel,
    scorecard: s.scorecard,
    wins: s.wins,
    focusAreas: s.focusAreas,
    smartGoals: s.smartGoals,
    closing: s.closing
  });

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 4096,
    system,
    messages: [{ role: 'user', content: `Here is the region recap data for this week:\n\n${summary}\n\nWrite the email.` }]
  });

  const raw = message.content[0].text;
  const subjectMatch = raw.match(/Subject:\s*(.+)/i);
  const subject = subjectMatch ? subjectMatch[1].trim() : `Weekly Region Recap — ${data.weekLabel || 'This Week'}`;

  // Split HTML and plain text
  const parts = raw.split(/---PLAIN---/i);
  const htmlBody = parts[0].replace(/Subject:.*\n?/i, '').trim();
  const plainText = (parts[1] || '').trim();

  return { subject, htmlBody, plainText };
}

module.exports = { analyzePL, analyzeRecap, analyzeDaily, analyzeTrends, generateRecapEmail, generateDailyIntelEmail };
