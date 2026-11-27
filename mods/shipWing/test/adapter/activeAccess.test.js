"use strict";

const assert = require("node:assert");
const { createActiveAccess, ACCESS_COUNTER_NAMES } = require("../../lib/adapter/activeAccess");
const { createSceneGuard } = require("../../lib/adapter/sceneGuard");
const { formatStatus, refusalText } = require("../../lib/channels/chat");
const { resolveConfig } = require("../../config");
const { fixtures } = require("../core/wingService.test");
const path = require("node:path");

const MOD_DIR = path.join(__dirname, "..", "..");
const OWNER = 90000001;
const WH_SYSTEM = 31000005;
const ATTR = Object.freeze({
  armorEmDamageResonance: 267, armorExplosiveDamageResonance: 268, armorKineticDamageResonance: 269,
  armorThermalDamageResonance: 270, shieldEmDamageResonance: 271, shieldExplosiveDamageResonance: 272,
  shieldKineticDamageResonance: 273, shieldThermalDamageResonance: 274, emDamageResonance: 113,
  explosiveDamageResonance: 111, kineticDamageResonance: 109, thermalDamageResonance: 110,
  capacitorNeed: 6, duration: 73, speed: 51,
});
const shipMod = (id) => ({ func: "ItemModifier", domain: "shipID", modifiedAttributeID: id });
const EFFECT = Object.freeze({
  hardener: { effectID: 5230, name: "moduleBonusArmorHardener", guid: "effects.ArmorHardener",
    modifierInfo: [shipMod(267)] },
  dc: { effectID: 4928, name: "damageControl", guid: "effects.DamageControl",
    modifierInfo: [shipMod(267), shipMod(271), shipMod(113)] },
  armorRep: { effectID: 27, name: "armorRepair", guid: "effects.ArmorRepair", durationAttributeID: 73,
    dischargeAttributeID: 6 },
  shieldBoost: { effectID: 4, name: "shieldBoosting", guid: "effects.ShieldBoosting", durationAttributeID: 73,
    dischargeAttributeID: 6 },
  rr: { effectID: 592, name: "shipModuleRemoteArmorRepairer", guid: "effects.RemoteArmourRepair" },
  sensor: { effectID: 2670, name: "sensorBoosterActivePercentage", modifierInfo: [shipMod(76)] },
  mwd: { effectID: 6730, name: "moduleBonusMicrowarpdrive" },
  laser: { effectID: 10, name: "targetAttack" },
});
const TYPES = Object.freeze({
  2301: ["hardener", 20, 10000], 2048: ["dc", 0, 10000], 3540: ["armorRep", 160, 4000],
  10836: ["shieldBoost", 80, 4000], 16455: ["rr", 9000, 1000], 1952: ["sensor", 10, 10000],
  35660: ["mwd", 9000, 1000], 3057: ["laser", 30, 5000],
});

function fitModule(itemID, typeID, flagID, extra = {}) {
  return { itemID, typeID, flagID, categoryID: 7, ...extra };
}

