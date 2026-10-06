'use strict';
/**
 * scorecard.js — the hierarchy scorecard that opens every morning brief.
 *
 * One rule: show the reader their own level, plus the level directly beneath them.
 *
 *   VP (Territory)      own = territory     rows = region coaches under them
 *   RDO / Director      own = region        rows = area coaches under them
 *   Area Coach / DM     own = area          rows = stores under them
 *
 * Five metrics, no targets: sales + growth, IST, labor hours (actual vs scheduled),
 * WIN score PTD, missed routines.
 *
 * -- Rollup rule --------------------------------------------------------------
 * Sum the numerators, sum the denominators. Never average an average.
 *
 *  - Growth % is recomputed from summed sales and summed LY sales, not averaged
 *    from per-store percentages. LY is recovered per store as sales / (1 + growth),
 *    which is exact.
 *  - IST is weighted by total_orders. Since a store's ist_avg is minutes / orders,
 *    an order-weighted mean of store averages reproduces the true group average
 *    exactly -- this is algebra, not an approximation.
 *  - Labor hours sum, then the variance is taken on the sums.
 *  - WIN score is weighted by survey_count. Unlike the others this one is an
 *    approximation: Win Score is a composite index, so a survey-weighted mean of
 *    store scores is close to but not guaranteed equal to SMG's own group number.
 *    Groups carry win_approx so the brief can mark it.
 *
 * -- Missing data ------------------------------------------------------------
 * A metric with no contributing stores reports null, never 0, and every metric
 * carries a "reporting/total" coverage count so a thin denominator is visible
 * instead of passing for a real number.
 *
 * -- Store id formats --------------------------------------------------------
 * velocity_daily_records keys stores as "S039377"; store_assignments,
 * intel_dbs_metrics, dbs_soft_indicators, smg_win_scores and intel_flags all use
 * "039377". The velocity join has to bridge that, which is why it reads
 * v.store_id = 'S' || sa.store_id below. Joining them directly returns no rows.
 */

const LEVELS = {
  vp:         { own: 'territory', child: 'region' },
  rdo:        { own: 'region',    child: 'area'   },
  area_coach: { own: 'area',      child: 'store'  },
};

// -- Per-store pull ----------------------------------------------------------
// store_assignments is the spine, so grouping follows the current alignment even
// when a metric row was written under a coach name that has since changed.
const STORE_SQL = `
  SELECT sa.store_id,
         COALESCE(sa.store_name, sa.store_id) AS store_name,
         sa.area, sa.area_coach, sa.region_coach, sa.vp,
         m.net_sales_day::float   AS net_sales,
         m.growth_pct_day::float  AS growth_pct,
         v.ist_avg::float         AS ist_avg,
         v.total_orders::int      AS total_orders,
         la.value::float          AS act_hrs,
         ls.value::float          AS sch_hrs,
         w.win_score::float       AS win_score,
         w.survey_count::int      AS survey_count,
         COALESCE(mr.missed, 0)   AS missed_routines
    FROM store_assignments sa
    LEFT JOIN intel_dbs_metrics m
           ON m.store_id = sa.store_id AND m.metric_date = $1
    LEFT JOIN velocity_daily_records v
           ON v.store_id = 'S' || sa.store_id AND v.record_date = $1
    LEFT JOIN dbs_soft_indicators la
           ON la.store_id = sa.store_id AND la.metric_date = $1
          AND la.indicator = 'act_labor_hrs'
    LEFT JOIN dbs_soft_indicators ls
           ON ls.store_id = sa.store_id AND ls.metric_date = $1
          AND ls.indicator = 'sch_labor_hrs'
    LEFT JOIN LATERAL (
           SELECT win_score, survey_count
             FROM smg_win_scores
            WHERE store_id = sa.store_id
            ORDER BY period_end_date DESC
            LIMIT 1
         ) w ON TRUE
    LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS missed
             FROM intel_flags f
            WHERE f.store_id = sa.store_id
              AND f.metric_date = $1
              AND f.metric_type = 'ROUTINE_MISSED'
              AND f.status <> 'archived'
         ) mr ON TRUE
`;

function scopeClause(role, scope, name, params) {
  if (role === 'vp') {
    params.push((scope && scope.vp_name) || name);
    return `WHERE sa.vp = $${params.length}`;
  }
  if (role === 'rdo') {
    params.push((scope && scope.rc_name) || name);
    return `WHERE sa.region_coach = $${params.length}`;
  }
  if (role === 'area_coach') {
    params.push((scope && scope.ac_name) || name);
    return `WHERE sa.area_coach = $${params.length}`;
  }
  return '';   // no scope -- whole company
}

