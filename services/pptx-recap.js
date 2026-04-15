const PptxGenJS = require('pptxgenjs');

// ── Themes ────────────────────────────────────────────────────────────────────
const THEMES = {
  // 1 — Charcoal + red (default)
  'command-dark': {
    dark: '#1A1A1A', mid: '#2A2A2A', muted: '#3A3A3A',
    light: '#F5F5F5', accent: '#CC0000'
  },
  // 2 — White + red (print-friendly)
  'clean-white': {
    dark: '#1C1C1C', mid: '#2C2C2C', muted: '#4A4A4A',
    light: '#FFFFFF', accent: '#CC0000'
  },
  // 3 — Deep maroon + warm gold
  'maroon': {
    dark: '#3D0C0C', mid: '#5A1313', muted: '#751A1A',
    light: '#FFF8F0', accent: '#F9A825'
  },
  // 4 — Royal blue + white
  'royal-white': {
    dark: '#003594', mid: '#0040A8', muted: '#1A55BC',
    light: '#F0F4FF', accent: '#FFFFFF'
  },
  // 5 — Deep purple + gold
  'purple-gold': {
    dark: '#2D0A5E', mid: '#3D1278', muted: '#4E1A92',
    light: '#FAF5FF', accent: '#F5C518'
  },
  // 6 — Forest green + gold
  'forest-gold': {
    dark: '#1A4731', mid: '#235E40', muted: '#2C7550',
    light: '#F2FAF5', accent: '#B8960C'
  },
  // 7 — Dark navy + orange
  'navy-orange': {
    dark: '#0D1B2A', mid: '#162638', muted: '#1F3347',
    light: '#FFF8F2', accent: '#E85D04'
  },
  // 8 — True black + vegas gold
  'black-gold': {
    dark: '#0F0F0F', mid: '#1E1E1E', muted: '#2D2D2D',
    light: '#FAFAF5', accent: '#C9A84C'
  },
  // 9 — Slate + teal
  'slate-teal': {
    dark: '#1C3A4A', mid: '#264D61', muted: '#306078',
    light: '#F0F8FA', accent: '#00B4D8'
  },
  // 10 — Crimson + silver
  'crimson-silver': {
    dark: '#6B0F1A', mid: '#8B1525', muted: '#A61B2E',
    light: '#FFF5F6', accent: '#A8A9AD'
  },
};

function buildBrand(theme) {
  const t = THEMES[theme] || THEMES['command-dark'];
  return {
    red:    t.accent,
    dark:   t.dark,
    mid:    t.mid,
    muted:  t.muted,
    light:  t.light,
    white:  '#FFFFFF',
    gray:   '#888888',
    lgray:  '#BBBBBB',
    green:  '#2E7D32',
    yellow: '#F57F17',
    danger: '#C62828',
    gold:   '#F9A825',
  };
}

// Default brand (overridden per call in generateRecapPPTX)
let B = buildBrand('command-dark');

// ── Helpers ───────────────────────────────────────────────────────────────────
function safe(val, fallback = '') {
  if (val === null || val === undefined) return fallback;
  if (typeof val === 'object' && !Array.isArray(val)) return fallback;
  return String(val) || fallback;
}

// Extract AC/person name from a row object — tries every plausible field key
function extractName(row, fallback = '') {
  if (!row || typeof row !== 'object') return fallback;
  const keys = ['name', 'acName', 'ac', 'areaCoach', 'coach', 'area_coach',
                'areaCoachName', 'Area_Coach', 'AreaCoach', 'Name', 'AC',
                'district_manager', 'dm', 'manager'];
  for (const k of keys) {
    if (row[k] && typeof row[k] === 'string' && row[k].trim()) return row[k].trim();
  }
  // Last resort: find any string-valued key whose value looks like a name (2+ words, no numbers)
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'string' && /^[A-Za-z]+ [A-Za-z]+/.test(v.trim())) return v.trim();
  }
  return fallback;
}

function safeArr(val) {
  return Array.isArray(val) ? val : [];
}

function statusColor(status) {
  if (!status) return B.lgray;
  const s = status.toLowerCase();
  if (s === 'green') return B.green;
  if (s === 'yellow') return B.yellow;
  if (s === 'red') return B.danger;
  return B.lgray;
}

function chrome(slide, pptx, title, slideNum, total) {
  // Left red accent bar
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.08, h: '100%', fill: { color: B.red } });
  // Dark header bar
  slide.addShape(pptx.ShapeType.rect, { x: 0.08, y: 0, w: '100%', h: 0.65, fill: { color: B.mid } });
  // Title
  slide.addText(title.toUpperCase(), {
    x: 0.25, y: 0.1, w: 8.5, h: 0.45,
    color: B.light, fontSize: 11, bold: true, charSpacing: 3
  });
  // Slide number
  slide.addText(`${slideNum} / ${total}`, {
    x: 8.8, y: 0.15, w: 0.85, h: 0.3,
    color: B.gray, fontSize: 9, align: 'right'
  });
  // Footer
  slide.addText('P.AI · CONFIDENTIAL · AYVAZ PIZZA LLC', {
    x: 0.25, y: 6.88, w: 9.2, h: 0.18,
    color: B.muted, fontSize: 7, charSpacing: 2
  });
}

