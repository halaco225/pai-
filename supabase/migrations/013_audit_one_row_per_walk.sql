-- 013_audit_one_row_per_walk.sql — one walk, one row.
--
-- A submission that saves but whose reply never reaches the phone looks to
-- the walker like it failed, so they hit the button again and the walk lands
-- twice. It has happened in the real data: one walk saved three times, and
-- another twice, 42 microseconds apart from a double tap.
--
-- The page has always had a walk id and has always sent it. Keeping it, and
-- making it unique, is what makes submitting twice harmless: the second one
-- is turned away by the database, and the route hands back the first result.
--
-- Safe to run twice.

alter table public.audit_responses
  add column if not exists walk_id uuid;

create unique index if not exists audit_responses_walk_id_key
  on public.audit_responses (walk_id)
  where walk_id is not null;
