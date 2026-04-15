const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { requireAuth } = require('../middleware/auth');
const { analyzeDaily, analyzeTrends, generateDailyIntelEmail } = require('../services/claude');
const { generateDailyIntelPPTX } = require('../services/pptx-daily');
const { saveAnalysis, getHistory, getRecentDaily, getAnalysisById } = require('../services/db');

const upload = multer({
  dest: path.join(__dirname, '../uploads'),
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
        console.log('[Daily] Rate limit hit (attempt ' + attempt + '/' + maxAttempts + '). Retrying in ' + (delay / 1000) + 's...');
        await sleep(delay);
      } else {
        throw err;
      }
    }
  }
}

// POST /api/daily/analyze
router.post('/analyze', requireAuth, upload.array('files', 10), async (req, res) => {
  if (req.files == null || req.files.length === 0) {
    return res.status(400).json({ error: 'At least one report file is required.' });
  }

  try {
    console.log('[Daily] Analyzing ' + req.files.length + ' file(s) for ' + req.session.user.username + ': ' + req.files.map(f => f.originalname).join(', '));
    const analysis = await withRetry(() => analyzeDaily(req.files));
    const reportNames = req.files.map(f => f.originalname).join(', ');

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
      savedId: saved && saved.id ? saved.id : null,
      savedAt: saved && saved.created_at ? saved.created_at : null
    });
  } catch (err) {
    const stack1 = err.stack ? err.stack.split('\n')[1] : '';
    console.error('[Daily] Analysis error (status=' + err.status + ', code=' + err.code + '):', err.message, stack1);
    res.status(500).json({ error: 'Analysis failed.', message: err.message || String(err) });
  } finally {
    req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch (e) {} });
  }
});

// GET /api/daily/history
router.get('/history', requireAuth, async (req, res) => {
  try {
    const history = await getHistory(req.session.user.username, 30);
    res.json({ history });
  } catch (err) {
    console.error('History error:', err);
    res.status(500).json({ error: 'Could not load history.' });
  }
});

// GET /api/daily/history/:id
router.get('/history/:id', requireAuth, async (req, res) => {
  try {
    const record = await getAnalysisById(req.params.id, req.session.user.username);
    if (record == null) return res.status(404).json({ error: 'Not found.' });
    res.json({ record });
  } catch (err) {
    res.status(500).json({ error: 'Could not load record.' });
  }
});

// POST /api/daily/trends
router.post('/trends', requireAuth, async (req, res) => {
  try {
    const days = parseInt(req.body.days) || 14;
    const recentReports = await getRecentDaily(req.session.user.username, days);

    if (recentReports.length < 2) {
      return res.json({
        analysis: '## Not Enough Data\n\nAt least 2 daily intel sessions are needed to identify trends.',
        reportCount: recentReports.length
      });
    }

    const analysis = await withRetry(() => analyzeTrends(recentReports));
    res.json({ analysis, reportCount: recentReports.length, days });
  } catch (err) {
    console.error('Trends error:', err);
    res.status(500).json({ error: 'Trend analysis failed.', message: err.message });
  }
});

// POST /api/daily/email
router.post('/email', requireAuth, async (req, res) => {
  try {
    const { analysisText, tone, length } = req.body;
    if (analysisText == null) return res.status(400).json({ error: 'No analysis text provided.' });
    const result = await generateDailyIntelEmail(analysisText, { tone, length });
    res.json(result);
  } catch (err) {
    console.error('Daily email error:', err);
    res.status(500).json({ error: err.message || 'Email generation failed.' });
  }
});

// POST /api/daily/pptx
router.post('/pptx', requireAuth, async (req, res) => {
  try {
    const { analysisText } = req.body;
    if (analysisText == null) return res.status(400).json({ error: 'No analysis text provided.' });
    const buffer = await generateDailyIntelPPTX(analysisText);
    const dateStr = new Date().toISOString().slice(0, 10);
    const filename = 'Daily_Intel_' + dateStr + '.pptx';
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
    res.setHeader('Content-Disposition', 'attachment; filename="' + filename + '"');
    res.send(buffer);
  } catch (err) {
    console.error('Daily PPTX error:', err);
    res.status(500).json({ error: err.message || 'PPTX generation failed.' });
  }
});

m