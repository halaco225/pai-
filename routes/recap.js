const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { requireAuth } = require('../middleware/auth');

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '../uploads')),
  filename: (req, file, cb) => {
    const ts = Date.now();
    cb(null, `recap_${ts}_${Math.random().toString(36).slice(2)}_${file.originalname}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }
});

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
        console.log(`Rate limit hit (attempt ${attempt}/${maxAttempts}). Retrying in ${delay / 1000}s...`);
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
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'At least one report file is required.' });
  }
  let alignTempFile = null;
  try {
    const { analyzeRecap } = require('../services/claude');
    const { getAlignmentPath } = require('./alignment');
    const recapDay = getRecapDay();
    const lastAcOfWeek = req.body.lastAcOfWeek || null;

    // Auto-inject stored alignment file if one exists for this user
    let allFiles = [...req.files];
    const alignPath = getAlignmentPath(req.session.user.username);
    if (alignPath) {
      const alignStat = require('fs').statSync(alignPath);
      alignTempFile = { path: alignPath, originalname: 'Master_Alignment.xlsx', size: alignStat.size, mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', skipDelete: true };
      allFiles = [...allFiles, alignTempFile];
      console.log(`Auto-injecting alignment file for ${req.session.user.username}`);
    }

    const data = await withRetry(() => analyzeRecap(allFiles, '', recapDay, lastAcOfWeek));
    res.json({ data, fileCount: req.files.length, fileNames: req.files.map(f => f.originalname).join(', ') });
  } catch (err) {
    console.error('Recap analyze error:', err);
    res.status(500).json({ error: err.message || 'Analysis failed.' });
  } finally {
    if (req.files) req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch {} });
    // Do NOT delete the stored alignment file
  }
});

router.post('/build', requireAuth, async (req, res) => {
  try {
    const { generateRecapPPTX } = require('../services/pptx-recap');
    const { data, theme } = req.body;
    if (!data) return res.status(400).json({ error: 'No data provided.' });
    const pptxBuffer = await generateRecapPPTX(data, { theme });
    const weekLabel = (data.weekLabel || 'Weekly').replace(/[^a-zA-Z0-9]/g, '_');
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'Content-Disposition': `attachment; filename="P.AI_Region_Recap_${weekLabel}.pptx"`
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
    if (!data) return res.status(400).json({ error: 'No data provided.' });
    await sleep(65000);
    const result = await withRetry(() => generateRecapEmail(data, { tone, length }));
    res.json(result);
  } catch (err) {
    console.error('Recap email error:', err);
    res.status(500).json({ error: err.message || 'Email generation failed.' });
  }
});

router.post('/generate', requireAuth, upload.array('files', 10), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'At least one report file is required.' });
  }
  try {
    const { analyzeRecap } = require('../services/claude');
    const { generateRecapPPTX } = require('../services/pptx-recap');
    const analysis   = await withRetry(() => analyzeRecap(req.files, '', getRecapDay()));
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
    if (req.files) req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch {} });
  }
});

module.exports = router;
