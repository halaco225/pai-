-- 011_audit_frozen_scores.sql — keep a walk's score as it was on the day.
--
-- Audits became editable in the Audits tab. Without this, opening an old
-- response would re-grade it against today's questions, so rewording an answer
-- or fixing a typo would silently change a score somebody already saw.
--
-- `graded` holds the full result at submit time: per question, what they
-- picked, what was right, the explanation and the points earned.
-- `template_version` records which version of the audit they were given.

alter table audit_responses add column if not exists graded jsonb;
alter table audit_responses add column if not exists template_version int;
