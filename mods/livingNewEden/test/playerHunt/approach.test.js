"use strict";

const assert = require("node:assert");

const { approachSystems, orderApproachCandidates } = require("../../lib/playerHunt/approach");
const { approachChainIdOf, approachKey, MAX_HUNT_ID_LENGTH } = require("../../lib/playerHunt/schema");

const EDGES = [[1, 2], [1, 3], [2, 4], [3, 5], [4, 6], [1, 7], [7, 8], [10, 1]];
const SEC = new Map([[7, "highsec"], [10, "highsec"]]);

function fakeGraph() {
  const n = new Map([[1, []], [2, []], [3, []], [4, []], [5, []], [6, []], [7, []], [8, []], [10, []]]);
  for (const [a, b] of EDGES) {
    n.get(a).push(b);
    n.get(b).push(a);
  }
  n.get(1).reverse();
  return { getNeighbors: (id) => (n.has(id) ? n.get(id) : null),
    getSystem: (id) => (n.has(id) ? { systemId: id, secClass: SEC.get(id) || "nullsec" } : null) };
}

const OPTS = Object.freeze({ maxJumps: 2, maxSystems: 32, avoidSecClasses: ["highsec"] });

module.exports = ({ test }) => {
  test("AP1 approachSystems: order (jumps, id), maxJumps / maxSystems cut, highsec neither returned nor "
    + "expanded, start in highsec TARGET_AVOIDED, unknown system UNKNOWN_SYSTEM; orderApproachCandidates", () => {
    const g = fakeGraph();
    assert.deepStrictEqual(approachSystems(g, 1, OPTS), { ok: true, systems: [{ systemId: 2, jumps: 1 },
      { systemId: 3, jumps: 1 }, { systemId: 4, jumps: 2 }, { systemId: 5, jumps: 2 }] },
    "7 (highsec) and 10 (highsec) skipped, 8 behind 7 never reached, 6 at 3 jumps");
    assert.deepStrictEqual(approachSystems(g, 1, { ...OPTS, maxJumps: 1 }).systems.map((s) => s.systemId), [2, 3]);
    assert.deepStrictEqual(approachSystems(g, 1, { ...OPTS, maxSystems: 3 }).systems.map((s) => s.systemId),
      [2, 3, 4]);
    assert.deepStrictEqual(approachSystems(g, 1, { ...OPTS, maxJumps: 3, avoidSecClasses: [] }).systems
      .map((s) => [s.systemId, s.jumps]), [[2, 1], [3, 1], [7, 1], [10, 1], [4, 2], [5, 2], [8, 2], [6, 3]]);
    assert.deepStrictEqual(approachSystems(g, 7, OPTS), { ok: false, reason: "TARGET_AVOIDED" });
    assert.deepStrictEqual(approachSystems(g, 99, OPTS), { ok: false, reason: "UNKNOWN_SYSTEM" });
    assert.deepStrictEqual(approachSystems(g, 1, { ...OPTS, maxJumps: 0 }), { ok: false, reason: "INVALID_ARGUMENT" });

    const bySystem = new Map([[5, [{ fleetId: "a" }]], [2, [{ fleetId: "z" }, { fleetId: "b" }]], [9, [{ fleetId: "c" }]]]);
    const jumpsOf = new Map([[2, 1], [5, 2]]);
    assert.deepStrictEqual(orderApproachCandidates(bySystem, jumpsOf).map((f) => f.fleetId), ["b", "z", "a"]);

    const longest = approachKey(approachChainIdOf("f".repeat(64), 2 ** 31));
    assert.ok(approachChainIdOf("f".repeat(64), 2 ** 31).length <= MAX_HUNT_ID_LENGTH);
    assert.ok(longest.startsWith("phunt:apr:") && longest.endsWith(":approach"));
  });
};
