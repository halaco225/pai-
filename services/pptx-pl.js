const PptxGenJS = require('pptxgenjs');

// Default brand colors — overridden by user options
const DEFAULTS = {
  accent: '#E31837',      // Pizza Hut red
  dark: '#0D0D0D',
  mid: '#1A1A2E',
  light: '#F5F5F5',
  fontHeading: 'Montserrat',
  fontBody: 'Inter'
};

async function generatePLPPTX(analysisText, options = {}) {
  const pptx = new PptxGenJS();

  // Apply user customization
  const accent = options.accentColor || DEFAULTS.accent;
  const bgColor = options.bgColor || DEFAULTS.dark;
  const logoBase64 = options.logoBase64 || null;

  pptx.layout = 'LAYOUT_WIDE'; // 16:9
  pptx.author = 'P.AI by Ayvaz Pizza';

  // ── Slide 1: Cover ──────────────────────────────────────────────────────
  const cover = pptx.addSlide();
  cover.background = { color: bgColor };

  // Accent bar
  cover.addShape(pptx.ShapeType.rect, {
    x: 0, y: 0, w: 0.4, h: '100%',
    fill: { color: accent }
  });

  // Logo if provided
  if (logoBase64) {
    cover.addImage({ data: logoBase64, x: 0.7, y: 0.4, w: 2, h: 0.8 });
  }

  cover.addText('PERIOD-END', {
    x: 0.7, y: 1.8, w: 9, h: 0.5,
    color: accent, fontSize: 13, bold: true, charSpacing: 6
  });
  cover.addText('P&L ANALYSIS', {
    x: 0.7, y: 2.3, w: 9, h: 1.2,
    color: DEFAULTS.light, fontSize: 52, bold: true
  });
  cover.addText('Powered by P.AI · Ayvaz Pizza LLC', {
    x: 0.7, y: 3.8, w: 9, h: 0.4,
    color: '#888888', fontSize: 11
  });

  // ── Parse analysis into sections ────────────────────────────────────────
  const sections = parseAnalysisSections(analysisText);

  // ── Slides 2+: Content ──────────────────────────────────────────────────
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
      color: '#555555', fontSize: 10, align: 'right'
    });

    // Section title
    slide.addText(section.title.toUpperCase(), {
      x: 0.4, y: 0.3, w: 9, h: 0.5,
      color: accent, fontSize: 11, bold: true, charSpacing: 4
    });

    // Divider line
    slide.addShape(pptx.ShapeType.line, {
      x: 0.4, y: 0.85, w: 9.2, h: 0,
      line: { color: '#333333', width: 1 }
    });

    // Body content
    slide.addText(section.content, {
      x: 0.4, y: 1.0, w: 9.2, h: 4.5,
      color: DEFAULTS.light, fontSize: 14, valign: 'top',
      breakLine: true, wrap: true
    });

    // Footer
    slide.addText('P.AI · CONFIDENTIAL', {
      x: 0.4, y: 6.8, w: 9, h: 0.25,
      color: '#444444', fontSize: 8, charSpacing: 2
    });
  });

  // Generate buffer
  const buffer = await pptx.write({ outputType: 'nodebuffer' });
  return buffer;
}

// ── Helper: split analysis text into titled sections ─────────────────────

function parseAnalysisSections(text) {
  const sections = [];
  // Split on common heading patterns (numbered, ALL CAPS, markdown ##)
  const lines = text.split('\n');
  let currentTitle = 'Executive Summary';
  let currentContent = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Detect headings: lines starting with #, or ALL CAPS short lines, or numbered
    const isHeading =
      /^#{1,3}\s+/.test(trimmed) ||
      /^\d+\.\s+[A-Z]/.test(trimmed) ||
      (trimmed.length < 60 && trimmed === trimmed.toUpperCase() && trimmed.length > 4);

    if (isHeading && currentContent.length > 0) {
      sections.push({
        title: currentTitle,
        content: currentContent.join('\n').trim()
      });
      currentTitle = trimmed.replace(/^#{1,3}\s+/, '').replace(/^\d+\.\s+/, '');
      currentContent = [];
    } else if (isHeading) {
      currentTitle = trimmed.replace(/^#{1,3}\s+/, '').replace(/^\d+\.\s+/, '');
    } else {
      currentContent.push(line);
    }
  }

  // Push last section
  if (currentContent.length > 0) {
    sections.push({ title: currentTitle, content: currentContent.join('\n').trim() });
  }

  // If no sections parsed, return full text as one slide
  if (sections.length === 0) {
    return [{ title: 'Analysis Results', content: text }];
  }

  // Limit to ~10 content slides (truncate overly long text per slide)
  return sections.slice(0, 10).map(s => ({
    ...s,
    content: s.content.length > 800 ? s.content.slice(0, 800) + '...' : s.content
  }));
}

module.exports = { generatePLPPTX };
