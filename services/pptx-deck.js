// Renders a Claude-designed deck spec into pptxgenjs slides.
//
// Claude returns { deck: { title, subtitle, footer, slides: [ {layout, ...}, ... ] } }
// and decides how many slides there are, their order, and which layout each uses.
// Anything it sends that this file does not understand falls back to a bullets
// slide rather than disappearing — a wrong-looking slide beats a missing one.

const { C } = require('./pptx-theme');

const W = 13.33;            // LAYOUT_WIDE
const H = 7.5;
const PAD = 0.22;
const BODY_TOP = 0.82;      // first usable y under the header band
const BODY_BOT = 7.18;      // top of the footer line

const LAYOUTS = ['cover', 'metrics', 'table', 'cards', 'bridge', 'bullets', 'twoColumn', 'callout', 'quotes', 'closing'];

// ─── helpers ───────────────────────────────────────────────────────────────

const str = (v, fallback = '') => (v === 0 ? '0' : (v == null ? fallback : String(v)));
const arr = (v) => (Array.isArray(v) ? v : []);

// Shrink the font when the text is long so it stays inside its box instead of
// spilling over the next shape. pptxgenjs has no measure pass, so this is a
// character-count approximation tuned against the reference deck.
function fit(text, capacity, base, min = 7) {
  const len = String(text || '').length;
  if (len <= capacity) return base;
  const scaled = base * Math.sqrt(capacity / len);
  return Math.max(min, Math.round(scaled * 2) / 2);
}

function accentColor(key) {
  const k = String(key || '').toLowerCase();
  if (['critical', 'red', 'bad', 'headwind', 'down', 'miss', 'risk', 'behind'].includes(k)) return C.red;
  if (['high', 'amber', 'warn', 'watch', 'caution', 'flat'].includes(k)) return C.amber;
  if (['green', 'good', 'tailwind', 'up', 'win', 'ahead', 'on track'].includes(k)) return C.green;
  if (['info', 'note', 'gray', 'grey'].includes(k)) return C.gray;
  return C.navy;
}

function header(pptx, slide, title, eyebrow) {
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: W, h: 0.62, fill: { color: C.navy }, line: { type: 'none' } });
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0.62, w: W, h: 0.05, fill: { color: C.gold }, line: { type: 'none' } });
  slide.addText(str(title), {
    x: 0.3, y: 0.1, w: eyebrow ? 9.6 : 12.7, h: 0.46,
    color: C.white, fontSize: fit(title, 70, 13.5, 10), bold: true, fontFace: 'Arial Black', valign: 'middle',
  });
  if (eyebrow) {
    slide.addText(str(eyebrow).toUpperCase(), {
      x: 10.0, y: 0.1, w: 3.03, h: 0.46,
      color: C.gold, fontSize: 8, bold: true, charSpacing: 1.5, align: 'right', valign: 'middle',
    });
  }
}

function footer(slide, label) {
  if (!label) return;
  slide.addText(str(label), { x: 0.3, y: 7.23, w: 12.7, h: 0.22, color: C.gray, fontSize: 7.5, charSpacing: 1 });
}

function newSlide(pptx, spec, title, foot, eyebrow) {
  const slide = pptx.addSlide();
  slide.background = { color: C.light };
  header(pptx, slide, title, eyebrow);
  footer(slide, foot);
  if (spec && spec.notes) slide.addNotes(str(spec.notes));
  return slide;
}

// Split a list across as many slides as it needs. Returns [[items, slideIndex]].
function paginate(items, perSlide) {
  const out = [];
  for (let i = 0; i < items.length; i += perSlide) out.push(items.slice(i, i + perSlide));
  return out.length ? out : [[]];
}

function contTitle(title, page, total) {
  return total > 1 ? `${str(title)} (${page + 1}/${total})` : str(title);
}