// ── Main generator ─────────────────────────────────────────────────────────────
async function generateRecapPPTX(data, options = {}) {
  // Apply theme
  B = buildBrand(options.theme || 'command-dark');

  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'P.AI by Ayvaz Pizza';

  // Handle raw text fallback (Claude couldn't produce JSON)
  if (data.rawContent) {
    return generateFallbackDeck(pptx, data.rawContent);
  }

  // Normalise: Claude may put slides under data.slides or flat on data
  const s = data.slides || data;
  const regionName = safe(data.regionName || s.title?.regionName, 'AYVAZ REGION');
  const weekLabel  = safe(data.weekLabel  || s.title?.weekLabel,  'Current Week');
  const TOTAL = 13;

  // 1 ── Cover ─────────────────────────────────────────────────────────────────
  makeCover(pptx, s.title || {}, regionName, weekLabel);

  // 2 ── Region Scorecard ──────────────────────────────────────────────────────
  makeScorecard(pptx, s.scorecard || {}, weekLabel, TOTAL);

  // 3 ── AC Performance Table ──────────────────────────────────────────────────
  makeACTable(pptx, s.acTable || {}, weekLabel, TOTAL);

  // 4 ── Wins ──────────────────────────────────────────────────────────────────
  makeWins(pptx, s.wins || {}, weekLabel, TOTAL);

  // 5 ── Focus Areas ───────────────────────────────────────────────────────────
  makeFocusAreas(pptx, s.focusAreas || {}, weekLabel, TOTAL);

  // 6 ── Labor Deep Dive ───────────────────────────────────────────────────────
  makeLaborDeepDive(pptx, s.laborDeepDive || {}, weekLabel, TOTAL);

  // 7 ── Speed Outlier ─────────────────────────────────────────────────────────
  makeSpeedOutlier(pptx, s.speedOutlier || {}, weekLabel, TOTAL);

  // 8 ── SMG by AC ─────────────────────────────────────────────────────────────
  makeSMGbyAC(pptx, s.smgByAC || {}, weekLabel, TOTAL);

  // 9 ── SMG Store Spotlight ───────────────────────────────────────────────────
  makeSMGSpotlight(pptx, s.smgSpotlight || {}, weekLabel, TOTAL);

  // 10 ── Customer Voice ───────────────────────────────────────────────────────
  makeCustomerVoice(pptx, s.customerVoice || {}, weekLabel, TOTAL);

  // 11 ── Smart Goals ──────────────────────────────────────────────────────────
  makeSmartGoals(pptx, s.smartGoals || {}, weekLabel, TOTAL);

  // 12 ── Key Dates ────────────────────────────────────────────────────────────
  makeKeyDates(pptx, s.keyDates || {}, weekLabel, TOTAL);

  // 13 ── Closing ──────────────────────────────────────────────────────────────
  makeClosing(pptx, s.closing || {}, regionName, weekLabel, TOTAL);

  return pptx.write({ outputType: 'nodebuffer' });
}

// ── Slide builders ─────────────────────────────────────────────────────────────

function makeCover(pptx, d, regionName, weekLabel) {
  const slide = pptx.addSlide();
  slide.background = { color: B.dark };

  // Left red bar
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.5, h: '100%', fill: { color: B.red } });

  slide.addText('PIZZA HUT', { x: 0.75, y: 0.5, w: 9, h: 0.4, color: B.red, fontSize: 12, bold: true, charSpacing: 6 });
  slide.addText(regionName, { x: 0.75, y: 1.0, w: 9, h: 1.1, color: B.light, fontSize: 44, bold: true });
  slide.addText(`WEEK OF ${weekLabel}`, { x: 0.75, y: 2.15, w: 9, h: 0.4, color: B.gray, fontSize: 13, charSpacing: 2 });
  slide.addText('Weekly Performance Recap for Area Coaches', { x: 0.75, y: 2.65, w: 9, h: 0.35, color: B.lgray, fontSize: 12 });

  // Stat cards from title.stats
  const stats = safeArr(d.stats);
  const labels = stats.length ? stats.map(s => safe(s.label, '—')) : ['SALES GROWTH','LABOR VAR','WIN','HUT BOT'];
  const values = stats.length ? stats.map(s => safe(s.value, '—')) : ['—','—','—','—'];
  const subs   = stats.length ? stats.map(s => safe(s.sub, ''))  : ['vs last year','over plan','score','audit on time'];

  const cw = 2.1, ch = 1.5, gap = 0.1, sy = 3.9, sx = 0.75;
  labels.slice(0, 4).forEach((lbl, i) => {
    const x = sx + i * (cw + gap);
    slide.addShape(pptx.ShapeType.rect, { x, y: sy, w: cw, h: ch, fill: { color: B.mid }, line: { color: B.red, width: 1 } });
    slide.addText(lbl, { x: x+0.1, y: sy+0.1, w: cw-0.2, h: 0.3, color: B.gray, fontSize: 8, bold: true, charSpacing: 1 });
    slide.addText(values[i], { x: x+0.1, y: sy+0.4, w: cw-0.2, h: 0.65, color: B.light, fontSize: 28, bold: true });
    slide.addText(subs[i], { x: x+0.1, y: sy+1.1, w: cw-0.2, h: 0.3, color: B.gray, fontSize: 9 });
  });

  slide.addText('Area Coach Recap  ·  Confidential', { x: 0.75, y: 6.75, w: 9, h: 0.25, color: '#444444', fontSize: 8, charSpacing: 2 });
}

