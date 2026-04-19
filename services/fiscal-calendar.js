// ─── Pizza Hut / Ayvaz U.S. Fiscal Calendar 2025-2030 ────────────────────────
// Embedded permanently — no upload ever needed.
// 13 fiscal periods per year, each exactly 4 weeks (28 days).
// Fiscal year starts in late December of the prior calendar year.
// Week 1 = first week of P1, Week 52 = last week of P13.

const FISCAL_PERIODS = [
  // ── FY 2025 ──────────────────────────────────────────────────────────────
  { period: 1,  year: 2025, start: '2024-12-26', end: '2025-01-22', weeks: '1-4'   },
  { period: 2,  year: 2025, start: '2025-01-23', end: '2025-02-19', weeks: '5-8'   },
  { period: 3,  year: 2025, start: '2025-02-20', end: '2025-03-19', weeks: '9-12'  },
  { period: 4,  year: 2025, start: '2025-03-20', end: '2025-04-16', weeks: '13-16' },
  { period: 5,  year: 2025, start: '2025-04-17', end: '2025-05-14', weeks: '17-20' },
  { period: 6,  year: 2025, start: '2025-05-15', end: '2025-06-11', weeks: '21-24' },
  { period: 7,  year: 2025, start: '2025-06-12', end: '2025-07-09', weeks: '25-28' },
  { period: 8,  year: 2025, start: '2025-07-10', end: '2025-08-06', weeks: '29-32' },
  { period: 9,  year: 2025, start: '2025-08-07', end: '2025-09-03', weeks: '33-36' },
  { period: 10, year: 2025, start: '2025-09-04', end: '2025-10-01', weeks: '37-40' },
  { period: 11, year: 2025, start: '2025-10-02', end: '2025-10-29', weeks: '41-44' },
  { period: 12, year: 2025, start: '2025-10-30', end: '2025-11-26', weeks: '45-48' },
  { period: 13, year: 2025, start: '2025-12-02', end: '2025-12-29', weeks: '49-52' },

  // ── FY 2026 ──────────────────────────────────────────────────────────────
  { period: 1,  year: 2026, start: '2025-12-30', end: '2026-01-26', weeks: '1-4'   },
  { period: 2,  year: 2026, start: '2026-01-27', end: '2026-02-23', weeks: '5-8'   },
  { period: 3,  year: 2026, start: '2026-02-24', end: '2026-03-23', weeks: '9-12'  },
  { period: 4,  year: 2026, start: '2026-03-24', end: '2026-04-20', weeks: '13-16' },
  { period: 5,  year: 2026, start: '2026-04-21', end: '2026-05-18', weeks: '17-20' },
  { period: 6,  year: 2026, start: '2026-05-19', end: '2026-06-15', weeks: '21-24' },
  { period: 7,  year: 2026, start: '2026-06-16', end: '2026-07-13', weeks: '25-28' },
  { period: 8,  year: 2026, start: '2026-07-14', end: '2026-08-10', weeks: '29-32' },
  { period: 9,  year: 2026, start: '2026-08-11', end: '2026-09-07', weeks: '33-36' },
  { period: 10, year: 2026, start: '2026-09-08', end: '2026-10-05', weeks: '37-40' },
  { period: 11, year: 2026, start: '2026-10-06', end: '2026-11-02', weeks: '41-44' },
  { period: 12, year: 2026, start: '2026-11-03', end: '2026-11-30', weeks: '45-48' },
  { period: 13, year: 2026, start: '2026-12-01', end: '2026-12-28', weeks: '49-52' },

  // ── FY 2027 ──────────────────────────────────────────────────────────────
  { period: 1,  year: 2027, start: '2026-12-29', end: '2027-01-25', weeks: '1-4'   },
  { period: 2,  year: 2027, start: '2027-01-26', end: '2027-02-22', weeks: '5-8'   },
  { period: 3,  year: 2027, start: '2027-02-23', end: '2027-03-22', weeks: '9-12'  },
  { period: 4,  year: 2027, start: '2027-03-23', end: '2027-04-19', weeks: '13-16' },
  { period: 5,  year: 2027, start: '2027-04-20', end: '2027-05-17', weeks: '17-20' },
  { period: 6,  year: 2027, start: '2027-05-18', end: '2027-06-14', weeks: '21-24' },
  { period: 7,  year: 2027, start: '2027-06-15', end: '2027-07-12', weeks: '25-28' },
  { period: 8,  year: 2027, start: '2027-07-13', end: '2027-08-09', weeks: '29-32' },
  { period: 9,  year: 2027, start: '2027-08-10', end: '2027-09-06', weeks: '33-36' },
  { period: 10, year: 2027, start: '2027-09-07', end: '2027-10-04', weeks: '37-40' },
  { period: 11, year: 2027, start: '2027-10-05', end: '2027-11-01', weeks: '41-44' },
  { period: 12, year: 2027, start: '2027-11-02', end: '2027-11-29', weeks: '45-48' },
  { period: 13, year: 2027, start: '2027-11-30', end: '2027-12-27', weeks: '49-52' },

  // ── FY 2028 ──────────────────────────────────────────────────────────────
  { period: 1,  year: 2028, start: '2027-12-28', end: '2028-01-24', weeks: '1-4'   },
  { period: 2,  year: 2028, start: '2028-01-25', end: '2028-02-21', weeks: '5-8'   },
  { period: 3,  year: 2028, start: '2028-02-22', end: '2028-03-20', weeks: '9-12'  },
  { period: 4,  year: 2028, start: '2028-03-21', end: '2028-04-17', weeks: '13-16' },
  { period: 5,  year: 2028, start: '2028-04-18', end: '2028-05-15', weeks: '17-20' },
  { period: 6,  year: 2028, start: '2028-05-16', end: '2028-06-12', weeks: '21-24' },
  { period: 7,  year: 2028, start: '2028-06-13', end: '2028-07-10', weeks: '25-28' },
  { period: 8,  year: 2028, start: '2028-07-11', end: '2028-08-07', weeks: '29-32' },
  { period: 9,  year: 2028, start: '2028-08-08', end: '2028-09-04', weeks: '33-36' },
  { period: 10, year: 2028, start: '2028-09-05', end: '2028-10-02', weeks: '37-40' },
  { period: 11, year: 2028, start: '2028-10-03', end: '2028-10-30', weeks: '41-44' },
  { period: 12, year: 2028, start: '2028-10-31', end: '2028-11-27', weeks: '45-48' },
  { period: 13, year: 2028, start: '2028-11-28', end: '2028-12-25', weeks: '49-52' },

  // ── FY 2029 ──────────────────────────────────────────────────────────────
  { period: 1,  year: 2029, start: '2028-12-26', end: '2029-01-22', weeks: '1-4'   },
  { period: 2,  year: 2029, start: '2029-01-23', end: '2029-02-19', weeks: '5-8'   },
  { period: 3,  year: 2029, start: '2029-02-20', end: '2029-03-19', weeks: '9-12'  },
  { period: 4,  year: 2029, start: '2029-03-20', end: '2029-04-16', weeks: '13-16' },
  { period: 5,  year: 2029, start: '2029-04-17', end: '2029-05-14', weeks: '17-20' },
  { period: 6,  year: 2029, start: '2029-05-15', end: '2029-06-11', weeks: '21-24' },
  { period: 7,  year: 2029, start: '2029-06-12', end: '2029-07-09', weeks: '25-28' },
  { period: 8,  year: 2029, start: '2029-07-10', end: '2029-08-06', weeks: '29-32' },
  { period: 9,  year: 2029, start: '2029-08-07', end: '2029-09-03', weeks: '33-36' },
  { period: 10, year: 2029, start: '2029-09-04', end: '2029-10-01', weeks: '37-40' },
  { period: 11, year: 2029, start: '2029-10-02', end: '2029-10-29', weeks: '41-44' },
  { period: 12, year: 2029, start: '2029-10-30', end: '2029-11-26', weeks: '45-48' },
  { period: 13, year: 2029, start: '2029-11-27', end: '2029-12-24', weeks: '49-52' },

  // ── FY 2030 ──────────────────────────────────────────────────────────────
  { period: 1,  year: 2030, start: '2029-12-25', end: '2030-01-21', weeks: '1-4'   },
  { period: 2,  year: 2030, start: '2030-01-22', end: '2030-02-18', weeks: '5-8'   },
  { period: 3,  year: 2030, start: '2030-02-19', end: '2030-03-18', weeks: '9-12'  },
  { period: 4,  year: 2030, start: '2030-03-19', end: '2030-04-15', weeks: '13-16' },
  { period: 5,  year: 2030, start: '2030-04-16', end: '2030-05-13', weeks: '17-20' },
  { period: 6,  year: 2030, start: '2030-05-14', end: '2030-06-10', weeks: '21-24' },
  { period: 7,  year: 2030, start: '2030-06-11', end: '2030-07-08', weeks: '25-28' },
  { period: 8,  year: 2030, start: '2030-07-09', end: '2030-08-05', weeks: '29-32' },
  { period: 9,  year: 2030, start: '2030-08-06', end: '2030-09-02', weeks: '33-36' },
  { period: 10, year: 2030, start: '2030-09-03', end: '2030-09-30', weeks: '37-40' },
  { period: 11, year: 2030, start: '2030-10-01', end: '2030-10-28', weeks: '41-44' },
  { period: 12, year: 2030, start: '2030-10-29', end: '2030-11-25', weeks: '45-48' },
  { period: 13, year: 2030, start: '2030-11-26', end: '2030-12-23', weeks: '49-52' },
];

