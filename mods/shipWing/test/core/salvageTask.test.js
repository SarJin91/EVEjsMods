"use strict";

const assert = require("node:assert");
const { createSalvageEngine } = require("../../lib/core/salvageTask");

const OWNER = 90000001;
const HOST = 1000000400;
const W1 = 4100000000000001;
const W2 = 4100000000000002;
const CONFIG = Object.freeze({ salvageSearchRangeMeters: 15000, salvageLeashMarginMeters: 2500,
  salvageSeekRetryMs: 10000, salvageFullRetryMs: 30000, salvageMinFreeCargoM3: 1, salvageMaxSeeksPerTick: 2,
  miningRangeBufferMeters: 500, followRangeMeters: 1500, followRetuneMs: 1000 });

function world() {
  const w = {
    host: { itemID: HOST, position: { x: 0, y: 0, z: 0 } },
    wrecks: new Map([[W1, { itemID: W1, position: { x: 3000, y: 0, z: 0 }, done: false }],
      [W2, { itemID: W2, position: { x: 6000, y: 0, z: 0 }, done: false }]]),
    near: false,
    free: 100,
    log: [],
  };
  w.access = {
    salvagerModules: (twin) => twin.salvagers.map((id) => ({ moduleId: id, module: { itemID: id },
      effectName: "salvaging" })),
    workRangeM: () => 4500,
    candidates: (_scene, host, rangeM) => [...w.wrecks.values()].filter((e) => !e.done)
      .map((e) => ({ wreckId: e.itemID, distanceM: Math.abs(e.position.x - host.position.x) }))
      .filter((c) => c.distanceM <= rangeM).sort((a, b) => a.distanceM - b.distanceM),
    isSalvageable: (_scene, id) => Boolean(w.wrecks.get(id) && !w.wrecks.get(id).done),
    wreckDistanceM: (_scene, a, id) => (w.wrecks.get(id) ? { ok: true,
      distanceM: Math.abs(w.wrecks.get(id).position.x - a.position.x) } : { ok: false, reason: "NO_WRECK" }),
    hostCargoFreeM3: () => ({ ok: true, freeM3: w.free }),
  };
  w.scene = {
    entity: (_scene, id) => w.wrecks.get(id) || null,
    surfaceDistance: () => (w.near ? 1000 : 9000),
    approach: (_s, twin, id) => { w.log.push(["approach", twin.itemID, id]); return true; },
    orbit: (_s, twin, id) => {
      w.log.push(["orbit", twin.itemID, id]);
      if (w.orbitRefused) return false;
      twin.mode = "ORBIT";
      twin.targetEntityID = id;
      return true;
    },
    followHost: (_s, twin) => { w.log.push(["follow", twin.itemID]); return true; },
    lock: () => ({ ok: true }),
    targetsOf: () => [],
    activate: (_s, twin, module, _effect, targetId) => {
      twin.activeModuleEffects.set(module.itemID, { targetID: targetId });
      w.log.push(["activate", twin.itemID, module.itemID, targetId]);
      return { ok: true };
    },
    deactivate: (_s, twin, id) => { twin.activeModuleEffects.delete(id); w.log.push(["off", twin.itemID, id]); return true; },
    activeEffect: (twin, id) => {
      const s = twin.activeModuleEffects.get(id);
      return s ? { targetID: s.targetID } : null;
    },
  };
  return w;
}

function twin(id, salvagers) {
  return { itemID: id, salvagers, activeModuleEffects: new Map() };
}

function runtime(twinId) {
  return { task: "SALVAGE", targetId: null, sub: null, nextActionAtMs: 0, lastRefusal: null,
    record: { ownerCharacterId: OWNER, hostShipId: HOST, twinEntityId: twinId } };
}

function engineOf(w) {
  return createSalvageEngine({ access: w.access, scene: w.scene, config: CONFIG, hookReady: () => true });
}