function makeScorecard(pptx, d, weekLabel, total) {
  const slide = pptx.addSlide();
  slide.background = { color: B.light };
  chrome(slide, pptx, `REGION SCORECARD  |  Week of ${weekLabel}`, 2, total);

  const metrics = safeArr(d.metrics);
  const defaults = [
    { label: 'SALES GROWTH', value: '—', sub: 'vs LY', status: 'red' },
    { label: 'LABOR VAR', value: '—', sub: 'over plan', status: 'red' },
    { label: 'OTD AVG TIME', value: '—', sub: 'mins avg', status: 'yellow' },
    { label: 'WIN SCORE', value: '—', sub: 'combined', status: 'yellow' },
    { label: 'HUT BOT', value: '—', sub: 'audits on time', status: 'yellow' },
  ];
  const items = metrics.length ? metrics : defaults;

  const cw = 1.8, ch = 1.55, gap = 0.08, sy = 0.75, sx = 0.25;
  items.slice(0, 5).forEach((m, i) => {
    const x = sx + i * (cw + gap);
    const color = statusColor(m.status);
    slide.addShape(pptx.ShapeType.rect, { x, y: sy, w: cw, h: 0.12, fill: { color } });
    slide.addShape(pptx.ShapeType.rect, { x, y: sy + 0.12, w: cw, h: ch - 0.12, fill: { color: B.white }, line: { color: '#DDDDDD', width: 1 } });
    slide.addText(safe(m.label), { x: x+0.1, y: sy+0.15, w: cw-0.2, h: 0.3, color: '#555555', fontSize: 8, bold: true, charSpacing: 1 });
    slide.addText(safe(m.value), { x: x+0.08, y: sy+0.45, w: cw-0.16, h: 0.7, color: B.dark, fontSize: 26, bold: true });
    slide.addText(safe(m.sub), { x: x+0.1, y: sy+1.18, w: cw-0.2, h: 0.25, color: '#777777', fontSize: 9 });
  });

  // HUT Bot breakdown
  const hb = d.hutBotBreakdown || {};
  const bx = 0.25, by = 2.5;
  slide.addText('HUT BOT BREAKDOWN  —', { x: bx, y: by, w: 3, h: 0.3, color: B.dark, fontSize: 10, bold: true });

  const bCols = [
    { lbl: 'On Time %', val: safe(hb.onTime, '—') },
    { lbl: 'Late %', val: safe(hb.late, '—') },
    { lbl: 'Missed %', val: safe(hb.missed, '—') },
  ];
  bCols.forEach((c, i) => {
    const x = bx + i * 2.5;
    slide.addText(c.lbl, { x, y: by + 0.35, w: 2.3, h: 0.25, color: '#555555', fontSize: 9 });
    slide.addText(c.val, { x, y: by + 0.6, w: 2.3, h: 0.55, color: B.dark, fontSize: 28, bold: true });
  });

  // Legend
  const ly = 3.6;
  [['Green = On Track', B.green], ['Yellow = Caution', B.yellow], ['Red = Needs Attention', B.danger]].forEach(([lbl, col], i) => {
    slide.addShape(pptx.ShapeType.rect, { x: 0.25 + i * 3.1, y: ly, w: 0.18, h: 0.18, fill: { color: col } });
    slide.addText(lbl, { x: 0.5 + i * 3.1, y: ly - 0.02, w: 2.7, h: 0.22, color: '#444444', fontSize: 9 });
  });

  // ── Routine Non-Completers ─────────────────────────────────────────────────
  const nonCompleters = safeArr(
    hb.nonCompleters || hb.non_completers || hb.flaggedUsers || hb.users || hb.flagged
  );
  if (nonCompleters.length) {
    slide.addShape(pptx.ShapeType.rect, { x: 0.25, y: 3.95, w: 9.2, h: 0.28, fill: { color: B.danger } });
    slide.addText('⚠  ROUTINE NON-COMPLETERS THIS WEEK — WHO DROPPED THE BALL', {
      x: 0.35, y: 3.96, w: 9.0, h: 0.26,
      color: B.white, fontSize: 9, bold: true, charSpacing: 1
    });

    const tableRows = [[
      { text: 'EMPLOYEE',      options: { bold: true, color: B.white, fill: B.dark, fontSize: 8 } },
      { text: 'STORE',         options: { bold: true, color: B.white, fill: B.dark, fontSize: 8 } },
      { text: 'AREA COACH',    options: { bold: true, color: B.white, fill: B.dark, fontSize: 8 } },
      { text: 'ROUTINES MISSED', options: { bold: true, color: B.white, fill: B.dark, fontSize: 8 } },
      { text: 'STATUS',        options: { bold: true, color: B.white, fill: B.dark, fontSize: 8, align: 'center' } },
    ]];

    nonCompleters.slice(0, 6).forEach((u, idx) => {
      const fill = idx % 2 === 0 ? B.white : '#F5F5F5';
      const status = safe(u.status || u.completion || u.completionStatus || '—');
      const isNotStarted = status.toLowerCase().includes('not') || status.toLowerCase().includes('never');
      const statusColor = isNotStarted ? B.danger : B.yellow;
      const storeLine = [safe(u.store || u.storeName || ''), u.storeNum ? '#' + safe(u.storeNum) : '']
        .filter(Boolean).join('  ');
      tableRows.push([
        { text: safe(u.user || u.name || u.userName || u.employee || '—'), options: { color: B.dark, fontSize: 9, fill, bold: true } },
        { text: storeLine, options: { color: B.dark, fontSize: 9, fill } },
        { text: safe(u.ac || u.acName || extractName(u) || '—'), options: { color: B.dark, fontSize: 9, fill } },
        { text: safe(u.routines || u.routine || u.routinesMissed || u.missed || '—'), options: { color: B.dark, fontSize: 9, fill } },
        { text: status, options: { color: statusColor, fontSize: 9, fill, bold: true, align: 'center' } },
      ]);
    });

    slide.addTable(tableRows, {
      x: 0.25, y: 4.26, w: 9.2, rowH: 0.36,
      border: { type: 'solid', color: '#DDDDDD', pt: 1 }
    });
  } else {
    // Placeholder when file not uploaded
    slide.addText('Upload "Routines Status by User" file to see individual accountability data', {
      x: 0.25, y: 4.1, w: 9.2, h: 0.3, color: B.gray, fontSize: 9, italic: true
    });
  }
}

function makeACTable(pptx, d, weekLabel, total) {
  const slide = pptx.addSlide();
  slide.background = { color: B.light };
  chrome(slide, pptx, `AREA COACH PERFORMANCE  |  Week of ${weekLabel}`, 3, total);

  const rows = safeArr(d.rows);

  const tableRows = [
    [
      { text: 'AREA COACH', options: { bold: true, color: B.white, fill: B.dark, fontSize: 9 } },
      { text: 'SALES GROWTH', options: { bold: true, color: B.white, fill: B.dark, fontSize: 9 } },
      { text: 'LABOR VAR', options: { bold: true, color: B.white, fill: B.dark, fontSize: 9 } },
      { text: 'WIN SCORE', options: { bold: true, color: B.white, fill: B.dark, fontSize: 9 } },
      { text: 'HUT BOT', options: { bold: true, color: B.white, fill: B.dark, fontSize: 9 } },
    ]
  ];

  rows.forEach((r, idx) => {
    const acName = extractName(r);
    tableRows.push([
      { text: acName, options: { color: B.dark, fontSize: 11, bold: true, fill: idx % 2 === 0 ? B.white : '#F0F0F0' } },
      { text: safe(r.salesGrowth || r.sales_growth || r.sales), options: { color: B.dark, fontSize: 11, fill: idx % 2 === 0 ? B.white : '#F0F0F0', align: 'center' } },
      { text: safe(r.laborVar || r.labor_var), options: { color: B.dark, fontSize: 11, fill: idx % 2 === 0 ? B.white : '#F0F0F0', align: 'center' } },
      { text: safe(r.winScore || r.win_score || r.win), options: { color: B.dark, fontSize: 11, fill: idx % 2 === 0 ? B.white : '#F0F0F0', align: 'center' } },
      { text: safe(r.hutBot || r.hut_bot || r.hutbot), options: { color: B.dark, fontSize: 11, fill: idx % 2 === 0 ? B.white : '#F0F0F0', align: 'center' } },
    ]);
  });

  if (tableRows.length > 1) {
    slide.addTable(tableRows, {
      x: 0.25, y: 0.75, w: 9.2,
      rowH: 0.52,
      border: { type: 'solid', color: '#DDDDDD', pt: 1 },
    });
  } else {
    slide.addText('No AC data available', { x: 0.25, y: 1.5, w: 9.2, h: 0.5, color: B.gray, fontSize: 13 });
  }

  slide.addText('★ = Best in column  |  HUT BOT thresholds: Green ≥95%  Yellow 88–94%  Red <88%', {
    x: 0.25, y: 6.55, w: 9.2, h: 0.25, color: B.gray, fontSize: 9
  });
}

