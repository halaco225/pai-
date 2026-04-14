const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { requireAuth } = require('../middleware/auth');
const { analyzeDaily } = require('../services/claude');

const upload = multer({
  dest: path.join(__dirname, '../uploads'),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.xlsx', '.xls', '.csv', '.pdf', '.txt'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  }
});

// POST /api/daily/analyze
router.post('/analyze', requireAuth, upload.array('files', 10), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'At least one report file is required.' });
  }

  try {
    const analysis = await analyzeDaily(req.files);
    res.json({ analysis, fileCount: req.files.length });
  } catch (err) {
    console.error('Daily analysis error:', err);
    res.status(500).json({ error: 'Analysis failed.', message: err.message });
  } finally {
    // Clean up uploaded files
    req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch {} });
  }
});

module.exports = router;
