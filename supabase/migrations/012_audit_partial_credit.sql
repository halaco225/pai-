-- 012_audit_partial_credit.sql — let a score hold half marks.
--
-- Pick-all questions now pay per box, so a walk can score 20.6 out of 23.
-- The columns were int, which rounds that to 21 and makes the headline
-- disagree with the per-question marks frozen in `graded`.
--
-- Safe to run twice.

alter table public.audit_responses
  alter column score     type numeric(6,1),
  alter column max_score type numeric(6,1);
