"use strict";

const assert = require("node:assert");

const { decideHuntStep, PHASES } = require("../../lib/playerHunt/phases");
const { scanRoll } = require("../../lib/playerHunt/policy");

const P = Object.freeze({ objectDwellMs: 30000, warpTimeoutMs: 60000, reacquireGraceMs: 20000, exitGraceMs: 30000,
  maxDurationMs: 1200000, maxObjectsPerHunt: 3 });
const T0 = 1000000;
const pos = (x) => ({ x, y: 0, z: 0 });
const OBJECTS = Object.freeze([{ kind: "stargate", itemId: 1, position: pos(0) },
  { kind: "station", itemId: 2, position: pos(1e7) }, { kind: "planet", itemId: 3, position: pos(2e7) }]);

function entry(extra = {}) {
  return { phase: PHASES.SWEEP_DWELL, phaseSince: T0, objects: OBJECTS, objectIndex: 0, visited: 1, liveSince: T0,
    quarryAbsentSince: null, noTargetSince: null, ...extra };
}

function facts(now, extra = {}) {
  return { now, sceneLoaded: true, quarry: { state: "space", ship: { capsule: false } },
    ownAlive: [{ entityId: 11, inWarp: false }, { entityId: 12, inWarp: false }], hostilesOnGrid: [], ...extra };
}

