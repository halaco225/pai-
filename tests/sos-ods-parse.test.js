// The SOS parser used to fall back to hard-coded column numbers when it could
// not match a heading, so a shifted report was read from the wrong columns and
// saved as real numbers. It must refuse the file instead.

const fs   = require('fs');
const os   = require('os');
const path = require('path');
const XLSX = require('xlsx');

const { parseSOSExcelODS } = require('../services/velocity-parser');

// Minimal stand-in for PH_Speed_Of_Service.xlsx: a summary header that also
// says "In Store", the chart placeholder rows, then the per-store header and
// one store row. `makeLabel` renames the Make column and `headerRow` moves the
// per-store header, which is what an added chart does to the real report.
function writeSheet({ makeLabel = 'Make', headerRow = 9 } = {}) {
  // Rows are padded to a fixed width: a sparse row past the sheet's widest
  // column is dropped on write, which would lose the date cell at col 23.
  const row = (pairs) => {
    const r = new Array(28).fill(null);
    for (const [i, v] of pairs) r[i] = v;
    return r;
  };
  const aoa = [];
  for (let i = 0; i <= headerRow + 1; i++) aoa.push(row([]));
  aoa[1] = row([[23, 46113]]);                       // report date, Excel serial
  aoa[3] = row([[0, 'On Time %'], [4, 'In Store'], [8, '# Deliveries']]);
  for (let i = 5; i < headerRow; i++) aoa[i] = row([[0, '[Flash Component Not Supported]']]);
  aoa[headerRow] = row([
    [3, 'On Time %'], [8, 'In Store'], [9, '# Del'], [11, makeLabel],
    [13, '% < 4'], [15, 'Oven / Cut'], [17, 'Production'], [19, '% < 15']
  ]);
  aoa[headerRow + 1] = row([
    [0, 'S039382'], [3, '72.4%'], [8, 17], [9, '29'], [11, '04:03'],
    [13, '59.4%'], [15, '26:14'], [17, '13:05'], [19, '87.2%']
  ]);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'SpeedOfService');
  const file = path.join(os.tmpdir(), `sos-test-${Date.now()}-${Math.random()}.xlsx`);
  XLSX.writeFile(wb, file);
  return file;
}

describe('parseSOSExcelODS', () => {
  const files = [];
  afterAll(() => files.forEach(f => { try { fs.unlinkSync(f); } catch (e) {} }));

  test('reads each value from the column its heading names', () => {
    const file = writeSheet();
    files.push(file);

    const { stores, reportDate } = parseSOSExcelODS(file);

    expect(reportDate).toBe('2026-04-01');
    expect(stores).toHaveLength(1);
    expect(stores[0]).toMatchObject({
      store_id:        'S039382',
      ist_avg:         17,
      total_orders:    29,
      make_time:       '04:03',
      pct_lt4:         59.4,
      production_time: '13:05',
      pct_lt15:        87.2,
      on_time_pct:     72.4
    });
  });

  // An added chart pushes the per-store header past where it used to be looked
  // for, which is what broke the 2026-11-05 pull.
  test('finds the per-store header wherever an added chart pushed it', () => {
    const file = writeSheet({ headerRow: 13 });
    files.push(file);

    const { stores } = parseSOSExcelODS(file);

    expect(stores).toHaveLength(1);
    expect(stores[0]).toMatchObject({
      store_id: 'S039382', ist_avg: 17, total_orders: 29,
      make_time: '04:03', production_time: '13:05', on_time_pct: 72.4
    });
  });

  test('refuses the file and names the heading when a column moves', () => {
    const file = writeSheet({ makeLabel: 'Make Time (min)' });
    files.push(file);

    expect(() => parseSOSExcelODS(file)).toThrow(/layout changed.*Make/s);
  });
});
