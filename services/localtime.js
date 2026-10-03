// services/localtime.js
//
// Every local-date and local-time decision in P.AI goes through here.
//
// Why this file exists: Render's cron is UTC-only and has no idea daylight
// saving exists, so a job pinned to a UTC hour runs at 6am Eastern for five
// months a year and 7am for the other seven. Asking the clock what time it is
// *there*, on every tick, is right year-round with no annual edit. The same
// applies to "today": UTC rolls over hours before any US zone does, so a UTC
// date used for a local-day decision is wrong every night.

// YYYY-MM-DD in `tz`. en-CA formats as ISO, which is why it is used here.
function localDate(date, tz) {
  return date.toLocaleDateString('en-CA', { timeZone: tz });
}

// HH:MM, 24-hour, zero-padded, in `tz`. en-GB gives 24-hour with no AM/PM.
function localHHMM(date, tz) {
  return date.toLocaleTimeString('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

// Plain string arithmetic on a YYYY-MM-DD, via UTC so no zone can shift it.
function minusDays(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() - n);
  return dt.toISOString().slice(0, 10);
}

// Is the local wall clock in `tz` at or past `hhmm` ("06:00")?
// Lexical compare is safe because both sides are zero-padded HH:MM.
function isAtOrAfter(date, tz, hhmm) {
  return localHHMM(date, tz) >= hhmm;
}

module.exports = { localDate, localHHMM, minusDays, isAtOrAfter };
