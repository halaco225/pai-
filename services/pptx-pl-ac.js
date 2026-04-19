const PptxGenJS = require('pptxgenjs');

// Called by pptx-pl.js — builds 8 deep-dive slides for ONE area coach
// pptx  : PptxGenJS instance
// ac    : acDeepDive object from JSON
// theme : { navy, gold, white, light, dk, green, red, amber, gray, lgray, border, lgred }

function buildACDeepDive(pptx, ac, C) {
  const period = ac.period || 'P3 2026';
  const foot   = `${period} · Preliminary · Ayvaz Pizza LLC`;

  acS1Cover(pptx, ac, C, period);
  acS2Scorecard(pptx, ac, C, period, foot);
  acS3Labor(pptx, ac, C, period, foot);
  acS4COS(pptx, ac, C, period, foot);
  acS5EBITDA(pptx, ac, C, period, foot);
  acS6Anomalies(pptx, ac, C, period, foot);
  acS7Spotlights(pptx, ac, C, period, foot);
  acS8Coaching(pptx, ac, C, period, foot);
}

// ── helpers ──────────────────────────────────────────────────────────────────

function hdr(pptx, slide, title, C) {
  slide.addShape(pptx.ShapeType.rect, { x:0, y:0, w:13.33, h:0.62, fill:{color:C.navy}, line:{type:'none'} });
  slide.addShape(pptx.ShapeType.rect, { x:0, y:0.62, w:13.33, h:0.05, fill:{color:C.gold}, line:{type:'none'} });
  slide.addText(title, { x:0.3, y:0.1, w:12.7, h:0.46, color:C.white, fontSize:13.5, bold:true, fontFace:'Arial Black', valign:'middle' });
}

function footer(slide, label, C) {
  slide.addText(label, { x:0.3, y:7.23, w:12.7, h:0.22, color:C.gray, fontSize:7.5, charSpacing:1 });
}

function calloutBox(pptx, slide, x, y, w, h, text, C, bgColor) {
  const bg = bgColor || C.red;
  slide.addShape(pptx.ShapeType.rect, { x, y, w, h, fill:{color:bg}, line:{type:'none'} });
  slide.addShape(pptx.ShapeType.rect, { x, y, w:0.06, h, fill:{color:C.white}, line:{type:'none'} });
  slide.addText(text, { x:x+0.14, y:y+0.12, w:w-0.22, h:h-0.2, color:C.white, fontSize:9.5, valign:'top', wrap:true, lineSpacingMultiple:1.4 });
}

function statusColor(statusStr, C) {
  const s = (statusStr||'').toLowerCase();
  if (s === 'green') return C.green;
  if (s === 'amber' || s === 'yellow') return C.amber;
  return C.red;
}

