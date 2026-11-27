"use strict";

const assert = require("node:assert");

const { planConstruction, planBaseConstruction, DEV_HARD_NOTES } = require("../../lib/strategy/ai/construction");
const { readDevLevels } = require("../../lib/strategy/reviewService");
const { helpers: T } = require("../strategy/construction.test");

const DEV = Object.freeze({ minLevelSum: 6, maxOpen: 1 });
const C0 = Object.freeze({ ...T.CONSTRUCTION, dev: DEV });
const withC = (c) => ({ ...T.PARAMS, construction: c });
const lv = (rows) => new Map(rows.map(([id, ind, trade]) => [id, { ind, trade }]));

function run(factionId, devLevels, o = {}, c = C0) {
  const s = T.snap(factionId, { ...o, sc: { ...(o.sc || {}), ...(devLevels ? { devLevels } : {}) } });
  if (o.edit) o.edit(s);
  return planConstruction(s, T.supplyOf(s), withC(c));
}

module.exports = ({ test }) => {
  test("DI17 DEV_STATION: conditions, limits, hard notes, order", () => {
    assert.deepStrictEqual(run(T.AMARR, lv([[2, 3, 3]])), {
      intents: [{ type: "BUILD_PLAN", slot: 0, systemId: 2, kitId: "k" }], notes: ["CONSTRUCTION_DEV_PLAN"] });
    assert.deepStrictEqual(run(T.SANSHA, lv([[2, 3, 3]]), { target: true }), {
      intents: [{ type: "BUILD_PLAN", slot: 0, systemId: 2, kitId: "k" }],
      notes: ["CONSTRUCTION_HAS_TARGETS", "CONSTRUCTION_DEV_PLAN"] });
    assert.deepStrictEqual(run(T.SANSHA, lv([[2, 3, 3]])).notes, ["CONSTRUCTION_PLAN"]);

    const edit = (s) => {
      s.systems = s.systems.map((x) => (x.systemId === 2 ? { ...x, occupationState: "CONTESTED" }
        : x.systemId === 8 ? { ...x, liveStations: 8 } : x));
    };
    assert.deepStrictEqual(run(T.AMARR, lv([[1, 5, 5], [2, 3, 3], [7, 2, 3], [8, 3, 3]]), { edit }),
      { intents: [], notes: [] });

    const roomy = { ...C0, maxOpenBuildsPerFaction: 3 };
    assert.deepStrictEqual(run(T.AMARR, lv([[2, 3, 3], [3, 3, 3]]), { open: [{ systemId: 2 }] }, roomy),
      { intents: [], notes: ["CONSTRUCTION_DEV_BUSY"] });
    assert.deepStrictEqual(run(T.AMARR, lv([[2, 3, 3], [3, 1, 1]]), { open: [{ systemId: 3 }] }, roomy).intents
      .map((i) => i.systemId), [2]);
    assert.deepStrictEqual(run(T.AMARR, lv([[2, 3, 3]]), { open: [{ systemId: 7 }] }).notes,
      ["CONSTRUCTION_DEV_BUSY"]);

    const sub1 = { ...C0, minGapMs: 6 * T.HOUR, maxOpenBuildsTotal: 8, maxLiveStationsTotal: 100 };
    assert.deepStrictEqual(run(T.SANSHA, lv([[2, 3, 3]]), { target: true,
      sc: { openTotal: 0, liveTotal: 0, sinceLastBuildMs: T.HOUR } }, sub1), { intents: [], notes: ["CONSTRUCTION_GAP"] });
    assert.deepStrictEqual(run(T.SANSHA, lv([[2, 3, 3]]), { sc: { openTotal: 8, liveTotal: 0, sinceLastBuildMs: null } },
      sub1), { intents: [], notes: ["CONSTRUCTION_GLOBAL_CAP"] });
    assert.deepStrictEqual(run(T.SANSHA, lv([[2, 3, 3]]), { minerals: { "type:34": 5000 } }),
      { intents: [], notes: ["CONSTRUCTION_NO_KIT"] });
    assert.deepStrictEqual(run(T.AMARR, lv([[2, 3, 3]]), { minerals: { "type:34": 5000 } }),
      { intents: [], notes: ["CONSTRUCTION_NO_KIT"] }, "the kit gate of the DEV branch itself");
    assert.deepStrictEqual(run(T.AMARR, lv([[2, 3, 3]]), { edit: (s) => { s.doctrine.buildsStations = false; } }),
      { intents: [], notes: [] });
    assert.ok(["CONSTRUCTION_GAP", "CONSTRUCTION_GLOBAL_CAP", "CONSTRUCTION_NO_KIT"].every((n) => DEV_HARD_NOTES.includes(n)));

    const three = { ...C0, maxBuildsPerReview: 3, maxOpenBuildsPerFaction: 3, dev: { minLevelSum: 6, maxOpen: 3 } };
    assert.deepStrictEqual(run(T.AMARR, lv([[3, 2, 4], [2, 2, 4], [7, 4, 2], [8, 4, 3]]), {}, three).intents
      .map((i) => [i.slot, i.systemId]), [[0, 8], [1, 7], [2, 2]]);
  });

  test("DI18 DEV_STATION flag off: planConstruction = planBaseConstruction bit for bit; no devLevels key", () => {
    const READY_TWO = { mode: "ready", sites: [{ systemId: 5, borderNeighbours: 1, liveStations: 0, ownLiveStations: 0 },
      { systemId: 4, borderNeighbours: 3, liveStations: 0, ownLiveStations: 0 }] };
    const OUT = { ...T.CONSTRUCTION, outpostsEnabled: true, outpostMaxOpen: 1, outpostMaxStations: 4 };
    const cases = [[T.SANSHA, {}, T.CONSTRUCTION], [T.AMARR, { sc: { outposts: READY_TWO } }, OUT],
      [T.SANSHA, { target: true }, T.CONSTRUCTION]];
    for (const [f, o, c] of cases) {
      const s = T.snap(f, o);
      const base = planBaseConstruction(s, T.supplyOf(s), withC(c));
      assert.deepStrictEqual(planConstruction(s, T.supplyOf(s), withC({ ...c, dev: null })), base);
      assert.deepStrictEqual(planConstruction(s, T.supplyOf(s), withC(c)), base);
      assert.deepStrictEqual(planConstruction(s, T.supplyOf(s), withC({ ...c, dev: DEV })), base);
    }

    const systems = [{ systemId: 1, controllerFactionId: 7 }, { systemId: 2, controllerFactionId: 7 },
      { systemId: 3, controllerFactionId: 9 }];
    const stations = [{ systemId: 1 }];
    const warm = () => ({ levelsOf: (id) => ({ mil: 1, ind: id, trade: 2 }) });
    assert.strictEqual(readDevLevels(T.CONSTRUCTION, warm, 7, { systems, stations }), null, "no dev");
    assert.strictEqual(readDevLevels(null, warm, 7, { systems, stations }), null);
    assert.strictEqual(readDevLevels(C0, undefined, 7, { systems, stations }), null, "no getter");
    assert.strictEqual(readDevLevels(C0, () => ({ levelsOf: () => null }), 7, { systems, stations }), null, "cold");
    assert.strictEqual(readDevLevels(C0, () => { throw new Error("x"); }, 7, { systems, stations }), null);
    assert.deepStrictEqual([...readDevLevels(C0, warm, 7, { systems, stations })], [[2, { ind: 2, trade: 2 }]],
      "own systems without an own ONLINE station only");
  });
};