function card(pptx, slide, { x, y, w, h, accent }) {
  slide.addShape(pptx.ShapeType.rect, { x, y, w, h, fill: { color: C.white }, line: { color: C.border, width: 1 } });
  if (accent) slide.addShape(pptx.ShapeType.rect, { x, y, w, h: 0.06, fill: { color: accent }, line: { type: 'none' } });
}

// ─── layouts ───────────────────────────────────────────────────────────────

function lCover(pptx, s, ctx) {
  const slide = pptx.addSlide();
  slide.background = { color: C.navy };
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 3.02, w: W, h: 0.07, fill: { color: C.gold }, line: { type: 'none' } });

  if (ctx.logoBase64) {
    try { slide.addImage({ data: ctx.logoBase64, x: 0.6, y: 0.5, w: 1.5, h: 1.5, sizing: { type: 'contain', w: 1.5, h: 1.5 } }); } catch (_) {}
  }
  if (s.eyebrow) {
    slide.addText(str(s.eyebrow).toUpperCase(), { x: 0.75, y: 2.1, w: 11.8, h: 0.3, color: C.gold, fontSize: 11, bold: true, charSpacing: 3 });
  }
  slide.addText(str(s.title, ctx.title), {
    x: 0.75, y: 2.4, w: 11.8, h: 0.62, color: C.white,
    fontSize: fit(s.title || ctx.title, 46, 30, 18), bold: true, fontFace: 'Arial Black',
  });
  slide.addText(str(s.subtitle, ctx.subtitle), {
    x: 0.75, y: 3.25, w: 11.8, h: 0.5, color: C.white, fontSize: 14,
  });

  const meta = arr(s.meta).slice(0, 4);
  meta.forEach((m, i) => {
    const x = 0.75 + i * 3.05;
    slide.addText(str(m.label).toUpperCase(), { x, y: 4.3, w: 2.85, h: 0.25, color: C.gold, fontSize: 8, bold: true, charSpacing: 1.5 });
    slide.addText(str(m.value), { x, y: 4.55, w: 2.85, h: 0.6, color: C.white, fontSize: fit(m.value, 14, 20, 11), bold: true, fontFace: 'Arial Black' });
    if (m.sub) slide.addText(str(m.sub), { x, y: 5.15, w: 2.85, h: 0.4, color: C.lgray, fontSize: 9 });
  });

  if (ctx.footer) slide.addText(str(ctx.footer), { x: 0.75, y: 6.75, w: 11.8, h: 0.3, color: C.gray, fontSize: 8.5, charSpacing: 1 });
}

function lMetrics(pptx, s, ctx) {
  const slide = newSlide(pptx, s, s.title || 'Headline', ctx.footer, s.eyebrow);
  const metrics = arr(s.metrics).slice(0, 5);
  const n = Math.max(metrics.length, 1);
  const gap = 0.2;
  const cW = (W - PAD * 2 - gap * (n - 1)) / n;
  const cH = 1.6, cY = BODY_TOP;

  metrics.forEach((m, i) => {
    const x = PAD + i * (cW + gap);
    card(pptx, slide, { x, y: cY, w: cW, h: cH, accent: accentColor(m.trend || m.tier) });
    slide.addText(str(m.label).toUpperCase(), { x: x + 0.14, y: cY + 0.15, w: cW - 0.28, h: 0.26, color: C.gray, fontSize: 7.5, bold: true, charSpacing: 1 });
    slide.addText(str(m.value, '—'), { x: x + 0.1, y: cY + 0.43, w: cW - 0.2, h: 0.68, color: C.navy, fontSize: fit(m.value, 9, 26, 14), bold: true, fontFace: 'Arial Black' });
    const sub = m.delta || m.vsPY || m.sub;
    if (sub) slide.addText(str(sub), { x: x + 0.14, y: cY + 1.13, w: cW - 0.28, h: 0.4, color: accentColor(m.trend) === C.navy ? C.dk : accentColor(m.trend), fontSize: fit(sub, 34, 8.5, 7), wrap: true });
  });

  const items = arr(s.narrative).length ? arr(s.narrative) : arr(s.items);
  const boxY = cY + (metrics.length ? cH + 0.18 : 0);
  const boxH = BODY_BOT - boxY;
  if (items.length) {
    slide.addShape(pptx.ShapeType.rect, { x: PAD, y: boxY, w: W - PAD * 2, h: boxH, fill: { color: C.white }, line: { color: C.border, width: 1 } });
    slide.addShape(pptx.ShapeType.rect, { x: PAD, y: boxY, w: 0.07, h: boxH, fill: { color: C.gold }, line: { type: 'none' } });
    slide.addText(str(s.narrativeTitle, 'KEY TAKEAWAYS').toUpperCase(), { x: PAD + 0.22, y: boxY + 0.1, w: 6, h: 0.26, color: C.navy, fontSize: 7.5, bold: true, charSpacing: 2 });
    const total = items.map(t => (typeof t === 'string' ? t : t.text || '')).join(' ').length;
    slide.addText(items.map(t => ({ text: typeof t === 'string' ? t : str(t.text), options: { breakLine: true } })), {
      x: PAD + 0.22, y: boxY + 0.38, w: W - PAD * 2 - 0.44, h: boxH - 0.5,
      color: C.dk, fontSize: fit(total, 620, 11.5, 8), valign: 'top',
      lineSpacingMultiple: 1.45, bullet: { type: 'bullet', indent: 10 },
    });
  }
}

