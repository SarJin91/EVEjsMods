"use strict";

const assert = require("node:assert");

const { buildPopulationPanel } = require("../../lib/population/view");

const T0 = 1700000000000;
const DAY = 86400000;
const P = Object.freeze({ near: { enabled: false }, observer: { refreshMs: 60000, maxSystems: 50 } });
const KEYS_BEFORE = ["available", "status", "size", "byState", "tiers", "eventsPerSec", "lagMs", "flush", "counters",
  "nearEnabled", "generatedAt"];
const LIFE_COUNTERS = Object.freeze({ "lifecycle.away": 0, "lifecycle.awayCapped": 0, "lifecycle.returned": 0,
  "lifecycle.returnedHome": 0, "lifecycle.quit": 0, "lifecycle.reborn": 0, "lifecycle.rookieFallback": 0,
  "lifecycle.wakeFailed": 0, "lifecycle.promoted": 0, "lifecycle.homeMoved": 0, "lifecycle.careerSeeded": 0,
  "corps.founded": 0, "corps.dissolved": 0, "corps.dissolvedInactive": 0, "corps.skippedInactive": 0 });

function statusOf(extra = {}, counters = {}) {
  return Object.freeze({ state: "running", size: 1000, loaded: 1000, queue: 1000, dirty: 0,
    byState: { DOCKED: 700, TRAVEL: 300 }, lastPass: { lagMs: 12 }, lastFlush: null, eventsTotal: 0,
    counters: { ...LIFE_COUNTERS, ...counters }, activeLife: { enabled: false }, standings: { enabled: false },
    ...extra });
}

function rig(status) {
  const box = { status, t: T0 };
  const panel = buildPopulationPanel({ service: { getStatus: () => box.status }, settings: P,
    clock: { now: () => box.t } });
  return { panel, set(s, at) {
    box.status = s;
    box.t = at;
  } };
}

const LIFE = Object.freeze({ enabled: true, rookieSystems: 8, away: 150, awayCap: 400,
  career: { byCareer: { UNASSIGNED: 10, ROOKIE: 300, PILOT: 400, SEASONED: 200, VETERAN: 90 } } });
const CORPS = Object.freeze({ enabled: true, open: 12, members: 300, activity: { extraEntries: 0, compactions: 0 } });

module.exports = ({ test }) => {
  test("LV1 flag off: no lifecycle block, the keys and values as before (also a day later); flag on = block", () => {
    const st = statusOf();
    const r = rig(st);
    const a = r.panel.getData();
    assert.deepStrictEqual(Object.keys(a), KEYS_BEFORE);
    assert.deepStrictEqual(a, { available: true, status: st, size: 1000, byState: st.byState, tiers: null,
      eventsPerSec: null, lagMs: 12, flush: null, counters: st.counters, nearEnabled: false, generatedAt: T0 });
    r.set(statusOf({}, { "lifecycle.reborn": 5 }), T0 + DAY);
    const b = r.panel.getData();
    assert.deepStrictEqual(Object.keys(b), KEYS_BEFORE);
    assert.strictEqual(b.lifecycle, undefined);
    const on = rig(statusOf({ lifecycle: { enabled: true, rookieSystems: 0, away: 0, awayCap: 0 } })).panel.getData();
    assert.deepStrictEqual(Object.keys(on), [...KEYS_BEFORE.slice(0, -1), "lifecycle", "generatedAt"]);
  });

  test("LV2 the block: AWAY share, per-day rates since the first read, careers, corps, size 0", () => {
    const START = { "lifecycle.reborn": 4, "corps.skippedInactive": 2, "lifecycle.careerSeeded": 900 };
    const r = rig(statusOf({ lifecycle: LIFE, corps: CORPS }, START));
    const first = r.panel.getData().lifecycle;
    assert.strictEqual(first.windowMs, 0);
    assert.strictEqual(first.perDay, null);
    assert.deepStrictEqual([first.away, first.awayCap, first.awayPermille, first.rookieSystems], [150, 400, 150, 8]);
    r.set(statusOf({ lifecycle: LIFE, corps: CORPS }, { ...START, "lifecycle.reborn": 44,
      "corps.dissolvedInactive": 3, "corps.skippedInactive": 9 }), T0 + 2 * DAY);
    const b = r.panel.getData().lifecycle;
    assert.strictEqual(b.windowMs, 2 * DAY);
    assert.deepStrictEqual(b.perDay, { away: 0, returned: 0, quit: 0, reborn: 20, promoted: 0, homeMoved: 0,
      dissolvedInactive: 1.5 });
    assert.deepStrictEqual(b.totals, { awayCapped: 0, returnedHome: 0, rookieFallback: 0, wakeFailed: 0,
      careerSeeded: 900 });
    assert.deepStrictEqual(b.byCareer, LIFE.career.byCareer);
    assert.deepStrictEqual([b.corps.open, b.corps.dissolved, b.corps.dissolvedInactive, b.corps.skippedCandidates],
      [12, 0, 3, 9]);
    assert.ok(typeof b.corps.note === "string" && b.corps.note.length > 0);

    const { career: _c, ...noCareer } = LIFE;
    const { activity: _a, ...noActivity } = CORPS;
    const r2 = rig(statusOf({ lifecycle: noCareer, corps: noActivity }));
    r2.panel.getData();
    r2.set(statusOf({ lifecycle: noCareer, corps: noActivity }, { "lifecycle.reborn": 10 }), T0 + DAY);
    const c = r2.panel.getData().lifecycle;
    assert.strictEqual(c.byCareer, undefined);
    assert.strictEqual(c.corps, undefined);
    assert.deepStrictEqual(c.perDay, { away: 0, returned: 0, quit: 0, reborn: 10 });
    assert.strictEqual(c.totals.careerSeeded, undefined);

    const z = rig(statusOf({ size: 0, lifecycle: LIFE })).panel.getData().lifecycle;
    assert.strictEqual(z.awayPermille, null);
  });
};
