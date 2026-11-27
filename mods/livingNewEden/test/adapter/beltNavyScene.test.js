"use strict";

const assert = require("node:assert");

const { createBeltNavyScene, checkBeltNavySceneFrom, SEAM_METHODS } = require("../../lib/adapter/beltNavyScene");

const SYSTEM = 30001984;
const OTHER = 30001985;

function fakeGame(over = {}) {
  const entity = (id) => ({ itemID: id, position: { x: id, y: 0, z: 0 } });
  const entities = new Map([[1, entity(1)], [2, entity(2)], [700, entity(700)]]);
  const controllers = new Map([[1, { lastAggressorID: 700, lastAggressedAtMs: 5000, manualOrder: { type: "attack", targetID: 700 } }],
    [2, { manualOrder: { type: "orbit", targetID: 700 } }]]);
  const log = [];
  const scene = { getEntityByID: (id) => entities.get(id) || null };
  const runtime = { scenes: new Map([[SYSTEM, scene]]), isSolarSystemSceneLoaded: (id) => id === SYSTEM };
  const npc = {
    issueManualOrder(id, order) {
      log.push(["order", id, order]);
      const controller = controllers.get(id);
      if (!controller) return { success: false, errorMsg: "NPC_NOT_FOUND" };
      controller.manualOrder = order.type === "resume" ? null : { ...order };
      return { success: true, data: controller };
    },
    wakeNpcController(id, whenMs) {
      log.push(["wake", id, whenMs]);
      return { success: true, data: controllers.get(id) };
    },
    getControllerByEntityID: (id) => controllers.get(id) || null,
    ...over.npc,
  };
  const modules = { "space/runtime": { ...over.runtime, ...runtime }, "space/npc/npcService": npc };
  const requireGame = (rel) => (modules[rel] ? { ok: true, exports: modules[rel] } : { ok: false });
  return { requireGame, modules, log, controllers, entities, seam: createBeltNavyScene({ requireGame }) };
}

module.exports = ({ test }) => {
  test("BNC1 readGroup: fields, no scene = ships [], a ship outside the scene is skipped, bad input refused", () => {
    const { seam, entities } = fakeGame();
    assert.deepStrictEqual(seam.readGroup(SYSTEM, [1, 2, 3]), { ok: true, ships: [
      { entityId: 1, position: { x: 1, y: 0, z: 0 }, manualTargetId: 700, aggressorEntityId: 700, aggressedAtMs: 5000 },
      { entityId: 2, position: { x: 2, y: 0, z: 0 }, manualTargetId: 0, aggressorEntityId: 0, aggressedAtMs: 0 },
    ] });
    assert.deepStrictEqual(seam.readGroup(OTHER, [1]), { ok: true, ships: [] }, "a sleeping or unloaded scene");
    entities.set(3, { itemID: 3 });
    assert.deepStrictEqual(seam.readGroup(SYSTEM, [3]), { ok: true, ships: [] }, "no position");
    assert.deepStrictEqual(seam.readGroup(0, [1]), { ok: false, reason: "INVALID_INPUT" });
    assert.deepStrictEqual(seam.readGroup(SYSTEM, ["1"]), { ok: false, reason: "INVALID_INPUT" });
  });

  test("BNC2 orderGroup: attack with no pod kill, resume, wake, per-ship failures, scene guard", () => {
    const { seam, log, controllers } = fakeGame();
    assert.deepStrictEqual(seam.orderGroup(SYSTEM, [{ entityId: 2, targetId: 700 }, { entityId: 1, targetId: 0 }]),
      { ok: true, failed: [] });
    assert.deepStrictEqual(log, [
      ["order", 2, { type: "attack", targetID: 700, allowPodKill: false }], ["wake", 2, 0],
      ["order", 1, { type: "resume" }], ["wake", 1, 0]]);
    assert.strictEqual(controllers.get(1).manualOrder, null);

    log.length = 0;
    assert.deepStrictEqual(seam.orderGroup(OTHER, [{ entityId: 1, targetId: 700 }]), { ok: false, reason: "SCENE_NOT_LOADED" });
    assert.deepStrictEqual(log, [], "no vendor call: wake would load the scene");
    assert.deepStrictEqual(seam.orderGroup(SYSTEM, [{ entityId: 1, targetId: 999 }]),
      { ok: true, failed: [1], detail: "ENTITY_NOT_IN_SCENE" }, "the target is not in this scene");
    assert.deepStrictEqual(log, []);
    controllers.delete(2);
    assert.deepStrictEqual(seam.orderGroup(SYSTEM, [{ entityId: 2, targetId: 0 }, { entityId: 1, targetId: 700 }]),
      { ok: true, failed: [2], detail: "NPC_NOT_FOUND" }, "the next ship still gets its order");
    assert.ok(log.some((l) => l[0] === "wake" && l[1] === 1));
    assert.deepStrictEqual(seam.orderGroup(SYSTEM, [{ entityId: 1, targetId: -1 }]), { ok: false, reason: "INVALID_INPUT" });

    const throwing = fakeGame({ npc: { wakeNpcController() { throw new Error("boom"); } } });
    assert.deepStrictEqual(throwing.seam.orderGroup(SYSTEM, [{ entityId: 1, targetId: 700 }]),
      { ok: true, failed: [1], detail: "boom" });
  });

  test("BNC3 check: every module and function of the seam, a throwing requireGame refuses", () => {
    const { requireGame, modules } = fakeGame();
    assert.deepStrictEqual(checkBeltNavySceneFrom(requireGame), { ok: true });
    delete modules["space/npc/npcService"].wakeNpcController;
    assert.deepStrictEqual(checkBeltNavySceneFrom(requireGame), { ok: false, reason: "SEAM_UNAVAILABLE",
      missing: ["space/npc/npcService.wakeNpcController"] });
    assert.deepStrictEqual(checkBeltNavySceneFrom(() => { throw new Error("boom"); }), { ok: false,
      reason: "SEAM_UNAVAILABLE", missing: ["space/runtime", "space/npc/npcService"] });
    assert.deepStrictEqual(SEAM_METHODS, Object.keys(createBeltNavyScene({ requireGame })));
  });
};
