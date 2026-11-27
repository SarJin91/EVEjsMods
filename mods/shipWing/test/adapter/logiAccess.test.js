"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { createLogiAccess, LOGI_ACCESS_COUNTER_NAMES } = require("../../lib/adapter/logiAccess");
const { fakes } = require("./activeAccess.test");

const RR = Object.freeze({ effectID: 592, name: "shipModuleRemoteArmorRepairer", guid: "effects.RemoteArmourRepair" });
const RS = Object.freeze({ effectID: 6186, name: "shipModuleRemoteShieldBooster", guid: "effects.ShieldTransfer" });
const FAMILY = Object.freeze({ shipModuleRemoteArmorRepairer: "remoteArmor", shipModuleRemoteShieldBooster:
  "remoteShield" });

function fakeLogiVendor(opts = {}) {
  const v = { resolve: [], execute: [], broadcast: 0, capConsume: 0, optimal: opts.optimal || 6000,
    falloff: opts.falloff || 3000, durationMs: opts.durationMs || 5000, step: opts.step || 0.1,
    dist: opts.dist || (() => 1000) };
  const refuse = (errorMsg) => ({ matched: true, success: false, errorMsg });
  v.deps = {
    resolveAssistanceModuleActivation(o) {
      v.resolve.push(o);
      const family = FAMILY[o.effectRecord && o.effectRecord.name];
      if (!family) return { matched: false };
      if (!o.scene || !o.entity || !o.moduleItem || !o.shipItem) return refuse("UNSUPPORTED_MODULE");
      if (!(o.options.targetID > 0)) return refuse("TARGET_REQUIRED");
      const target = o.scene.getEntityByID(o.options.targetID);
      if (!target || target.kind !== "ship") return refuse("TARGET_NOT_FOUND");
      if (o.callbacks.isEntityLockedTarget(o.entity, o.options.targetID) !== true) return refuse("TARGET_NOT_LOCKED");
      if (o.callbacks.getEntitySurfaceDistance(o.entity, target) > v.optimal + v.falloff) {
        return refuse("TARGET_OUT_OF_RANGE");
      }
      return { matched: true, success: true, data: { targetEntity: target,
        runtimeAttrs: { capNeed: 50, durationMs: v.durationMs, durationAttributeID: 73 },
        effectStatePatch: { assistanceModuleEffect: true, assistanceFamily: family,
          assistanceMaxRangeMeters: v.optimal, assistanceFalloffMeters: v.falloff } } };
    },
    executeAssistanceModuleCycle(o) {
      v.execute.push({ session: o.session, isActivationPass: o.isActivationPass, nowMs: o.nowMs,
        targetID: o.effectState.targetID, moduleID: o.effectState.moduleID });
      const target = o.scene.getEntityByID(o.effectState.targetID);
      if (!target || target.kind !== "ship") return { success: false, errorMsg: "TARGET_NOT_FOUND", stopReason: "target" };
      if (o.callbacks.isEntityLockedTarget(o.entity, o.effectState.targetID) !== true) {
        return { success: false, errorMsg: "TARGET_NOT_LOCKED", stopReason: "target" };
      }
      if (o.callbacks.getEntitySurfaceDistance(o.entity, target) > v.optimal + v.falloff) {
        return { success: false, errorMsg: "TARGET_OUT_OF_RANGE" };
      }
      const cs = target.conditionState || (target.conditionState = {});
      const round = (x) => Math.round(x * 100) / 100;
      if (o.effectState.assistanceFamily === "remoteArmor") cs.armorDamage = Math.max(0, round((cs.armorDamage || 0) - v.step));
      if (o.effectState.assistanceFamily === "remoteShield") cs.shieldCharge = Math.min(1, round((cs.shieldCharge ?? 1) + v.step));
      o.callbacks.broadcastDamageStateChange(o.scene, target, o.nowMs);
      return { success: true, data: { targetEntity: target, appliedAmount: 100 } };
    },
    buildAssistanceModuleRuntimeCallbacks: () => ({
      isEntityLockedTarget: () => { throw new Error("the vendor lock check must be overridden"); },
      getEntityRuntimeModuleItem: () => { throw new Error("overridden: the twin's module is not in the vendor"); },
      getEntityRuntimeLoadedCharge: () => { throw new Error("overridden: no charge"); },
      getEntitySurfaceDistance: (a, b) => v.dist(a, b),
      getEntityCapacitorAmount: () => 0,
      setEntityCapacitorRatio: () => { v.capConsume += 1; },
      consumeEntityCapacitor: () => {
        v.capConsume += 1;
        throw new Error("consumeEntityCapacitor must never run for a twin");
      },
      broadcastDamageStateChange: () => { v.broadcast += 1; },
      persistDynamicEntity: () => {},
    }),
    buildRuntimeShipItemFromEntity: (e) => (e && e.kind === "ship" ? { itemID: e.itemID, typeID: e.typeID } : null),
    canEntitiesInteractLocally: (a, b) => {
      if (opts.scopeThrows === true) throw new Error("vendor scope failure");
      return (Number(a && a.airInstanceID) || 0) === (Number(b && b.airInstanceID) || 0);
    },
  };
  return v;
}