// ── Slide A: AC Cover ─────────────────────────────────────────────────────────
function acS1Cover(pptx, ac, C, period) {
  const slide = pptx.addSlide();
  slide.background = { color: C.navy };

  slide.addShape(pptx.ShapeType.rect, { x:0, y:0, w:0.22, h:7.5, fill:{color:C.gold}, line:{type:'none'} });

  slide.addText((ac.acName || 'Area Coach').toUpperCase(), {
    x:0.55, y:0.65, w:12.4, h:1.5,
    color:C.white, fontSize:44, bold:true, fontFace:'Arial Black'
  });

  slide.addText(`Area Deep Dive  |  ${period} Prelim`, {
    x:0.55, y:2.3, w:12.4, h:0.45,
    color:C.gold, fontSize:14, bold:true, charSpacing:1
  });

  slide.addShape(pptx.ShapeType.rect, { x:0.55, y:2.88, w:7, h:0.04, fill:{color:C.gold}, line:{type:'none'} });

  const storeCount = ac.totalStores || (ac.scorecard ? ac.scorecard.length : 0);
  slide.addText(`${storeCount} Stores  |  Ayvaz Pizza LLC  |  SE Atlanta Region`, {
    x:0.55, y:3.08, w:12.4, h:0.35,
    color:C.lgray, fontSize:11
  });

  // Bottom stat bar
  const kpis = ac.coverKPIs || [];
  if (kpis.length > 0) {
    const barY = 5.9, barH = 1.2;
    slide.addShape(pptx.ShapeType.rect, { x:0, y:barY, w:13.33, h:barH, fill:{color:'0D1829'}, line:{type:'none'} });
    const kW = 13.33 / kpis.length;
    kpis.forEach((kpi, i) => {
      const x = i * kW;
      if (i > 0) slide.addShape(pptx.ShapeType.rect, { x, y:barY, w:0.02, h:barH, fill:{color:'2A3A55'}, line:{type:'none'} });
      slide.addText((kpi.value || '—'), {
        x:x+0.12, y:barY+0.12, w:kW-0.18, h:0.55,
        color:C.red, fontSize:22, bold:true, fontFace:'Arial Black', align:'center'
      });
      slide.addText((kpi.label || '').toUpperCase(), {
        x:x+0.12, y:barY+0.7, w:kW-0.18, h:0.3,
        color:'9AADC8', fontSize:7.5, bold:true, charSpacing:0.5, align:'center'
      });
    });
  }
}

// ── Slide B: Area Scorecard ───────────────────────────────────────────────────
function acS2Scorecard(pptx, ac, C, period, footLabel) {
  const slide = pptx.addSlide();
  slide.background = { color: C.light };
  hdr(pptx, slide, `AREA SCORECARD  —  ${period} vs PY`, C);

  const stores = ac.scorecard || [];
  if (stores.length === 0) { footer(slide, footLabel, C); return; }

  const nCols = stores.length;
  const colW  = (13.33 - 0.44) / nCols;
  const startX = 0.22, startY = 0.82;
  const topBarH = 0.18;
  const rows = ['Net Sales', 'COS%', 'Dir Labor%', 'PY Labor%', 'SCP%', 'EBITDA%', 'PY EBITDA%'];
  const rowH = 0.58, labelW = 0;

  stores.forEach((store, ci) => {
    const x = startX + ci * colW;
    const sc = statusColor(store.status, C);

    // Store header card
    slide.addShape(pptx.ShapeType.rect, { x, y:startY, w:colW-0.04, h:topBarH, fill:{color:sc}, line:{type:'none'} });
    slide.addText((store.storeNum ? store.storeNum+'\n' : '') + (store.name || ''), {
      x:x+0.04, y:startY+topBarH, w:colW-0.1, h:0.55,
      color:C.dk, fontSize:8, bold:true, align:'center', valign:'middle',
      fill:{color:C.white}, lineSpacingMultiple:1.2
    });
    slide.addShape(pptx.ShapeType.rect, { x, y:startY+topBarH, w:colW-0.04, h:0.55, fill:{color:C.white}, line:{color:C.lgray, width:0.5} });
    slide.addText((store.storeNum ? store.storeNum+'\n' : '') + (store.name || ''), {
      x:x+0.04, y:startY+topBarH+0.05, w:colW-0.1, h:0.45,
      color:C.dk, fontSize:8.5, bold:true, align:'center', valign:'middle', lineSpacingMultiple:1.2
    });

    const metricVals = [
      store.netSales || '—',
      store.cosPct   || '—',
      store.laborPct || '—',
      store.laborPY  || '—',
      store.scpPct   || '—',
      store.ebitdaPct|| '—',
      store.ebitdaPY || '—',
    ];

    metricVals.forEach((val, ri) => {
      const y = startY + topBarH + 0.55 + ri * rowH;
      const isEBITDA = ri === 5;
      const ep = isEBITDA ? parseFloat(String(val).replace('%','')) : 0;
      const cellBg = ri % 2 === 0 ? C.white : C.light;
      slide.addShape(pptx.ShapeType.rect, { x, y, w:colW-0.04, h:rowH, fill:{color:cellBg}, line:{color:C.lgray, width:0.5} });

      let color = C.dk, bold = false;
      if (isEBITDA) {
        color = ep < 0 ? C.red : (ep >= 10 ? C.green : C.amber);
        bold = true;
      }
      if (ri === 2) { // labor
        const lv = parseFloat(String(val).replace('%',''));
        color = lv > 35 ? C.red : (lv > 30 ? C.amber : C.dk);
      }

      slide.addText(val, {
        x:x+0.04, y:y+0.1, w:colW-0.1, h:rowH-0.14,
        color, fontSize:11, bold, align:'center', valign:'middle'
      });
    });
  });

  // Row labels on far right (or we can do it differently - left side)
  // Actually skip row labels to keep it clean like the reference

  // Sub-label row (Net Sales vs PY) if available
  stores.forEach((store, ci) => {
    const x = startX + ci * colW;
    if (store.netSalesVsPY) {
      const y = startY + topBarH + 0.55;
      // The netSales cell is at y — add vs PY below it
      slide.addText(store.netSalesVsPY, {
        x:x+0.04, y:y+0.3, w:colW-0.1, h:0.22,
        color: (store.netSalesVsPY||'').startsWith('+') ? C.green : C.red,
        fontSize:7.5, align:'center', italic:true
      });
    }
  });

  footer(slide, footLabel, C);
}

