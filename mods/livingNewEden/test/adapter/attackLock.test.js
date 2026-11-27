"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { createHuntScene } = require("../../lib/adapter/huntScene");
const { createBeltNavyScene } = require("../../lib/adapter/beltNavyScene");
const { createNpcSpawn } = require("../../lib/adapter/npcSpawn");
const { attackLockOf, attackLockFields } = require("../../lib/adapter/attackLock");
const liveProfiles = require("../../lib/adapter/data/liveProfiles");
const { resolveConfig } = require("../../config");

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const MOD_DIR = path.resolve(__dirname, "..", "..");
const SYSTEM = 30000142;
const SHIP_A = 7001;
const SHIP_B = 7002;
const TARGET = 1001;

function functionBody(source, name) {
  const start = source.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, `function ${name} not found`);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next === -1 ? undefined : next).replace(/\s+/g, " ");
}

function vendorNormalize(order) {
  if (!order || typeof order !== "object") return null;
  const flag = (v) => (v == null ? null : v === true);
  return { ...order, allowWeapons: flag(order.allowWeapons), keepLock: flag(order.keepLock),
    allowPodKill: flag(order.allowPodKill) };
}

function makeVendor() {
  const controllers = new Map([[SHIP_A, {}], [SHIP_B, {}]]);
  const scene = { getEntityByID: (id) => ([SHIP_A, SHIP_B, TARGET].includes(id) ? { itemID: id } : null) };
  const runtime = { scenes: new Map([[SYSTEM, scene]]), isSolarSystemSceneLoaded: (id) => id === SYSTEM };
  const npc = {
    setBehaviorOverrides: (id) => (controllers.has(id) ? { success: true } : { success: false }),
    issueManualOrder(id, order) {
      const c = controllers.get(id);
      if (!c) return { success: false, errorMsg: "NPC_NOT_FOUND" };
      c.manualOrder = vendorNormalize(order);
      return { success: true, data: c };
    },
    wakeNpcController: (id) => (controllers.has(id) ? { success: true } : { success: false }),
    getControllerByEntityID: (id) => controllers.get(id) || null,
    destroyNpcControllerByEntityID: () => ({ success: true }),
  };
  const modules = { "space/runtime": runtime, "space/npc/npcService": npc };
  const requireGame = (rel) => (modules[rel] ? { ok: true, exports: modules[rel] } : { ok: false });
  const tick = (id) => {
    const order = vendorNormalize(controllers.get(id).manualOrder);
    return { type: order.type, targetID: order.targetID, keepLock: order.keepLock, allowWeapons: order.allowWeapons,
      allowPodKill: order.allowPodKill };
  };
  return { requireGame, tick };
}

const seen = (targetID, lock) => ({ type: "attack", targetID, keepLock: lock, allowWeapons: lock, allowPodKill: false });

const LOCK = () => liveProfiles.ATTACK_LOCK_ORDER;
const OFF = () => null;

