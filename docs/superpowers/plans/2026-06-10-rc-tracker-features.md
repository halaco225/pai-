# RC Tracker — OAuth + Images + Follow-Ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate Gmail polling to OAuth 2.0, add photo attachments to notes everywhere, and add a dedicated Follow-Up tab with threaded notes and image support.

**Architecture:** Express backend on Render + Supabase (PostgreSQL + Storage). All new routes follow the existing `/api/*` pattern in `server.js`. Images upload through the backend (not direct browser-to-Supabase) so the service key stays server-side. Follow-ups live in a proper Supabase table (`follow_ups`) rather than the `user_data` JSON blob, enabling real filtering and queries.

**Tech Stack:** Node.js/Express, Supabase JS v2, `googleapis` (Gmail API), `multer` (multipart upload), vanilla JS SPA (`public/index.html`), Jest + supertest (backend tests)

---

## Setup: Clone the repo

```bash
git clone https://github.com/halaco225/rc-tracker.git
cd rc-tracker
npm install
```

Create a `.env` file for local dev:
```
SUPABASE_URL=<your value from Render>
SUPABASE_ANON_KEY=<your value from Render>
SUPABASE_SERVICE_KEY=<from Supabase project settings → API → service_role key>
PORT=3000
```

> `SUPABASE_SERVICE_KEY` is needed for Storage uploads (anon key can't write to buckets). Add it to Render env vars too.

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `gmail-poller.js` | Rewrite | Gmail API OAuth polling (replaces IMAP) |
| `scripts/get-gmail-token.js` | Create | One-time local script to get refresh token |
| `server.js` | Modify | Add `/api/upload-image`, `/api/follow-ups/*` routes |
| `package.json` | Modify | Add `googleapis`, `multer`, `jest`, `supertest`; remove `imap`, `mailparser` |
| `supabase/migrations/001_follow_ups.sql` | Create | `follow_ups` table DDL |
| `supabase/migrations/002_storage_bucket.sql` | Create | `note-images` storage bucket |
| `public/index.html` | Modify | Image attach UI in note modal + Follow-Ups tab |
| `tests/upload.test.js` | Create | Tests for image upload endpoint |
| `tests/followups.test.js` | Create | Tests for follow-up CRUD routes |

---

## Task 1: Update dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Update package.json**

Replace the entire `dependencies` block and add `devDependencies`:

```json
{
  "name": "rc-tracker",
  "dependencies": {
    "@supabase/supabase-js": "^2.39.0",
    "cors": "^2.8.5",
    "express": "^4.18.2",
    "googleapis": "^144.0.0",
    "multer": "^1.4.5-lts.1"
  },
  "devDependencies": {
    "jest": "^29.7.0",
    "supertest": "^6.3.4"
  },
  "scripts": {
    "start": "node server.js",
    "test": "jest --testPathPattern=tests/"
  },
  "engines": { "node": ">=18.0.0" }
}
```

- [ ] **Step 2: Install**

```bash
npm install
```

Expected: No errors. `node_modules/googleapis` and `node_modules/multer` present.

- [ ] **Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: swap imap/mailparser for googleapis+multer, add jest"
```

---

## Task 2: Gmail OAuth — one-time token script

**Files:**
- Create: `scripts/get-gmail-token.js`

This script is run **once locally** to get a refresh token. It is never deployed.

- [ ] **Step 1: Create Google Cloud project (manual — 5 min)**

1. Go to https://console.cloud.google.com
2. Create a new project — name it `rc-tracker`
3. Go to **APIs & Services → Library** → search "Gmail API" → Enable it
4. Go to **APIs & Services → Credentials → Create Credentials → OAuth 2.0 Client ID**
5. Application type: **Desktop app** → name it `rc-tracker-local`
6. Download the JSON — note `client_id` and `client_secret`
7. Go to **OAuth consent screen** → add your Gmail address as a test user

- [ ] **Step 2: Create the token script**

Create `scripts/get-gmail-token.js`:

```js
const { google } = require('googleapis');
const http = require('http');
const url = require('url');

const CLIENT_ID = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:3333/oauth2callback';

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Set GMAIL_CLIENT_ID and GMAIL_CLIENT_SECRET env vars first.');
  process.exit(1);
}

const oauth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oauth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: ['https://www.googleapis.com/auth/gmail.modify'],
  prompt: 'consent',
});

console.log('\nOpen this URL in your browser:\n\n' + authUrl + '\n');

const server = http.createServer(async (req, res) => {
  const qs = new url.URL(req.url, 'http://localhost:3333').searchParams;
  const code = qs.get('code');
  if (!code) { res.end('No code'); return; }

  const { tokens } = await oauth2Client.getToken(code);
  res.end('Done! Copy the refresh token from your terminal.');
  server.close();

  console.log('\n✅ GMAIL_REFRESH_TOKEN =', tokens.refresh_token);
  console.log('\nAdd this to Render env vars (and your local .env).\n');
});