// ── Slide C: Labor Deep Dive ──────────────────────────────────────────────────
function acS3Labor(pptx, ac, C, period, footLabel) {
  const slide = pptx.addSlide();
  slide.background = { color: C.light };
  hdr(pptx, slide, `DIRECT LABOR DEEP DIVE  —  ${period} vs PY  |  YTD`, C);

  const lc = ac.laborChart || {};
  const labels  = lc.labels  || [];
  const current = lc.current || [];
  const prior   = lc.prior   || [];

  // Left: clustered bar chart
  if (labels.length > 0) {
    slide.addChart(pptx.ChartType.bar, [
      { name: `${period} Labor %`, labels, values: current },
      { name: 'PY Labor %',        labels, values: prior   }
    ], {
      x:0.22, y:0.82, w:6.6, h:4.0,
      barGrouping: 'clustered',
      chartColors: [C.red, '8899AA'],
      showLegend: true, legendPos: 'b', legendFontSize: 9,
      valAxisMinVal: 0,
      dataLabelFontSize: 8,
      showValue: true,
      catAxisLabelFontSize: 9,
    });
  }

  // Right: comparison table
  const tX = 7.1, tY = 0.82, tW = 5.9;
  const tcols = ['Store', `${period}`, 'PY', '\u0394'];
  const twidths = [1.85, 1.2, 1.2, 1.15];
  let cy = tY;
  const thH = 0.36;

  let cx = tX;
  tcols.forEach((col, i) => {
    slide.addShape(pptx.ShapeType.rect, { x:cx, y:cy, w:twidths[i], h:thH, fill:{color:C.navy}, line:{type:'none'} });
    slide.addText(col.toUpperCase(), { x:cx+0.06, y:cy+0.05, w:twidths[i]-0.08, h:thH-0.08, color:C.white, fontSize:8.5, bold:true, align:i===0?'left':'center', valign:'middle' });
    cx += twidths[i];
  });
  cy += thH;

  labels.forEach((lbl, ri) => {
    const curr = current[ri] !== undefined ? current[ri].toFixed(1)+'%' : '—';
    const pVal = prior[ri]   !== undefined ? prior[ri].toFixed(1)+'%'   : '—';
    const delta = (current[ri] !== undefined && prior[ri] !== undefined)
      ? (current[ri] - prior[ri]).toFixed(1)
      : null;
    const dStr = delta !== null ? (parseFloat(delta) >= 0 ? '\u25b2 '+delta : '\u25bc '+Math.abs(delta)) : '—';
    const dColor = delta !== null && parseFloat(delta) >= 0 ? C.red : C.green;
    const bg = ri % 2 === 0 ? C.white : C.light;
    const rH = 0.42;

    cx = tX;
    [lbl, curr, pVal, dStr].forEach((val, ci) => {
      slide.addShape(pptx.ShapeType.rect, { x:cx, y:cy, w:twidths[ci], h:rH, fill:{color:bg}, line:{color:C.lgray, width:0.5} });
      slide.addText(val, {
        x:cx+0.06, y:cy+0.06, w:twidths[ci]-0.08, h:rH-0.1,
        color: ci===3 ? dColor : C.dk,
        fontSize:10, bold:ci===3,
        align:ci===0?'left':'center', valign:'middle'
      });
      cx += twidths[ci];
    });

    // Red/green indicator dot
    if (delta !== null) {
      slide.addShape(pptx.ShapeType.rect, {
        x:tX, y:cy, w:0.05, h:rH,
        fill:{color: parseFloat(delta) >= 0 ? C.red : C.green}, line:{type:'none'}
      });
    }
    cy += rH;
  });

  // YTD box
  const ytdLines = lc.ytdLines || [];
  if (ytdLines.length > 0) {
    const ytdY = cy + 0.14;
    const ytdH = 7.5 - ytdY - 0.8;
    slide.addShape(pptx.ShapeType.rect, { x:tX, y:ytdY, w:tW, h:ytdH, fill:{color:'EFF3F8'}, line:{color:C.border, width:1} });
    slide.addText('YTD DIRECT LABOR', { x:tX+0.1, y:ytdY+0.06, w:tW-0.2, h:0.24, color:C.navy, fontSize:7.5, bold:true, charSpacing:1 });
    slide.addText(ytdLines.join('\n'), { x:tX+0.1, y:ytdY+0.32, w:tW-0.15, h:ytdH-0.4, color:C.dk, fontSize:8.5, valign:'top', wrap:true, lineSpacingMultiple:1.5 });
  }

  // Insight callout
  if (lc.insight) {
    calloutBox(pptx, slide, 0.22, 5.0, 6.6, 1.08, lc.insight, C, C.red);
  }

  footer(slide, footLabel, C);
}