function makeWins(pptx, d, weekLabel, total) {
  const slide = pptx.addSlide();
  slide.background = { color: B.dark };
  chrome(slide, pptx, `WINS THIS WEEK  🏆`, 4, total);

  const items = safeArr(d.items);
  if (!items.length) {
    slide.addText('No wins data available', { x: 0.25, y: 1.5, w: 9.2, h: 0.5, color: B.gray, fontSize: 13 });
    return;
  }

  items.slice(0, 5).forEach((item, i) => {
    const y = 0.8 + i * 1.1;
    // Green checkmark box
    slide.addShape(pptx.ShapeType.rect, { x: 0.25, y, w: 0.35, h: 0.35, fill: { color: B.green }, rectRadius: 0.05 });
    slide.addText('✓', { x: 0.25, y: y + 0.02, w: 0.35, h: 0.3, color: B.white, fontSize: 14, bold: true, align: 'center' });
    // Store name & number
    const storeName = safe(item.store || item.storeName);
    const storeNum  = safe(item.storeNum || item.store_num);
    slide.addText(`${storeName}${storeNum ? '  |  #' + storeNum : ''}`, {
      x: 0.7, y, w: 5.5, h: 0.3, color: B.light, fontSize: 12, bold: true
    });
    // Metric badge
    slide.addText(safe(item.metric), { x: 6.3, y, w: 2.8, h: 0.3, color: B.gold, fontSize: 10, bold: true, align: 'right' });
    // Description
    slide.addText(safe(item.description || item.desc), {
      x: 0.7, y: y + 0.33, w: 7.5, h: 0.45, color: B.lgray, fontSize: 10, wrap: true
    });
    // AC name
    slide.addText(safe(item.ac || item.acName), {
      x: 0.7, y: y + 0.78, w: 3, h: 0.22, color: B.gray, fontSize: 9, italic: true
    });
    // Divider (except last)
    if (i < items.length - 1 && i < 4) {
      slide.addShape(pptx.ShapeType.line, { x: 0.25, y: y + 1.05, w: 9.1, h: 0, line: { color: '#333333', width: 0.5 } });
    }
  });
}

function makeFocusAreas(pptx, d, weekLabel, total) {
  const slide = pptx.addSlide();
  slide.background = { color: B.dark };
  chrome(slide, pptx, `FOCUS AREAS  ⚠`, 5, total);

  const items = safeArr(d.items);
  if (!items.length) {
    slide.addText('No focus areas identified', { x: 0.25, y: 1.5, w: 9.2, h: 0.5, color: B.gray, fontSize: 13 });
    return;
  }

  items.slice(0, 5).forEach((item, i) => {
    const y = 0.8 + i * 1.1;
    slide.addShape(pptx.ShapeType.rect, { x: 0.25, y, w: 0.35, h: 0.35, fill: { color: B.danger }, rectRadius: 0.05 });
    slide.addText('!', { x: 0.25, y: y + 0.02, w: 0.35, h: 0.3, color: B.white, fontSize: 16, bold: true, align: 'center' });
    const storeName = safe(item.store || item.storeName);
    const storeNum  = safe(item.storeNum || item.store_num);
    slide.addText(`${storeName}${storeNum ? '  |  #' + storeNum : ''}`, {
      x: 0.7, y, w: 5.5, h: 0.3, color: B.light, fontSize: 12, bold: true
    });
    slide.addText(safe(item.metric), { x: 6.3, y, w: 2.8, h: 0.3, color: B.danger, fontSize: 10, bold: true, align: 'right' });
    slide.addText(safe(item.description || item.desc), {
      x: 0.7, y: y + 0.33, w: 7.5, h: 0.45, color: B.lgray, fontSize: 10, wrap: true
    });
    slide.addText(safe(item.ac || item.acName), {
      x: 0.7, y: y + 0.78, w: 3, h: 0.22, color: B.gray, fontSize: 9, italic: true
    });
    if (i < items.length - 1 && i < 4) {
      slide.addShape(pptx.ShapeType.line, { x: 0.25, y: y + 1.05, w: 9.1, h: 0, line: { color: '#333333', width: 0.5 } });
    }
  });
}

function makeLaborDeepDive(pptx, d, weekLabel, total) {
  const slide = pptx.addSlide();
  slide.background = { color: B.light };
  chrome(slide, pptx, `LABOR VARIANCE DEEP DIVE  |  FRS Report  |  ${weekLabel}`, 6, total);

  const rs = d.regionSummary || d.region || {};
  // Region summary row
  const sumCols = [
    { lbl: 'Labor Var', val: safe(rs.laborVar || rs.labor_var, '—') },
    { lbl: 'Crew OT $', val: safe(rs.crewOT || rs.crew_ot, '—') },
    { lbl: 'HAM OT $', val: safe(rs.hamOT || rs.ham_ot, '—') },
    { lbl: 'Total OT $', val: safe(rs.totalOT || rs.total_ot, '—') },
    { lbl: 'PCA %', val: safe(rs.pca, '—') },
    { lbl: 'COS Var', val: safe(rs.cosVar || rs.cos_var, '—') },
  ];

  slide.addText('REGION TOTAL', { x: 0.25, y: 0.72, w: 1.5, h: 0.25, color: '#555555', fontSize: 8, bold: true });
  sumCols.forEach((c, i) => {
    const x = 1.85 + i * 1.27;
    slide.addText(c.lbl, { x, y: 0.7, w: 1.2, h: 0.22, color: '#555555', fontSize: 8, align: 'center' });
    slide.addText(c.val, { x, y: 0.92, w: 1.2, h: 0.3, color: B.dark, fontSize: 13, bold: true, align: 'center' });
  });

  // AC rows table
  const acRows = safeArr(d.acRows || d.rows);
  const tableRows = [[
    { text: 'AREA COACH', options: { bold: true, color: B.white, fill: B.dark, fontSize: 8 } },
    { text: 'SALES', options: { bold: true, color: B.white, fill: B.dark, fontSize: 8, align: 'center' } },
    { text: 'LABOR VAR %', options: { bold: true, color: B.white, fill: B.dark, fontSize: 8, align: 'center' } },
    { text: 'CREW OT $', options: { bold: true, color: B.white, fill: B.dark, fontSize: 8, align: 'center' } },
    { text: 'HAM OT $', options: { bold: true, color: B.white, fill: B.dark, fontSize: 8, align: 'center' } },
    { text: 'PCA %', options: { bold: true, color: B.white, fill: B.dark, fontSize: 8, align: 'center' } },
    { text: 'COS VAR %', options: { bold: true, color: B.white, fill: B.dark, fontSize: 8, align: 'center' } },
  ]];

  acRows.forEach((r, idx) => {
    const fill = idx % 2 === 0 ? B.white : '#F0F0F0';
    const acName = extractName(r);
    tableRows.push([
      { text: acName, options: { color: B.dark, fontSize: 10, bold: true, fill } },
      { text: safe(r.salesGrowth || r.sales_growth || r.sales), options: { color: B.dark, fontSize: 10, fill, align: 'center' } },
      { text: safe(r.laborVar || r.labor_var), options: { color: B.dark, fontSize: 10, fill, align: 'center' } },
      { text: safe(r.crewOT || r.crew_ot), options: { color: B.dark, fontSize: 10, fill, align: 'center' } },
      { text: safe(r.hamOT || r.ham_ot), options: { color: B.dark, fontSize: 10, fill, align: 'center' } },
      { text: safe(r.pca), options: { color: B.dark, fontSize: 10, fill, align: 'center' } },
      { text: safe(r.cosVar || r.cos_var), options: { color: B.dark, fontSize: 10, fill, align: 'center' } },
    ]);
  });

  if (tableRows.length > 1) {
    slide.addTable(tableRows, { x: 0.25, y: 1.3, w: 9.2, rowH: 0.42, border: { type: 'solid', color: '#DDDDDD', pt: 1 } });
  }

  // OT Flags
  const otFlags = safe(d.otFlags || d.ot_flags);
  if (otFlags) {
    slide.addText('OT FLAGS:', { x: 0.25, y: 5.5, w: 1.0, h: 0.25, color: B.danger, fontSize: 9, bold: true });
    slide.addText(otFlags, { x: 1.3, y: 5.5, w: 8.1, h: 0.8, color: '#444444', fontSize: 9, wrap: true });
  }
}