function lTable(pptx, s, ctx) {
  const cols = arr(s.columns).map(c => (typeof c === 'string' ? { label: c } : c));
  const rows = arr(s.rows);
  if (!cols.length) return lBullets(pptx, { ...s, items: rows.map(r => ({ text: Array.isArray(r) ? r.join(' · ') : str(r) })) }, ctx);

  const hasNote = !!s.note;
  const perSlide = Number(s.rowsPerSlide) || (rows.length > 16 ? 15 : rows.length || 1);
  const pages = paginate(rows, perSlide);

  // Column widths: explicit, else first column wide and the rest even.
  const totalW = W - PAD * 2;
  let widths = cols.map(c => Number(c.width) || 0);
  if (widths.some(w => !w)) {
    const first = cols.length > 2 ? 2.6 : totalW / cols.length;
    const rest = (totalW - first) / (cols.length - 1 || 1);
    widths = cols.map((_, i) => (i === 0 ? first : rest));
  }
  const scale = totalW / widths.reduce((a, b) => a + b, 0);
  widths = widths.map(w => w * scale);

  pages.forEach((page, p) => {
    const slide = newSlide(pptx, s, contTitle(s.title || 'Detail', p, pages.length), ctx.footer, s.eyebrow);
    let y = BODY_TOP;
    if (s.subtitle) {
      slide.addText(str(s.subtitle), { x: PAD, y, w: totalW, h: 0.3, color: C.gray, fontSize: 10 });
      y += 0.34;
    }

    const bottom = hasNote ? BODY_BOT - 0.62 : BODY_BOT;
    const rowH = Math.min(0.5, Math.max(0.26, (bottom - y - 0.34) / Math.max(page.length, 1)));
    const fontSize = rowH < 0.32 ? 8 : 9.5;

    const body = page.map((row, ri) => {
      // Claude sometimes sends a bare value where a row should be — show it in
      // the first column rather than losing the line.
      const r = (row && typeof row === 'object') ? row : [str(row)];
      const cells = Array.isArray(r) ? r : (Array.isArray(r.cells) ? r.cells : cols.map(c => r[c.key || c.label]));
      const tier = Array.isArray(r) ? null : (r.tier || r.severity || r.status);
      const isTotal = !Array.isArray(r) && (r.total === true || /total/i.test(str(r.label)));
      return cells.map((cell, ci) => ({
        text: str(cell, '—'),
        options: {
          align: ci === 0 ? 'left' : (cols[ci] && cols[ci].align) || 'center',
          bold: isTotal || ci === 0,
          color: isTotal ? C.navy : (ci === 0 && tier ? accentColor(tier) : C.dk),
          fill: { color: isTotal ? C.lgray : (ri % 2 ? C.light : C.white) },
          fontSize,
        },
      }));
    });

    const head = cols.map((c, i) => ({
      text: str(c.label).toUpperCase(),
      options: { align: i === 0 ? 'left' : c.align || 'center', bold: true, color: C.white, fill: { color: C.navy }, fontSize: 7.5, charSpacing: 0.3 },
    }));

    slide.addTable([head, ...body], {
      x: PAD, y, w: totalW, colW: widths,
      rowH, border: { type: 'solid', color: C.border, pt: 0.5 },
      valign: 'middle', autoPage: false,
    });

    if (hasNote && p === pages.length - 1) {
      slide.addText(str(s.note), {
        x: PAD, y: BODY_BOT - 0.56, w: totalW, h: 0.52,
        color: C.dk, fontSize: fit(s.note, 190, 9.5, 7.5), italic: true, valign: 'top', wrap: true,
      });
    }
  });
}

