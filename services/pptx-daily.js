const PptxGenJS = require('pptxgenjs');

// ── Brand colors ──────────────────────────────────────────────────────────────
const DARK   = '#1A1A1A';
const MID    = '#2A2A2A';
const MUTED  = '#3A3A3A';
const RED    = '#CC0000';
const WHITE  = '#FFFFFF';
const LIGHT  = '#F5F5F5';
const LGRAY  = '#BBBBBB';
const GRAY   = '#888888';
const GREEN  = '#2E7D32';
const YELLOW = '#F57F17';
const DANGER = '#C62828';

// ── Parse markdown into sections ──────────────────────────────────────────────
function parseMarkdownSections(text) {
  const sections = [];
  const lines = text.split('\n');
  let cur = null;

  for (const raw of lines) {
    const line = raw.trim();

    if (line.startsWith('## ')) {
      if (cur) sections.push(cur);
      // Strip emoji and clean title
      cur = {
        title: line
          .replace(/^## /, '')
          .replace(/[\u{1F300}-\u{1FAFF}]/gu, '')
          .replace(/[⚠️✅📊🎯🔗📋]/g, '')
          .trim(),
        items: []
      };
      continue;
    }

    if (!cur || !line) continue;

    // Bullet: "- **Label:** rest" or "- plain text"
    const bulletMatch = line.match(/^[-*•]\s+(.+)/);
    if (bulletMatch) {
      const inner = bulletMatch[1];
      const boldLabel = inner.match(/^\*\*([^*]+)\*\*[:\s]+(.+)/);
      if (boldLabel) {
        cur.items.push({ type: 'bullet', label: boldLabel[1].replace(/:$/, ''), text: boldLabel[2] });
      } else {
        cur.items.push({ type: 'bullet', text: inner.replace(/\*\*/g, '') });
      }
      continue;
    }

    // Bold label without bullet: "**Label:** text"
    const boldLine = line.match(/^\*\*([^*]+)\*\*[:\s]+(.+)/);
    if (boldLine) {
      cur.items.push({ type: 'labeled', label: boldLine[1].replace(/:$/, ''), text: boldLine[2] });
      continue;
    }

    // Plain paragraph (skip heading lines starting with #)
    if (!line.startsWith('#') && line.length > 3) {
      cur.items.push({ type: 'para', text: line.replace(/\*\*/g, '') });
    }
  }

  if (cur) sections.push(cur);
  return sections;
}

// ── Slide chrome (left bar + header bar + title + slide number) ───────────────
function addChrome(pptx, slide, title, slideNum, total) {
  slide.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.08, h: '100%', fill: { color: RED } });
  slide.addShape(pptx.ShapeType.rect, { x: 0.08, y: 0, w: '100%', h: 0.62, fill: { color: MID } });
  slide.addText(title.toUpperCase(), {
    x: 0.25, y: 0.1, w: 8.7, h: 0.42,
    color: WHITE, fontSize: 11, bold: true, charSpacing: 3
  });
  slide.addText(`${slideNum} / ${total}`, {
    x: 9.05, y: 0.1, w: 0.85, h: 0.42,
    color: GRAY, fontSize: 9, align: 'right'
  });
}

// ── Section icon mapping ──────────────────────────────────────────────────────
const SECTION_META = {
  'DAILY INTEL SUMMARY':    { dark: true,  icon: '🎯' },
  'KEY METRICS':            { dark: false, icon: '📊' },
  'WINS':                   { dark: false, icon: '✅' },
  'WATCH LIST':             { dark: false, icon: '⚠️' },
  'CONNECTIONS & INSIGHTS': { dark: false, icon: '🔗' },
  'ACTION ITEMS':           { dark: true,  icon: '📋' },
};

function getSectionMeta(title) {
  const key = Object.keys(SECTION_META).find(k => title.toUpperCase().includes(k));
  return SECTION_META[key] || { dark: false, icon: '•' };
}

