// =====================================================================
// VELOCITY PARSER — PDF and Excel parsers for SOS reports
// IST always comes from Above Store PDF (authoritative)
// Make time comes from SOS Excel
// Production/delivery from Delivery Excel
// =====================================================================
'use strict';

const XLSX = require('xlsx');
const fs   = require('fs');
const { execSync } = require('child_process');

// ── IST Bucket midpoints for approximation fallback ──────────────────
const BUCKET_MIDPOINTS = { lt10: 8, t1014: 12, t1518: 16.5, t1925: 22, gt25: 30 };

function calculateISTFromBuckets(lt10, t1014, t1518, t1925, gt25) {
  const total = lt10 + t1014 + t1518 + t1925 + gt25;
  if (total === 0) return null;
  return Math.round(((lt10*8 + t1014*12 + t1518*16.5 + t1925*22 + gt25*30) / total) * 10) / 10;
}

// ── Above Store Report PDF Parser (primary — uses pdftotext) ─────────
function parseAboveStorePDFLocal(filePath) {
  try {
    const text = execSync(`pdftotext "${filePath}" -`, { maxBuffer: 20 * 1024 * 1024 }).toString();
    const storeBlocks = text.split(/~+\s*\n\s*\nStore:/);
    const stores = [];

    for (const block of storeBlocks.slice(1)) {
      const storeMatch = block.trim().match(/^(S?\d+)\s+\(([^)]+)\)/);
      if (!storeMatch) continue;
      const rawId = storeMatch[1];
      const store_id = 'S' + rawId.replace(/^S/, '').padStart(6, '0');

      // Extract report date
      const dateMatch = block.match(/For Bus\.Date\s+\S+-(\d{2}\/\d{2}\/\d{2})/);
      let reportDate = null;
      if (dateMatch) {
        const parts = dateMatch[1].split('/');
        const yr = parseInt(parts[2]) < 100 ? 2000 + parseInt(parts[2]) : parseInt(parts[2]);
        reportDate = `${yr}-${parts[0].padStart(2,'0')}-${parts[1].padStart(2,'0')}`;
      }

      // Extract IST bucket counts (5 colon section)
      const colonBlock = block.match(/:\s*\n:\s*\n:\s*\n:\s*\n:\s*\n\s*\n([\s\S]+?)(?:Orders per Dispatch|Averages:|Cash controls)/);
      if (!colonBlock) continue;

      const afterColons = colonBlock[1];
      const lines = afterColons.trim().split('\n');
      const counts = [];
      for (const line of lines) {
        const l = line.trim();
        if (!l) continue;
        const m1 = l.match(/^(-?\d+)(?:\s+[\d.]+%)?$/);
        if (m1) { counts.push(parseInt(m1[1])); continue; }
        if (l.match(/^[\d.]+%$/)) continue;
        const m2 = l.match(/^(-?\d+)\s+[\d.]+%/);
        if (m2) counts.push(parseInt(m2[1]));
      }
      if (counts.length < 5) continue;

      const [ist_lt10, ist_1014, ist_1518, ist_1925, ist_gt25] = counts;
      const total_orders = ist_lt10 + ist_1014 + ist_1518 + ist_1925 + ist_gt25;
      const ist_lt19_pct = total_orders > 0
        ? parseFloat(((ist_lt10 + ist_1014 + ist_1518) / total_orders * 100).toFixed(1))
        : 0;

      // Extract In-Store Time average directly from PDF (no math fallback)
      let ist_avg = null;
      const inStoreValueMatch = block.match(/In-Store Time[\s\S]*?\n\s*(\d+)\s+mins/i);
      if (inStoreValueMatch) {
        ist_avg = parseFloat(inStoreValueMatch[1]);
      } else {
        const sameLineMatch = block.match(/In-Store Time\s*:\s*(\d+(?:\.\d+)?)/i);
        if (sameLineMatch) ist_avg = parseFloat(sameLineMatch[1]);
      }
      // If still null, approximate from buckets
      if (ist_avg === null) {
        ist_avg = calculateISTFromBuckets(ist_lt10, ist_1014, ist_1518, ist_1925, ist_gt25);
      }

      stores.push({ store_id, reportDate, ist_lt10, ist_1014, ist_1518, ist_1925, ist_gt25,
        ist_lt19_pct, total_orders, ist_avg });
    }

    // Determine report date from most common date across stores
    const dates = stores.map(s => s.reportDate).filter(Boolean);
    const dateCounts = {};
    dates.forEach(d => { dateCounts[d] = (dateCounts[d] || 0) + 1; });
    const reportDate = Object.entries(dateCounts).sort((a,b) => b[1]-a[1])[0]?.[0] || null;

    console.log(`[PDF Parser] ${stores.length} stores, date=${reportDate}`);
    return { stores, reportDate, source: 'pdf' };
  } catch (e) {
    console.error('[PDF Parser] pdftotext failed:', e.message);
    return { stores: [], reportDate: null, source: 'pdf', error: e.message };
  }
}