function makeSpeedOutlier(pptx, d, weekLabel, total) {
  const slide = pptx.addSlide();
  slide.background = { color: B.dark };
  chrome(slide, pptx, `SPEED OUTLIER ANALYSIS  |  IST by Day & Store  |  ${weekLabel}`, 7, total);

  // Daily chart (text representation)
  const dailyChart = safeArr(d.dailyChart || d.daily_chart);
  if (dailyChart.length) {
    slide.addText('DAILY REGION AVG IST  |  Target ≤18 min', {
      x: 0.25, y: 0.75, w: 5, h: 0.25, color: B.gray, fontSize: 9, bold: true, charSpacing: 1
    });
    const dayRow = dailyChart.map(d => safe(d.day || d.date, '—')).join('     ');
    const valRow = dailyChart.map(d => safe(d.value || d.avg || d.ist, '—')).join('     ');
    slide.addText(dayRow, { x: 0.25, y: 1.05, w: 5.5, h: 0.3, color: B.gray, fontSize: 10 });
    slide.addText(valRow, { x: 0.25, y: 1.35, w: 5.5, h: 0.45, color: B.light, fontSize: 16, bold: true });
    slide.addText('≤18 target', { x: 0.25, y: 1.85, w: 2, h: 0.25, color: B.green, fontSize: 9 });
  }

  // Outlier stores
  const outliers = safeArr(d.outlierStores || d.outlier_stores);
  slide.addText('WTD OUTLIER STORES  |  IST > 22 min', {
    x: 5.5, y: 0.75, w: 4, h: 0.25, color: B.danger, fontSize: 9, bold: true, charSpacing: 1
  });

  outliers.slice(0, 5).forEach((o, i) => {
    const y = 1.05 + i * 1.0;
    const name = safe(o.store || o.name || o.storeName);
    const num  = safe(o.storeNum || o.store_num || o.num);
    const ist  = safe(o.ist);
    const ac   = safe(o.ac || o.acName);
    const note = safe(o.note || o.description);
    slide.addText(`${name}  ${num ? '#' + num : ''}`, { x: 5.5, y, w: 4, h: 0.28, color: B.light, fontSize: 11, bold: true });
    if (ist) slide.addText(ist, { x: 5.5, y: y + 0.28, w: 4, h: 0.25, color: B.danger, fontSize: 16, bold: true });
    if (ac)  slide.addText(`AC: ${ac}  |  ${note}`, { x: 5.5, y: y + 0.55, w: 4, h: 0.3, color: B.gray, fontSize: 9, wrap: true });
  });

  if (!dailyChart.length && !outliers.length) {
    slide.addText('Speed data not available — upload Velocity IST file for full analysis', {
      x: 0.25, y: 1.5, w: 9.2, h: 0.5, color: B.gray, fontSize: 12
    });
  }
}

function makeSMGbyAC(pptx, d, weekLabel, total) {
  const slide = pptx.addSlide();
  slide.background = { color: B.light };
  chrome(slide, pptx, `SMG BY AREA COACH  |  ${weekLabel}`, 8, total);

  const rows = safeArr(d.rows);
  const tableRows = [[
    { text: 'AREA COACH', options: { bold: true, color: B.white, fill: B.dark, fontSize: 9 } },
    { text: 'REVIEWS', options: { bold: true, color: B.white, fill: B.dark, fontSize: 9, align: 'center' } },
    { text: 'AVG SCORE', options: { bold: true, color: B.white, fill: B.dark, fontSize: 9, align: 'center' } },
    { text: 'POS', options: { bold: true, color: B.white, fill: B.dark, fontSize: 9, align: 'center' } },
    { text: 'NEG', options: { bold: true, color: B.white, fill: B.dark, fontSize: 9, align: 'center' } },
    { text: 'NEG RATE', options: { bold: true, color: B.white, fill: B.dark, fontSize: 9, align: 'center' } },
  ]];

  rows.forEach((r, idx) => {
    const fill = idx % 2 === 0 ? B.white : '#F0F0F0';
    const acName = extractName(r);
    tableRows.push([
      { text: acName, options: { color: B.dark, fontSize: 11, bold: true, fill } },
      { text: safe(r.reviews || r.reviewCount || r.review_count), options: { color: B.dark, fontSize: 11, fill, align: 'center' } },
      { text: safe(r.avg || r.avgScore || r.avg_score || r.satAvg || r.score), options: { color: B.dark, fontSize: 11, fill, align: 'center' } },
      { text: safe(r.pos || r.positive), options: { color: B.green, fontSize: 11, fill, align: 'center' } },
      { text: safe(r.neg || r.negative), options: { color: B.danger, fontSize: 11, fill, align: 'center' } },
      { text: safe(r.negRate || r.neg_rate), options: { color: B.dark, fontSize: 11, fill, align: 'center' } },
    ]);
  });

  if (tableRows.length > 1) {
    slide.addTable(tableRows, { x: 0.25, y: 0.75, w: 9.2, rowH: 0.47, border: { type: 'solid', color: '#DDDDDD', pt: 1 } });
  } else {
    slide.addText('No AC-level SMG data available — upload SMG comments file to populate this table.', {
      x: 0.25, y: 1.5, w: 9.2, h: 0.5, color: B.gray, fontSize: 11, italic: true
    });
  }

  // Complaint themes
  const themes = safeArr(d.complaintThemes || d.complaint_themes);
  if (themes.length) {
    const themeTotal = themes.reduce((s, t) => s + (parseInt(t.count) || 0), 0);
    const prefix = themeTotal ? `TOP COMPLAINT THEMES ACROSS ${themeTotal} REVIEWS:` : 'TOP COMPLAINT THEMES:';
    slide.addText(prefix, { x: 0.25, y: 5.6, w: 9, h: 0.25, color: '#444444', fontSize: 9, bold: true });
    const themeStr = themes.slice(0, 6).map(t => {
      const label = safe(t.theme || t.name || t);
      const count = safe(t.count || t.mentions || '');
      return count ? `${label}  [${count}]` : label;
    }).filter(Boolean).join('     ');
    slide.addText(themeStr, { x: 0.25, y: 5.88, w: 9.2, h: 0.3, color: B.dark, fontSize: 11, bold: true });
  }
}