module.exports = ({ test }) => {
  test("AL1 vendor facts: normalizeManualOrder maps an absent keepLock / allowWeapons to null, issueManualOrder "
    + "stores it, the tick normalizes again (null -> false), shouldMaintainLock / shouldAllowWeapons honour it", () => {
    const loop = fs.readFileSync(path.join(SERVER_SRC, "space/npc/npcBehaviorLoop.js"), "utf8");
    const normalize = functionBody(loop, "normalizeManualOrder");
    assert.ok(normalize.includes("keepLock: order.keepLock == null ? null : order.keepLock === true"));
    assert.ok(normalize.includes("allowWeapons: order.allowWeapons == null ? null : order.allowWeapons === true"));
    assert.ok(normalize.includes("allowPodKill: order.allowPodKill == null ? null : order.allowPodKill === true"));
    const issue = functionBody(loop, "issueManualOrder");
    assert.ok(issue.includes("const normalizedOrder = normalizeManualOrder(order); controller.manualOrder = "
      + "normalizedOrder;"));
    assert.ok(functionBody(loop, "tickControllerBehavior").includes("normalizeManualOrder(controller.manualOrder)"));
    assert.ok(functionBody(loop, "shouldMaintainLock").includes("if (manualOrder.keepLock !== null) { return "
      + "manualOrder.keepLock === true;"));
    assert.ok(functionBody(loop, "shouldAllowWeapons").includes("if (manualOrder && manualOrder.allowWeapons !== null) "
      + "{ return manualOrder.allowWeapons === true;"));
    assert.deepStrictEqual(vendorNormalize(vendorNormalize({ type: "attack" })).keepLock, null);
    assert.ok(functionBody(loop, "shouldMaintainLock").includes("return ( manualOrder.type === \"attack\" ||"),
      "null keepLock on an attack order = lock");
    assert.deepStrictEqual(liveProfiles.ATTACK_LOCK_ORDER, { keepLock: true, allowWeapons: true });
    assert.ok(Object.isFrozen(liveProfiles.ATTACK_LOCK_ORDER));
  });

  test("AL2 huntScene.attackTargets / beltNavyScene.orderGroup: lock and fire after the tick with the flag, the "
    + "order as before without", () => {
    for (const [lock, want] of [[LOCK, true], [OFF, null], [undefined, null]]) {
      const v = makeVendor();
      const hunt = createHuntScene({ requireGame: v.requireGame, data: liveProfiles, attackLock: lock });
      assert.deepStrictEqual(hunt.attackTargets(SYSTEM, [SHIP_A], [TARGET]), { ok: true, failed: [] });
      assert.deepStrictEqual(v.tick(SHIP_A), seen(TARGET, want));
      const belt = createBeltNavyScene({ requireGame: v.requireGame, attackLock: lock });
      assert.deepStrictEqual(belt.orderGroup(SYSTEM, [{ entityId: SHIP_B, targetId: TARGET }]),
        { ok: true, failed: [] });
      assert.deepStrictEqual(v.tick(SHIP_B), seen(TARGET, want));
    }
  });

  test("AL3 npcSpawn.engage / orderAttack (LIVE battles): lock and fire after the tick with the flag, the order as "
    + "before without", () => {
    const seenLive = (targetID, lock) => ({ ...seen(targetID, lock), allowPodKill: null });
    for (const [lock, want] of [[LOCK, true], [OFF, null], [undefined, null]]) {
      const v = makeVendor();
      const seam = createNpcSpawn({ requireGame: v.requireGame, navyProfiles: {}, data: liveProfiles,
        attackLock: lock });
      assert.deepStrictEqual(seam.engage(SYSTEM, [SHIP_A], [SHIP_B]), { ok: true });
      assert.deepStrictEqual(v.tick(SHIP_A), seenLive(SHIP_B, want));
      assert.deepStrictEqual(v.tick(SHIP_B), seenLive(SHIP_A, want));
      assert.deepStrictEqual(seam.orderAttack(SYSTEM, SHIP_A, TARGET), { ok: true });
      assert.deepStrictEqual(v.tick(SHIP_A), seenLive(TARGET, want));
    }
  });

  test("AL4 attackLockOf: defaults scene on / live off, env overrides, no config off; a throwing getter = as before",
    () => {
      const cfg = (env) => resolveConfig({ modDir: MOD_DIR, env }).config;
      const def = cfg({});
      assert.strictEqual(attackLockOf(def, "scene"), liveProfiles.ATTACK_LOCK_ORDER);
      assert.strictEqual(attackLockOf(def, "live"), null);
      const flipped = cfg({ EVEJS_LNE_MATERIALIZATION_ATTACK_LOCK_ENABLED: "false",
        EVEJS_LNE_MATERIALIZATION_LIVE_BATTLE_ATTACK_LOCK_ENABLED: "true" });
      assert.strictEqual(attackLockOf(flipped, "scene"), null);
      assert.strictEqual(attackLockOf(flipped, "live"), liveProfiles.ATTACK_LOCK_ORDER);
      assert.strictEqual(attackLockOf(undefined, "scene"), null);
      assert.strictEqual(attackLockOf(def, "other"), null);
      assert.deepStrictEqual(attackLockFields(() => { throw new Error("boom"); }), {});
      assert.deepStrictEqual(attackLockFields(LOCK), { keepLock: true, allowWeapons: true });
    });
};
