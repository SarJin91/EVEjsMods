"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { createEwarAccess, EWAR_ACCESS_COUNTER_NAMES, EWAR_KIND } = require("../../lib/adapter/ewarAccess");
const { createActiveAccess, ACCESS_COUNTER_NAMES } = require("../../lib/adapter/activeAccess");
const { decide, SHED_ORDER } = require("../../lib/core/capBalance");
const { fakes } = require("./activeAccess.test");

const WEB = Object.freeze({ effectID: 6426, name: "remoteWebifierFalloff", guid: "effects.ModifyTargetSpeed" });
const NEUT = Object.freeze({ effectID: 6197, name: "energyNeutralizerFalloff", guid: "effects.EnergyDestabilization" });
const NOS = Object.freeze({ effectID: 6197, name: "energyNosferatuFalloff", guid: "effects.EnergyVampire" });
const SCRAM = Object.freeze({ effectID: 6735, name: "warpScrambleBlockMWDWithNPCEffect",
  guid: "effects.WarpScramble" });
const PAINTER = Object.freeze({ effectID: 6425, name: "remoteTargetPaintFalloff", guid: "effects.TargetPaint" });
const FAMILY = Object.freeze({ remotewebifierfalloff: "stasisWebifier", energyneutralizerfalloff: "energyNeutralizer",
  energynosferatufalloff: "energyNosferatu", warpscrambleblockmwdwithnpceffect: "warpScrambler",
  warpdisrupt: "warpDisruptor", remotetargetpaintfalloff: "targetPainter" });
const SYSTEM = 30000142;
const OWNER = 90000001;