module.exports = ({ test }) => {
  test("ST1 SEEK -> APPROACH -> LOCK -> SALVAGING (every Salvager on the wreck, one orbit) -> the vendor finished "
    + "the wreck -> SEEK picks the next wreck; leashAnchorId = the wreck", () => {
    const w = world();
    const engine = engineOf(w);
    const t = twin(7001, [11, 12]);
    const rt = runtime(7001);
    engine.start(rt, { record: rt.record, scene: {} });
    const step = (nowMs) => engine.step(rt, { scene: {}, twin: t, host: w.host, nowMs, record: rt.record });
    let out = step(1000);
    assert.deepStrictEqual([rt.sub, rt.salvage.wreckId], ["APPROACH", W1]);
    assert.deepStrictEqual(out, { controlsMovement: true, leashAnchorId: W1 });
    step(1500);
    assert.deepStrictEqual(w.log.filter((l) => l[0] === "approach"), [["approach", 7001, W1]]);
    step(2000);
    assert.strictEqual(w.log.filter((l) => l[0] === "approach").length, 1, "one approach per wreck");
    w.near = true;
    step(2500);
    assert.strictEqual(rt.sub, "LOCK");
    step(3000);
    assert.strictEqual(rt.sub, "SALVAGING");
    assert.deepStrictEqual(w.log.filter((l) => l[0] === "activate"), [["activate", 7001, 11, W1], ["activate", 7001, 12, W1]]);
    assert.strictEqual(engine.stats().counters["salvage.engine.activated"], 2, "Each activation counts");
    step(3500);
    assert.strictEqual(w.log.filter((l) => l[0] === "orbit").length, 1, "one orbit order");
    w.wrecks.get(W1).done = true;
    t.activeModuleEffects.clear();
    w.near = false;
    out = step(4000);
    assert.deepStrictEqual([rt.sub, rt.salvage.wreckId], ["APPROACH", W2], "the next wreck in the same step");
    assert.deepStrictEqual(out, { controlsMovement: true, leashAnchorId: W2 });
    assert.strictEqual(engine.stats().claims, 1);
  });

  test("ST7 (round 2) a Salvager the vendor stopped (the effect gone, the engine did not switch it off) "
    + "-> salvage.engine.effectLost once, activated again after salvageSeekRetryMs; the engine's own stop is no "
    + "effectLost", () => {
    const w = world();
    w.near = true;
    const engine = engineOf(w);
    const t = twin(7001, [11]);
    const rt = runtime(7001);
    engine.start(rt, { record: rt.record });
    const step = (nowMs) => engine.step(rt, { scene: {}, twin: t, host: w.host, nowMs, record: rt.record });
    step(1000);
    step(1500);
    step(2000);
    assert.strictEqual(rt.sub, "SALVAGING");
    t.activeModuleEffects.delete(11);
    step(5000);
    const c = () => engine.stats().counters;
    assert.deepStrictEqual([c()["salvage.engine.effectLost"], c()["salvage.engine.activated"]], [1, 1]);
    step(12000);
    assert.deepStrictEqual([c()["salvage.engine.effectLost"], c()["salvage.engine.activated"]], [1, 2]);
    w.free = 0;
    step(12500);
    assert.strictEqual(rt.sub, "FULL");
    assert.strictEqual(c()["salvage.engine.effectLost"], 1, "the engine's stop is no effectLost");
  });

  test("ST2 two twins spread over two wrecks (the nearest unclaimed); no wreck -> SEEK, NO_WRECK, follow the host, "
    + "retry after salvageSeekRetryMs", () => {
    const w = world();
    const engine = engineOf(w);
    const a = twin(7001, [11]);
    const b = twin(7002, [21]);
    const ra = runtime(7001);
    const rb = runtime(7002);
    engine.start(ra, { record: ra.record });
    engine.start(rb, { record: rb.record });
    engine.step(ra, { scene: {}, twin: a, host: w.host, nowMs: 1000, record: ra.record });
    engine.step(rb, { scene: {}, twin: b, host: w.host, nowMs: 1000, record: rb.record });
    assert.deepStrictEqual([ra.salvage.wreckId, rb.salvage.wreckId], [W1, W2]);

    const empty = world();
    empty.wrecks.clear();
    const lone = engineOf(empty);
    const c = twin(7003, [31]);
    const rc = runtime(7003);
    lone.start(rc, { record: rc.record });
    lone.step(rc, { scene: {}, twin: c, host: empty.host, nowMs: 1000, record: rc.record });
    assert.deepStrictEqual([rc.sub, rc.lastRefusal, rc.nextActionAtMs], ["SEEK", "NO_WRECK", 11000]);
    assert.deepStrictEqual(empty.log, [["follow", 7003]]);
    lone.step(rc, { scene: {}, twin: c, host: empty.host, nowMs: 5000, record: rc.record });
    assert.strictEqual(empty.log.length, 1, "no new search before the retry");
  });

  test("ST3 host cargo below salvageMinFreeCargoM3 -> FULL (modules off, claim freed, follow), back to SEEK after "
    + "salvageFullRetryMs with room; canRun NO_SALVAGER; stop frees the claim idempotently", () => {
    const w = world();
    const engine = engineOf(w);
    const t = twin(7001, [11]);
    const rt = runtime(7001);
    assert.deepStrictEqual(engine.canRun(twin(7009, []), null, {}), { ok: false, reason: "NO_SALVAGER" });
    assert.deepStrictEqual(engine.canRun(t, null, {}), { ok: true });
    engine.start(rt, { record: rt.record });
    w.near = true;
    const step = (nowMs) => engine.step(rt, { scene: {}, twin: t, host: w.host, nowMs, record: rt.record });
    step(1000);
    step(1500);
    step(2000);
    assert.strictEqual(rt.sub, "SALVAGING");
    w.free = 0.5;
    step(2500);
    assert.deepStrictEqual([rt.sub, rt.nextActionAtMs, engine.stats().claims], ["FULL", 32500, 0]);
    assert.strictEqual(t.activeModuleEffects.size, 0, "modules off");
    assert.deepStrictEqual(w.log[w.log.length - 1], ["follow", 7001]);
    w.free = 50;
    step(10000);
    assert.strictEqual(rt.sub, "FULL", "waits for the retry");
    step(32500);
    assert.strictEqual(rt.sub, "SEEK");
    step(33000);
    assert.deepStrictEqual([rt.sub, engine.stats().claims], ["APPROACH", 1]);
    engine.stop(rt, "ORDER", {});
    engine.stop(rt, "ORDER", {});
    engine.dispose(rt, "RECALL_DONE");
    assert.strictEqual(engine.stats().claims, 0, "claim freed once");
    assert.strictEqual(engine.stats().counters["salvage.full"], 1);
  });

  test("ST4 (pattern): the wreck orbit lost (logi approach to an ally) is ordered again, at the "
    + "earliest followRetuneMs after the last order; steady ORBIT on the wreck = no order; a refused order waits "
    + "salvageSeekRetryMs", () => {
    const w = world();
    const engine = engineOf(w);
    const t = twin(7001, [11]);
    const rt = runtime(7001);
    engine.start(rt, { record: rt.record });
    w.near = true;
    const step = (nowMs) => engine.step(rt, { scene: {}, twin: t, host: w.host, nowMs, record: rt.record });
    const orbits = () => w.log.filter((l) => l[0] === "orbit").length;
    step(1000);
    step(1500);
    step(2000);
    assert.deepStrictEqual([rt.sub, orbits(), t.mode, t.targetEntityID], ["SALVAGING", 1, "ORBIT", W1]);
    t.mode = "FOLLOW";
    t.targetEntityID = 555;
    step(2500);
    assert.strictEqual(orbits(), 1, "not before followRetuneMs after the last order");
    step(3000);
    assert.deepStrictEqual([orbits(), t.mode, t.targetEntityID], [2, "ORBIT", W1], "the orbit ordered again");
    step(4500);
    assert.strictEqual(orbits(), 2, "steady ORBIT on the wreck: no new order");
    t.mode = "STOP";
    w.orbitRefused = true;
    step(5000);
    assert.strictEqual(orbits(), 3);
    step(7000);
    assert.strictEqual(orbits(), 3, "a refused order waits salvageSeekRetryMs");
    w.orbitRefused = false;
    step(15000);
    assert.deepStrictEqual([orbits(), t.mode], [4, "ORBIT"]);
    assert.strictEqual(rt.sub, "SALVAGING");
  });

  test("ST5 a twin without a Salvager but with salvage drones: canRun ok (without "
    + "the drones NO_SALVAGER); SEEK claims a wreck at salvageDroneWorkRangeMeters, LOCK goes to SALVAGING with no lock "
    + "and no module, the twin orbits the wreck", () => {
    const w = world();
    let drones = true;
    const config = { ...CONFIG, salvageDroneWorkRangeMeters: 5000 };
    const engine = createSalvageEngine({ access: w.access, scene: w.scene, config, hookReady: () => true,
      droneSalvage: (_twin, ctx) => drones && Boolean(ctx && ctx.record) });
    const t = twin(7001, []);
    const rt = runtime(7001);
    assert.deepStrictEqual(engine.canRun(t, null, { record: rt.record }), { ok: true });
    drones = false;
    assert.deepStrictEqual(engine.canRun(t, null, { record: rt.record }), { ok: false, reason: "NO_SALVAGER" });
    assert.deepStrictEqual(engineOf(w).canRun(t, null, { record: rt.record }), { ok: false, reason: "NO_SALVAGER" },
      "no droneSalvage dep (flag off) =");
    drones = true;
    const ranges = [];
    const approach = w.scene.approach;
    w.scene.approach = (s, tw, id, rangeM) => {
      ranges.push(rangeM);
      return approach(s, tw, id);
    };
    let locks = 0;
    w.scene.lock = () => {
      locks += 1;
      return { ok: true };
    };
    engine.start(rt, { record: rt.record });
    const step = (nowMs) => engine.step(rt, { scene: {}, twin: t, host: w.host, nowMs, record: rt.record });
    step(1000);
    assert.deepStrictEqual([rt.sub, rt.salvage.wreckId, rt.salvage.claimed, rt.salvage.workRangeM],
      ["APPROACH", W1, true, 5000]);
    step(1500);
    assert.deepStrictEqual(ranges, [4500], "work range - miningRangeBufferMeters");
    w.near = true;
    step(2000);
    step(2500);
    assert.deepStrictEqual([rt.sub, locks, w.log.filter((l) => l[0] === "activate").length, t.targetEntityID],
      ["SALVAGING", 0, 0, W1]);
    w.wrecks.get(W1).done = true;
    step(3000);
    assert.deepStrictEqual([rt.sub, rt.salvage.wreckId], ["APPROACH", W2]);
  });

  test("ST6 () drones only, SALVAGING without progress leaves the wreck: CARGO -> FULL "
    + "NO_TARGET -> SEEK after salvageSeekRetryMs with the wreck skipped (the next wreck); no drone out for "
    + "salvageSeekRetryMs -> SEEK; drones off -> SEEK and NO_SALVAGER; drones working = SALVAGING", () => {
    const run = (progress, drones = () => true) => {
      const w = world();
      w.near = true;
      const engine = createSalvageEngine({ access: w.access, scene: w.scene, config: { ...CONFIG,
        salvageDroneWorkRangeMeters: 5000 }, hookReady: () => true, droneSalvage: (_t, ctx) => drones(ctx),
      droneSalvageProgress: (rt, wreckId) => progress(rt, wreckId) });
      const t = twin(7001, []);
      const rt = runtime(7001);
      engine.start(rt, { record: rt.record });
      const step = (nowMs) => engine.step(rt, { scene: {}, twin: t, host: w.host, nowMs, record: rt.record });
      step(1000);
      step(1500);
      step(2000);
      assert.strictEqual(rt.sub, "SALVAGING");
      return { w, engine, rt, step };
    };
    const working = { able: true, out: 2, done: null };
    let p = working;
    const cargo = run(() => p);
    for (let ms = 2500; ms <= 60000; ms += 5000) cargo.step(ms);
    assert.strictEqual(cargo.rt.sub, "SALVAGING", "drones working: no exit");
    p = { able: true, out: 0, done: "CARGO" };
    cargo.step(61000);
    assert.deepStrictEqual([cargo.rt.sub, cargo.rt.nextActionAtMs, cargo.engine.stats().claims], ["FULL", 91000, 0]);

    let q = { able: true, out: 0, done: "NO_TARGET" };
    const nt = run((_rt, wreckId) => (wreckId === W1 ? q : working));
    nt.step(2500);
    assert.deepStrictEqual([nt.rt.sub, nt.rt.nextActionAtMs, nt.engine.stats().counters["salvage.drones.stalled"]],
      ["SEEK", 12500, 1]);
    nt.step(12500);
    assert.deepStrictEqual([nt.rt.sub, nt.rt.salvage.wreckId], ["APPROACH", W2], "W1 skipped");
    q = working;

    const idle = run(() => ({ able: true, out: 0, done: null }));
    idle.step(5000);
    idle.step(14999);
    assert.strictEqual(idle.rt.sub, "SALVAGING", "within salvageSeekRetryMs");
    idle.step(15000);
    assert.strictEqual(idle.rt.sub, "SEEK", "no salvage drone out for salvageSeekRetryMs");

    let on = true;
    const off = run(() => ({ able: on, out: on ? 2 : 0, done: null }), (ctx) => on && Boolean(ctx && ctx.rt));
    on = false;
    off.step(2500);
    assert.strictEqual(off.rt.sub, "SEEK");
    off.step(3000);
    assert.deepStrictEqual([off.rt.sub, off.rt.lastRefusal], ["SEEK", "NO_SALVAGER"]);
  });
};