// ── Slide D: COS Analysis ────────────────────────────────────────────────────
function acS4COS(pptx, ac, C, period, footLabel) {
  const slide = pptx.addSlide();
  slide.background = { color: C.light };
  hdr(pptx, slide, `COST OF SALES  —  ${period} vs PY  |  YTD`, C);

  const cc = ac.cosChart || {};
  const labels  = cc.labels  || [];
  const current = cc.current || [];
  const prior   = cc.prior   || [];

  // Left: clustered bar chart
  if (labels.length > 0) {
    slide.addChart(pptx.ChartType.bar, [
      { name: `${period} COS %`, labels, values: current },
      { name: 'PY COS %',        labels, values: prior   }
    ], {
      x:0.22, y:0.82, w:6.6, h:4.0,
      barGrouping: 'clustered',
      chartColors: [C.red, '8899AA'],
      showLegend: true, legendPos: 'b', legendFontSize: 9,
      valAxisMinVal: 20,
      showValue: true, dataLabelFontSize: 8,
      catAxisLabelFontSize: 9,
    });
  }

  // Right: per-store cards
  const storeCards = cc.storeCards || [];
  let cardY = 0.82;
  const cardH = 0.78, cardW = 5.9, cardX = 7.1;
  const trendUp   = '\u25b2';
  const trendDown = '\u25bc';

  storeCards.forEach((sc, i) => {
    if (i >= 6) return;
    const trend    = (sc.trend||'').toLowerCase() === 'up' ? trendUp : trendDown;
    const tColor   = (sc.trend||'').toLowerCase() === 'up' ? C.red : C.green;
    const bg       = i % 2 === 0 ? C.white : C.light;

    slide.addShape(pptx.ShapeType.rect, { x:cardX, y:cardY, w:cardW, h:cardH, fill:{color:bg}, line:{color:C.lgray, width:0.75} });
    slide.addText(trend, { x:cardX+0.08, y:cardY+0.08, w:0.3, h:cardH-0.12, color:tColor, fontSize:16, bold:true, valign:'middle', align:'center' });
    slide.addText((sc.name||''), { x:cardX+0.42, y:cardY+0.06, w:2.0, h:0.3, color:C.navy, fontSize:10, bold:true });
    slide.addText(`P3: ${sc.p3||'—'}  PY: ${sc.py||'—'}`, { x:cardX+0.42, y:cardY+0.35, w:2.5, h:0.25, color:C.dk, fontSize:9 });
    slide.addText(`YTD: ${sc.ytd||'—'}  PY: ${sc.ytdPY||'—'}`, { x:cardX+0.42, y:cardY+0.56, w:2.5, h:0.2, color:C.gray, fontSize:8.5, italic:true });

    cardY += cardH + 0.04;
  });

  // Insight callout
  if (cc.insight) {
    calloutBox(pptx, slide, 0.22, 5.0, 6.6, 1.08, cc.insight, C, C.red);
  }

  footer(slide, footLabel, C);
}