function fakeHostileVendor(opts = {}) {
  const v = { resolve: [], execute: [], remove: [], optimal: opts.optimal || 10000, falloff: opts.falloff || 5000,
    durationMs: opts.durationMs || 5000, dist: opts.dist || (() => 1000), locked: new Set(opts.locked || []) };
  const refuse = (errorMsg) => ({ matched: true, success: false, errorMsg });
  const keyOf = (src, es, target) => `${src.itemID}:${es.moduleID}:${target.itemID}`;
  const incoming = (target) => target.incomingEffects || (target.incomingEffects = new Map());
  const definition = (er) => {
    const family = FAMILY[String(er && er.name || "").trim().toLowerCase()];
    return family ? { family } : null;
  };
  v.deps = {
    resolveHostileDefinition: definition,
    resolveHostileModuleActivation(o) {
      v.resolve.push(o);
      const def = definition(o.effectRecord);
      if (!def) return { matched: false };
      if (!o.scene || !o.entity || !o.moduleItem || !o.shipItem) return refuse("UNSUPPORTED_MODULE");
      if (!(o.options.targetID > 0)) return refuse("TARGET_REQUIRED");
      const target = o.callbacks.getEntityByID(o.options.targetID);
      if (!target || target.kind !== "ship") return refuse("TARGET_NOT_FOUND");
      if (o.callbacks.isEntityLockedTarget(o.entity, o.options.targetID) !== true) return refuse("TARGET_NOT_LOCKED");
      if (o.callbacks.getEntitySurfaceDistance(o.entity, target) > v.optimal + v.falloff) {
        return refuse("TARGET_OUT_OF_RANGE");
      }
      return { matched: true, success: true, data: { targetEntity: target, rangeMultiplier: 1,
        runtimeAttrs: { capNeed: 30, durationMs: v.durationMs, durationAttributeID: 73, attributeOverrides: {} },
        effectStatePatch: { hostileModuleEffect: true, hostileFamily: def.family, hostileMaxRangeMeters: v.optimal,
          hostileFalloffMeters: v.falloff, hostileWarpScrambleStrength: def.family === "warpScrambler" ? 2 : 0 } } };
    },
    executeHostileModuleCycle(o) {
      v.execute.push({ session: o.session, nowMs: o.nowMs, targetID: o.effectState.targetID });
      const target = o.callbacks.getEntityByID(o.effectState.targetID);
      if (!target || target.kind !== "ship") return { success: false, errorMsg: "TARGET_NOT_FOUND" };
      if (o.callbacks.isEntityLockedTarget(o.entity, o.effectState.targetID) !== true) {
        return { success: false, errorMsg: "TARGET_NOT_LOCKED" };
      }
      if (o.callbacks.getEntitySurfaceDistance(o.entity, target) > v.optimal + v.falloff) {
        return { success: false, errorMsg: "TARGET_OUT_OF_RANGE", stopReason: "target" };
      }
      const key = keyOf(o.entity, o.effectState, target);
      const had = incoming(target).has(key);
      incoming(target).set(key, { key, family: o.effectState.hostileFamily });
      const family = o.effectState.hostileFamily;
      const appliedAmount = family === "energyNeutralizer" ? 120 : 0;
      return { success: true, data: { targetEntity: target, appliedAmount, aggregateChanged: !had } };
    },
    removeHostileModuleState(o) {
      v.remove.push({ target: o.targetEntity && o.targetEntity.itemID, source: o.sourceEntity && o.sourceEntity.itemID,
        nowMs: o.nowMs });
      if (!o.targetEntity || !o.sourceEntity || !o.effectState) {
        return { success: false, errorMsg: "UNSUPPORTED_MODULE" };
      }
      const key = keyOf(o.sourceEntity, o.effectState, o.targetEntity);
      const removedRecord = incoming(o.targetEntity).get(key) || null;
      incoming(o.targetEntity).delete(key);
      return { success: true, data: { removedRecord, targetEntity: o.targetEntity, aggregateChanged: !!removedRecord } };
    },
    buildHostileModuleRuntimeCallbacks: (scene) => ({
      random: () => 0,
      getEntityByID: (id) => (scene && scene.getEntityByID(id)) || null,
      isEntityLockedTarget: (_src, id) => v.locked.has(Number(id)),
      getEntitySurfaceDistance: (a, b) => v.dist(a, b),
      getEntityCapacitorAmount: () => 0,
      setEntityCapacitorRatio: () => { throw new Error("a twin's EWAR never sets a capacitor in this fake"); },
    }),
    buildRuntimeShipItemFromEntity: (e) => (e && e.kind === "ship" ? { itemID: e.itemID, typeID: e.typeID } : null),
  };
  return v;
}

function ewarScene(entities, systemID = SYSTEM) {
  const s = { systemID, entities, fx: [], refreshed: [], forbidden: [],
    getEntityByID: (id) => entities.get(id) || null,
    refreshShipEntityDerivedState: (entity, options) => { s.refreshed.push([entity.itemID, options]); },
    broadcastSpecialFx: (...args) => s.fx.push(args),
    activateGenericModule: () => { s.forbidden.push("activateGenericModule"); },
    evaluateCrimewatchOffensiveAggression: () => { s.forbidden.push("crimewatch"); },
  };
  return s;
}

function twinOf(itemID, fittedItems) {
  return { itemID, kind: "ship", typeID: 24690, pilotCharacterID: OWNER, characterID: 0, fittedItems,
    skillMap: new Map([[3435, 5]]) };
}

const config = (extra = {}) => ({ ewarRetryMs: 2000, activeFxEnabled: true, ...extra });

