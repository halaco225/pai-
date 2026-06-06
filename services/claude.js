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

const PL_SYSTEM_PROMPT = `You are an elite financial analyst for Ayvaz Pizza LLC, a Pizza Hut multi-unit franchisee. You analyze period-end P&L Excel files and produce structured JSON for an 8-slide executive deck reviewed by the Regional Director and VPs.

FILE STRUCTURE
The Excel file follows this pattern:
• Sheet named after the Regional Director (e.g. "Harold Lacoste") = region summary sheet
• Sheets named after Area Coaches (e.g. "Ebony Simmons") = district rollups — use these as the authoritative source for AC-level metrics, NOT individual store tabs
• Sheets prefixed "PH" + store number = individual store P&Ls
• AC sheets appear before their store sheets — stores are mapped to the AC sheet that immediately precedes them in tab order

COLUMN MAPPING — DYNAMIC (do not hardcode column numbers)
Row 3 contains period headers. Find columns by matching header text:
• Current period dollar column: find header matching the current period label (e.g. "P04-26")
• Current period % column: immediately after the dollar column
• Prior year dollar column: find header matching prior year label (e.g. "P04-25")
• Prior year % column: immediately after the prior year dollar column
• Period Variance dollar column: find header matching "Variance" or similar
• Period Variance % column: immediately after variance dollar column
All percentages are decimals in the file (e.g. 0.274 = 27.4%). Convert to percentage strings in output.

METRICS TO EXTRACT
From every AC sheet and the region summary sheet, pull these exact line items by matching the string in column A (row label):
• Product Net Sales
• Store Level EBITDA
• Total Direct Labor Cost (ALWAYS use this — never "Total Labor Cost")
• Cost of Food Sales
• Total Utilities
• Utilities - Electric Expense
• Utilities - Gas Expense
• Total Services
• Digico Expense
• Total Supplies
• Supplies - Food Supplier Expense
• Repairs and Maintenance (the total line)
• Repair & Maintenance Expense - Parts
• Repairs Expense - Hood Cleaning
• Insurance- General Expense
• Total Credit Card and Bank Fees
• Total Cash Over / (Short)
• Total Advertising
• Advertising Expense - Others
• Total Occupancy Expense
• Total Non-Controllable Expenses
• Store Controllable Profit

EBITDA PROFITABILITY RULE: A store or district is profitable if and only if Store Level EBITDA dollar value is positive. NEVER use YOY improvement to determine profitability. A store that improved from -20% to -8% is still losing money.

CALCULATIONS
• BPS = (current % − prior year %) × 10,000
• EBITDA variance = current $ − prior year $
• Direct Labor % = Total Direct Labor Cost $ ÷ Product Net Sales $ (compute if % column is missing or unreliable)
• Profitable store count = count of stores where Store Level EBITDA $ > 0 (count carefully — this number appears on the cover)

ANOMALY DETECTION — always flag these automatically:
• Hood Cleaning = $0 when PY > $5,000 → severity: Critical
• Insurance-General increase > $10,000 vs PY → severity: Critical, validate with finance
• COGS % increase > 80 bps while Net Sales declining → severity: High
• Advertising-Other increase > $8,000 → severity: High, investigate across all area coaches
• Any AC with Total Direct Labor Cost % > 35% → severity: High
• Any store with Total Direct Labor Cost % > 45% → severity: Critical
• R&M Parts > 1.0% of net sales at any AC → severity: Watch

NARRATIVE STANDARDS — always follow these language rules:
• Say "period" not "month"
• Say "area coach" not "district manager"
• Say "Total Direct Labor Cost" not "labor" when referencing that specific metric
• Use "bps" for basis points throughout
• When describing a store collapse: state prior period EBITDA → current EBITDA → bps swing
• When flagging a labor issue: always state the Total Direct Labor Cost % AND the net sales volume together — 40% labor means something different at $100K sales vs $30K sales
• EBITDA profitability = positive EBITDA $, never determined by YOY trend alone

OUTPUT FORMAT — CRITICAL
Return a single JSON object in a \`\`\`json code block. No markdown outside the block. No preamble. Use this exact structure:

{
  "period": "P04-26",
  "region": {
    "name": "Harold Lacoste Region",
    "company": "Ayvaz Pizza LLC",
    "director": "Harold Lacoste"
  },
  "areaCoaches": ["Daria Spikes", "Ebony Simmons", "Jorge Martinez", "Ja'Don Williams", "Michelle Meehan", "Kesha Thomas"],
  "slide2": {
    "metrics": [
      {"label": "Region EBITDA $", "value": "$277,830", "vsPY": "+$87,575 vs prior period", "trend": "up"},
      {"label": "EBITDA %", "value": "10.9%", "vsPY": "+344 bps vs prior period", "trend": "up"},
      {"label": "Total Direct Labor %", "value": "28.4%", "vsPY": "-120 bps vs prior period", "trend": "up"},
      {"label": "Net Sales", "value": "$2.55M", "vsPY": "-$6.2K vs prior period", "trend": "down"}
    ],
    "narrative": [
      "EBITDA grew $87.6K period-over-period — a 46% increase on essentially flat net sales, driven by cost discipline not volume",
      "Margin expanded 344 bps from 7.5% to 10.9% — Total Direct Labor Cost and COGS discipline account for the full variance",
      "Total Direct Labor Cost improved 120 bps region-wide; 4 of 6 area coaches held or improved their percentage",
      "Ebony Simmons district is the critical situation — 3 of 5 stores EBITDA negative, Total Direct Labor Cost averaging 38.7% on combined $341K net sales",
      "Insurance-General spiked $14,200 vs prior period — requires finance validation before period close"
    ]
  },
  "slide3": {
    "bridge": [
      {"driver": "Sales Volume", "varianceDollars": "-$6,200", "bpsImpact": "-24", "explanation": "Flat traffic contributed a minor EBITDA headwind — this is a volume story, not a cost story", "direction": "headwind"},
      {"driver": "Cost of Food Sales", "varianceDollars": "+$18,400", "bpsImpact": "+72", "explanation": "Chicken and cheese favorable vs prior period; portioning discipline improving in Daria and Jorge districts", "direction": "tailwind"},
      {"driver": "Total Direct Labor Cost", "varianceDollars": "+$31,200", "bpsImpact": "+122", "explanation": "Primary EBITDA driver; 4 of 6 area coaches improved — Ebony district offsetting region gains with 38.7% average", "direction": "tailwind"},
      {"driver": "Insurance-General", "varianceDollars": "-$14,200", "bpsImpact": "-56", "explanation": "Spike requiring finance validation — determine if rate increase, new policy, or billing error", "direction": "headwind"},
      {"driver": "Total Utilities", "varianceDollars": "-$8,100", "bpsImpact": "-32", "explanation": "Electric trending up across 3 area coach districts — seasonal but warrants monitoring", "direction": "headwind"},
      {"driver": "Advertising-Other", "varianceDollars": "-$9,800", "bpsImpact": "-38", "explanation": "Up across all area coaches this period — pull invoices and investigate authorization", "direction": "headwind"},
      {"driver": "Total Occupancy", "varianceDollars": "-$4,200", "bpsImpact": "-16", "explanation": "Lease escalations at 2 locations — non-controllable but flagged for awareness", "direction": "headwind"},
      {"driver": "R&M incl. Hood Cleaning", "varianceDollars": "-$5,600", "bpsImpact": "-22", "explanation": "Hood cleaning $0 this period vs $6,200 prior period — CRITICAL safety and compliance issue; R&M parts accelerating in Ja'Don district", "direction": "headwind"}
    ]
  },
  "slide4": {
    "rows": [
      {"ac": "Daria Spikes", "stores": 7, "netSales": "$545K", "ebitdaDollars": "$95,114", "ebitdaPct": "17.5%", "vsPYBps": "+530", "dirLaborPct": "25.5%", "dlVsPYBps": "-140", "negStores": 0, "tier": "green"},
      {"ac": "Ebony Simmons", "stores": 5, "netSales": "$341K", "ebitdaDollars": "($8,200)", "ebitdaPct": "-2.4%", "vsPYBps": "-180", "dirLaborPct": "38.7%", "dlVsPYBps": "+420", "negStores": 3, "tier": "red"}
    ],
    "territoryTotal": {"netSales": "$2.55M", "ebitdaDollars": "$277,830", "ebitdaPct": "10.9%", "vsPYBps": "+344", "dirLaborPct": "28.4%", "dlVsPYBps": "-120", "negStores": 8}
  },
  "slide5": {
    "rows": [
      {"category": "Repairs Expense - Hood Cleaning", "regionCurrentDollars": "$0", "regionCurrentPct": "0.0%", "pyDollars": "$6,200", "pyPct": "0.24%", "varDollars": "-$6,200", "varBps": "-24", "districtFlag": "ALL DISTRICTS — $0 this period; fire safety and compliance risk; schedule immediately", "flagColor": "red"},
      {"category": "Insurance- General Expense", "regionCurrentDollars": "$28,400", "regionCurrentPct": "1.11%", "pyDollars": "$14,200", "pyPct": "0.56%", "varDollars": "+$14,200", "varBps": "+56", "districtFlag": "CRITICAL — more than doubled vs prior period; validate with finance", "flagColor": "red"},
      {"category": "Total Direct Labor Cost", "regionCurrentDollars": "$724,200", "regionCurrentPct": "28.4%", "pyDollars": "$730,600", "pyPct": "28.7%", "varDollars": "-$6,400", "varBps": "-30", "districtFlag": "Ebony 38.7% (Critical); 4 of 6 area coaches improved", "flagColor": "green"},
      {"category": "Cost of Food Sales", "regionCurrentDollars": "$664,500", "regionCurrentPct": "26.1%", "pyDollars": "$645,200", "pyPct": "25.3%", "varDollars": "+$19,300", "varBps": "+80", "districtFlag": "Ebony +120 bps, Ja'Don +95 bps — portioning observation needed", "flagColor": "red"},
      {"category": "Advertising Expense - Others", "regionCurrentDollars": "$34,200", "regionCurrentPct": "1.34%", "pyDollars": "$24,400", "pyPct": "0.96%", "varDollars": "+$9,800", "varBps": "+38", "districtFlag": "Up in all 6 area coach districts — pull invoices and verify authorization", "flagColor": "red"},
      {"category": "Utilities - Electric Expense", "regionCurrentDollars": "$52,100", "regionCurrentPct": "2.04%", "pyDollars": "$44,000", "pyPct": "1.72%", "varDollars": "+$8,100", "varBps": "+32", "districtFlag": "3 area coach districts trending up — monitor seasonally", "flagColor": "amber"},
      {"category": "Repair & Maintenance Expense - Parts", "regionCurrentDollars": "$18,400", "regionCurrentPct": "0.72%", "pyDollars": "$8,600", "pyPct": "0.34%", "varDollars": "+$9,800", "varBps": "+38", "districtFlag": "Ja'Don district driving majority — review invoices before next period", "flagColor": "amber"},
      {"category": "Total Cash Over / (Short)", "regionCurrentDollars": "$3,200", "regionCurrentPct": "0.13%", "pyDollars": "$800", "pyPct": "0.03%", "varDollars": "+$2,400", "varBps": "+9", "districtFlag": "3 stores above $100 threshold — GM cash handling review needed", "flagColor": "amber"}
    ]
  },
  "slide6": {
    "cards": [
      {"severity": "Critical", "title": "Hood Cleaning $0 — Fire Safety Risk", "analysis": "Hood cleaning was $0 this period versus $6,200 prior period across the region. Every store that skipped hood cleaning is operating in violation of franchise standards and fire code. This is not a financial issue — it is a safety and compliance emergency. The Regional Director must have written confirmation of rescheduled services from every General Manager before end of week. Any store without documentation must not open for business."},
      {"severity": "Critical", "title": "Insurance-General Spike — $14,200 vs Prior Period", "analysis": "Insurance-General more than doubled from $14,200 to $28,400 period-over-period. This requires immediate validation with finance to determine whether this is a rate increase, a new policy addition, a one-time premium charge, or a billing error. Until confirmed, model this as a recurring headwind — if it continues next period, it represents a $14,200 EBITDA drag that cannot be offset by operational improvement alone."},
      {"severity": "High", "title": "Ebony Simmons — District Total Direct Labor Cost Crisis", "analysis": "Ebony's district is averaging 38.7% Total Direct Labor Cost on combined net sales of $341K — 1,030 bps above the region average of 28.4%. Three of five stores are EBITDA negative, and Total Direct Labor Cost is the primary driver in all three cases. At the current sales volume, 38.7% labor means the cost structure is fundamentally misaligned with revenue. This requires a scheduling audit and GM accountability conversation this week — not next period."},
      {"severity": "High", "title": "Advertising-Other Up Across All Districts", "analysis": "Advertising Expense - Others increased $9,800 versus prior period, and the variance is present in all six area coach districts — not isolated to one location. A region-wide increase across all area coaches in a single period indicates either a coordinated, unauthorized spend increase or a vendor change that rolled without approval. Pull the invoices for every district, identify who authorized the charges, and determine whether this spend will continue next period."},
      {"severity": "High", "title": "COGS Rising in 2 Districts on Flat Sales", "analysis": "Ebony Simmons and Ja'Don Williams districts show Cost of Food Sales up 120 and 95 bps respectively while net sales are flat to declining. Rising COGS on flat volume is a portioning and waste issue, not a commodity price issue. Schedule a full portioning observation at each district's highest-COGS store before next period closes. Review waste logs if available. A 100 bps COGS improvement across just these two districts would return approximately $4,300 to the bottom line."},
      {"severity": "Watch", "title": "R&M Parts Acceleration — Ja'Don District", "analysis": "Repair & Maintenance Expense - Parts increased $9,800 versus prior period, with Ja'Don's district driving the majority. Parts spend at 0.72% of net sales is approaching the 1.0% flag threshold. Pull invoices and determine whether this reflects equipment deterioration requiring capital planning or one-time emergency repairs. If any single store is consistently above $1,500 in parts spending, a preventive service contract review is warranted before costs compound further."}
    ]
  },
  "slide7": {
    "cards": [
      {"acName": "Daria Spikes", "ebitdaPct": "17.5%", "bpsVsPY": "+530", "tier": "green", "win": "Wells Street (#38876) at 25.2% EBITDA — regional benchmark this period; Total Direct Labor Cost improved 240 bps vs prior period on $71K net sales", "flag": "Store C (#39381): Total Direct Labor Cost 31.2% on $58K net sales — overstaffed relative to volume; EBITDA flipped from +3.4% prior period to negative this period"},
      {"acName": "Ebony Simmons", "ebitdaPct": "-2.4%", "bpsVsPY": "-180", "tier": "red", "win": "Store A (#39390) is the only profitable store in the district at 4.2% EBITDA — contained Total Direct Labor Cost at 29.8% on $68K net sales", "flag": "Store D (#39394): Total Direct Labor Cost 48.2% on $42K net sales — Critical; EBITDA collapsed from -3.1% to -18.4% this period, a -1,530 bps swing"}
    ]
  },
  "slide8": {
    "whatsWorking": [
      {"title": "Total Direct Labor Cost Discipline — 4 of 6 Districts", "detail": "Region improved 120 bps period-over-period. Daria Spikes district best at 25.5% Total Direct Labor Cost. Consistent scheduling and volume alignment are driving this result."},
      {"title": "COGS Improvement in 4 Districts", "detail": "Cost of Food Sales improved ~72 bps on average in improving districts. Favorable chicken and cheese costs plus portioning consistency in Daria and Jorge districts."},
      {"title": "Daria Spikes — Regional Benchmark", "detail": "17.5% EBITDA, $95K district profit, 0 negative stores. Wells Street at 25.2% is the model for the region. This period is a cross-training opportunity."},
      {"title": "EBITDA Growth on Flat Net Sales", "detail": "Region EBITDA grew $87.6K (+46%) with net sales essentially flat. This is pure margin expansion — cost discipline working exactly as designed."}
    ],
    "priorities": [
      {"number": 1, "urgency": "red", "title": "Hood Cleaning — Written Schedules by End of Week", "detail": "$0 this period vs $6,200 prior period. Written confirmation of rescheduled services from every General Manager required immediately. Fire safety and franchise compliance — no exceptions."},
      {"number": 2, "urgency": "red", "title": "Ebony Simmons — Labor Scheduling Audit This Week", "detail": "District averaging 38.7% Total Direct Labor Cost with 3 negative EBITDA stores. Scheduling audit and GM accountability conversation required this week. Store D at 48.2% Total Direct Labor Cost on $42K net sales is a Critical case."},
      {"number": 3, "urgency": "red", "title": "Insurance Spike — Finance Validation Before Next Period", "detail": "$14,200 increase vs prior period. Confirm with finance whether rate change, new policy, or billing error. If recurring, this is a $14,200 headwind next period that cannot be recovered operationally."},
      {"number": 4, "urgency": "amber", "title": "COGS Audit — Ebony and Ja'Don Districts", "detail": "COGS up 120 and 95 bps respectively on flat net sales. Schedule portioning observations before next period closes. This is a training and accountability issue — a 100 bps improvement returns $4,300 to EBITDA across these two districts."}
    ]
  }
}

RULES — fill every field with real data from the file. No placeholder text. No example values.
- areaCoaches: list all area coaches found in the file, up to 6
- slide4.rows: one row per area coach, sorted by EBITDA % descending
- slide4.rows.tier: "green" if EBITDA% ≥ 15%, "amber" if 5–14.9%, "red" if < 5% or negative
- slide5.rows: include every key expense line; always include Hood Cleaning even if $0
- slide6.cards: 4–6 cards; always lead with the most severe anomaly; use exactly the severity values "Critical", "High", or "Watch"
- slide7.cards: one card per area coach; name specific stores with store numbers and dollar amounts
- slide8.whatsWorking: exactly 4 items
- slide8.priorities: exactly 4 items; number 1 is always the most urgent operational or safety issue
- All dollar amounts as strings ("$277,830" or "($8,200)" for negatives)
- All percentages as strings ("10.9%")
- BPS as signed strings ("+344" or "-120")
- trend field: "up" = favorable for the metric, "down" = unfavorable

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

OUTPUT FORMAT — CRITICAL
You MUST return a single JSON object wrapped in a \`\`\`json code block. No markdown outside the code block. No preamble. The JSON structure is:

{
  "period": "P3 2026",
  "region": {
    "name": "Southeast Atlanta Region",
    "company": "Ayvaz Pizza LLC",
    "operator": "Harold Lacoste · Director of Operations"
  },
  "headline": {
    "ebitda": "$277,830",
    "ebitdaVsPY": "+$87,575 vs PY",
    "ebitdaMargin": "10.9%",
    "ebitdaMarginVsPY": "+344 bps vs PY (7.5%)",
    "netSales": "$2.55M",
    "netSalesVsPY": "-$6.2K vs prior year",
    "storesProfitable": "33 / 41",
    "storesNegativeNote": "8 stores EBITDA negative",
    "takeaways": [
      "EBITDA grew $87.6K year-over-year — a 46% increase on essentially flat sales",
      "Margin expanded 344 basis points from 7.5% to 10.9% — driven by COGS and labor discipline",
      "COGS improved ~60 bps region-wide; chicken and cheese costs favorable vs prior year",
      "8 stores remain EBITDA negative — labor is the primary drag across all losing locations"
    ]
  },
  "acScorecard": [
    { "name": "Daria Spikes", "stores": 7, "ebitdaDollars": "$95,114", "ebitdaPct": "17.5%", "vsPYBps": "+530", "cogsPct": "27.0%", "laborPct": "25.5%" }
  ],
  "topPerformers": [
    { "store": "Wells Street", "storeNum": "38876", "ac": "Daria", "netSales": "$71,304", "ebitdaDollars": "$17,976", "ebitdaPct": "25.2%", "bpsVsPY": "+747", "cogsPct": "27.1%", "laborPct": "21.8%" }
  ],
  "topPerformersNote": "Daria's district holds 4 of the top 7 — Wells Street at 25.2% EBITDA is the regional benchmark.",
  "losingStores": [
    { "store": "Glade Rd", "storeNum": "39382", "ac": "Ja'Don", "netSales": "$35,836", "ebitdaDollars": "($19,369)", "ebitdaPct": "-54.1%", "cogsPct": "32.0%", "laborPct": "74.4%", "primaryIssue": "CRITICAL — Labor structural failure" }
  ],
  "losingStoresNote": "Ja's district: 4 of 6 stores losing money. Glade Rd alone is a ($19.4K) hole at 74% labor — structural, not cyclical.",
  "turnarounds": {
    "gainers": [
      { "store": "Lithia Springs", "storeNum": "39389", "ac": "Jorge", "ebitdaPY": "$10,037", "ebitdaP3": "$23,685", "change": "+$13,648" }
    ],
    "declines": [
      { "store": "Glade Rd", "storeNum": "39382", "ac": "Ja'Don", "ebitdaPY": "($2,119)", "ebitdaP3": "($19,369)", "change": "-$17,250" }
    ],
    "footerNote": "Glade Rd decline is not a trend — it is an emergency. Requires immediate staffing and operational intervention."
  },
  "peterFramework": [
    { "number": "1", "title": "Start with EBITDA %", "body": "Green = above 15%. Yellow = 8–15%. Red = below 8%. Negative = actively losing money." },
    { "number": "2", "title": "Check BPS vs Prior Year", "body": "100 bps = 1%. Positive = improving. Negative = eroding. Sales growth + shrinking margin = still in trouble." },
    { "number": "3", "title": "Labor % is your first red flag", "body": "Target 28–32%. Above 35% = overstaffed or undersold. Above 40% = structural problem." },
    { "number": "4", "title": "Flow Through — did growth convert?", "body": "EBITDA change ÷ Sales change. Negative = costs outran sales. 100%+ = excellent leverage." },
    { "number": "5", "title": "COGS % — control what you can", "body": "Target 26–28%. High COGS = waste, portioning, or theft. COGS + high labor = double jeopardy." },
    { "number": "6", "title": "The pattern tells the story", "body": "One bad metric = fixable. Two = coaching conversation. Three = PIP conversation. Glade Rd has all three." }
  ],
  "acDeepDives": [
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
        "ytdLines": [
          "YTD Labor: 25.5% vs PY 26.8% (neg 130 bps)",
          "3 of 7 stores improved vs PY",
          "Store C trending up -- needs coaching"
        ],
        "insight": "Wells Street best in region at 21.8%. Store C above 31% -- overstaffed relative to $58K volume. Coaching priority."
      },
      "cosChart": {
        "labels": ["Wells St", "Store B", "Store C"],
        "current": [27.1, 28.8, 30.2],
        "prior":   [28.0, 28.5, 29.8],
        "storeCards": [
          {"name": "Wells St", "trend": "down", "p3": "27.1%", "py": "28.0%", "ytd": "27.5%", "ytdPY": "28.1%"},
          {"name": "Store B",  "trend": "up",   "p3": "28.8%", "py": "28.5%", "ytd": "28.6%", "ytdPY": "28.2%"},
          {"name": "Store C",  "trend": "up",   "p3": "30.2%", "py": "29.8%", "ytd": "29.9%", "ytdPY": "29.2%"}
        ],
        "insight": "COS improvement led by Wells Street (neg 90 bps). Store C trending up -- check portioning and waste."
      },
      "ebitdaChart": {
        "labels": ["Wells St", "Store B", "Store C"],
        "current": [25.2, 12.8, -4.1],
        "prior":   [17.5, 11.2,  3.4],
        "ytdItems": [
          {"name": "Wells St", "ytd": "22.3%", "ytdPY": "18.1%"},
          {"name": "Store B",  "ytd": "11.5%", "ytdPY": "10.8%"},
          {"name": "Store C",  "ytd": "-1.8%", "ytdPY": "2.9%"}
        ],
        "insight": "Store C flipped negative this period. Labor spike of 8.4 pts vs PY is the entire story."
      },
      "anomalies": [
        {
          "name": "Store C", "storeNum": "39381", "status": "red",
          "items": [
            {"line": "Payroll - R&M",  "p3": "$1,842", "py": "$284", "note": "Who was paid? Needs authorization check"},
            {"line": "Pest Control",   "p3": "$480",   "py": "$57",  "note": "Spike -- new vendor or recurring issue?"},
            {"line": "Cash Short",     "p3": "$214",   "py": "$18",  "note": "Cash handling concern -- review with GM"}
          ]
        }
      ],
      "spotlights": {
        "crisis":     {"name": "Store C (#39381)", "bullets": ["Labor 31.2% on $58K sales -- overstaffed", "EBITDA flipped negative (-4.1%)", "3 controllable line item spikes this period"]},
        "urgent":     {"name": "Store B (#39383)", "bullets": ["COS trending up 3 consecutive periods", "GM has not submitted COGS correction", "Review scheduling and portioning"]},
        "brightSpot": {"name": "Wells Street (#38876)", "bullets": ["25.2% EBITDA -- regional best", "Labor improved 240 bps vs PY", "Model store -- cross-train other GMs here"]},
        "structural": {"name": "Area Trend", "bullets": ["3 of 7 stores improved EBITDA vs PY", "Labor discipline is the primary driver", "Inconsistent portioning training driving COS gaps"]}
      },
      "coachingPriorities": [
        {"number": "01", "status": "red",   "title": "Store C -- Labor Crisis",        "body": "31.2% labor on $58K is structural. Schedule audit this week. GM must explain $1,842 R&M charge before end of period."},
        {"number": "02", "status": "red",   "title": "Store C -- Controllable Spikes", "body": "Three line-item spikes in one period. Pull invoices for pest control and R&M. Cash short ($214) needs GM investigation."},
        {"number": "03", "status": "amber", "title": "Store B -- COS Trend",           "body": "3-period upward COS trend. Schedule a full portioning observation visit before next period closes."},
        {"number": "04", "status": "green", "title": "Replicate Wells Street",          "body": "25.2% EBITDA -- best in region. Cross-train Store C GM at Wells Street this period. Document what they do differently."}
      ]
    }
  ]
}

RULES:
- Fill every field with real data from the file. Do not use placeholder text.
- acScorecard: one entry per area coach, sorted by EBITDA% descending.
- topPerformers: top 6–8 stores by EBITDA%, only stores with positive EBITDA.
- losingStores: all stores with negative EBITDA, sorted by EBITDA% ascending (worst first).
- turnarounds.gainers: top 5 stores by EBITDA$ improvement vs PY.
- turnarounds.declines: top 5 stores by EBITDA$ decline vs PY.
- peterFramework: customize the "body" text with 1–2 specific examples from THIS file's data.
- storesProfitable: count only stores where EBITDA$ is positive. Count carefully — this number goes on the cover.
- All percentages formatted as strings like "17.5%" — already converted from decimal.
- Dollar amounts formatted as strings like "$95,114" or "($19,369)" for negatives.
- acDeepDives: one entry per area coach. Each entry must include all 8 fields: coverKPIs (5 KPIs), scorecard (one row per store with all 8 metric columns), laborChart (labels/current/prior as numeric arrays, ytdLines, insight), cosChart (labels/current/prior as numeric arrays, storeCards, insight), ebitdaChart (labels/current/prior as numeric arrays, ytdItems, insight), anomalies (up to 4 stores with flagged line items — include p3/py dollar amounts and a coaching question as "note"), spotlights (crisis/urgent/brightSpot/structural quadrants with store name and 3 bullet points each — use null for any quadrant with no content), coachingPriorities (4 items with number/status/title/body — status is "red", "amber", or "green").
- For chart arrays (laborChart.current, cosChart.current, etc.): values must be RAW NUMBERS, not strings. Example: 27.4 not "27.4%". The chart renderer converts to percentages.
- anomalies: pull from controllable expense sub-lines as defined in the CONTROLLABLE EXPENSE SUB-LINES section above. Every AC should have at least 1–2 anomaly entries if any sub-line moved significantly vs PY.
- spotlights.crisis: use only if a store is EBITDA negative this period. spotlights.brightSpot: use for the strongest performing store. Set unused quadrants to null.`;

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

