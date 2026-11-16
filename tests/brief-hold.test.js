// tests/brief-hold.test.js
//
// 2026-11-16: the 8:30 text went out reading "Labor still posting" and "Chz
// not reporting" for 11/15. Both numbers were on the intel page later the same
// morning. The scorecard is built live at send time, so this was not a stale
// cache -- at 08:30 not one store had a cheese row for the day and Fourth was
// still posting punches. The text was honest; it was just early.
//
// So: hold the send while the numbers are still landing, and send anyway at a
// backstop. The backstop has to sit inside the 08:30-09:05 window, because
// Harold asked for the brief between 8 and 9 and brief-due.test.js pins that.
const {
  holdForData, DATA_BACKSTOP_LOCAL, SEND_WINDOW_MINUTES, inCatchupWindow,
} = require('../services/brief-sms');

const toMin = hhmm => Number(hhmm.split(':')[0]) * 60 + Number(hhmm.split(':')[1]);

describe('holdForData', () => {
  // 12:35Z is 08:35 EDT — inside the window, before the backstop.
  const early = new Date('2026-10-05T12:35:00Z');

  test('holds while the numbers are still landing', () => {
    expect(holdForData({ now: early, ready: false })).toBe(true);
  });

  test('does not hold once the numbers are in', () => {
    expect(holdForData({ now: early, ready: true })).toBe(false);
  });

  // A text that never arrives is worse than one that says "not reporting".
  test('sends at the backstop even if the numbers never land', () => {
    const atBackstop = new Date('2026-10-05T13:00:00Z'); // 09:00 EDT
    expect(holdForData({ now: atBackstop, ready: false })).toBe(false);
  });

  test('sends after the backstop even if the numbers never land', () => {
    const late = new Date('2026-10-05T13:02:00Z'); // 09:02 EDT
    expect(holdForData({ now: late, ready: false })).toBe(false);
  });

  // The whole point of a backstop is that it is reachable. Past the send
  // window nothing sends at all, so a backstop outside it would mean a day
  // with late cheese produced no text whatsoever.
  test('the backstop sits inside the send window', () => {
    expect(toMin(DATA_BACKSTOP_LOCAL)).toBeLessThan(toMin('08:30') + SEND_WINDOW_MINUTES);
  });

  // Harold asked for it between 8 and 9.
  test('the backstop stays inside the hour he asked for', () => {
    expect(toMin(DATA_BACKSTOP_LOCAL)).toBeLessThanOrEqual(toMin('09:00'));
  });

  // The hold is decided on the clock the feeds keep, not the reader's. A
  // Pacific recipient is due at 08:30 their time, which is 11:30 Eastern --
  // hours after the feeds settled. Holding them to a Pacific 09:00 would wait
  // on flags that stopped being read at Eastern 09:00.
  test('the backstop is Eastern, whatever zone the reader is in', () => {
    const pacificMorning = new Date('2026-10-05T15:35:00Z'); // 08:35 PDT, 11:35 EDT
    expect(holdForData({ now: pacificMorning, ready: false })).toBe(false);
  });
});

// A hold is only worth anything if something is still pulling during it. The
// catch-up used to stop at the send time, so an 08:30-09:00 wait would have
// sat there with no pulls running and sent the same incomplete text half an
// hour later -- worse than not waiting at all.
describe('inCatchupWindow', () => {
  test('is open before the send, as it always was', () => {
    expect(inCatchupWindow(new Date('2026-10-05T11:30:00Z'))).toBe(true); // 07:30 EDT
  });

  test('stays open between the send and the backstop', () => {
    expect(inCatchupWindow(new Date('2026-10-05T12:45:00Z'))).toBe(true); // 08:45 EDT
  });

  test('closes at the backstop, so nothing re-runs all day', () => {
    expect(inCatchupWindow(new Date('2026-10-05T13:00:00Z'))).toBe(false); // 09:00 EDT
  });

  test('is shut before the catch-up starts', () => {
    expect(inCatchupWindow(new Date('2026-10-05T10:30:00Z'))).toBe(false); // 06:30 EDT
  });
});
