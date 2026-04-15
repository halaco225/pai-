const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { requireAuth, requireRole } = require('../middleware/auth');

// Single global alignment file — stored in uploads/ as a known filename
const UPLOADS_DIR = path.join(__dirname, '../uploads');
const ALIGN_FILE = path.join(UPLOADS_DIR, '_master_alignment.xlsx');

// Ensure uploads dir exists (it should already, but be safe)
try { if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true }); } catch {}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => cb(null, '_master_alignment.xlsx')
});

const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

// GET — check if a global alignment file exists
router.get('/status', requireAuth, (req, res) => {
  try {
    if (!fs.existsSync(ALIGN_FILE)) return res.json({ hasFile: false });
    const stat = fs.statSync(ALIGN_FILE);
    res.json({ hasFile: true, updatedAt: stat.mtime });
  } catch { res.json({ hasFile: false }); }
});

// POST — upload/replace the global alignment file (RDO and VP only)
router.post('/upload', requireRole('rdo', 'vp'), upload.single('alignmentFile'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided.' });
  res.json({ success: true });
});

// DELETE — remove global alignment file (RDO and VP only)
router.delete('/clear', requireRole('rdo', 'vp'), (req, res) => {
  try { if (fs.existsSync(ALIGN_FILE)) fs.unlinkSync(ALIGN_FILE); } catch {}
  res.json({ success: true });
});

// Internal helper — get alignment file path (used by recap route)
function getAlignmentPath() {
  try {
    if (fs.existsSync(ALIGN_FILE)) return ALIGN_FILE;
  } catch {}
  return null;
}

module.exports = router;
module.exports.getAlignmentPath = getAlignmentPath;
