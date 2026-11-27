"use strict";

const assert = require("node:assert");
const { createEwarSidecar } = require("../../lib/core/ewarTask");
const { createWingTasks } = require("../../lib/core/wingTasks");

const TWIN = 7001;
const NPC = 900;
const NPC2 = 901;
const CONFIG = Object.freeze({ ewarRetryMs: 2000, ewarMaxCyclesPerTick: 32, ewarOrphanSweepMs: 10000 });

function world() {
  const scene = { systemID: 30000142, now: 0, ents: new Map(), locks: [NPC], dist: 5000, allowed: true,
    lockResult: { ok: true } };
  for (const id of [TWIN, NPC, NPC2]) scene.ents.set(id, { itemID: id });
  const calls = [];
  const ts = {
    simNow: (s) => s.now,
    entity: (s, id) => s.ents.get(id) || null,
    targetsOf: (s) => [...s.locks],
    surfaceDistance: (s) => s.dist,
    lock: (s, _twin, target, opts) => {
      calls.push(["lock", target.itemID, opts.keepIds]);
      if (s.lockResult.ok === true) s.locks.push(target.itemID);
      return s.lockResult;
    },
    approach: () => calls.push(["approach"]),
  };
  const access = {
    rangeOf: () => ({ ok: true, optimalM: 10000, falloffM: 0 }),
    startCycle: (_s, _t, rep, targetId, simMs) => {
      calls.push(["start", targetId, simMs]);
      return { ok: true, durationMs: 5000, data: { effectState: { moduleID: rep.moduleId, targetID: targetId,
        durationMs: 5000 }, appliedGJ: 0, nosIdle: false } };
    },
    refreshCycle: (_s, _t, state, simMs) => {
      calls.push(["refresh", state.targetID, simMs]);
      return { ok: true, appliedGJ: 0, nosIdle: false };
    },
    release: (s, twin, twinId, state) => {
      calls.push(["release", state.targetID, twinId, s ? "scene" : "none"]);
      return { ok: true, removed: true };
    },
    sweep: () => ({ released: 0 }),
    stats: () => ({ counters: { "ewar.release.ok": 0 } }),
  };
  const combat = { targetAllowed: (s) => s.allowed };
  const sidecar = createEwarSidecar({ access, combat, scene: ts, config: CONFIG });
  const rt = () => ({ task: "ATTACK", combat: { targetId: NPC }, ending: false,
    launch: { active: { ewar: [{ moduleId: 11, flagId: 27, typeId: 526, effectRecord: {}, kind: "web" }] } } });
  const step = (r, nowMs) => sidecar.step(r, { scene, twin: scene.ents.get(TWIN), host: { itemID: 1 },
    record: { shipItemId: 501 }, nowMs });
  const of = (kind) => calls.filter((c) => c[0] === kind);
  return { scene, calls, access, sidecar, rt, step, of, counters: () => sidecar.stats().counters };
}

