const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const { requireAuth, requireRole } = require('../middleware/auth');
const { saveAlignment, getAlignment, clearAlignment } = require('../services/db');

const upload = multer({
  dest: path.join(__dirname, '../uploads'),
  limits: { fileSize: 25 * 1024 * 1024 }
});

function extractAlignmentText(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  if (['.xlsx', '.xls', '.csv'].includes(ext)) {
    const workbook = XLSX.readFile(filePath);
    let text = '';
    workbook.SheetNames.forEach(sheetName => {
      const sheet = workbook.Sheets[sheetName];
      const rows = XLSX.utils.sheet_to_csv(sheet).split('\n');
      text += '=== Sheet: ' + sheetName + ' ===\n';
      text += rows.join('\n') + '\n';
    });
    return text;
  }
  return fs.readFileSync(filePath, 'utf8');
}

// GET status — check if alignment is stored in DB
router.get('/status', requireAuth, async (req, res) => {
  try {
    const row = await getAlignment();
    if (row == null) return res.json({ hasFile: false });
    res.json({
      hasFile: true,
      fileName: row.file_name,
      updatedBy: row.updated_by,
      updatedAt: row.created_at
    });
  } catch (err) {
    console.error('[Alignment] Status error:', err.message);
    res.json({ hasFile: false });
  }
});

// POST upload — RDO and VP only
router.post('/upload', requireRole('rdo', 'vp'), upload.single('alignmentFile'), async (req, res) => {
  if (req.file == null) return res.status(400).json({ error: 'No file provided.' });
  try {
    const contentText = extractAlignmentText(req.file.path, req.file.originalname);
    await saveAlignment({
      updatedBy: req.session.user.username,
      fileName: req.file.originalname,
      contentText
    });
    res.json({ success: true, fileName: req.file.originalname });
  } catch (err) {
    console.error('[Alignment] Upload error:', err.message);
    res.status(500).json({ error: 'Failed to save alignment: ' + err.message });
  } finally {
    try { fs.unlinkSync(req.file.path); } catch (e) {}
  }
});

// DELETE clear — RDO and VP only
router.delete('/clear', requireRole('rdo', 'vp'), async (req, res) => {
  try {
    await clearAlignment();
    res.json({ success: true });
  } catch (err) {
    console.error('[Alignment] Clear error:', err.message);
    res.status(500).json({ error: 'Failed to clear alignment.' });
  }
});

module.exports = router;
