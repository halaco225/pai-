const PptxGenJS = require('pptxgenjs');
const { buildACDeepDive } = require('./pptx-pl-ac');
const { chromium } = require('playwright');

// ─── Base palette (no # prefix — pptxgenjs uses raw hex) ──────────────────
const C = {
  navy:   '1E2761',  // matches reference PPTX
  gold:   'E07B2A',
  white:  'FFFFFF',
  light:  'F4F6FA',  // matches reference PPTX bg
  dk:     '1E293B',
  green:  '1D9E75',  // matches reference PPTX
  red:    'C0392B',
  amber:  'D68910',
  gray:   '64748B',
  lgray:  'E2E8F0',
  border: 'D1D9E6',
  lgred:  'FFF5F5',
};

// ─── Per-theme overrides (only keys that differ from base) ─────────────────
const THEME_OVERRIDES = {
  'command-dark':   { navy: '111111', light: '1A1A1A', gold: 'CC0000', lgray: '2A2A2A', border: '333333', gray: '888888', dk: 'CCCCCC' },
  'clean-white':    { navy: 'CC0000', light: 'F9F9F9', gold: 'CC0000', border: 'E0E0E0', lgray: 'EEEEEE' },
  'maroon':         { navy: '3D0C0C', light: '2A0808', gold: 'F9A825', lgray: '350E0E', border: '4A1010', gray: 'A07070', dk: 'F0D0D0' },
  'royal-white':    { navy: '003594', light: 'EEF2FA', gold: '4A90D9', border: 'C5D5EE', lgray: 'DCE8FA' },
  'purple-gold':    { navy: '2D0A5E', light: '1A0535', gold: 'F5C518', lgray: '250845', border: '350A70', gray: 'A080C0', dk: 'E0C0FF' },
  'forest-gold':    { navy: '1A4731', light: '102C1E', gold: 'B8960C', lgray: '183D28', border: '204F33', gray: '709080', dk: 'C0E0D0' },
  'navy-orange':    { navy: '0D1B2A', light: '071018', gold: 'E85D04', lgray: '0E1E30', border: '152438', gray: '607080', dk: 'C0D0E0' },
  'black-gold':     { navy: '0F0F0F', light: '1A1A0A', gold: 'C9A84C', lgray: '222215', border: '333320', gray: '807060', dk: 'E0D0B0' },
  'slate-teal':     { navy: '1C3A4A', light: '0E2030', gold: '00B4D8', lgray: '152C3A', border: '1E3A4A', gray: '608090', dk: 'C0D8E8' },
  'crimson-silver': { navy: '6B0F1A', light: '3D0810', gold: 'A8A9AD', lgray: '4A0E18', border: '5A1220', gray: 'A09090', dk: 'E0C0C0' },
};

const BASE_C = { ...C };

// ─── Apply theme colors (mutates C for this request) ──────────────────────
function applyTheme(slug) {
  Object.assign(C, BASE_C, THEME_OVERRIDES[slug] || {});
}

// ─── Parse analysis data ───────────────────────────────────────────────────
function parseAnalysis(analysis) {
  if (typeof analysis === 'object' && analysis !== null) return analysis;
  if (typeof analysis === 'string') {
    try {
      const m = analysis.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (m) return JSON.parse(m[1]);
      const s = analysis.indexOf('{'), e = analysis.lastIndexOf('}');
      if (s !== -1 && e !== -1) return JSON.parse(analysis.slice(s, e + 1));
    } catch (_) {}
  }
  return null;
}

// ─── Entry point ───────────────────────────────────────────────────────────
async function generatePLPPTX(analysis, options = {}) {
  applyTheme(options.theme || 'default');
  const data = parseAnalysis(analysis);

  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE'; // 13.33" × 7.5"
  pptx.author = 'P.AI by Ayvaz Pizza';

  if (data) {
    if (data.storeName || data.plLines) {
      buildStoreDeck(pptx, data, options);
    } else {
      buildRegionDeck(pptx, data, options);
    }
  } else {
    buildFallbackDeck(pptx, typeof analysis === 'string' ? analysis : JSON.stringify(analysis));
  }

  return pptx.write({ outputType: 'nodebuffer' });
}

// ─── 1-Pager: PDF via Playwright ──────────────────────────────────────────
async function generateOnePager(analysis, options = {}) {
  applyTheme(options.theme || 'default');
  const data = parseAnalysis(analysis);
  const html = buildOnePagerHTML(data, options);

  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'networkidle' });
    const pdf = await page.pdf({
      width: '11in', height: '8.5in', printBackground: true,
      margin: { top: 0, right: 0, bottom: 0, left: 0 }
    });
    return pdf;
  } finally {
    await browser.close();
  }
}

