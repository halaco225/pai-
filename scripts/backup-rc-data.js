// scripts/backup-rc-data.js
//
// Dumps every RC Tracker Supabase table and the note-images bucket to disk.
// Read-only against Supabase. Safe to re-run; each run gets its own folder.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/backup-rc-data.js
//
// Then verify it before relying on it:
//   node scripts/verify-rc-backup.js YYYY-MM-DD

const fs   = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const TABLES = [
  'user_data', 'follow_ups', 'email_followups',
  'sms_reminders', 'sms_consent', 'sms_messages', 'candidates',
];
const BUCKET    = 'note-images';
const PAGE_SIZE = 1000;

function client() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL and a Supabase key must be set');
  return createClient(url, key, { auth: { persistSession: false } });
}

// Page through a table. A plain select caps out at Supabase's row limit and
// returns the truncated set without complaining, which would silently back up
// a fraction of sms_messages and look like a success.
async function dumpTable(sb, table) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await sb.from(table).select('*').range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...data);
    if (data.length < PAGE_SIZE) break;
  }
  return rows;
}

async function dumpBucket(sb, outDir) {
  const { data: files, error } = await sb.storage.from(BUCKET).list('', { limit: 10000 });
  if (error) throw new Error(`${BUCKET}: ${error.message}`);
  fs.mkdirSync(outDir, { recursive: true });
  let saved = 0;
  for (const f of files) {
    const { data, error: dlErr } = await sb.storage.from(BUCKET).download(f.name);
    if (dlErr) { console.error(`  ! ${f.name}: ${dlErr.message}`); continue; }
    fs.writeFileSync(path.join(outDir, f.name), Buffer.from(await data.arrayBuffer()));
    saved++;
  }
  return { listed: files.length, saved };
}

async function main() {
  const sb    = client();
  const stamp = new Date().toISOString().slice(0, 10);
  const root  = path.join(__dirname, '..', '..', 'rc-tracker', 'backups', stamp);
  fs.mkdirSync(root, { recursive: true });

  const manifest = { created_at: new Date().toISOString(), tables: {}, bucket: null };

  for (const t of TABLES) {
    const rows = await dumpTable(sb, t);
    fs.writeFileSync(path.join(root, `${t}.json`), JSON.stringify(rows, null, 2));
    manifest.tables[t] = rows.length;
    console.log(`  ${t}: ${rows.length} rows`);
  }

  manifest.bucket = await dumpBucket(sb, path.join(root, BUCKET));
  console.log(`  ${BUCKET}: ${manifest.bucket.saved}/${manifest.bucket.listed} files`);

  fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`\nBackup written to ${root}`);

  const empty = Object.entries(manifest.tables).filter(([, n]) => n === 0).map(([t]) => t);
  if (empty.length) {
    console.warn(`\nWARNING: these tables came back empty: ${empty.join(', ')}`);
    console.warn('Either the key cannot read them or this is the wrong project. Do not');
    console.warn('treat this as a backup until you know which.');
  }
}

main().catch(err => { console.error('BACKUP FAILED:', err.message); process.exit(1); });
