"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const hs = require("../../lib/adapter/huntScene");
const ballUpdates = require("../../lib/adapter/ballUpdates");
const liveProfiles = require("../../lib/adapter/data/liveProfiles");

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const SYSTEM = 30000142;
const STAMP = 4321;
const HUNT_OPTIONS = { forceImmediateStart: true, broadcastWarpStartToVisibleSessions: true };

function readSource(rel) {
  return fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
}

function bodyFrom(source, head, end) {
  const start = source.indexOf(head);
  assert.ok(start >= 0, `${head.trim()} not found`);
  return source.slice(start, source.indexOf(end, start));
}

function fakeActions() {
  return {
    buildOnSpecialFXPayload: (entityId, guid, { active = true } = {}) =>
      ["OnSpecialFX", [entityId, null, null, null, null, guid, 0, 1, active ? 1 : 0]],
  };
}

function makeVendor(opts) {
  const o = opts || {};
  const calls = [];
  const entities = new Map([[7001, { itemID: 7001, position: { x: 0, y: 0, z: 0 } }],
    [7002, { itemID: 7002, position: { x: 10, y: 0, z: 0 } }]]);
  const scene = { getEntityByID: (id) => entities.get(id) || null, nextDestinyStamp: STAMP };
  if (o.noQueue !== true) {
    scene.queueBubbleHistory = (updates) => { calls.push(["queue", updates]); return STAMP; };
  }
  if (o.sceneWarp !== undefined) {
    scene.warpDynamicEntityToPoint = (entity) => {
      calls.push(["sceneWarp", entity.itemID]);
      return o.sceneWarp ? { success: true } : { success: false, errorMsg: "WARP_DISTANCE_TOO_CLOSE" };
    };
  }
  const runtime = { scenes: new Map([[SYSTEM, scene]]), isSolarSystemSceneLoaded: (id) => id === SYSTEM };
  const npc = {
    setBehaviorOverrides: () => ({ success: true }),
    issueManualOrder: (id, order) => { calls.push(["order", id, order.type]); return { success: true }; },
    wakeNpcController: () => ({ success: true }),
    getControllerByEntityID: () => null,
  };
  const npcRuntime = {
    warpToPoint: (id, point, options) => {
      calls.push(["warpToPoint", id, options]);
      return o.refuse ? { success: false, errorMsg: o.refuse } : { success: true, queued: true };
    },
  };
  const byPath = { [hs.MODULE_PATHS.runtime]: runtime, [hs.MODULE_PATHS.npc]: npc,
    [hs.MODULE_PATHS.npcRuntime]: npcRuntime, [hs.MODULE_PATHS.worldData]: {} };
  if (o.noActions !== true) byPath[ballUpdates.ACTIONS_PATH] = fakeActions();
  const seam = hs.createHuntScene({ requireGame: (rel) => (byPath[rel] ? { ok: true, exports: byPath[rel] }
    : { ok: false }), data: liveProfiles });
  return { seam, calls };
}

const kinds = (calls) => calls.map((c) => c[0]);
const fxOf = (id) => [{ stamp: STAMP, payload: ["OnSpecialFX", [id, null, null, null, null, "effects.Warping", 0, 1, 0]] }];