server.listen(3333, () => console.log('Waiting for OAuth callback on port 3333...'));
```

- [ ] **Step 3: Run the script**

```bash
GMAIL_CLIENT_ID=<your_id> GMAIL_CLIENT_SECRET=<your_secret> node scripts/get-gmail-token.js
```

Open the printed URL, sign in with the Gmail account used for polling, grant access. The terminal prints your `GMAIL_REFRESH_TOKEN`.

- [ ] **Step 4: Save credentials**

Add to `.env`:
```
GMAIL_CLIENT_ID=<value>
GMAIL_CLIENT_SECRET=<value>
GMAIL_REFRESH_TOKEN=<value>
```

Add to Render env vars (Dashboard → rc-tracker service → Environment).

- [ ] **Step 5: Commit script (not credentials)**

```bash
git add scripts/get-gmail-token.js
git commit -m "chore: add one-time Gmail OAuth token helper script"
```

---

## Task 3: Rewrite gmail-poller.js

**Files:**
- Rewrite: `gmail-poller.js`

- [ ] **Step 1: Rewrite gmail-poller.js**

```js
const { google } = require('googleapis');

function buildOAuth2Client() {
  const client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET
  );
  client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  return client;
}

async function fetchUnreadMessages(gmail) {
  const res = await gmail.users.messages.list({
    userId: 'me',
    q: 'is:unread to:atlworkingfile@gmail.com',
    maxResults: 20,
  });
  return res.data.messages || [];
}

async function getMessageBody(gmail, messageId) {
  const msg = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });

  const payload = msg.data.payload;
  const headers = payload.headers || [];
  const subject = headers.find(h => h.name === 'Subject')?.value || '';
  const from = headers.find(h => h.name === 'From')?.value || '';
  const date = headers.find(h => h.name === 'Date')?.value || null;

  let body = '';
  if (payload.parts) {
    const textPart = payload.parts.find(p => p.mimeType === 'text/plain');
    if (textPart?.body?.data) {
      body = Buffer.from(textPart.body.data, 'base64').toString('utf8');
    }
  } else if (payload.body?.data) {
    body = Buffer.from(payload.body.data, 'base64').toString('utf8');
  }

  return { subject, from, body: body.trim(), date, messageId: msg.data.id };
}

async function markRead(gmail, messageId) {
  await gmail.users.messages.modify({
    userId: 'me',
    id: messageId,
    requestBody: { removeLabelIds: ['UNREAD'] },
  });
}

async function pollInbox(supabase) {
  if (!process.env.GMAIL_CLIENT_ID || !process.env.GMAIL_REFRESH_TOKEN) {
    console.warn('Gmail OAuth env vars not set — skipping poll');
    return;
  }

  const auth = buildOAuth2Client();
  const gmail = google.gmail({ version: 'v1', auth });

  const messages = await fetchUnreadMessages(gmail);
  if (messages.length === 0) return;

  for (const { id } of messages) {
    const { subject, from, body, date, messageId } = await getMessageBody(gmail, id);

    if (!body) { await markRead(gmail, messageId); continue; }

    // Extract AC name heuristic: first "proper noun" word before a verb
    // Falls back to null — user assigns manually in the UI
    const acMatch = body.match(/(?:for|re:|about)\s+([A-Z][a-z]+ [A-Z][a-z]+)/i);
    const acName = acMatch ? acMatch[1] : null;

    const { error } = await supabase.from('email_followups').upsert(
      {
        gmail_message_id: messageId,
        subject,
        sender_email: from,
        note_text: body.substring(0, 1000),
        ac_name: acName,
        received_at: date ? new Date(date).toISOString() : new Date().toISOString(),
        done: false,
      },
      { onConflict: 'gmail_message_id', ignoreDuplicates: true }
    );

    if (error) {
      console.error('Insert error:', error.message);
    } else {
      await markRead(gmail, messageId);
    }
  }
}

module.exports = { pollInbox };
```

- [ ] **Step 2: Verify server starts**

```bash
node server.js
```

Expected: `RC Tracker running on port 3000` — no crash. (Poll will log a warning if env vars aren't set yet, that's fine locally.)

- [ ] **Step 3: Commit**

```bash
git add gmail-poller.js
git commit -m "feat: migrate Gmail polling from IMAP to OAuth 2.0 (googleapis)"
```

---

## Task 4: Supabase migrations

**Files:**
- Create: `supabase/migrations/001_follow_ups.sql`
- Create: `supabase/migrations/002_storage_bucket.sql`

- [ ] **Step 1: Create follow_ups table SQL**

Create `supabase/migrations/001_follow_ups.sql`:

```sql
create table if not exists follow_ups (
  id uuid primary key default gen_random_uuid(),
  text text not null,
  assigned_to text,
  status text not null default 'open',
  source text not null default 'manual',
  due_date date,
  notes jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists follow_ups_status_idx on follow_ups(status);
create index if not exists follow_ups_created_at_idx on follow_ups(created_at desc);
```

- [ ] **Step 2: Create storage bucket SQL**

Create `supabase/migrations/002_storage_bucket.sql`:

```sql
insert into storage.buckets (id, name, public)
values ('note-images', 'note-images', true)
on conflict (id) do nothing;

create policy "Public read note-images"
  on storage.objects for select
  using ( bucket_id = 'note-images' );

create policy "Service role insert note-images"
  on storage.objects for insert
  with check ( bucket_id = 'note-images' );
```

- [ ] **Step 3: Run migrations in Supabase dashboard**

1. Go to your Supabase project → **SQL Editor**
2. Paste and run `001_follow_ups.sql`
3. Paste and run `002_storage_bucket.sql`

Expected: No errors. Confirm in **Table Editor** that `follow_ups` table exists. Confirm in **Storage** that `note-images` bucket exists and is public.

- [ ] **Step 4: Commit migration files**

```bash
git add supabase/
git commit -m "feat: add follow_ups table and note-images storage bucket migrations"
```

---

## Task 5: Image upload endpoint

**Files:**
- Modify: `server.js`
- Create: `tests/upload.test.js`

- [ ] **Step 1: Write the failing test**

Create `tests/upload.test.js`:

```js
const request = require('supertest');
const path = require('path');
const fs = require('fs');

// Mock supabase storage
const mockUpload = jest.fn().mockResolvedValue({ error: null });
const mockGetPublicUrl = jest.fn().mockReturnValue({
  data: { publicUrl: 'https://example.supabase.co/storage/v1/object/public/note-images/test.jpg' }
});

jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    storage: {
      from: () => ({
        upload: mockUpload,
        getPublicUrl: mockGetPublicUrl,
      })
    }
  })
}));

