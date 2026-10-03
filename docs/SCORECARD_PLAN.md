# Hierarchy Scorecard — Implementation Plan

> **Status 2026-10-02:** Phases 0, 1, 2 and 4 are built and tested locally,
> nothing committed or deployed. Phase 3 (WIN score) is still open — the nightly
> SMG pull is returning zero rows in production, see below.

Spec: every brief shows **your level, plus the level directly beneath you.**

| Role | Own line | Breakdown rows |
|---|---|---|
| VP (Territory) | territory totals | region coaches under them |
| RDO / Director | region totals | area coaches under them |
| Area Coach / DM | area totals | stores under them |

Five metrics, no target column: Sales + growth · IST · Labor hrs (act vs sch) · WIN PTD · Missed routines.

---

## Phase 0 — Alignment refresh (P10 REV 092926) — DONE

Source: `AYVAZ Master Alignment P10 REV 092926.xlsx`, 367 stores, one sheet.
Columns: `Ayvaz Store #`(1) `Reference Name`(2) `Region`(4) `Area #`(15) `Area Coach`(16)
`Region Coach`(19) `VP of Operations`(22).

**Roster drift found — `routes/auth.js` USER_ROSTER is stale on three counts:**

| | Roster says | P10 says |
|---|---|---|
| Lori Schwartz | under Chad Magner | under **Matt Hester** |
| Terrance Spillane | under Matt Hester | under **Tracy Krumwiede** |
| Chad Magner | active VP | **absent from alignment entirely** |

P10 territories: Matt Hester 108 stores (Lori 37, Harold 36, Preston 35) ·
Tracy Krumwiede 259 stores (Jose Lozano 57, Theresa McDaniel 56, Papa Diack 53,
Terrance Spillane 47, Jerry Warren 46).

Note `Region` (9 geographic names) is NOT 1:1 with `Region Coach` (8 people) —
Theresa McDaniel covers both CORPUS CHRISTI (30) and SAN ANTONIO (26). Roll RDO
views up by **Region Coach**, not by the `Region` label.

Tasks:
- [x] Regenerate `services/alignment-data.js` from P10
- [x] Fix USER_ROSTER: Lori→Matt, Terrance→Tracy, retire Chad Magner
- [x] Add `area` + `region` to `store_assignments`; rename/alias `vp`→`territory_vp` for consistency with `intel_flags`
- [ ] Re-run `/api/intel/automation/seed-hierarchy`

## Phase 1 — Scorecard builder — DONE

New `services/scorecard.js`. One function, level-aware, returns `{ own, rows }`.
Three of five metrics are already in the DB today:

- **Sales/growth** — `intel_dbs_metrics.net_sales_day`, `growth_pct_day`
- **Labor hrs** — `dbs_soft_indicators` indicators `act_labor_hrs` / `sch_labor_hrs`,
  written for every store every day regardless of the $200 flag threshold
- **Missed routines** — `intel_flags` where `metric_type='ROUTINE_MISSED'` (LATE excluded)

Rollup rule: **sum the numerators, sum the denominators** — never average the averages.
Growth % recomputed from summed sales, not averaged from store percentages.

## Phase 2 — IST: no second report required — DONE

Resolved: option (a)/(b) is moot. `velocity_daily_records` holds `ist_avg` **and**
`total_orders` per store. Since `ist_avg = total_minutes / orders`, an
order-weighted average of store averages reproduces the true area IST **exactly**:

    area_ist = Σ(ist_avg_i × total_orders_i) / Σ(total_orders_i)

This is algebra, not approximation — it will agree with an area-level report.
Caveat to surface in the brief: stores with null `ist_avg` drop out of the
denominator, so the row carries a coverage count (`14/16 stores reporting`).

## Phase 3 — WIN score: fix a production outage first — OPEN

`GET /api/intel/debug/winscore` against live, 2026-10-02:

    formLogin: ok          controllerLength: 22133
    reportLength: 4244     storeRows: 0
    aggregate: null        periodEnd: null
    unitsSnippet: {"Error":"An Error Occurred!"}

**The nightly WIN score pull is writing zero rows.** Login and session init work;
the saved favorite `SMG_WINSCORE_REPORT_ID=033C5385EEA0F79D08857C066EDF71D7`
renders 4.2KB with no "Win Score" header — the favorite is empty, deleted, or
no longer valid. It fails silently: step 6b logs an error, nothing else breaks,
and the WIN column has been going stale without complaint.

