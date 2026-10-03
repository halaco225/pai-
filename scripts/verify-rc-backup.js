// scripts/verify-rc-backup.js
//
// Re-counts live rows and diffs them against a dump's manifest. A backup
// nobody has read back is not a backup.
//
// Usage:
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... node scripts/verify-rc-backup.js 2026-10-03

const fs   = require('fs');
const path = require('path');
const { createClient } = require('@supabase/supabase-js');

const stamp = process.argv[2];
if (!stamp) { console.error('Usage: node scripts/verify-rc-backup.js YYYY-MM-DD'); process.exit(1); }

const root     = path.join(__dirname, '..', '..', 'rc-tracker', 'backups', stamp);
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

async function main() {
  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY,
    { auth: { persistSession: false } }
  );

  let bad = 0;
  for (const [table, backedUp] of Object.entries(manifest.tables)) {
    const { count, error } = await sb.from(table).select('*', { count: 'exact', head: true });
    if (error) { console.error(`  ! ${table}: ${error.message}`); bad++; continue; }

    const onDisk = JSON.parse(fs.readFileSync(path.join(root, `${table}.json`), 'utf8')).length;

    // Live may legitimately have grown since the dump — it must never be
    // short, and the file must match what the manifest claimed.
    if (onDisk !== backedUp) {
      console.error(`  ! ${table}: file has ${onDisk} rows, manifest claims ${backedUp}`);
      bad++;
    } else if (count < backedUp) {
      console.error(`  ! ${table}: live has ${count}, backup has ${backedUp} — rows disappeared`);
      bad++;
    } else {
      console.log(`  ${table}: ${onDisk} backed up, ${count} live  OK`);
    }
  }

  const b = manifest.bucket;
  if (b.saved !== b.listed) {
    console.error(`  ! note-images: ${b.listed - b.saved} file(s) failed to download`);
    bad++;
  } else {
    console.log(`  note-images: ${b.saved} files  OK`);
  }

  if (bad) { console.error(`\nVERIFY FAILED (${bad} problem(s)). Do not proceed.`); process.exit(1); }
  console.log('\nVerify passed. Safe to proceed.');
}

main().catch(err => { console.error('VERIFY FAILED:', err.message); process.exit(1); });