UNEXPECTED OR UNRECOGNIZED FILES: If an uploaded file does not match any trigger type above, analyze it anyway. Include its findings in the most relevant existing slide, or add a new entry in the "additionalSlides" array. Never skip an uploaded file — every file gets analyzed.

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
  }
}`;

// ─── P&L Analyzer ──────────────────────────────────────────────────────────

async function analyzePL(file, opts = {}) {
  const { level = 'region', scopeTarget = '', glFile = null, userName = '', scope = null, alignmentText = '', instructions = '' } = opts;
  const fileText = await extractTextFromFile(file);

  // General Ledger cross-reference
  let glBlock = '';
  if (glFile) {
    try {
      const glText = await extractTextFromFile(glFile);
      glBlock = `\n\n=== GENERAL LEDGER DATA ===\nCross-reference this with the P&L for deeper cost analysis. Identify variances, unusual line items, and cost control opportunities.\n\n${glText.slice(0, 30000)}\n=== END GENERAL LEDGER ===`;
    } catch (e) { console.warn('[PL] GL parse failed:', e.message); }
  }

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
    territory: `Produce a TERRITORY-LEVEL analysis covering all regions and area coaches in the file.${scopeTarget ? ` Focus on: ${scopeTarget}.` : ''}
Use the standard 8-slide JSON format. The "region" object should reflect the full territory (all VPs/RDs combined). The areaCoaches array should list ALL area coaches across all regions. Slide 4 rows should include every area coach sorted by EBITDA% descending. Slide 2 narrative should speak to territory-wide patterns. If the territory is large enough to warrant it, include additional slides as an "additionalSlides" array after the 8 standard slides. Each extra slide: {"type":"table|bullets|twoColumn","title":"...","items":[...] or "rows":[...] or "left":{...},"right":{...}}`,

    region: `Produce a REGION-LEVEL analysis.${scopeTarget ? ` Focus on the ${scopeTarget} region.` : ' Cover all area coaches in the file.'}
