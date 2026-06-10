# RC Tracker — Feature Design
**Date:** 2026-06-10  
**Repo:** https://github.com/halaco225/rc-tracker  
**Live:** https://rc-tracker-hos2.onrender.com

---

## Scope

Three features to implement together:

1. Gmail OAuth 2.0 migration (replace IMAP + App Password)
2. Image/photo attachments on notes (Matrix, 1:1 View, and Follow-Ups)
3. Follow-Up section — new tab, separate from Matrix and 1:1

---

## 1. Gmail OAuth 2.0 Migration

### Problem
`gmail-poller.js` uses the `imap` package with a Gmail App Password. This breaks every time the Google account password changes.

### Solution
Replace with `googleapis` npm package using OAuth 2.0 refresh token flow.

### Setup (one-time, manual)
1. Create a Google Cloud project at console.cloud.google.com
2. Enable the Gmail API
3. Create OAuth 2.0 credentials (Desktop app type) — get `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET`
4. Run the provided `scripts/get-gmail-token.js` script locally to exchange credentials for a `GMAIL_REFRESH_TOKEN`
5. Add all three to Render env vars: `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`

### Code changes
- `gmail-poller.js` — rewrite to use `googleapis` Gmail API (search unread messages, parse body, insert into `email_followups` table). Public interface `pollInbox(supabase)` stays identical — `server.js` needs no changes.
- `package.json` — add `googleapis`, remove `imap` and `mailparser`
- Add `scripts/get-gmail-token.js` — one-time local script to obtain refresh token via browser OAuth consent flow

### Data flow
```
cron-job.org → GET /api/poll
  → pollInbox(supabase)
    → Gmail API (users.messages.list + get, OAuth2 auth)
    → parse body text
    → upsert into email_followups table
```

---

## 2. Image/Photo Attachments on Notes

### Applies to
- Note modal in Region Matrix (click any cell)
- Note modal in 1:1 View (click any topic card)
- Follow-up item notes (see section 3)

### Storage
Supabase Storage bucket: `note-images` (public bucket, no auth needed to read URLs).

### Data model change
Each note entry gains an optional `images` field:

```js
// Before
{ text: "...", date: "...", ts: "..." }

// After
{ text: "...", date: "...", ts: "...", images: ["https://...supabase.co/storage/...", ...] }
```

All existing note data is backward compatible (missing `images` treated as `[]`).

### New API endpoint
`POST /api/upload-image`  
- Accepts `multipart/form-data` with a single `file` field
- Validates: image only, max 5MB
- Uploads to Supabase Storage `note-images` bucket
- Returns `{ url: "https://..." }`

### UI changes (note modal)
- Add a 📎 attach button next to the note text input
- Opens native file picker (image/* only)
- Selected images show as small thumbnails below the text input before saving
- On save, images upload first (parallel), URLs appended to note entry
- Note history entries: thumbnails shown below note text, click to full-screen lightbox
- Limit: 5 images per note entry

### Dependencies
- `multer` npm package for multipart parsing on the upload endpoint
- Supabase Storage bucket must be created and set to public

---

## 3. Follow-Up Section

### Overview
New tab `📋 Follow-Ups` in the nav bar (between Email Inbox and 1:1 View). A dedicated place to track action items sourced from emails or entered manually, each with a threaded notes sub-list.

### Supabase table: `follow_ups`

```sql
create table follow_ups (
  id uuid primary key default gen_random_uuid(),
  text text not null,
  assigned_to text,           -- "Matt Hester", "Harold", "Jamie AC", etc.
  status text default 'open', -- 'open' | 'done'
  source text default 'manual', -- 'email' | 'manual'
  due_date date,
  notes jsonb default '[]',   -- [{text, date, ts, images[]}]
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
```

### New API routes

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/follow-ups` | List all follow-ups (query: `?status=open\|done\|all`) |
| POST | `/api/follow-ups` | Create a manual follow-up |
| PATCH | `/api/follow-ups/:id` | Update text, assigned_to, status, due_date |
| POST | `/api/follow-ups/:id/notes` | Append a note (text + optional image URLs) |
| POST | `/api/follow-ups/:id/done` | Mark done |

### Email inbox integration
- Existing "Move to Tracker" button on email inbox items changes to "→ Add to Follow-Ups"
- Creates a follow-up row with `source: 'email'`, pre-fills `text` from email body, `assigned_to` from detected AC name if present

### UI — Follow-Ups tab

**Filter bar** (top):
- Status: All / Open / Done (pill buttons)
- Person: dropdown of all assigned_to values seen in data

**Item list** (flat, most recent first):
- Each item: checkbox (mark done) · item text · assigned to chip · source badge (📨 / ✍️) · due date · expand arrow
- Expanded state: threaded notes list (timestamp + text + image thumbnails) + "Add note" input with 📎 attach

**Add Follow-Up button** (top right):
- Modal: text input, assigned-to input, due date picker, source auto-set to 'manual'

### No drag-and-drop
Status changes via checkbox only. Keeps implementation simple.

---

## PAi module notes
- All new routes follow existing `/api/*` pattern in `server.js` — self-contained, no globals
- Image upload goes through the Express backend (not direct-to-Supabase from browser) so the service key stays server-side
- `follow_ups` table is independent of `user_data` blob — easier to query/filter as a proper table

---

## Out of scope (this iteration)
- Email-out / reply from follow-up
- Per-user follow-up filtering (currently global across all RC users)
- Push notifications for due dates