function buildOnePagerHTML(data, options) {
  const logo = options.logoBase64 || null;
  const n = (hex) => '#' + hex;
  const navy = n(C.navy), gold = n(C.gold), light = n(C.light), white = n(C.white);
  const dk = n(C.dk), green = n(C.green), red = n(C.red), amber = n(C.amber);
  const gray = n(C.gray), lgray = n(C.lgray), border = n(C.border);

  const isStore = !!(data && (data.storeName || data.plLines));
  const isAC    = !!(data && !isStore && (data.acName || data.scorecard));
  const d = data || {};
  const region = d.region || {};
  const period = d.period || 'P&L Analysis';

  let title, subtitle;
  if (isStore) {
    title    = `${d.storeNum ? d.storeNum + ' · ' : ''}${d.storeName || 'Store'} — ${period}`;
    subtitle = `Area Coach: ${d.acName || ''} · ${region.company || 'Ayvaz Pizza LLC'}`;
  } else if (isAC) {
    title    = `${d.acName || 'Area Coach'} — ${period}`;
    subtitle = `Area Coach Report · ${region.name || ''} · ${region.company || 'Ayvaz Pizza LLC'}`;
  } else {
    title    = `${region.name || 'Region'} — ${period} P&L One-Pager`;
    subtitle = region.operator || region.director || region.company || 'Ayvaz Pizza LLC';
  }

  // KPI cards
  let kpis = [];
  if (isStore) {
    const h = d.headline || {};
    kpis = [
      { label: 'Net Sales',       value: h.netSales  || '—', sub: h.netSalesVsPY || '',  good: true },
      { label: 'EBITDA $',        value: h.ebitda    || '—', sub: h.ebitdaVsPY   || '',  good: !(h.ebitda||'').startsWith('(') },
      { label: 'EBITDA %',        value: h.ebitdaPct || '—', sub: '',                     good: !(h.ebitdaPct||'').startsWith('-') },
      { label: 'Direct Labor %',  value: h.laborPct  || '—', sub: h.laborVsPY    || '',  good: (h.laborVsPY||'').includes('-') },
      { label: 'Cost of Sales %', value: h.cogsPct   || '—', sub: h.cogsVsPY    || '',   good: (h.cogsVsPY||'').includes('-') },
    ];
  } else if (isAC) {
    kpis = (d.coverKPIs || []).map((k, i) => ({ label: k.label, value: k.value, sub: '', good: i < 2 }));
  } else {
    kpis = (d.slide2?.metrics || d.headline ? [
      { label: 'Region EBITDA',     value: d.headline?.ebitda          || d.slide2?.metrics?.[0]?.value || '—', sub: d.headline?.ebitdaVsPY       || d.slide2?.metrics?.[0]?.vsPY || '', good: true },
      { label: 'EBITDA Margin',     value: d.headline?.ebitdaMargin    || d.slide2?.metrics?.[1]?.value || '—', sub: d.headline?.ebitdaMarginVsPY || d.slide2?.metrics?.[1]?.vsPY || '', good: true },
      { label: 'Stores Profitable', value: d.headline?.storesProfitable || d.slide2?.metrics?.[2]?.value || '—', sub: d.headline?.storesNegativeNote || '', good: true },
      { label: 'Net Sales',         value: d.headline?.netSales        || d.slide2?.metrics?.[3]?.value || '—', sub: d.headline?.netSalesVsPY     || d.slide2?.metrics?.[3]?.vsPY || '', good: true },
    ] : (d.slide2?.metrics || []).map(m => ({ label: m.label, value: m.value, sub: m.vsPY || '', good: m.trend === 'up' })));
  }

  // Scorecard / table section
  let scorecardHtml = '';
  if (isStore) {
    const lines = (d.plLines || []);
    const KEY_LINES = ['Product Net Sales','Cost of Food Sales','Total Direct Labor Cost','Store Controllable Profit','Store Level EBITDA'];
    scorecardHtml = `<div class="sh">P&amp;L DETAIL — ALL LINE ITEMS</div>
    <table class="tbl"><tr>
      <th style="text-align:left;width:36%">Line Item</th><th>P3 $</th><th>P3 %</th><th>PY $</th><th>PY %</th><th>Var $</th><th>Var bps</th><th>Flag</th>
    </tr>${lines.map((r,i) => {
      const bold = KEY_LINES.includes(r.label);
      const neg  = (r.varDollars||'').startsWith('-') || (r.varDollars||'').startsWith('(');
      return `<tr style="background:${i%2===0?white:lgray}">
        <td style="font-weight:${bold?700:400};color:${bold?navy:dk}">${r.label||''}</td>
        <td>${r.current||''}</td><td>${r.currentPct||''}</td>
        <td>${r.py||''}</td><td>${r.pyPct||''}</td>
        <td style="font-weight:${bold?700:400};color:${neg?red:green}">${r.varDollars||''}</td>
        <td style="color:${neg?red:green}">${r.varBps||''}</td>
        <td style="color:${red};font-size:7pt">${r.flag||''}</td>
      </tr>`;
    }).join('')}</table>`;
  } else if (isAC) {
    const rows = d.scorecard || [];
    scorecardHtml = `<div class="sh">STORE SCORECARD</div>
    <table class="tbl"><tr>
      <th style="text-align:left">Store</th><th>Net Sales</th><th>EBITDA $</th><th>EBITDA %</th><th>Labor %</th><th>COGS %</th><th>SCP %</th>
    </tr>${rows.map((r,i) => {
      const ep = parseFloat(String(r.ebitdaPct||'0').replace('%',''));
      const ec = ep<0 ? red : ep>=10 ? green : amber;
      return `<tr style="background:${i%2===0?white:lgray}">
        <td style="font-weight:600">${r.storeNum||''} ${r.name||''}</td>
        <td>${r.netSales||''}</td>
        <td style="font-weight:700;color:${ec}">${r.ebitdaDollars||''}</td>
        <td style="font-weight:700;color:${ec}">${r.ebitdaPct||''}</td>
        <td>${r.laborPct||''}</td><td>${r.cosPct||''}</td><td>${r.scpPct||''}</td>
      </tr>`;
    }).join('')}</table>`;
  } else {
    const rows = d.slide4?.rows || d.acScorecard || [];
    scorecardHtml = `<div class="sh">AREA COACH SCORECARD</div>
    <table class="tbl"><tr>
      <th style="text-align:left">Area Coach</th><th>EBITDA $</th><th>EBITDA %</th><th>vs PY (bps)</th><th>Labor %</th><th>Neg Stores</th>
    </tr>${rows.map((r,i) => {
      const ep = parseFloat(String(r.ebitdaPct||'0').replace('%',''));
      const ec = ep<0 ? red : ep>=15 ? green : amber;
      const bv = parseFloat(String(r.vsPYBps||'0').replace(/[^0-9.\-]/g,''));
      const bc = bv>=0 ? green : red;
      return `<tr style="background:${i%2===0?white:lgray}">
        <td style="font-weight:600">${r.ac||r.name||''}</td>
        <td>${r.ebitdaDollars||''}</td>
        <td style="font-weight:700;color:${ec}">${r.ebitdaPct||''}</td>
        <td style="font-weight:700;color:${bc}">${r.vsPYBps||''}</td>
        <td>${r.dirLaborPct||''}</td>
        <td style="color:${(parseInt(r.negStores)||0)>0?red:dk}">${r.negStores??'0'}</td>
      </tr>`;
    }).join('')}</table>`;
  }

  // Right column: takeaways, anomalies, priorities
  const takeaways = isStore ? (d.coachingNotes||[]).map(n=>`[${(n.status||'').toUpperCase()}] ${n.title}: ${n.detail||''}`)
    : isAC ? (d.coachingPriorities||[]).map(p=>`[${p.number}] ${p.title}: ${p.body||''}`)
    : (d.slide2?.narrative || d.headline?.takeaways || []);

  const anomalies = isStore ? (d.anomalies||[]).map(a=>({ title: a.line||'', note: a.note||'', sev: a.severity||'Watch', p3: a.current||'', py: a.py||'' }))
    : isAC ? (d.anomalies||[]).flatMap(s=>(s.items||[]).map(it=>({ title:`${s.name}: ${it.line}`, note: it.note||'', sev: s.status||'Watch', p3: it.p3||'', py: it.py||'' })))
    : (d.slide6?.cards||[]).map(c=>({ title: c.title||'', note: c.analysis||'', sev: c.severity||'Watch' }));

  const priorities = isStore ? [] : isAC ? (d.coachingPriorities||[]) : (d.slide8?.priorities||[]);

  const sevColor = (s) => { const sl=(s||'').toLowerCase(); return sl==='critical'?red:sl==='high'?amber:gray; };
  const priColor = (s) => s==='red'?red:s==='green'?green:amber;

  const kpiHtml = kpis.slice(0,6).map(k=>`
    <div class="kpi-card">
      <div class="kpi-lbl">${k.label}</div>
      <div class="kpi-val">${k.value}</div>
      ${k.sub?`<div class="kpi-sub" style="background:${k.good?green:red}">${k.sub}</div>`:''}
    </div>`).join('');

  const taHtml = takeaways.slice(0,8).map(t=>`
    <div class="bullet"><div class="dot" style="background:${gold}"></div><div>${t}</div></div>`).join('');

  const anomHtml = anomalies.slice(0,6).map(a=>`
    <div class="anom" style="border-left-color:${sevColor(a.sev)}">
      <div style="flex:1"><b style="color:${dk};font-size:7.5pt">${a.title}</b>
        ${a.p3?`<br><span style="font-size:6.5pt;color:${gray}">${a.p3} vs ${a.py} PY · </span>`:''}
        <span style="font-size:7pt;color:${dk}">${a.note}</span></div>
      <div class="sev-badge" style="background:${sevColor(a.sev)}">${a.sev}</div>
    </div>`).join('');

  const priHtml = priorities.slice(0,4).map(p=>`
    <div class="pri-item">
      <div class="pri-num" style="background:${priColor(p.urgency||p.status)}">${p.number||''}</div>
      <div class="pri-body">
        <div class="pri-title" style="color:${priColor(p.urgency||p.status)}">${p.title||''}</div>
        <div class="pri-detail">${(p.detail||p.body||'').slice(0,130)}</div>
      </div>
    </div>`).join('');

  const logoHtml = logo ? `<img src="${logo}" style="height:38px;max-width:130px;object-fit:contain;margin-right:10px;">` : '';

  return `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>
@page{size:11in 8.5in landscape;margin:0}
*{box-sizing:border-box;margin:0;padding:0;font-family:Arial,sans-serif}
body{width:11in;height:8.5in;background:${light};display:flex;flex-direction:column;overflow:hidden}
.hdr{background:${navy};color:${white};display:flex;align-items:center;padding:0 0.25in;height:0.6in;flex-shrink:0;gap:10px}
.hdr-title{font-size:12.5pt;font-weight:900;letter-spacing:.3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1}
.hdr-sub{font-size:7.5pt;color:${lgray};white-space:nowrap}
.gold-bar{height:5px;background:${gold};flex-shrink:0}
.kpi-row{display:flex;gap:9px;padding:8px 0.25in 6px;flex-shrink:0}
.kpi-card{flex:1;background:${white};border:1px solid ${border};padding:7px 9px;border-top:4px solid ${navy}}
.kpi-lbl{font-size:6pt;font-weight:700;letter-spacing:1px;color:${gray};text-transform:uppercase;margin-bottom:2px}
.kpi-val{font-size:19pt;font-weight:900;color:${navy};line-height:1.1}
.kpi-sub{font-size:6.5pt;padding:2px 5px;margin-top:3px;font-weight:700;display:inline-block;color:${white};border-radius:2px}
.main{display:flex;gap:9px;padding:0 0.25in;flex:1;overflow:hidden;min-height:0}
.left{flex:62;display:flex;flex-direction:column;overflow:hidden;border:1px solid ${border};background:${white}}
.right{flex:38;display:flex;flex-direction:column;gap:7px;overflow:hidden}
.sh{background:${navy};color:${white};font-size:6.5pt;font-weight:700;letter-spacing:1.5px;padding:3px 8px;text-transform:uppercase;flex-shrink:0}
.tbl{width:100%;border-collapse:collapse;font-size:7pt;overflow:hidden}
.tbl th{background:${navy};color:${white};padding:3px 4px;text-align:center;font-size:6pt;font-weight:700}
.tbl th:first-child{text-align:left;padding-left:7px}
.tbl td{padding:3px 4px;text-align:center;border-bottom:1px solid ${border};font-size:7pt}
.tbl td:first-child{text-align:left;padding-left:7px}
.sect{background:${white};border:1px solid ${border};overflow:hidden;display:flex;flex-direction:column}
.bullet{display:flex;align-items:flex-start;gap:5px;padding:4px 8px;border-bottom:1px solid ${border};font-size:7pt;line-height:1.3;color:${dk}}
.dot{width:7px;height:7px;border-radius:1px;margin-top:3px;flex-shrink:0}
.anom{display:flex;align-items:center;gap:6px;padding:4px 8px;border-left:3px solid ${red};border-bottom:1px solid ${border}}
.sev-badge{background:${gray};color:${white};padding:2px 5px;border-radius:2px;font-size:6pt;font-weight:700;white-space:nowrap}
.pri-item{display:flex;align-items:stretch;border-bottom:1px solid ${border}}
.pri-num{min-width:28px;font-size:11pt;font-weight:900;color:${white};display:flex;align-items:center;justify-content:center}
.pri-body{padding:4px 7px;flex:1}
.pri-title{font-size:7pt;font-weight:700}
.pri-detail{font-size:6.5pt;color:${gray};margin-top:1px;line-height:1.3}
.ftr{background:${navy};color:${lgray};font-size:6pt;padding:3px 0.25in;letter-spacing:1px;flex-shrink:0;white-space:nowrap;overflow:hidden}
</style></head><body>
<div class="hdr">${logoHtml}
  <div style="flex:1"><div class="hdr-title">${title}</div><div class="hdr-sub">${subtitle}</div></div>
  <div style="font-size:7pt;color:${lgray};text-align:right">P.AI · PRELIMINARY · CONFIDENTIAL</div>
</div>
<div class="gold-bar"></div>
<div class="kpi-row">${kpiHtml}</div>
<div class="main">
  <div class="left">${scorecardHtml}</div>
  <div class="right">
    ${taHtml ? `<div class="sect" style="flex:${anomHtml||priHtml?'45':'100'}"><div class="sh">${isStore||isAC?'COACHING PRIORITIES':'KEY TAKEAWAYS'}</div>${taHtml}</div>` : ''}
    ${anomHtml ? `<div class="sect" style="flex:${taHtml?'30':'50'}"><div class="sh">ANOMALIES &amp; FLAGS</div>${anomHtml}</div>` : ''}
    ${priHtml  ? `<div class="sect" style="flex:${taHtml?'25':'50'}"><div class="sh">REGIONAL PRIORITIES</div>${priHtml}</div>` : ''}
  </div>
</div>
<div class="ftr">${period} · ${region.company||'Ayvaz Pizza LLC'} · ${region.director||''} · P.AI by Ayvaz Pizza LLC</div>
</body></html>`;
}

// ─── Region / Territory deck (dynamic — 8+ slides) ────────────────────────
function buildRegionDeck(pptx, data, options = {}) {
  const period = data.period || 'P&L Analysis';
  const region = data.region || {};
  const foot   = `${period} · Preliminary · ${region.company || 'Ayvaz Pizza LLC'} · ${region.director || ''}`;

  s1Title(pptx, data, period, region, foot, options);
  s2RegionHeadline(pptx, data, period, foot);
  s3VarianceBridge(pptx, data, period, foot);
  s4ACScorecard(pptx, data, period, foot);
  s5ExpenseAnomalies(pptx, data, period, foot);
  s6InvestigationCards(pptx, data, period, foot);
  s7ACDeepDive(pptx, data, period, foot);
  s8Takeaways(pptx, data, period, foot);

  // Additional slides beyond the standard 8
  const extra = data.additionalSlides || [];
  extra.forEach(s => sAdditionalSlide(pptx, s, period, foot));
}