// ── Slide E: EBITDA & Profitability ───────────────────────────────────────────
function acS5EBITDA(pptx, ac, C, period, footLabel) {
  const slide = pptx.addSlide();
  slide.background = { color: C.light };
  hdr(pptx, slide, `EBITDA & PROFITABILITY  —  ${period} vs PY`, C);

  const ec = ac.ebitdaChart || {};
  const labels  = ec.labels  || [];
  const current = ec.current || [];
  const prior   = ec.prior   || [];

  // Bar chart
  if (labels.length > 0) {
    const barColors = current.map(v => v < 0 ? C.red : C.green);
    slide.addChart(pptx.ChartType.bar, [
      { name: `${period} EBITDA %`, labels, values: current },
      { name: 'PY EBITDA %',        labels, values: prior   }
    ], {
      x:0.22, y:0.82, w:7.5, h:4.2,
      barGrouping: 'clustered',
      chartColors: [C.red, '8899AA'],
      showLegend: true, legendPos: 'b', legendFontSize: 9,
      showValue: true, dataLabelFontSize: 8,
      catAxisLabelFontSize: 9,
    });
  }

  // Right: YTD EBITDA panel
  const ytdItems = ec.ytdItems || [];
  const panX = 7.95, panY = 0.82, panW = 5.1;
  slide.addShape(pptx.ShapeType.rect, { x:panX, y:panY, w:panW, h:0.35, fill:{color:C.navy}, line:{type:'none'} });
  slide.addText('YTD EBITDA', { x:panX+0.1, y:panY+0.06, w:panW-0.2, h:0.25, color:C.white, fontSize:8.5, bold:true, charSpacing:1 });

  let itemY = panY + 0.35;
  const itemH = 0.52;
  ytdItems.forEach((item, i) => {
    const bg = i % 2 === 0 ? C.white : C.light;
    const ep = parseFloat(String(item.ytd||'0').replace('%',''));
    const color = ep < 0 ? C.red : C.green;
    slide.addShape(pptx.ShapeType.rect, { x:panX, y:itemY, w:panW, h:itemH, fill:{color:bg}, line:{color:C.lgray, width:0.5} });
    slide.addText((item.name||''), { x:panX+0.1, y:itemY+0.06, w:2.2, h:itemH-0.1, color:C.dk, fontSize:10, bold:true, valign:'middle' });
    slide.addText(`YTD: ${item.ytd||'—'}`, { x:panX+2.3, y:itemY+0.06, w:1.4, h:itemH-0.1, color, fontSize:10, bold:true, valign:'middle', align:'center' });
    slide.addText(`PY: ${item.ytdPY||'—'}`, { x:panX+3.7, y:itemY+0.06, w:1.2, h:itemH-0.1, color:C.gray, fontSize:9, valign:'middle', align:'center' });
    itemY += itemH;
  });

  // Insight callout
  if (ec.insight) {
    calloutBox(pptx, slide, 0.22, 5.2, 7.5, 0.9, ec.insight, C, C.red);
  }

  footer(slide, footLabel, C);
}

