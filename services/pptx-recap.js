const PptxGenJS = require('pptxgenjs');

const BRAND = {
  accent: '#E31837',
  dark: '#0D0D0D',
  mid: '#111827',
  muted: '#1F2937',
  light: '#F9FAFB',
  gray: '#6B7280',
  success: '#10B981',
  warning: '#F59E0B',
  danger: '#EF4444'
};

// 13-slide structure for weekly region recap
const SLIDE_TITLES = [
  'Cover',
  'Executive Summary',
  'Sales Performance',
  'Transaction Count & Guest Count',
  'Average Check',
  'Labor Management',
  'Food Cost & COGS',
  'Controllable Expenses',
  'EBITDA & Profitability',
  'Top Performers',
  'Needs Attention',
  'Action Items & Priorities',
  'Looking Ahead'
];

async function generateRecapPPTX(data) {
  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE';
  pptx.author = 'P.AI by Ayvaz Pizza';

  // If we have raw text fallback, create simplified deck
  if (data.rawContent) {
    return generateFallbackDeck(pptx, data.rawContent);
  }

  // ── Slide 1: Cover ─────────────────────────────────────────────────────
  addCoverSlide(pptx, data);

  // ── Slides 2–13: Content ───────────────────────────────────────────────
  for (let i = 1; i < SLIDE_TITLES.length; i++) {
    const slide = pptx.addSlide();
    slide.background = { color: BRAND.dark };

    const slideKey = SLIDE_TITLES[i].toLowerCase().replace(/[^a-z]/g, '_');
    const slideData = data[slideKey] || data[i] || {};

    addSlideChrome(slide, pptx, SLIDE_TITLES[i], i + 1);
    addSlideContent(slide, pptx, slideData, i);
  }

  const buffer = await pptx.write({ outputType: 'nodebuffer' });
  return buffer;
}

function addCoverSlide(pptx, data) {
  const slide = pptx.addSlide();
  slide.background = { color: BRAND.dark };

  // Full-height accent bar
  slide.addShape(pptx.ShapeType.rect, {
    x: 0, y: 0, w: 0.5, h: '100%',
    fill: { color: BRAND.accent }
  });

  // Top accent strip
  slide.addShape(pptx.ShapeType.rect, {
    x: 0.5, y: 0, w: '100%', h: 0.06,
    fill: { color: BRAND.accent }
  });

  slide.addText('WEEKLY REGION RECAP', {
    x: 0.8, y: 1.5, w: 9, h: 0.5,
    color: BRAND.accent, fontSize: 12, bold: true, charSpacing: 6
  });
  slide.addText(data.regionName || 'AREA PERFORMANCE REPORT', {
    x: 0.8, y: 2.1, w: 9, h: 1.4,
    color: BRAND.light, fontSize: 46, bold: true
  });
  slide.addText(data.weekLabel || 'Current Period', {
    x: 0.8, y: 3.7, w: 5, h: 0.5,
    color: BRAND.gray, fontSize: 14
  });
  slide.addText('Powered by P.AI · Ayvaz Pizza LLC', {
    x: 0.8, y: 6.7, w: 9, h: 0.3,
    color: '#444444', fontSize: 9, charSpacing: 2
  });
}

function addSlideChrome(slide, pptx, title, slideNum) {
  // Left accent bar
  slide.addShape(pptx.ShapeType.rect, {
    x: 0, y: 0, w: 0.08, h: '100%',
    fill: { color: BRAND.accent }
  });

  // Slide number
  slide.addText(`${String(slideNum).padStart(2, '0')} / ${SLIDE_TITLES.length}`, {
    x: 8.5, y: 0.2, w: 1.1, h: 0.3,
    color: BRAND.gray, fontSize: 9, align: 'right'
  });

  // Title
  slide.addText(title.toUpperCase(), {
    x: 0.3, y: 0.25, w: 8, h: 0.45,
    color: BRAND.accent, fontSize: 11, bold: true, charSpacing: 4
  });

  // Divider
  slide.addShape(pptx.ShapeType.line, {
    x: 0.3, y: 0.78, w: 9.3, h: 0,
    line: { color: '#2D2D2D', width: 1 }
  });

  // Footer
  slide.addText('P.AI · CONFIDENTIAL · AYVAZ PIZZA LLC', {
    x: 0.3, y: 6.85, w: 9, h: 0.2,
    color: '#3D3D3D', fontSize: 7, charSpacing: 2
  });
}

