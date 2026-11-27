"use strict";

const assert = require("node:assert");

const { locateCharacter, decidePursuit, constraintsOf, arrivalGateIndex } = require("../../lib/playerHunt/pursuit");
const { decideHuntStep, PHASES } = require("../../lib/playerHunt/phases");
const PH = require("../../lib/playerHunt/schema");
const { SEC_CLASSES } = require("../../lib/graph/universeGraph");

const X = 30000201;
const Y = 30000205;
const P = Object.freeze({ pursuitEnabled: true, pursuitRequireContact: true, pursuitMaxHops: 3, pursuitMaxActive: 2,
  pursuitMaxJumps: 1, pursuitAvoidSecClasses: "highsec" });
const HP = Object.freeze({ objectDwellMs: 30000, warpTimeoutMs: 60000, reacquireGraceMs: 20000, exitGraceMs: 30000,
  maxDurationMs: 1200000, maxObjectsPerHunt: 3 });
const T0 = 1000000;

module.exports = ({ test }) => {
  test("PU1 decidePursuit refusals in the contract order and pursue on route.ok; locateCharacter "
    + "arrivalGateIndex, constraintsOf; phases PURSUIT before exitGraceMs, TARGET_DOWN first; SEC_CLASSES copy", () => {
    const base = { fromSystemId: X, located: { systemId: Y, state: "space" }, contact: true, hops: 0,
      activePursuits: 0, route: { ok: true, jumps: 1 } };
    const cases = [
      [{}, { pursuitEnabled: false }, "DISABLED"],
      [{}, { pursuitMaxActive: 0 }, "DISABLED"],
      [{ located: null }, {}, "NOT_LOCATED"],
      [{ located: { systemId: X, state: "space" } }, {}, "SAME_SYSTEM"],
      [{ located: { systemId: Y, state: "docked" } }, {}, "DOCKED"],
      [{ contact: false }, {}, "NO_CONTACT"],
      [{ hops: 3 }, {}, "HOPS_EXHAUSTED"],
      [{ activePursuits: 2 }, {}, "MAX_ACTIVE"],
      [{ route: null }, {}, "GRAPH_NOT_READY"],
      [{ route: { ok: false, reason: "UNREACHABLE" } }, {}, "UNREACHABLE"],
      [{ route: { ok: false, reason: "TOO_FAR" } }, {}, "TOO_FAR"],
      [{ route: { ok: true, jumps: 2 } }, {}, "TOO_FAR"],
      [{ located: { systemId: Y, state: "docked" }, contact: false }, {}, "DOCKED"],
    ];
    const got = cases.map(([i, p]) => decidePursuit({ ...base, ...i }, { ...P, ...p }).reason);
    assert.deepStrictEqual(got, cases.map((c) => c[2]));
    assert.deepStrictEqual(decidePursuit(base, P), { pursue: true, targetSystemId: Y, jumps: 1 });
    assert.deepStrictEqual(decidePursuit({ ...base, located: { systemId: Y, state: "transit" } }, P),
      { pursue: true, targetSystemId: Y, jumps: 1 }, "transit counts as space");
    assert.deepStrictEqual(decidePursuit({ ...base, contact: false }, { ...P, pursuitRequireContact: false }),
      { pursue: true, targetSystemId: Y, jumps: 1 }, "no contact needed when pursuitRequireContact is off");

    const presence = { observedSystems: () => [Y, X],
      getSystemPresence: (id) => ({ characters: id === X ? [{ characterId: 7, state: "docked" }]
        : [{ characterId: 7, state: "space" }, { characterId: 8, state: "space" }] }) };
    assert.deepStrictEqual(locateCharacter(presence, 7), { systemId: X, state: "docked" }, "ascending systemId");
    assert.deepStrictEqual(locateCharacter(presence, 8), { systemId: Y, state: "space" });
    assert.strictEqual(locateCharacter(presence, 9), null);
    assert.strictEqual(locateCharacter({ observedSystems: () => { throw new Error("x"); } }, 7), null);

    const objects = [{ kind: "planet", itemId: 1, toSystemId: X }, { kind: "stargate", itemId: 2, toSystemId: 99 },
      { kind: "stargate", itemId: 3, toSystemId: X }];
    assert.deepStrictEqual([arrivalGateIndex(objects, X), arrivalGateIndex(objects, 98)], [2, -1]);
    assert.deepStrictEqual(constraintsOf(P), { maxJumps: 1, avoidSecClasses: ["highsec"] });
    assert.deepStrictEqual(constraintsOf({ ...P, pursuitAvoidSecClasses: "none" }).avoidSecClasses, []);
    assert.deepStrictEqual([PH.parseSecClassList("highsec,highsec"), PH.parseSecClassList("moon")], [null, null]);

    const entry = { phase: PHASES.SWEEP_DWELL, phaseSince: T0, objects: [], objectIndex: 0, visited: 1, liveSince: T0,
      quarryAbsentSince: null, noTargetSince: null };
    const facts = (now, extra) => ({ now, sceneLoaded: true, quarry: { state: "absent", ship: null },
      ownAlive: [{ entityId: 11, inWarp: false }], hostilesOnGrid: [], ...extra });
    let d = decideHuntStep(entry, facts(T0 + 1, { pursuitTarget: Y }), HP);
    assert.deepStrictEqual([d.end, d.pursuitTarget, d.actions], [{ reason: "PURSUIT" }, Y,
      [{ type: "end", reason: "PURSUIT" }]]);
    d = decideHuntStep(entry, facts(T0 + 1, { pursuitTarget: null }), HP);
    assert.deepStrictEqual([d.end, d.quarryAbsentSince], [null, T0 + 1]);
    d = decideHuntStep({ ...entry, quarryAbsentSince: T0 + 1 }, facts(T0 + 1 + HP.exitGraceMs, { pursuitTarget: null }),
      HP);
    assert.deepStrictEqual(d.end, { reason: "TARGET_GONE" });
    d = decideHuntStep(entry, facts(T0 + 1, { quarry: { state: "space", ship: { capsule: true } }, pursuitTarget: Y }),
      HP);
    assert.deepStrictEqual(d.end, { reason: "TARGET_DOWN" });

    assert.deepStrictEqual([...PH.SEC_CLASSES], [...SEC_CLASSES]);
    assert.ok(PH.END_REASONS.includes("PURSUIT"));
  });
};
