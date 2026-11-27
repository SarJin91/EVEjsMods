"use strict";

const assert = require("node:assert");
const { createWingTasks } = require("../../lib/core/wingTasks");
const { createBurstSidecar, BURST_COUNTER_NAMES } = require("../../lib/core/burstTask");
const { createBurstAccess, BURST_AFFINITY_BASE } = require("../../lib/adapter/burstAccess");

const OWNER = 90000001;
const GID = BURST_AFFINITY_BASE + OWNER;

function setup(resolver = (e) => e.commandBurstAffinityGroupID) {
  const lines = [];
  const access = createBurstAccess({ deps: { collectModifierEntriesForItem: () => [],
    affinityResolver: () => resolver } });
  const sidecar = createBurstSidecar({ access, config: {}, log: { log: (l) => lines.push(l) } });
  const tasks = createWingTasks({ sidecars: [sidecar], clock: { now: () => 0 } });
  const record = (shipItemId, owner = OWNER) => ({ shipItemId, ownerCharacterId: owner, state: "ACTIVE" });
  const twin = (id) => ({ itemID: id, kind: "ship", characterID: 0, pilotCharacterID: OWNER });
  const step = (rec, t, host) => tasks.step(rec, null, { twin: t, host, nowMs: 1, scene: null });
  return { access, sidecar, tasks, record, twin, step, lines };
}

const fields = (e) => [e.commandBurstAffinityExplicit, e.commandBurstAffinityGroupID];

