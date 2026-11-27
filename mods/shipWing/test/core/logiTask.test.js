"use strict";

const assert = require("node:assert");
const { createWingTasks } = require("../../lib/core/wingTasks");
const { createActiveSidecar } = require("../../lib/core/activeTask");
const { createEwarSidecar } = require("../../lib/core/ewarTask");
const { createLogiAccess } = require("../../lib/adapter/logiAccess");
const { createActiveAccess } = require("../../lib/adapter/activeAccess");
const { formatStatus } = require("../../lib/channels/chat");
const { fixtures: combat } = require("./combatEngine.test");
const { fixtures: core } = require("./wingService.test");
const { fakes: logiFakes } = require("../adapter/logiAccess.test");
const { fakes: activeFakes } = require("../adapter/activeAccess.test");

const TWIN = 4200000000000010;
const TWIN2 = 4200000000000011;
const RR_MODULE = 21;

function logiConfig(w, extra = {}) {
  return { ...w.config, activeModulesEnabled: true, logiEnabled: true, activeMaxCyclesPerTick: 32,
    activeFxEnabled: false, ...extra };
}

function rrTwin(itemID) {
  return { ...combat.twinEntity(itemID), typeID: 11987, conditionState: {}, skillMap: new Map(),
    fittedItems: [{ itemID: RR_MODULE, typeID: 3530, flagID: 19 }] };
}

function rrPlan() {
  return { localRep: [], remote: [{ moduleId: RR_MODULE, flagId: 19, typeId: 3530, effectRecord: logiFakes.RR,
    family: "remoteArmor", layer: null }], summary: { cap: "stable", shed: 0, alwaysOn: 0, localRep: 0, remote: 1,
    logi: true } };
}

function world(opts = {}) {
  const w = combat.fakeWorld();
  w.scene.getEntityByID = (id) => w.scene.entities.get(Number(id)) || null;
  w.host.kind = "ship";
  w.host.conditionState = { armorDamage: 0.5 };
  w.host.distToTwin = 2000;
  w.own = [];
  w.cfg = logiConfig(w, opts.config);
  w.v = logiFakes.fakeLogiVendor({ dist: (a, b) => w.ts.surfaceDistance(null, a, b) });
  w.logi = createLogiAccess({ deps: w.v.deps, config: w.cfg });
  w.sidecar = createActiveSidecar({ access: w.access, scene: w.ts, config: w.cfg, logi: w.logi,
    wingTwins: () => w.own.map((twinEntityId) => ({ twinEntityId })) });
  const mine = { name: "mine", canRun: () => ({ ok: true }), start() {}, stop() {},
    step: () => ({ controlsMovement: true }) };
  const salvage = { ...mine, name: "salvage" };
  w.tasks = createWingTasks({ engines: { attack: w.engine, mine, salvage }, sidecars: [w.sidecar], config: w.cfg });
  return w;
}

function launch(w, shipItemId, twin, plan = rrPlan()) {
  w.add(twin);
  const rec = combat.record(shipItemId, twin);
  w.tasks.start(rec, { active: plan });
  return rec;
}

function stepAt(w, rec, twin, nowMs) {
  return w.tasks.step(rec, null, { twin, host: w.host, nowMs, scene: w.scene });
}

function counters(w) {
  return w.tasks.stats().counters;
}