// -- Aggregation -------------------------------------------------------------
function blank(label) {
  return {
    label, stores: 0,
    sales: 0, ly_sales: 0, sales_n: 0,
    ist_minutes: 0, ist_orders: 0, ist_n: 0,
    act_hrs: 0, sch_hrs: 0, labor_n: 0,
    win_weighted: 0, win_surveys: 0, win_n: 0,
    missed_routines: 0,
  };
}

function accumulate(acc, r) {
  acc.stores++;

  if (r.net_sales != null) {
    acc.sales += r.net_sales;
    acc.sales_n++;
    // Recover LY from the growth percentage so group growth can be rebuilt from
    // sums:  growth = (sales - ly) / ly   ->   ly = sales / (1 + g).
    if (r.growth_pct != null && r.growth_pct > -100) {
      acc.ly_sales += r.net_sales / (1 + r.growth_pct / 100);
    } else {
      acc.ly_sales += r.net_sales;   // no LY signal -- treat as flat, not as growth
    }
  }

  if (r.ist_avg != null && r.total_orders > 0) {
    acc.ist_minutes += r.ist_avg * r.total_orders;
    acc.ist_orders  += r.total_orders;
    acc.ist_n++;
  }

  if (r.act_hrs != null || r.sch_hrs != null) {
    acc.act_hrs += r.act_hrs || 0;
    acc.sch_hrs += r.sch_hrs || 0;
    acc.labor_n++;
  }

  if (r.win_score != null) {
    const wt = r.survey_count > 0 ? r.survey_count : 1;
    acc.win_weighted += r.win_score * wt;
    acc.win_surveys  += wt;
    acc.win_n++;
  }

  acc.missed_routines += r.missed_routines || 0;
}

const r1 = n => Math.round(n * 10) / 10;

function finalize(acc) {
  return {
    label:  acc.label,
    stores: acc.stores,

    sales:          acc.sales_n ? Math.round(acc.sales) : null,
    growth_pct:     acc.sales_n && acc.ly_sales > 0
                      ? r1(((acc.sales - acc.ly_sales) / acc.ly_sales) * 100) : null,
    sales_coverage: `${acc.sales_n}/${acc.stores}`,

    ist:            acc.ist_orders > 0 ? r1(acc.ist_minutes / acc.ist_orders) : null,
    ist_coverage:   `${acc.ist_n}/${acc.stores}`,

    act_hrs:        acc.labor_n ? r1(acc.act_hrs) : null,
    sch_hrs:        acc.labor_n ? r1(acc.sch_hrs) : null,
    hrs_variance:   acc.labor_n ? r1(acc.act_hrs - acc.sch_hrs) : null,
    labor_coverage: `${acc.labor_n}/${acc.stores}`,

    win:            acc.win_surveys > 0 ? r1(acc.win_weighted / acc.win_surveys) : null,
    win_surveys:    acc.win_surveys,
    win_coverage:   `${acc.win_n}/${acc.stores}`,
    win_approx:     acc.win_n > 1,   // one store's score is its own, not a blend

    missed_routines: acc.missed_routines,
  };
}

// -- Public ------------------------------------------------------------------
/**
 * Build the scorecard for one reader.
 *
 * @returns {Promise<{level, childLevel, own, rows}|null>}
 *   own  -- the reader's own aggregated line
 *   rows -- one per child unit, worst growth first (that is what needs attention)
 *   null -- when the reader's scope matches no stores at all
 */
async function buildScorecard({ pool, targetDate, role, name, scope }) {
  if (!pool) return null;
  const level = LEVELS[role];
  if (!level) return null;

  const params = [targetDate];
  const where  = scopeClause(role, scope, name, params);
  const res    = await pool.query(`${STORE_SQL} ${where}`, params);
  if (!res.rows.length) return null;

  const childKey = role === 'vp'  ? 'region_coach'
                 : role === 'rdo' ? 'area_coach'
                 : 'store_id';

  const labelOf = (r) => {
    if (role === 'vp')  return r.region_coach || 'Unassigned';
    if (role === 'rdo') return r.area ? `${r.area} — ${r.area_coach}` : (r.area_coach || 'Unassigned');
    // Store number, not name. Two of Harold's stores are both called "Senoia"
    // and were indistinguishable in the text; the number is what identifies a
    // store on every other report anyway.
    return r.store_id || r.store_name;
  };

  const own    = blank(name);
  const groups = new Map();

  for (const r of res.rows) {
    accumulate(own, r);
    const key = r[childKey] || 'Unassigned';
    if (!groups.has(key)) groups.set(key, blank(labelOf(r)));
    accumulate(groups.get(key), r);
  }

  const rows = [...groups.values()].map(finalize).sort((a, b) => {
    if (a.growth_pct == null) return 1;    // no data sinks to the bottom
    if (b.growth_pct == null) return -1;
    return a.growth_pct - b.growth_pct;    // worst first
  });

  return { level: level.own, childLevel: level.child, own: finalize(own), rows };
}