module.exports = ({ test }) => {
  test("BT1 two twins of one owner -> one gid on the host and both twins; dispose of the first keeps the host, of "
    + "the second clears it; a step without host/twin/record or with rt.ending writes nothing; stays FREE", () => {
    const s = setup();
    const host = { itemID: 1000000400, kind: "ship" };
    const [r1, r2] = [s.record(501), s.record(502)];
    const [t1, t2] = [s.twin(4200000000000001), s.twin(4200000000000002)];
    s.tasks.start(r1);
    s.tasks.start(r2);
    assert.deepStrictEqual(s.step(r1, t1, host), { controlsMovement: false });
    s.step(r2, t2, host);
    s.step(r1, t1, host);
    assert.deepStrictEqual([fields(host), fields(t1), fields(t2)], [[true, GID], [true, GID], [true, GID]]);
    let c = s.sidecar.stats().counters;
    assert.deepStrictEqual([c["burst.affinity.stamped"], c["burst.affinity.mismatch"], s.sidecar.stats().owners],
      [3, 0, 1], "host once + 2 twins; the self check passed");

    s.tasks.drop(501, "RECALL_DONE");
    assert.deepStrictEqual(fields(host), [true, GID], "one twin left: the host keeps the group");
    s.tasks.drop(502, "RECALL_DONE");
    assert.deepStrictEqual(fields(host), [undefined, undefined], "last twin gone: host cleared");
    c = s.sidecar.stats().counters;
    assert.deepStrictEqual([c["burst.affinity.cleared"], s.sidecar.stats().owners], [1, 0]);

    const r3 = s.record(503);
    const t3 = s.twin(4200000000000003);
    s.tasks.start(r3);
    s.sidecar.step({}, { twin: t3, host: null, record: r3 });
    s.sidecar.step({ ending: true }, { twin: t3, host, record: r3 });
    s.sidecar.step({}, { twin: t3, host, record: s.record(503, 0) });
    assert.deepStrictEqual([fields(host), fields(t3)], [[undefined, undefined], [undefined, undefined]]);
    assert.ok(Object.keys(s.sidecar.stats().counters).every((n) => BURST_COUNTER_NAMES.includes(n)
      || n === "burst.collect.error"));
  });

  test("BT2 a new host entity (other ship or the same itemID after a dock) clears the old one; a FOREIGN group on "
    + "the host is kept and counted once; /rr on the host counted once per change; a mismatch is counted and logged "
    + "once; clearAll clears every host", () => {
    const s = setup();
    const r1 = s.record(501);
    const t1 = s.twin(4200000000000001);
    s.tasks.start(r1);
    const oldHost = { itemID: 1000000400, kind: "ship" };
    s.step(r1, t1, oldHost);
    const sameIdNewEntity = { itemID: 1000000400, kind: "ship" };
    s.step(r1, t1, sameIdNewEntity);
    assert.deepStrictEqual([fields(oldHost), fields(sameIdNewEntity)], [[undefined, undefined], [true, GID]]);
    const otherShip = { itemID: 1000000410, kind: "ship" };
    s.step(r1, t1, otherShip);
    assert.deepStrictEqual([fields(sameIdNewEntity), fields(otherShip)], [[undefined, undefined], [true, GID]]);
    assert.strictEqual(s.sidecar.stats().counters["burst.affinity.cleared"], 2);

    const foreign = { itemID: 1000000420, kind: "ship", commandBurstAffinityExplicit: true,
      commandBurstAffinityGroupID: 777 };
    s.step(r1, t1, foreign);
    s.step(r1, t1, foreign);
    assert.deepStrictEqual([fields(foreign), fields(t1)], [[true, 777], [true, GID]]);
    let c = s.sidecar.stats().counters;
    assert.deepStrictEqual([c["burst.affinity.foreign"], c["burst.affinity.mismatch"]], [1, 0]);

    const rrHost = { itemID: 1000000430, kind: "ship", remoteRepairBurstAffinityGroupID: 3980000000000001 };
    s.step(r1, t1, rrHost);
    s.step(r1, t1, rrHost);
    delete rrHost.remoteRepairBurstAffinityGroupID;
    s.step(r1, t1, rrHost);
    rrHost.remoteRepairBurstAffinityGroupID = 3980000000000002;
    s.step(r1, t1, rrHost);
    c = s.sidecar.stats().counters;
    assert.strictEqual(c["burst.affinity.rrOverride"], 2, "false -> true twice");
    assert.deepStrictEqual(fields(rrHost), [true, GID], "our explicit field stays under /rr");

    s.sidecar.clearAll();
    assert.deepStrictEqual(fields(rrHost), [undefined, undefined]);
    assert.strictEqual(s.sidecar.stats().owners, 0);
    s.tasks.drop(501, "RESTART");
    assert.strictEqual(s.tasks.stats().counters["task.error"], 0);

    const m = setup(() => 12345);
    const r2 = m.record(502);
    m.tasks.start(r2);
    const host = { itemID: 1000000400, kind: "ship" };
    m.step(r2, m.twin(4200000000000002), host);
    m.step(r2, m.twin(4200000000000002), host);
    assert.strictEqual(m.sidecar.stats().counters["burst.affinity.mismatch"], 1);
    assert.strictEqual(m.lines.filter((l) => l.startsWith("command burst affinity mismatch")).length, 1);
  });

  test("BT3 (command burst) a new signature -> rebuild with the entries [wormhole, alwaysOn, burst] -> "
    + "applyDerived with propNow; the same signature -> no work; \"[]\" -> applyDerived(base), the very object of the "
    + "first step; burstShipStatsEnabled false -> no rebuild", () => {
    const s = shipSetup();
    const r1 = s.record(501);
    const t1 = s.twinOf(4200000000000001);
    const spawnState = t1.passiveDerivedState;
    s.tasks.start(r1, { active: { alwaysOn: [11] } });
    s.tick(1, [[r1, t1]]);
    assert.deepStrictEqual([s.v.passive.length, s.v.applied.length, s.v.dbuff], [0, 0, 0], "fast path, no vendor");

    t1.commandBurstDynamicBuffs = new Map([[11, 1.25]]);
    s.prop.state = { effectName: "moduleBonusMicrowarpdrive" };
    s.tick(2, [[r1, t1]]);
    assert.strictEqual(s.v.passive.length, 1);
    const call = s.v.passive[0];
    assert.deepStrictEqual(call.options.additionalAttributeModifierEntries.map((e) => e.tag), ["wh", "aon", "burst"]);
    assert.deepStrictEqual([call.owner, call.stub.itemID, call.options.activeSelfModifierEffectsByItemID],
      [OWNER, t1.itemID, s.selfEffects]);
    assert.deepStrictEqual(s.aon, [{ ids: [11], owner: OWNER, entity: t1 }]);
    assert.strictEqual(t1.passiveDerivedState.tags.join(","), "wh,aon,burst");
    assert.deepStrictEqual(s.v.prop, [s.prop.state], "AB/MWD on top of the new state (passive -> prop)");
    s.tick(3, [[r1, t1]]);
    assert.deepStrictEqual([s.v.passive.length, s.v.applied.length], [1, 1]);

    t1.commandBurstDynamicBuffs.clear();
    s.prop.state = null;
    s.tick(4, [[r1, t1]]);
    assert.strictEqual(t1.passiveDerivedState, spawnState, "back to the exact spawn state");
    assert.deepStrictEqual([s.v.passive.length, s.v.applied.length, s.v.prop.length], [1, 2, 1]);
    const c = s.sidecar.stats().counters;
    assert.deepStrictEqual([c["burst.rebuild.ok"], c["burst.rebuild.restore"], c["burst.rebuild.error"],
      c["burst.rebuild.deferred"]], [1, 1, 0, 0]);
    assert.ok(c["burst.rebuild.maxMs"] >= 0);

    const off = shipSetup({ burstShipStatsEnabled: false });
    const r2 = off.record(502);
    const t2 = off.twinOf(4200000000000002);
    off.tasks.start(r2);
    t2.commandBurstDynamicBuffs = new Map([[11, 1.25]]);
    off.tick(1, [[r2, t2]]);
    assert.deepStrictEqual([off.v.passive.length, off.v.applied.length, off.v.dbuff], [0, 0, 0]);
    assert.deepStrictEqual(t2.commandBurstAffinityGroupID, GID, "the affinity of still runs");

    const { propNow, createActiveSidecar } = require("../../lib/core/activeTask");
    const st = { effectName: "moduleBonusAfterburner" };
    assert.deepStrictEqual([propNow({ active: { prop: { on: true, state: st } } }),
      propNow({ active: { prop: { on: null, state: st } } }), propNow({ active: null }), propNow(undefined)],
    [st, null, null, null]);
    assert.strictEqual(createActiveSidecar({ access: {}, scene: {}, config: {} }).propNow, propNow);
  });

  test("BT4 (command burst) burstMaxRebuildsPerTick = 1, two twins -> one rebuilt, one deferred, the next tick "
    + "the second; a rebuild error -> burst.rebuild.error, appliedSig kept, retried after activeRetryMs", () => {
    const s = shipSetup({ burstMaxRebuildsPerTick: 1 });
    const [r1, r2] = [s.record(501), s.record(502)];
    const [t1, t2] = [s.twinOf(4200000000000001), s.twinOf(4200000000000002)];
    s.tasks.start(r1);
    s.tasks.start(r2);
    t1.commandBurstDynamicBuffs = new Map([[11, 1.25]]);
    t2.commandBurstDynamicBuffs = new Map([[11, 1.25]]);
    s.tick(1, [[r1, t1], [r2, t2]]);
    let c = s.sidecar.stats().counters;
    assert.deepStrictEqual([c["burst.rebuild.ok"], c["burst.rebuild.deferred"]], [1, 1]);
    assert.ok(Array.isArray(t1.passiveDerivedState.tags) && !Array.isArray(t2.passiveDerivedState.tags));
    s.tick(2, [[r1, t1], [r2, t2]]);
    c = s.sidecar.stats().counters;
    assert.deepStrictEqual([c["burst.rebuild.ok"], c["burst.rebuild.deferred"]], [2, 1]);
    assert.ok(Array.isArray(t2.passiveDerivedState.tags));

    const e = shipSetup({ activeRetryMs: 5000 });
    const r3 = e.record(503);
    const t3 = e.twinOf(4200000000000003);
    e.tasks.start(r3);
    t3.commandBurstDynamicBuffs = new Map([[11, 1.25]]);
    e.v.failBuild = true;
    e.tick(1, [[r3, t3]]);
    assert.strictEqual(e.sidecar.stats().counters["burst.rebuild.error"], 1);
    assert.strictEqual(e.tasks.context(503).burst.appliedSig, "[]", "appliedSig kept");
    e.v.failBuild = false;
    e.sim += 1000;
    e.tick(2, [[r3, t3]]);
    assert.strictEqual(e.v.passive.length, 1);
    e.sim += 5000;
    e.tick(3, [[r3, t3]]);
    const c3 = e.sidecar.stats().counters;
    assert.deepStrictEqual([c3["burst.rebuild.error"], c3["burst.rebuild.ok"], e.tasks.context(503).burst.appliedSig],
      [1, 1, "[[11,1.25]]"]);
  });
};