Use the standard 8-slide JSON format. The region object should name the specific region and director. Cover all area coaches in that region. Slide 3 bridge should explain what drove the region's EBITDA variance vs prior period. Slide 4 must have one row per area coach sorted by EBITDA% descending. Slides 6-8 must name specific stores and dollar amounts — never generic statements. If the region warrants deeper analysis (many ACs, complex issues), add additional slides via "additionalSlides" array: each entry {"type":"table|bullets|twoColumn","title":"...","items":[...] or "rows":[...] or "left":{...},"right":{...}}`,

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

  const userMessage = `${scopeBlock ? scopeBlock + '\n' : ''}Analysis Level: ${level.toUpperCase()}${scopeTarget ? ` — ${scopeTarget}` : ''}
${instructionsBlock}
${levelInstructions[level] || levelInstructions.region}

Here is the P&L file data:

${fileText}${glBlock}${alignBlock}`;

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 20000,
    system: PL_SYSTEM_PROMPT,
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
1. First, list every file uploaded and what data it contains.
2. Build slides ONLY for the data you actually found. If a source file was not uploaded, do not include that slide's key in the JSON — omit it entirely.
3. NEVER use placeholder text, empty arrays as filler, or "[Data not available]" strings. A missing key is always correct. A slide with fake or empty data is always wrong.
4. If only 3 files were uploaded, you may return as few as 4-5 slides. That is correct behavior.
5. If an unexpected file is uploaded that does not match the standard report types, analyze it anyway and include its findings in the most appropriate slide or as an additional slide.
Return a structured JSON object with content only for the slides you have real data to populate.`;

  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    system: [{ type: 'text', text: RECAP_SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
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

async function generateMorningBrief({ date, userName, userRole, fiscalContext, regionMetrics, byAC, byStore, velocity, flags, shoutouts, followUps }) {
  const fmtDollar = n => n != null ? '$' + Math.round(n).toLocaleString('en-US') : 'N/A';
  const fmtGrowth = n => n != null ? (n >= 0 ? '+' : '') + Number(n).toFixed(1) + '% vs LY' : 'no LY data';

  const isAC = userRole === 'area_coach';
  const isVP = userRole === 'vp';

  const totalLine = regionMetrics.store_count > 0
    ? `${regionMetrics.store_count} store${regionMetrics.store_count !== 1 ? 's' : ''} | Net Sales: ${fmtDollar(regionMetrics.net_sales_day)} | Growth: ${fmtGrowth(regionMetrics.avg_growth_day)}`
    : 'No DBS data loaded for this date.';

  // Role-specific breakdown section
  let breakdownSection = '';
  if (isAC && byStore?.length) {
    // Area Coach: show each store
    breakdownSection = 'BY STORE:\n' + byStore.map(s =>
      `  • ${s.store_name || s.store_id}: ${fmtDollar(s.net_sales_day)} | ${fmtGrowth(s.growth_pct_day)}`
    ).join('\n');
  } else if (byAC?.length) {
    // RDO/VP: show each AC with their stores if available
    breakdownSection = (isVP ? 'BY REGION / AREA COACH:\n' : 'BY AREA COACH:\n')
      + byAC.map(a => {
          let line = `  • ${a.area_coach}: ${fmtDollar(a.net_sales_day)} | ${fmtGrowth(a.avg_growth_day)} | ${a.high_flags} high flag(s)`;
          // For RDO, show notable stores under each AC
          if (!isVP && byStore?.length) {
            const acStores = byStore.filter(s => s.area_coach === a.area_coach);
            if (acStores.length) {
              const top = acStores.sort((x,y) => (y.growth_pct_day||0) - (x.growth_pct_day||0));
              line += '\n' + top.map(s => `      - ${s.store_name || s.store_id}: ${fmtDollar(s.net_sales_day)} | ${fmtGrowth(s.growth_pct_day)}`).join('\n');
            }
          }
          return line;
        }).join('\n');
  }

  const flagLines = flags.length
    ? flags.slice(0, 30).map(f => {
        const days = (f.consecutive_days_out||0) > 1 ? ` | ${f.consecutive_days_out}-day pattern` : '';
        const ac   = !isAC && f.area_coach ? ` (${f.area_coach})` : '';
        return `  • [${f.severity.toUpperCase()}] ${f.store_name || f.store_id}${ac} — ${f.metric_type}${days}`;
      }).join('\n')
    : '  No active flags.';

  const shoutLines = shoutouts.length
    ? shoutouts.slice(0, 8).map(s => {
        const ac = !isAC && s.area_coach ? ` (${s.area_coach})` : '';
        return `  • ${s.store_name || s.store_id}${ac}: "${(s.summary || s.comment_text || '').slice(0, 120)}"`;
      }).join('\n')
    : '  No shoutouts today.';

  const followLines = followUps.length
    ? followUps.map(f => {
        const ackDate = f.acknowledged_at ? String(f.acknowledged_at).slice(0, 10) : '?';
        return `  • ${f.store_name || f.store_id} | ${f.metric_type} | ${f.acknowledged_by} committed on ${ackDate}: "${(f.action_taken || '').slice(0, 100)}" | Status: ${f.flag_status || f.status}`;
      }).join('\n')
    : '  No outstanding follow-up items.';

  const velLines = (velocity || []).length
    ? velocity.map(v =>
        `  • ${v.area_coach || v.store_name || '?'}: OTD ${v.avg_otd_pct != null ? v.avg_otd_pct + '%' : 'N/A'} | <4min ${v.avg_pct_lt4 != null ? v.avg_pct_lt4 + '%' : 'N/A'}`
      ).join('\n')
    : '  No velocity data for this date.';

  // Role label for prompt
  const roleLabel = isAC ? 'Area Coach' : isVP ? 'VP of Operations' : 'Region Coach / RDO';

  // Role-specific output instructions
  const outputInstructions = isAC
    ? `YESTERDAY'S PERFORMANCE
