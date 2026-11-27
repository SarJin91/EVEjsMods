"use strict";

const assert = require("node:assert");
const { createActiveSidecar } = require("../../lib/core/activeTask");
const { createActiveAccess } = require("../../lib/adapter/activeAccess");
const { fakes } = require("../adapter/activeAccess.test");
const { createPropAccess } = require("../../lib/adapter/propAccess");
const { fakes: propFakes } = require("../adapter/propAccess.test");

const TWIN = 4200000000000001;
const TWIN2 = 4200000000000002;
const TARGET = 4200000000000009;
const OWNER = 90000001;
const PROP_REP = Object.freeze({ moduleId: 16, flagId: 16, typeId: 35660, effectRecord: { effectID: 6730 } });

function cfg(extra = {}) {
  return { activePropEnabled: true, activePropMinDistanceMeters: 5000, followRetuneMs: 1000,
    activeMaxCyclesPerTick: 32, ...extra };
}

function fakeProp() {
  const p = { applied: [], attrs: 0, failApply: false, failAttrs: false };
  p.access = {
    attrsOf: (_twin, rep, owner) => {
      p.attrs += 1;
      if (p.failAttrs) return { ok: false, reason: "ERROR" };
      return { ok: true, state: { moduleID: rep.moduleId, owner, effectName: "moduleBonusMicrowarpdrive" } };
    },
    apply: (_scene, twin, state, previous) => {
      p.applied.push([twin.itemID, state ? "on" : "off", previous ? "prev" : "none"]);
      if (p.failApply) return { ok: false, reason: "ERROR", retryMs: null };
      return { ok: true, durationMs: 1000, data: { on: Boolean(state) } };
    },
    stats: () => ({ counters: { "prop.fx.error": 0 } }),
  };
  return p;
}

function harness(opts = {}) {
  const h = { sim: 10000, dist: 20000, nowMs: 0 };
  const target = { itemID: TARGET };
  const ts = { simNow: () => h.sim, entity: (_s, id) => (id === TARGET ? target : null),
    surfaceDistance: () => h.dist };
  h.prop = fakeProp();
  h.scene = {};
  h.side = createActiveSidecar({ access: { isGone: () => false }, scene: ts, config: cfg(opts.config),
    prop: opts.noAccess ? null : (opts.prop || h.prop.access) });
  h.rt = (plan) => ({ task: "FOLLOW", launch: { active: plan } });
  h.twin = (id) => ({ itemID: id, mode: "STOP", targetEntityID: TARGET, position: { x: 0, y: 0, z: 0 } });
  h.step = (rt, twin, sameTick) => {
    if (!sameTick) h.nowMs += 1;
    return h.side.step(rt, { scene: h.scene, twin, record: { ownerCharacterId: OWNER }, nowMs: h.nowMs });
  };
  h.counters = () => h.side.stats().counters;
  return h;
}

