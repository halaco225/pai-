const PptxGenJS = require('pptxgenjs');

const THEMES = {
  'command-dark': { bg: '#0D0D0D', accent: '#E31837', text: '#F5F5F5', sub: '#AAAAAA', line: '#333333', foot: '#444444' },
  'navy-gold':    { bg: '#0F1F3D', accent: '#C9A84C', text: '#F0EDE6', sub: '#9BAEC8', line: '#1E3A5F', foot: '#5A7A9A' },
  'clean-white':  { bg: '#FFFFFF', accent: '#E31837', text: '#1A1A1A', sub: '#555555', line: '#DDDDDD', foot: '#999999' },
  'slate-blue':   { bg: '#1A2744', accent: '#60A5FA', text: '#F0F4FF', sub: '#94A3B8', line: '#2A3F6F', foot: '#4A6090' },
  'obsidian':     { bg: '#111827', accent: '#F59E0B', text: '#F9FAFB', sub: '#9CA3AF', line: '#2D3748', foot: '#4B5563' },
};

async function generatePLPPTX(analysisText, options = {}) {
  const pptx = new PptxGenJS();

  // Resolve theme
  const theme = THEMES[options.theme] || THEMES['command-dark'];
  const accent    = options.accentColor || theme.accent;
  const bgColor   = options.bgColor    || theme.bg;
  const textColor = theme.text;
  const subColor  = theme.sub;
  const lineColor = theme.line;
  const footColor = theme.foot;
  const logoBase64 = options.logoBase64 || null;

  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'P.AI by Ayvaz Pizza';

  // ── Slide 1: Cover ───────────────────────────────────────────────────────
  const cover = pptx.addSlide();
  cover.background = { color: bgColor };

  // Accent bar
  cover.addShape(pptx.ShapeType.rect, {
    x: 0, y: 0, w: 0.4, h: '100%',
    fill: { color: accent }
  });

  // Logo
  if (logoBase64) {
    cover.addImage({ data: logoBase64, x: 0.7, y: 0.35, w: 2.2, h: 0.9, sizing: { type: 'contain', w: 2.2, h: 0.9 } });
  }

  cover.addText('PERIOD-END', {
    x: 0.7, y: 1.8, w: 9, h: 0.5,
    color: accent, fontSize: 13, bold: true, charSpacing: 6
  });
  cover.addText('P&L ANALYSIS', {
    x: 0.7, y: 2.25, w: 9, h: 1.2,
    color: textColor, fontSize: 52, bold: true
  });
  cover.addText('Powered by P.AI · Ayvaz Pizza LLC', {
    x: 0.7, y: 3.8, w: 9, h: 0.4,
    color: subColor, fontSize: 11
  });

  // ── Parse analysis into sections ─────────────────────────────────────────
  const sections = parseAnalysisSections(analysisText);

  // ── Content Slides ────────────────────────────────────────────────────────
  sections.forEach((section, i) => {
    const slide = pptx.addSlide();
    slide.background = { color: bgColor };

    // Accent left bar
    slide.addShape(pptx.ShapeType.rect, {
      x: 0, y: 0, w: 0.08, h: '100%',
      fill: { color: accent }
    });

    // Slide number
    slide.addText(`${String(i + 2).padStart(2, '0')}`, {
      x: 8.8, y: 0.2, w: 0.8, h: 0.35,
      color: subColor, fontSize: 10, align: 'right'
    });

    // Section title
    slide.addText(section.title.toUpperCase(), {
      x: 0.4, y: 0.3, w: 9, h: 0.5,
      color: accent, fontSize: 11, bold: true, charSpacing: 4
    });

    // Divider
    slide.addShape(pptx.ShapeType.line, {
      x: 0.4, y: 0.85, w: 9.2, h: 0,
      line: { color: lineColor, width: 1 }
    });

    // Body
    slide.addText(section.content, {
      x: 0.4, y: 1.0, w: 9.2, h: 4.5,
      color: textColor, fontSize: 14, valign: 'top',
      breakLine: true, wrap: true
    });

    // Footer
    slide.addText('P.AI · CONFIDENTIAL · AYVAZ PIZZA LLC', {
      x: 0.4, y: 6.8, w: 9, h: 0.25,
      color: footColor, fontSize: 8, charSpacing: 2
    });
  });

  const buffer = await pptx.write({ outputType: 'nodebuffer' });
  return buffer;
}

function parseAnalysisSections(text) {
  const sections = [];
  const lines = text.split('\n');
  let currentTitle = 'Executive Summary';
  let currentContent = [];

  for (const line of lines) {
    const trimmed = line.trim();
    const isHeading =
      /^#{1,3}\s+/.test(trimmed) ||
      /^\d+\.\s+[A-Z]/.test(trimmed) ||
      (trimmed.length < 60 && trimmed === trimmed.toUpperCase() && trimmed.length > 4);

    if (isHeading && currentContent.length > 0) {
      sections.push({ title: currentTitle, content: currentContent.join('\n').trim() });
      currentTitle = trimmed.replace(/^#{1,3}\s+/, '').replace(/^\d+\.\s+/, '');
      currentContent = [];
    } else if (isHeading) {
      currentTitle = trimmed.replace(/^#{1,3}\s+/, '').replace(/^\d+\.\s+/, '');
    } else {
      currentContent.push(line);
    }
  }

  if (currentContent.length > 0) {
    sections.push({ title: currentTitle, content: currentContent.join('\n').trim() });
  }

  if (sections.length === 0) {
    return [{ title: 'Analysis Results', content: text }];
  }

  return sections.slice(0, 10).map(s => ({
    ...s,
    content: s.content.length > 800 ? s.content.slice(0, 800) + '...' : s.content
  }));
}

module.exports = { generatePLPPTX };