function makeSMGSpotlight(pptx, d, weekLabel, total) {
  const slide = pptx.addSlide();
  slide.background = { color: B.light };
  chrome(slide, pptx, `SMG STORE SPOTLIGHT  |  Top & Bottom Performers  |  ${weekLabel}`, 9, total);

  const top = safeArr(d.top5 || d.top);
  const bot = safeArr(d.bottom5 || d.bottom);

  // Column headers with colored background bars
  slide.addShape(pptx.ShapeType.rect, { x: 0.25, y: 0.72, w: 4.35, h: 0.32, fill: { color: B.green } });
  slide.addText('★  TOP RATED STORES', { x: 0.35, y: 0.74, w: 4.1, h: 0.28, color: B.white, fontSize: 10, bold: true });
  slide.addShape(pptx.ShapeType.rect, { x: 4.9, y: 0.72, w: 4.85, h: 0.32, fill: { color: B.danger } });
  slide.addText('⚠  LOWEST RATED STORES', { x: 5.0, y: 0.74, w: 4.6, h: 0.28, color: B.white, fontSize: 10, bold: true });

  // Row-based layout — SMG score pill right, WIN score badge below store name
  const renderStoreList = (items, x, colW, isTop) => {
    const color = isTop ? B.green : B.danger;
    items.slice(0, 5).forEach((item, i) => {
      const y = 1.12 + i * 1.08;
      const score    = safe(item.score || item.avgScore || item.avg_score || item.satAvg, '—');
      const name     = safe(item.name || item.storeName || item.store, 'Store');
      const num      = safe(item.num || item.storeNum || item.store_num);
      const reviews  = safe(item.reviews || item.reviewCount || item.review_count);
      const ac       = extractName(item) || safe(item.ac || item.acName);
      const winScore = safe(item.winScore || item.win_score || item.win || '');

      // SMG score pill (right)
      slide.addShape(pptx.ShapeType.rect, { x: x + colW - 1.2, y, w: 1.15, h: 0.42, fill: { color }, rectRadius: 0.05 });
      slide.addText(`${score} / 5`, { x: x + colW - 1.2, y: y + 0.02, w: 1.15, h: 0.38, color: B.white, fontSize: 13, bold: true, align: 'center', valign: 'middle' });

      // Store name
      slide.addText(`${name}${num ? ' — ' + num : ''}`, {
        x, y, w: colW - 1.3, h: 0.28, color: B.dark, fontSize: 11, bold: true
      });

      // AC + reviews + WIN score on second row
      const acPart = ac ? `AC: ${ac}` : '';
      const revPart = reviews ? `${reviews} reviews` : '';
      const sub = [acPart, revPart].filter(Boolean).join('  |  ');
      if (sub) {
        slide.addText(sub, { x, y: y + 0.29, w: colW - 1.3, h: 0.2, color: B.gray, fontSize: 9 });
      }

      // WIN score badge (below AC info)
      if (winScore) {
        slide.addShape(pptx.ShapeType.rect, {
          x, y: y + 0.51, w: 0.95, h: 0.18,
          fill: { color: '#1A1A1A' }, line: { color: B.red, width: 1 }
        });
        slide.addText(`WIN  ${winScore}`, {
          x, y: y + 0.52, w: 0.95, h: 0.16,
          color: B.red, fontSize: 7.5, bold: true, align: 'center'
        });
      }

      // Divider
      if (i < Math.min(items.length, 5) - 1) {
        slide.addShape(pptx.ShapeType.line, { x, y: y + 0.78, w: colW, h: 0, line: { color: '#DDDDDD', width: 0.5 } });
      }
    });
  };

  if (top.length || bot.length) {
    renderStoreList(top, 0.25, 4.45, true);
    renderStoreList(bot, 4.9, 4.85, false);
  } else {
    slide.addText('SMG store spotlight data not available — upload SMG comments file for full analysis', {
      x: 0.25, y: 1.5, w: 9.5, h: 0.5, color: B.gray, fontSize: 11, italic: true
    });
  }
}