function fakeVendor(opts = {}) {
  const v = { calls: [], passive: [], resolve: [], prepare: [], execute: [], capRatio: 0, capConsume: 0, fx: 0,
    broadcastDamage: 0, capacity: opts.capacity || 5000, rechargeMs: opts.rechargeMs || 500000,
    repairStep: opts.repairStep || 0.15 };
  v.deps = {
    resolveDefaultActivationEffect: (typeID) => (TYPES[typeID] ? EFFECT[TYPES[typeID][0]] : null),
    resolveAssistanceDefinition: (er) => (er && er.name === "shipModuleRemoteArmorRepairer"
      ? { family: "remoteArmor" } : null),
    propulsionEffectIds: () => [6731, 6730],
    getAttributeIDByNames: (name) => ATTR[name] || null,
    isModuleOnline: (m) => m.online !== false,
    appendDirectModifierEntries: (dest, attrs, effects, kind) => {
      dest.push({ tag: `mod:${attrs.src}`, kind, effectID: effects[0].effectID });
    },
    buildPassiveShipResourceState: (owner, stub, options) => {
      v.passive.push({ owner, stub, options });
      return { capacitorCapacity: v.capacity, capacitorRechargeRate: v.rechargeMs,
        attributes: { tags: (options.additionalAttributeModifierEntries || []).map((e) => e.tag) } };
    },
    resolveActiveShipModifierSourceAttributes: (entity, ctx, contexts, options) => {
      v.resolve.push({ entity, ctx, contexts, options });
      return { src: ctx.moduleItem.itemID };
    },
    collectEntityWormholeLocationModifierSources: () => ["whLoc"],
    effectRecordSelfModifiesProjectedAttributes: () => false,
    collectShipAttributeModifierEntriesForSystem: (systemID) => (systemID === WH_SYSTEM ? [{ tag: "wh" }] : []),
    buildLiveModuleAttributeMap: (_stub, m) => {
      const t = TYPES[m.typeID] || [null, 0, 0];
      return { [ATTR.capacitorNeed]: t[1], [ATTR.duration]: t[2] };
    },
    prepareLocalCycleActivation: (o) => {
      v.prepare.push({ characterID: o.callbacks.resolveCharacterID(o.entity), shipItem: o.shipItem,
        fitted: o.callbacks.getEntityRuntimeFittedItems(o.entity), chargeItem: o.chargeItem });
      const name = o.effectRecord.name;
      const cycleState = { effectName: name, applicationTiming: name === "shieldBoosting" ? "start" : "end",
        durationMs: TYPES[o.moduleItem.typeID][2] };
      return { matched: true, success: true, cycleState,
        effectStatePatch: { localCycleEffect: true, localCycleResolvedState: cycleState } };
    },
    executeLocalCycle: (o) => {
      const cs = o.effectState.localCycleResolvedState;
      v.execute.push({ activation: o.activation, nowMs: o.nowMs, session: o.session, effectName: cs.effectName });
      if (o.activation && cs.applicationTiming !== "start") return { matched: true, success: true, data: {} };
      const c = o.entity.conditionState;
      const step = (x) => Math.round(x * 100) / 100;
      if (cs.effectName === "armorRepair") c.armorDamage = Math.max(0, step(c.armorDamage - v.repairStep));
      if (cs.effectName === "shieldBoosting") c.shieldCharge = Math.min(1, step(c.shieldCharge + v.repairStep));
      o.callbacks.broadcastDamageStateChange(o.scene, o.entity, o.nowMs);
      return { matched: true, success: true, data: {} };
    },
    buildLocalCycleRuntimeCallbacks: () => ({
      resolveCharacterID: () => -1,
      getEntityCapacitorAmount: () => 0,
      setEntityCapacitorRatio: () => { v.capRatio += 1; },
      consumeEntityCapacitor: () => {
        v.capConsume += 1;
        throw new Error("consumeEntityCapacitor must never run for a twin");
      },
      broadcastDamageStateChange: () => { v.broadcastDamage += 1; },
    }),
    buildRuntimeShipItemFromEntity: (e) => (e && e.kind === "ship" ? { itemID: e.itemID, typeID: e.typeID,
      conditionState: { ...(e.conditionState || {}) } } : null),
    isRuntimeEntityDestroyingOrDestroyed: (e) => e.destroying === true,
  };
  return v;
}

function config(extra = {}) {
  return { ...resolveConfig({ modDir: MOD_DIR, env: { EVEJS_SHIPWING_ENABLED: "1",
    EVEJS_SHIPWING_ACTIVE_MODULES_ENABLED: "1" } }).config, ...extra };
}

function fullFit() {
  return [fitModule(11, 2301, 11), fitModule(12, 2048, 12), fitModule(13, 3540, 13), fitModule(14, 16455, 14),
    fitModule(15, 1952, 15), fitModule(16, 35660, 16), fitModule(27, 3057, 27)];
}

function spec(fit, extra = {}) {
  return { itemID: 4200000000000001, typeID: 24690, groupID: 27, categoryID: 6, itemName: "Twin", ownerID: OWNER,
    pilotCharacterID: OWNER, characterID: 0, fittedItems: fit, skillMap: new Map([[3300, 5]]),
    conditionState: {}, ...extra };
}