/**
 * Returns the current fiscal period info based on today's date.
 * { period, year, start, end, weeks, weekOfPeriod, weekOfYear }
 */
function getCurrentFiscalPeriod(today) {
  const d = today || new Date();
  const todayStr = d.toISOString().slice(0, 10);

  for (const p of FISCAL_PERIODS) {
    if (todayStr >= p.start && todayStr <= p.end) {
      const startDate = new Date(p.start);
      const diffDays = Math.floor((d - startDate) / (1000 * 60 * 60 * 24));
      const weekOfPeriod = Math.floor(diffDays / 7) + 1;
      const [w1] = p.weeks.split('-').map(Number);
      const weekOfYear = w1 + Math.floor(diffDays / 7);
      return { ...p, weekOfPeriod, weekOfYear };
    }
  }
  return null;
}

/**
 * Returns a human-readable string for injection into AI prompts.
 * e.g. "Today is P4W3 of FY2026 (Apr 14 - Apr 20, 2026). Period 4 runs Mar 24 - Apr 20."
 */
function getFiscalContextString(today) {
  const p = getCurrentFiscalPeriod(today);
  if (p == null) return '';
  const startFmt = new Date(p.start).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const endFmt   = new Date(p.end).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return (
    'FISCAL CALENDAR CONTEXT: Today is Period ' + p.period + ', Week ' + p.weekOfPeriod +
    ' of FY' + p.year + ' (P' + p.period + 'W' + p.weekOfPeriod + '). ' +
    'Fiscal weeks ' + p.weeks + ' of the year. ' +
    'This period runs ' + startFmt + ' through ' + endFmt + '. ' +
    'The fiscal year has 13 periods of 4 weeks each (52 weeks total). ' +
    'Periods run Tuesday-to-Monday. Weekly recap day is Thursday.'
  );
}

module.exports = { FISCAL_PERIODS, getCurrentFiscalPeriod, getFiscalContextString };