// ── Slide F: Controllable Anomalies ──────────────────────────────────────────
function acS6Anomalies(pptx, ac, C, period, footLabel) {
  const slide = pptx.addSlide();
  slide.background = { color: C.light };
  hdr(pptx, slide, `CONTROLLABLE EXPENSE ANOMALIES  —  ${period}`, C);

  const anomalies = (ac.anomalies || []).slice(0, 4);
  if (anomalies.length === 0) { footer(slide, footLabel, C); return; }

  // 2×2 grid of store panels
  const pW = 6.25, pH = 2.85;
  const positions = [
    {x:0.22, y:0.82}, {x:6.77, y:0.82},
    {x:0.22, y:3.82}, {x:6.77, y:3.82}
  ];

  anomalies.forEach((store, si) => {
    if (si >= 4) return;
    const {x, y} = positions[si];
    const sc = statusColor(store.status, C);

    // Panel background
    slide.addShape(pptx.ShapeType.rect, { x, y, w:pW, h:pH, fill:{color:C.white}, line:{color:C.border, width:1} });
    // Header bar
    slide.addShape(pptx.ShapeType.rect, { x, y, w:pW, h:0.38, fill:{color:sc}, line:{type:'none'} });
    // Status emoji + name
    const icon = store.status === 'green' ? '\u2705' : (store.status === 'amber' ? '\u26a0' : '\ud83d\udd34');
    slide.addText(`${icon}  ${store.name||''} (${store.storeNum||''})`, {
      x:x+0.1, y:y+0.05, w:pW-0.2, h:0.28,
      color:C.white, fontSize:10, bold:true
    });

    const items = (store.items || []).slice(0, 4);
    let lineY = y + 0.42;
    const lineH = (pH - 0.44) / Math.max(items.length, 1);

    items.forEach((item, ii) => {
      const bg = ii % 2 === 0 ? C.white : C.light;
      slide.addShape(pptx.ShapeType.rect, { x, y:lineY, w:pW, h:lineH, fill:{color:bg}, line:{type:'none'} });
      // Line name
      slide.addText((item.line||''), { x:x+0.1, y:lineY+0.04, w:2.4, h:lineH-0.06, color:C.navy, fontSize:8.5, bold:true, valign:'middle', wrap:true });
      // P3 value
      slide.addText(`P3: ${item.p3||'—'}`, { x:x+2.55, y:lineY+0.04, w:1.1, h:lineH-0.06, color:C.red, fontSize:8.5, bold:true, valign:'middle', align:'center' });
      // PY value
      slide.addText(`PY: ${item.py||'—'}`, { x:x+3.7, y:lineY+0.04, w:0.9, h:lineH-0.06, color:C.gray, fontSize:8, valign:'middle', align:'center' });
      // Note
      slide.addText((item.note||''), { x:x+4.65, y:lineY+0.04, w:pW-4.72, h:lineH-0.06, color:C.dk, fontSize:7.5, valign:'middle', wrap:true, italic:true });
      lineY += lineH;
    });
  });

  footer(slide, footLabel, C);
}