function spyScene(entities) {
  const s = { entities, fx: [], forbidden: [],
    getEntityByID: (id) => entities.get(id) || null,
    broadcastSpecialFx: (...args) => s.fx.push(args),
    activateGenericModule: () => { s.forbidden.push("activateGenericModule"); },
    evaluateCrimewatchOffensiveAggression: () => { s.forbidden.push("crimewatch"); },
  };
  return s;
}

module.exports = ({ test }) => {
  test("LA1 cycle (fake vendor): resolve gets the twin's hull, twin.fittedItems, the twin's skill map "
    + "chargeItem null, activeModuleContexts []; execute at the end with session null and isActivationPass false; "
    + "cycles every durationMs; isEntityLockedTarget = the rule; activateGenericModule and crimewatch never "
    + "called; no capacitor callback; refusals in the closed set", () => {
    const { config } = fakes;
    const v = fakeLogiVendor();
    const access = createLogiAccess({ deps: v.deps, config: config({ logiRetargetMs: 1000 }) });
    const twin = { itemID: 4200000000000001, kind: "ship", typeID: 11987, pilotCharacterID: 90000001, characterID: 0,
      fittedItems: [{ itemID: 21, typeID: 3530, flagID: 19 }], skillMap: new Map([[3416, 5]]) };
    const host = { itemID: 1000000400, kind: "ship", conditionState: { armorDamage: 0.5 } };
    const scene = spyScene(new Map([[twin.itemID, twin], [host.itemID, host]]));
    const entry = { moduleId: 21, flagId: 19, typeId: 3530, effectRecord: RR, family: "remoteArmor" };
    const allowed = (id) => id === host.itemID;

    assert.deepStrictEqual(access.rangeOf(scene, twin, entry, host.itemID, 90000001),
      { ok: true, optimalM: 6000, falloffM: 3000 });
    const started = access.startCycle(scene, twin, entry, host.itemID, 90000001, 20000, allowed);
    assert.strictEqual(started.ok, true, JSON.stringify(started));
    assert.strictEqual(started.durationMs, 5000);
    const r = v.resolve[v.resolve.length - 1];
    assert.deepStrictEqual([r.entity, r.shipItem.itemID, r.fittedItems, r.skillMap, r.chargeItem,
      r.activeModuleContexts, r.options, r.moduleItem.itemID],
    [twin, twin.itemID, twin.fittedItems, twin.skillMap, null, [], { targetID: host.itemID, nowMs: 20000 }, 21]);
    assert.strictEqual(r.callbacks.getEntityRuntimeModuleItem(), null);
    assert.strictEqual(r.callbacks.getEntityRuntimeLoadedCharge(), null);
    assert.deepStrictEqual([r.callbacks.isEntityLockedTarget(twin, host.itemID),
      r.callbacks.isEntityLockedTarget(host, host.itemID), r.callbacks.isEntityLockedTarget(twin, 9000001)],
    [true, false, false], "the rule, and only for the twin as source");
    const es = started.data.effectState;
    assert.deepStrictEqual([es.moduleID, es.moduleFlagID, es.typeID, es.targetID, es.startedAtMs, es.durationMs,
      es.assistanceFamily], [21, 19, 3530, host.itemID, 20000, 5000, "remoteArmor"]);
    assert.deepStrictEqual(scene.fx[0].slice(0, 3), [twin.itemID, "effects.RemoteArmourRepair",
      { moduleID: 21, moduleTypeID: 3530, targetID: host.itemID, start: true, active: false, duration: 5000 }]);

    assert.deepStrictEqual(access.finishCycle(scene, twin, es, 25000, allowed), { ok: true, appliedAmount: 100 });
    assert.deepStrictEqual(v.execute[0], { session: null, isActivationPass: false, nowMs: 25000,
      targetID: host.itemID, moduleID: 21 });
    assert.strictEqual(host.conditionState.armorDamage, 0.4);

    assert.deepStrictEqual(access.startCycle(scene, twin, entry, 0, 90000001, 1, allowed),
      { ok: false, reason: "TARGET_REQUIRED", retryMs: 1000 });
    scene.entities.set(1000000500, { itemID: 1000000500, kind: "ship" });
    assert.strictEqual(access.startCycle(scene, twin, entry, 1000000500, 90000001, 1, allowed).reason,
      "TARGET_NOT_LOCKED");
    assert.strictEqual(access.finishCycle(scene, twin, { ...es, targetID: 1000000500 }, 2, allowed).reason,
      "TARGET_NOT_LOCKED", "the rule holds at the end of a cycle too (S3E-F6 :1650)");
    v.dist = () => 50000;
    assert.strictEqual(access.startCycle(scene, twin, entry, host.itemID, 90000001, 1, allowed).reason,
      "TARGET_OUT_OF_RANGE");
    assert.strictEqual(access.startCycle(scene, twin, { ...entry, moduleId: 99, flagId: 99 }, host.itemID, 90000001,
      1, allowed).reason, "ERROR", "a module the twin does not have");
    assert.deepStrictEqual([scene.forbidden, v.capConsume], [[], 0]);
    assert.deepStrictEqual(access.stats().counters, { "logi.fx.error": 0, "logi.access.error": 0 });
    assert.ok(LOGI_ACCESS_COUNTER_NAMES.every((n) => n.startsWith("logi.")));
    const text = fs.readFileSync(path.join(__dirname, "..", "..", "lib", "adapter", "logiAccess.js"), "utf8")
      .split("\n").filter((l) => !/^\s*(\*|\/\/)/.test(l)).join("\n");
    assert.ok(!/activateGenericModule\(|crimewatch|consumeEntityCapacitor/i.test(text), "logiAccess.js code");
  });

  test("LA2 (command burst) with the burst collector: startCycle gives the vendor "
    + "additionalDirectModifierEntries = collect(twin, module, simMs); rangeOf reads none; without the collector no "
    + "field (as before)", () => {
    const { config } = fakes;
    const twin = { itemID: 4200000000000001, kind: "ship", typeID: 11987, pilotCharacterID: 90000001, characterID: 0,
      fittedItems: [{ itemID: 21, typeID: 3530, flagID: 19 }], skillMap: new Map() };
    const host = { itemID: 1000000400, kind: "ship", conditionState: { armorDamage: 0.5 } };
    const entry = { moduleId: 21, flagId: 19, typeId: 3530, effectRecord: RR, family: "remoteArmor" };
    const allowed = (id) => id === host.itemID;
    const burstEntries = [{ modifiedAttributeID: 73, value: -10 }];
    const calls = [];
    const collectBurst = (t, item, simMs) => {
      calls.push([t, item.itemID, simMs]);
      return burstEntries;
    };
    for (const withCollector of [true, false]) {
      const v = fakeLogiVendor();
      const scene = spyScene(new Map([[twin.itemID, twin], [host.itemID, host]]));
      const access = createLogiAccess({ deps: v.deps, config: config({ logiRetargetMs: 1000 }),
        collectBurst: withCollector ? collectBurst : undefined });
      calls.length = 0;
      assert.strictEqual(access.rangeOf(scene, twin, entry, host.itemID, 90000001).ok, true);
      assert.ok(!Object.prototype.hasOwnProperty.call(v.resolve[0], "additionalDirectModifierEntries"),
        "rangeOf: no burst entries");
      assert.strictEqual(access.startCycle(scene, twin, entry, host.itemID, 90000001, 20000, allowed).ok, true);
      const r = v.resolve[1];
      if (withCollector) {
        assert.strictEqual(r.additionalDirectModifierEntries, burstEntries);
        assert.deepStrictEqual(calls, [[twin, 21, 20000]]);
      } else {
        assert.ok(!Object.prototype.hasOwnProperty.call(r, "additionalDirectModifierEntries"), "regression");
        assert.deepStrictEqual(calls, []);
      }
    }
  });
};

module.exports.fakes = { fakeLogiVendor, spyScene, RR, RS };