module.exports = ({ test }) => {
  test("EA1 startCycle web (fake vendor): resolve with the twin's hull, fit, skills, chargeItem null, "
    + "activeModuleContexts []; effectState with hostileFamily, targetID, durationMs; the first execute at the start "
    + "(session null); aggregateChanged -> one refresh of the target {broadcast, notifyTargeting}; the lock callback "
    + "= rule AND vendor lock; refusals with retryMs; neut moves GJ; no crimewatch, no activateGenericModule", () => {
    const npc = { itemID: 1000000700, kind: "ship" };
    const twin = twinOf(4200000000000001, [{ itemID: 31, typeID: 526, flagID: 19, groupID: 65 },
      { itemID: 32, typeID: 533, flagID: 20 }]);
    const scene = ewarScene(new Map([[twin.itemID, twin], [npc.itemID, npc]]));
    const v = fakeHostileVendor({ locked: [npc.itemID] });
    const access = createEwarAccess({ deps: v.deps, config: config() });
    const allowed = (id) => id === npc.itemID;
    const entry = { moduleId: 31, flagId: 19, typeId: 526, effectRecord: WEB, kind: "web" };

    assert.deepStrictEqual(access.rangeOf(scene, twin, entry, npc.itemID), { ok: true, optimalM: 10000,
      falloffM: 5000 });
    const started = access.startCycle(scene, twin, entry, npc.itemID, 20000, allowed);
    assert.strictEqual(started.ok, true, JSON.stringify(started));
    assert.strictEqual(started.durationMs, 5000);
    const r = v.resolve[v.resolve.length - 1];
    assert.deepStrictEqual([r.entity, r.shipItem.itemID, r.fittedItems, r.skillMap, r.chargeItem,
      r.activeModuleContexts, r.options.targetID, r.moduleItem.itemID],
    [twin, twin.itemID, twin.fittedItems, twin.skillMap, null, [], npc.itemID, 31]);
    assert.deepStrictEqual([r.callbacks.isEntityLockedTarget(twin, npc.itemID),
      r.callbacks.isEntityLockedTarget(npc, npc.itemID), r.callbacks.isEntityLockedTarget(twin, 1000000800)],
    [true, false, false], "the rule, and only for the twin as source");
    const es = started.data.effectState;
    assert.deepStrictEqual([es.moduleID, es.moduleFlagID, es.typeID, es.groupID, es.effectID, es.targetID,
      es.startedAtMs, es.durationMs, es.hostileFamily, es.guid],
    [31, 19, 526, 65, 6426, npc.itemID, 20000, 5000, "stasisWebifier", "effects.ModifyTargetSpeed"]);
    assert.deepStrictEqual([started.data.appliedGJ, started.data.nosIdle], [0, false]);
    assert.deepStrictEqual(v.execute, [{ session: null, nowMs: 20000, targetID: npc.itemID }], "first execute");
    assert.deepStrictEqual(scene.refreshed, [[npc.itemID, { broadcast: true, notifyTargeting: true }]]);
    assert.deepStrictEqual(scene.fx[0].slice(0, 3), [twin.itemID, "effects.ModifyTargetSpeed",
      { moduleID: 31, moduleTypeID: 526, targetID: npc.itemID, start: true, active: false, duration: 5000 }]);
    assert.deepStrictEqual(access.refreshCycle(scene, twin, es, 25000, allowed),
      { ok: true, appliedGJ: 0, nosIdle: false });
    assert.strictEqual(scene.refreshed.length, 1, "refresh only on aggregateChanged");

    assert.deepStrictEqual(access.startCycle(scene, twin, entry, npc.itemID, 1, () => false),
      { ok: false, reason: "TARGET_NOT_LOCKED", retryMs: 2000 });
    v.locked.clear();
    assert.strictEqual(access.startCycle(scene, twin, entry, npc.itemID, 1, allowed).reason, "TARGET_NOT_LOCKED");
    v.locked.add(npc.itemID);
    assert.strictEqual(access.startCycle(scene, twin, entry, 0, 1, allowed).reason, "TARGET_REQUIRED");
    assert.strictEqual(access.startCycle(scene, twin, { ...entry, moduleId: 99, flagId: 99 }, npc.itemID, 1, allowed)
      .reason, "ERROR", "a module the twin does not have");
    const neut = access.startCycle(scene, twin, { moduleId: 32, flagId: 20, typeId: 533, effectRecord: NEUT,
      kind: "neut" }, npc.itemID, 30000, allowed);
    assert.deepStrictEqual([neut.ok, neut.data.appliedGJ, neut.data.nosIdle], [true, 120, false]);
    const nosTwin = twinOf(4200000000000002, [{ itemID: 41, typeID: 530, flagID: 19 }]);
    scene.entities.set(nosTwin.itemID, nosTwin);
    const nos = access.startCycle(scene, nosTwin, { moduleId: 41, flagId: 19, typeId: 530, effectRecord: NOS,
      kind: "nos" }, npc.itemID, 30000, allowed);
    assert.deepStrictEqual([nos.ok, nos.data.appliedGJ, nos.data.nosIdle], [true, 0, true]);
    assert.deepStrictEqual(scene.forbidden, []);
    assert.ok(EWAR_ACCESS_COUNTER_NAMES.every((n) => n.startsWith("ewar.")));
    assert.strictEqual(access.stats().counters["ewar.access.error"], 0);
    const text = fs.readFileSync(path.join(__dirname, "..", "..", "lib", "adapter", "ewarAccess.js"), "utf8")
      .split("\n").filter((l) => !/^\s*(\*|\/\/)/.test(l)).join("\n");
    assert.ok(!/activateGenericModule\(|crimewatch|consumeEntityCapacitor|activeModuleEffects/i.test(text),
      "ewarAccess.js code");
  });

  test("EA2 a range failure in refreshCycle releases the effect (the vendor keeps the record): "
    + "removeHostileModuleState called, the record gone from the target, {ok:false, reason:TARGET_OUT_OF_RANGE}, "
    + "the entry gone from `applied`", () => {
    const npc = { itemID: 1000000700, kind: "ship" };
    const twin = twinOf(4200000000000001, [{ itemID: 31, typeID: 526, flagID: 19 }]);
    const scene = ewarScene(new Map([[twin.itemID, twin], [npc.itemID, npc]]));
    const v = fakeHostileVendor({ locked: [npc.itemID] });
    const access = createEwarAccess({ deps: v.deps, config: config() });
    const allowed = () => true;
    const started = access.startCycle(scene, twin, { moduleId: 31, flagId: 19, typeId: 526, effectRecord: WEB,
      kind: "web" }, npc.itemID, 1000, allowed);
    assert.strictEqual(started.ok, true, JSON.stringify(started));
    assert.strictEqual(npc.incomingEffects.size, 1);
    v.dist = () => 50000;
    assert.deepStrictEqual(access.refreshCycle(scene, twin, started.data.effectState, 6000, allowed),
      { ok: false, reason: "TARGET_OUT_OF_RANGE" });
    assert.deepStrictEqual(v.remove, [{ target: npc.itemID, source: twin.itemID, nowMs: 6000 }]);
    assert.strictEqual(npc.incomingEffects.size, 0, "no web left on the NPC");
    assert.deepStrictEqual(scene.refreshed.map((x) => x[0]), [npc.itemID, npc.itemID], "start and release");
    assert.strictEqual(scene.fx[scene.fx.length - 1][2].start, false, "FX stop");
    scene.entities.delete(twin.itemID);
    assert.deepStrictEqual(access.sweep(scene, 7000), { released: 0 }, "no entry left in `applied`");
    assert.strictEqual(access.stats().counters["ewar.release.ok"], 1);
  });

  test("EA3 release is idempotent; a target gone -> removed false; sweep releases the entry of a twin missing from "
    + "the scene, not the entry of a present twin nor one of another system", () => {
    const npc = { itemID: 1000000700, kind: "ship" };
    const a = twinOf(4200000000000001, [{ itemID: 31, typeID: 447, flagID: 19 }]);
    const b = twinOf(4200000000000002, [{ itemID: 31, typeID: 447, flagID: 19 }]);
    const scene = ewarScene(new Map([[a.itemID, a], [b.itemID, b], [npc.itemID, npc]]));
    const npc2 = { itemID: 1000000900, kind: "ship" };
    const c = twinOf(4200000000000003, [{ itemID: 31, typeID: 447, flagID: 19 }]);
    const other = ewarScene(new Map([[c.itemID, c], [npc2.itemID, npc2]]), SYSTEM + 1);
    const v = fakeHostileVendor({ locked: [npc.itemID, npc2.itemID] });
    const access = createEwarAccess({ deps: v.deps, config: config() });
    const entry = { moduleId: 31, flagId: 19, typeId: 447, effectRecord: SCRAM, kind: "scram" };
    const start = (s, t, target) => access.startCycle(s, t, entry, target, 1000, () => true);
    const sa = start(scene, a, npc.itemID);
    const sb = start(scene, b, npc.itemID);
    const sc = start(other, c, npc2.itemID);
    assert.deepStrictEqual([sa.ok, sb.ok, sc.ok, npc.incomingEffects.size], [true, true, true, 2]);

    assert.deepStrictEqual(access.release(scene, a, a.itemID, sa.data.effectState, 2000), { ok: true, removed: true });
    assert.deepStrictEqual(access.release(scene, a, a.itemID, sa.data.effectState, 2000), { ok: true, removed: false });
    const again = start(scene, a, npc.itemID);
    assert.strictEqual(again.ok, true);

    scene.entities.delete(b.itemID);
    assert.deepStrictEqual(access.sweep(scene, 3000), { released: 1 });
    assert.deepStrictEqual([...npc.incomingEffects.keys()], [`${a.itemID}:31:${npc.itemID}`]);
    assert.strictEqual(npc2.incomingEffects.size, 1, "another system untouched");
    assert.deepStrictEqual(v.remove[v.remove.length - 1], { target: npc.itemID, source: b.itemID, nowMs: 3000 });
    assert.deepStrictEqual(access.sweep(scene, 4000), { released: 0 });

    other.entities.delete(npc2.itemID);
    assert.deepStrictEqual(access.release(other, c, c.itemID, sc.data.effectState, 5000), { ok: true, removed: false });
    const n = access.stats().counters;
    assert.deepStrictEqual([n["ewar.orphan.released"], n["ewar.release.targetGone"], n["ewar.release.error"],
      n["ewar.release.ok"]], [1, 1, 0, 2]);
    v.deps.removeHostileModuleState = () => { throw new Error("boom"); };
    assert.deepStrictEqual(access.release(scene, a, a.itemID, again.data.effectState, 6000),
      { ok: false, reason: "ERROR" });
    assert.strictEqual(access.stats().counters["ewar.release.error"], 1);
  });

  test("EA4 activeAccess with ewarFamilyOf: web + neut + painter -> plan.ewar 2 (with kind), "
    + "unsupported.ewarOther 1, summary/classified ewar, active.ewar.<kind>; without it the plan as today "
    + "(3x unsupported.other); unstable cap -> neut shed before web; capBalance: EWAR second, neut before scram", () => {
    const { fakeVendor, config: activeConfig, fitModule, spec } = fakes;
    const EWAR_TYPES = { 526: [WEB, 30, 5000], 533: [NEUT, 600, 12000], 12709: [PAINTER, 40, 5000] };
    const vendorOf = (opts) => {
      const v = fakeVendor(opts);
      const effect = v.deps.resolveDefaultActivationEffect;
      const attrs = v.deps.buildLiveModuleAttributeMap;
      v.deps.resolveDefaultActivationEffect = (typeID) => (EWAR_TYPES[typeID] ? EWAR_TYPES[typeID][0] : effect(typeID));
      v.deps.buildLiveModuleAttributeMap = (stub, m, ...rest) => (EWAR_TYPES[m.typeID]
        ? { 6: EWAR_TYPES[m.typeID][1], 73: EWAR_TYPES[m.typeID][2] } : attrs(stub, m, ...rest));
      return v;
    };
    const ewar = createEwarAccess({ deps: fakeHostileVendor().deps, config: config() });
    assert.deepStrictEqual([ewar.familyOf(WEB), ewar.familyOf(NEUT), ewar.familyOf(SCRAM), ewar.familyOf(PAINTER),
      ewar.familyOf(fakes.EFFECT.rr), ewar.familyOf(null)], ["web", "neut", "scram", "other", null, null]);
    const fit = [fitModule(21, 526, 19), fitModule(22, 533, 20), fitModule(23, 12709, 21)];
    const ctx = { ownerCharId: fakes.OWNER, systemID: 0, weapons: [] };

    const today = createActiveAccess({ deps: vendorOf().deps, config: activeConfig() });
    assert.deepStrictEqual(today.planActive(spec(fit), ctx), { ok: true, passiveResourceState: null, plan: {
      summary: { cap: "stable", shed: 0, shedTypeIds: [], alwaysOn: 0, localRep: 0, remote: 0, prop: false },
      classified: { alwaysOn: 0, localRep: 0, remote: 0, prop: 0, weapon: 0, unsupported: { other: 3 } },
      peakGJs: 25, drainGJs: 0, alwaysOn: [], localRep: [], remote: [], prop: [] } });
    const tc = today.stats().counters;
    assert.deepStrictEqual([tc["active.module.unsupported.other"], tc["active.module.unsupported.ewarOther"],
      ...EWAR_KIND.map((k) => tc[`active.ewar.${k}`])], [3, 0, 0, 0, 0, 0, 0]);

    const on = createActiveAccess({ deps: vendorOf({ capacity: 30000 }).deps, config: activeConfig(),
      ewarFamilyOf: ewar.familyOf });
    const out = on.planActive(spec(fit), ctx);
    assert.strictEqual(out.ok, true, JSON.stringify(out));
    assert.deepStrictEqual(out.plan.ewar.map((m) => [m.moduleId, m.flagId, m.typeId, m.kind, m.effectRecord.name]),
      [[21, 19, 526, "web", WEB.name], [22, 20, 533, "neut", NEUT.name]]);
    assert.deepStrictEqual([out.plan.summary.ewar, out.plan.summary.cap, out.plan.classified.ewar,
      out.plan.classified.unsupported, out.plan.drainGJs], [2, "stable", 2, { ewarOther: 1 }, 56]);
    const oc = on.stats().counters;
    assert.deepStrictEqual([oc["active.ewar.web"], oc["active.ewar.neut"], oc["active.module.unsupported.ewarOther"],
      oc["active.module.unsupported.other"]], [1, 1, 1, 0]);
    assert.ok(ACCESS_COUNTER_NAMES.includes("active.ewar.disrupt") && ACCESS_COUNTER_NAMES.every((n) =>
      !n.startsWith("ewar.")), "names disjoint from the access ewar.*");

    const shed = createActiveAccess({ deps: vendorOf().deps, config: activeConfig({ activeCapUnstablePolicy: "shed" }),
      ewarFamilyOf: ewar.familyOf }).planActive(spec(fit), ctx);
    assert.deepStrictEqual([shed.plan.summary.cap, shed.plan.summary.shedTypeIds, shed.plan.ewar.map((m) => m.kind),
      shed.plan.summary.ewar], ["shed", [533], ["web"], 1]);

    assert.deepStrictEqual(SHED_ORDER, ["prop", "ewar", "remoteCapacitor", "localRep", "remote", "alwaysOn"]);
    const m = (id, kind, gjs) => ({ id, kind, capNeed: gjs, durationMs: 1000 });
    const d = decide({ capacityGJ: 5000, rechargeMs: 500000, policy: "shed", stableFactorPct: 100,
      modules: [m(1, "localRep", 20), m(2, "ewar", 6), m(3, "ewar", 50)] });
    assert.deepStrictEqual([d.cap, d.shed, [...d.kept]], ["shed", [3, 2], [1]]);
  });
};

module.exports.fakes = { fakeHostileVendor, ewarScene, twinOf, WEB, NEUT, NOS, SCRAM, PAINTER };