function shipSetup(cfg = {}) {
  const v = { passive: [], applied: [], prop: [], dbuff: 0, failBuild: false };
  const deps = {
    collectModifierEntriesForItem: (e) => (e.commandBurstDynamicBuffs && e.commandBurstDynamicBuffs.size > 0
      ? [{ tag: "burst" }] : []),
    affinityResolver: () => (e) => e.commandBurstAffinityGroupID,
    buildClientDbuffStateEntries: (e, opts) => {
      v.dbuff += 1;
      return [...e.commandBurstDynamicBuffs.entries()].map(([id, value]) => [id, [value, opts.buildExpiry(99)]]);
    },
    buildPassiveShipResourceState: (owner, stub, options) => {
      v.passive.push({ owner, stub, options });
      if (v.failBuild) throw new Error("boom");
      return { tags: options.additionalAttributeModifierEntries.map((x) => x.tag) };
    },
    applyPassiveResourceStateToEntity: (e, st) => {
      v.applied.push(st);
      e.passiveDerivedState = st;
      return e;
    },
    collectShipAttributeModifierEntriesForSystem: () => [{ tag: "wh" }],
    buildRuntimeShipItemFromEntity: (e) => ({ itemID: e.itemID, typeID: e.typeID }),
    applyPropulsionEffectStateToEntity: (_e, ps) => v.prop.push(ps),
  };
  const access = createBurstAccess({ deps });
  const selfEffects = new Map([[11, [{ effectID: 1 }]]]);
  const aon = [];
  const activeAccess = { alwaysOnInputs: (entity, _stub, owner, ids) => {
    aon.push({ ids, owner, entity });
    return { entries: [{ tag: "aon" }], selfEffects };
  } };
  const prop = { state: null };
  const config = { burstShipStatsEnabled: true, burstMaxRebuildsPerTick: 8, ...cfg };
  const sidecar = createBurstSidecar({ access, config, log: {}, activeAccess: () => activeAccess,
    propNow: () => prop.state, scene: { simNow: () => h.sim } });
  const tasks = createWingTasks({ sidecars: [sidecar], clock: { now: () => 0 } });
  const host = { itemID: 1000000400, kind: "ship" };
  const scene = { movementChangesWait: () => false, captureShipMotion: () => ({}), adoptDerivedShipState() {},
    queueShipMotionChange: () => false, dropPendingShipMotion() {}, broadcastShipPrimeUpdates() {} };
  const h = {
    v, sidecar, tasks, aon, selfEffects, prop, sim: 1000,
    record: (shipItemId) => ({ shipItemId, ownerCharacterId: OWNER, state: "ACTIVE" }),
    twinOf: (id) => ({ itemID: id, typeID: 22544, kind: "ship", characterID: 0, pilotCharacterID: OWNER,
      systemID: 30000142, passiveDerivedState: { spawn: true } }),
    tick: (nowMs, pairs) => {
      for (const [rec, twin] of pairs) tasks.step(rec, null, { twin, host, nowMs, scene });
    },
  };
  return h;
}