// ── Render a content slide ────────────────────────────────────────────────────
function renderContentSlide(pptx, slide, section, isDark) {
  const textColor  = isDark ? LGRAY   : '#333333';
  const labelColor = isDark ? WHITE   : DARK;
  const bulletDot  = isDark ? LGRAY   : RED;

  let y = 0.80;
  const MAX_Y = 6.8;

  for (const item of section.items) {
    if (y >= MAX_Y) break;

    if (item.type === 'para') {
      slide.addText(item.text, {
        x: 0.35, y, w: 9.1, h: 0.55,
        color: textColor, fontSize: 11, wrap: true, italic: true
      });
      y += 0.60;

    } else if (item.type === 'labeled') {
      // Bold label + body text side by side
      slide.addText([
        { text: item.label + ':  ', options: { bold: true, color: labelColor, fontSize: 11 } },
        { text: item.text,          options: { color: textColor,  fontSize: 11 } }
      ], { x: 0.35, y, w: 9.1, h: 0.55, wrap: true });
      y += 0.65;

    } else if (item.type === 'bullet') {
      // Red square bullet dot
      slide.addShape(pptx.ShapeType.rect, {
        x: 0.35, y: y + 0.2, w: 0.09, h: 0.09,
        fill: { color: bulletDot }
      });

      if (item.label) {
        slide.addText([
          { text: item.label + ':  ', options: { bold: true, color: labelColor, fontSize: 11 } },
          { text: item.text,          options: { color: textColor,  fontSize: 11 } }
        ], { x: 0.53, y, w: 8.93, h: 0.55, wrap: true });
      } else {
        slide.addText(item.text, {
          x: 0.53, y, w: 8.93, h: 0.55,
          color: textColor, fontSize: 11, wrap: true
        });
      }
      y += 0.62;
    }

    // Thin divider between items on light slides
    if (!isDark && y < MAX_Y - 0.3) {
      slide.addShape(pptx.ShapeType.line, {
        x: 0.35, y: y - 0.05, w: 9.1, h: 0,
        line: { color: '#DDDDDD', width: 0.3 }
      });
    }
  }
}

// ── Main export ───────────────────────────────────────────────────────────────
async function generateDailyIntelPPTX(analysisText) {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';

  const sections = parseMarkdownSections(analysisText);
  const total = sections.length + 1; // +1 for title slide

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
  });

  // ── Slide 1: Title ──────────────────────────────────────────────────────────
  const title = pptx.addSlide();
  title.background = { color: DARK };
  title.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.18, h: '100%', fill: { color: RED } });
  title.addShape(pptx.ShapeType.rect, { x: 0.18, y: 0, w: '100%', h: 0.08, fill: { color: MID } });
  title.addText('DAILY INTEL REPORT', {
    x: 0.45, y: 1.8, w: 9.0, h: 1.0,
    color: WHITE, fontSize: 40, bold: true, charSpacing: 5
  });
  title.addText(dateStr, {
    x: 0.45, y: 2.9, w: 9.0, h: 0.45,
    color: LGRAY, fontSize: 16
  });
  title.addText('Ayvaz Pizza LLC  ·  P.AI Operational Intelligence', {
    x: 0.45, y: 3.45, w: 9.0, h: 0.3,
    color: GRAY, fontSize: 11
  });
  // Red accent line under subtitle
  title.addShape(pptx.ShapeType.line, {
    x: 0.45, y: 3.82, w: 3.5, h: 0,
    line: { color: RED, width: 1.5 }
  });

  // ── Content slides ──────────────────────────────────────────────────────────
  sections.forEach((section, idx) => {
    const meta   = getSectionMeta(section.title);
    const isDark = meta.dark;
    const slide  = pptx.addSlide();
    slide.background = { color: isDark ? DARK : LIGHT };

    addChrome(pptx, slide, `${meta.icon}  ${section.title}`, idx + 2, total);
    renderContentSlide(pptx, slide, section, isDark);
  });

  const buffer = await pptx.write({ outputType: 'nodebuffer' });
  return buffer;
}

module.exports = { generateDailyIntelPPTX };
