const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { requireAuth } = require('../middleware/auth');

const ALIGN_DIR = path.join(__dirname, '../alignment');
if (!fs.existsSync(ALIGN_DIR)) fs.mkdirSync(ALIGN_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, ALIGN_DIR),
  filename: (req, file, cb) => {
    const username = req.session.user.username;
    const ext = path.extname(file.originalname);
    cb(null, `${username}_alignment${ext}`);
  }
});

const upload = multer({ storage, limits: { fileSize: 25 * 1024 * 1024 } });

// GET — check if user has a stored alignment file
router.get('/status', requireAuth, (req, res) => {
  const username = req.session.user.username;
  const files = fs.readdirSync(ALIGN_DIR).filter(f => f.startsWith(`${username}_alignment`));
  if (files.length === 0) return res.json({ hasFile: false });
  const filePath = path.join(ALIGN_DIR, files[0]);
  const stat = fs.statSync(filePath);
  res.json({ hasFile: true, filename: files[0], updatedAt: stat.mtime });
});

// POST — upload/replace the stored alignment file
router.post('/upload', requireAuth, upload.single('alignmentFile'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided.' });
  res.json({ success: true, filename: req.file.filename });
});

// DELETE — remove stored alignment file
router.delete('/clear', requireAuth, (req, res) => {
  const username = req.session.user.username;
  const files = fs.readdirSync(ALIGN_DIR).filter(f => f.startsWith(`${username}_alignment`));
  files.forEach(f => { try { fs.unlinkSync(path.join(ALIGN_DIR, f)); } catch {} });
  res.json({ success: true });
});

// Internal helper — get alignment file path for a user (used by recap route)
function getAlignmentPath(username) {
  if (!fs.existsSync(ALIGN_DIR)) return null;
  const files = fs.readdirSync(ALIGN_DIR).filter(f => f.startsWith(`${username}_alignment`));
  if (files.length === 0) return null;
  return path.join(ALIGN_DIR, files[0]);
}

module.exports = router;
module.exports.getAlignmentPath = getAlignmentPath;