function addSlideContent(slide, pptx, data, slideIndex) {
  if (typeof data === 'string') {
    // Simple text content
    slide.addText(data, {
      x: 0.3, y: 1.0, w: 9.3, h: 5.6,
      color: BRAND.light, fontSize: 14, valign: 'top',
      breakLine: true, wrap: true
    });
    return;
  }

  // Structured data — render key metrics as cards if present
  if (data.metrics && Array.isArray(data.metrics)) {
    const metrics = data.metrics.slice(0, 4);
    const cardW = 2.2;
    const cardH = 1.4;
    const startX = 0.3;
    const startY = 1.1;
    const gap = 0.15;

    metrics.forEach((m, i) => {
      const x = startX + i * (cardW + gap);
      slide.addShape(pptx.ShapeType.rect, {
        x, y: startY, w: cardW, h: cardH,
        fill: { color: BRAND.muted },
        line: { color: BRAND.accent, width: 1 }
      });
      slide.addText(String(m.label || ''), {
        x: x + 0.1, y: startY + 0.1, w: cardW - 0.2, h: 0.35,
        color: BRAND.gray, fontSize: 9, bold: true
      });
      slide.addText(String(m.value || ''), {
        x: x + 0.1, y: startY + 0.5, w: cardW - 0.2, h: 0.65,
        color: BRAND.light, fontSize: 26, bold: true
      });
      if (m.change) {
        const isPositive = String(m.change).startsWith('+') || parseFloat(m.change) > 0;
        slide.addText(String(m.change), {
          x: x + 0.1, y: startY + 1.15, w: cardW - 0.2, h: 0.2,
          color: isPositive ? BRAND.success : BRAND.danger, fontSize: 10
        });
      }
    });
  }

  // Narrative text below metrics
  if (data.narrative || data.summary || data.content) {
    const text = data.narrative || data.summary || data.content || '';
    const yStart = data.metrics ? 2.8 : 1.0;
    slide.addText(String(text), {
      x: 0.3, y: yStart, w: 9.3, h: 6.5 - yStart,
      color: BRAND.light, fontSize: 13, valign: 'top',
      breakLine: true, wrap: true
    });
  }

  // Bullet list
  if (data.bullets && Array.isArray(data.bullets)) {
    const yStart = data.metrics ? 2.8 : 1.0;
    const bulletText = data.bullets.map(b => ({ text: `• ${b}`, options: { breakLine: true } }));
    slide.addText(bulletText, {
      x: 0.3, y: yStart, w: 9.3, h: 6.5 - yStart,
      color: BRAND.light, fontSize: 13, valign: 'top'
    });
  }
}

async function generateFallbackDeck(pptx, rawText) {
  // Split raw text into 13 chunks for the slides
  const words = rawText.split(' ');
  const chunkSize = Math.ceil(words.length / 12);

  // Cover slide
  const cover = pptx.addSlide();
  cover.background = { color: BRAND.dark };
  cover.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: 0.5, h: '100%', fill: { color: BRAND.accent } });
  cover.addText('WEEKLY REGION RECAP', { x: 0.8, y: 2.1, w: 9, h: 1, color: BRAND.light, fontSize: 42, bold: true });

  for (let i = 1; i < SLIDE_TITLES.length; i++) {
    const slide = pptx.addSlide();
    slide.background = { color: BRAND.dark };
    addSlideChrome(slide, pptx, SLIDE_TITLES[i], i + 1);

    const chunk = words.slice((i - 1) * chunkSize, i * chunkSize).join(' ');
    slide.addText(chunk || '(No data)', {
      x: 0.3, y: 1.0, w: 9.3, h: 5.6,
      color: BRAND.light, fontSize: 13, valign: 'top', breakLine: true, wrap: true
    });
  }

  return pptx.write({ outputType: 'nodebuffer' });
}

module.exports = { generateRecapPPTX };