// ── Above Store PDF via Claude API (fallback when pdftotext unavailable) ─
async function parseAboveStorePDFClaude(filePath) {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return { stores: [], reportDate: null, source: 'pdf', error: 'No ANTHROPIC_API_KEY' };

    const fileBuffer = fs.readFileSync(filePath);
    const base64Data = fileBuffer.toString('base64');

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 8000,
        messages: [{
          role: 'user',
          content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Data } },
            { type: 'text', text: `Extract Speed of Service data from this Pizza Hut Above Store report.
Return ONLY a JSON array with no markdown. Each object:
{
  "store_id": "S039xxx",
  "report_date": "YYYY-MM-DD",
  "ist_avg": number (minutes, integer),
  "ist_lt10": number,
  "ist_1014": number,
  "ist_1518": number,
  "ist_1925": number,
  "ist_gt25": number,
  "total_orders": number,
  "ist_lt19_pct": number (percentage 0-100)
}
Return [] if no data found.` }
          ]
        }]
      })
    });

    if (!response.ok) throw new Error(`Claude API ${response.status}`);
    const apiResult = await response.json();
    const rawText = apiResult.content?.map(c => c.text || '').join('').trim();
    const jsonMatch = rawText.replace(/^```json\s*/i,'').replace(/```\s*$/,'').match(/\[[\s\S]*\]/);
    if (!jsonMatch) throw new Error('No JSON array in response');

    const stores = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(stores)) throw new Error('Non-array response');

    const reportDate = stores.find(s => s.report_date)?.report_date || null;
    console.log(`[PDF Claude] ${stores.length} stores, date=${reportDate}`);
    return { stores: stores.map(s => ({ ...s, store_id: normalizeStoreId(s.store_id) })), reportDate, source: 'pdf_claude' };
  } catch (e) {
    console.error('[PDF Claude] error:', e.message);
    return { stores: [], reportDate: null, source: 'pdf_claude', error: e.message };
  }
}

// ── Main PDF parser: try local first, fall back to Claude ────────────
async function parseAboveStorePDF(filePath) {
  const local = parseAboveStorePDFLocal(filePath);
  if (local.stores.length >= 10) return local;
  console.log(`[PDF Parser] pdftotext got ${local.stores.length} stores, trying Claude fallback...`);
  return parseAboveStorePDFClaude(filePath);
}

// ── SOS Excel Parser (Make time + %<4 only — NOT IST) ────────────────
function parseSOSExcel(filePath) {
  const wb = XLSX.readFile(filePath, { cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  let reportDate = null;
  try {
    const dateCell = raw[1] && raw[1][23];
    reportDate = extractDateFromCell(dateCell);
  } catch(e) {}
  if (!reportDate) reportDate = scanForDate(raw);

  const stores = [];
  for (const row of raw) {
    if (!row || !row[0] || typeof row[0] !== 'string') continue;
    if (!row[0].match(/^S0?\d{5,6}$/)) continue;
    const make = row[11] || null;
    const pctLt4 = row[13] ? parseFloat(String(row[13]).replace('%','')) || null : null;
    if (!make) continue;
    stores.push({ store_id: normalizeStoreId(row[0].trim()), make_time: make, pct_lt4: pctLt4 });
  }

  console.log(`[SOS Excel] ${stores.length} stores, date=${reportDate}`);
  return { stores, reportDate, source: 'sos_excel' };
}

// ── Delivery Performance Excel Parser ────────────────────────────────
function parseDeliveryExcel(filePath) {
  const wb = XLSX.readFile(filePath, { cellDates: false });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  let reportDate = null;
  try {
    const dateRow = raw[1]?.[0];
    if (typeof dateRow === 'string') {
      const m = dateRow.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
      if (m) reportDate = `${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
    }
  } catch(e) {}

  const stores = [];
  for (let i = 5; i < raw.length; i++) {
    const row = raw[i];
    if (!row || !row[0] || typeof row[0] !== 'string') continue;
    const storeMatch = row[0].match(/\(S(\d{6})\)\s*$/);
    if (!storeMatch) continue;
    const store_id = 'S' + storeMatch[1];

    const avgProdMins = parseFloat(row[7]) || 0;
    const makePct4    = parseFloat(row[8]) || 0;
    const prodPct15   = parseFloat(row[9]) || 0;
    const totalDel    = parseInt(row[2]) || 0;

    stores.push({
      store_id,
      production_time: avgProdMins > 0 ? `${Math.floor(avgProdMins)}:${String(Math.round((avgProdMins % 1)*60)).padStart(2,'0')}` : null,
      pct_lt15: prodPct15 > 0 ? prodPct15 * 100 : null,
      pct_lt4: makePct4 > 0 ? makePct4 * 100 : null,
      total_orders: totalDel
    });
  }

  console.log(`[Delivery Excel] ${stores.length} stores, date=${reportDate}`);
  return { stores, reportDate, source: 'delivery_excel' };
}

// ── Helpers ───────────────────────────────────────────────────────────
function normalizeStoreId(raw) {
  return 'S' + String(raw).replace(/^S/, '').padStart(6, '0');
}

function extractDateFromCell(cell) {
  if (!cell) return null;
  if (cell instanceof Date && cell.getFullYear() > 2020) {
    return `${cell.getFullYear()}-${String(cell.getMonth()+1).padStart(2,'0')}-${String(cell.getDate()).padStart(2,'0')}`;
  }
  if (typeof cell === 'string') {
    const m = cell.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (m) return `${m[3]}-${m[1].padStart(2,'0')}-${m[2].padStart(2,'0')}`;
    const m2 = cell.match(/(\d{4})-(\d{2})-(\d{2})/);
    if (m2) return m2[0];
  }
  return null;
}

function scanForDate(raw) {
  for (let i = 0; i < Math.min(5, raw.length); i++) {
    for (let j = 0; j < Math.min(30, (raw[i] || []).length); j++) {
      const d = extractDateFromCell(raw[i][j]);
      if (d) return d;
    }
  }
  return null;
}

module.exports = { parseAboveStorePDF, parseAboveStorePDFLocal, parseSOSExcel, parseDeliveryExcel, normalizeStoreId };
