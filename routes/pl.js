const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { requireAuth } = require('../middleware/auth');
const { MASTER_ALIGNMENT_TEXT } = require('../services/alignment-data');
const { getAlignment } = require('../services/db');

const UPLOAD_DIR = '/tmp/uploads';
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ts = Date.now();
    cb(null, `pl_${ts}_${file.fieldname}_${file.originalname}`);
  }
});
const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

// POST /api/pl/analyze
router.post('/analyze', requireAuth, upload.fields([
  { name: 'file',   maxCount: 1 },
  { name: 'ledger', maxCount: 1 }
]), async (req, res) => {
  const plFile   = req.files?.file?.[0];
  const glFile   = req.files?.ledger?.[0];
  if (!plFile) return res.status(400).json({ error: 'No P&L file uploaded.' });

  const role         = req.session.user.role;
  const name         = req.session.user.name;
  const scope        = req.session.user.scope || null;
  const level        = req.body.level        || (role === 'area_coach' ? 'area' : 'region');
  const scopeTarget  = req.body.scopeTarget  || '';
  const instructions = req.body.instructions || '';

  try {
    const { analyzePL } = require('../services/claude');

    // Load alignment text (DB override or built-in)
    const alignRow = await getAlignment();
    const alignmentText = (alignRow && alignRow.content_text) ? alignRow.content_text : MASTER_ALIGNMENT_TEXT;

    const result = await analyzePL(plFile, {
      level, scopeTarget, glFile, userName: name, scope, alignmentText, instructions
    });

    res.json({ success: true, analysis: result, role, level });
  } catch (err) {
    console.error('P&L analysis error:', err);
    res.status(500).json({ error: err.message || 'Analysis failed.' });
  } finally {
    [plFile, glFile].forEach(f => { if (f) try { fs.unlinkSync(f.path); } catch (e) {} });
  }
});

// POST /api/pl/generate-pptx
router.post('/generate-pptx', requireAuth, express.json({ limit: '10mb' }), async (req, res) => {
  const { analysis, options } = req.body;
  if (!analysis) return res.status(400).json({ error: 'Analysis data required.' });

  const role  = req.session.user.role;
  const name  = req.session.user.name;
  const level = options?.level || (role === 'area_coach' ? 'area' : 'region');

  try {
    const { generatePLPPTX, generateACPPTX } = require('../services/pptx-pl');

    let pptxBuffer, filename;
    if (level === 'area' || role === 'area_coach') {
      pptxBuffer = await generateACPPTX(analysis, options || {});
      const safeName = (options?.scopeTarget || name).replace(/[^a-zA-Z0-9]/g, '_');
      filename = `P.AI_${safeName}_Area_PL.pptx`;
    } else {
      pptxBuffer = await generatePLPPTX(analysis, options || {});
      const levelTag = level === 'store' ? 'Store' : 'Region';
      filename = `P.AI_${levelTag}_PL_Analysis.pptx`;
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

// POST /api/pl/one-pager
router.post('/one-pager', requireAuth, express.json({ limit: '10mb' }), async (req, res) => {
  const { analysis, options } = req.body;
  if (!analysis) return res.status(400).json({ error: 'Analysis data required.' });
  try {
    const { generateOnePager } = require('../services/pptx-pl');
    const buf = await generateOnePager(analysis, options || {});
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="P.AI_PL_One_Pager.pdf"'
    });
    res.send(buf);
  } catch (err) {
    console.error('1-pager error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