So the fix is NOT patching the parser to keep area rows. It is to **stop depending
on a saved favorite** and build the Comparison postback ourselves. The debug dump
already hands us the pieces:

- survey item `Win Score` = **699308**
- date range `Current Fiscal Period` = `9/8/2026|10/5/2026|False|95` ← this is PTD
- `UnitOptionType` in the build postback is the grouping lever (currently `UserLevel`)
- `getunits` is erroring and needs its own fix before unit targeting will work

Tasks:
- [ ] Fix `getunits` (likely missing params or a prerequisite session step)
- [ ] Construct the postback directly: surveyItem 699308 + Current Fiscal Period + explicit unit level
- [ ] Pull twice — store level, then area level
- [ ] `parseHtmlTable`: keep **all** non-store rows with their unit label, not just the first
      (`services/intel-smg-winscore.js:405` currently discards the rest)
- [ ] Map area unit label → area coach (`R-KDGI08-LACOSTE, HAROLD - …REGNKDGI08` carries the name)
- [ ] New table `smg_win_scores_rollup (level, unit_key, period_end_date, win_score, survey_count)`
      — `smg_win_scores` is keyed by `store_id` and has nowhere to put an area score

Why pull area rather than compute it: WIN Score is a composite index, so a
survey-weighted average of store scores is **not** guaranteed to equal SMG's own
area number. Unlike IST, this one needs the source.

Requires iterative probing against live SMG. The debug endpoint is the harness.

## Phase 4 — Wire into the brief — DONE

`services/claude.js:1503`. Scorecard goes first, deterministic, no LLM call.
Performance prose shrinks to two sentences above it. Attack List and SMG Pulse unchanged.

Stale-data rule: any metric whose source failed renders `—` with a footnote,
never a zero and never a silently carried-forward number.

## Sequencing

Phase 0 → 1 ship together and stand alone (3 of 5 columns live).
Phase 2 lands with Phase 1 — it is pure SQL.
Phase 3 is the long pole and ships behind the others.


---

## What shipped locally (2026-10-02)

New files:
- `services/scorecard.js` — builder + plain-text renderer
- `scripts/generate-alignment.js` — regenerates both embedded alignment files from the workbook
- `scripts/verify-alignment.js` — fails non-zero when USER_ROSTER drifts from the workbook
- `scripts/test-scorecard.js` — 22 assertions on the rollup arithmetic, no DB needed
- `scripts/test-brief-render.js` — end-to-end brief render with no API key

Changed:
- `routes/auth.js` — roster matches P10, Chad Magner retired
- `services/alignment-data.js`, `services/velocity-alignment.js` — regenerated, now generated not hand-edited
- `services/db.js` — `store_assignments.area` column + ALTER, carried through upsert and seeder
- `services/claude.js` — LLM performance section replaced by the scorecard plus a two-sentence lede
- `services/intel-pipeline.js`, `routes/intel.js` — build and pass the scorecard

## Bugs found along the way

1. **WIN score writes nothing** — the saved SMG favorite renders an empty table. Phase 3.
2. **Velocity join never matched** — `velocity_daily_records.store_id` is `S039377`,
   every other table uses `039377`. The brief's velocity query had always returned
   zero rows, which is why that data was fetched and never rendered. The scorecard
   bridges it; the dead query is gone.
3. **Excel eats leading zeros** — store 038876 reads back as 38876. Caught in the
   generator before it wrote 351 malformed keys. `SID()` pads to 6 digits.
4. **Three stadium kiosks dropped from P10** — AT&T Center / Frost Bank #1 and #2,
   and NRG Stadium, all under Imran Awan's Area 2100. Toyota Center stayed. The
   seeder deletes stores absent from alignment, so these will be purged from
   `store_assignments` on next boot. Confirm that is intended.

## Not done

- Nothing committed, nothing deployed.
- `/api/intel/automation/seed-hierarchy` needs a run after deploy to populate
  `store_assignments.area` and re-point flags at the P10 hierarchy.
- Two new area coaches (Jason McNeal, Lonie Johnson Jr) have roster entries and
  therefore logins on the shared default password. They have never signed in.