function lCards(pptx, s, ctx) {
  const cards = arr(s.cards).length ? arr(s.cards) : arr(s.items);
  const perSlide = Number(s.cardsPerSlide) || 4;
  const pages = paginate(cards, perSlide);

  pages.forEach((page, p) => {
    const slide = newSlide(pptx, s, contTitle(s.title || 'Findings', p, pages.length), ctx.footer, s.eyebrow);
    const cols = page.length <= 2 ? 1 : 2;
    const rowsN = Math.ceil(page.length / cols) || 1;
    const gap = 0.18;
    const cW = (W - PAD * 2 - gap * (cols - 1)) / cols;
    const cH = (BODY_BOT - BODY_TOP - gap * (rowsN - 1)) / rowsN;

    page.forEach((c, i) => {
      const x = PAD + (i % cols) * (cW + gap);
      const y = BODY_TOP + Math.floor(i / cols) * (cH + gap);
      const accent = accentColor(c.severity || c.tier || c.tag);
      card(pptx, slide, { x, y, w: cW, h: cH, accent });

      const tag = c.severity || c.tag;
      let ty = y + 0.14;
      if (tag) {
        slide.addShape(pptx.ShapeType.rect, { x: x + 0.14, y: ty, w: 1.0, h: 0.22, fill: { color: accent }, line: { type: 'none' } });
        slide.addText(str(tag).toUpperCase(), { x: x + 0.14, y: ty, w: 1.0, h: 0.22, color: C.white, fontSize: 7, bold: true, align: 'center', valign: 'middle', charSpacing: 0.5 });
        ty += 0.3;
      }
      slide.addText(str(c.title), { x: x + 0.14, y: ty, w: cW - 0.28, h: 0.42, color: C.navy, fontSize: fit(c.title, 52, 12.5, 9), bold: true, valign: 'top' });
      const bodyText = c.body || c.analysis || c.text || '';
      const bodyY = ty + 0.44;
      slide.addText(str(bodyText), {
        x: x + 0.14, y: bodyY, w: cW - 0.28, h: y + cH - bodyY - 0.4,
        color: C.dk, fontSize: fit(bodyText, cols === 1 ? 560 : 330, 10.5, 7.5), valign: 'top', wrap: true, lineSpacingMultiple: 1.2,
      });
      if (c.action) {
        slide.addText(`→ ${str(c.action)}`, {
          x: x + 0.14, y: y + cH - 0.38, w: cW - 0.28, h: 0.3,
          color: C.gold, fontSize: fit(c.action, 90, 9.5, 7.5), bold: true, valign: 'middle',
        });
      }
    });
  });
}