module.exports = ({ test }) => {
  test("ET1 ATTACK on an allowed locked target -> startCycle once; before nextAt nothing; at nextAt refreshCycle; "
    + "start.web 1, cycle.web 2, never steers", () => {
    const w = world();
    const r = w.rt();
    assert.deepStrictEqual(w.step(r, 1), { controlsMovement: false });
    assert.deepStrictEqual(w.of("start"), [["start", NPC, 0]]);
    w.scene.now = 4999;
    w.step(r, 2);
    assert.strictEqual(w.of("start").length + w.of("refresh").length, 1, "no call before nextAt");
    w.scene.now = 5000;
    w.step(r, 3);
    assert.deepStrictEqual(w.of("refresh"), [["refresh", NPC, 5000]]);
    const c = w.counters();
    assert.deepStrictEqual([c["ewar.start.web"], c["ewar.cycle.web"], c["ewar.release.ok"]], [1, 2, 0]);
    assert.deepStrictEqual(w.sidecar.view(r), { ewarOn: ["web"] });
    assert.strictEqual(w.of("approach").length, 0);
  });

  test("ET2 a new rt.combat.targetId -> release of the old before startCycle of the new; task MINE -> release, "
    + "ewar.stop.NO_TARGET", () => {
    const w = world();
    const r = w.rt();
    w.step(r, 1);
    w.scene.locks.push(NPC2);
    r.combat.targetId = NPC2;
    w.scene.now = 1000;
    w.step(r, 2);
    assert.deepStrictEqual(w.calls.filter((c) => c[0] !== "lock").map((c) => c.slice(0, 2)),
      [["start", NPC], ["release", NPC], ["start", NPC2]]);
    assert.deepStrictEqual(w.of("release")[0], ["release", NPC, TWIN, "scene"], "released with the twin id");
    r.task = "MINE";
    w.scene.now = 2000;
    w.step(r, 3);
    assert.deepStrictEqual(w.of("release").map((c) => c[1]), [NPC, NPC2]);
    assert.strictEqual(w.of("start").length, 2, "no start without ATTACK");
    const c = w.counters();
    assert.deepStrictEqual([c["ewar.stop.TARGET_CHANGED"], c["ewar.stop.NO_TARGET"]], [1, 1]);
    assert.deepStrictEqual(w.sidecar.view(r), { ewarOn: [] });
  });

  test("ET3 no lock -> twinScene.lock with keepIds = the locks now; refused -> next try after ewarRetryMs, no start; "
    + "out of optimal+falloff -> no start, skip.TARGET_OUT_OF_RANGE, no approach", () => {
    const w = world();
    const r = w.rt();
    w.scene.locks = [555];
    w.scene.lockResult = { ok: false, reason: "TARGET_LOCK_FAILED" };
    w.step(r, 1);
    assert.deepStrictEqual(w.of("lock"), [["lock", NPC, [555]]]);
    w.scene.now = 1999;
    w.step(r, 2);
    assert.strictEqual(w.of("lock").length, 1, "no lock before ewarRetryMs");
    assert.strictEqual(w.of("start").length, 0);
    w.scene.now = 2000;
    w.scene.lockResult = { ok: true };
    w.scene.dist = 10001;
    w.step(r, 3);
    assert.strictEqual(w.of("lock").length, 2);
    assert.strictEqual(w.of("start").length, 0);
    const c = w.counters();
    assert.deepStrictEqual([c["ewar.lock.requested"], c["ewar.lock.refused"], c["ewar.skip.TARGET_OUT_OF_RANGE"]],
      [2, 1, 1]);
    assert.strictEqual(w.of("approach").length, 0);
  });

  test("ET4 suspend -> one release, beforeEnd and dispose after it -> none more; dispose without a scene -> no "
    + "throw, no call, ewar.release.noScene", () => {
    const w = world();
    const r = w.rt();
    w.step(r, 1);
    w.sidecar.suspend(r, "RECALL", { scene: w.scene });
    w.sidecar.beforeEnd(r, "RECALL_DONE", { record: {}, scene: w.scene });
    w.sidecar.dispose(r, "RECALL_DONE", { shipItemId: 501, scene: w.scene });
    assert.deepStrictEqual(w.of("release"), [["release", NPC, TWIN, "scene"]]);
    const r2 = w.rt();
    w.step(r2, 2);
    w.sidecar.dispose(r2, "RESTART", { shipItemId: 502, scene: null });
    assert.strictEqual(w.of("release").length, 1);
    const c = w.counters();
    assert.deepStrictEqual([c["ewar.stop.SUSPEND"], c["ewar.stop.ENDING"], c["ewar.stop.DISPOSE"],
      c["ewar.release.noScene"]], [1, 0, 0, 1]);
    assert.strictEqual(r2.ewar.disposed, true);
  });

  test("ET5 (wingTasks) drop(id, LOST, {scene}) -> sidecar dispose gets {shipItemId, scene}; dropAll -> scene null",
    () => {
      const seen = [];
      const spy = { name: "spy", step: () => ({ controlsMovement: false }), stats: () => ({ counters: {} }),
        dispose: (_rt, reason, extra) => seen.push([reason, extra]) };
      const tasks = createWingTasks({ sidecars: [spy] });
      const scene = { systemID: 1 };
      tasks.start({ shipItemId: 501 });
      tasks.drop(501, "LOST", { scene });
      tasks.start({ shipItemId: 502 });
      tasks.dropAll("RESTART");
      assert.deepStrictEqual(seen, [["LOST", { shipItemId: 501, scene }], ["RESTART", { shipItemId: 502, scene: null }]]);
      assert.strictEqual(seen[0][1].scene, scene);
    });

  test("ET6 (of) not allowed -> NOT_ALLOWED; lock gone and refused -> LOCK_LOST; refresh refused "
    + "-> CYCLE_FAILED without a release of the sidecar; rt.ending -> ENDING", () => {
    const stopOf = (w) => Object.fromEntries(["NOT_ALLOWED", "LOCK_LOST", "CYCLE_FAILED", "ENDING"]
      .map((why) => [why, w.counters()[`ewar.stop.${why}`]]));
    const a = world();
    const ra = a.rt();
    a.step(ra, 1);
    a.scene.allowed = false;
    a.scene.now = 1000;
    a.step(ra, 2);
    assert.deepStrictEqual(a.of("release").map((c) => c[1]), [NPC]);
    assert.deepStrictEqual(stopOf(a), { NOT_ALLOWED: 1, LOCK_LOST: 0, CYCLE_FAILED: 0, ENDING: 0 });
    assert.deepStrictEqual(a.sidecar.view(ra), { ewarOn: [] });

    const b = world();
    const rb = b.rt();
    b.step(rb, 1);
    b.scene.locks = [];
    b.scene.lockResult = { ok: false, reason: "TARGET_LOCK_FAILED" };
    b.scene.now = 1000;
    b.step(rb, 2);
    assert.deepStrictEqual(b.of("release").map((c) => c[1]), [NPC]);
    assert.deepStrictEqual(stopOf(b), { NOT_ALLOWED: 0, LOCK_LOST: 1, CYCLE_FAILED: 0, ENDING: 0 });

    const c = world();
    const rc = c.rt();
    c.step(rc, 1);
    c.access.refreshCycle = () => ({ ok: false, reason: "TARGET_OUT_OF_RANGE" });
    c.scene.now = 5000;
    c.step(rc, 2);
    assert.strictEqual(c.of("release").length, 0, "no second release by the sidecar");
    assert.deepStrictEqual(stopOf(c), { NOT_ALLOWED: 0, LOCK_LOST: 0, CYCLE_FAILED: 1, ENDING: 0 });
    assert.strictEqual(c.counters()["ewar.skip.TARGET_OUT_OF_RANGE"], 1);
    assert.deepStrictEqual(c.sidecar.view(rc), { ewarOn: [] });

    const d = world();
    const rd = d.rt();
    d.step(rd, 1);
    rd.ending = true;
    d.scene.now = 1000;
    assert.deepStrictEqual(d.step(rd, 2), { controlsMovement: false });
    assert.deepStrictEqual(d.of("release"), [["release", NPC, TWIN, "scene"]]);
    assert.deepStrictEqual(stopOf(d), { NOT_ALLOWED: 0, LOCK_LOST: 0, CYCLE_FAILED: 0, ENDING: 1 });
    d.scene.now = 6000;
    d.step(rd, 3);
    assert.strictEqual(d.of("start").length, 1, "no start after the end began");
  });

  test("ET7 wingTasks.releaseEffects(sceneOf) -> sidecar release(rt, STOPPED, {scene}) per "
    + "runtime, runtimes stay; the EWAR sidecar releases with the scene, ewar.stop.STOPPED", () => {
    const seen = [];
    const spy = { name: "spy", step: () => ({ controlsMovement: false }), stats: () => ({ counters: {} }),
      release: (_rt, reason, extra) => seen.push([reason, extra]) };
    const tasks = createWingTasks({ sidecars: [spy, { name: "noHook" }] });
    const scene = { systemID: 1 };
    tasks.start({ shipItemId: 501 });
    tasks.start({ shipItemId: 502 });
    tasks.releaseEffects((id) => {
      if (id === 502) throw new Error("boom");
      return scene;
    });
    assert.deepStrictEqual(seen, [["STOPPED", { scene }], ["STOPPED", { scene: null }]]);
    assert.strictEqual(tasks.size(), 2, "runtimes stay");

    const w = world();
    const r = w.rt();
    w.step(r, 1);
    w.sidecar.release(r, "STOPPED", { scene: w.scene });
    w.sidecar.release(r, "STOPPED", { scene: w.scene });
    assert.deepStrictEqual(w.of("release"), [["release", NPC, TWIN, "scene"]], "once (idempotent)");
    assert.strictEqual(w.counters()["ewar.stop.STOPPED"], 1);
  });
};
