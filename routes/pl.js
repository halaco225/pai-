const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { requireAuth } = require('../middleware/auth');

// Multer config for P&L uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '../uploads')),
  filename: (req, file, cb) => {
    const ts = Date.now();
    cb(null, `pl_${ts}_${file.originalname}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }
});

// POST /api/pl/analyze — upload and analyze a P&L file
router.post('/analyze', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

  try {
    const { analyzePL } = require('../services/claude');
    const result = await analyzePL(req.file);
    res.json({ success: true, analysis: result });
  } catch (err) {
    console.error('P&L analysis error:', err);
    res.status(500).json({ error: err.message || 'Analysis failed.' });
  }
});

// POST /api/pl/generate-pptx — generate PowerPoint from analysis
router.post('/generate-pptx', requireAuth, express.json({ limit: '10mb' }), async (req, res) => {
  const { analysis, options } = req.body;
  if (!analysis) return res.status(400).json({ error: 'Analysis data required.' });

  try {
    const { generatePLPPTX } = require('../services/pptx-pl');
    const pptxBuffer = await generatePLPPTX(analysis, options || {});
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'Content-Disposition': 'attachment; filename="P.AI_PL_Analysis.pptx"'
    });
    res.send(pptxBuffer);
  } catch (err) {
    console.error('PPTX generation error:', err);
    res.status(500).json({ error: err.message || 'PPTX generation failed.' });
  }
});

module.exports = router;