function lBridge(pptx, s, ctx) {
  const items = arr(s.items).length ? arr(s.items) : arr(s.bridge);
  const pages = paginate(items, Number(s.rowsPerSlide) || 8);

  pages.forEach((page, p) => {
    const slide = newSlide(pptx, s, contTitle(s.title || 'Variance Bridge', p, pages.length), ctx.footer, s.eyebrow);
    const rowH = Math.min(0.72, (BODY_BOT - BODY_TOP) / Math.max(page.length, 1));
    page.forEach((it, i) => {
      const y = BODY_TOP + i * rowH;
      const dir = str(it.direction || (String(it.varianceDollars || it.value || '').trim().startsWith('-') ? 'headwind' : 'tailwind'));
      const col = accentColor(dir);
      slide.addShape(pptx.ShapeType.rect, { x: PAD, y, w: W - PAD * 2, h: rowH - 0.06, fill: { color: C.white }, line: { color: C.border, width: 1 } });
      slide.addShape(pptx.ShapeType.rect, { x: PAD, y, w: 0.07, h: rowH - 0.06, fill: { color: col }, line: { type: 'none' } });
      slide.addText(str(it.driver || it.label), { x: PAD + 0.2, y: y + 0.04, w: 3.1, h: rowH - 0.14, color: C.navy, fontSize: fit(it.driver || it.label, 30, 11, 8), bold: true, valign: 'middle' });
      slide.addText(str(it.varianceDollars || it.value, '—'), { x: PAD + 3.3, y: y + 0.04, w: 1.5, h: rowH - 0.14, color: col, fontSize: 12, bold: true, fontFace: 'Arial Black', align: 'right', valign: 'middle' });
      slide.addText(str(it.bpsImpact ? `${it.bpsImpact} bps` : it.impact, ''), { x: PAD + 4.9, y: y + 0.04, w: 1.1, h: rowH - 0.14, color: C.gray, fontSize: 9.5, align: 'right', valign: 'middle' });
      slide.addText(str(it.explanation || it.note), { x: PAD + 6.15, y: y + 0.04, w: W - PAD * 2 - 6.35, h: rowH - 0.14, color: C.dk, fontSize: fit(it.explanation || it.note, 120, 10, 7.5), valign: 'middle', wrap: true });
    });
  });
}

function lBullets(pptx, s, ctx) {
  const items = arr(s.items);
  const pages = paginate(items, Number(s.itemsPerSlide) || 7);

  pages.forEach((page, p) => {
    const slide = newSlide(pptx, s, contTitle(s.title || 'Detail', p, pages.length), ctx.footer, s.eyebrow);
    let y = BODY_TOP;
    if (s.subtitle) { slide.addText(str(s.subtitle), { x: PAD, y, w: W - PAD * 2, h: 0.3, color: C.gray, fontSize: 10 }); y += 0.36; }
    const rowH = Math.min(0.9, (BODY_BOT - y) / Math.max(page.length, 1));
    page.forEach((raw, i) => {
      const it = typeof raw === 'string' ? { text: raw } : raw;
      const yy = y + i * rowH;
      const accent = accentColor(it.tier || it.severity || it.tag);
      slide.addShape(pptx.ShapeType.rect, { x: PAD, y: yy, w: W - PAD * 2, h: rowH - 0.08, fill: { color: C.white }, line: { color: C.border, width: 1 } });
      slide.addShape(pptx.ShapeType.rect, { x: PAD, y: yy, w: 0.07, h: rowH - 0.08, fill: { color: accent }, line: { type: 'none' } });
      const hasHeading = !!it.heading;
      if (hasHeading) {
        slide.addText(str(it.heading), { x: PAD + 0.22, y: yy + 0.06, w: W - PAD * 2 - 0.44, h: 0.26, color: C.navy, fontSize: fit(it.heading, 70, 11, 8.5), bold: true });
      }
      slide.addText(str(it.text || it.body), {
        x: PAD + 0.22, y: yy + (hasHeading ? 0.32 : 0.06), w: W - PAD * 2 - 0.44, h: rowH - (hasHeading ? 0.44 : 0.2),
        color: C.dk, fontSize: fit(it.text || it.body, 200, 10.5, 7.5), valign: 'top', wrap: true,
      });
    });
  });
}

