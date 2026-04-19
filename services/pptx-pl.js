const PptxGenJS = require('pptxgenjs');
const { buildACDeepDive } = require('./pptx-pl-ac');

// ─── Brand palette (no # prefix — pptxgenjs uses raw hex) ─────────────────
const C = {
  navy:   '1A2744',
  gold:   'C9A84C',
  white:  'FFFFFF',
  light:  'F2F4F8',
  dk:     '344055',
  green:  '1B8A4C',
  red:    'C0392B',
  amber:  'E07B2A',
  gray:   '8899AA',
  lgray:  'E0E6ED',
  border: 'CDD5DF',
  lgred:  'FFF5F5',
};

// ─── Entry point ───────────────────────────────────────────────────────────
async function generatePLPPTX(analysis, options = {}) {
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
  pptx.layout = 'LAYOUT_WIDE'; // 13.33" × 7.5"
  pptx.author = 'P.AI by Ayvaz Pizza';

  if (data) {
    buildRegionDeck(pptx, data);
  } else {
    buildFallbackDeck(pptx, typeof analysis === 'string' ? analysis : JSON.stringify(analysis));
  }

  return pptx.write({ outputType: 'nodebuffer' });
}

// ─── Full 7-slide region deck ──────────────────────────────────────────────
function buildRegionDeck(pptx, data) {
  const period = data.period || 'P&L Analysis';
  const region = data.region || {};
  const foot   = `${period} · Preliminary · ${region.company || 'Ayvaz Pizza LLC'}`;

  s1Cover(pptx, data, period, region);
  s2Headline(pptx, data, period, foot);
  s3ACScorecard(pptx, data, period, foot);
  s4TopPerformers(pptx, data, period, foot);
  s5LosingStores(pptx, data, period, foot);
  s6Turnarounds(pptx, data, period, foot);
  s7PeterFramework(pptx, data, period, foot);

  // Per-AC deep dive decks (8 slides each)
  const deepDives = data.acDeepDives || [];
  deepDives.forEach(ac => buildACDeepDive(pptx, ac, C));
}

// ─── Common helpers ────────────────────────────────────────────────────────

function navyHeader(pptx, slide, title) {
  slide.addShape(pptx.ShapeType.rect, {
    x: 0, y: 0, w: 13.33, h: 0.62,
    fill: { color: C.navy }, line: { type: 'none' },
  });
  // Gold underline stripe
  slide.addShape(pptx.ShapeType.rect, {
    x: 0, y: 0.62, w: 13.33, h: 0.05,
    fill: { color: C.gold }, line: { type: 'none' },
  });
  slide.addText(title, {
    x: 0.3, y: 0.1, w: 12.7, h: 0.46,
    color: C.white, fontSize: 13.5, bold: true, fontFace: 'Arial Black', valign: 'middle',
  });
}

function foot(slide, label) {
  slide.addText(label, {
    x: 0.3, y: 7.23, w: 12.7, h: 0.22,
    color: C.gray, fontSize: 7.5, charSpacing: 1,
  });
}

function tblHdr(pptx, slide, cols, widths, x, y, h) {
  let cx = x;
  cols.forEach((col, i) => {
    slide.addShape(pptx.ShapeType.rect, {
      x: cx, y, w: widths[i], h,
      fill: { color: C.navy }, line: { type: 'none' },
    });
    slide.addText(col.toUpperCase(), {
      x: cx + 0.07, y: y + 0.05, w: widths[i] - 0.1, h: h - 0.08,
      color: C.white, fontSize: 8, bold: true, charSpacing: 0.3,
      align: i === 0 ? 'left' : 'center', valign: 'middle',
    });
    cx += widths[i];
  });
}

function miniHdr(pptx, slide, cols, widths, x, y) {
  const h = 0.32;
  let cx = x;
  cols.forEach((col, i) => {
    slide.addShape(pptx.ShapeType.rect, {
      x: cx, y, w: widths[i], h,
      fill: { color: C.dk }, line: { type: 'none' },
    });
    slide.addText(col.toUpperCase(), {
      x: cx + 0.06, y: y + 0.04, w: widths[i] - 0.08, h: h - 0.06,
      color: C.white, fontSize: 7.5, bold: true,
      align: i <= 1 ? 'left' : 'center', valign: 'middle',
    });
    cx += widths[i];
  });
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

module.exports = { generatePLPPTX, generateACPPTX };
