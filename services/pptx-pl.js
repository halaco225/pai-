const PptxGenJS = require('pptxgenjs');

const THEMES = {
  'command-dark':   { bg: '#1A1A1A', accent: '#CC0000', text: '#F5F5F5', sub: '#AAAAAA', line: '#333333', foot: '#444444' },
  'clean-white':    { bg: '#FFFFFF', accent: '#CC0000', text: '#1A1A1A', sub: '#555555', line: '#DDDDDD', foot: '#999999' },
  'maroon':         { bg: '#3D0C0C', accent: '#F9A825', text: '#FFF8F0', sub: '#CC9966', line: '#5A1313', foot: '#884422' },
  'royal-white':    { bg: '#003594', accent: '#FFFFFF', text: '#FFFFFF', sub: '#AABFE8', line: '#1A55BC', foot: '#4477CC' },
  'purple-gold':    { bg: '#2D0A5E', accent: '#F5C518', text: '#FAF5FF', sub: '#B89ECC', line: '#3D1278', foot: '#6633AA' },
  'forest-gold':    { bg: '#1A4731', accent: '#B8960C', text: '#F2FAF5', sub: '#88BB99', line: '#235E40', foot: '#448855' },
  'navy-orange':    { bg: '#0D1B2A', accent: '#E85D04', text: '#FFF8F2', sub: '#8899AA', line: '#1F3347', foot: '#334455' },
  'black-gold':     { bg: '#0F0F0F', accent: '#C9A84C', text: '#FAFAF5', sub: '#AAAAAA', line: '#2D2D2D', foot: '#444444' },
  'slate-teal':     { bg: '#1C3A4A', accent: '#00B4D8', text: '#F0F8FA', sub: '#88AACC', line: '#264D61', foot: '#3A6678' },
  'crimson-silver': { bg: '#6B0F1A', accent: '#A8A9AD', text: '#FFF5F6', sub: '#CC8899', line: '#8B1525', foot: '#AA3344' },
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
