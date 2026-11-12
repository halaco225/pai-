// Daily Intel is supposed to cover the whole territory — all three regions
// under the VP, not just the region the ODS login happens to sit in. Only
// SUS_DBS asked for the territory; the other five reports came back as
// hlacoste's own region, so Lori's and Preston's stores were never in the data.
//
// The ask has to be retryable: if a report's input controls do not include
// orgType, the territory ask fails and the day's data must still arrive. So
// every scoped report has two param sets — the territory one, then the plain
// one — and the fallback is logged rather than silent.

describe('ODS territory scoping', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; });

  // The territory id is read when the module loads; the off switch is read on
  // every call. So the env stays set for the whole test, not just the require.
  const load = (env = {}) => {
    jest.resetModules();
    Object.assign(process.env, env);
    return require('../services/intel-ods');
  };

  test('a plain report asks for the territory first, then falls back', () => {
    const { paramSets } = load({ ODS_TERRITORY_ID: '26' });
    const sets = paramSets('DBS');
    expect(sets).toHaveLength(2);
    expect(sets[0]).toEqual({ orgType: 'territory', orgTypeValue: '26' });
    expect(sets[1]).toEqual({});
  });

  test('every report the pipeline pulls is territory-scoped', () => {
    const { paramSets } = load();
    for (const key of ['DBS', 'SOS', 'PAYROLL', 'CHANGE_DOWN', 'CANCEL_TENDER', 'SUS_DBS']) {
      expect(paramSets(key)[0].orgType).toBe('territory');
    }
  });

  test('SUS_DBS keeps its own params alongside the scope', () => {
    const { paramSets } = load();
    const [scoped, fallback] = paramSets('SUS_DBS');
    expect(scoped.groupBy).toBe('store_number');
    expect(scoped.orgType).toBe('territory');
    expect(fallback.groupBy).toBe('store_number');
    expect(fallback.orgType).toBeUndefined();
    // No store list: empty means every store in the territory.
    expect(scoped.storeIdsPH).toBeUndefined();
  });

  test('the territory id is configurable and defaults to Matt Hester', () => {
    expect(load().paramSets('DBS')[0].orgTypeValue).toBe('26');
    expect(load({ ODS_TERRITORY_ID: '31' }).paramSets('DBS')[0].orgTypeValue).toBe('31');
  });

  test('ODS_TERRITORY_SCOPE=off goes back to one unscoped pull', () => {
    const { paramSets } = load({ ODS_TERRITORY_SCOPE: 'off' });
    expect(paramSets('DBS')).toEqual([{}]);
    expect(paramSets('SUS_DBS')).toHaveLength(1);
    expect(paramSets('SUS_DBS')[0].orgType).toBeUndefined();
  });
});