module.exports = ({ test }) => {
  test("AA1 plan (fake vendor): hardener + DC = alwaysOn 2, armor rep = localRep 1, RR = remote 1 (not in the "
    + "balance in), sensor booster = unsupported.sensor 1; P0 then P1 = [wormhole..., hardener, DC]; no alwaysOn "
    + "-> passiveResourceState null; refuse + unstable -> CAP_UNSTABLE; no weapon data counted", () => {
    const v = fakeVendor();
    const access = createActiveAccess({ deps: v.deps, config: config() });
    const s = spec(fullFit());
    const out = access.planActive(s, { ownerCharId: OWNER, systemID: WH_SYSTEM, weapons: [{ moduleId: 27 }] });
    assert.strictEqual(out.ok, true, JSON.stringify(out));
    assert.deepStrictEqual(out.plan.classified, { alwaysOn: 2, localRep: 1, remote: 1, prop: 1, weapon: 1,
      unsupported: { sensor: 1 } });
    assert.strictEqual(out.plan.peakGJs, 25);
    assert.deepStrictEqual(out.plan.summary, { cap: "shed", shed: 1, shedTypeIds: [3540], alwaysOn: 2, localRep: 0,
      remote: 1, prop: false });
    assert.deepStrictEqual(out.plan.alwaysOn, [11, 12]);
    assert.strictEqual(v.passive.length, 2);
    assert.deepStrictEqual(v.passive[0].options.additionalAttributeModifierEntries.map((e) => e.tag), ["wh"]);
    assert.deepStrictEqual(out.passiveResourceState.attributes.tags, ["wh", "mod:11", "mod:12"]);
    assert.strictEqual(v.passive[1].owner, OWNER);
    assert.strictEqual(v.passive[1].stub.itemID, s.itemID, "S3E-F12a: stub.itemID = the twin's runtime ID");
    assert.ok(v.passive[1].options.activeSelfModifierEffectsByItemID instanceof Map);
    const r = v.resolve[0];
    assert.deepStrictEqual([r.entity.kind, r.entity.systemID, r.options.additionalLocationModifierSources,
      r.options.overloadEffectRecordsByModuleID instanceof Map, r.options.fittedItems === s.fittedItems,
      r.options.skillMap === s.skillMap, r.contexts.length], ["ship", WH_SYSTEM, ["whLoc"], true, true, true, 2]);
    const c = access.stats().counters;
    assert.deepStrictEqual([c["active.plan.ok"], c["active.cap.shed"], c["active.module.unsupported.sensor"],
      c["active.alwaysOn.applied"], c["active.plan.noWeaponsData"]], [1, 1, 1, 2, 0]);

    const big = createActiveAccess({ deps: fakeVendor({ capacity: 10000 }).deps, config: config() });
    assert.strictEqual(big.planActive(s, { ownerCharId: OWNER, systemID: 0, weapons: [{ moduleId: 27 }] })
      .plan.summary.cap, "stable");
    const noWeapons = createActiveAccess({ deps: fakeVendor().deps, config: config({ activeCapIncludeWeapons: false,
      activeCapStableFactorPct: 200 }) });
    assert.strictEqual(noWeapons.planActive(s, { ownerCharId: OWNER, systemID: 0, weapons: null }).plan.summary.cap,
      "stable");
    assert.strictEqual(noWeapons.stats().counters["active.plan.noWeaponsData"], 1);

    const profiled = (include) => {
      const pv = fakeVendor({ capacity: 10000 });
      const seen = [];
      const orig = pv.deps.buildLiveModuleAttributeMap;
      pv.deps.buildLiveModuleAttributeMap = (stub, m, ...rest) => { seen.push(m.itemID); return orig(stub, m, ...rest); };
      const acc = createActiveAccess({ deps: pv.deps, config: config({ activeCapIncludeWeapons: include }) });
      const res = acc.planActive(s, { ownerCharId: OWNER, systemID: 0, weapons: [{ moduleId: 27 }] });
      assert.strictEqual(res.ok, true, JSON.stringify(res));
      assert.strictEqual(res.plan.classified.weapon, 1);
      return seen.filter((id) => id === 27).length;
    };
    assert.deepStrictEqual([profiled(false), profiled(true)], [0, 1]);

    const rep = createActiveAccess({ deps: fakeVendor({ capacity: 10000 }).deps, config: config() });
    const repOnly = rep.planActive(spec([fitModule(13, 3540, 13)]), { ownerCharId: OWNER, systemID: WH_SYSTEM,
      weapons: [] });
    assert.deepStrictEqual([repOnly.ok, repOnly.passiveResourceState, repOnly.plan.localRep.map((m) => m.layer)],
      [true, null, ["armor"]]);

    const rv = fakeVendor();
    const refuse = createActiveAccess({ deps: rv.deps, config: config({ activeCapUnstablePolicy: "refuse" }) });
    assert.deepStrictEqual(refuse.planActive(s, { ownerCharId: OWNER, systemID: 0, weapons: [] }),
      { ok: false, reason: "CAP_UNSTABLE" });
    assert.deepStrictEqual([rv.passive.length, refuse.stats().counters["active.plan.refused.CAP_UNSTABLE"],
      refuse.stats().counters["active.plan.error"]], [1, 1, 0]);
    const tv = fakeVendor();
    tv.deps.buildPassiveShipResourceState = () => { throw new Error("boom"); };
    const thrown = createActiveAccess({ deps: tv.deps, config: config() });
    assert.deepStrictEqual(thrown.planActive(s, { ownerCharId: OWNER, systemID: 0, weapons: [] }),
      { ok: false, reason: "ERROR" });
    assert.ok(ACCESS_COUNTER_NAMES.every((n) => n.startsWith("active.")));
  });

  test("AA2 launch on the real core: flag off -> spec without passiveResourceState; refuse + unstable ship -> "
    + "CAP_UNSTABLE, no record and no spawn of it, the others start; P1 (wormhole first, then hardeners) in "
    + "the spec, the real derived-state guard skips the twin and the resists stay; rt.launch.active + listWing.active",
  () => {
    const { setup, cleanup, twinOf, CHAR } = fixtures;
    const off = setup();
    try {
      assert.strictEqual(off.svc.orderCopy(CHAR, 501, "launch").ok, true);
      const spawned = off.w.scene.entities.get(twinOf(off, 501)).spec;
      assert.ok(!Object.prototype.hasOwnProperty.call(spawned, "passiveResourceState"));
    } finally {
      cleanup(off.dir);
    }

    const v = fakeVendor();
    const access = createActiveAccess({ deps: v.deps, config: config({ activeCapUnstablePolicy: "refuse" }) });
    const planActive = (s, ctx) => access.planActive(s, { ...ctx, systemID: WH_SYSTEM, weapons: [] });
    const t = setup({ planActive, config: { activeModulesEnabled: true } });
    try {
      const fits = { 501: [fitModule(5011, 2301, 11), fitModule(5012, 2048, 12)],
        502: [fitModule(5021, 3540, 13), fitModule(5022, 3540, 14)], 503: [fitModule(5031, 2048, 12)] };
      t.adapter.readFit = (id) => fits[id];
      t.adapter.spawn = (scene, _systemId, s) => {
        t.w.calls.push(["spawn", s.itemID]);
        const entity = { itemID: s.itemID, kind: "ship", pilotCharacterID: s.pilotCharacterID, spec: s,
          passiveDerivedState: s.passiveResourceState || { attributes: { tags: ["wh"] } } };
        scene.entities.set(s.itemID, entity);
        return { ok: true, entity };
      };
      const results = [501, 502, 503].map((id) => t.svc.orderCopy(CHAR, id, "launch", { commandId: "c" }));
      assert.deepStrictEqual(results.map((r) => r.ok ? r.state : r.reason), ["ACTIVE", "CAP_UNSTABLE", "ACTIVE"]);
      assert.ok(!t.store.get(502), "no record of the refused ship");
      assert.strictEqual(t.w.calls.filter((c) => c[0] === "spawn").length, 2);
      assert.strictEqual(t.svc.stats().counters["orderCopy.refused.CAP_UNSTABLE"], 1);

      const twin = t.w.scene.entities.get(twinOf(t, 501));
      const ids = twin.spec.fittedItems.map((m) => m.itemID);
      const p1 = ["wh", ...ids.map((id) => `mod:${id}`)];
      assert.deepStrictEqual(twin.spec.passiveResourceState.attributes.tags, p1);
      const calls = [];
      class Scene {}
      Object.defineProperty(Scene.prototype, "refreshShipEntityDerivedState", {
        value: function refreshShipEntityDerivedState(entity) {
          calls.push(entity);
          entity.passiveDerivedState = { attributes: { tags: ["carrier hull, no fit"] } };
          return { success: true };
        },
        enumerable: false, writable: true, configurable: true,
      });
      assert.deepStrictEqual(createSceneGuard({ proto: Scene.prototype, wing: t.svc }).install(), { ok: true });
      assert.deepStrictEqual(new Scene().refreshShipEntityDerivedState(twin),
        { success: true, data: { shipWingSkipped: true } });
      assert.deepStrictEqual([calls.length, twin.passiveDerivedState.attributes.tags], [0, p1]);

      assert.deepStrictEqual(t.svc.twinTaskContext(twin).launch.active.alwaysOn, ids);
      const row = t.svc.listWing(CHAR).ships.find((s) => s.shipItemId === 501);
      assert.deepStrictEqual(row.active, { cap: "stable", shed: 0, shedTypeIds: [], alwaysOn: 2, localRep: 0,
        remote: 0, prop: false, shedNames: [] });
      assert.ok(formatStatus(t.svc.listWing(CHAR)).includes(", following, cap stable, always-on 2]"),
        formatStatus(t.svc.listWing(CHAR)));
      assert.strictEqual(refusalText("CAP_UNSTABLE"), "capacitor not stable - launch refused (policy refuse)");
      const dcOnly = t.w.scene.entities.get(twinOf(t, 503));
      assert.deepStrictEqual(dcOnly.spec.passiveResourceState.attributes.tags,
        ["wh", `mod:${dcOnly.spec.fittedItems[0].itemID}`]);
    } finally {
      cleanup(t.dir);
    }
  });

  test("AA3 (command burst) local repair callbacks: with the burst collector "
    + "getEntityRuntimeDirectModifierEntriesForItem(entity, item, now) = collect(twin, item, now); without it [] "
    + "(as before, the collector never called)", () => {
    const burstEntries = [{ modifiedAttributeID: 73, value: -15 }];
    for (const withCollector of [true, false]) {
      const v = fakeVendor();
      const seen = [];
      const prepare = v.deps.prepareLocalCycleActivation;
      v.deps.prepareLocalCycleActivation = (o) => {
        seen.push(o.callbacks.getEntityRuntimeDirectModifierEntriesForItem(o.entity, o.moduleItem, o.nowMs));
        return prepare(o);
      };
      const calls = [];
      const access = createActiveAccess({ deps: v.deps, config: config({ activeFxEnabled: false }),
        collectBurst: withCollector ? (twin, item, now) => {
          calls.push([twin, item.itemID, now]);
          return burstEntries;
        } : undefined });
      const twin = { ...spec(fullFit()), kind: "ship", conditionState: { armorDamage: 0.5 } };
      const scene = { getEntityByID: () => twin };
      const out = access.runLocalCycle(scene, twin, { moduleId: 13, flagId: 13, effectRecord: EFFECT.armorRep },
        OWNER, 7000);
      assert.strictEqual(out.ok, true, JSON.stringify(out));
      if (withCollector) {
        assert.deepStrictEqual([seen, calls], [[burstEntries], [[twin, 13, 7000]]]);
      } else {
        assert.deepStrictEqual([seen, calls], [[[]], []]);
      }
    }
  });

  test("AA4 (command burst) alwaysOnInputs on the running twin (plan.alwaysOn IDs, no stub) gives the "
    + "alwaysOn entries of P1 (P1 = [wormhole, ...these]); unknown IDs skipped; exposed on the access", () => {
    const v = fakeVendor();
    const access = createActiveAccess({ deps: v.deps, config: config() });
    const s = spec(fullFit());
    const out = access.planActive(s, { ownerCharId: OWNER, systemID: WH_SYSTEM, weapons: [{ moduleId: 27 }] });
    assert.strictEqual(out.ok, true, JSON.stringify(out));
    const twin = { ...s, kind: "ship", systemID: WH_SYSTEM };
    const got = access.alwaysOnInputs(twin, null, OWNER, [...out.plan.alwaysOn, 999], twin.skillMap, twin.fittedItems);
    assert.deepStrictEqual(["wh", ...got.entries.map((e) => e.tag)], out.passiveResourceState.attributes.tags);
    assert.ok(got.selfEffects instanceof Map);
    const last = v.resolve[v.resolve.length - 1];
    assert.deepStrictEqual([last.entity, last.options.shipItem.itemID, last.contexts.length], [twin, s.itemID, 2],
      "the twin's hull from buildRuntimeShipItemFromEntity");
  });

  test("AA5 (BUG nos-rr) RR + 2 Nosferatu + hardener, EWAR off: credit 0 -> RR shed, Nos "
    + "unsupported.other 2, no dogma map of a Nos; credit 100 -> +12 GJ/s, RR kept, cap stable, active.cap.nosCredit",
  () => {
    const NOS_TYPE = 12257;
    const POWER_TRANSFER = 90;
    const nosEffect = { effectID: 6197, name: "energyNosferatuFalloff", guid: "effects.EnergyNosferatuFalloff" };
    const run = (creditPct) => {
      const v = fakeVendor();
      const seen = [];
      const resolveEffect = v.deps.resolveDefaultActivationEffect;
      v.deps.resolveDefaultActivationEffect = (typeID) => (typeID === NOS_TYPE ? nosEffect : resolveEffect(typeID));
      const attrId = v.deps.getAttributeIDByNames;
      v.deps.getAttributeIDByNames = (name) => (name === "powerTransferAmount" ? POWER_TRANSFER : attrId(name));
      const attrs = v.deps.buildLiveModuleAttributeMap;
      v.deps.buildLiveModuleAttributeMap = (stub, m, ...rest) => {
        seen.push(m.itemID);
        if (m.typeID === 16455) return { [ATTR.capacitorNeed]: 30, [ATTR.duration]: 1000 };
        if (m.typeID === NOS_TYPE) return { [ATTR.capacitorNeed]: 0, [ATTR.duration]: 5000, [POWER_TRANSFER]: 30 };
        return attrs(stub, m, ...rest);
      };
      const access = createActiveAccess({ deps: v.deps, config: config({ logiEnabled: true,
        activeCapNosCreditPct: creditPct }) });
      const fit = [fitModule(11, 2301, 11), fitModule(14, 16455, 14), fitModule(21, NOS_TYPE, 21),
        fitModule(22, NOS_TYPE, 22)];
      const out = access.planActive(spec(fit), { ownerCharId: OWNER, systemID: 0, weapons: [] });
      assert.strictEqual(out.ok, true, JSON.stringify(out));
      return { out, seen, c: access.stats().counters };
    };
    const off = run(0);
    assert.deepStrictEqual([off.out.plan.remote, off.out.plan.summary.cap, off.out.plan.summary.shedTypeIds,
      off.c["active.module.unsupported.other"], off.c["active.cap.nosCredit"]], [[], "shed", [16455], 2, 0]);
    assert.ok(!Object.prototype.hasOwnProperty.call(off.out.plan.summary, "nosCreditGJs"));
    assert.deepStrictEqual(off.seen.filter((id) => id === 21 || id === 22), [], "credit 0 -> no dogma work for a Nos");
    const on = run(100);
    assert.deepStrictEqual([on.out.plan.remote.length, on.out.plan.summary.cap, on.out.plan.summary.nosCreditGJs,
      on.c["active.cap.nosCredit"], on.c["active.module.unsupported.other"]], [1, "stable", 12, 1, 2]);
    assert.strictEqual(run(50).out.plan.summary.nosCreditGJs, 6);
  });
};

module.exports.fakes = { fakeVendor, config, fitModule, spec, EFFECT, TYPES, OWNER };