function lTwoColumn(pptx, s, ctx) {
  const slide = newSlide(pptx, s, s.title || 'Comparison', ctx.footer, s.eyebrow);
  const cW = (W - PAD * 2 - 0.2) / 2;
  [[s.left, PAD, C.green], [s.right, PAD + cW + 0.2, C.red]].forEach(([side, x, defCol]) => {
    const col = side && side.tier ? accentColor(side.tier) : defCol;
    const h = BODY_BOT - BODY_TOP;
    card(pptx, slide, { x, y: BODY_TOP, w: cW, h, accent: col });
    slide.addText(str(side && side.heading).toUpperCase(), { x: x + 0.16, y: BODY_TOP + 0.14, w: cW - 0.32, h: 0.3, color: col, fontSize: 10, bold: true, charSpacing: 1.5 });
    const items = arr(side && side.items);
    const total = items.map(t => (typeof t === 'string' ? t : `${t.heading || ''} ${t.text || ''}`)).join(' ').length;
    const lines = [];
    items.forEach(raw => {
      const it = typeof raw === 'string' ? { text: raw } : raw;
      if (it.heading) lines.push({ text: str(it.heading), options: { bold: true, color: C.navy, breakLine: true, bullet: { type: 'bullet', indent: 10 } } });
      lines.push({ text: str(it.text || it.body), options: { breakLine: true, color: C.dk, bullet: it.heading ? false : { type: 'bullet', indent: 10 }, indentLevel: it.heading ? 1 : 0 } });
    });
    if (lines.length) {
      slide.addText(lines, { x: x + 0.16, y: BODY_TOP + 0.5, w: cW - 0.32, h: h - 0.64, fontSize: fit(total, 700, 11, 7.5), valign: 'top', lineSpacingMultiple: 1.3 });
    }
  });
}

function lCallout(pptx, s, ctx) {
  const slide = newSlide(pptx, s, s.title || 'The Point', ctx.footer, s.eyebrow);
  const stmt = s.statement || s.text || '';
  slide.addShape(pptx.ShapeType.rect, { x: PAD, y: BODY_TOP, w: W - PAD * 2, h: 2.1, fill: { color: C.navy }, line: { type: 'none' } });
  slide.addShape(pptx.ShapeType.rect, { x: PAD, y: BODY_TOP, w: 0.09, h: 2.1, fill: { color: C.gold }, line: { type: 'none' } });
  slide.addText(str(stmt), {
    x: PAD + 0.35, y: BODY_TOP + 0.15, w: W - PAD * 2 - 0.7, h: 1.8,
    color: C.white, fontSize: fit(stmt, 150, 20, 12), bold: true, valign: 'middle', wrap: true,
  });
  const support = arr(s.support).length ? arr(s.support) : arr(s.items);
  if (support.length) {
    const y = BODY_TOP + 2.3;
    slide.addText(support.map(t => ({ text: typeof t === 'string' ? t : str(t.text), options: { breakLine: true } })), {
      x: PAD + 0.1, y, w: W - PAD * 2 - 0.2, h: BODY_BOT - y,
      color: C.dk, fontSize: fit(support.join(' ').length, 500, 12, 8.5), valign: 'top',
      lineSpacingMultiple: 1.5, bullet: { type: 'bullet', indent: 12 },
    });
  }
}