const app = require('../server');

describe('POST /api/upload-image', () => {
  it('returns 400 when no file sent', async () => {
    const res = await request(app).post('/api/upload-image');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no file/i);
  });

  it('returns 400 for non-image file', async () => {
    const res = await request(app)
      .post('/api/upload-image')
      .attach('file', Buffer.from('hello'), { filename: 'test.txt', contentType: 'text/plain' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/image/i);
  });

  it('returns url on success', async () => {
    const res = await request(app)
      .post('/api/upload-image')
      .attach('file', Buffer.from('fakejpeg'), { filename: 'photo.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(200);
    expect(res.body.url).toContain('note-images');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
npm test -- tests/upload.test.js
```

Expected: FAIL — `Cannot find module '../server'` or route not found errors.

- [ ] **Step 3: Add multer + upload route to server.js**

At the top of `server.js`, add after the existing requires:

```js
const multer = require('multer');
const { v4: uuidv4 } = require('crypto');
```

Wait — `crypto` is built-in but `v4` isn't exported that way. Use this instead:

```js
const multer = require('multer');
const crypto = require('crypto');
```

Add multer config after the `app.use(express.json(...))` line:

```js
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith('image/')) {
      return cb(Object.assign(new Error('Only image files allowed'), { status: 400 }));
    }
    cb(null, true);
  },
});
```

Add the route after the existing `/api/poll` route:

```js
// ── Upload image to Supabase Storage ──
app.post('/api/upload-image', (req, res, next) => {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(err.status || 400).json({ error: err.message });
    next();
  });
}, async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided' });

  const ext = req.file.originalname.split('.').pop() || 'jpg';
  const filename = `${crypto.randomUUID()}.${ext}`;

  const supabaseService = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY
  );

  const { error } = await supabaseService.storage
    .from('note-images')
    .upload(filename, req.file.buffer, { contentType: req.file.mimetype });

  if (error) return res.status(500).json({ error: error.message });

  const { data } = supabaseService.storage.from('note-images').getPublicUrl(filename);
  res.json({ url: data.publicUrl });
});
```

Also export `app` at the bottom of `server.js` so tests can import it:

```js
// At the very bottom, after app.listen(...)
module.exports = app;
```

- [ ] **Step 4: Run tests**

```bash
npm test -- tests/upload.test.js
```

Expected: All 3 tests PASS.

- [ ] **Step 5: Manual smoke test**

```bash
node server.js &
curl -F "file=@/path/to/any/image.jpg" http://localhost:3000/api/upload-image
```

Expected: `{"url":"https://...supabase.co/storage/v1/object/public/note-images/...jpg"}`

- [ ] **Step 6: Commit**

```bash
git add server.js tests/upload.test.js
git commit -m "feat: add POST /api/upload-image endpoint with Supabase Storage"
```

---

## Task 6: Follow-up API routes

**Files:**
- Modify: `server.js`
- Create: `tests/followups.test.js`

- [ ] **Step 1: Write failing tests**

Create `tests/followups.test.js`:

```js
const request = require('supertest');

const mockData = [];

const mockFrom = jest.fn().mockImplementation((table) => ({
  select: jest.fn().mockReturnThis(),
  eq: jest.fn().mockReturnThis(),
  order: jest.fn().mockResolvedValue({ data: mockData, error: null }),
  insert: jest.fn().mockResolvedValue({ data: [{ id: 'abc', text: 'test', status: 'open', source: 'manual', notes: [] }], error: null }),
  update: jest.fn().mockReturnThis(),
  match: jest.fn().mockResolvedValue({ data: [], error: null }),
  single: jest.fn().mockResolvedValue({ data: { id: 'abc', notes: [] }, error: null }),
  upsert: jest.fn().mockResolvedValue({ error: null }),
}));