// ─── Common helpers ────────────────────────────────────────────────────────

function navyHeader(pptx, slide, title) {
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 13.33, h: 0.62, fill: { color: C.navy }, line: { type: 'none' } });
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0.62, w: 13.33, h: 0.05, fill: { color: C.gold }, line: { type: 'none' } });
  slide.addText(title, { x: 0.3, y: 0.1, w: 12.7, h: 0.46, color: C.white, fontSize: 13.5, bold: true, fontFace: 'Arial Black', valign: 'middle' });
}

function foot(slide, label) {
  slide.addText(label, { x: 0.3, y: 7.23, w: 12.7, h: 0.22, color: C.gray, fontSize: 7.5, charSpacing: 1 });
}

function tblHdr(pptx, slide, cols, widths, x, y, h) {
  let cx = x;
  cols.forEach((col, i) => {
    slide.addShape(pptx.ShapeType.rect, { x: cx, y, w: widths[i], h, fill: { color: C.navy }, line: { type: 'none' } });
    slide.addText(col.toUpperCase(), { x: cx + 0.07, y: y + 0.05, w: widths[i] - 0.1, h: h - 0.08, color: C.white, fontSize: 7.5, bold: true, charSpacing: 0.3, align: i === 0 ? 'left' : 'center', valign: 'middle' });
    cx += widths[i];
  });
}

function bpsColor(bpsStr, invertGood) {
  const v = parseFloat(String(bpsStr).replace(/[^0-9.\-]/g, ''));
  if (isNaN(v)) return C.dk;
  const good = invertGood ? v < 0 : v > 0;
  return good ? C.green : C.red;
}

function tierColor(tier) {
  if (tier === 'green') return C.green;
  if (tier === 'red')   return C.red;
  return C.amber;
}

function severityColor(sev) {
  if (!sev) return C.gray;
  const s = sev.toLowerCase();
  if (s === 'critical') return C.red;
  if (s === 'high')     return C.amber;
  return C.gray;
}

// ─── Slide 1: Cover ────────────────────────────────────────────────────────
function s1Cover(pptx, data, period, region) {
  const slide = pptx.addSlide();
  slide.background = { color: C.navy };

  slide.addShape(pptx.ShapeType.rect, {
    x: 0, y: 0, w: 0.22, h: 7.5,
    fill: { color: C.gold }, line: { type: 'none' },
  });

  const co  = (region.company  || 'AYVAZ PIZZA LLC').toUpperCase();
  const rgn = (region.name     || 'SOUTHEAST ATLANTA REGION').toUpperCase();

  slide.addText(`${co} · ${rgn}`, {
    x: 0.55, y: 0.9, w: 12.4, h: 0.38,
    color: C.gold, fontSize: 11, bold: true, charSpacing: 2.5, fontFace: 'Arial Black',
  });

  slide.addText(`${period} P&L Analysis`, {
    x: 0.55, y: 1.45, w: 12.4, h: 1.35,
    color: C.white, fontSize: 50, bold: true, fontFace: 'Arial Black',
  });

  slide.addText('Region Performance · Area Coach Breakdown · Store Highlights', {
    x: 0.55, y: 3.05, w: 12.4, h: 0.42,
    color: C.lgray, fontSize: 12.5,
  });

  slide.addShape(pptx.ShapeType.rect, {
    x: 0.55, y: 3.62, w: 7.5, h: 0.04,
    fill: { color: C.gold }, line: { type: 'none' },
  });

  const op = region.operator || 'Harold Lacoste · Director of Operations';
  slide.addText(`Prepared by ${op}`, {
    x: 0.55, y: 3.84, w: 12.4, h: 0.35,
    color: C.gray, fontSize: 10.5,
  });
  slide.addText(`Period Ending ${period}  |  Preliminary`, {
    x: 0.55, y: 4.28, w: 12.4, h: 0.32,
    color: C.gray, fontSize: 9.5,
  });
}

// ─── Slide 2: Region Headline ──────────────────────────────────────────────
function s2Headline(pptx, data, period, footLabel) {
  const slide = pptx.addSlide();
  slide.background = { color: C.light };
  navyHeader(pptx, slide, `Region Headline — ${period}`);

  const h = data.headline || {};

  const cards = [
    { label: 'Region EBITDA',     value: h.ebitda            || '—', sub: h.ebitdaVsPY           || '' },
    { label: 'EBITDA Margin',     value: h.ebitdaMargin      || '—', sub: h.ebitdaMarginVsPY     || '' },
    { label: 'Stores Profitable', value: h.storesProfitable  || '—', sub: h.storesNegativeNote   || '' },
    { label: 'Net Sales',         value: h.netSales          || '—', sub: h.netSalesVsPY         || '' },
  ];

  const cW = 3.0, cH = 1.6, cY = 0.82, startX = 0.22, gap = 0.2;

  cards.forEach((card, i) => {
    const x = startX + i * (cW + gap);
    slide.addShape(pptx.ShapeType.rect, {
      x, y: cY, w: cW, h: cH,
      fill: { color: C.white }, line: { color: C.border, width: 1 },
    });
    slide.addShape(pptx.ShapeType.rect, {
      x, y: cY, w: cW, h: 0.06,
      fill: { color: C.navy }, line: { type: 'none' },
    });
    slide.addText(card.label.toUpperCase(), {
      x: x + 0.14, y: cY + 0.13, w: cW - 0.24, h: 0.26,
      color: C.gray, fontSize: 7.5, bold: true, charSpacing: 1,
    });
    slide.addText(card.value, {
      x: x + 0.1, y: cY + 0.41, w: cW - 0.2, h: 0.7,
      color: C.navy, fontSize: 26, bold: true, fontFace: 'Arial Black',
    });
    if (card.sub) {
      slide.addText(card.sub, {
        x: x + 0.14, y: cY + 1.15, w: cW - 0.24, h: 0.38,
        color: C.dk, fontSize: 8.5, wrap: true,
      });
    }
  });

  // Key Takeaways box
  const boxY = cY + cH + 0.18;
  const boxH = 7.5 - boxY - 0.38;

  slide.addShape(pptx.ShapeType.rect, {
    x: 0.22, y: boxY, w: 12.89, h: boxH,
    fill: { color: C.white }, line: { color: C.border, width: 1 },
  });
  slide.addShape(pptx.ShapeType.rect, {
    x: 0.22, y: boxY, w: 0.07, h: boxH,
    fill: { color: C.gold }, line: { type: 'none' },
  });
  slide.addText('KEY TAKEAWAYS', {
    x: 0.44, y: boxY + 0.1, w: 5, h: 0.26,
    color: C.navy, fontSize: 7.5, bold: true, charSpacing: 2,
  });

  const takeaways = h.takeaways || [];
  if (takeaways.length > 0) {
    slide.addText(
      takeaways.map(t => ({ text: t, options: { breakLine: true } })),
      {
        x: 0.44, y: boxY + 0.38, w: 12.55, h: boxH - 0.5,
        color: C.dk, fontSize: 11.5, valign: 'top',
        lineSpacingMultiple: 1.6,
        bullet: { type: 'bullet', indent: 10 },
      }
    );
  }

  foot(slide, footLabel);
}

// ─── Slide 3: AC Scorecard ─────────────────────────────────────────────────
function s3ACScorecard(pptx, data, period, footLabel) {
  const slide = pptx.addSlide();
  slide.background = { color: C.light };
  navyHeader(pptx, slide, `Area Coach ${period} Scorecard`);

  const rows   = data.acScorecard || [];
  const cols   = ['Area Coach', 'Stores', 'EBITDA $', 'EBITDA %', 'vs PY (bps)', 'COGS %', 'Labor %'];
  const widths = [2.6, 0.7, 1.5, 1.1, 1.25, 1.05, 1.05];
  const tX = 0.22, tY = 0.82, hH = 0.4, rH = 0.52;

  tblHdr(pptx, slide, cols, widths, tX, tY, hH);

  rows.forEach((row, ri) => {
    const y  = tY + hH + ri * rH;
    const bg = ri % 2 === 0 ? C.white : C.light;
    const ep = parseFloat(String(row.ebitdaPct || '0').replace('%', ''));
    const isRed   = ep < 0;
    const isGreen = ep >= 12;

    const vals = [
      row.name       || '—',
      String(row.stores || '—'),
      row.ebitdaDollars || '—',
      row.ebitdaPct  || '—',
      row.vsPYBps    || '—',
      row.cogsPct    || '—',
      row.laborPct   || '—',
    ];

    let cx = tX;
    vals.forEach((val, ci) => {
      slide.addShape(pptx.ShapeType.rect, {
        x: cx, y, w: widths[ci], h: rH,
        fill: { color: bg }, line: { color: C.lgray, width: 0.75 },
      });

      let color = C.dk;
      if (ci === 3) color = isRed ? C.red : (isGreen ? C.green : C.amber);
      if (ci === 4) {
        const n = parseFloat(String(val).replace(/[^0-9.-]/g, ''));
        color = !isNaN(n) && n >= 0 ? C.green : C.red;
      }

      slide.addText(val, {
        x: cx + 0.08, y: y + 0.07, w: widths[ci] - 0.12, h: rH - 0.1,
        color, fontSize: ci === 0 ? 11 : 12,
        bold: ci === 0 || ci === 3,
        align: ci === 0 ? 'left' : 'center', valign: 'middle',
      });
      cx += widths[ci];
    });

    // Left status bar
    const barC = isRed ? C.red : (isGreen ? C.green : null);
    if (barC) {
      slide.addShape(pptx.ShapeType.rect, {
        x: tX, y, w: 0.06, h: rH,
        fill: { color: barC }, line: { type: 'none' },
      });
    }
  });

  foot(slide, footLabel);
}

