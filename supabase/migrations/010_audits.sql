-- 010_audits.sql — Steritech readiness walk responses.
--
-- Runs in the SAME Supabase project RC Tracker uses (the one SUPABASE_URL
-- points at; services/rc-db.js is P.AI's seam onto it). Paste this into the
-- Supabase SQL editor once, before the first shift leader opens /audit.
--
-- The store's Area Coach is NOT stored here. It lives in store_assignments in
-- pai-db and is joined at read time, so a realignment does not leave stale
-- ownership on old responses.

create table if not exists audit_responses (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  audit_id        text not null,
  respondent_name text not null,
  store_number    text not null,
  answers         jsonb not null default '{}'::jsonb,
  photos          jsonb not null default '{}'::jsonb,
  score           int  not null,
  max_score       int  not null,
  fixes           text,
  user_agent      text
);

create index if not exists idx_audit_responses_created
  on audit_responses (created_at desc);

create index if not exists idx_audit_responses_store
  on audit_responses (store_number, created_at desc);

-- The public /audit page writes through the service key on the server, never
-- from the browser, so no anon policy is granted. RLS on with no policy means
-- the anon key cannot read or write this table even if it leaks.
alter table audit_responses enable row level security;

-- ── Photo storage ───────────────────────────────────────────────────────────
-- Run once. Private bucket: the Audits page serves photos through short-lived
-- signed URLs, so a guessed path is not enough to see inside someone's kitchen.
insert into storage.buckets (id, name, public)
values ('audit-photos', 'audit-photos', false)
on conflict (id) do nothing;