module.exports = ({ test }) => {
  test("PT1 decision (scene time): STOP -> off; FOLLOW 20 km > 5 km -> on; <= 5 km -> off only at the next due "
    + "step (followRetuneMs after the switch); GOTO targetPoint; target gone -> off; attrs once; no prop module, "
    + "flag off or no access -> never on; shared budget (deferred); failures wait followRetuneMs; dispose", () => {
    const h = harness();
    const plan = { localRep: [], remote: [], prop: [PROP_REP] };
    const rt = h.rt(plan);
    const twin = h.twin(TWIN);
    assert.deepStrictEqual(h.step(rt, twin), { controlsMovement: false });
    assert.deepStrictEqual(h.prop.applied, [], "STOP: off, no apply");
    twin.mode = "FOLLOW";
    h.step(rt, twin);
    assert.deepStrictEqual(h.prop.applied, [[TWIN, "on", "none"]]);
    h.dist = 3000;
    h.sim += 500;
    h.step(rt, twin);
    assert.strictEqual(h.prop.applied.length, 1, "hysteresis: no switch before followRetuneMs");
    h.sim += 500;
    h.step(rt, twin);
    assert.deepStrictEqual(h.prop.applied[1], [TWIN, "off", "prev"]);
    h.dist = 5000;
    h.sim += 1000;
    h.step(rt, twin);
    assert.strictEqual(h.prop.applied.length, 2, "= threshold stays off; same state, no apply");
    h.dist = 20000;
    h.step(rt, twin);
    assert.deepStrictEqual(h.prop.applied[2], [TWIN, "on", "none"]);
    twin.mode = "ORBIT";
    twin.targetEntityID = 777;
    h.sim += 1000;
    h.step(rt, twin);
    assert.deepStrictEqual(h.prop.applied[3], [TWIN, "off", "prev"]);
    twin.mode = "GOTO";
    twin.targetEntityID = 0;
    twin.targetPoint = { x: 20000, y: 0, z: 0 };
    h.sim += 1000;
    h.step(rt, twin);
    twin.targetPoint = { x: 4000, y: 0, z: 0 };
    h.sim += 1000;
    h.step(rt, twin);
    assert.deepStrictEqual(h.prop.applied.slice(4).map((a) => a[1]), ["on", "off"]);
    assert.strictEqual(h.prop.attrs, 1, "attrs once per runtime");
    twin.targetPoint = { x: 20000, y: 0, z: 0 };
    h.sim += 1500;
    h.step(rt, twin);
    twin.targetPoint = { x: 4000, y: 0, z: 0 };
    h.sim += 500;
    h.step(rt, twin);
    assert.deepStrictEqual(h.prop.applied.slice(6).map((a) => a[1]), ["on"], "500 ms after a switch: no switch");
    h.sim += 500;
    h.step(rt, twin);
    assert.deepStrictEqual(h.prop.applied.slice(6).map((a) => a[1]), ["on", "off"]);
    h.prop.applied.splice(6);
    let c = h.counters();
    assert.deepStrictEqual([c["prop.on"], c["prop.off"], c["prop.error"], c["prop.fx.error"]], [4, 4, 0, 0]);

    h.prop.failApply = true;
    twin.targetPoint = { x: 30000, y: 0, z: 0 };
    h.sim += 1000;
    h.step(rt, twin);
    h.sim += 999;
    h.step(rt, twin);
    assert.strictEqual(h.prop.applied.length, 7);
    h.prop.failApply = false;
    h.sim += 1;
    h.step(rt, twin);
    assert.deepStrictEqual(h.prop.applied[7], [TWIN, "on", "none"]);
    assert.strictEqual(h.counters()["prop.error"], 1);
    h.side.dispose(rt, "LOST");
    assert.strictEqual(rt.active.prop, null);
    twin.mode = "STOP";
    h.sim += 5000;
    h.step(rt, twin);
    assert.strictEqual(h.prop.applied.length, 8);

    const b = harness({ config: { activeMaxCyclesPerTick: 1 } });
    const r1 = b.rt({ localRep: [], prop: [PROP_REP] });
    const r2 = b.rt({ localRep: [], prop: [PROP_REP] });
    const t1 = { ...b.twin(TWIN), mode: "FOLLOW" };
    const t2 = { ...b.twin(TWIN2), mode: "FOLLOW" };
    b.step(r1, t1);
    b.step(r2, t2, true);
    assert.deepStrictEqual([b.prop.applied.map((a) => a[0]), b.counters()["active.cycles.deferred"]], [[TWIN], 1]);
    b.step(r2, t2);
    assert.deepStrictEqual(b.prop.applied.map((a) => a[0]), [TWIN, TWIN2]);
    const f = harness();
    f.prop.failAttrs = true;
    f.step(f.rt({ prop: [PROP_REP] }), { ...f.twin(TWIN), mode: "FOLLOW" });
    assert.deepStrictEqual([f.prop.applied.length, f.counters()["prop.error"]], [0, 1]);

    for (const [label, made, plan2] of [["no module", harness(), { localRep: [], prop: [] }],
      ["flag off", harness({ config: { activePropEnabled: false } }), { prop: [PROP_REP] }],
      ["no access", harness({ noAccess: true }), { prop: [PROP_REP] }]]) {
      const r = made.rt(plan2);
      made.step(r, { ...made.twin(TWIN), mode: "FOLLOW" });
      assert.deepStrictEqual([label, made.prop.applied.length, r.active], [label, 0, null]);
    }
    c = h.counters();
    assert.strictEqual(c["prop.on"], 5);
  });

  test("PT2: activePropEnabled + unstable fit -> the MWD is the first shed, plan.prop = [] "
    + "and zero switches; stable -> plan.prop = the kept MWD and it switches on; flag off -> plan.prop = [] and the "
    + "MWD is not in the balance", () => {
    const { fakeVendor, config, fitModule, spec } = fakes;
    const fit = [fitModule(11, 2301, 11), fitModule(16, 35660, 16)];
    const plan = (capacity, extra) => {
      const access = createActiveAccess({ deps: fakeVendor({ capacity }).deps, config: config(extra) });
      const out = access.planActive(spec(fit), { ownerCharId: OWNER, systemID: 0, weapons: [] });
      assert.strictEqual(out.ok, true, JSON.stringify(out));
      return out.plan;
    };
    const run = (p) => {
      const h = harness();
      h.step(h.rt(p), { ...h.twin(TWIN), mode: "FOLLOW" });
      return h.prop.applied.length;
    };
    const unstable = plan(5000, { activePropEnabled: true });
    assert.deepStrictEqual([unstable.summary.cap, unstable.summary.shedTypeIds, unstable.summary.prop, unstable.prop,
      unstable.alwaysOn], ["shed", [35660], false, [], [11]]);
    assert.strictEqual(run(unstable), 0, "a shed AB/MWD never switches on");
    const stable = plan(2000000, { activePropEnabled: true });
    assert.deepStrictEqual([stable.summary.cap, stable.summary.prop, stable.prop.map((m) => m.moduleId)],
      ["stable", true, [16]]);
    assert.strictEqual(run(stable), 1);
    const off = plan(5000, {});
    assert.deepStrictEqual([off.summary.cap, off.summary.prop, off.prop, off.classified.prop], ["stable", false, [], 1]);
  });

  test("PT3: a throw half-way through apply at off -> on (the real prop access, MWD) leaves "
    + "the MWD values and prop.error; the state is unknown, so the next decision to off calls apply and the twin has "
    + "P1 again (speed and signatureRadius); then known off = no apply", () => {
    const { fakeVendor, fakeScene, makeTwin, config: paConfig, MWD_RECORD } = propFakes;
    const real = createPropAccess({ deps: fakeVendor().deps, config: paConfig({ activeFxEnabled: false }) });
    const calls = [];
    const access = { attrsOf: real.attrsOf, stats: real.stats,
      apply: (...args) => { calls.push(args[2] ? "on" : "off"); return real.apply(...args); } };
    const h = harness({ prop: access });
    h.scene = fakeScene(false);
    const prime = h.scene.broadcastShipPrimeUpdates;
    let throws = 1;
    h.scene.broadcastShipPrimeUpdates = (e, o) => {
      if (throws > 0) {
        throws -= 1;
        throw new Error("boom");
      }
      return prime(e, o);
    };
    const twin = { ...makeTwin(), mode: "FOLLOW", targetEntityID: TARGET, position: { x: 0, y: 0, z: 0 } };
    const pick = (e) => ({ maxVelocity: e.maxVelocity, signatureRadius: e.signatureRadius });
    const rt = h.rt({ localRep: [], remote: [], prop: [{ ...PROP_REP, effectRecord: MWD_RECORD }] });
    h.step(rt, twin);
    assert.deepStrictEqual(calls, ["on"]);
    assert.deepStrictEqual(pick(twin), { maxVelocity: 1200, signatureRadius: 240 }, "the throw leaves the MWD values");
    assert.deepStrictEqual([h.counters()["prop.error"], h.counters()["prop.on"]], [1, 0]);
    h.dist = 3000;
    h.sim += 1000;
    h.step(rt, twin);
    assert.deepStrictEqual(calls, ["on", "off"], "state unknown: apply although the last good state was off");
    assert.deepStrictEqual(pick(twin), { maxVelocity: 200, signatureRadius: 40 }, "P1 again");
    assert.strictEqual(h.counters()["prop.off"], 1);
    h.sim += 1000;
    h.step(rt, twin);
    assert.deepStrictEqual(calls, ["on", "off"], "known off: no apply");
  });

  test("PT4: MINE at its rock (LOCK, MINING) orbiting 9 km > activePropMinDistanceMeters -> "
    + "AB/MWD stays off and an on one goes off; MINE on the way (UNLOAD_TRAVEL) -> on as before", () => {
    const h = harness();
    const rt = { task: "MINE", sub: "UNLOAD_TRAVEL", launch: { active: { localRep: [], remote: [], prop: [PROP_REP] } } };
    const twin = { ...h.twin(TWIN), mode: "FOLLOW" };
    h.step(rt, twin);
    assert.deepStrictEqual(h.prop.applied, [[TWIN, "on", "none"]], "travel: on as before");
    rt.sub = "MINING";
    twin.mode = "ORBIT";
    h.dist = 9000;
    h.sim += 1000;
    h.step(rt, twin);
    assert.deepStrictEqual(h.prop.applied[1], [TWIN, "off", "prev"], "orbit of the rock: off");
    rt.sub = "LOCK";
    h.sim += 1000;
    h.step(rt, twin);
    rt.sub = "MINING";
    h.sim += 1000;
    h.step(rt, twin);
    assert.strictEqual(h.prop.applied.length, 2, "stays off at the rock");
  });

  test("PT5 salvage: SALVAGE at its wreck (LOCK, SALVAGING) -> AB/MWD off as MINE, on the way "
    + "(SEEK) -> on; SALVAGE never holds a logi lease: a lease of before is dropped, the step is FREE", () => {
    const h = harness();
    const rt = { task: "SALVAGE", sub: "SEEK", launch: { active: { localRep: [], remote: [], prop: [PROP_REP] } } };
    const twin = { ...h.twin(TWIN), mode: "FOLLOW" };
    h.step(rt, twin);
    assert.deepStrictEqual(h.prop.applied, [[TWIN, "on", "none"]], "SEEK: on as before");
    rt.sub = "SALVAGING";
    twin.mode = "ORBIT";
    h.dist = 9000;
    h.sim += 1000;
    h.step(rt, twin);
    assert.deepStrictEqual(h.prop.applied[1], [TWIN, "off", "prev"], "orbit of the wreck: off");
    rt.sub = "LOCK";
    h.sim += 1000;
    h.step(rt, twin);
    assert.strictEqual(h.prop.applied.length, 2, "stays off at the wreck");
    rt.moveLease = { by: "logi", moduleId: 77, targetId: TARGET, sinceSimMs: h.sim, untilSimMs: h.sim + 60000 };
    assert.deepStrictEqual(h.step(rt, twin), { controlsMovement: false });
    assert.strictEqual(rt.moveLease, null, "SALVAGE: no logi lease");
  });
};
