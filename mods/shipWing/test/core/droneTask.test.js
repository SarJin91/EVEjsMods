"use strict";

const assert = require("node:assert");
const { createDroneSidecar, DRONE_COUNTER_NAMES, SCOOP_DISTANCE_M, planLaunch } = require("../../lib/core/droneTask");
const { createWingTasks } = require("../../lib/core/wingTasks");
const { ranges, DRONE_ACCESS_COUNTER_NAMES } = require("../../lib/adapter/droneAccess");
const { fixtures } = require("./wingService.test");

const OWNER = 90000001;
const HOST = 1000000400;
const RAT = 9000001;
const DURATION = 2000;

function bay() {
  return [
    { itemId: 701, typeId: 2488, quantity: 1, bandwidth: 10, kind: "combat" },
    { itemId: 702, typeId: 2488, quantity: 2, bandwidth: 10, kind: "combat" },
    { itemId: 703, typeId: 10246, quantity: 5, bandwidth: 5, kind: "other" },
  ];
}

function fakeWorld(config = {}, calls = []) {
  const w = { calls, sim: 10000, nextDrone: 8000, maxActive: 5, bandwidth: 25, refuse: false, checks: 0,
    droneTargetM: 1000, droneTwinM: 5000, bays: {}, bayReads: 0 };
  w.config = { droneDefaultMode: "auto", droneMaxPerCopy: 5, droneMaxPerPilot: 0, droneIdleRecallMs: 60000,
    droneLaunchesPerTick: 5, droneMaxCyclesPerTick: 16, ...config };
  w.access = {
    makeProxy: (o) => ({ ...o, proxy: true }),
    bayDrones: (_owner, ship) => {
      w.bayReads += 1;
      return { ok: true, drones: w.bays[ship] || bay() };
    },
    limits: () => ({ ok: true, maxActive: w.maxActive, bandwidth: w.bandwidth }),
    launch(scene, twin, o) {
      w.calls.push(["launch", twin.itemID, o.itemId]);
      w.nextDrone += 1;
      scene.entities.set(w.nextDrone, { itemID: w.nextDrone, kind: "drone", controllerID: twin.itemID,
        droneHomeOrbitDistance: 600 });
      return { ok: true, droneId: w.nextDrone };
    },
    recall(scene, ship, list) {
      w.calls.push(["recall", ship, list.map((e) => e.itemID)]);
      for (const e of list) scene.entities.delete(e.itemID);
      return { ok: true, ids: list.map((e) => e.itemID) };
    },
    combatSnapshot: () => ({ ok: true, snapshot: { durationMs: DURATION, orbitDistanceMeters: 1000,
      attackRangeMeters: 5000 } }),
    ranges,
    orbit(_scene, drone, targetId, rangeM, o) {
      w.calls.push(["orbit", drone.itemID, targetId, rangeM, o.fast]);
      return true;
    },
    fireCombat(_scene, drone, target, _snap, simMs) {
      w.calls.push(["fire", drone.itemID, target.itemID, simMs]);
      return { ok: true, hit: true, applied: 1, destroyed: false };
    },
    stats: () => ({ counters: {} }),
    repairSnapshot: () => ({ ok: true, snapshot: { repairFamily: "remoteArmor", durationMs: DURATION,
      orbitDistanceMeters: 1000, attackRangeMeters: 6000 } }),
    fireRepair(_scene, drone, target, _snap, simMs) {
      w.calls.push(["repair", drone.itemID, target.itemID, simMs]);
      return { ok: true, appliedAmount: 10 };
    },
    canInteract: () => true,
  };
  w.own = [];
  w.ts = {
    simNow: () => w.sim,
    entity: (scene, id) => (scene && scene.entities.get(Number(id))) || null,
    surfaceDistance: (_s, a, b) => (a.kind === "drone" && b.itemID === RAT ? w.droneTargetM : w.droneTwinM),
  };
  w.refuseFrom = 0;
  w.combat = { checkTarget: () => {
    w.checks += 1;
    const refused = w.refuse || (w.refuseFrom > 0 && w.checks >= w.refuseFrom);
    return refused ? { ok: false, reason: "NO_TARGET" } : { ok: true };
  } };
  w.sidecar = createDroneSidecar({ access: w.access, scene: w.ts, combat: w.combat, config: w.config,
    wingTwins: () => w.own.map((id) => ({ twinEntityId: id })) });
  w.tasks = createWingTasks({ sidecars: [w.sidecar], config: w.config });
  w.host = { itemID: HOST };
  w.scene = { entities: new Map([[HOST, w.host], [RAT, { itemID: RAT }]]) };
  return w;
}

function deploy(w, id) {
  const twin = { itemID: 4.2e15 + id, systemID: 30000142 };
  w.scene.entities.set(twin.itemID, twin);
  const rec = { shipItemId: id, ownerCharacterId: OWNER, hostShipId: HOST, twinEntityId: twin.itemID,
    state: "ACTIVE", launchedAtMs: 1000 + id };
  w.tasks.start(rec);
  const rt = w.tasks.context(id);
  rt.task = "ATTACK";
  rt.combat = { targetId: RAT };
  return { twin, rec, rt };
}