function makeCustomerVoice(pptx, d, weekLabel, total) {
  const slide = pptx.addSlide();
  slide.background = { color: B.dark };
  chrome(slide, pptx, `CUSTOMER VOICE  |  Actual Comments This Week`, 10, total);

  const pos = safeArr(d.positives || d.positive);
  const neg = safeArr(d.negatives || d.negative);

  // Section header bars
  slide.addShape(pptx.ShapeType.rect, { x: 0.25, y: 0.72, w: 4.35, h: 0.28, fill: { color: '#1B5E20' } });
  slide.addText(`★  DESERVES RECOGNITION  (${pos.length || 0})`, {
    x: 0.32, y: 0.73, w: 4.18, h: 0.26, color: '#FFFFFF', fontSize: 9, bold: true
  });
  slide.addShape(pptx.ShapeType.rect, { x: 4.9, y: 0.72, w: 4.85, h: 0.28, fill: { color: B.danger } });
  slide.addText(`⚠  NEEDS FOLLOW-UP  (${neg.length || 0})`, {
    x: 4.97, y: 0.73, w: 4.68, h: 0.26, color: '#FFFFFF', fontSize: 9, bold: true
  });

  const renderVoice = (items, x, colW) => {
    items.slice(0, 5).forEach((item, i) => {
      const y = 1.1 + i * 1.1;
      const store = safe(item.store || item.storeName || item.name);
      const winScore = safe(item.winScore || item.win_score || item.win || '');
      const quote = safe(
        item.quote || item.comment || item.feedback || item.review ||
        item.verbatim || item.text || item.description || item.content ||
        item.customerComment || item.customer_comment || item.customerFeedback
      );
      const ac = extractName(item) || safe(item.ac || item.acName);

      // Store name — leave room for WIN badge if present
      const storeW = winScore ? colW - 1.15 : colW;
      slide.addText(store, {
        x, y, w: storeW, h: 0.22,
        color: B.light, fontSize: 10, bold: true
      });

      // WIN score badge (right side of row)
      if (winScore) {
        slide.addShape(pptx.ShapeType.rect, {
          x: x + colW - 1.08, y: y + 0.01, w: 1.03, h: 0.21,
          fill: { color: B.mid }, line: { color: B.red, width: 1 }
        });
        slide.addText(`WIN  ${winScore}`, {
          x: x + colW - 1.08, y: y + 0.02, w: 1.03, h: 0.19,
          color: B.red, fontSize: 8, bold: true, align: 'center'
        });
      }

      // AC name
      if (ac) {
        slide.addText(ac, {
          x, y: y + 0.23, w: colW, h: 0.16,
          color: '#777777', fontSize: 8, italic: true
        });
      }

      // Verbatim customer quote
      if (quote) {
        slide.addText(`"${quote}"`, {
          x, y: y + (ac ? 0.40 : 0.26), w: colW, h: 0.63,
          color: '#CCCCCC', fontSize: 9, wrap: true, italic: true
        });
      }

      // Thin divider between items
      if (i < Math.min(items.length, 5) - 1) {
        slide.addShape(pptx.ShapeType.line, {
          x, y: y + 1.04, w: colW, h: 0,
          line: { color: '#2D2D2D', width: 0.5 }
        });
      }
    });
  };

  renderVoice(pos, 0.25, 4.45);
  renderVoice(neg, 4.9, 4.85);

  // Complaint themes — compact footer
  const themesRaw = d.themes || d.topThemes || d.complaintThemes;
  if (themesRaw) {
    let themes = '';
    if (Array.isArray(themesRaw)) {
      themes = themesRaw.map(t => {
        if (typeof t === 'string') return t;
        const label = safe(t.theme || t.name || t.label || t.topic);
        const count = safe(t.count || t.mentions || t.total || '');
        return count ? `${label} [${count}]` : label;
      }).filter(Boolean).join('   ·   ');
    } else {
      themes = safe(themesRaw);
    }
    if (themes) {
      slide.addText(`TOP COMPLAINT THEMES:   ${themes}`, {
        x: 0.25, y: 6.65, w: 9.2, h: 0.22, color: '#555555', fontSize: 8, wrap: true
      });
    }
  }
}

function makeSmartGoals(pptx, d, weekLabel, total) {
  const slide = pptx.addSlide();
  slide.background = { color: B.light };
  chrome(slide, pptx, `SMART GOALS  |  Week Ahead`, 11, total);

  const goals = safeArr(d.goals);
  if (!goals.length) {
    slide.addText('No goals data available', { x: 0.25, y: 1.5, w: 9.2, h: 0.5, color: B.gray, fontSize: 13 });
    return;
  }

  goals.slice(0, 3).forEach((g, i) => {
    const y = 0.78 + i * 2.05;

    // ── Number badge ────────────────────────────────────────────────────────
    slide.addShape(pptx.ShapeType.rect, { x: 0.25, y, w: 0.38, h: 0.38, fill: { color: B.red } });
    slide.addText(String(i + 1).padStart(2, '0'), {
      x: 0.25, y: y + 0.04, w: 0.38, h: 0.3,
      color: B.white, fontSize: 13, bold: true, align: 'center'
    });

    // ── Metric name ─────────────────────────────────────────────────────────
    slide.addText(safe(g.metric || g.name), {
      x: 0.73, y, w: 4.1, h: 0.38,
      color: B.dark, fontSize: 14, bold: true, valign: 'middle'
    });

    // ── Current → Target chips + By When ────────────────────────────────────
    const current = safe(g.current, '—');
    const target  = safe(g.target, '—');
    const byWhen  = safe(g.byWhen || g.by_when, '—');

    slide.addShape(pptx.ShapeType.rect, { x: 5.0, y: y + 0.04, w: 1.45, h: 0.3, fill: { color: '#E8E8E8' }, line: { color: '#CCCCCC', width: 0.5 } });
    slide.addText(`NOW: ${current}`, { x: 5.0, y: y + 0.06, w: 1.45, h: 0.26, color: B.dark, fontSize: 9, bold: true, align: 'center' });

    slide.addText('→', { x: 6.5, y: y + 0.06, w: 0.28, h: 0.26, color: B.red, fontSize: 13, bold: true, align: 'center' });

    slide.addShape(pptx.ShapeType.rect, { x: 6.82, y: y + 0.04, w: 1.45, h: 0.3, fill: { color: B.green }, line: { color: B.green, width: 0.5 } });
    slide.addText(`GOAL: ${target}`, { x: 6.82, y: y + 0.06, w: 1.45, h: 0.26, color: B.white, fontSize: 9, bold: true, align: 'center' });

    slide.addText(`By: ${byWhen}`, {
      x: 8.32, y: y + 0.09, w: 1.25, h: 0.2,
      color: '#888888', fontSize: 9, align: 'right'
    });

    // ── Owner line ───────────────────────────────────────────────────────────
    const owner = safe(g.owner || g.ac || g.who || '');
    let rowY = y + 0.44;
    if (owner) {
      slide.addText([
        { text: 'OWNER:  ', options: { bold: true, color: '#555555', fontSize: 9 } },
        { text: owner,      options: { color: B.dark, fontSize: 9 } }
      ], { x: 0.73, y: rowY, w: 8.85, h: 0.22, wrap: false });
      rowY += 0.24;
    }

    // ── Why it matters ───────────────────────────────────────────────────────
    const why = safe(g.why || g.impact || g.reason || '');
    if (why) {
      slide.addText([
        { text: 'WHY:  ', options: { bold: true, color: '#555555', fontSize: 9 } },
        { text: why,       options: { color: '#444444', fontSize: 9 } }
      ], { x: 0.73, y: rowY, w: 8.85, h: 0.3, wrap: true });
      rowY += 0.34;
    }

    // ── How (action plan) ────────────────────────────────────────────────────
    const how = safe(g.how || g.description || '');
    if (how) {
      slide.addText([
        { text: 'HOW:  ', options: { bold: true, color: B.red, fontSize: 9 } },
        { text: how,       options: { color: '#333333', fontSize: 9 } }
      ], { x: 0.73, y: rowY, w: 8.85, h: 0.7, wrap: true });
    }

    // ── Divider ──────────────────────────────────────────────────────────────
    if (i < Math.min(goals.length, 3) - 1) {
      slide.addShape(pptx.ShapeType.line, {
        x: 0.25, y: y + 1.97, w: 9.1, h: 0,
        line: { color: '#DDDDDD', width: 0.5 }
      });
    }
  });
}

