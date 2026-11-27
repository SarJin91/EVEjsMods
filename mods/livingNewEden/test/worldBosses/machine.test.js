"use strict";

const assert = require("node:assert");

const M = require("../../lib/worldBosses/machine");
const F = require("./fixture");

const HOUR = 3600000;
const PHASE = Object.freeze({ units: [{ key: "bs", count: 2, hp: 1000 }, { key: "dread", count: 1, hp: 5000 }] });

module.exports = ({ test }) => {
  test("WB1 unitsAt: linear regen to max, hp 0 stays 0, now = hp_at -> changed false; phaseUnits order", () => {
    assert.deepStrictEqual(M.phaseUnits(PHASE), { bs1: 1000, bs2: 1000, dread1: 5000 });
    const row = { units_json: JSON.stringify({ bs1: 500, bs2: 0, dread1: 5000 }), hp_at: 0 };
    const cfg = { regenPermillePerHour: 100 };
    assert.deepStrictEqual(M.unitsAt(row, HOUR, PHASE, cfg),
      { units: { bs1: 600, bs2: 0, dread1: 5000 }, changed: true });
    assert.deepStrictEqual(M.unitsAt(row, 100 * HOUR, PHASE, cfg),
      { units: { bs1: 1000, bs2: 0, dread1: 5000 }, changed: true });
    assert.deepStrictEqual(M.unitsAt(row, 0, PHASE, cfg), { units: { bs1: 500, bs2: 0, dread1: 5000 },
      changed: false });
    assert.strictEqual(M.unitsAt(row, 1000, PHASE, cfg).changed, false);
  });

  test("WB2 chooseNextHop / pickSpawnSystem: deterministic, visited avoided, excluded region / no gates never, "
    + "NO_NEIGHBOR; spawn in [min..max] jumps", () => {
    const g = F.makeGraph();
    const P = F.settingsFor();
    assert.deepStrictEqual([P.excludedRegionIds, P.secClasses, P.spawnMinJumps, P.spawnMaxJumps],
      [[200], ["nullsec"], 2, 4]);
    for (let seed = 0; seed < 20; seed += 1) {
      assert.deepStrictEqual(M.chooseNextHop({ systemId: 6, visited: [5], goalSystemId: 1, seed, hops: 0 }, g, P),
        { systemId: 7 });
    }
    const bias = { ...P, goalBiasPermille: 1000 };
    assert.deepStrictEqual(M.chooseNextHop({ systemId: 6, visited: [5, 7], goalSystemId: 1, seed: 3, hops: 2 }, g,
      bias), { systemId: 5 });
    const random = { ...P, goalBiasPermille: 0 };
    const seen = new Set();
    for (let seed = 0; seed < 40; seed += 1) {
      const a = M.chooseNextHop({ systemId: 6, visited: [], goalSystemId: 1, seed, hops: 1 }, g, random);
      const b = M.chooseNextHop({ systemId: 6, visited: [], goalSystemId: 1, seed, hops: 1 }, g, random);
      assert.deepStrictEqual(a, b, "same seed = same hop");
      assert.ok([5, 7].includes(a.systemId), JSON.stringify(a));
      seen.add(a.systemId);
    }
    assert.deepStrictEqual([...seen].sort(), [5, 7], "both neighbours over 40 seeds");
    assert.deepStrictEqual(M.chooseNextHop({ systemId: 14, visited: [], goalSystemId: 1, seed: 1, hops: 0 }, g, P),
      { systemId: null, reason: "NO_NEIGHBOR" });
    assert.deepStrictEqual(M.chooseNextHop({ systemId: 16, visited: [], goalSystemId: 1, seed: 1, hops: 0 }, g, P),
      { systemId: null, reason: "NO_NEIGHBOR" });

    const dist = M.bfsFromMany(g, [1], 10, 100);
    const picked = new Set();
    for (let seed = 0; seed < 30; seed += 1) {
      const r = M.pickSpawnSystem({ observed: [1], seed }, g, P);
      assert.deepStrictEqual(r, M.pickSpawnSystem({ observed: [1], seed }, g, P));
      assert.ok(dist.get(r.systemId) >= 2 && dist.get(r.systemId) <= 4, JSON.stringify(r));
      picked.add(r.systemId);
    }
    assert.deepStrictEqual([...picked].sort((a, b) => a - b), [3, 4, 5]);
    for (let seed = 0; seed < 30; seed += 1) {
      const r = M.pickSpawnSystem({ observed: [], seed }, g, P);
      assert.ok(![13, 14, 15].includes(r.systemId), JSON.stringify(r));
    }
    assert.deepStrictEqual(M.pickSpawnSystem({ observed: [1], seed: 1 }, g, { ...P, spawnMinJumps: 30,
      spawnMaxJumps: 40 }), { systemId: null, reason: "NO_SYSTEM" });
  });
};