// ─── Slide 4: Top Performers ───────────────────────────────────────────────
function s4TopPerformers(pptx, data, period, footLabel) {
  const slide = pptx.addSlide();
  slide.background = { color: C.light };
  navyHeader(pptx, slide, `Top Performers — ${period}`);

  const rows   = data.topPerformers || [];
  const cols   = ['Store', 'DM', 'Net Sales', 'EBITDA $', 'EBITDA %', 'BPS vs PY', 'COGS %', 'Labor %'];
  const widths = [2.2, 1.0, 1.35, 1.35, 1.05, 1.05, 1.0, 1.0];
  const tX = 0.22, tY = 0.82, hH = 0.4, rH = 0.5;

  tblHdr(pptx, slide, cols, widths, tX, tY, hH);

  rows.forEach((row, ri) => {
    const y  = tY + hH + ri * rH;
    const bg = ri % 2 === 0 ? C.white : C.light;

    slide.addShape(pptx.ShapeType.rect, {
      x: tX, y, w: 0.06, h: rH,
      fill: { color: C.green }, line: { type: 'none' },
    });

    const storeLbl = (row.storeNum ? row.storeNum + ' ' : '') + (row.store || '—');
    const vals = [
      storeLbl,
      row.ac || row.dm || '—',
      row.netSales || '—',
      row.ebitdaDollars || '—',
      row.ebitdaPct || '—',
      row.bpsVsPY || '—',
      row.cogsPct || '—',
      row.laborPct || '—',
    ];

    let cx = tX;
    vals.forEach((val, ci) => {
      slide.addShape(pptx.ShapeType.rect, {
        x: cx, y, w: widths[ci], h: rH,
        fill: { color: bg }, line: { color: C.lgray, width: 0.75 },
      });
      slide.addText(val, {
        x: cx + 0.08, y: y + 0.07, w: widths[ci] - 0.12, h: rH - 0.1,
        color: ci === 4 ? C.green : C.dk,
        fontSize: ci === 0 ? 10 : 11,
        bold: ci === 4,
        align: ci <= 1 ? 'left' : 'center', valign: 'middle',
      });
      cx += widths[ci];
    });
  });

  if (data.topPerformersNote) {
    const noteY = tY + hH + rows.length * rH + 0.12;
    slide.addText(data.topPerformersNote, {
      x: tX, y: noteY, w: 12.89, h: 0.35,
      color: C.dk, fontSize: 9.5, italic: true,
    });
  }

  foot(slide, footLabel);
}

// ─── Slide 5: Losing Stores ────────────────────────────────────────────────
function s5LosingStores(pptx, data, period, footLabel) {
  const slide = pptx.addSlide();
  slide.background = { color: C.light };
  navyHeader(pptx, slide, 'Stores Losing Money — Needs Immediate Attention');

  const rows   = data.losingStores || [];
  const cols   = ['Store', 'DM', 'Net Sales', 'EBITDA $', 'EBITDA %', 'COGS %', 'Labor %', 'Primary Issue'];
  const widths = [1.7, 0.85, 1.1, 1.1, 1.0, 0.9, 0.9, 3.77];
  const tX = 0.22, tY = 0.82, hH = 0.4, rH = 0.5;

  tblHdr(pptx, slide, cols, widths, tX, tY, hH);

  rows.forEach((row, ri) => {
    const y  = tY + hH + ri * rH;
    const bg = ri % 2 === 0 ? C.white : C.lgred;

    slide.addShape(pptx.ShapeType.rect, {
      x: tX, y, w: 0.06, h: rH,
      fill: { color: C.red }, line: { type: 'none' },
    });

    const storeLbl = (row.storeNum ? row.storeNum + ' ' : '') + (row.store || '—');
    const isCrit   = String(row.primaryIssue || '').toUpperCase().includes('CRITICAL');
    const vals     = [
      storeLbl,
      row.ac || row.dm || '—',
      row.netSales || '—',
      row.ebitdaDollars || '—',
      row.ebitdaPct || '—',
      row.cogsPct || '—',
      row.laborPct || '—',
      row.primaryIssue || '—',
    ];

    let cx = tX;
    vals.forEach((val, ci) => {
      slide.addShape(pptx.ShapeType.rect, {
        x: cx, y, w: widths[ci], h: rH,
        fill: { color: bg }, line: { color: C.lgray, width: 0.75 },
      });
      slide.addText(val, {
        x: cx + 0.08, y: y + 0.06, w: widths[ci] - 0.12, h: rH - 0.1,
        color: (ci === 3 || ci === 4 || (ci === 7 && isCrit)) ? C.red : C.dk,
        fontSize: ci === 0 ? 9.5 : (ci === 7 ? 9 : 11),
        bold: ci === 3 || ci === 4 || (ci === 7 && isCrit),
        align: (ci === 0 || ci === 1 || ci === 7) ? 'left' : 'center',
        valign: 'middle', wrap: true,
      });
      cx += widths[ci];
    });
  });

  if (data.losingStoresNote) {
    const noteY = tY + hH + rows.length * rH + 0.12;
    slide.addText(data.losingStoresNote, {
      x: tX, y: noteY, w: 12.89, h: 0.35,
      color: C.red, fontSize: 9.5, italic: true, bold: true,
    });
  }

  foot(slide, footLabel);
}

// ─── Slide 6: Turnarounds ──────────────────────────────────────────────────
function s6Turnarounds(pptx, data, period, footLabel) {
  const slide = pptx.addSlide();
  slide.background = { color: C.light };
  navyHeader(pptx, slide, `Biggest EBITDA Turnarounds — ${period} vs Prior Year`);

  const t       = data.turnarounds || {};
  const gainers = t.gainers  || [];
  const declines= t.declines || [];

  const lX = 0.22, rX = 6.82, pW = 6.3, pY = 0.82, rH = 0.46;
  const gCols = ['Store', 'DM', 'EBITDA PY', 'EBITDA P3', 'Change $'];
  const gW    = [1.9, 0.8, 1.15, 1.15, 1.3];
  const dCols = ['Store', 'DM', 'EBITDA PY', 'EBITDA P3', 'Change $'];
  const dW    = [1.9, 0.8, 1.15, 1.15, 1.3];

  // Panel headers
  slide.addShape(pptx.ShapeType.rect, {
    x: lX, y: pY, w: pW, h: 0.38,
    fill: { color: C.green }, line: { type: 'none' },
  });
  slide.addText('Biggest Gainers', {
    x: lX + 0.12, y: pY + 0.05, w: pW - 0.2, h: 0.28,
    color: C.white, fontSize: 11, bold: true, fontFace: 'Arial Black',
  });

  slide.addShape(pptx.ShapeType.rect, {
    x: rX, y: pY, w: pW, h: 0.38,
    fill: { color: C.red }, line: { type: 'none' },
  });
  slide.addText('Biggest Declines', {
    x: rX + 0.12, y: pY + 0.05, w: pW - 0.2, h: 0.28,
    color: C.white, fontSize: 11, bold: true, fontFace: 'Arial Black',
  });

  const subY = pY + 0.38;
  miniHdr(pptx, slide, gCols, gW, lX, subY);
  miniHdr(pptx, slide, dCols, dW, rX, subY);

  const dataY = subY + 0.32;

  gainers.forEach((row, ri) => {
    const y  = dataY + ri * rH;
    const bg = ri % 2 === 0 ? C.white : C.light;
    const vals = [
      (row.storeNum ? row.storeNum + ' ' : '') + (row.store || '—'),
      row.ac || '—', row.ebitdaPY || '—', row.ebitdaP3 || '—', row.change || '—',
    ];
    let cx = lX;
    vals.forEach((val, ci) => {
      slide.addShape(pptx.ShapeType.rect, {
        x: cx, y, w: gW[ci], h: rH,
        fill: { color: bg }, line: { color: C.lgray, width: 0.75 },
      });
      slide.addText(val, {
        x: cx + 0.07, y: y + 0.07, w: gW[ci] - 0.1, h: rH - 0.1,
        color: ci === 4 ? C.green : C.dk,
        fontSize: 10, bold: ci === 4,
        align: ci <= 1 ? 'left' : 'center', valign: 'middle',
      });
      cx += gW[ci];
    });
  });

  declines.forEach((row, ri) => {
    const y  = dataY + ri * rH;
    const bg = ri % 2 === 0 ? C.white : C.light;
    const vals = [
      (row.storeNum ? row.storeNum + ' ' : '') + (row.store || '—'),
      row.ac || '—', row.ebitdaPY || '—', row.ebitdaP3 || '—', row.change || '—',
    ];
    let cx = rX;
    vals.forEach((val, ci) => {
      slide.addShape(pptx.ShapeType.rect, {
        x: cx, y, w: dW[ci], h: rH,
        fill: { color: bg }, line: { color: C.lgray, width: 0.75 },
      });
      slide.addText(val, {
        x: cx + 0.07, y: y + 0.07, w: dW[ci] - 0.1, h: rH - 0.1,
        color: ci === 4 ? C.red : C.dk,
        fontSize: 10, bold: ci === 4,
        align: ci <= 1 ? 'left' : 'center', valign: 'middle',
      });
      cx += dW[ci];
    });
  });

  if (t.footerNote) {
    slide.addText(`Note: ${t.footerNote}`, {
      x: lX, y: 6.98, w: 12.89, h: 0.26,
      color: C.red, fontSize: 8.5, italic: true,
    });
  }

  foot(slide, footLabel);
}

// ─── Slide 7: Peter Framework ──────────────────────────────────────────────

const DEFAULT_PETER = [
  { number: '1', title: 'Start with EBITDA %',               body: 'Green = above 15%. Yellow = 8-15%. Red = below 8%. Negative = actively losing money.' },
  { number: '2', title: 'Check BPS vs Prior Year',           body: '100 bps = 1%. Positive = improving. Negative = eroding. Sales growth + shrinking margin = still in trouble.' },
  { number: '3', title: 'Labor % is your first red flag',    body: 'Target 28-32%. Above 35% = overstaffed or undersold. Above 40% = structural problem, not a scheduling problem.' },
  { number: '4', title: 'Flow Through - did growth convert?',body: 'EBITDA change divided by Sales change. 100%+ = excellent leverage. Negative = costs outran sales.' },
  { number: '5', title: 'COGS % - control what you can',     body: 'Target 26-28%. High COGS = waste, portioning, or theft. COGS + high labor = double jeopardy.' },
  { number: '6', title: 'The pattern tells the story',       body: 'One bad metric = fixable. Two = coaching conversation. Three = PIP conversation.' },
];

