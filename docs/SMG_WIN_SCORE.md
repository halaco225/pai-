# SMG Win Score — how the report is actually run

Captured 2026-10-03 by watching Harold run it in `reporting.smg.com`, because
`smg_win_scores` has **0 rows and no period recorded, ever** — the pull has
never once worked in production.

The data is there and the account can see it: Win Score showed 774 responses at
58% for the region over 9/8/2026–10/5/2026. So this is not a permissions or
data problem. The scraper is simply not producing this report.

## The recipe

Site: `https://reporting.smg.com` → **Report Builder** (`/ReportBuilder.aspx`).
Landing dashboard after login is `/dashboard.aspx?id=1`, scoped to
`My Region - #R-KDGI08-LACOSTE, HAROLD - PPP1393282REGNKDGI08`.

### 1. Report Type & Time Frame
| Field | Value |
|---|---|
| Type of report | **Comparison** |
| Date type | **Survey Date** — *not* Visit Date |
| Date range | **Current Fiscal Period** (auto-fills From/To, e.g. 9/8/2026 → 10/5/2026) |
| Compare to other dates | *Select One* (none) |

### 2. Units or Levels
| Field | Value |
|---|---|
| Generate report for this level | **Store** |
| Group by | **Area** |
| Units | all areas ticked |

**Grouping by Area while reporting at Store level is the whole trick** — one
pull returns the per-store rows *and* the area aggregate. Reporting at Area
level alone loses the stores; reporting at Store level without the grouping
loses the area number.

Area unit ids look like:
`A-DGI0401-GANNON, MARC - PPP1393282AREADGI0401 - PPP1393282AREADGI0401`

### 3. Data in Report
| Field | Value |
|---|---|
| Survey items | **Win Score** (the first item in the list) |
| Include hierarchy in report | **None** |

Then **Build Report**.

## The request to replicate

Clicking Build Report fires:

```
POST https://reporting.smg.com/handlers/ReportViewer.ashx
     ?function=getdata
     &reporttype=27          <- Comparison
     &reportsubtype=0
     &disableunits=false
     &r=<cache-buster>
     &translateBtnClicked=false&translateFlag=false
```

followed by a `POST /ReportBuilder.aspx` postback. The analytics pings on the
same click confirm the parameters, which is a useful cross-check:

- `ReportBuilder-ReportType-Full*27,:,0` — report type 27, subtype 0
- `ReportBuilder-ReportLevel*10` — level 10 = Store
- `Hierarchy*Project*UserGroup*Language` = `310-Region*YRI_PH_CSI*Ops_US*US`

## What comes back

A paginated table — **two pages** for this region, so a scraper that reads only
the first page silently loses half the stores.

```
Store                                                        Count  Win Score
Combined                                                       774    58%
1P038876 - 038876,8080 WELLS STREET, STE 2B,SENOIA,GA           34    47%
1P039375 - 039375,4221 BELLS FERRY DR., #103,KENNESAW,GA        13    61%
1P039376 - 039376,8876 DALLAS-ACWORTH HWY., #106,DALLAS,GA      24    48%
...
```

### Parsing notes

- **`Combined` is the aggregate row**, not a store. It is the Area/Region
  number when grouped.
- The store number is the **6-digit zero-padded** value immediately after the
  dash: `1P038876 - 038876,...` → `038876`. That matches
  `store_assignments.store_id` and `intel_dbs_metrics.store_id` directly — no
  bridging needed, unlike `velocity_daily_records` which uses `S039377`.
- Win Score is a **percentage string** (`47%`), not a number.
- `Count` is the response count. Rows below 30 render in gray and the page
  footnote warns the sample may mislead — worth storing alongside the score so
  the brief can suppress or mark a thin number rather than present `31%` from
  23 responses as fact.
- `**` marks a low response for that survey item.
- Pagination controls are `Page: 1 2 … Previous Next`.

## Still to do

- Point `services/intel-smg-winscore.js` at this report instead of the saved
  favorite. The handoff's lead — the login chain ending on `MultiLanguage.aspx`
  ("Reporting Site Selection") — is consistent with the favorite resolving
  against a different reporting site than the one holding the data.
- Page through to the end. Two pages here; other regions will differ.
- Write `smg_win_scores` with `store_id`, `win_score`, `survey_count`,
  `period_end_date`, and keep the Combined row as the area figure.
- Scope: Matt Hester's territory only for now, per Harold.
