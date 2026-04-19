// =====================================================================
// VELOCITY COMPUTE — WTD/PTD aggregation and trend calculations
// =====================================================================
'use strict';

const { ALIGNMENT } = require('./velocity-alignment');

// ── Fiscal calendar (Tue–Mon weeks) ─────────────────────────────────
const FISCAL_CALENDAR = {
  "2025-12-30":"P1W1","2026-01-06":"P1W2","2026-01-13":"P1W3","2026-01-20":"P1W4",
  "2026-01-27":"P2W1","2026-02-03":"P2W2","2026-02-10":"P2W3","2026-02-17":"P2W4",
  "2026-02-24":"P3W1","2026-03-03":"P3W2","2026-03-10":"P3W3","2026-03-17":"P3W4",
  "2026-03-24":"P4W1","2026-03-31":"P4W2","2026-04-07":"P4W3","2026-04-14":"P4W4",
  "2026-04-21":"P5W1","2026-04-28":"P5W2","2026-05-05":"P5W3","2026-05-12":"P5W4",
  "2026-05-19":"P6W1","2026-05-26":"P6W2","2026-06-02":"P6W3","2026-06-09":"P6W4",
  "2026-06-16":"P7W1","2026-06-23":"P7W2","2026-06-30":"P7W3","2026-07-07":"P7W4",
  "2026-07-14":"P8W1","2026-07-21":"P8W2","2026-07-28":"P8W3","2026-08-04":"P8W4",
  "2026-08-11":"P9W1","2026-08-18":"P9W2","2026-08-25":"P9W3","2026-09-01":"P9W4",
  "2026-09-08":"P10W1","2026-09-15":"P10W2","2026-09-22":"P10W3","2026-09-29":"P10W4",
  "2026-10-06":"P11W1","2026-10-13":"P11W2","2026-10-20":"P11W3","2026-10-27":"P11W4",
  "2026-11-03":"P12W1","2026-11-10":"P12W2","2026-11-17":"P12W3","2026-11-24":"P12W4",
  "2026-12-01":"P13W1","2026-12-08":"P13W2","2026-12-15":"P13W3","2026-12-22":"P13W4",
  "2026-12-29":"P1W1","2027-01-05":"P1W2","2027-01-12":"P1W3","2027-01-19":"P1W4",
  "2027-01-26":"P2W1","2027-02-02":"P2W2","2027-02-09":"P2W3","2027-02-16":"P2W4",
  "2027-02-23":"P3W1","2027-03-02":"P3W2","2027-03-09":"P3W3","2027-03-16":"P3W4",
  "2027-03-23":"P4W1","2027-03-30":"P4W2","2027-04-06":"P4W3","2027-04-13":"P4W4"
};

function getWeekKey(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const day = d.getUTCDay();
  const daysFromTue = (day + 5) % 7;
  const tue = new Date(d);
  tue.setUTCDate(d.getUTCDate() - daysFromTue);
  return tue.toISOString().split('T')[0];
}

function getPeriodWeek(dateStr) {
  const weekKey = getWeekKey(dateStr);
  return FISCAL_CALENDAR[weekKey] || 'P?W?';
}

function getWeekDateRange(weekKey) {
  if (\!weekKey) return '';
  try {
    const tue = new Date(weekKey + 'T12:00:00Z');
    const mon = new Date(tue);
    mon.setUTCDate(tue.getUTCDate() + 6);
    const fmt = d => `${d.getUTCMonth()+1}/${d.getUTCDate()}`;
    return `${fmt(tue)}–${fmt(mon)}`;
  } catch(e) { return ''; }
}

// "Yesterday" in America/Chicago (handles DST)
function getYesterdayChicago() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago',
    year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const d = parts.find(p => p.type === 'day').value;
  const chicagoToday = new Date(`${y}-${m}-${d}T00:00:00Z`);
  chicagoToday.setUTCDate(chicagoToday.getUTCDate() - 1);
  return chicagoToday.toISOString().slice(0, 10);
}

