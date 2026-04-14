const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { requireAuth } = require('../middleware/auth');

// Multer config for weekly recap uploads (up to 6 files)
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '../uploads')),
  filename: (req, file, cb) => {
    const ts = Date.now();
    cb(null, `recap_${ts}_${Math.random().toString(36).slice(2)}_${file.originalname}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.xlsx', '.xls', '.pdf', '.csv', '.docx'];
    const ext = path.extname(file.originalname).toLowerCase();
    if (allowed.includes(ext)) cb(null, true);
    else cb(new Error('Unsupported file type.'));
  }
});

// POST /api/recap/generate — upload 6 files and generate 13-slide deck
router.post('/generate', requireAuth, upload.array('files', 6), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'No files uploaded.' });
  }

  try {
    const { analyzeRecap } = require('../services/claude');
    const { generateRecapPPTX } = require('../services/pptx-recap');

    // Extract text from all uploaded files
    const weekLabel = req.body.weekLabel || '';
    const recapDay = req.body.recapDay || 'Thursday';
    const analysis = await analyzeRecap(req.files, weekLabel, recapDay);

    // Generate the 13-slide PPTX
    const pptxBuffer = await generateRecapPPTX(analysis);

    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'Content-Disposition': 'attachment; filename="P.AI_Weekly_Recap.pptx"'
    });
    res.send(pptxBuffer);
  } catch (err) {
    console.error('Recap generation error:', err);
    res.status(500).json({ error: err.message || 'Recap generation failed.' });
  }
});

module.exports = router;