[2-3 sentences covering your total area: combined sales, growth vs LY, overall read on the day]

STORE BREAKDOWN
[One bullet per store. Include sales, growth vs LY, any flags or standout moments. Be specific — this is what you'll reference in 1:1s.]

HIGHLIGHTS
[Stores or moments worth calling out positively — strong growth, great guest reviews, clean operations.]

WATCHOUTS
[Store-level issues: flags, negative growth, patterns. Name the specific store, metric, and how many consecutive days. Be direct.]

SPEED OF SERVICE
[OTD % and <4min % — flag any store below 85% OTD or below 70% <4min. Skip if no data.]

FOLLOW-UP ITEMS
[Commitments made in prior days that are still open or where the issue recurred. Skip if empty.]

PRIORITIES FOR TODAY
[2-3 specific actions for today based on the data above]`
    : isVP
    ? `YESTERDAY'S PERFORMANCE
[2-3 sentences on territory-wide performance: total sales, growth vs LY, overall read]

BY REGION / AREA COACH
[Bullet per AC or region. Call out who stood out positively and who needs attention, with numbers.]

HIGHLIGHTS
[Strongest performers — ACs, regions, or specific stores. Be specific with numbers.]

WATCHOUTS
[Underperforming ACs or regions, high-severity patterns, anything needing VP attention. Be direct.]

SPEED OF SERVICE
[Territory OTD summary. Call out any AC below 85% OTD. Skip if no data.]

FOLLOW-UP ITEMS
[Open commitments from prior days. Skip if empty.]

PRIORITIES FOR TODAY
[2-4 territory-level priorities]`
    : `YESTERDAY'S PERFORMANCE
[2-3 sentences: total region sales, growth vs LY, overall read]

BY AREA COACH
[Bullet per AC with sales, growth vs LY, high flags. Under each AC, list notable stores — best and worst performers with specific numbers.]

HIGHLIGHTS
[Standout AC or store performances — growth %, guest shoutouts. Be specific.]

WATCHOUTS
[High-severity flags, negative growth areas, multi-day patterns. Name the store, AC, metric, and consecutive days.]

SPEED OF SERVICE
[OTD and <4min by AC. Flag anyone below 85% OTD or 70% <4min. Skip if no data.]

FOLLOW-UP ITEMS
[Commitments from prior days that are still open or recurred. Skip if empty.]

PRIORITIES FOR TODAY
[2-4 specific priorities for the region today]`;

  const prompt = `You are writing a morning executive brief memo for ${userName} (${roleLabel}) at Ayvaz Pizza LLC, a Pizza Hut franchisee.

DATE: ${date}
${fiscalContext ? 'FISCAL CONTEXT: ' + fiscalContext : ''}

OVERALL PERFORMANCE:
${totalLine}

${breakdownSection}

SPEED OF SERVICE (Yesterday):
${velLines}

ACTIVE FLAGS (sorted high → low severity):
${flagLines}

GUEST SHOUTOUTS:
${shoutLines}

FOLLOW-UP ITEMS FROM PRIOR DAYS:
${followLines}

---
Write a professional morning brief memo at the ${roleLabel} level. Use this exact format:

MORNING BRIEF — ${date}
${fiscalContext || ''}

${outputInstructions}

Rules: Direct and factual. Use exact numbers from the data. Skip a section entirely if there's nothing to say. ${isAC ? 'Aim for 350-500 words.' : 'Aim for 400-600 words.'} Use Pizza Hut operations language (area coach not district manager, net sales not revenue, store not restaurant).`;

  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 2200,
    messages: [{ role: 'user', content: prompt }]
  });
  return resp.content[0].text.trim();
}

module.exports = { analyzePL, analyzePLForAC, analyzeRecap, analyzeDaily, analyzeTrends, generateRecapEmail, generateDailyIntelEmail, analyzeAdditionalContent, generateMorningBrief };