module.exports = ({ test }) => {
  test("HC5 decideHuntStep: SWEEP_DWELL / SWEEP_WARP / ENGAGED transitions, timeouts, NOT_FOUND, every "
    + "end of, search before warp", () => {
    let d = decideHuntStep(entry(), facts(T0 + P.objectDwellMs - 1), P);
    assert.deepStrictEqual([d.phase, d.actions, d.end], [PHASES.SWEEP_DWELL, [], null]);
    d = decideHuntStep(entry(), facts(T0 + P.objectDwellMs), P);
    assert.deepStrictEqual([d.phase, d.objectIndex, d.visited, d.phaseSince], [PHASES.SWEEP_WARP, 1, 2,
      T0 + P.objectDwellMs]);
    assert.deepStrictEqual(d.actions, [{ type: "warp", point: pos(1e7), objectIndex: 1 }]);
    const w = entry({ phase: PHASES.SWEEP_WARP, phaseSince: T0, objectIndex: 1, visited: 2 });
    d = decideHuntStep(w, facts(T0 + 5000, { ownAlive: [{ entityId: 11, inWarp: true }, { entityId: 12,
      inWarp: false }] }), P);
    assert.strictEqual(d.phase, PHASES.SWEEP_WARP);
    d = decideHuntStep(w, facts(T0 + 5000), P);
    assert.deepStrictEqual([d.phase, d.phaseSince], [PHASES.SWEEP_DWELL, T0 + 5000]);
    d = decideHuntStep(w, facts(T0 + P.warpTimeoutMs, { ownAlive: [{ entityId: 11, inWarp: true }] }), P);
    assert.strictEqual(d.phase, PHASES.SWEEP_DWELL);
    for (const e of [entry(), w]) {
      d = decideHuntStep(e, facts(T0 + 1000, { hostilesOnGrid: [901, 902] }), P);
      assert.deepStrictEqual([d.phase, d.actions], [PHASES.ENGAGED, [{ type: "attack", targets: [901, 902] }]]);
    }
    const g = entry({ phase: PHASES.ENGAGED, phaseSince: T0, objectIndex: 2, visited: 2 });
    d = decideHuntStep(g, facts(T0 + 1000, { hostilesOnGrid: [901] }), P);
    assert.deepStrictEqual([d.phase, d.actions, d.noTargetSince], [PHASES.ENGAGED, [], null]);
    d = decideHuntStep(g, facts(T0 + 1000), P);
    assert.deepStrictEqual([d.phase, d.noTargetSince, d.actions], [PHASES.ENGAGED, T0 + 1000, []]);
    d = decideHuntStep({ ...g, noTargetSince: T0 + 1000 }, facts(T0 + 1000 + P.reacquireGraceMs), P);
    assert.deepStrictEqual(d.actions.map((a) => a.type), ["search", "warp"], "search before warp");
    assert.deepStrictEqual([d.phase, d.objectIndex, d.visited], [PHASES.SWEEP_WARP, 0, 3], "wraps to object 0");
    d = decideHuntStep(entry({ visited: 3 }), facts(T0 + P.objectDwellMs), P);
    assert.deepStrictEqual(d.end, { reason: "NOT_FOUND" });
    d = decideHuntStep({ ...g, visited: 3, noTargetSince: T0 }, facts(T0 + P.reacquireGraceMs), P);
    assert.deepStrictEqual(d.end, { reason: "NOT_FOUND" });
    assert.deepStrictEqual(d.actions, [{ type: "end", reason: "NOT_FOUND" }]);

    for (const e of [entry(), w, g]) {
      assert.strictEqual(decideHuntStep(e, facts(T0 + 1, { sceneLoaded: false, ownAlive: [] }), P).end.reason,
        "SCENE_GONE");
      assert.strictEqual(decideHuntStep({ ...e, spawnConfirmed: true }, facts(T0 + 1, { ownAlive: [] }), P).end.reason,
        "WIPED");
      assert.strictEqual(decideHuntStep(e, facts(T0 + P.maxDurationMs, { hostilesOnGrid: [901] }), P).end.reason,
        "TIMEOUT");
      assert.strictEqual(decideHuntStep(e, facts(T0 + 1, { quarry: { state: "space", ship: { capsule: true } } }), P)
        .end.reason, "TARGET_DOWN");
      const absent = { quarry: { state: "absent", ship: null } };
      const first = decideHuntStep(e, facts(T0 + 1, absent), P);
      assert.deepStrictEqual([first.end, first.quarryAbsentSince], [null, T0 + 1], "grace starts");
      const back = decideHuntStep({ ...e, quarryAbsentSince: T0 + 1 }, facts(T0 + 2), P);
      assert.strictEqual(back.quarryAbsentSince, null, "quarry back in space: grace reset");
      assert.strictEqual(decideHuntStep({ ...e, quarryAbsentSince: T0 + 1 }, facts(T0 + P.exitGraceMs, absent), P).end,
        null);
      assert.strictEqual(decideHuntStep({ ...e, quarryAbsentSince: T0 + 1 }, facts(T0 + 1 + P.exitGraceMs, absent), P)
        .end.reason, "TARGET_GONE");
    }
  });

  test("PH6 no ship ever seen -> SPAWN_NOT_VISIBLE; spawnConfirmed -> WIPED; SCENE_GONE before both", () => {
    const empty = facts(T0 + 1, { ownAlive: [] });
    for (const e of [entry(), entry({ spawnConfirmed: false })]) {
      const d = decideHuntStep(e, empty, P);
      assert.deepStrictEqual([d.end, d.actions], [{ reason: "SPAWN_NOT_VISIBLE" },
        [{ type: "end", reason: "SPAWN_NOT_VISIBLE" }]]);
    }
    assert.strictEqual(decideHuntStep(entry({ spawnConfirmed: true }), empty, P).end.reason, "WIPED");
    for (const e of [entry(), entry({ spawnConfirmed: true })]) {
      assert.strictEqual(decideHuntStep(e, { ...empty, sceneLoaded: false }, P).end.reason, "SCENE_GONE");
    }
    assert.ok(require("../../lib/playerHunt/schema").END_REASONS.includes("SPAWN_NOT_VISIBLE"));
  });

  const PG = Object.freeze({ ...P, maxScanCycles: 30, warpStartGraceMs: 6000 });
  const inWarp = { ownAlive: [{ entityId: 11, inWarp: true }, { entityId: 12, inWarp: false }] };
  const carry = (e, d) => ({ ...e, phase: d.phase, phaseSince: d.phaseSince, warpSeen: d.warpSeen,
    scanCycle: d.scanCycle });

  for (const [id, phase, landedPhase, extra] of [
    ["HW1", PHASES.WARP_TO_TARGET, PHASES.SCAN, { mode: "SCAN", scanCycle: 1, seed: 7 }],
    ["HW2", PHASES.SWEEP_WARP, PHASES.SWEEP_DWELL, { objectIndex: 1, visited: 2 }],
  ]) {
    test(`${id} ${phase}: stays until a ship was seen in warp and left it (landed, phaseSince = landing), `
      + "ends by grace without a warp, no scan roll before the landing", () => {
      let e = entry({ phase, phaseSince: T0, warpSeen: false, ...extra });
      let d = decideHuntStep(e, facts(T0 + 2000), PG);
      assert.deepStrictEqual([d.phase, d.warpSeen, d.warpEnd, d.scan, d.actions], [phase, false, null, null, []],
        "pass 1: warp not started yet");
      e = carry(e, d);
      d = decideHuntStep(e, facts(T0 + 4000, inWarp), PG);
      assert.deepStrictEqual([d.phase, d.warpSeen, d.warpEnd, d.scan], [phase, true, null, null], "pass 2: in warp");
      e = carry(e, d);
      d = decideHuntStep(e, facts(T0 + 9000), PG);
      assert.deepStrictEqual([d.phase, d.phaseSince, d.warpEnd, d.scan, d.end], [landedPhase, T0 + 9000, "landed",
        null, null], "pass 3: landed");
      if (phase === PHASES.WARP_TO_TARGET) assert.strictEqual(d.scanCycle, 1, "the cycle does not move on landing");
      const fresh = entry({ phase, phaseSince: T0, warpSeen: false, ...extra });
      d = decideHuntStep(fresh, facts(T0 + PG.warpStartGraceMs - 1), PG);
      assert.deepStrictEqual([d.phase, d.warpEnd], [phase, null]);
      d = decideHuntStep(fresh, facts(T0 + PG.warpStartGraceMs), PG);
      assert.deepStrictEqual([d.phase, d.phaseSince, d.warpEnd], [landedPhase, T0 + PG.warpStartGraceMs, "grace"]);
    });
  }

  test("HW3 without warpStartGraceMs (absent or 0) the warp decisions equal the ones before "
    + "warpTimeoutMs with a ship still in warp -> timeout", () => {
    const old = (d) => ({ phase: d.phase, phaseSince: d.phaseSince, objectIndex: d.objectIndex, visited: d.visited,
      quarryAbsentSince: d.quarryAbsentSince, noTargetSince: d.noTargetSince, scanCycle: d.scanCycle, scan: d.scan,
      actions: d.actions, end: d.end });
    const sw = entry({ phase: PHASES.SWEEP_WARP, phaseSince: T0, objectIndex: 1, visited: 2 });
    const wt = entry({ phase: PHASES.WARP_TO_TARGET, phaseSince: T0, mode: "SCAN", scanCycle: 2, seed: 7 });
    const base = { objectIndex: 1, visited: 2, quarryAbsentSince: null, noTargetSince: null, scan: null, actions: [],
      end: null };
    const cases = [
      [sw, T0 + 5000, inWarp, { ...base, phase: PHASES.SWEEP_WARP, phaseSince: T0, scanCycle: 0 }],
      [sw, T0 + 5000, {}, { ...base, phase: PHASES.SWEEP_DWELL, phaseSince: T0 + 5000, scanCycle: 0 }],
      [sw, T0 + P.warpTimeoutMs, inWarp, { ...base, phase: PHASES.SWEEP_DWELL, phaseSince: T0 + P.warpTimeoutMs,
        scanCycle: 0 }],
      [wt, T0 + 5000, inWarp, { ...base, objectIndex: 0, visited: 1, phase: PHASES.WARP_TO_TARGET, phaseSince: T0,
        scanCycle: 2 }],
      [wt, T0 + 5000, {}, { ...base, objectIndex: 0, visited: 1, phase: PHASES.SCAN, phaseSince: T0 + 5000,
        scanCycle: 2 }],
      [wt, T0 + P.warpTimeoutMs, inWarp, { ...base, objectIndex: 0, visited: 1, phase: PHASES.SCAN,
        phaseSince: T0 + P.warpTimeoutMs, scanCycle: 2 }],
    ];
    const got = [];
    const want = [];
    for (const params of [{ ...P, maxScanCycles: 30 }, { ...P, maxScanCycles: 30, warpStartGraceMs: 0 }]) {
      for (const [e, now, f, expected] of cases) {
        got.push(old(decideHuntStep(e, facts(now, f), params)));
        want.push(expected);
      }
    }
    assert.deepStrictEqual(got, want);
    for (const e of [sw, wt]) {
      const d = decideHuntStep({ ...e, warpSeen: true }, facts(T0 + PG.warpTimeoutMs, inWarp), PG);
      assert.strictEqual(d.warpEnd, "timeout");
    }
  });

  test("PHA3 SCAN with facts.warmScan and a visible quarry -> hit without a "
    + "roll (chancePermille 1000) -> WARP_TO_TARGET; without warmScan -> the scanRoll as before; a cloaked quarry "
    + "is never a warm hit", () => {
    const PS = { ...P, maxDurationMs: Number.MAX_SAFE_INTEGER, scanCycleMs: 8000, maxScanCycles: 30,
      warpInDistanceMeters: 15000, scanBasePermille: 250, scanRefSignatureM: 100, scanMinPermille: 50,
      scanMaxPermille: 900 };
    const rollOpts = { basePermille: 250, minPermille: 50, maxPermille: 900, refSignatureM: 100 };
    let seed = 1;
    while (scanRoll(seed, 0, 100, rollOpts).found) seed += 1;
    const e = entry({ phase: PHASES.SCAN, phaseSince: T0, mode: "SCAN", scanCycle: 0, seed });
    const ship = { entityId: 9, capsule: false, position: pos(5e9), signatureRadius: 100, inWarp: false,
      cloaked: false };
    const f = (extra) => facts(T0 + PS.scanCycleMs, { quarry: { state: "space", ship: { ...ship, ...extra.ship } },
      ownAlive: [{ entityId: 11, inWarp: false, position: pos(0) }], ...extra.facts });
    let d = decideHuntStep(e, f({ facts: { warmScan: true } }), PS);
    assert.deepStrictEqual([d.phase, d.scan], [PHASES.WARP_TO_TARGET,
      { cycle: 0, rolled: true, found: true, chancePermille: 1000 }]);
    assert.strictEqual(d.actions[0].targetId, 9);
    const cold = scanRoll(seed, 0, 100, rollOpts);
    d = decideHuntStep(e, f({}), PS);
    assert.deepStrictEqual([d.phase, d.scan], [PHASES.SCAN,
      { cycle: 0, rolled: true, found: false, chancePermille: cold.chancePermille }]);
    d = decideHuntStep(e, f({ facts: { warmScan: true }, ship: { cloaked: true } }), PS);
    assert.deepStrictEqual([d.phase, d.scan.found, d.scan.rolled], [PHASES.SCAN, false, false]);
  });

  test("HC-R1 sweep re-target: the quarry moved to an object -> it is the next warp "
    + "(a visit); quarry in warp / capsule / lead on its grid / flag off -> the old order", () => {
    const PR = { ...P, maxObjectsPerHunt: 10, gridRadiusMeters: 250000, sweepRetargetEnabled: true };
    const lead = [{ entityId: 11, inWarp: false, position: pos(0) }];
    const at = (x, ship = {}) => facts(T0 + P.objectDwellMs, { ownAlive: lead,
      quarry: { state: "space", ship: { capsule: false, position: pos(x), inWarp: false, ...ship } } });
    let d = decideHuntStep(entry(), at(2e7 + 1000), PR);
    assert.deepStrictEqual([d.phase, d.objectIndex, d.visited], [PHASES.SWEEP_WARP, 2, 2]);
    assert.deepStrictEqual(d.actions, [{ type: "warp", point: pos(2e7), retarget: true, objectIndex: 2 }]);
    const extra = [{ kind: "anomaly", itemId: 9, position: pos(9e9) }];
    d = decideHuntStep(entry({ retargetExtra: extra }), at(9e9 + 10), PR);
    assert.deepStrictEqual([d.objectIndex, d.visited, d.actions], [0, 2, [{ type: "warp", point: pos(9e9),
      retarget: true }]]);
    assert.strictEqual(decideHuntStep(entry({ visited: 10 }), at(2e7), PR).end.reason, "NOT_FOUND");
    const plain = [{ type: "warp", point: pos(1e7), objectIndex: 1 }];
    assert.deepStrictEqual(decideHuntStep(entry(), at(2e7, { inWarp: true }), PR).actions, plain);
    assert.deepStrictEqual(decideHuntStep(entry(), at(2e7, { cloaked: true }), PR).actions, plain);
    assert.strictEqual(decideHuntStep(entry(), at(2e7, { capsule: true }), PR).end.reason, "TARGET_DOWN");
    assert.deepStrictEqual(decideHuntStep(entry(), at(2e7), { ...PR, sweepRetargetEnabled: false }).actions, plain);
  });
};
