const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { requireAuth } = require('../middleware/auth');
const { analyzeDaily, analyzeTrends } = require('../services/claude');
const { saveAnalysis, getHistory, getRecentDaily, getAnalysisById } = require('../services/db');

const upload = multer({
  dest: path.join(__dirname, '../uploads'),
  limits: { fileSize: 25 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.xlsx', '.xls', '.csv', '.pdf', '.txt'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  }
});

// ── POST /api/daily/analyze ───────────────────────────────────────────────────
router.post('/analyze', requireAuth, upload.array('files', 10), async (req, res) => {
  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ error: 'At least one report file is required.' });
  }

  try {
    const analysis = await analyzeDaily(req.files);
    const reportNames = req.files.map(f => f.originalname).join(', ');

    // Auto-save to history
    const saved = await saveAnalysis({
      username: req.session.user.username,
      userName: req.session.user.name,
      module: 'daily',
      reportNames,
      analysisText: analysis
    });

    res.json({
      analysis,
      fileCount: req.files.length,
      savedId: saved?.id || null,
      savedAt: saved?.created_at || null
    });
  } catch (err) {
    console.error('Daily analysis error:', err);
    res.status(500).json({ error: 'Analysis failed.', message: err.message });
  } finally {
    req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch {} });
  }
});

// ── GET /api/daily/history ────────────────────────────────────────────────────
router.get('/history', requireAuth, async (req, res) => {
  try {
    const history = await getHistory(req.session.user.username, 30);
    res.json({ history });
  } catch (err) {
    console.error('History error:', err);
    res.status(500).json({ error: 'Could not load history.' });
  }
});

// ── GET /api/daily/history/:id ────────────────────────────────────────────────
router.get('/history/:id', requireAuth, async (req, res) => {
  try {
    const record = await getAnalysisById(req.params.id, req.session.user.username);
    if (!record) return res.status(404).json({ error: 'Not found.' });
    res.json({ record });
  } catch (err) {
    res.status(500).json({ error: 'Could not load record.' });
  }
});

// ── POST /api/daily/trends ────────────────────────────────────────────────────
router.post('/trends', requireAuth, async (req, res) => {
  try {
    const days = parseInt(req.body.days) || 14;
    const recentReports = await getRecentDaily(req.session.user.username, days);

    if (recentReports.length < 2) {
      return res.json({
        analysis: '## ⚠️ Not Enough Data\n\nAt least 2 daily intel sessions are needed to identify trends. Run Daily Intel for a few days and come back.',
        reportCount: recentReports.length
      });
    }

    const analysis = await analyzeTrends(recentReports);
    res.json({ analysis, reportCount: recentReports.length, days });
  } catch (err) {
    console.error('Trends error:', err);
    res.status(500).json({ error: 'Trend analysis failed.', message: err.message });
  }
});

module.exports = router;