function s7PeterFramework(pptx, data, period, footLabel) {
  const slide = pptx.addSlide();
  slide.background = { color: C.light };
  navyHeader(pptx, slide, 'How to Read a P&L - The Peter Framework');
  const items = (data.peterFramework && data.peterFramework.length > 0) ? data.peterFramework : DEFAULT_PETER;
  const cW = 4.1, cH = 2.56, startX = 0.22, startY = 0.82, gX = 0.17, gY = 0.18;
  items.slice(0, 6).forEach((item, i) => {
    const col = i % 3, row = Math.floor(i / 3);
    const x = startX + col * (cW + gX), y = startY + row * (cH + gY);
    slide.addShape(pptx.ShapeType.rect, { x, y, w: cW, h: cH, fill: { color: C.white }, line: { color: C.border, width: 1 } });
    slide.addShape(pptx.ShapeType.rect, { x, y, w: 0.44, h: 0.44, fill: { color: C.navy }, line: { type: 'none' } });
    slide.addText(String(item.number || i + 1), { x, y, w: 0.44, h: 0.44, color: C.gold, fontSize: 17, bold: true, fontFace: 'Arial Black', align: 'center', valign: 'middle' });
    slide.addText(item.title || '', { x: x + 0.52, y: y + 0.07, w: cW - 0.62, h: 0.44, color: C.navy, fontSize: 11, bold: true });
    slide.addText(item.body || '', { x: x + 0.14, y: y + 0.57, w: cW - 0.26, h: cH - 0.67, color: C.dk, fontSize: 10, valign: 'top', wrap: true, lineSpacingMultiple: 1.4 });
  });
  foot(slide, footLabel);
}

// ─── 8-Slide Functions (new JSON format) ───────────────────────────────────

function s1Title(pptx, data, period, region, footLabel, options = {}) {
  const slide = pptx.addSlide();
  slide.background = { color: C.navy };
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.22, h: 7.5, fill: { color: C.gold }, line: { type: 'none' } });
  slide.addText((region.company || 'Ayvaz Pizza LLC').toUpperCase(), { x: 0.45, y: 0.5, w: 12.6, h: 0.52, color: C.gold, fontSize: 13, bold: true, charSpacing: 3 });
  const titleText = `${period} · Preliminary · ${region.name || 'Region'} · ${region.director || ''}`;
  slide.addText(titleText.toUpperCase(), { x: 0.45, y: 1.1, w: 12.6, h: 1.0, color: C.white, fontSize: 24, bold: true, fontFace: 'Arial Black', valign: 'middle' });
  slide.addText('AREA COACH P&L REVIEW', { x: 0.45, y: 2.1, w: 12.6, h: 0.4, color: C.gray, fontSize: 11, charSpacing: 2 });
  slide.addShape(pptx.ShapeType.rect, { x: 0.45, y: 2.58, w: 10.0, h: 0.04, fill: { color: C.gold }, line: { type: 'none' } });
  const acs = data.areaCoaches || [];
  const cW = 3.8, cH = 0.76, gX = 0.25, gY = 0.22;
  acs.slice(0, 6).forEach((ac, i) => {
    const col = i % 3, row = Math.floor(i / 3);
    const x = 0.45 + col * (cW + gX), y = 2.88 + row * (cH + gY);
    slide.addShape(pptx.ShapeType.rect, { x, y, w: cW, h: cH, fill: { color: '1A2050' }, line: { color: C.gold, width: 1 } });
    slide.addShape(pptx.ShapeType.rect, { x, y, w: 0.08, h: cH, fill: { color: C.gold }, line: { type: 'none' } });
    slide.addText('AREA COACH', { x: x + 0.18, y: y + 0.1, w: cW - 0.22, h: 0.22, color: C.gray, fontSize: 7.5, bold: true, charSpacing: 1.5 });
    slide.addText(ac, { x: x + 0.18, y: y + 0.3, w: cW - 0.22, h: 0.38, color: C.white, fontSize: 14, bold: true });
  });
  slide.addText(footLabel, { x: 0.45, y: 7.25, w: 12.6, h: 0.2, color: C.gray, fontSize: 7.5, charSpacing: 1 });
  if (options.logoBase64) {
    try { slide.addImage({ data: options.logoBase64, x: 10.5, y: 6.5, w: 2.5, h: 0.75 }); } catch (_) {}
  }
}

function s2RegionHeadline(pptx, data, period, footLabel) {
  const slide = pptx.addSlide();
  slide.background = { color: C.light };
  navyHeader(pptx, slide, `${period} · REGION HEADLINE`);
  const s2 = data.slide2 || {};
  const metrics = s2.metrics || [];
  const narrative = s2.narrative || [];
  const cW = 2.9, cH = 1.3, cY = 0.82, startX = 0.22, gap = 0.22;
  metrics.slice(0, 4).forEach((m, i) => {
    const x = startX + i * (cW + gap);
    const trendGood = m.trend === 'up';
    slide.addShape(pptx.ShapeType.rect, { x, y: cY, w: cW, h: cH, fill: { color: C.white }, line: { color: C.border, width: 1 } });
    slide.addShape(pptx.ShapeType.rect, { x, y: cY, w: cW, h: 0.06, fill: { color: C.navy }, line: { type: 'none' } });
    slide.addText((m.label || '').toUpperCase(), { x: x + 0.12, y: cY + 0.1, w: cW - 0.2, h: 0.22, color: C.gray, fontSize: 7, bold: true, charSpacing: 1 });
    slide.addText(m.value || '—', { x: x + 0.1, y: cY + 0.3, w: cW - 0.18, h: 0.6, color: C.navy, fontSize: 24, bold: true, fontFace: 'Arial Black' });
    if (m.vsPY) {
      slide.addShape(pptx.ShapeType.rect, { x, y: cY + cH - 0.32, w: cW, h: 0.32, fill: { color: trendGood ? C.green : C.red }, line: { type: 'none' } });
      slide.addText(m.vsPY, { x: x + 0.1, y: cY + cH - 0.28, w: cW - 0.15, h: 0.24, color: C.white, fontSize: 8.5, bold: true, valign: 'middle' });
    }
  });
  const bY = cY + cH + 0.22, bH = 7.22 - bY - 0.3;
  slide.addShape(pptx.ShapeType.rect, { x: 0.22, y: bY, w: 12.89, h: bH, fill: { color: C.white }, line: { color: C.border, width: 1 } });
  slide.addShape(pptx.ShapeType.rect, { x: 0.22, y: bY, w: 12.89, h: 0.34, fill: { color: C.navy }, line: { type: 'none' } });
  slide.addText('REGIONAL DIRECTOR READ', { x: 0.38, y: bY + 0.06, w: 8, h: 0.24, color: C.white, fontSize: 8.5, bold: true, charSpacing: 1.5 });
  const rowH = (bH - 0.48) / 5;
  narrative.slice(0, 5).forEach((bullet, bi) => {
    const by = bY + 0.44 + bi * rowH;
    slide.addShape(pptx.ShapeType.rect, { x: 0.36, y: by + 0.08, w: 0.1, h: 0.1, fill: { color: C.gold }, line: { type: 'none' } });
    slide.addText(bullet, { x: 0.56, y: by, w: 12.3, h: rowH, color: C.dk, fontSize: 11, wrap: true, valign: 'middle' });
  });
  foot(slide, footLabel);
}

function s3VarianceBridge(pptx, data, period, footLabel) {
  const slide = pptx.addSlide();
  slide.background = { color: C.light };
  navyHeader(pptx, slide, `${period} · WHERE DID THE EBITDA GO? — VARIANCE BRIDGE`);
  const bridge = (data.slide3 || {}).bridge || [];
  const cols = ['Driver', 'Variance $', 'BPS Impact', 'Explanation — What Caused It'];
  const widths = [2.4, 1.4, 1.1, 8.0];
  const tX = 0.22, tY = 0.78, rH = 0.5;
  tblHdr(pptx, slide, cols, widths, tX, tY, 0.36);
  bridge.forEach((row, ri) => {
    const y = tY + 0.36 + ri * rH;
    const isGood = row.direction === 'tailwind';
    const rowBg = isGood ? 'F0FBF6' : 'FFF5F5';
    const accentColor = isGood ? C.green : C.red;
    let cx = tX;
    slide.addShape(pptx.ShapeType.rect, { x: cx, y, w: 0.06, h: rH, fill: { color: accentColor }, line: { type: 'none' } });
    [row.driver || '—', row.varianceDollars || '—', row.bpsImpact || '—', row.explanation || ''].forEach((val, ci) => {
      slide.addShape(pptx.ShapeType.rect, { x: cx, y, w: widths[ci], h: rH, fill: { color: ci === 0 ? C.white : rowBg }, line: { color: C.border, width: 0.5 } });
      const textColor = ci <= 2 ? (isGood ? C.green : C.red) : C.dk;
      slide.addText(val, { x: cx + 0.1, y: y + 0.05, w: widths[ci] - 0.16, h: rH - 0.08, color: ci === 0 ? C.navy : textColor, fontSize: ci === 3 ? 9.5 : (ci === 0 ? 10.5 : 12), bold: ci <= 2, align: ci === 0 || ci === 3 ? 'left' : 'center', valign: 'middle', wrap: true });
      cx += widths[ci];
    });
    slide.addText(isGood ? '▲ TAILWIND' : '▼ HEADWIND', { x: tX + 0.08, y: y + rH - 0.2, w: 1.5, h: 0.18, color: accentColor, fontSize: 6.5, bold: true });
  });
  foot(slide, footLabel);
}

