// Run with: node --test tests/engine.test.js  (or: npm test)
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const E = require('../js/engine.js');
const D = require('../data/pilot/pilot_bundle.json');

test('workload conserves volume and is positive', () => {
  const wl = E.buildWorkload(D);
  assert.ok(Math.abs(wl.totalItems - D.tomorrow.p50) / D.tomorrow.p50 < 0.01, 'all forecast items land in the horizon');
  E.FUNCTIONS.forEach((f) => wl.required[f].forEach((v) => assert.ok(v >= 0)));
});

test('demand scenario scales required hours monotonically', () => {
  const r = [-10, 0, 10, 20].map((d) => E.evaluate(D, D.roster, { demandPct: d }).requiredHours);
  for (let i = 1; i < r.length; i++) assert.ok(r[i] > r[i - 1]);
});

test('roster is sized like the business case depot', () => {
  const ev = E.evaluate(D, D.roster);
  assert.ok(ev.cost.hours > 250 && ev.cost.hours < 450, `paid hours ${ev.cost.hours}`);
});

test('recommendations improve service and never raise late freight', () => {
  const rec = E.recommend(D, {});
  assert.ok(rec.actions.length >= 2);
  assert.ok(rec.after.sim.lateItems <= rec.base.sim.lateItems);
  assert.ok(rec.after.sim.ontimePct >= 99);
  rec.actions.forEach((a) => {
    assert.ok(a.confidence >= 50 && a.confidence <= 99);
    assert.ok(a.lateAfter <= a.lateBefore + 10, a.title);
  });
});

test('approving all actions reproduces the full plan', () => {
  const rec = E.recommend(D, {});
  const all = E.planWith(D, {}, rec, rec.actions.map((a) => a.id));
  assert.strictEqual(all.sim.lateItems, rec.after.sim.lateItems);
  assert.strictEqual(all.cost.aud, rec.after.cost.aud);
  const none = E.planWith(D, {}, rec, []);
  assert.strictEqual(none.sim.lateItems, rec.base.sim.lateItems);
});

test('stress scenarios are handled', () => {
  for (const sc of [{ demandPct: 15 }, { absences: 6 }, { linehaulDelayMin: 90 }]) {
    const rec = E.recommend(D, sc);
    assert.ok(rec.after.sim.lateItems < rec.base.sim.lateItems, JSON.stringify(sc));
  }
});

test('engine is deterministic', () => {
  const a = E.recommend(D, { absences: 3 }), b = E.recommend(D, { absences: 3 });
  assert.deepStrictEqual(a.actions.map((x) => x.title), b.actions.map((x) => x.title));
});