function lQuotes(pptx, s, ctx) {
  const quotes = arr(s.quotes).length ? arr(s.quotes) : arr(s.items);
  const pages = paginate(quotes, Number(s.quotesPerSlide) || 4);
  pages.forEach((page, p) => {
    const slide = newSlide(pptx, s, contTitle(s.title || 'Customer Voice', p, pages.length), ctx.footer, s.eyebrow);
    const rowH = (BODY_BOT - BODY_TOP) / Math.max(page.length, 1);
    page.forEach((raw, i) => {
      const q = typeof raw === 'string' ? { text: raw } : raw;
      const y = BODY_TOP + i * rowH;
      const accent = accentColor(q.sentiment || q.tier);
      card(pptx, slide, { x: PAD, y, w: W - PAD * 2, h: rowH - 0.12, accent: null });
      slide.addShape(pptx.ShapeType.rect, { x: PAD, y, w: 0.07, h: rowH - 0.12, fill: { color: accent }, line: { type: 'none' } });
      slide.addText(`“${str(q.text || q.quote)}”`, {
        x: PAD + 0.22, y: y + 0.08, w: W - PAD * 2 - 0.44, h: rowH - 0.46,
        color: C.dk, fontSize: fit(q.text || q.quote, 210, 11.5, 8), italic: true, valign: 'top', wrap: true,
      });
      const src = [q.store, q.date, q.score != null ? `score ${q.score}` : null].filter(Boolean).join(' · ');
      if (src) slide.addText(src, { x: PAD + 0.22, y: y + rowH - 0.4, w: W - PAD * 2 - 0.44, h: 0.26, color: C.gray, fontSize: 8.5, bold: true });
    });
  });
}

function lClosing(pptx, s, ctx) {
  const slide = pptx.addSlide();
  slide.background = { color: C.navy };
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 1.55, w: W, h: 0.07, fill: { color: C.gold }, line: { type: 'none' } });
  slide.addText(str(s.title, 'What Happens Next'), { x: 0.75, y: 0.9, w: 11.8, h: 0.6, color: C.white, fontSize: fit(s.title, 40, 26, 16), bold: true, fontFace: 'Arial Black' });
  const items = arr(s.items);
  if (items.length) {
    slide.addText(items.map(t => ({ text: typeof t === 'string' ? t : `${t.heading ? t.heading + ' — ' : ''}${str(t.text)}`, options: { breakLine: true } })), {
      x: 0.85, y: 1.95, w: 11.6, h: 4.4,
      color: C.white, fontSize: fit(items.join(' ').length, 520, 13, 9), valign: 'top',
      lineSpacingMultiple: 1.6, bullet: { type: 'bullet', indent: 14 },
    });
  }
  if (s.signoff || ctx.footer) {
    slide.addText(str(s.signoff || ctx.footer), { x: 0.85, y: 6.6, w: 11.6, h: 0.4, color: C.gold, fontSize: 10, charSpacing: 1 });
  }
}

const RENDERERS = {
  cover: lCover, metrics: lMetrics, table: lTable, cards: lCards, bridge: lBridge,
  bullets: lBullets, twoColumn: lTwoColumn, callout: lCallout, quotes: lQuotes, closing: lClosing,
};

// ─── entry point ───────────────────────────────────────────────────────────

function hasDeckSpec(data) {
  return !!(data && data.deck && Array.isArray(data.deck.slides) && data.deck.slides.length);
}

function renderDeck(pptx, deck, options = {}) {
  const ctx = {
    title:    deck.title || options.title || '',
    subtitle: deck.subtitle || options.subtitle || '',
    footer:   deck.footer || options.footer || '',
    logoBase64: options.logoBase64 || null,
  };
  let rendered = 0;
  arr(deck.slides).forEach((s, i) => {
    const fn = RENDERERS[s && s.layout] || lBullets;
    try {
      fn(pptx, s || {}, ctx);
      rendered++;
    } catch (err) {
      // One bad slide must not cost the whole deck.
      console.error(`[pptx-deck] slide ${i} (${s && s.layout}) failed: ${err.message}`);
      const slide = newSlide(pptx, null, str(s && s.title, `Slide ${i + 1}`), ctx.footer);
      slide.addText('This slide could not be rendered. The underlying analysis is still in the on-screen summary.', {
        x: PAD, y: BODY_TOP, w: W - PAD * 2, h: 1, color: C.red, fontSize: 12,
      });
    }
  });
  return rendered;
}

module.exports = { renderDeck, hasDeckSpec, LAYOUTS, fit, accentColor };