function s4ACScorecard(pptx, data, period, footLabel) {
  const slide = pptx.addSlide();
  slide.background = { color: C.light };
  navyHeader(pptx, slide, `${period} · AREA COACH SCORECARD — SORTED BY EBITDA %`);
  const s4 = data.slide4 || {};
  const rows = s4.rows || [];
  const total = s4.territoryTotal || null;
  const cols = ['Area Coach', 'Stores', 'Net Sales', 'EBITDA $', 'EBITDA %', 'vs PY (bps)', 'Dir Labor %', 'DL vs PY', 'Neg Stores'];
  const widths = [2.6, 0.65, 1.3, 1.3, 1.1, 1.1, 1.1, 1.0, 0.9];
  const tX = 0.22, tY = 0.78, rH = 0.52;
  tblHdr(pptx, slide, cols, widths, tX, tY, 0.36);
  rows.forEach((row, ri) => {
    const y = tY + 0.36 + ri * rH;
    const bg = ri % 2 === 0 ? C.white : C.lgray;
    const ep = parseFloat(String(row.ebitdaPct || '0').replace('%', ''));
    const tc = tierColor(row.tier);
    let cx = tX;
    slide.addShape(pptx.ShapeType.rect, { x: cx, y, w: 0.07, h: rH, fill: { color: tc }, line: { type: 'none' } });
    [row.ac || '—', String(row.stores || '—'), row.netSales || '—', row.ebitdaDollars || '—', row.ebitdaPct || '—', row.vsPYBps || '—', row.dirLaborPct || '—', row.dlVsPYBps || '—', String(row.negStores ?? '—')].forEach((val, ci) => {
      slide.addShape(pptx.ShapeType.rect, { x: cx, y, w: widths[ci], h: rH, fill: { color: bg }, line: { color: C.border, width: 0.5 } });
      let color = C.dk;
      if (ci === 4) color = ep < 0 ? C.red : ep >= 15 ? C.green : C.amber;
      if (ci === 5) color = bpsColor(val, false);
      if (ci === 7) color = bpsColor(val, true);
      if (ci === 8 && parseInt(val) > 0) color = C.red;
      slide.addText(val, { x: cx + 0.08, y: y + 0.06, w: widths[ci] - 0.12, h: rH - 0.1, color, fontSize: ci === 0 ? 10 : 9.5, bold: ci === 4, align: ci === 0 ? 'left' : 'center', valign: 'middle' });
      cx += widths[ci];
    });
  });
  if (total) {
    const y = tY + 0.36 + rows.length * rH;
    let cx = tX;
    slide.addShape(pptx.ShapeType.rect, { x: cx, y, w: widths.reduce((a, b) => a + b, 0), h: rH, fill: { color: C.navy }, line: { type: 'none' } });
    ['TERRITORY TOTAL', '', total.netSales || '', total.ebitdaDollars || '', total.ebitdaPct || '', total.vsPYBps || '', total.dirLaborPct || '', total.dlVsPYBps || '', String(total.negStores ?? '')].forEach((val, ci) => {
      slide.addText(val, { x: cx + 0.08, y: y + 0.06, w: widths[ci] - 0.12, h: rH - 0.1, color: C.white, fontSize: ci === 0 ? 10 : 9.5, bold: true, align: ci === 0 ? 'left' : 'center', valign: 'middle' });
      cx += widths[ci];
    });
  }
  foot(slide, footLabel);
}

function s5ExpenseAnomalies(pptx, data, period, footLabel) {
  const slide = pptx.addSlide();
  slide.background = { color: C.light };
  navyHeader(pptx, slide, `${period} · CONTROLLABLE EXPENSE ANOMALIES`);
  const rows = (data.slide5 || {}).rows || [];
  const cols = ['Category / Line Item', 'P4 $', 'P4 %', 'PY $', 'PY %', 'Var $', 'Var bps', 'District Flag / Note'];
  const widths = [2.7, 1.0, 0.8, 1.0, 0.8, 1.0, 0.85, 4.7];
  const tX = 0.22, tY = 0.78, rH = 0.48;
  tblHdr(pptx, slide, cols, widths, tX, tY, 0.36);
  rows.forEach((row, ri) => {
    const y = tY + 0.36 + ri * rH;
    const bg = ri % 2 === 0 ? C.white : C.lgray;
    const flagColor = row.flagColor === 'red' ? C.red : row.flagColor === 'green' ? C.green : C.amber;
    let cx = tX;
    slide.addShape(pptx.ShapeType.rect, { x: cx, y, w: 0.06, h: rH, fill: { color: flagColor }, line: { type: 'none' } });
    [row.category || '—', row.regionCurrentDollars || '—', row.regionCurrentPct || '—', row.pyDollars || '—', row.pyPct || '—', row.varDollars || '—', row.varBps || '—', row.districtFlag || ''].forEach((val, ci) => {
      slide.addShape(pptx.ShapeType.rect, { x: cx, y, w: widths[ci], h: rH, fill: { color: bg }, line: { color: C.border, width: 0.5 } });
      let color = C.dk;
      if (ci === 5 || ci === 6) color = flagColor;
      if (ci === 7) color = C.navy;
      slide.addText(val, { x: cx + 0.08, y: y + 0.05, w: widths[ci] - 0.12, h: rH - 0.08, color, fontSize: ci === 7 ? 8.5 : 9, bold: ci === 0, align: ci === 0 || ci === 7 ? 'left' : 'center', valign: 'middle', wrap: ci === 7 });
      cx += widths[ci];
    });
  });
  foot(slide, footLabel);
}

function s6InvestigationCards(pptx, data, period, footLabel) {
  const slide = pptx.addSlide();
  slide.background = { color: C.light };
  navyHeader(pptx, slide, `${period} · ANOMALIES REQUIRING INVESTIGATION`);
  const cards = (data.slide6 || {}).cards || [];
  const cW = 6.3, cH = 1.92, gX = 0.22, gY = 0.18, startX = 0.22, startY = 0.82;
  cards.slice(0, 6).forEach((card, i) => {
    const x = startX + (i % 2) * (cW + gX), y = startY + Math.floor(i / 2) * (cH + gY);
    const sc = severityColor(card.severity);
    slide.addShape(pptx.ShapeType.rect, { x, y, w: cW, h: cH, fill: { color: C.white }, line: { color: C.border, width: 1 } });
    slide.addShape(pptx.ShapeType.rect, { x, y, w: cW, h: 0.38, fill: { color: sc }, line: { type: 'none' } });
    slide.addText((card.severity || 'Watch').toUpperCase(), { x: x + 0.12, y: y + 0.06, w: 1.2, h: 0.26, color: C.white, fontSize: 7, bold: true, charSpacing: 1.5 });
    slide.addText(card.title || '', { x: x + 1.35, y: y + 0.06, w: cW - 1.5, h: 0.26, color: C.white, fontSize: 10, bold: true, valign: 'middle' });
    slide.addText(card.analysis || '', { x: x + 0.14, y: y + 0.44, w: cW - 0.24, h: cH - 0.5, color: C.dk, fontSize: 9.5, wrap: true, valign: 'top', lineSpacingMultiple: 1.35 });
  });
  foot(slide, footLabel);
}

function s7ACDeepDive(pptx, data, period, footLabel) {
  const slide = pptx.addSlide();
  slide.background = { color: C.light };
  navyHeader(pptx, slide, `${period} · AREA COACH DEEP DIVE`);
  const cards = (data.slide7 || {}).cards || [];
  const cW = 6.3, cH = 1.92, gX = 0.22, gY = 0.18, startX = 0.22, startY = 0.82;
  cards.slice(0, 6).forEach((card, i) => {
    const x = startX + (i % 2) * (cW + gX), y = startY + Math.floor(i / 2) * (cH + gY);
    const tc = tierColor(card.tier);
    slide.addShape(pptx.ShapeType.rect, { x, y, w: cW, h: cH, fill: { color: C.white }, line: { color: C.border, width: 1 } });
    slide.addShape(pptx.ShapeType.rect, { x, y, w: cW, h: 0.42, fill: { color: C.navy }, line: { type: 'none' } });
    slide.addShape(pptx.ShapeType.rect, { x, y, w: 0.08, h: cH, fill: { color: tc }, line: { type: 'none' } });
    slide.addText(card.acName || '', { x: x + 0.16, y: y + 0.06, w: cW * 0.55, h: 0.3, color: C.white, fontSize: 11, bold: true });
    slide.addText(card.ebitdaPct || '', { x: x + cW * 0.58, y: y + 0.05, w: 1.1, h: 0.3, color: C.gold, fontSize: 14, bold: true, fontFace: 'Arial Black', align: 'right' });
    const bpsGood = !(card.bpsVsPY || '').startsWith('-');
    slide.addText((card.bpsVsPY || '') + ' bps', { x: x + cW * 0.58 + 1.1, y: y + 0.08, w: 1.3, h: 0.26, color: bpsGood ? '90EEC0' : 'FFAAAA', fontSize: 9, bold: true });
    slide.addShape(pptx.ShapeType.rect, { x: x + 0.16, y: y + 0.52, w: 0.18, h: 0.18, fill: { color: C.green }, line: { type: 'none' } });
    slide.addText('▲', { x: x + 0.16, y: y + 0.5, w: 0.18, h: 0.2, color: C.white, fontSize: 7, align: 'center', valign: 'middle' });
    slide.addText(card.win || '', { x: x + 0.42, y: y + 0.5, w: cW - 0.55, h: 0.56, color: C.dk, fontSize: 9.5, wrap: true, valign: 'top', lineSpacingMultiple: 1.3 });
    slide.addShape(pptx.ShapeType.rect, { x: x + 0.16, y: y + 1.14, w: 0.18, h: 0.18, fill: { color: C.red }, line: { type: 'none' } });
    slide.addText('▼', { x: x + 0.16, y: y + 1.12, w: 0.18, h: 0.2, color: C.white, fontSize: 7, align: 'center', valign: 'middle' });
    slide.addText(card.flag || '', { x: x + 0.42, y: y + 1.12, w: cW - 0.55, h: 0.7, color: C.dk, fontSize: 9.5, wrap: true, valign: 'top', lineSpacingMultiple: 1.3 });
  });
  foot(slide, footLabel);
}

