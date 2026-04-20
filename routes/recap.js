const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { requireAuth } = require('../middleware/auth');
const { MASTER_ALIGNMENT_TEXT } = require('../services/alignment-data');
const { getAlignment } = require('../services/db');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '../uploads')),
  filename: (req, file, cb) => {
    const ts = Date.now();
    cb(null, 'recap_' + ts + '_' + Math.random().toString(36).slice(2) + '_' + file.originalname);
  }
});

const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function withRetry(fn, maxAttempts = 5) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const status = err.status || (err.error && err.error.status);
      const isRateLimit = status === 429 || (err.message && err.message.includes('rate_limit'));
      if (isRateLimit && attempt < maxAttempts) {
        const retryAfter = err.headers && err.headers['retry-after'];
        const delay = retryAfter ? parseInt(retryAfter) * 1000 : 30000 * attempt;
        console.log('Rate limit hit (attempt ' + attempt + '/' + maxAttempts + '). Retrying in ' + (delay / 1000) + 's...');
        await sleep(delay);
      } else {
        throw err;
      }
    }
  }
}

function getRecapDay() {
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const today = new Date();
  const dow = today.getDay();
  if (dow === 4) return 'Thursday';
  const diff = (4 - dow + 7) % 7;
  const next = new Date(today);
  next.setDate(today.getDate() + diff);
  return days[next.getDay()];
}

router.post('/analyze', requireAuth, upload.array('files', 10), async (req, res) => {
  if (req.files == null || req.files.length === 0) {
    return res.status(400).json({ error: 'At least one report file is required.' });
  }
  try {
    const { analyzeRecap } = require('../services/claude');
    const recapDay = getRecapDay();
    const lastAcOfWeek = req.body.lastAcOfWeek || null;

    // Use DB override if uploaded, otherwise use built-in alignment (always current)
    const alignRow = await getAlignment();
    const alignmentText = (alignRow && alignRow.content_text) ? alignRow.content_text : MASTER_ALIGNMENT_TEXT;
    console.log('[Recap] Alignment source: ' + (alignRow ? 'DB upload' : 'built-in'));

    const data = await withRetry(() => analyzeRecap(req.files, '', recapDay, lastAcOfWeek, alignmentText));
    res.json({ data, fileCount: req.files.length, fileNames: req.files.map(f => f.originalname).join(', ') });
  } catch (err) {
    console.error('Recap analyze error:', err);
    res.status(500).json({ error: err.message || 'Analysis failed.' });
  } finally {
    if (req.files) req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch (e) {} });
  }
});

router.post('/build', requireAuth, async (req, res) => {
  try {
    const { generateRecapPPTX } = require('../services/pptx-recap');
    const { data, theme } = req.body;
    if (data == null) return res.status(400).json({ error: 'No data provided.' });
    const pptxBuffer = await generateRecapPPTX(data, { theme });
    const weekLabel = (data.weekLabel || 'Weekly').replace(/[^a-zA-Z0-9]/g, '_');
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'Content-Disposition': 'attachment; filename="P.AI_Region_Recap_' + weekLabel + '.pptx"'
    });
    res.send(pptxBuffer);
  } catch (err) {
    console.error('Recap build error:', err);
    res.status(500).json({ error: err.message || 'PPTX generation failed.' });
  }
});

router.post('/email', requireAuth, async (req, res) => {
  try {
    const { generateRecapEmail } = require('../services/claude');
    const { data, tone, length } = req.body;
    if (data == null) return res.status(400).json({ error: 'No data provided.' });
    const result = await withRetry(() => generateRecapEmail(data, { tone, length }));
    res.json(result);
  } catch (err) {
    console.error('Recap email error:', err);
    res.status(500).json({ error: err.message || 'Email generation failed.' });
  }
});

router.post('/generate', requireAuth, upload.array('files', 10), async (req, res) => {
  if (req.files == null || req.files.length === 0) {
    return res.status(400).json({ error: 'At least one report file is required.' });
  }
  try {
    const { analyzeRecap } = require('../services/claude');
    const { generateRecapPPTX } = require('../services/pptx-recap');
    const alignRow = await getAlignment();
    const alignmentText = (alignRow && alignRow.content_text) ? alignRow.content_text : MASTER_ALIGNMENT_TEXT;
    const analysis = await withRetry(() => analyzeRecap(req.files, '', getRecapDay(), null, alignmentText));
    const pptxBuffer = await generateRecapPPTX(analysis);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'Content-Disposition': 'attachment; filename="P.AI_Weekly_Recap.pptx"'
    });
    res.send(pptxBuffer);
  } catch (err) {
    console.error('Recap generation error:', err);
    res.status(500).json({ error: err.message || 'Recap generation failed.' });
  } finally {
    if (req.files) req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch (e) {} });
  }
});

module.exports = router;