// -- Rendering ---------------------------------------------------------------
// Plain text, fixed-width columns. The brief is read in email and in a <pre>
// block, so no markdown and no characters that need escaping.

const OWN_HEADING   = { territory: 'YOUR TERRITORY', region: 'YOUR REGION', area: 'YOUR AREA' };
const CHILD_HEADING = { region: 'BY REGION', area: 'BY AREA', store: 'BY STORE' };
const CHILD_COLUMN  = { region: 'Region', area: 'Area', store: 'Store' };

const money   = n => n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US');
const pct     = n => n == null ? '—' : (n >= 0 ? '+' : '') + n.toFixed(1) + '%';
const minutes = n => n == null ? '—' : n.toFixed(1);
const score   = n => n == null ? '—' : n.toFixed(1) + '%';
const signed  = n => n == null ? '—' : (n >= 0 ? '+' : '') + n.toFixed(1);

// Flag a metric whose denominator is thin — a number built from half the stores
// should not read like a number built from all of them.
function thin(coverage) {
  const [got, total] = String(coverage).split('/').map(Number);
  return total > 0 && got < total;
}

function truncate(s, n) {
  s = String(s == null ? '' : s);
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function renderScorecard(sc, opts) {
  if (!sc) return '';
  const o = sc.own;
  const notes = [];
  const lines = [];

  const heading = OWN_HEADING[sc.level] || 'YOUR SCORECARD';
  lines.push(`${heading}${opts && opts.fiscalCode ? ' — ' + opts.fiscalCode : ''}`);

  const cov = c => thin(c) ? `   (${c} reporting)` : '';

  lines.push(`  Sales             ${money(o.sales)}   ${pct(o.growth_pct)} vs LY${cov(o.sales_coverage)}`);
  lines.push(`  IST               ${minutes(o.ist)} min${cov(o.ist_coverage)}`);
  lines.push(`  Labor hrs         ${o.act_hrs == null ? '—' : o.act_hrs.toFixed(1) + ' act / ' + o.sch_hrs.toFixed(1) + ' sch'}   ${signed(o.hrs_variance)}${cov(o.labor_coverage)}`);
  lines.push(`  WIN PTD           ${score(o.win)}${o.win_approx ? ' *' : ''}${cov(o.win_coverage)}`);
  lines.push(`  Missed routines   ${o.missed_routines}`);

  if (o.win_approx) {
    notes.push('* WIN at this level is a survey-weighted blend of store scores, not SMG\'s own group figure.');
  }

  // Child table
  const nameCol = CHILD_COLUMN[sc.childLevel] || 'Unit';
  const w = sc.childLevel === 'store' ? 20 : 30;
  lines.push('');
  lines.push(CHILD_HEADING[sc.childLevel] || 'BREAKDOWN');
  lines.push([
    nameCol.padEnd(w),
    'Sales'.padStart(10),
    'Growth'.padStart(8),
    'IST'.padStart(6),
    'Labor hrs'.padStart(11),
    'WIN'.padStart(7),
    'Missed'.padStart(7),
  ].join(''));

  for (const r of sc.rows) {
    lines.push([
      truncate(r.label, w - 1).padEnd(w),
      money(r.sales).padStart(10),
      pct(r.growth_pct).padStart(8),
      minutes(r.ist).padStart(6),
      signed(r.hrs_variance).padStart(11),
      score(r.win).padStart(7),
      String(r.missed_routines || '—').padStart(7),
    ].join(''));
  }

  if (notes.length) { lines.push(''); notes.forEach(n => lines.push(n)); }
  return lines.join('\n');
}

module.exports = { buildScorecard, renderScorecard, LEVELS,
                   _internals: { blank, accumulate, finalize, thin } };