function s8Takeaways(pptx, data, period, footLabel) {
  const slide = pptx.addSlide();
  slide.background = { color: C.light };
  navyHeader(pptx, slide, `${period} · TAKEAWAYS & REGIONAL PRIORITIES`);
  const s8 = data.slide8 || {};
  const working = s8.whatsWorking || [];
  const priorities = s8.priorities || [];
  const lX = 0.22, colW = 6.2, startY = 0.84, cH = 1.42, gap = 0.2;
  const urgencyColor = { red: C.red, amber: C.amber, green: C.green };
  slide.addShape(pptx.ShapeType.rect, { x: lX, y: startY, w: colW, h: 0.34, fill: { color: C.green }, line: { type: 'none' } });
  slide.addText("WHAT'S WORKING", { x: lX + 0.14, y: startY + 0.04, w: colW - 0.2, h: 0.26, color: C.white, fontSize: 9, bold: true, charSpacing: 1.5 });
  working.slice(0, 4).forEach((item, i) => {
    const y = startY + 0.34 + i * (cH + gap);
    slide.addShape(pptx.ShapeType.rect, { x: lX, y, w: colW, h: cH, fill: { color: C.white }, line: { color: C.border, width: 1 } });
    slide.addShape(pptx.ShapeType.rect, { x: lX, y, w: colW, h: 0.06, fill: { color: C.green }, line: { type: 'none' } });
    slide.addText(item.title || '', { x: lX + 0.14, y: y + 0.1, w: colW - 0.22, h: 0.28, color: C.navy, fontSize: 10, bold: true });
    slide.addText(item.detail || '', { x: lX + 0.14, y: y + 0.42, w: colW - 0.22, h: cH - 0.5, color: C.dk, fontSize: 9.5, wrap: true, valign: 'top', lineSpacingMultiple: 1.35 });
  });
  const rX = lX + colW + 0.28;
  slide.addShape(pptx.ShapeType.rect, { x: rX, y: startY, w: colW, h: 0.34, fill: { color: C.red }, line: { type: 'none' } });
  slide.addText('REGIONAL PRIORITIES — NOW', { x: rX + 0.14, y: startY + 0.04, w: colW - 0.2, h: 0.26, color: C.white, fontSize: 9, bold: true, charSpacing: 1.5 });
  priorities.slice(0, 4).forEach((item, i) => {
    const y = startY + 0.34 + i * (cH + gap);
    const uc = urgencyColor[item.urgency] || C.amber;
    slide.addShape(pptx.ShapeType.rect, { x: rX, y, w: colW, h: cH, fill: { color: C.white }, line: { color: C.border, width: 1 } });
    slide.addShape(pptx.ShapeType.rect, { x: rX, y, w: 0.5, h: cH, fill: { color: uc }, line: { type: 'none' } });
    slide.addText(String(item.number || i + 1), { x: rX, y, w: 0.5, h: cH, color: C.white, fontSize: 18, bold: true, fontFace: 'Arial Black', align: 'center', valign: 'middle' });
    slide.addText(item.title || '', { x: rX + 0.6, y: y + 0.08, w: colW - 0.68, h: 0.3, color: uc, fontSize: 10.5, bold: true });
    slide.addText(item.detail || '', { x: rX + 0.6, y: y + 0.42, w: colW - 0.68, h: cH - 0.5, color: C.dk, fontSize: 9.5, wrap: true, valign: 'top', lineSpacingMultiple: 1.35 });
  });
  foot(slide, footLabel);
}

// ─── Additional slide renderer (type: table | bullets | twoColumn) ────────
function sAdditionalSlide(pptx, sd, period, footLabel) {
  const slide = pptx.addSlide();
  slide.background = { color: C.light };
  navyHeader(pptx, slide, sd.title || 'Additional Analysis');
  const type = (sd.type || 'bullets').toLowerCase();

  if (type === 'table') {
    const rows = sd.rows || [];
    const cols = sd.columns || (rows[0] ? Object.keys(rows[0]) : []);
    if (cols.length) {
      const w = cols.map(() => 12.89 / cols.length);
      tblHdr(pptx, slide, cols, w, 0.22, 0.78, 0.36);
      rows.forEach((row, ri) => {
        const y = 0.78 + 0.36 + ri * 0.46;
        const bg = ri % 2 === 0 ? C.white : C.lgray;
        let cx = 0.22;
        cols.forEach((col, ci) => {
          slide.addShape(pptx.ShapeType.rect, { x: cx, y, w: w[ci], h: 0.46, fill: { color: bg }, line: { color: C.border, width: 0.5 } });
          slide.addText(String(row[col] ?? ''), { x: cx + 0.08, y: y + 0.06, w: w[ci] - 0.14, h: 0.34, color: C.dk, fontSize: 10, align: ci === 0 ? 'left' : 'center', valign: 'middle' });
          cx += w[ci];
        });
      });
    }
  } else if (type === 'twocolumn' || type === 'two_column') {
    const left = sd.left || {}, right = sd.right || {};
    [[left, 0.22, 6.2], [right, 6.86, 6.25]].forEach(([panel, px, pw]) => {
      slide.addShape(pptx.ShapeType.rect, { x: px, y: 0.78, w: pw, h: 0.34, fill: { color: C.navy }, line: { type: 'none' } });
      slide.addText(panel.title || '', { x: px + 0.1, y: 0.82, w: pw - 0.14, h: 0.26, color: C.white, fontSize: 9, bold: true, charSpacing: 1 });
      (panel.items || []).forEach((item, i) => {
        const y = 1.2 + i * 0.52;
        slide.addShape(pptx.ShapeType.rect, { x: px, y, w: pw, h: 0.52, fill: { color: i % 2 === 0 ? C.white : C.lgray }, line: { color: C.border, width: 0.5 } });
        slide.addText(typeof item === 'string' ? item : (item.text || ''), { x: px + 0.1, y: y + 0.06, w: pw - 0.18, h: 0.4, color: C.dk, fontSize: 10, wrap: true, valign: 'middle' });
      });
    });
  } else {
    (sd.items || []).forEach((item, i) => {
      const y = 0.88 + i * 0.56;
      slide.addShape(pptx.ShapeType.rect, { x: 0.22, y, w: 12.89, h: 0.56, fill: { color: i % 2 === 0 ? C.white : C.lgray }, line: { color: C.border, width: 0.5 } });
      slide.addShape(pptx.ShapeType.rect, { x: 0.3, y: y + 0.2, w: 0.1, h: 0.1, fill: { color: C.gold }, line: { type: 'none' } });
      slide.addText(typeof item === 'string' ? item : (item.text || JSON.stringify(item)), { x: 0.5, y: y + 0.04, w: 12.4, h: 0.48, color: C.dk, fontSize: 11, wrap: true, valign: 'middle' });
    });
  }
  foot(slide, footLabel);
}