module.exports = ({ test }) => {
  test("HWF1 warpFx: an instant warp queues one Warping effect on the ball after warpToPoint; a refused warp or a "
    + "successful aligned warp sends none; align fallback and clearAlignOrder send it", () => {
    const point = { x: 1e9, y: 0, z: 0 };
    const v = makeVendor();
    assert.deepStrictEqual(v.seam.warpShips(SYSTEM, [7001], point, { spreadMeters: 0, warpFx: true }),
      { ok: true, warped: 1, failed: [], warpFx: 1 });
    assert.deepStrictEqual(v.calls, [["warpToPoint", 7001, HUNT_OPTIONS], ["queue", fxOf(7001)]]);

    const refused = makeVendor({ refuse: "WARP_SCRAMBLED" });
    const r = refused.seam.warpShips(SYSTEM, [7001], point, { warpFx: true });
    assert.deepStrictEqual([r.warped, r.failed, r.warpFx], [0, [7001], 0]);
    assert.deepStrictEqual(kinds(refused.calls), ["warpToPoint"]);

    const aligned = makeVendor({ sceneWarp: true });
    assert.deepStrictEqual(aligned.seam.warpShips(SYSTEM, [7001], point, { align: true, warpFx: true }),
      { ok: true, warped: 1, failed: [], aligned: 1, fellBack: 0, warpFx: 0 });
    assert.ok(!kinds(aligned.calls).includes("queue"));

    const fell = makeVendor({ sceneWarp: false });
    assert.deepStrictEqual(fell.seam.warpShips(SYSTEM, [7002], point, { align: true, warpFx: true }),
      { ok: true, warped: 1, failed: [], aligned: 0, fellBack: 1, warpFx: 1 });
    assert.deepStrictEqual(kinds(fell.calls), ["order", "sceneWarp", "order", "warpToPoint", "queue"]);

    const clear = makeVendor();
    assert.deepStrictEqual(clear.seam.warpShips(SYSTEM, [7001], point, { clearAlignOrder: true, warpFx: true }),
      { ok: true, warped: 1, failed: [], warpFx: 1 });
    assert.deepStrictEqual(clear.calls, [["order", 7001, "resume"], ["warpToPoint", 7001, HUNT_OPTIONS],
      ["queue", fxOf(7001)]]);
  });

  test("HWF2 without warpFx nothing is queued and the result shape is unchanged; a non-boolean warpFx is "
    + "INVALID_INPUT; a missing actions module or queueBubbleHistory still warps with warpFx 0", () => {
    const point = { x: 5e8, y: 0, z: 0 };
    for (const options of [undefined, {}, { spreadMeters: 2000 }]) {
      const v = makeVendor();
      assert.deepStrictEqual(v.seam.warpShips(SYSTEM, [7001, 7002], point, options),
        { ok: true, warped: 2, failed: [] }, JSON.stringify(options));
      assert.deepStrictEqual(kinds(v.calls), ["warpToPoint", "warpToPoint"]);
    }
    assert.deepStrictEqual(makeVendor().seam.warpShips(SYSTEM, [7001], point, { warpFx: "yes" }),
      { ok: false, reason: "INVALID_INPUT" });
    for (const opts of [{ noActions: true }, { noQueue: true }]) {
      const v = makeVendor(opts);
      assert.deepStrictEqual(v.seam.warpShips(SYSTEM, [7001], point, { warpFx: true }),
        { ok: true, warped: 1, failed: [], warpFx: 0 }, JSON.stringify(opts));
    }
  });

  test("HWF3 queueWarpingFx: structured refusals for a missing builder, a gone ball and a throwing queue", () => {
    const ok = { ok: true, exports: fakeActions() };
    const scene = { getEntityByID: (id) => (id === 7001 ? { itemID: 7001 } : null), nextDestinyStamp: STAMP,
      queueBubbleHistory: () => null };
    assert.deepStrictEqual(ballUpdates.queueWarpingFx(() => ({ ok: false }), scene, 7001),
      { ok: false, reason: "FX_UNAVAILABLE" });
    assert.deepStrictEqual(ballUpdates.queueWarpingFx(() => ok, scene, 7002), { ok: false, reason: "GONE" });
    assert.deepStrictEqual(ballUpdates.queueWarpingFx(() => ok, scene, 7001), { ok: true, sent: false });
    const boom = { ...scene, queueBubbleHistory: () => { throw new Error("queue broke"); } };
    assert.deepStrictEqual(ballUpdates.queueWarpingFx(() => ok, boom, 7001),
      { ok: false, reason: "FX_FAILED", detail: "queue broke" });
  });

  test("HWF4 vendor facts: the scene warp reads forceImmediateStart before EntityWarpIn, the ingress ends in "
    + "EntityWarpIn, nothing reads visibilitySuppressMs, the warp order sends Warping inactive", () => {
    const warp = readSource("space/destiny/commands/warpCommands.js");
    const dynamic = bodyFrom(warp, "\n    warpDynamicEntityToPoint(runtime,", "\n    },");
    const gate = dynamic.indexOf("options.forceImmediateStart === true && !request.nativeGoto");
    assert.ok(gate >= 0 && dynamic.indexOf("return issueEntityWarpIn(runtime, entity, request", gate) > gate);
    const ingress = bodyFrom(warp, "\n    startSessionlessWarpIngress(runtime,", "\n    },");
    assert.ok(ingress.includes("const result = issueEntityWarpIn(runtime, entity, request);"));
    assert.ok(!warp.includes("visibilitySuppressMs"));
    const order = bodyFrom(warp, "\n  function buildWarpOrderUpdates(", "\n  }\n");
    assert.match(order, /buildOnSpecialFXPayload\(entity\.itemID, "effects\.Warping", \{\s*active: false,\s*\}\)/);
    assert.match(warp, /function sendWarpUpdates\(runtime, entity, updates\) \{\s*runtime\.queueBubbleHistory\(updates\);/);
    assert.match(readSource("space/destiny/stream/actions.js"), /^ {2}buildOnSpecialFXPayload,$/m);
    assert.match(readSource("space/runtime/scene/destinyHistory.js"), /^queueBubbleHistory\(updates, options = \{\}\) \{$/m);
  });
};