function step(w, d, nowMs) {
  return w.tasks.step(d.rec, null, { twin: d.twin, host: w.host, nowMs, scene: w.scene });
}

const of = (calls, kind) => calls.filter((c) => c[0] === kind);

module.exports = ({ test }) => {
  test("DT1 ATTACK with a target: launch up to min(droneMaxPerCopy, maxActive, bandwidth, pilot cap) of combat drones "
    + "only (bay order); one orbit order per drone; a cycle every durationMs of scene time; the target rule before "
    + "every cycle; droneMaxPerPilot 0 = no pilot cap; drones never steer the twin", () => {
    const w = fakeWorld({ droneMaxPerPilot: 3 });
    const a = deploy(w, 501);
    assert.deepStrictEqual(step(w, a, 1000), { controlsMovement: false });
    assert.deepStrictEqual(of(w.calls, "launch"), [["launch", a.twin.itemID, 701], ["launch", a.twin.itemID, 702]]);
    assert.deepStrictEqual(of(w.calls, "orbit").map((c) => [c[2], c[3]]), [[RAT, 1000], [RAT, 1000]]);
    assert.deepStrictEqual(of(w.calls, "fire").map((c) => c[3]), [10000, 10000]);
    const b = deploy(w, 502);
    step(w, b, 1000);
    assert.strictEqual(of(w.calls, "launch").filter((c) => c[1] === b.twin.itemID).length, 1);
    w.calls.length = 0;
    w.sim = 11000;
    step(w, a, 2000);
    assert.deepStrictEqual(of(w.calls, "fire"), []);
    w.sim = 12000;
    step(w, a, 3000);
    assert.deepStrictEqual(of(w.calls, "fire").map((c) => c[3]), [12000, 12000]);
    assert.deepStrictEqual(of(w.calls, "orbit"), []);
    w.calls.length = 0;
    w.sim = 14000;
    w.refuseFrom = w.checks + 2;
    step(w, a, 4000);
    assert.deepStrictEqual([of(w.calls, "fire"), of(w.calls, "orbit")], [[], []]);
    w.calls.length = 0;
    w.refuse = true;
    step(w, a, 4500);
    assert.deepStrictEqual(of(w.calls, "fire"), []);
    assert.deepStrictEqual(of(w.calls, "orbit").map((c) => [c[2], c[3], c[4]]),
      [[a.twin.itemID, 600, false], [a.twin.itemID, 600, false]]);
    assert.deepStrictEqual(w.sidecar.view(a.rt), { drones: { mode: "auto", out: 2, max: 2, phase: "OUT" } }, "sidecar drone view");
    const free = fakeWorld();
    deploy(free, 501);
    const c = deploy(free, 502);
    step(free, deploy(free, 503), 1000);
    step(free, c, 1000);
    assert.strictEqual(of(free.calls, "launch").filter((x) => x[1] === c.twin.itemID).length, 2);
    const names = [...DRONE_COUNTER_NAMES, ...DRONE_ACCESS_COUNTER_NAMES];
    assert.strictEqual(new Set(names).size, names.length, "one telemetry map: no name twice");
  });

  test("DT2 no target for droneIdleRecallMs -> RETURNING (orbit of the twin at 0, fast) -> recall only of the "
    + "drones within the scoop distance; mode off = the same at once, no launch while off", () => {
    const w = fakeWorld({ droneIdleRecallMs: 30000 });
    const a = deploy(w, 501);
    step(w, a, 1000);
    const out = [...a.rt.drones.out.keys()];
    assert.strictEqual(out.length, 2);
    a.rt.combat.targetId = null;
    w.calls.length = 0;
    step(w, a, 2000);
    step(w, a, 31999);
    assert.strictEqual(a.rt.drones.phase, "OUT");
    step(w, a, 32000);
    assert.strictEqual(a.rt.drones.phase, "RETURNING");
    assert.deepStrictEqual(of(w.calls, "orbit").slice(-2).map((c) => [c[2], c[3], c[4]]),
      [[a.twin.itemID, 0, true], [a.twin.itemID, 0, true]]);
    step(w, a, 33000);
    assert.deepStrictEqual(of(w.calls, "recall"), []);
    w.droneTwinM = SCOOP_DISTANCE_M;
    step(w, a, 34000);
    assert.deepStrictEqual(of(w.calls, "recall"), [["recall", 501, out]]);
    assert.strictEqual(a.rt.drones.phase, "NONE");
    w.bays[501] = out.map((id) => ({ itemId: id, typeId: 2488, quantity: 1, bandwidth: 10, kind: "combat" }));
    a.rt.combat.targetId = RAT;
    w.calls.length = 0;
    const reads = w.bayReads;
    step(w, a, 35000);
    assert.deepStrictEqual(of(w.calls, "launch"), out.map((id) => ["launch", a.twin.itemID, id]));
    assert.strictEqual(a.rt.drones.phase, "OUT");
    step(w, a, 36000);
    assert.strictEqual(w.bayReads, reads + 1, "one bay read per recall");
    const o = deploy(w, 502);
    w.droneTwinM = 5000;
    step(w, o, 40000);
    assert.deepStrictEqual(w.sidecar.setMode(o.rt, "bogus"), { ok: false, reason: "MODE_INVALID" });
    assert.deepStrictEqual(w.sidecar.setMode(o.rt, "off"), { ok: true, mode: "off" });
    w.droneTwinM = 1000;
    w.calls.length = 0;
    step(w, o, 41000);
    assert.strictEqual(of(w.calls, "recall").length, 1);
    step(w, o, 42000);
    assert.deepStrictEqual(of(w.calls, "launch"), [], "off: no launch");
    assert.strictEqual(w.sidecar.stats().counters["drone.mode.off"], 1);
  });

  test("DT3 every end through the core: the drones go back at once (instant recall) BEFORE the twin is removed; "
    + "setDroneMode refusals; dispose(LOST) takes nothing; a drone of another controller -> BLOCKED, no new "
    + "launch in that runtime", () => {
    const shared = [];
    const w = fakeWorld({}, shared);
    const t = fixtures.setup({ taskSidecars: [w.sidecar], config: { dronesEnabled: true } });
    try {
      const orig = t.adapter.remove;
      t.adapter.remove = (scene, id, nowMs) => {
        shared.push(["remove", id]);
        return orig(scene, id, nowMs);
      };
      assert.strictEqual(t.svc.orderCopy(fixtures.CHAR, 501, "launch").ok, true);
      const twin = t.w.scene.entities.get(fixtures.twinOf(t, 501));
      t.w.scene.entities.set(RAT, { itemID: RAT });
      const rt = t.svc.twinTaskContext(twin);
      rt.task = "ATTACK";
      rt.combat = { targetId: RAT };
      t.clock.t += 500;
      t.svc.tick(t.clock.t);
      assert.strictEqual(of(shared, "launch").length, 2);
      assert.deepStrictEqual(t.svc.setDroneMode(fixtures.OTHER, 501, "off"), { ok: false, reason: "NOT_OWNER" });
      assert.deepStrictEqual(t.svc.setDroneMode(fixtures.CHAR, 502, "off"), { ok: false, reason: "NOT_DEPLOYED" });
      assert.deepStrictEqual(t.svc.setDroneMode(fixtures.CHAR, 501, "x"), { ok: false, reason: "MODE_INVALID" });
      assert.deepStrictEqual(t.svc.setDroneMode(fixtures.CHAR, 501, "auto"),
        { ok: true, state: "ACTIVE", mode: "auto" });
      const row = t.svc.listWing(fixtures.CHAR).ships.find((s) => s.shipItemId === 501);
      assert.deepStrictEqual(row.drones, { mode: "auto", out: 2, max: 2, phase: "OUT" }, "listWing drone row");
      assert.strictEqual(t.svc.orderCopy(fixtures.CHAR, 501, "return").ok, true);
      t.clock.t += 500;
      assert.strictEqual(t.svc.tick(t.clock.t).ended, 1);
      const kinds = shared.map((c) => c[0]).filter((k) => k === "recall" || k === "remove");
      assert.deepStrictEqual(kinds, ["recall", "remove"], "the drones go back before the twin is removed");
      assert.strictEqual(w.sidecar.stats().counters["drone.recall.instant"], 1);
    } finally {
      fixtures.cleanup(t.dir);
    }
    const off = fixtures.setup();
    try {
      assert.strictEqual(off.svc.orderCopy(fixtures.CHAR, 501, "launch").ok, true);
      assert.deepStrictEqual(off.svc.setDroneMode(fixtures.CHAR, 501, "off"),
        { ok: false, reason: "DRONES_UNAVAILABLE" });
    } finally {
      fixtures.cleanup(off.dir);
    }
    const lost = fakeWorld();
    const l = deploy(lost, 501);
    step(lost, l, 1000);
    lost.calls.length = 0;
    lost.tasks.drop(501, "LOST");
    assert.deepStrictEqual(of(lost.calls, "recall"), []);
    const ab = fakeWorld();
    const b = deploy(ab, 501);
    step(ab, b, 1000);
    for (const id of b.rt.drones.out.keys()) ab.scene.entities.get(id).controllerID = 0;
    ab.calls.length = 0;
    step(ab, b, 2000);
    assert.deepStrictEqual([b.rt.drones.out.size, b.rt.drones.phase, of(ab.calls, "launch").length], [0, "BLOCKED", 0]);
    assert.strictEqual(ab.sidecar.stats().counters["drone.abandoned"], 2);
  });

  const REPAIR_CONFIG = { droneRepairEnabled: true, logiRepairThresholdPct: 90, logiRetargetMs: 1000 };
  const repairStack = (itemId, quantity) => ({ itemId, typeId: 23707, quantity, bandwidth: 10, kind: "repair",
    family: "remoteArmor" });

  test("DT4 an armor repair drone and the host at 50 % armor: launch without an attack target, a repair "
    + "cycle on the host every durationMs; the host repaired (>= logiRepairThresholdPct) -> the drones orbit the twin; "
    + "no combat drone without an attack target; droneRepairEnabled off -> nothing", () => {
    const w = fakeWorld(REPAIR_CONFIG);
    w.bays[501] = [bay()[0], repairStack(711, 1), repairStack(712, 1)];
    w.host.kind = "ship";
    w.host.conditionState = { armorDamage: 0.5 };
    const a = deploy(w, 501);
    a.rt.task = "FOLLOW";
    a.rt.combat = null;
    step(w, a, 1000);
    assert.deepStrictEqual(of(w.calls, "launch"), [["launch", a.twin.itemID, 711], ["launch", a.twin.itemID, 712]]);
    assert.deepStrictEqual(of(w.calls, "repair").map((c) => [c[2], c[3]]), [[HOST, 10000], [HOST, 10000]]);
    assert.deepStrictEqual(of(w.calls, "fire"), []);
    w.calls.length = 0;
    w.sim = 11000;
    step(w, a, 2000);
    assert.deepStrictEqual(of(w.calls, "repair"), [], "not before durationMs");
    w.sim = 12000;
    step(w, a, 3000);
    assert.deepStrictEqual(of(w.calls, "repair").map((c) => [c[2], c[3]]), [[HOST, 12000], [HOST, 12000]]);
    assert.strictEqual(w.sidecar.stats().counters["drone.repair.cycle"], 4);
    w.host.conditionState = { armorDamage: 0 };
    w.calls.length = 0;
    w.sim = 14000;
    step(w, a, 4000);
    assert.deepStrictEqual(of(w.calls, "repair"), []);
    assert.deepStrictEqual(of(w.calls, "orbit").map((c) => [c[2], c[3], c[4]]),
      [[a.twin.itemID, 600, false], [a.twin.itemID, 600, false]]);
    const off = fakeWorld({ ...REPAIR_CONFIG, droneRepairEnabled: false });
    off.bays[501] = [repairStack(711, 2)];
    off.host.kind = "ship";
    off.host.conditionState = { armorDamage: 0.5 };
    const o = deploy(off, 501);
    o.rt.task = "FOLLOW";
    step(off, o, 1000);
    assert.deepStrictEqual(off.calls, []);
  });

  test("DT5 the twin's remote repair target of the drone's layer wins over the pick (twin B at 80 % "
    + "before the host at 50 %); another layer does not; combat and repair drones out together, each kind on its own "
    + "target", () => {
    const w = fakeWorld(REPAIR_CONFIG);
    w.bays[501] = [{ ...bay()[0] }, repairStack(711, 1)];
    w.host.kind = "ship";
    w.host.conditionState = { armorDamage: 0.5 };
    const a = deploy(w, 501);
    const b = deploy(w, 502);
    Object.assign(b.twin, { kind: "ship", pilotCharacterID: OWNER, conditionState: { armorDamage: 0.2 } });
    w.own = [a.twin.itemID, b.twin.itemID];
    const rr = { rep: { family: "remoteArmor" }, entry: { targetId: b.twin.itemID } };
    a.rt.active = { remote: [rr] };
    step(w, a, 1000);
    assert.deepStrictEqual(of(w.calls, "launch").map((c) => c[2]), [701, 711]);
    assert.deepStrictEqual(of(w.calls, "fire").map((c) => c[2]), [RAT], "the combat drone on the attack target");
    assert.deepStrictEqual(of(w.calls, "repair").map((c) => c[2]), [b.twin.itemID], "the RR target of the twin");
    rr.rep.family = "remoteShield";
    w.calls.length = 0;
    w.sim = 12000;
    step(w, a, 2000);
    assert.deepStrictEqual(of(w.calls, "repair").map((c) => c[2]), [HOST]);
  });

  function mixedOut() {
    const w = fakeWorld({ ...REPAIR_CONFIG, droneIdleRecallMs: 30000 });
    w.bandwidth = 50;
    w.bays[501] = [{ ...bay()[0] }, { ...bay()[0], itemId: 704 }, repairStack(711, 1), repairStack(712, 1)];
    w.host.kind = "ship";
    w.host.conditionState = { armorDamage: 0.5 };
    const a = deploy(w, 501);
    step(w, a, 1000);
    assert.deepStrictEqual(of(w.calls, "launch").map((c) => c[2]), [701, 704, 711, 712]);
    const ids = (kind) => [...a.rt.drones.out].filter(([, i]) => i.kind === kind).map(([id]) => id);
    return { w, a, combatIds: ids("combat"), repairIds: ids("repair") };
  }

  test("DT6 a per-kind recall re-reads the bay; the other kind, its whole stack in space, is still "
    + "known: the repair drones keep their family and cycle after the combat drones went back; hasCombatDrones stays "
    + "true after the repair drones went back", () => {
    const c = mixedOut();
    c.a.rt.combat.targetId = null;
    step(c.w, c.a, 2000);
    c.w.droneTwinM = SCOOP_DISTANCE_M;
    c.w.bays[501] = c.combatIds.map((id) => ({ itemId: id, typeId: 2488, quantity: 1, bandwidth: 10, kind: "combat" }));
    c.w.sim = 12000;
    step(c.w, c.a, 32000);
    assert.deepStrictEqual(of(c.w.calls, "recall"), [["recall", 501, c.combatIds]]);
    const reads = c.w.bayReads;
    c.w.calls.length = 0;
    c.w.sim = 14000;
    step(c.w, c.a, 33000);
    assert.strictEqual(c.w.bayReads, reads + 1, "one re-read after the real recall");
    assert.strictEqual(c.a.rt.drones.bay.repairFamily, "remoteArmor");
    assert.deepStrictEqual(of(c.w.calls, "repair").map((x) => [x[1], x[2]]), c.repairIds.map((id) => [id, HOST]));
    assert.deepStrictEqual(of(c.w.calls, "launch"), [], "no relaunch of the combat drones without a target");
    const r = mixedOut();
    r.w.host.conditionState = { armorDamage: 0 };
    r.w.sim = 12000;
    step(r.w, r.a, 2000);
    r.w.droneTwinM = SCOOP_DISTANCE_M;
    r.w.bays[501] = r.repairIds.map((id) => ({ ...repairStack(id, 1) }));
    step(r.w, r.a, 32000);
    assert.deepStrictEqual(of(r.w.calls, "recall"), [["recall", 501, r.repairIds]]);
    const before = r.w.bayReads;
    assert.strictEqual(r.w.sidecar.hasCombatDrones(r.a.rec), true, "combat drones in space count");
    assert.strictEqual(r.w.bayReads, before + 1);
    assert.strictEqual(r.w.sidecar.hasCombatDrones(r.a.rec), true);
    assert.strictEqual(r.w.bayReads, before + 1, "no read per call");
  });

  function miningWorld(config = {}) {
    const ROCK = 4100000000000007;
    const w = fakeWorld({ droneMiningEnabled: true, miningEnabled: true, droneMaxPerCopy: 1, ...config });
    w.rock = ROCK;
    w.bays[601] = [{ itemId: 701, typeId: 2488, quantity: 1, bandwidth: 10, kind: "combat" },
      { itemId: 704, typeId: 10246, quantity: 2, bandwidth: 5, kind: "mining", yieldKind: "ore" }];
    w.droneRockM = 100;
    w.yields = [];
    w.rockReads = 0;
    w.yieldOut = { ok: true, typeId: 1230, quantity: 5, wasted: 0, volumeM3: 50, depleted: false };
    w.scene.entities.set(ROCK, { itemID: ROCK });
    w.access.miningSnapshot = () => ({ ok: true, snapshot: { durationMs: 60000, orbitDistanceMeters: 500,
      maxRangeMeters: 1000 } });
    w.access.miningFx = (_s, drone, rockId) => w.calls.push(["fx", drone.itemID, rockId]) > 0;
    w.ts.surfaceDistance = (_s, a, b) => (a.kind === "drone" && b.itemID === ROCK ? w.droneRockM : w.droneTwinM);
    w.sidecar = createDroneSidecar({ access: w.access, scene: w.ts, combat: w.combat, config: w.config,
      mineYield: (_scene, _twin, drone, input, rockId, simMs) => {
        w.yields.push([drone.itemID, rockId, simMs, input.yieldKind]);
        return w.yieldOut;
      },
      mineRock: () => {
        w.rockReads += 1;
        return { ok: true, yieldKind: "ore", remaining: 1000 };
      } });
    w.tasks = createWingTasks({ sidecars: [w.sidecar], config: w.config });
    const a = deploy(w, 601);
    a.rt.task = "MINE";
    a.rt.combat = null;
    a.rt.mine = { claimed: true, rockId: ROCK };
    return { w, a };
  }

  test("DT7 (copy drones) MINE with a claimed rock: only the mining drones go out; far -> chase "
    + "(orbit of the rock, fast) without a yield; in range a cycle starts (FX), mineYield once at its end; no claimed "
    + "rock -> the home orbit; depleted -> no further yield; the rock kind is read once; droneMiningEnabled false -> "
    + "no launch", () => {
    const { w, a } = miningWorld();
    w.droneRockM = 5000;
    step(w, a, 1000);
    assert.deepStrictEqual(of(w.calls, "launch").map((c) => c[2]), [704], "the combat stack stays in the bay");
    const [droneId] = [...a.rt.drones.out.keys()];
    assert.deepStrictEqual(of(w.calls, "orbit").pop(), ["orbit", droneId, w.rock, 500, true]);
    assert.deepStrictEqual([w.yields.length, of(w.calls, "fx").length], [0, 0]);
    w.droneRockM = 100;
    step(w, a, 2000);
    assert.deepStrictEqual(of(w.calls, "fx"), [["fx", droneId, w.rock]]);
    w.sim = 69999;
    step(w, a, 3000);
    assert.strictEqual(w.yields.length, 0);
    w.sim = 70000;
    step(w, a, 4000);
    w.sim = 70001;
    step(w, a, 5000);
    assert.deepStrictEqual(w.yields, [[droneId, w.rock, 70000, "ore"]], "one yield per finished cycle");
    a.rt.mine.claimed = false;
    step(w, a, 6000);
    assert.deepStrictEqual(of(w.calls, "orbit").pop(), ["orbit", droneId, a.twin.itemID, 600, false]);
    a.rt.mine.claimed = true;
    w.sim = 80000;
    step(w, a, 7000);
    w.yieldOut = { ...w.yieldOut, depleted: true };
    w.sim = 140000;
    step(w, a, 8000);
    w.sim = 300000;
    step(w, a, 9000);
    assert.strictEqual(w.yields.length, 2);
    const c = w.sidecar.stats().counters;
    assert.deepStrictEqual([c["drone.mine.cycle"], c["drone.mine.depleted"], w.rockReads], [2, 1, 1]);
    const off = miningWorld({ droneMiningEnabled: false });
    step(off.w, off.a, 1000);
    assert.deepStrictEqual(of(off.w.calls, "launch"), []);
  });

  test("DT-S1 SALVAGE with a claimed wreck: only the salvage drones go out; far "
    + "-> chase (orbit of the wreck, fast), in range a cycle starts and salvageCycle runs at its end with the host; "
    + "salvaged -> no target for that wreck -> the home orbit of the twin -> back to the bay after droneIdleRecallMs; "
    + "a refusal is counted; droneSalvageEnabled false -> no launch, hasSalvageDrones false", () => {
    const WRECK = 4100000000000011;
    const make = (config = {}) => {
      const w = fakeWorld({ droneSalvageEnabled: true, salvageEnabled: true, droneMaxPerCopy: 2,
        droneIdleRecallMs: 30000, ...config });
      w.bays[701] = [{ itemId: 701, typeId: 2488, quantity: 1, bandwidth: 10, kind: "combat" },
        { itemId: 705, typeId: 32787, quantity: 2, bandwidth: 5, kind: "salvage" }];
      w.droneWreckM = 8000;
      w.cycles = [];
      w.cycleOut = { ok: true, salvaged: false, durationMs: 10000 };
      w.scene.entities.set(WRECK, { itemID: WRECK });
      w.access.salvageSnapshot = () => ({ ok: true, snapshot: { durationMs: 10000, orbitDistanceMeters: 500,
        maxRangeMeters: 5000 } });
      w.access.salvageCycle = (_s, _twin, drone, wreckId, owner, hostId, simMs) => {
        w.cycles.push([drone.itemID, wreckId, owner, hostId, simMs]);
        return w.cycleOut;
      };
      w.ts.surfaceDistance = (_s, a, b) => (a.kind === "drone" && b.itemID === WRECK ? w.droneWreckM : 100);
      w.sidecar = createDroneSidecar({ access: w.access, scene: w.ts, combat: w.combat, config: w.config });
      w.tasks = createWingTasks({ sidecars: [w.sidecar], config: w.config });
      const a = deploy(w, 701);
      a.rt.task = "SALVAGE";
      a.rt.combat = null;
      a.rt.salvage = { claimed: true, wreckId: WRECK, hostShipId: HOST };
      return { w, a };
    };
    const { w, a } = make();
    assert.strictEqual(w.sidecar.hasSalvageDrones(a.rec), true);
    step(w, a, 1000);
    assert.deepStrictEqual(of(w.calls, "launch").map((c) => c[2]), [705, 705], "the combat stack stays in the bay");
    const ids = [...a.rt.drones.out.keys()];
    assert.deepStrictEqual(of(w.calls, "orbit").map((c) => [c[2], c[3], c[4]]), [[WRECK, 500, true], [WRECK, 500, true]]);
    w.droneWreckM = 1000;
    step(w, a, 2000);
    w.sim = 19999;
    step(w, a, 3000);
    assert.strictEqual(w.cycles.length, 0);
    w.sim = 20000;
    step(w, a, 4000);
    assert.deepStrictEqual(w.cycles, ids.map((id) => [id, WRECK, OWNER, HOST, 20000]), "one cycle per drone, the host");
    w.cycleOut = { ok: false, reason: "RANGE" };
    w.sim = 30000;
    step(w, a, 5000);
    w.sim = 40000;
    step(w, a, 6000);
    w.cycleOut = { ok: true, salvaged: true, durationMs: 10000 };
    w.sim = 50000;
    step(w, a, 7000);
    const c = w.sidecar.stats().counters;
    assert.deepStrictEqual([c["drone.salvage.cycle"], c["drone.salvage.ok"], c["drone.salvage.refused.RANGE"]],
      [3, 1, 2]);
    w.sim = 60000;
    step(w, a, 8000);
    assert.strictEqual(w.cycles.length, 5, "no cycle on a finished wreck");
    assert.deepStrictEqual(of(w.calls, "orbit").slice(-2).map((c2) => c2[2]), [a.twin.itemID, a.twin.itemID],
      "the home orbit of the twin");
    step(w, a, 38000);
    step(w, a, 39000);
    assert.deepStrictEqual(of(w.calls, "recall").map((r) => r[2]), [ids]);
    assert.strictEqual(a.rt.drones.out.size, 0);
    const off = make({ droneSalvageEnabled: false });
    step(off.w, off.a, 1000);
    assert.deepStrictEqual([of(off.w.calls, "launch"), off.w.sidecar.hasSalvageDrones(off.a.rec)], [[], false]);
  });

  test("DT-S2 () hasSalvageDrones(record, rt): false with `drones off` and a blocked runtime "
    + "counted from `out` and a fresh bay read (not the bay cache: an emptied bay counts no more); salvageProgress: "
    + "able, the salvage drones out, done CARGO / NO_TARGET for the wreck they left", () => {
    const WRECK = 4100000000000012;
    const w = fakeWorld({ droneSalvageEnabled: true, salvageEnabled: true, droneMaxPerCopy: 2 });
    w.bays[711] = [{ itemId: 715, typeId: 32787, quantity: 2, bandwidth: 5, kind: "salvage" }];
    w.bays[712] = [{ itemId: 716, typeId: 32787, quantity: 1, bandwidth: 5, kind: "salvage" }];
    w.scene.entities.set(WRECK, { itemID: WRECK });
    w.cycleOut = { ok: false, reason: "CARGO" };
    w.access.salvageSnapshot = () => ({ ok: true, snapshot: { durationMs: 10000, orbitDistanceMeters: 500,
      maxRangeMeters: 5000 } });
    w.access.salvageCycle = () => w.cycleOut;
    w.ts.surfaceDistance = () => 100;
    w.sidecar = createDroneSidecar({ access: w.access, scene: w.ts, combat: w.combat, config: w.config });
    w.tasks = createWingTasks({ sidecars: [w.sidecar], config: w.config });
    const a = deploy(w, 711);
    a.rt.task = "SALVAGE";
    a.rt.combat = null;
    a.rt.salvage = { claimed: true, wreckId: WRECK, hostShipId: HOST };
    assert.strictEqual(w.sidecar.hasSalvageDrones(a.rec, a.rt), true, "no drone state yet: the default mode");
    step(w, a, 1000);
    assert.deepStrictEqual(w.sidecar.salvageProgress(a.rt, WRECK), { able: true, out: 2, done: null });
    w.sidecar.setMode(a.rt, "off");
    assert.deepStrictEqual([w.sidecar.hasSalvageDrones(a.rec, a.rt), w.sidecar.salvageProgress(a.rt, WRECK).able],
      [false, false], "drones off");
    w.sidecar.setMode(a.rt, "auto");
    a.rt.drones.blocked = true;
    assert.deepStrictEqual([w.sidecar.hasSalvageDrones(a.rec, a.rt), w.sidecar.salvageProgress(a.rt, WRECK).able],
      [false, false], "blocked");
    a.rt.drones.blocked = false;
    w.sim = 20000;
    step(w, a, 2000);
    assert.deepStrictEqual(w.sidecar.salvageProgress(a.rt, WRECK).done, "CARGO");
    assert.strictEqual(w.sidecar.salvageProgress(a.rt, WRECK + 1).done, null, "another wreck");
    w.cycleOut = { ok: false, reason: "NO_TARGET" };
    a.rt.salvage.claimed = false;
    step(w, a, 3000);
    assert.strictEqual(w.sidecar.salvageProgress(a.rt, WRECK).done, null);
    const b = deploy(w, 712);
    b.rt.task = "SALVAGE";
    b.rt.combat = null;
    step(w, b, 1000);
    assert.deepStrictEqual([of(w.calls, "launch").filter((c) => c[1] === b.twin.itemID).length,
      w.sidecar.hasSalvageDrones(b.rec, b.rt)], [0, true]);
    w.bays[712] = [];
    assert.strictEqual(w.sidecar.hasSalvageDrones(b.rec, b.rt), false, "the emptied bay, not the cache");
  });

  test("DT8 a combat target and no combat drone in the bay (only mining drones, or "
    + "none): no access.launch, drone.launch.skipped.noCombatDrones once per runtime and target (not per tick); "
    + "a new target counts again; a bay with combat drones never counts", () => {
    const NAME = "drone.launch.skipped.noCombatDrones";
    const { w, a } = miningWorld();
    w.bays[601] = [{ itemId: 704, typeId: 10246, quantity: 2, bandwidth: 5, kind: "mining", yieldKind: "ore" }];
    a.rt.task = "ATTACK";
    a.rt.combat = { targetId: RAT };
    a.rt.mine = { claimed: true, rockId: w.rock };
    for (let t = 1000; t <= 4000; t += 1000) step(w, a, t);
    assert.deepStrictEqual(of(w.calls, "launch"), [], "mining drones are not combat drones");
    assert.strictEqual(w.sidecar.stats().counters[NAME], 1);
    const RAT2 = RAT + 1;
    w.scene.entities.set(RAT2, { itemID: RAT2 });
    a.rt.combat.targetId = RAT2;
    step(w, a, 5000);
    step(w, a, 6000);
    assert.strictEqual(w.sidecar.stats().counters[NAME], 2, "a new target counts once more");
    const empty = fakeWorld();
    empty.bays[602] = [];
    step(empty, deploy(empty, 602), 1000);
    step(empty, deploy(empty, 603), 1000);
    assert.strictEqual(of(empty.calls, "launch").length, 2, "ship 603: the default bay with combat drones");
    assert.strictEqual(empty.sidecar.stats().counters[NAME], 1);
  });

  const unit = (itemId, typeId, left, bandwidth) => ({ itemId, typeId, left, bandwidth });
  const ids = (plan) => plan.map((e) => [e.typeId, e.itemId]);

  test("DT9 view.max = the launch: Venture (10 Mbit, Mining Drone I 5) max 2 before "
    + "and after the launch, 2 drones out; Pioneer (20 Mbit, mining + Hobgoblins) mining max 4; planLaunch: mixed "
    + "medium + light = the most drones, a tie of count = the bigger bandwidth, then typeId, itemId", () => {
    const { w, a } = miningWorld({ droneMaxPerCopy: 5 });
    w.bandwidth = 10;
    w.bays[601] = [{ itemId: 704, typeId: 10246, quantity: 5, bandwidth: 5, kind: "mining", yieldKind: "ore" }];
    assert.strictEqual(w.sidecar.view(a.rt).drones.max, null, "the bay not read yet");
    a.rt.mine.claimed = false;
    step(w, a, 1000);
    assert.deepStrictEqual([of(w.calls, "launch").length, w.sidecar.view(a.rt).drones.max], [0, 2]);
    a.rt.mine.claimed = true;
    step(w, a, 2000);
    step(w, a, 3000);
    assert.deepStrictEqual(of(w.calls, "launch").map((c) => c[2]), [704, 704], "Venture: 2 drones");
    assert.deepStrictEqual([w.sidecar.view(a.rt).drones.out, w.sidecar.view(a.rt).drones.max], [2, 2]);
    const pio = miningWorld({ droneMaxPerCopy: 5 });
    pio.w.bandwidth = 20;
    pio.w.bays[601] = [{ itemId: 801, typeId: 2454, quantity: 3, bandwidth: 5, kind: "combat" },
      { itemId: 802, typeId: 10246, quantity: 5, bandwidth: 5, kind: "mining", yieldKind: "ore" }];
    pio.a.rt.mine.claimed = false;
    step(pio.w, pio.a, 1000);
    const before = pio.w.sidecar.view(pio.a.rt).drones.max;
    pio.a.rt.mine.claimed = true;
    step(pio.w, pio.a, 2000);
    assert.deepStrictEqual([before, of(pio.w.calls, "launch").map((c) => c[2])], [4, [802, 802, 802, 802]]);
    assert.strictEqual(pio.w.sidecar.view(pio.a.rt).drones.max, 4);
    const mixed = [unit(711, 2183, 2, 10), unit(712, 2454, 5, 5)];
    assert.deepStrictEqual(ids(planLaunch(mixed, 5, 25)), Array(5).fill([2454, 712]));
    const m = fakeWorld();
    m.bays[501] = [{ itemId: 711, typeId: 2183, quantity: 2, bandwidth: 10, kind: "combat" },
      { itemId: 712, typeId: 2454, quantity: 5, bandwidth: 5, kind: "combat" }];
    const ma = deploy(m, 501);
    step(m, ma, 1000);
    assert.deepStrictEqual([of(m.calls, "launch").length, m.sidecar.view(ma.rt).drones.max], [5, 5]);
    assert.deepStrictEqual(ids(planLaunch(mixed, 2, 25)), [[2183, 711], [2183, 711]]);
    assert.deepStrictEqual(ids(planLaunch(mixed, 2, 15)), [[2183, 711], [2454, 712]]);
    const lights = [unit(722, 2486, 1, 5), unit(721, 2454, 1, 5), unit(720, 2454, 1, 5)];
    assert.deepStrictEqual(ids(planLaunch(lights, 1, 5)), [[2454, 720]]);
    assert.deepStrictEqual([planLaunch(lights, 0, 50), planLaunch(lights, 3, 4)], [[], []]);
  });

  test("DT10 a launch refused NOT_IN_BAY (a stale bay snapshot): the bay is read again at the "
    + "next step and the fresh stack launches", () => {
    const w = fakeWorld();
    const launch = w.access.launch;
    w.access.launch = (scene, twin, o) => (o.itemId === 701 ? { ok: false, reason: "NOT_IN_BAY" }
      : launch(scene, twin, o));
    const a = deploy(w, 501);
    step(w, a, 1000);
    assert.strictEqual(a.rt.drones.out.size, 0);
    w.bays[501] = [{ itemId: 705, typeId: 2488, quantity: 2, bandwidth: 10, kind: "combat" }];
    const reads = w.bayReads;
    step(w, a, 2000);
    assert.deepStrictEqual([w.bayReads, of(w.calls, "launch").slice(-2).map((c) => c[2])], [reads + 1, [705, 705]]);
  });
};