module.exports = ({ test }) => {
  test("LT1 mixed fit: a volley and an RR cycle in one tick; `hold` -> no volley, RR goes on; the "
    + "repair target out of range -> moveLease, the ASSIST engine gives no movement order while it is valid; MINE -> "
    + "no lease", () => {
    const w = world();
    const twin = rrTwin(TWIN);
    w.add(combat.rat());
    w.host.activeModuleEffects.set(1, { weaponFamily: "hybridTurret", targetID: combat.rat().itemID });
    const rec = launch(w, 501, twin);
    assert.strictEqual(w.tasks.order(rec, null, "attack", { mode: "ASSIST", twin, scene: w.scene, record: rec }).ok,
      true);
    stepAt(w, rec, twin, 1000);
    assert.deepStrictEqual([w.fired.length, counters(w)["logi.cycle.start"]], [1, 1], "volley + RR start, one tick");
    assert.strictEqual(w.v.resolve[w.v.resolve.length - 1].options.targetID, combat.HOST);
    w.sim += 5000;
    stepAt(w, rec, twin, 2000);
    assert.deepStrictEqual([w.host.conditionState.armorDamage, counters(w)["logi.cycle.ok"]], [0.4, 1]);
    assert.ok(w.fired.length >= 2);
    assert.match(formatStatus({ deployedCount: 1, limit: 2, ships: [{ shipItemId: 501, name: "Guardian",
      state: "ACTIVE", task: "ATTACK", active: w.tasks.activeOf(501) }] }), /RR 1, repairing host\]/);

    assert.strictEqual(w.tasks.order(rec, null, "hold", { scene: w.scene, record: rec }).ok, true);
    const fired = w.fired.length;
    w.sim += 5000;
    stepAt(w, rec, twin, 3000);
    assert.deepStrictEqual([w.fired.length, w.host.conditionState.armorDamage], [fired, 0.3], "HOLD stops weapons only");

    assert.strictEqual(w.tasks.order(rec, null, "attack", { mode: "ASSIST", twin, scene: w.scene, record: rec }).ok,
      true);
    w.sim += 5000;
    w.host.distToTwin = 20000;
    w.scene.entities.get(combat.rat().itemID).distToTwin = 30000;
    const out = stepAt(w, rec, twin, 4000);
    assert.deepStrictEqual(out, { controlsMovement: true });
    const rt = w.tasks.context(501);
    assert.deepStrictEqual([rt.moveLease.by, rt.moveLease.targetId, rt.moveLease.moduleId], ["logi", combat.HOST,
      RR_MODULE]);
    const leaseAt = w.orders.length;
    for (let i = 1; i <= 5; i += 1) {
      w.sim += 500;
      w.host.distToTwin -= 500;
      assert.deepStrictEqual(stepAt(w, rec, twin, 4000 + i * 500), { controlsMovement: true });
    }
    const later = w.orders.slice(leaseAt);
    assert.ok(later.length > 0 && later.every((o) => o[0] === "approach" && o[2] === combat.HOST && o[3] === 5000),
      JSON.stringify(later));

    assert.strictEqual(w.tasks.order(rec, null, "mine", { targetId: 777, twin, scene: w.scene, record: rec }).ok, true);
    const ordersBefore = w.orders.length;
    w.sim += 1000;
    stepAt(w, rec, twin, 9000);
    assert.deepStrictEqual([rt.moveLease, w.orders.length], [null, ordersBefore], "MINE: no lease, no approach");

    assert.strictEqual(w.tasks.order(rec, null, "salvage", { twin, scene: w.scene, record: rec }).ok, true);
    w.sim += 1000;
    stepAt(w, rec, twin, 10000);
    assert.deepStrictEqual([w.tasks.context(501).task, w.tasks.context(501).moveLease, w.orders.length],
      ["SALVAGE", null, ordersBefore], "SALVAGE: no lease, no approach");
  });

  test("LT2 move: out of range -> approach at each renewal (every logiRetargetMs); no nearer for "
    + "logiMoveLeaseMs -> logi.move.stuck, no further approach until nearer; FOLLOW under a valid lease -> the core "
    + "does not follow", () => {
    const w = world();
    const twin = rrTwin(TWIN);
    const rec = launch(w, 501, twin);
    w.host.distToTwin = 20000;
    const approaches = () => w.orders.filter((o) => o[0] === "approach").length;
    const seen = [];
    for (let t = 0; t <= 6000; t += 500) {
      const out = stepAt(w, rec, twin, 1000 + t);
      seen.push([t, approaches(), out.controlsMovement]);
      w.sim += 500;
    }
    assert.deepStrictEqual(seen.map((s) => s[1]), [1, 1, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3], JSON.stringify(seen));
    assert.deepStrictEqual(seen.map((s) => s[2]), [...Array(6).fill(true), ...Array(7).fill(false)],
      "the lease steers until stuck, then the core follows");
    assert.strictEqual(counters(w)["logi.move.stuck"], 1);
    assert.strictEqual(counters(w)["logi.move.lease"], 1);
    w.host.distToTwin = 15000;
    stepAt(w, rec, twin, 9000);
    assert.deepStrictEqual([approaches(), counters(w)["logi.move.lease"]], [4, 2]);
    assert.strictEqual(w.v.resolve.length, 1, "only the range read, no cycle out of range");

    let lease = true;
    const sidecar = { name: "active", step: () => ({ controlsMovement: lease }), dispose() {}, stats: () => ({}) };
    const t = core.setup({ taskSidecars: [sidecar] });
    try {
      assert.strictEqual(t.svc.orderCopy(core.CHAR, 501, "launch", { commandId: "c" }).ok, true);
      const follows = () => t.w.calls.filter((c) => c[0] === "follow").length;
      const atLaunch = follows();
      t.clock.t += 60000;
      t.svc.tick(t.clock.t);
      assert.strictEqual(follows(), atLaunch, "FOLLOW + lease: no follow of the core");
      lease = false;
      t.svc.tick(t.clock.t);
      assert.strictEqual(follows(), atLaunch + 1);
    } finally {
      core.cleanup(t.dir);
    }
  });

  test("LT3 the rule at the end of a cycle: the own twin stops being allowed between start and end -> "
    + "TARGET_NOT_LOCKED, no HP; of: logiEnabled + an unstable fit with RR -> RR shed, zero RR "
    + "cycles; wing.activeTwinsOf: ACTIVE twins of the character only, no adapter call", () => {
    const w = world();
    const twin = rrTwin(TWIN);
    const other = w.add({ ...rrTwin(TWIN2), conditionState: { armorDamage: 0.5 }, distToTwin: 1000 });
    w.host.conditionState = {};
    w.own = [TWIN, TWIN2];
    const rec = launch(w, 501, twin);
    stepAt(w, rec, twin, 1000);
    assert.deepStrictEqual([w.v.resolve.length, counters(w)["logi.target.twin"], counters(w)["logi.cycle.start"]],
      [2, 1, 1]);
    w.own = [TWIN];
    w.sim += 5000;
    stepAt(w, rec, twin, 2000);
    assert.deepStrictEqual([counters(w)["logi.cycle.skip.TARGET_NOT_LOCKED"], counters(w)["logi.cycle.ok"],
      other.conditionState.armorDamage], [1, 0, 0.5]);
    assert.strictEqual(counters(w)["logi.target.none"], 1, "the next pick finds nothing");

    const { fakeVendor, config, fitModule, spec, OWNER } = activeFakes;
    const plan = (extra, cfg) => createActiveAccess({ deps: fakeVendor(extra).deps, config: config(cfg) })
      .planActive(spec([fitModule(11, 2301, 11), fitModule(14, 16455, 14)]), { ownerCharId: OWNER, systemID: 0,
        weapons: [] });
    const shed = plan({}, { logiEnabled: true });
    assert.deepStrictEqual([shed.plan.summary.cap, shed.plan.summary.remote, shed.plan.summary.logi, shed.plan.remote],
      ["shed", 0, true, []]);
    const stable = plan({ capacity: 10000000 }, { logiEnabled: true });
    assert.deepStrictEqual([stable.plan.summary.remote, stable.plan.remote.map((r) => [r.moduleId, r.family])],
      [1, [[14, "remoteArmor"]]]);
    const off = plan({ capacity: 10000000 }, {});
    assert.deepStrictEqual([off.plan.summary.remote, off.plan.summary.logi, off.plan.remote], [1, undefined, []]);
    const w2 = world();
    const twin3 = rrTwin(TWIN);
    const rec3 = launch(w2, 503, twin3, shed.plan);
    for (let i = 0; i < 3; i += 1) {
      w2.sim += 5000;
      stepAt(w2, rec3, twin3, 1000 + i);
    }
    assert.deepStrictEqual([w2.v.resolve.length, w2.v.execute.length, w2.host.conditionState.armorDamage],
      [0, 0, 0.5]);

    const t = core.setup({ config: { maxWingPerPilot: 3 } });
    try {
      for (const id of [501, 502, 503]) assert.strictEqual(t.svc.orderCopy(core.CHAR, id, "launch", { commandId: "c" }).ok, true);
      assert.strictEqual(t.svc.orderCopy(core.CHAR, 502, "return").ok, true);
      assert.strictEqual(t.svc.beginLoss(503, { cause: "DESTROYED" }).ok, true);
      let adapterCalls = 0;
      for (const name of Object.keys(t.adapter)) {
        const fn = t.adapter[name];
        if (typeof fn === "function") t.adapter[name] = (...args) => { adapterCalls += 1; return fn(...args); };
      }
      assert.deepStrictEqual(t.svc.activeTwinsOf(core.CHAR),
        [{ shipItemId: 501, twinEntityId: core.twinOf(t, 501) }]);
      assert.deepStrictEqual(t.svc.activeTwinsOf(core.OTHER), [], "another character: nothing");
      assert.strictEqual(adapterCalls, 0);
    } finally {
      core.cleanup(t.dir);
    }
  });

  function rrWorld() {
    const w = world();
    const twin = rrTwin(TWIN);
    w.host.conditionState = {};
    w.other = w.add({ ...rrTwin(TWIN2), conditionState: { armorDamage: 0.5 }, distToTwin: 8000 });
    w.own = [TWIN, TWIN2];
    w.moves = () => w.orders.filter((o) => o[0] === "approach" || o[0] === "stop");
    w.drive = (rec, nowMs) => {
      const out = stepAt(w, rec, twin, nowMs);
      const last = w.moves()[w.moves().length - 1];
      if (!out.controlsMovement || !last || last[2] !== TWIN2) w.other.distToTwin = 15000;
      return out;
    };
    return { w, twin };
  }

  test("LT4 (combat-audit) a cycle in flight holds the twin until its end: FOLLOW (no follow of the "
    + "core, one approach to the target) and ATTACK (no approach to the attack target while the hold is valid) -> the "
    + "cycle ends with the repair; a target that leaves the range anyway -> logi.cycle.skip.TARGET_OUT_OF_RANGE, then "
    + "an approach lease (no hold)", () => {
    const f = rrWorld();
    const rec = launch(f.w, 501, f.twin);
    const start = f.w.sim;
    assert.deepStrictEqual(f.w.drive(rec, 1000), { controlsMovement: true });
    const rt = f.w.tasks.context(501);
    assert.deepStrictEqual([rt.moveLease.hold, rt.moveLease.targetId, rt.moveLease.untilSimMs],
      [true, TWIN2, start + 5000]);
    assert.deepStrictEqual(f.w.moves(), [["approach", TWIN, TWIN2, 5000]], "one order to the repair target");
    f.w.sim += 2500;
    assert.deepStrictEqual(f.w.drive(rec, 2000), { controlsMovement: true }, "the core does not follow the host");
    f.w.sim += 2500;
    f.w.drive(rec, 3000);
    assert.deepStrictEqual([counters(f.w)["logi.cycle.ok"], counters(f.w)["logi.cycle.skip.TARGET_OUT_OF_RANGE"],
      f.w.other.conditionState.armorDamage], [1, 0, 0.4], "the cycle ends in range with the repair");

    const a = rrWorld();
    a.w.add(combat.rat(undefined, { distToTwin: 30000 }));
    const recA = launch(a.w, 502, a.twin);
    assert.strictEqual(a.w.tasks.order(recA, null, "attack", { targetId: combat.rat().itemID, twin: a.twin,
      scene: a.w.scene, record: recA }).ok, true);
    a.w.drive(recA, 1000);
    assert.deepStrictEqual(a.w.moves(), [["approach", TWIN, combat.rat().itemID, 5000], ["approach", TWIN, TWIN2, 5000]],
      "the engine first, then the hold of the cycle start (same tick)");
    a.w.sim += 2500;
    a.w.drive(recA, 2000);
    assert.strictEqual(a.w.moves().length, 2, "no movement order of the engine while the hold is valid");
    a.w.sim += 2500;
    a.w.drive(recA, 3000);
    assert.deepStrictEqual([counters(a.w)["logi.cycle.ok"], a.w.other.conditionState.armorDamage], [1, 0.4]);

    const o = rrWorld();
    const recO = launch(o.w, 503, o.twin);
    o.w.drive(recO, 1000);
    o.w.other.distToTwin = 12000;
    o.w.sim += 5000;
    o.w.drive(recO, 2000);
    assert.deepStrictEqual([counters(o.w)["logi.cycle.skip.TARGET_OUT_OF_RANGE"], counters(o.w)["logi.cycle.skip.OTHER"],
      counters(o.w)["logi.cycle.ok"]], [1, 0, 0]);
    const rtO = o.w.tasks.context(503);
    assert.deepStrictEqual([rtO.moveLease.hold, rtO.moveLease.targetId, counters(o.w)["logi.move.lease"],
      counters(o.w)["logi.move.hold"]], [undefined, TWIN2, 1, 1], "out of range: the approach lease of");
  });

  test("LT5 (combat-audit) the end began (rt.ending, beforeEnd; end.removeRetry keeps the twin): the "
    + "sidecar stops - no end of the cycle in flight, no new cycle, the lease dropped, the core follows again", () => {
    const w = world();
    const twin = rrTwin(TWIN);
    const rec = launch(w, 501, twin);
    stepAt(w, rec, twin, 1000);
    assert.deepStrictEqual([counters(w)["logi.cycle.start"], w.tasks.context(501).moveLease.hold], [1, true]);
    w.tasks.beforeEnd(rec, { scene: w.scene }, "RECALL_DONE");
    assert.deepStrictEqual(stepAt(w, rec, twin, 1500), { controlsMovement: false }, "the hold ends with the end");
    w.sim += 5000;
    assert.deepStrictEqual(stepAt(w, rec, twin, 2000), { controlsMovement: false });
    assert.deepStrictEqual([w.v.execute.length, counters(w)["logi.cycle.start"], w.tasks.context(501).moveLease,
      w.host.conditionState.armorDamage], [0, 1, null, 0.5]);
  });

  test("LT6 (combat-audit) HOLD: a target in range -> the cycle and the hold lease, 0 movement "
    + "orders; a target out of range -> no cycle, no lease, no movement, logi.cycle.skip.TARGET_OUT_OF_RANGE", () => {
    const moves = (w, from) => w.orders.slice(from).filter((o) => o[0] === "approach");
    const w = world();
    const twin = rrTwin(TWIN);
    const rec = launch(w, 501, twin);
    assert.strictEqual(w.tasks.order(rec, null, "hold", { scene: w.scene, record: rec }).ok, true);
    const at = w.orders.length;
    assert.deepStrictEqual(stepAt(w, rec, twin, 1000), { controlsMovement: true });
    assert.deepStrictEqual([counters(w)["logi.cycle.start"], counters(w)["logi.move.hold"],
      w.tasks.context(501).moveLease.hold, moves(w, at)], [1, 1, true, []], "HOLD: the hold without approach");
    w.sim += 5000;
    stepAt(w, rec, twin, 2000);
    assert.deepStrictEqual([counters(w)["logi.cycle.ok"], w.host.conditionState.armorDamage, moves(w, at)],
      [1, 0.4, []]);

    const o = world();
    const twinO = rrTwin(TWIN);
    const recO = launch(o, 502, twinO);
    assert.strictEqual(o.tasks.order(recO, null, "hold", { scene: o.scene, record: recO }).ok, true);
    o.host.distToTwin = 20000;
    const atO = o.orders.length;
    for (let i = 0; i < 4; i += 1) {
      assert.deepStrictEqual(stepAt(o, recO, twinO, 1000 + i * 500), { controlsMovement: false });
      o.sim += 500;
    }
    assert.deepStrictEqual([counters(o)["logi.cycle.start"], counters(o)["logi.move.lease"],
      counters(o)["logi.move.hold"], o.tasks.context(502).moveLease || null, moves(o, atO)],
    [0, 0, 0, null, []], "HOLD out of range: no cycle, no movement");
    assert.ok(counters(o)["logi.cycle.skip.TARGET_OUT_OF_RANGE"] >= 1);
  });

  test("LT7 (combat-audit) the pick skips an entity out of the interaction scope (other AIR "
    + "instance): the host is not picked, the next target (own twin) is; a throw of the vendor rule = not a target",
  () => {
    const w = world();
    const twin = rrTwin(TWIN);
    w.host.airInstanceID = 77;
    w.add({ ...rrTwin(TWIN2), conditionState: { armorDamage: 0.4 }, distToTwin: 1000 });
    w.own = [TWIN, TWIN2];
    const rec = launch(w, 501, twin);
    stepAt(w, rec, twin, 1000);
    assert.deepStrictEqual([counters(w)["logi.target.host"], counters(w)["logi.target.twin"],
      w.v.resolve.slice(1).map((r) => r.options.targetID)], [0, 1, [TWIN2]], "the next target is picked");

    const v = logiFakes.fakeLogiVendor({ scopeThrows: true });
    const access = createLogiAccess({ deps: v.deps, config: w.cfg });
    assert.deepStrictEqual([access.canInteract(twin, w.host), access.stats().counters["logi.access.error"]],
      [false, 1]);
  });

  test("FM-L1 (formations) ctx.formation true: a lease of before is dropped at once; the RR target out of "
    + "range -> no rt.moveLease, no approach, no cycle; in range -> the cycle without the hold lease, the core steers",
  () => {
    const w = world();
    const twin = rrTwin(TWIN);
    const rec = launch(w, 501, twin);
    const rt = w.tasks.context(501);
    const fstep = (nowMs) => w.tasks.step(rec, null, { twin, host: w.host, nowMs, scene: w.scene, formation: true });
    rt.moveLease = { by: "logi", hold: true, moduleId: RR_MODULE, targetId: combat.HOST, untilSimMs: w.sim + 60000 };
    w.host.distToTwin = 20000;
    assert.deepStrictEqual(fstep(1000), { controlsMovement: false });
    assert.strictEqual(rt.moveLease, null, "the lease of before the formation is dropped");
    w.sim += w.cfg.logiRetargetMs;
    assert.deepStrictEqual(fstep(2000), { controlsMovement: false });
    assert.deepStrictEqual([rt.moveLease, w.orders.filter((o) => o[0] === "approach").length,
      counters(w)["logi.cycle.start"], counters(w)["logi.move.lease"]], [null, 0, 0, 0], "out of range: nothing");
    w.host.distToTwin = 2000;
    w.sim += 500;
    assert.deepStrictEqual(fstep(3000), { controlsMovement: false });
    assert.deepStrictEqual([counters(w)["logi.cycle.start"], rt.moveLease, counters(w)["logi.move.hold"],
      w.orders.filter((o) => o[0] === "approach").length], [1, null, 0, 0], "in range: the cycle, no hold");
  });

  test("FM-L2 two targets below the threshold, the more damaged out of range: in a "
    + "formation the cycle goes on the one in range; formation none -> the old pick and the approach lease", () => {
    const setup = () => {
      const w = world();
      const twin = rrTwin(TWIN);
      w.host.conditionState = { armorDamage: 0.5 };
      w.add({ ...rrTwin(TWIN2), conditionState: { armorDamage: 0.7 }, distToTwin: 12000 });
      w.own = [TWIN, TWIN2];
      return { w, twin, rec: launch(w, 501, twin) };
    };
    const f = setup();
    const fstep = (nowMs) => f.w.tasks.step(f.rec, null, { twin: f.twin, host: f.w.host, nowMs, scene: f.w.scene,
      formation: true });
    for (let i = 0; i < 3; i += 1) {
      assert.deepStrictEqual(fstep(1000 + i * 500), { controlsMovement: false });
      f.w.sim += 500;
    }
    const last = f.w.v.resolve[f.w.v.resolve.length - 1].options.targetID;    assert.deepStrictEqual([counters(f.w)["logi.cycle.start"], last, counters(f.w)["logi.formation.repick"],
      f.w.tasks.context(501).moveLease || null, f.w.orders.filter((o) => o[0] === "approach").length],
    [1, combat.HOST, 1, null, 0], "formation: the host in reach is repaired");

    const n = setup();
    for (let i = 0; i < 3; i += 1) {
      stepAt(n.w, n.rec, n.twin, 1000 + i * 500);
      n.w.sim += 500;
    }
    assert.deepStrictEqual([counters(n.w)["logi.cycle.start"], n.w.tasks.context(501).moveLease.targetId,
      counters(n.w)["logi.formation.repick"] || 0], [0, TWIN2, 0], "none: the most damaged, the approach lease");
  });

  test("LT8 (BUG nos-rr) RR + Nos on one twin, ATTACK: the RR picks the own twin at 50 % (host 80 %) "
    + "the Nos starts on the NPC; the move lease is the logi's only; the Nos never changes the RR target; the next pick "
    + "after the cycle = the host at 40 %", () => {
    const w = world();
    const twin = rrTwin(TWIN);
    w.host.conditionState = { armorDamage: 0.2 };
    const other = w.add({ ...rrTwin(TWIN2), conditionState: { armorDamage: 0.5 }, distToTwin: 1000 });
    w.own = [TWIN, TWIN2];
    w.add(combat.rat());
    w.host.activeModuleEffects.set(1, { weaponFamily: "hybridTurret", targetID: combat.rat().itemID });
    const nosCalls = [];
    const ewarAccess = {
      rangeOf: () => ({ ok: true, optimalM: 10000, falloffM: 0 }),
      startCycle: (_s, _t, rep, targetId, simMs) => {
        nosCalls.push(["start", targetId]);
        return { ok: true, durationMs: 5000, data: { effectState: { moduleID: rep.moduleId, targetID: targetId,
          durationMs: 5000 }, appliedGJ: 0, nosIdle: true } };
      },
      refreshCycle: (_s, _t, state) => {
        nosCalls.push(["refresh", state.targetID]);
        return { ok: true, appliedGJ: 0, nosIdle: true };
      },
      release: () => ({ ok: true, removed: true }),
      sweep: () => ({ released: 0 }),
      stats: () => ({ counters: {} }),
    };
    const ewar = createEwarSidecar({ access: ewarAccess, combat: { targetAllowed: () => true }, scene: w.ts,
      config: { ...w.cfg, ewarRetryMs: 2000, ewarMaxCyclesPerTick: 32, ewarOrphanSweepMs: 10000 } });
    w.tasks = createWingTasks({ engines: { attack: w.engine }, sidecars: [w.sidecar, ewar], config: w.cfg });
    const plan = { ...rrPlan(), ewar: [{ moduleId: 31, flagId: 20, typeId: 12257, effectRecord: {}, kind: "nos" }] };
    const rec = launch(w, 501, twin, plan);
    assert.strictEqual(w.tasks.order(rec, null, "attack", { mode: "ASSIST", twin, scene: w.scene, record: rec }).ok,
      true);
    stepAt(w, rec, twin, 1000);
    const rt = w.tasks.context(501);
    assert.deepStrictEqual([rt.task, counters(w)["logi.target.twin"], counters(w)["logi.cycle.start"],
      w.v.resolve[w.v.resolve.length - 1].options.targetID], ["ATTACK", 1, 1, TWIN2], "RR on the own twin");
    assert.deepStrictEqual([ewar.stats().counters["ewar.start.nos"], nosCalls], [1, [["start", combat.rat().itemID]]],
      "the Nos on the NPC");
    assert.ok(rt.moveLease === null || rt.moveLease === undefined || rt.moveLease.by === "logi",
      JSON.stringify(rt.moveLease));
    w.host.conditionState.armorDamage = 0.6;
    w.sim += 5000;
    stepAt(w, rec, twin, 2000);
    assert.deepStrictEqual([counters(w)["logi.cycle.ok"], other.conditionState.armorDamage,
      counters(w)["logi.target.host"], w.v.resolve[w.v.resolve.length - 1].options.targetID],
    [1, 0.4, 1, combat.HOST], "the next pick = the host");
    assert.deepStrictEqual(nosCalls.map((c) => c[1]), [combat.rat().itemID, combat.rat().itemID],
      "the Nos stays on the NPC");
    assert.ok(rt.moveLease === null || rt.moveLease === undefined || rt.moveLease.by === "logi",
      JSON.stringify(rt.moveLease));
  });
};