// ── Compute WTD aggregates from raw DB rows ──────────────────────────
function computeWTD(records) {
  // records: array of velocity_daily_records rows for one week
  // Group by store, average across days
  const byStore = {};
  for (const r of records) {
    if (\!byStore[r.store_id]) byStore[r.store_id] = [];
    byStore[r.store_id].push(r);
  }

  const stores = [];
  for (const [storeId, days] of Object.entries(byStore)) {
    const align = ALIGNMENT[storeId];
    if (\!align) continue;

    const validIST = days.filter(d => d.ist_avg \!= null);
    const wtd_ist = validIST.length > 0
      ? Math.round((validIST.reduce((a, d) => a + parseFloat(d.ist_avg), 0) / validIST.length) * 10) / 10
      : null;

    const wtd_lt19_pct = validIST.length > 0
      ? Math.round(validIST.reduce((a, d) => a + (parseFloat(d.ist_lt19_pct) || 0), 0) / validIST.length * 10) / 10
      : null;

    const wtd_lt10 = days.reduce((a, d) => a + (d.ist_lt10 || 0), 0);
    const wtd_1014 = days.reduce((a, d) => a + (d.ist_1014 || 0), 0);
    const wtd_1518 = days.reduce((a, d) => a + (d.ist_1518 || 0), 0);
    const wtd_1925 = days.reduce((a, d) => a + (d.ist_1925 || 0), 0);
    const wtd_gt25 = days.reduce((a, d) => a + (d.ist_gt25 || 0), 0);
    const wtd_orders = days.reduce((a, d) => a + (d.total_orders || 0), 0);

    // Build daily breakdown map
    const daily = {};
    for (const d of days) {
      const dateStr = d.record_date instanceof Date
        ? d.record_date.toISOString().split('T')[0]
        : String(d.record_date).split('T')[0];
      daily[dateStr] = {
        ist_avg: d.ist_avg ? parseFloat(d.ist_avg) : null,
        ist_lt10: d.ist_lt10, ist_1014: d.ist_1014, ist_1518: d.ist_1518,
        ist_1925: d.ist_1925, ist_gt25: d.ist_gt25,
        ist_lt19_pct: d.ist_lt19_pct ? parseFloat(d.ist_lt19_pct) : null,
        total_orders: d.total_orders,
        make_time: d.make_time, pct_lt4: d.pct_lt4,
        production_time: d.production_time, pct_lt15: d.pct_lt15
      };
    }

    stores.push({
      store_id: storeId,
      name: align.name,
      area: align.area,
      area_coach: align.area_coach,
      region_coach: align.region_coach,
      days_reported: days.length,
      wtd_ist,
      wtd_lt19_pct,
      wtd_lt10, wtd_1014, wtd_1518, wtd_1925, wtd_gt25,
      wtd_orders,
      daily
    });
  }

  return stores.sort((a, b) => (a.wtd_ist || 99) - (b.wtd_ist || 99));
}

// ── Build IST color class ────────────────────────────────────────────
function istColorClass(ist) {
  if (\!ist) return 'ist-none';
  if (ist <= 18) return 'ist-green';
  if (ist <= 20) return 'ist-yellow';
  if (ist <= 25) return 'ist-orange';
  return 'ist-red';
}

function istColor(ist) {
  if (\!ist) return '#aaa';
  if (ist <= 18) return '#28a745';
  if (ist <= 20) return '#ffc107';
  if (ist <= 25) return '#fd7e14';
  return '#dc3545';
}

// ── DOW pattern analysis ─────────────────────────────────────────────
const DOW_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function analyzeDOWPatterns(dowRows) {
  // dowRows: [{dow, day_name, avg_ist, sample_count}]
  if (\!dowRows.length) return [];
  const avg = dowRows.reduce((a, r) => a + parseFloat(r.avg_ist), 0) / dowRows.length;
  return dowRows.map(r => ({
    dow: parseInt(r.dow),
    day_name: r.day_name.trim(),
    avg_ist: Math.round(parseFloat(r.avg_ist) * 10) / 10,
    sample_count: parseInt(r.sample_count),
    vs_avg: Math.round((parseFloat(r.avg_ist) - avg) * 10) / 10,
    insight: getInsight(r.avg_ist, avg)
  })).sort((a, b) => a.dow - b.dow);
}

function getInsight(ist, avg) {
  const delta = parseFloat(ist) - avg;
  if (delta > 1.5) return 'typically slower';
  if (delta < -1.5) return 'typically fastest';
  if (delta > 0.5) return 'slightly above average';
  if (delta < -0.5) return 'slightly below average';
  return 'average pace';
}

module.exports = {
  getWeekKey, getPeriodWeek, getWeekDateRange,
  getYesterdayChicago, computeWTD, istColorClass, istColor,
  analyzeDOWPatterns, FISCAL_CALENDAR, DOW_NAMES
};