jest.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ from: mockFrom, storage: { from: () => ({ upload: jest.fn().mockResolvedValue({ error: null }), getPublicUrl: jest.fn().mockReturnValue({ data: { publicUrl: 'http://x' } }) }) } })
}));

const app = require('../server');

describe('GET /api/follow-ups', () => {
  it('returns 200 with array', async () => {
    const res = await request(app).get('/api/follow-ups');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe('POST /api/follow-ups', () => {
  it('returns 400 when text missing', async () => {
    const res = await request(app).post('/api/follow-ups').send({});
    expect(res.status).toBe(400);
  });

  it('creates follow-up with text', async () => {
    const res = await request(app)
      .post('/api/follow-ups')
      .send({ text: 'Follow up with Matt on labor', assigned_to: 'Matt Hester' });
    expect(res.status).toBe(201);
  });
});

describe('PATCH /api/follow-ups/:id/done', () => {
  it('returns 200', async () => {
    const res = await request(app).patch('/api/follow-ups/abc/done');
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run to verify failure**

```bash
npm test -- tests/followups.test.js
```

Expected: FAIL — routes don't exist yet.

- [ ] **Step 3: Add follow-up routes to server.js**

Add these routes after the image upload route:

```js
// ── List follow-ups ──
app.get('/api/follow-ups', async (req, res) => {
  const { status } = req.query; // 'open' | 'done' | undefined = all
  let query = supabase.from('follow_ups').select('*').order('created_at', { ascending: false });
  if (status === 'open' || status === 'done') query = query.eq('status', status);
  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json(data || []);
});

// ── Create follow-up ──
app.post('/api/follow-ups', async (req, res) => {
  const { text, assigned_to, due_date, source = 'manual' } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });
  const { data, error } = await supabase
    .from('follow_ups')
    .insert({ text, assigned_to, due_date: due_date || null, source, notes: [] })
    .select()
    .single();
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(data);
});

// ── Update follow-up fields ──
app.patch('/api/follow-ups/:id', async (req, res) => {
  const { text, assigned_to, due_date, status } = req.body;
  const updates = {};
  if (text !== undefined) updates.text = text;
  if (assigned_to !== undefined) updates.assigned_to = assigned_to;
  if (due_date !== undefined) updates.due_date = due_date;
  if (status !== undefined) updates.status = status;
  updates.updated_at = new Date().toISOString();
  const { error } = await supabase.from('follow_ups').update(updates).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── Mark follow-up done ──
app.patch('/api/follow-ups/:id/done', async (req, res) => {
  const { error } = await supabase
    .from('follow_ups')
    .update({ status: 'done', updated_at: new Date().toISOString() })
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});

// ── Append note to follow-up ──
app.post('/api/follow-ups/:id/notes', async (req, res) => {
  const { text, images = [] } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });

  // Fetch current notes
  const { data: row, error: fetchErr } = await supabase
    .from('follow_ups')
    .select('notes')
    .eq('id', req.params.id)
    .single();
  if (fetchErr) return res.status(500).json({ error: fetchErr.message });

  const now = new Date();
  const newNote = {
    text,
    images,
    date: now.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
    ts: now.toISOString(),
  };
  const updatedNotes = [newNote, ...(row.notes || [])];

  const { error } = await supabase
    .from('follow_ups')
    .update({ notes: updatedNotes, updated_at: now.toISOString() })
    .eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json(newNote);
});
```

- [ ] **Step 4: Run tests**

```bash
npm test -- tests/followups.test.js
```

Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server.js tests/followups.test.js
git commit -m "feat: add follow-up CRUD API routes"
```

---

## Task 7: Image attachments in note modal (UI)

**Files:**
- Modify: `public/index.html`

Find the note modal section (search for `id="noteModal"`) and the `saveNote` / `renderNoteHistory` functions.

- [ ] **Step 1: Add image state variable**

Find the line `let editContext = null;` and add after it:

```js
let pendingImages = []; // URLs of images staged for the current note being typed
```

- [ ] **Step 2: Add image attach button to note input area**

Find the note input area in the modal HTML. Search for `id="modalNoteInput"`. Replace the save button row with:

```html
<div style="display:flex;gap:8px;align-items:flex-start;margin-top:8px;">
  <button class="btn btn-primary btn-sm" onclick="saveNote()">Add Note</button>
  <label class="btn btn-ghost btn-sm" style="cursor:pointer;display:flex;align-items:center;gap:4px;">
    📎 Photo
    <input type="file" id="noteImageInput" accept="image/*" multiple style="display:none" onchange="handleNoteImageSelect(event)">
  </label>
</div>
<div id="pendingImagePreviews" style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;"></div>
```

- [ ] **Step 3: Add image upload JS functions**

Add these functions near the `saveNote` function:

```js
async function handleNoteImageSelect(event) {
  const files = Array.from(event.target.files).slice(0, 5 - pendingImages.length);
  const previews = document.getElementById('pendingImagePreviews');

  for (const file of files) {
    // Local preview immediately
    const localUrl = URL.createObjectURL(file);
    const img = document.createElement('img');
    img.src = localUrl;
    img.style.cssText = 'width:60px;height:60px;object-fit:cover;border-radius:4px;border:1px solid var(--border);';
    previews.appendChild(img);

    // Upload to server
    const form = new FormData();
    form.append('file', file);
    try {
      const r = await fetch(`${API}/api/upload-image`, { method: 'POST', body: form });
      if (r.ok) {
        const { url } = await r.json();
        pendingImages.push(url);
        img.src = url; // swap local blob for permanent URL
      } else {
        img.remove();
        alert('Image upload failed');
      }
    } catch(e) {
      img.remove();
      alert('Image upload error: ' + e.message);
    }
  }
  event.target.value = ''; // reset input
}

function clearPendingImages() {
  pendingImages = [];
  document.getElementById('pendingImagePreviews').innerHTML = '';
}
```

- [ ] **Step 4: Update saveNote to include images**

Find `function saveNote()` and update `saveNoteForCell` call:

```js
function saveNote() {
  const text = document.getElementById("modalNoteInput").value.trim();
  if (!text && pendingImages.length === 0) return;
  const noteText = text || '📎 (photo only)';
  saveNoteForCell(modalContext.acName, modalContext.topicId, noteText, [...pendingImages]);
  document.getElementById("modalNoteInput").value = "";
  clearPendingImages();
  renderNoteHistory();
  renderMatrix();
  if (currentAC === modalContext.acName) loadAC(currentAC);
}
```

- [ ] **Step 5: Update saveNoteForCell to accept images**

Find `function saveNoteForCell(acName, topicId, text)` and replace:

```js
function saveNoteForCell(acName, topicId, text, images = []) {
  const d = gd();
  if (!d.notes[acName]) d.notes[acName] = {};
  if (!d.notes[acName][topicId]) d.notes[acName][topicId] = [];
  const now = new Date();
  d.notes[acName][topicId].unshift({
    text,
    images,
    date: fmtDate(now),
    ts: now.toISOString()
  });
  saveData(d);
}
```

- [ ] **Step 6: Update renderNoteHistory to show images**

Find `function renderNoteHistory()` and update the `hist.innerHTML` map to include images:

```js
hist.innerHTML = notes.map((n, i) => `
  <div class="note-entry">
    <div class="note-entry-date">🕐 ${escH(n.date)}</div>
    <div class="note-entry-text">${escH(n.text)}</div>
    ${(n.images && n.images.length > 0) ? `
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;">
        ${n.images.map(url => `<img src="${escH(url)}" onclick="openImageLightbox('${escH(url)}')" style="width:70px;height:70px;object-fit:cover;border-radius:4px;border:1px solid var(--border);cursor:pointer;">`).join('')}
      </div>` : ''}
    <div class="note-entry-actions">
      <button class="btn btn-ghost btn-xs" onclick="startEditNote(${i})">✏ Edit</button>
      <button class="btn btn-ghost btn-xs" style="color:#c62828" onclick="deleteNote(${i})">🗑 Delete</button>
    </div>
  </div>`).join('');
```

- [ ] **Step 7: Add image lightbox function**

Add near the bottom of the script block:

```js
function openImageLightbox(url) {
  const overlay = document.createElement('div');
  overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.85);z-index:9999;display:flex;align-items:center;justify-content:center;cursor:pointer;';
  overlay.onclick = () => overlay.remove();
  const img = document.createElement('img');
  img.src = url;
  img.style.cssText = 'max-width:90vw;max-height:90vh;border-radius:6px;';
  overlay.appendChild(img);
  document.body.appendChild(overlay);
}
```

- [ ] **Step 8: Clear pending images when modal closes**

Find `closeNoteModal()` and add `clearPendingImages()` inside it:

```js
function closeNoteModal() {
  document.getElementById("noteModal").classList.remove("open");
  modalContext = null;
  clearPendingImages();
}
```

- [ ] **Step 9: Manual test**

```bash
node server.js
```

Open http://localhost:3000 → select a user → click a matrix cell → type a note → click 📎 Photo → pick an image → click Add Note. Verify: image thumbnail appears in note history. Click thumbnail → lightbox opens.

- [ ] **Step 10: Commit**

```bash
git add public/index.html
git commit -m "feat: add photo attachments to note modal (upload + preview + lightbox)"
```

---

## Task 8: Follow-Ups tab (UI)

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: Add nav tab**

Find the nav tabs block (search for `id="tab-inbox"`). Add a new tab after the inbox tab:

```html
<div class="nav-tab" onclick="showTab('followups')" id="tab-followups">📋 Follow-Ups</div>
```

- [ ] **Step 2: Add the tab view HTML**

Find `</div><!-- /main -->` and add before it:

```html
<!-- ===== FOLLOW-UPS TAB ===== -->
<div id="view-followups" class="hidden">
  <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:8px;">
    <div>
      <div style="font-weight:700;font-size:16px;">📋 Follow-Ups</div>
      <div style="font-size:12px;color:var(--muted);">Action items from emails and manual entries</div>
    </div>
    <button class="btn btn-accent btn-sm" onclick="openAddFollowUpModal()">+ Add Follow-Up</button>
  </div>

  <!-- Filter bar -->
  <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:14px;">
    <div style="display:flex;gap:4px;">
      <button class="btn btn-sm" id="fu-filter-all" onclick="setFollowUpFilter('all')" style="background:var(--accent);color:#fff;">All</button>
      <button class="btn btn-ghost btn-sm" id="fu-filter-open" onclick="setFollowUpFilter('open')">Open</button>
      <button class="btn btn-ghost btn-sm" id="fu-filter-done" onclick="setFollowUpFilter('done')">Done</button>
    </div>
    <select id="fu-person-filter" onchange="loadFollowUps()" style="padding:5px 8px;border:1px solid var(--border);border-radius:4px;font-size:13px;background:var(--surface);color:var(--text);">
      <option value="">All People</option>
    </select>
    <button class="btn btn-ghost btn-sm" onclick="loadFollowUps()">🔄 Refresh</button>
  </div>

  <div id="followUpList" style="display:flex;flex-direction:column;gap:8px;"></div>
  <div id="followUpEmpty" class="empty" style="background:#fff;border-radius:var(--radius);border:1px solid var(--border);display:none;">No follow-ups found.</div>
</div>

<!-- Add Follow-Up Modal -->
<div class="modal-overlay" id="addFollowUpModal">
  <div class="modal" style="max-width:480px;">
    <div class="modal-header">
      <div class="modal-header-text"><h3>Add Follow-Up</h3></div>
      <button class="btn btn-ghost btn-xs" onclick="closeAddFollowUpModal()">✕</button>
    </div>
    <div class="modal-body">
      <div style="margin-bottom:10px;">
        <label style="font-size:12px;font-weight:700;display:block;margin-bottom:4px;">Item *</label>
        <textarea id="fuText" rows="3" style="width:100%;padding:7px 10px;border:1px solid var(--border);border-radius:4px;font-size:13px;font-family:inherit;background:var(--surface);color:var(--text);resize:vertical;" placeholder="What needs to be followed up on?"></textarea>
      </div>
      <div style="display:flex;gap:10px;margin-bottom:10px;">
        <div style="flex:1;">
          <label style="font-size:12px;font-weight:700;display:block;margin-bottom:4px;">Assigned To</label>
          <input type="text" id="fuAssignedTo" list="fu-people-list" style="width:100%;padding:5px 8px;border:1px solid var(--border);border-radius:4px;font-size:13px;background:var(--surface);color:var(--text);" placeholder="Matt Hester, Harold...">
          <datalist id="fu-people-list">
            <option value="Matt Hester">
            <option value="Harold Lacoste">
          </datalist>
        </div>
        <div style="flex:1;">
          <label style="font-size:12px;font-weight:700;display:block;margin-bottom:4px;">Due Date</label>
          <input type="date" id="fuDueDate" style="width:100%;padding:5px 8px;border:1px solid var(--border);border-radius:4px;font-size:13px;background:var(--surface);color:var(--text);">
        </div>
      </div>
    </div>
    <div class="modal-footer" style="display:flex;justify-content:flex-end;gap:8px;padding:12px 16px;border-top:1px solid var(--border);">
      <button class="btn btn-ghost btn-sm" onclick="closeAddFollowUpModal()">Cancel</button>
      <button class="btn btn-primary btn-sm" onclick="submitAddFollowUp()">Add</button>
    </div>
  </div>
</div>
```

- [ ] **Step 3: Add Follow-Ups JS**

Add this JS block before the closing `</script>` tag:

```js
// =============================================================
// FOLLOW-UPS
// =============================================================
let followUps = [];
let fuFilter = 'all';
let fuExpandedId = null;
let fuPendingImages = [];

function setFollowUpFilter(f) {
  fuFilter = f;
  ['all','open','done'].forEach(v => {
    const btn = document.getElementById('fu-filter-' + v);
    btn.style.background = v === f ? 'var(--accent)' : 'transparent';
    btn.style.color = v === f ? '#fff' : 'var(--text)';
    btn.className = v === f ? 'btn btn-sm' : 'btn btn-ghost btn-sm';
  });
  loadFollowUps();
}

async function loadFollowUps() {
  const personFilter = document.getElementById('fu-person-filter')?.value || '';
  const url = `${API}/api/follow-ups${fuFilter !== 'all' ? '?status=' + fuFilter : ''}`;
  try {
    const r = await fetch(url);
    if (!r.ok) return;
    followUps = await r.json();

    // Populate person filter dropdown
    const people = [...new Set(followUps.map(f => f.assigned_to).filter(Boolean))];
    const sel = document.getElementById('fu-person-filter');
    const current = sel.value;
    sel.innerHTML = '<option value="">All People</option>' + people.map(p => `<option value="${escH(p)}"${p===current?' selected':''}>${escH(p)}</option>`).join('');

    // Apply person filter
    const filtered = personFilter ? followUps.filter(f => f.assigned_to === personFilter) : followUps;
    renderFollowUps(filtered);
  } catch(e) {
    console.error('loadFollowUps error:', e);
  }
}

function renderFollowUps(items) {
  const list = document.getElementById('followUpList');
  const empty = document.getElementById('followUpEmpty');
  if (items.length === 0) {
    list.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  list.innerHTML = items.map(fu => {
    const isExpanded = fuExpandedId === fu.id;
    const isDone = fu.status === 'done';
    const sourceBadge = fu.source === 'email'
      ? '<span style="font-size:10px;background:#1f6feb22;color:#1f6feb;padding:1px 6px;border-radius:3px;">📨 email</span>'
      : '<span style="font-size:10px;background:#3fb95022;color:#3fb950;padding:1px 6px;border-radius:3px;">✍️ manual</span>';
    const dueBadge = fu.due_date
      ? `<span style="font-size:11px;color:${new Date(fu.due_date) < new Date() && !isDone ? '#f85149' : 'var(--muted)'};">📅 ${fu.due_date}</span>`
      : '';

    const notesHtml = isExpanded ? `
      <div style="border-top:1px solid var(--border);padding:10px 14px;background:var(--bg);">
        <div id="fu-note-history-${fu.id}" style="margin-bottom:10px;">
          ${(fu.notes || []).map(n => `
            <div style="margin-bottom:8px;">
              <div style="font-size:10px;color:var(--muted);">🕐 ${escH(n.date)}</div>
              <div style="font-size:13px;">${escH(n.text)}</div>
              ${(n.images && n.images.length > 0) ? `
                <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;">
                  ${n.images.map(url => `<img src="${escH(url)}" onclick="openImageLightbox('${escH(url)}')" style="width:60px;height:60px;object-fit:cover;border-radius:4px;border:1px solid var(--border);cursor:pointer;">`).join('')}
                </div>` : ''}
            </div>`).join('') || '<div style="font-size:12px;color:var(--muted);">No notes yet.</div>'}
        </div>
        <div style="display:flex;gap:6px;align-items:flex-start;">
          <textarea id="fu-note-input-${fu.id}" rows="2" style="flex:1;padding:6px 8px;border:1px solid var(--border);border-radius:4px;font-size:12px;font-family:inherit;background:var(--surface);color:var(--text);resize:vertical;" placeholder="Add a note..."></textarea>
          <div style="display:flex;flex-direction:column;gap:4px;">
            <button class="btn btn-primary btn-xs" onclick="saveFuNote('${fu.id}')">Add</button>
            <label class="btn btn-ghost btn-xs" style="cursor:pointer;">
              📎
              <input type="file" accept="image/*" multiple style="display:none" onchange="handleFuImageSelect(event,'${fu.id}')">
            </label>
          </div>
        </div>
        <div id="fu-pending-previews-${fu.id}" style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;"></div>
      </div>` : '';

    return `
      <div style="background:var(--card);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden;${isDone ? 'opacity:.6;' : ''}">
        <div style="display:flex;align-items:center;gap:10px;padding:10px 14px;cursor:pointer;" onclick="toggleFuExpand('${fu.id}')">
          <input type="checkbox" ${isDone ? 'checked' : ''} onclick="event.stopPropagation();toggleFuDone('${fu.id}',${isDone})" style="flex-shrink:0;">
          <div style="flex:1;min-width:0;">
            <div style="font-size:13px;font-weight:600;${isDone ? 'text-decoration:line-through;color:var(--muted);' : ''}">${escH(fu.text)}</div>
            <div style="display:flex;gap:8px;align-items:center;margin-top:3px;flex-wrap:wrap;">
              ${sourceBadge}
              ${fu.assigned_to ? `<span style="font-size:11px;color:var(--muted);">→ ${escH(fu.assigned_to)}</span>` : ''}
              ${dueBadge}
              ${(fu.notes||[]).length > 0 ? `<span style="font-size:11px;color:var(--muted);">💬 ${fu.notes.length} note${fu.notes.length>1?'s':''}</span>` : ''}
            </div>
          </div>
          <span style="color:var(--muted);font-size:12px;">${isExpanded ? '▲' : '▼'}</span>
        </div>
        ${notesHtml}
      </div>`;
  }).join('');
}

function toggleFuExpand(id) {
  fuExpandedId = fuExpandedId === id ? null : id;
  fuPendingImages = [];
  const personFilter = document.getElementById('fu-person-filter')?.value || '';
  const filtered = personFilter ? followUps.filter(f => f.assigned_to === personFilter) : followUps;
  renderFollowUps(filtered);
}

async function toggleFuDone(id, isDone) {
  if (isDone) {
    await fetch(`${API}/api/follow-ups/${id}`, { method: 'PATCH', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ status: 'open' }) });
  } else {
    await fetch(`${API}/api/follow-ups/${id}/done`, { method: 'PATCH' });
  }
  await loadFollowUps();
}

async function handleFuImageSelect(event, fuId) {
  const files = Array.from(event.target.files).slice(0, 5);
  const previews = document.getElementById('fu-pending-previews-' + fuId);
  if (!previews) return;

  for (const file of files) {
    const localUrl = URL.createObjectURL(file);
    const img = document.createElement('img');
    img.src = localUrl;
    img.style.cssText = 'width:50px;height:50px;object-fit:cover;border-radius:4px;border:1px solid var(--border);';
    previews.appendChild(img);

    const form = new FormData();
    form.append('file', file);
    try {
      const r = await fetch(`${API}/api/upload-image`, { method: 'POST', body: form });
      if (r.ok) {
        const { url } = await r.json();
        fuPendingImages.push(url);
        img.src = url;
      } else {
        img.remove();
      }
    } catch(e) { img.remove(); }
  }
  event.target.value = '';
}

async function saveFuNote(fuId) {
  const input = document.getElementById('fu-note-input-' + fuId);
  const text = input?.value.trim();
  if (!text && fuPendingImages.length === 0) return;
  const noteText = text || '📎 (photo only)';

  await fetch(`${API}/api/follow-ups/${fuId}/notes`, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ text: noteText, images: [...fuPendingImages] })
  });
  fuPendingImages = [];
  if (input) input.value = '';
  await loadFollowUps();
}

function openAddFollowUpModal() {
  document.getElementById('addFollowUpModal').classList.add('open');
}
function closeAddFollowUpModal() {
  document.getElementById('addFollowUpModal').classList.remove('open');
  document.getElementById('fuText').value = '';
  document.getElementById('fuAssignedTo').value = '';
  document.getElementById('fuDueDate').value = '';
}

async function submitAddFollowUp() {
  const text = document.getElementById('fuText').value.trim();
  if (!text) { alert('Please enter the follow-up item.'); return; }
  const assigned_to = document.getElementById('fuAssignedTo').value.trim() || null;
  const due_date = document.getElementById('fuDueDate').value || null;

  const r = await fetch(`${API}/api/follow-ups`, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ text, assigned_to, due_date, source: 'manual' })
  });
  if (!r.ok) { alert('Failed to add follow-up'); return; }
  closeAddFollowUpModal();
  await loadFollowUps();
}
```

- [ ] **Step 4: Hook showTab to load follow-ups**

Find `function showTab(tab)` and add a follow-ups case:

```js
function showTab(tab) {
  ["region","one-on-one","aop","inbox","followups"].forEach(t => {
    document.getElementById("view-"+t).classList.toggle("hidden", t !== tab);
    document.getElementById("tab-"+t).classList.toggle("active", t === tab);
  });
  if (tab === "aop") renderAOPTable();
  if (tab === "one-on-one") renderACSelector();
  if (tab === "inbox") loadEmailFollowups();
  if (tab === "followups") loadFollowUps();
}
```

- [ ] **Step 5: Update email inbox "Move to Tracker" to create a follow-up**

Find `async function moveEmailToTracker(fuId)` and replace the body:

```js
async function moveEmailToTracker(fuId) {
  const fu = emailFollowups.find(f => f.id === fuId);
  if (!fu) return;

  const r = await fetch(`${API}/api/follow-ups`, {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      text: fu.note_text,
      assigned_to: fu.ac_name || null,
      source: 'email',
    })
  });
  if (!r.ok) { alert('Failed to create follow-up'); return; }

  try { await fetch(`${API}/api/email-followups/${fuId}/done`, { method: 'POST' }); } catch(e) {}
  await loadEmailFollowups();
  alert('Added to Follow-Ups tab.');
}
```

- [ ] **Step 6: Manual test**

```bash
node server.js
```

1. Open http://localhost:3000 → click **📋 Follow-Ups** tab
2. Click **+ Add Follow-Up** → fill in text + assigned to → submit → item appears
3. Click item to expand → add a note → note appears with timestamp
4. Click 📎 on the note input → attach a photo → image thumbnail appears
5. Check the checkbox → item shows as done → filter by Open → item disappears
6. Go to **Email Inbox** tab → if any emails exist, click "→ Add to Follow-Ups" → verify item appears in Follow-Ups tab

- [ ] **Step 7: Commit**

```bash
git add public/index.html
git commit -m "feat: add Follow-Ups tab with threaded notes and image support"
```

---

## Task 9: Deploy to Render

- [ ] **Step 1: Add env vars to Render**

In Render dashboard → rc-tracker service → Environment, verify these are set:
- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_SERVICE_KEY` ← new
- `GMAIL_CLIENT_ID` ← new
- `GMAIL_CLIENT_SECRET` ← new
- `GMAIL_REFRESH_TOKEN` ← new

- [ ] **Step 2: Push to GitHub**

```bash
git push origin main
```

Render auto-deploys on push. Watch the deploy logs in Render dashboard.

- [ ] **Step 3: Smoke test live site**

1. Open https://rc-tracker-hos2.onrender.com
2. Wait for server to wake (free tier may take ~30s)
3. Click **📋 Follow-Ups** — add a test item
4. Click a matrix cell — add a note with a photo attachment
5. Trigger a Gmail poll: `curl https://rc-tracker-hos2.onrender.com/api/poll`
6. Check Render logs — should see no IMAP errors

---

## Self-Review Notes

- OAuth flow: `pollInbox` signature unchanged ✓ — `server.js` needs no edits for Gmail migration
- `saveNoteForCell` signature change: added optional `images=[]` param — all existing callers pass no images so backward compatible ✓
- `showTab` now includes `"followups"` in the array — nav tab hidden/active states will work correctly ✓
- `module.exports = app` added at bottom of `server.js` — required for Jest/supertest tests ✓
- Supabase service key used only server-side (upload endpoint), never sent to browser ✓
- `fuPendingImages` is a module-level array — reset on expand toggle and after save to prevent bleed between items ✓