function makeKeyDates(pptx, d, weekLabel, total) {
  const slide = pptx.addSlide();
  slide.background = { color: B.dark };
  chrome(slide, pptx, `KEY DATES & REMINDERS`, 12, total);

  slide.addText('Fill in key dates and reminders for your team before distributing this deck.', {
    x: 0.25, y: 0.75, w: 9.2, h: 0.35, color: B.gray, fontSize: 11, italic: true
  });

  const dates = safeArr(d.dates || d.items);
  const count = dates.length || 7;

  for (let i = 0; i < Math.min(count, 7); i++) {
    const y = 1.2 + i * 0.75;
    slide.addShape(pptx.ShapeType.rect, { x: 0.25, y, w: 1.6, h: 0.45, fill: { color: B.mid }, line: { color: '#444444', width: 1 } });
    slide.addText(safe(dates[i]?.date, '[DATE]'), { x: 0.25, y, w: 1.6, h: 0.45, color: B.gray, fontSize: 11, align: 'center', valign: 'middle' });
    slide.addShape(pptx.ShapeType.rect, { x: 1.95, y, w: 7.55, h: 0.45, fill: { color: B.muted }, line: { color: '#444444', width: 1 } });
    slide.addText(safe(dates[i]?.description, '[Event or reminder]'), { x: 2.05, y: y + 0.02, w: 7.3, h: 0.4, color: B.lgray, fontSize: 11, valign: 'middle' });
  }
}

function makeClosing(pptx, d, regionName, weekLabel, total) {
  const slide = pptx.addSlide();
  slide.background = { color: B.dark };

  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.5, h: '100%', fill: { color: B.red } });
  slide.addShape(pptx.ShapeType.rect, { x: 0.5, y: 0, w: '100%', h: 0.06, fill: { color: B.red } });

  const ac = d.acOfWeek || d.ac_of_week || {};
  slide.addText('🏆  AC OF THE WEEK', { x: 0.75, y: 0.4, w: 9, h: 0.35, color: B.gold, fontSize: 11, bold: true, charSpacing: 4 });
  slide.addText(safe(ac.name, '[AC Name]'), { x: 0.75, y: 0.78, w: 9, h: 0.9, color: B.light, fontSize: 38, bold: true });
  slide.addText(safe(ac.description || ac.reason, 'Outstanding performance this week.'), {
    x: 0.75, y: 1.72, w: 8.5, h: 0.7, color: B.lgray, fontSize: 13, wrap: true
  });
  slide.addText(safe(ac.note, 'Keep pushing.'), { x: 0.75, y: 2.5, w: 5, h: 0.35, color: B.gray, fontSize: 12, italic: true });
  slide.addText(`See you on the recap call — ${safe(d.recapDay || 'Thursday')}.`, {
    x: 0.75, y: 3.0, w: 6, h: 0.35, color: B.gray, fontSize: 12
  });

  // Footer stats
  const stats = safeArr(d.footerStats || d.footer_stats || d.stats);
  const defaults = [
    { label: 'IST', value: '—' }, { label: 'OTD<18', value: '—' },
    { label: 'WIN', value: '—' }, { label: 'HUT Bot', value: '—' },
    { label: 'Stores', value: '—' },
  ];
  const items = stats.length ? stats : defaults;
  const cw = 1.65, sy = 4.9, sx = 0.75, gap = 0.08;
  items.slice(0, 5).forEach((s, i) => {
    const x = sx + i * (cw + gap);
    slide.addShape(pptx.ShapeType.rect, { x, y: sy, w: cw, h: 0.9, fill: { color: B.mid }, line: { color: '#333333', width: 1 } });
    slide.addText(safe(s.label), { x, y: sy + 0.04, w: cw, h: 0.25, color: B.gray, fontSize: 8, align: 'center' });
    slide.addText(safe(s.value, '—'), { x, y: sy + 0.28, w: cw, h: 0.5, color: B.light, fontSize: 20, bold: true, align: 'center' });
  });

  slide.addText(`${regionName}  |  ${weekLabel}`, {
    x: 0.75, y: 6.75, w: 9, h: 0.2, color: '#444444', fontSize: 8, charSpacing: 2
  });
}

// ── Fallback deck ──────────────────────────────────────────────────────────────
async function generateFallbackDeck(pptx, rawText) {
  const SLIDE_TITLES = [
    'Cover', 'Region Scorecard', 'AC Performance', 'Wins This Week',
    'Focus Areas', 'Labor Deep Dive', 'Speed Outliers', 'SMG by AC',
    'SMG Spotlight', 'Customer Voice', 'Smart Goals', 'Key Dates', 'Closing'
  ];

  const cover = pptx.addSlide();
  cover.background = { color: B.dark };
  cover.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.5, h: '100%', fill: { color: B.red } });
  cover.addText('WEEKLY REGION RECAP', { x: 0.8, y: 2.1, w: 9, h: 1, color: B.light, fontSize: 42, bold: true });
  cover.addText('Powered by P.AI · Ayvaz Pizza LLC', { x: 0.8, y: 6.6, w: 9, h: 0.25, color: '#444444', fontSize: 9 });

  const words = rawText.split(' ');
  const chunkSize = Math.ceil(words.length / (SLIDE_TITLES.length - 1));

  for (let i = 1; i < SLIDE_TITLES.length; i++) {
    const slide = pptx.addSlide();
    slide.background = { color: B.dark };
    chrome(slide, pptx, SLIDE_TITLES[i], i + 1, SLIDE_TITLES.length);
    const chunk = words.slice((i - 1) * chunkSize, i * chunkSize).join(' ');
    slide.addText(chunk || '(No data available for this section)', {
      x: 0.25, y: 0.85, w: 9.3, h: 5.8, color: B.light, fontSize: 12, valign: 'top', breakLine: true, wrap: true
    });
  }

  return pptx.write({ outputType: 'nodebuffer' });
}

module.exports = { generateRecapPPTX };
