"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const hs = require("../../lib/adapter/huntScene");
const liveProfiles = require("../../lib/adapter/data/liveProfiles");

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const SYSTEM = 30000142;
const HUNT_OPTIONS = { forceImmediateStart: true, broadcastWarpStartToVisibleSessions: true };

function readSource(rel) {
  return fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
}

function methodBody(source, name) {
  const start = source.indexOf(`\n    ${name}(runtime,`);
  assert.ok(start >= 0, `method ${name} not found`);
  return source.slice(start, source.indexOf("\n    },", start));
}

function functionBody(source, name) {
  const start = source.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, `function ${name} not found`);
  return source.slice(start, source.indexOf("\n}", start));
}

function makeVendor(opts) {
  const o = opts || {};
  const calls = [];
  const entities = new Map([[7001, { itemID: 7001, position: { x: 0, y: 0, z: 0 } }],
    [7002, { itemID: 7002, position: { x: 10, y: 0, z: 0 } }]]);
  const scene = { getEntityByID: (id) => entities.get(id) || null };
  if (o.noSceneWarp !== true) {
    scene.warpDynamicEntityToPoint = (entity, point) => {
      calls.push(["warp", entity, point]);
      return o.refuse ? { success: false, errorMsg: o.refuse } : { success: true };
    };
  }
  const runtime = { scenes: new Map([[SYSTEM, scene]]), isSolarSystemSceneLoaded: (id) => id === SYSTEM };
  const npc = {
    setBehaviorOverrides: () => ({ success: true }),
    issueManualOrder: (id, order) => { calls.push(["order", id, order]); return { success: true }; },
    wakeNpcController: (id, ms) => { calls.push(["wake", id, ms]); return { success: true }; },
    getControllerByEntityID: () => null,
  };
  const npcRuntime = {
    warpToPoint: (id, point, options) => { calls.push(["warpToPoint", id, point, options]); return { success: true }; },
  };
  const byPath = { [hs.MODULE_PATHS.runtime]: runtime, [hs.MODULE_PATHS.npc]: npc,
    [hs.MODULE_PATHS.npcRuntime]: npcRuntime, [hs.MODULE_PATHS.worldData]: {} };
  const seam = hs.createHuntScene({ requireGame: (rel) => (byPath[rel] ? { ok: true, exports: byPath[rel] }
    : { ok: false }), data: liveProfiles });
  return { seam, calls, entities };
}

module.exports = ({ test }) => {
  test("HSA1 warpShips align: align order, wake 0, scene warp; a refused or missing scene warp resumes and falls "
    + "back to warpToPoint with the hunt options", () => {
    const point = { x: 1e9, y: 0, z: 0 };
    const v = makeVendor();
    assert.deepStrictEqual(v.seam.warpShips(SYSTEM, [7001], point, { spreadMeters: 0, align: true }),
      { ok: true, warped: 1, failed: [], aligned: 1, fellBack: 0 });
    assert.deepStrictEqual(v.calls, [["order", 7001, { type: "align", direction: { x: 1e9, y: 0, z: 0 } }],
      ["wake", 7001, 0], ["warp", v.entities.get(7001), point]]);

    const near = makeVendor({ refuse: "WARP_DISTANCE_TOO_CLOSE" });
    assert.deepStrictEqual(near.seam.warpShips(SYSTEM, [7002], point, { align: true }),
      { ok: true, warped: 1, failed: [], aligned: 0, fellBack: 1 });
    assert.deepStrictEqual(near.calls.map((c) => c[0]), ["order", "wake", "warp", "order", "warpToPoint"]);
    assert.deepStrictEqual(near.calls[3], ["order", 7002, { type: "resume" }]);
    assert.deepStrictEqual(near.calls[4], ["warpToPoint", 7002, point, HUNT_OPTIONS]);

    const bare = makeVendor({ noSceneWarp: true });
    assert.deepStrictEqual(bare.seam.warpShips(SYSTEM, [7001], point, { align: true }),
      { ok: true, warped: 1, failed: [], aligned: 0, fellBack: 1 });
    assert.deepStrictEqual(bare.calls, [["order", 7001, { type: "resume" }], ["warpToPoint", 7001, point,
      HUNT_OPTIONS]]);
  });

  test("HSA2 warpShips without align stays on warpToPoint with the hunt options; clearAlignOrder resumes first; "
    + "both flags or a non-boolean flag = INVALID_INPUT", () => {
    const point = { x: 5e8, y: 0, z: 0 };
    for (const options of [undefined, {}, { spreadMeters: 2000 }]) {
      const v = makeVendor();
      const r = v.seam.warpShips(SYSTEM, [7001, 7002], point, options);
      assert.deepStrictEqual(r, { ok: true, warped: 2, failed: [] }, JSON.stringify(options));
      assert.deepStrictEqual(v.calls.map((c) => [c[0], c[3]]), [["warpToPoint", HUNT_OPTIONS],
        ["warpToPoint", HUNT_OPTIONS]]);
    }
    const c = makeVendor();
    assert.deepStrictEqual(c.seam.warpShips(SYSTEM, [7001], point, { clearAlignOrder: true }),
      { ok: true, warped: 1, failed: [] });
    assert.deepStrictEqual(c.calls, [["order", 7001, { type: "resume" }], ["warpToPoint", 7001, point,
      HUNT_OPTIONS]]);
    for (const bad of [{ align: true, clearAlignOrder: true }, { align: 1 }, { clearAlignOrder: "yes" }]) {
      assert.deepStrictEqual(makeVendor().seam.warpShips(SYSTEM, [7001], point, bad),
        { ok: false, reason: "INVALID_INPUT" }, JSON.stringify(bad));
    }
  });

  test("HSA3 vendor facts: the sessionless warp ingress ignores forceImmediateStart, the scene warp reads it, "
    + "align is a manual order that ends itself, resume clears the order", () => {
    const warp = readSource("space/destiny/commands/warpCommands.js");
    const ingress = methodBody(warp, "startSessionlessWarpIngress");
    assert.ok(!ingress.includes("forceImmediateStart"), "ingress reads forceImmediateStart now");
    assert.ok(ingress.includes("issueEntityWarpIn(runtime, entity, request)"));
    const dynamic = methodBody(warp, "warpDynamicEntityToPoint");
    assert.ok(dynamic.includes("options.forceImmediateStart === true && !request.nativeGoto"));
    assert.ok(dynamic.includes("return issueWarpOrder(runtime, entity, request,"));
    assert.ok(dynamic.includes("errorMsg: \"WARP_DISTANCE_TOO_CLOSE\","));
    assert.match(readSource("space/runtime/scene/pilotCommands.js"),
      /^warpDynamicEntityToPoint\(entityOrID, point, options = \{\}\) \{$/m);
    const loop = readSource("space/npc/npcBehaviorLoop.js");
    assert.ok(loop.includes("manualOrder.type === \"align\""));
    assert.ok(functionBody(loop, "syncNpcAlign").includes("controller.manualOrder = null;"));
    assert.ok(functionBody(loop, "normalizeManualOrder").includes("normalizedType === \"resume\""));
  });
};
