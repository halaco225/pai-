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

// Helper: auto-calculate the next Thursday (or today if today IS Thursday)
function getRecapDay() {
  const days = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const today = new Date();
  const dow = today.getDay(); // 0=Sun, 4=Thu
  if (dow === 4) return 'Thursday'; // today is Thursday
  const diff = (4 - dow + 7) % 7;
  const next = new Date(today);
  next.setDate(today.getDate() + diff);
  return days[next.getDay()]; // will always be Thursday
}

// ── POST /api/recap/analyze ────────────────────────────────────────────────────
// Step 1: Upload files → analyze with Claude → return JSON preview data
router.post('/analyze', requireAuth, upload.array('files', 10), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'At least one report file is required.' });
  }

  try {
    const { analyzeRecap } = require('../services/claude');
    const recapDay = getRecapDay();

    const data = await analyzeRecap(req.files, '', recapDay);

    res.json({
      data,
      fileCount: req.files.length,
      fileNames: req.files.map(f => f.originalname).join(', ')
    });
  } catch (err) {
    console.error('Recap analyze error:', err);
    res.status(500).json({ error: err.message || 'Analysis failed.' });
  } finally {
    if (req.files) req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch {} });
  }
});

// ── POST /api/recap/build ──────────────────────────────────────────────────────
// Step 2: Take JSON data → build PPTX → return file
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

// ── POST /api/recap/email ──────────────────────────────────────────────────────
// Generate email recap from JSON data
router.post('/email', requireAuth, async (req, res) => {
  try {
    const { generateRecapEmail } = require('../services/claude');
    const { data, tone, length } = req.body;
    if (!data) return res.status(400).json({ error: 'No data provided.' });

    const result = await generateRecapEmail(data, { tone, length });
    res.json(result);
  } catch (err) {
    console.error('Recap email error:', err);
    res.status(500).json({ error: err.message || 'Email generation failed.' });
  }
});

// ── POST /api/recap/generate ───────────────────────────────────────────────────
// Legacy one-shot route (kept for backward compatibility)
router.post('/generate', requireAuth, upload.array('files', 10), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'At least one report file is required.' });
  }

  try {
    const { analyzeRecap } = require('../services/claude');
    const { generateRecapPPTX } = require('../services/pptx-recap');

    const analysis  = await analyzeRecap(req.files, '', getRecapDay());
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