// ── Slide G: Store Spotlights ─────────────────────────────────────────────────
function acS7Spotlights(pptx, ac, C, period, footLabel) {
  const slide = pptx.addSlide();
  slide.background = { color: C.light };
  hdr(pptx, slide, 'STORE SPOTLIGHTS  —  WHAT TO WATCH', C);

  const sp = ac.spotlights || {};
  const quadrants = [
    { key:'crisis',     label:'CRISIS STORE',    x:0.22,  y:0.82 },
    { key:'urgent',     label:'URGENT ISSUE',    x:6.77,  y:0.82 },
    { key:'brightSpot', label:'BRIGHT SPOT',     x:0.22,  y:3.82 },
    { key:'structural', label:'STRUCTURAL',       x:6.77,  y:3.82 },
  ];

  const statusMap = {
    crisis:     C.red,
    urgent:     C.red,
    brightSpot: C.green,
    structural: C.amber,
  };

  quadrants.forEach(({key, label, x, y}) => {
    const store = sp[key];
    if (!store) return;
    const clr = statusMap[key];
    const pW = 6.25, pH = 2.85;

    slide.addShape(pptx.ShapeType.rect, { x, y, w:pW, h:pH, fill:{color:C.white}, line:{color:C.border, width:1} });
    slide.addShape(pptx.ShapeType.rect, { x, y, w:pW, h:0.38, fill:{color:clr}, line:{type:'none'} });
    slide.addShape(pptx.ShapeType.rect, { x, y, w:0.06, h:pH, fill:{color:clr}, line:{type:'none'} });

    slide.addText(`${label} — ${store.name||''}`, {
      x:x+0.14, y:y+0.06, w:pW-0.2, h:0.26,
      color:C.white, fontSize:10, bold:true
    });

    const bullets = store.bullets || [];
    slide.addText(
      bullets.map(b => ({ text: b, options: { breakLine: true } })),
      {
        x:x+0.18, y:y+0.46, w:pW-0.28, h:pH-0.56,
        color:C.dk, fontSize:10.5, valign:'top',
        lineSpacingMultiple:1.6,
        bullet: { type:'bullet', indent:8 }
      }
    );
  });

  footer(slide, footLabel, C);
}

// ── Slide H: Coaching Priorities ─────────────────────────────────────────────
function acS8Coaching(pptx, ac, C, period, footLabel) {
  const slide = pptx.addSlide();
  slide.background = { color: C.light };
  hdr(pptx, slide, `COACHING PRIORITIES\n${ac.acName||''}  |  ${period} Action Items — Intervention Required`, C);

  const priorities = (ac.coachingPriorities || []).slice(0, 4);
  const pW = 12.89, pX = 0.22;
  const pHeight = (7.5 - 0.9 - 0.4 - (priorities.length - 1) * 0.15) / Math.max(priorities.length, 1);

  priorities.forEach((item, i) => {
    const y = 0.9 + i * (pHeight + 0.15);
    const clr = statusColor(item.status, C);

    slide.addShape(pptx.ShapeType.rect, { x:pX, y, w:pW, h:pHeight, fill:{color:C.white}, line:{color:C.border, width:1} });
    slide.addShape(pptx.ShapeType.rect, { x:pX, y, w:0.06, h:pHeight, fill:{color:clr}, line:{type:'none'} });

    // Number badge
    slide.addShape(pptx.ShapeType.rect, { x:pX+0.14, y:y+0.1, w:0.55, h:0.55, fill:{color:C.navy}, line:{type:'none'} });
    slide.addText((item.number||String(i+1).padStart(2,'0')), {
      x:pX+0.14, y:y+0.1, w:0.55, h:0.55,
      color:C.gold, fontSize:16, bold:true, fontFace:'Arial Black', align:'center', valign:'middle'
    });

    slide.addText((item.title||''), {
      x:pX+0.82, y:y+0.1, w:pW-1.0, h:0.38,
      color:C.navy, fontSize:12, bold:true
    });
    slide.addText((item.body||''), {
      x:pX+0.82, y:y+0.5, w:pW-1.0, h:pHeight-0.62,
      color:C.dk, fontSize:10.5, valign:'top', wrap:true, lineSpacingMultiple:1.4
    });
  });

  footer(slide, footLabel, C);
}

module.exports = { buildACDeepDive };
