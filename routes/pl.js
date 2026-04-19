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

// POST /api/pl/analyze
// Routes to the right analyzer based on the logged-in user's role:
//   area_coach -> analyzePLForAC  (returns single acDeepDive object, 8-slide deck)
//   rdo / vp   -> analyzePL       (returns full region JSON, region + AC deep dives)
router.post('/analyze', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded.' });

  const role = req.session.user.role;
  const name = req.session.user.name;

  try {
    const { analyzePL, analyzePLForAC } = require('../services/claude');

    let result;
    if (role === 'area_coach') {
      result = await analyzePLForAC(req.file, name);
    } else {
      result = await analyzePL(req.file);
    }

    res.json({ success: true, analysis: result, role });
  } catch (err) {
    console.error('P&L analysis error:', err);
    res.status(500).json({ error: err.message || 'Analysis failed.' });
  }
});

// POST /api/pl/generate-pptx
// Routes to the right builder based on the logged-in user's role:
//   area_coach -> generateACPPTX  (8-slide AC deep dive)
//   rdo / vp   -> generatePLPPTX  (7 region slides + per-AC deep dives)
router.post('/generate-pptx', requireAuth, express.json({ limit: '10mb' }), async (req, res) => {
  const { analysis, options } = req.body;
  if (!analysis) return res.status(400).json({ error: 'Analysis data required.' });

  const role = req.session.user.role;
  const name = req.session.user.name;

  try {
    const { generatePLPPTX, generateACPPTX } = require('../services/pptx-pl');

    let pptxBuffer;
    let filename;
    if (role === 'area_coach') {
      pptxBuffer = await generateACPPTX(analysis, options || {});
      const safeName = name.replace(/[^a-zA-Z0-9]/g, '_');
      filename = `P.AI_${safeName}_Area_Deep_Dive.pptx`;
    } else {
      pptxBuffer = await generatePLPPTX(analysis, options || {});
      filename = 'P.AI_PL_Analysis.pptx';
    }

    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'Content-Disposition': `attachment; filename="${filename}"`
    });
    res.send(pptxBuffer);
  } catch (err) {
    console.error('PPTX generation error:', err);
    res.status(500).json({ error: err.message || 'PPTX generation failed.' });
  }
});

module.exports = router;