// ─── Store-level deck (5 slides) ──────────────────────────────────────────
function buildStoreDeck(pptx, data, options = {}) {
  const period   = data.period || 'P&L Analysis';
  const region   = data.region || {};
  const store    = data.storeName || 'Store';
  const storeNum = data.storeNum || '';
  const acName   = data.acName || '';
  const footLbl  = `${period} · ${store} · Preliminary · ${region.company || 'Ayvaz Pizza LLC'}`;

  // Slide 1: Cover
  const s1 = pptx.addSlide();
  s1.background = { color: C.navy };
  s1.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.22, h: 7.5, fill: { color: C.gold }, line: { type: 'none' } });
  s1.addText((region.company || 'AYVAZ PIZZA LLC').toUpperCase(), { x: 0.45, y: 0.5, w: 12.6, h: 0.4, color: C.gold, fontSize: 11, bold: true, charSpacing: 3 });
  s1.addText(`${storeNum ? storeNum + ' · ' : ''}${store}`.toUpperCase(), { x: 0.45, y: 1.05, w: 12.6, h: 0.85, color: C.white, fontSize: 28, bold: true, fontFace: 'Arial Black' });
  s1.addText(`${period} P&L ANALYSIS`, { x: 0.45, y: 2.0, w: 12.6, h: 0.38, color: C.gray, fontSize: 12, charSpacing: 2 });
  s1.addShape(pptx.ShapeType.rect, { x: 0.45, y: 2.46, w: 8.0, h: 0.04, fill: { color: C.gold }, line: { type: 'none' } });
  if (acName) s1.addText(`Area Coach: ${acName}`, { x: 0.45, y: 2.68, w: 12.6, h: 0.3, color: C.lgray, fontSize: 11 });
  const h = data.headline || {};
  const sStat = h.storeStatus || 'amber';
  const sColor = sStat === 'green' ? C.green : sStat === 'red' ? C.red : C.amber;
  const sLabel = sStat === 'green' ? 'PROFITABLE' : sStat === 'red' ? 'EBITDA NEGATIVE' : 'WATCH';
  s1.addShape(pptx.ShapeType.rect, { x: 0.45, y: 3.1, w: 2.8, h: 0.52, fill: { color: sColor }, line: { type: 'none' } });
  s1.addText(sLabel, { x: 0.45, y: 3.1, w: 2.8, h: 0.52, color: C.white, fontSize: 13, bold: true, fontFace: 'Arial Black', align: 'center', valign: 'middle' });
  if (options.logoBase64) { try { s1.addImage({ data: options.logoBase64, x: 10.4, y: 6.5, w: 2.5, h: 0.75 }); } catch (_) {} }
  s1.addText(footLbl, { x: 0.45, y: 7.25, w: 12.6, h: 0.2, color: C.gray, fontSize: 7.5, charSpacing: 1 });

  // Slide 2: KPI Headline
  const s2 = pptx.addSlide();
  s2.background = { color: C.light };
  navyHeader(pptx, s2, `${store} — ${period} KEY METRICS`);
  const kpis = [
    { label: 'Net Sales',        value: h.netSales  || '—', sub: h.netSalesVsPY || '' },
    { label: 'EBITDA $',         value: h.ebitda    || '—', sub: h.ebitdaVsPY   || '' },
    { label: 'EBITDA %',         value: h.ebitdaPct || '—', sub: '' },
    { label: 'Direct Labor %',   value: h.laborPct  || '—', sub: h.laborVsPY    || '' },
    { label: 'Cost of Sales %',  value: h.cogsPct   || '—', sub: h.cogsVsPY     || '' },
  ];
  const kW = 2.38, kH = 1.55, kY = 0.82, kGap = 0.18;
  kpis.forEach((k, i) => {
    const x = 0.22 + i * (kW + kGap);
    s2.addShape(pptx.ShapeType.rect, { x, y: kY, w: kW, h: kH, fill: { color: C.white }, line: { color: C.border, width: 1 } });
    s2.addShape(pptx.ShapeType.rect, { x, y: kY, w: kW, h: 0.06, fill: { color: C.navy }, line: { type: 'none' } });
    s2.addText(k.label.toUpperCase(), { x: x + 0.1, y: kY + 0.1, w: kW - 0.16, h: 0.22, color: C.gray, fontSize: 7, bold: true, charSpacing: 1 });
    s2.addText(k.value, { x: x + 0.08, y: kY + 0.3, w: kW - 0.14, h: 0.72, color: C.navy, fontSize: 22, bold: true, fontFace: 'Arial Black' });
    if (k.sub) {
      s2.addShape(pptx.ShapeType.rect, { x, y: kY + kH - 0.34, w: kW, h: 0.34, fill: { color: C.navy }, line: { type: 'none' } });
      s2.addText(k.sub, { x: x + 0.08, y: kY + kH - 0.3, w: kW - 0.14, h: 0.26, color: C.white, fontSize: 8, bold: true, valign: 'middle' });
    }
  });
  if (data.glInsights) {
    const gY = kY + kH + 0.18;
    s2.addShape(pptx.ShapeType.rect, { x: 0.22, y: gY, w: 12.89, h: 0.32, fill: { color: C.amber }, line: { type: 'none' } });
    s2.addText('GL CROSS-REFERENCE FINDINGS', { x: 0.32, y: gY + 0.05, w: 12.6, h: 0.22, color: C.white, fontSize: 8, bold: true, charSpacing: 1 });
    s2.addShape(pptx.ShapeType.rect, { x: 0.22, y: gY + 0.32, w: 12.89, h: 7.22 - gY - 0.32 - 0.38, fill: { color: C.white }, line: { color: C.border, width: 1 } });
    s2.addText(String(data.glInsights), { x: 0.34, y: gY + 0.42, w: 12.5, h: 7.22 - gY - 0.82, color: C.dk, fontSize: 10, wrap: true, valign: 'top', lineSpacingMultiple: 1.4 });
  }
  foot(s2, footLbl);

  // Slide 3: P&L Line Items
  const s3 = pptx.addSlide();
  s3.background = { color: C.light };
  navyHeader(pptx, s3, `${store} — P&L DETAIL — ${period}`);
  const plLines = data.plLines || [];
  const plCols = ['Line Item', 'P3 $', 'P3 %', 'PY $', 'PY %', 'Var $', 'Var bps', 'Flag'];
  const plW = [3.1, 1.1, 0.88, 1.1, 0.88, 1.1, 0.9, 2.93];
  const KEY = ['Product Net Sales','Store Level EBITDA','Store Controllable Profit','Total Direct Labor Cost','Cost of Food Sales'];
  tblHdr(pptx, s3, plCols, plW, 0.22, 0.78, 0.34);
  plLines.forEach((row, ri) => {
    const y   = 0.78 + 0.34 + ri * 0.4;
    const bg  = KEY.includes(row.label) ? 'EEF2FA' : ri % 2 === 0 ? C.white : C.lgray;
    const isBold = KEY.includes(row.label);
    const neg = (row.varDollars || '').startsWith('-') || (row.varDollars || '').startsWith('(');
    let cx = 0.22;
    [row.label || '', row.current || '', row.currentPct || '', row.py || '', row.pyPct || '', row.varDollars || '', row.varBps || '', row.flag || ''].forEach((val, ci) => {
      s3.addShape(pptx.ShapeType.rect, { x: cx, y, w: plW[ci], h: 0.4, fill: { color: bg }, line: { color: C.border, width: 0.5 } });
      let color = C.dk;
      if (isBold && ci === 0) color = C.navy;
      if (ci === 5) color = neg ? C.red : C.green;
      if (ci === 6) color = neg ? C.red : C.green;
      if (ci === 7 && val) color = C.red;
      s3.addText(val, { x: cx + 0.06, y: y + 0.04, w: plW[ci] - 0.1, h: 0.32, color, fontSize: ci === 0 ? 8.5 : 9, bold: isBold && ci <= 2, align: ci === 0 ? 'left' : 'center', valign: 'middle', wrap: ci === 7 });
      cx += plW[ci];
    });
  });
  foot(s3, footLbl);

  // Slide 4: Anomalies
  const s4 = pptx.addSlide();
  s4.background = { color: C.light };
  navyHeader(pptx, s4, `${store} — EXPENSE ANOMALIES & FLAGS`);
  const anomalies = data.anomalies || [];
  if (!anomalies.length) {
    s4.addText('No significant anomalies detected this period.', { x: 0.22, y: 2.0, w: 12.89, h: 0.5, color: C.green, fontSize: 15, bold: true, align: 'center' });
  } else {
    const aCols = ['Line Item', 'Current $', 'Prior Year $', 'Severity', 'Coaching Note'];
    const aW    = [2.6, 1.7, 1.7, 1.1, 5.79];
    tblHdr(pptx, s4, aCols, aW, 0.22, 0.78, 0.36);
    anomalies.forEach((row, ri) => {
      const y  = 0.78 + 0.36 + ri * 0.52;
      const sc = severityColor(row.severity);
      const bg = ri % 2 === 0 ? C.white : C.lgray;
      let cx = 0.22;
      s4.addShape(pptx.ShapeType.rect, { x: cx, y, w: 0.06, h: 0.52, fill: { color: sc }, line: { type: 'none' } });
      [row.line || '', row.current || '', row.py || '', row.severity || '', row.note || ''].forEach((val, ci) => {
        s4.addShape(pptx.ShapeType.rect, { x: cx, y, w: aW[ci], h: 0.52, fill: { color: bg }, line: { color: C.border, width: 0.5 } });
        s4.addText(val, { x: cx + 0.08, y: y + 0.06, w: aW[ci] - 0.14, h: 0.4, color: ci === 3 ? sc : C.dk, fontSize: ci === 4 ? 9 : 10, bold: ci === 3, align: ci === 0 || ci === 4 ? 'left' : 'center', valign: 'middle', wrap: true });
        cx += aW[ci];
      });
    });
  }
  foot(s4, footLbl);

  // Slide 5: Coaching Notes
  const s5 = pptx.addSlide();
  s5.background = { color: C.light };
  navyHeader(pptx, s5, `${store} — COACHING PRIORITIES`);
  const notes = data.coachingNotes || [];
  const uc = { red: C.red, amber: C.amber, green: C.green };
  notes.forEach((note, i) => {
    const y  = 0.84 + i * 1.52;
    const nc = uc[note.status] || C.amber;
    s5.addShape(pptx.ShapeType.rect, { x: 0.22, y, w: 12.89, h: 1.42, fill: { color: C.white }, line: { color: C.border, width: 1 } });
    s5.addShape(pptx.ShapeType.rect, { x: 0.22, y, w: 0.5, h: 1.42, fill: { color: nc }, line: { type: 'none' } });
    s5.addText(String(note.priority || i + 1), { x: 0.22, y, w: 0.5, h: 1.42, color: C.white, fontSize: 18, bold: true, fontFace: 'Arial Black', align: 'center', valign: 'middle' });
    s5.addText(note.title || '', { x: 0.82, y: y + 0.1, w: 12.0, h: 0.32, color: nc, fontSize: 12, bold: true });
    s5.addText(note.detail || '', { x: 0.82, y: y + 0.48, w: 12.0, h: 0.86, color: C.dk, fontSize: 10, wrap: true, valign: 'top', lineSpacingMultiple: 1.35 });
  });
  foot(s5, footLbl);
}

async function generateStorePPTX(analysis, options = {}) {
  applyTheme(options.theme || 'default');
  const data = parseAnalysis(analysis);
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'P.AI by Ayvaz Pizza';
  if (data) {
    buildStoreDeck(pptx, data, options);
  } else {
    buildFallbackDeck(pptx, typeof analysis === 'string' ? analysis : JSON.stringify(analysis));
  }
  return pptx.write({ outputType: 'nodebuffer' });
}

function buildFallbackDeck(pptx, analysisText) {
  const cover = pptx.addSlide();
  cover.background = { color: C.navy };
  cover.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.22, h: 7.5, fill: { color: C.gold }, line: { type: 'none' } });
  cover.addText('P&L Analysis', { x: 0.55, y: 1.5, w: 12.4, h: 1.2, color: C.white, fontSize: 48, bold: true, fontFace: 'Arial Black' });
  cover.addText('Ayvaz Pizza LLC - Powered by P.AI', { x: 0.55, y: 3.0, w: 12.4, h: 0.4, color: C.gray, fontSize: 11 });
  const chunkSize = 1200;
  for (let i = 0; i < Math.min(Math.ceil(analysisText.length / chunkSize), 8); i++) {
    const chunk = analysisText.slice(i * chunkSize, (i + 1) * chunkSize);
    const sl = pptx.addSlide();
    navyHeader(pptx, sl, 'Analysis - Part ' + (i + 1));
    sl.addText(chunk, { x: 0.32, y: 0.82, w: 12.7, h: 6.28, color: C.dk, fontSize: 11, valign: 'top', wrap: true });
  }
}

// ─── AC-only deck (Area Coach uploads their own area P&L) ───────────────────────────
async function generateACPPTX(analysis, options = {}) {
  let data = null;

  if (typeof analysis === 'object' && analysis !== null) {
    data = analysis;
  } else if (typeof analysis === 'string') {
    try {
      const m = analysis.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (m) {
        data = JSON.parse(m[1]);
      } else {
        const s = analysis.indexOf('{');
        const e = analysis.lastIndexOf('}');
        if (s !== -1 && e !== -1) data = JSON.parse(analysis.slice(s, e + 1));
      }
    } catch (_) { /* stay null */ }
  }

  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'P.AI by Ayvaz Pizza';

  if (data && (data.acName || data.scorecard)) {
    // Direct acDeepDive object from analyzePLForAC
    buildACDeepDive(pptx, data, C);
  } else {
    buildFallbackDeck(pptx, typeof analysis === 'string' ? analysis : JSON.stringify(analysis));
  }

  return pptx.write({ outputType: 'nodebuffer' });
}

module.exports = { generatePLPPTX, generateStorePPTX, generateACPPTX, generateOnePager };
