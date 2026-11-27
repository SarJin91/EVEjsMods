"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const mb = require("../../lib/adapter/miningBeams");
const hs = require("../../lib/adapter/huntScene");
const liveProfiles = require("../../lib/adapter/data/liveProfiles");

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const SYSTEM = 30000142;
const pos = (x) => ({ x, y: 0, z: 0 });

function readSource(rel) {
  return fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
}

function bodyOf(source, start, end) {
  const at = source.indexOf(start);
  assert.ok(at >= 0, `${start} not found`);
  return source.slice(at, source.indexOf(end, at));
}

function rock(itemID, x, beltID, extra) {
  return { kind: "asteroid", itemID, position: pos(x), radius: 1000, beltID, ...(extra || {}) };
}

function makeScene(statics, ships) {
  const fx = [];
  const scene = {
    staticEntities: statics.slice(),
    staticEntitiesByID: new Map(statics.map((e) => [e.itemID, e])),
    getEntityByID: (id) => ships.get(id) || null,
    broadcastSpecialFx: (...args) => {
      fx.push(args);
      return { stamp: 1, deliveredCount: 1 };
    },
  };
  const remove = (id) => {
    scene.staticEntitiesByID.delete(id);
    scene.staticEntities = scene.staticEntities.filter((e) => e.itemID !== id);
  };
  return { scene, fx, remove };
}

const REQ = Object.freeze({ rockRangeMeters: 60000, maxFx: 40 });

module.exports = ({ test }) => {
  test("MB1 rock of the belt group nearest in range, site anchor skipped, vendor start and stop payloads, maxFx cut, "
    + "warp skipped, a removed rock rebuilds the cache", () => {
    const statics = [rock(501, 1000, 40001), rock(502, 500, 40002), rock(503, 3000, 40001),
      rock(504, 100, 40001, { generatedMiningSiteAnchor: true }), { kind: "stargate", itemID: 50001, position: pos(0) },
      rock(505, 200000, 40003)];
    const ships = new Map([[7001, { itemID: 7001, position: pos(0), mode: "STOP" }],
      [7002, { itemID: 7002, position: pos(0), mode: "WARP" }], [7003, { itemID: 7003, position: pos(150000) }]]);
    const { scene, fx, remove } = makeScene(statics, ships);
    const cached = mb.rocksOf(scene);
    assert.deepStrictEqual([cached.all.map((r) => r.itemId), [...cached.byBelt.keys()]],
      [[501, 502, 503, 505], [40001, 40002, 40003]]);

    const r = mb.presentBeams(scene, { ...REQ, start: [{ entityId: 7001, beltId: 40001 },
      { entityId: 7002, beltId: 40001 }, { entityId: 7003, beltId: 40001 }, { entityId: 7009, beltId: null }],
    stop: [{ entityId: 7001, rockId: 499 }, { entityId: 7999, rockId: 499 }] });
    assert.deepStrictEqual(r, { ok: true, started: [{ entityId: 7001, rockId: 501 }], approaching: [], released: [],
      stopped: 1, noRock: [7003], skipped: [7002, 7009], busy: [], fxSent: 2, ordersSent: 0, budgetCut: 0,
      refused: 0 });
    assert.deepStrictEqual(fx[0], [7001, "effects.Mining", { moduleID: 7001, targetID: 499, exactArgs: true,
      isOffensive: false, start: false, active: 0, duration: null, repeat: null, startTime: null, timeFromStart: 0,
      graphicInfo: null, stopAfterTargetRemoved: true }, ships.get(7001)]);
    assert.deepStrictEqual(fx[1], [7001, "effects.Mining", { moduleID: 7001, targetID: 501, exactArgs: true,
      isOffensive: false, start: true, active: 0, duration: 1000, repeat: mb.MINING_REPEAT, startTime: null,
      timeFromStart: 0, graphicInfo: null }, ships.get(7001)]);

    const anyBelt = mb.presentBeams(scene, { ...REQ, start: [{ entityId: 7001, beltId: null }], stop: [] });
    assert.deepStrictEqual(anyBelt.started, [{ entityId: 7001, rockId: 502 }], "no belt = nearest of the scene");
    const cut = mb.presentBeams(scene, { ...REQ, maxFx: 1, start: [{ entityId: 7001, beltId: 40001 }],
      stop: [{ entityId: 7001, rockId: 501 }] });
    assert.deepStrictEqual([cut.stopped, cut.started, cut.fxSent, cut.budgetCut], [1, [], 1, 1]);

    remove(501);
    const after = mb.presentBeams(scene, { ...REQ, start: [{ entityId: 7001, beltId: 40001 }], stop: [] });
    assert.deepStrictEqual(after.started, [{ entityId: 7001, rockId: 503 }], "rebuilt after a removal");
    assert.notStrictEqual(mb.rocksOf(scene), cached);
    scene.staticEntitiesByID.delete(503);
    const stale = mb.presentBeams(scene, { ...REQ, start: [{ entityId: 7001, beltId: 40001 }], stop: [] });
    assert.deepStrictEqual([stale.started, stale.noRock], [[], [7001]], "a rock gone from the index is not targeted");

    assert.deepStrictEqual(mb.presentBeams(scene, { ...REQ, start: [{ entityId: 0 }], stop: [] }),
      { ok: false, reason: "INVALID_INPUT" });
    assert.strictEqual(mb.presentBeams({ getEntityByID: () => null }, { ...REQ, start: [], stop: [] }).reason,
      "FX_UNAVAILABLE");
    const throwing = makeScene(statics, ships).scene;
    throwing.broadcastSpecialFx = () => { throw new Error("boom"); };
    assert.deepStrictEqual(mb.presentBeams(throwing, { ...REQ, start: [{ entityId: 7001, beltId: 40001 }], stop: [] }),
      { ok: false, reason: "FX_FAILED", detail: "boom" });
    assert.deepStrictEqual(mb.presentBeams(makeScene([], ships).scene,
      { ...REQ, start: [{ entityId: 7001, beltId: 40001 }], stop: [] }).noRock, [7001], "a scene without asteroids");

    const runtime = { scenes: new Map([[SYSTEM, scene]]), isSolarSystemSceneLoaded: (id) => id === SYSTEM };
    const seam = hs.createHuntScene({ requireGame: (rel) => (rel === hs.MODULE_PATHS.runtime
      ? { ok: true, exports: runtime } : { ok: false }), data: liveProfiles });
    assert.strictEqual(seam.presentMiningBeams(SYSTEM, { ...REQ, start: [], stop: [] }).ok, true);
    assert.strictEqual(seam.presentMiningBeams(SYSTEM + 1, { ...REQ, start: [], stop: [] }).reason, "SCENE_NOT_LOADED");
  });

  test("MB2 vendor facts: startBeam / stopBeam of airMiningRuntime, beltID of a belt asteroid, "
    + "stopAfterTargetRemoved read by broadcastSpecialFx", () => {
    const air = readSource("services/npe/airMiningRuntime.js");
    const start = bodyOf(air, "function startBeam(", "\n}");
    assert.ok(start.includes("\"effects.Mining\"") && start.includes("exactArgs: true") && start.includes("repeat:"),
      start);
    const stop = bodyOf(air, "function stopBeam(", "\n}");
    assert.ok(stop.includes("\"effects.Mining\"") && stop.includes("stopAfterTargetRemoved: true"), stop);
    assert.ok(readSource("space/asteroids/asteroidService.js").includes("beltID: belt.itemID,"));
    const fxBody = bodyOf(readSource("space/runtime/scene/presentation.js"), "broadcastSpecialFx(shipID", "\n  },");
    assert.ok(fxBody.includes("rawOptions.stopAfterTargetRemoved === true"), fxBody);
  });

  test("MB3 approach: a far miner gets the scripted order and a full-speed follow without a beam, in range = "
    + "release then beam, a refused follow = release and beam, a foreign order or a hit ship = busy, budget shared", () => {
    const statics = [rock(601, 40000, 40001)];
    const ship = (itemID, x, extra) => ({ itemID, position: pos(x), radius: 500, mode: "STOP", ...(extra || {}) });
    const ships = new Map([[8001, ship(8001, 9000)], [8002, ship(8002, 0)], [8003, ship(8003, 0)],
      [8004, ship(8004, 0)]]);
    const { scene, fx } = makeScene(statics, ships);
    const follows = [];
    let followResult = true;
    scene.followShipEntity = (entity, targetId, range, options) => {
      follows.push([entity.itemID, targetId, range, options]);
      if (followResult) Object.assign(entity, { mode: "FOLLOW", targetEntityID: targetId });
      return followResult;
    };
    const controllers = new Map([[8001, { manualOrder: null }], [8002, { manualOrder: null }],
      [8003, { manualOrder: { type: "follow", targetID: 50001 } }], [8004, { manualOrder: null, lastAggressedAtMs: 5 }]]);
    const orders = [];
    const wakes = [];
    const npc = {
      getControllerByEntityID: (id) => controllers.get(id) || null,
      issueManualOrder: (id, order) => {
        orders.push([id, order]);
        controllers.get(id).manualOrder = order.type === "resume" ? null : order;
        return { success: true };
      },
      wakeNpcController: (id, when) => wakes.push([id, when]),
    };
    const motion = mb.motionOf(npc);
    const APPROACH = { startMeters: 10000, followMeters: 7500 };
    const req = (ids, over) => ({ ...REQ, start: ids.map((entityId) => ({ entityId, beltId: 40001 })), stop: [],
      approach: APPROACH, ...(over || {}) });

    const far = mb.presentBeams(scene, req([8001]), motion);
    assert.deepStrictEqual([far.approaching, far.started, far.ordersSent, far.fxSent, fx.length],
      [[{ entityId: 8001, rockId: 601 }], [], 1, 0, 0]);
    assert.deepStrictEqual(orders, [[8001, { type: "scripted", lneApproach: true }]]);
    assert.deepStrictEqual(follows, [[8001, 601, 7500, { speedFraction: 1, queueHistorySafeContract: true,
      suppressFreshAcquireReplay: true }]]);
    const again = mb.presentBeams(scene, req([8001]), motion);
    assert.deepStrictEqual([again.approaching.length, again.ordersSent, follows.length, orders.length], [1, 0, 1, 1],
      "already following the rock = no new order");

    ships.get(8001).position = pos(31000);
    const near = mb.presentBeams(scene, req([8001]), motion);
    assert.deepStrictEqual([near.released, near.started, near.fxSent], [[8001], [{ entityId: 8001, rockId: 601 }], 1]);
    assert.deepStrictEqual([orders[1], wakes], [[8001, { type: "resume" }], [[8001, 0]]], "resume and wake");
    assert.strictEqual(fx[0][2].duration, 9000, "duration = centre distance");

    followResult = false;
    const refused = mb.presentBeams(scene, req([8002]), motion);
    assert.deepStrictEqual([refused.refused, refused.released, refused.started.length, controllers.get(8002).manualOrder],
      [1, [8002], 1, null]);

    const busy = mb.presentBeams(scene, req([8003, 8004]), motion);
    assert.deepStrictEqual([busy.busy, busy.fxSent, controllers.get(8003).manualOrder.type,
      controllers.get(8004).manualOrder], [[8003, 8004], 0, "follow", null]);
    assert.deepStrictEqual(mb.presentBeams(scene, req([], { release: [8003] }), motion).released, [],
      "release leaves an order without the marker");
    assert.strictEqual(controllers.get(8003).manualOrder.type, "follow");

    followResult = true;
    ships.get(8002).mode = "STOP";
    controllers.get(8004).lastAggressedAtMs = 0;
    const cut = mb.presentBeams(scene, req([8002, 8004], { maxFx: 1 }), motion);
    assert.deepStrictEqual([cut.ordersSent, cut.budgetCut], [1, 1]);

    const plain = mb.presentBeams(scene, req([8004], { approach: undefined }), motion);
    const bare = mb.presentBeams(scene, req([8004]), null);
    assert.deepStrictEqual([plain.started, bare.started, plain.ordersSent, bare.ordersSent],
      [[{ entityId: 8004, rockId: 601 }], [{ entityId: 8004, rockId: 601 }], 0, 0], "no approach or no motion = beam");
    assert.strictEqual(mb.presentBeams(scene, req([8004], { approach: { startMeters: 5000, followMeters: 5000 } }),
      motion).reason, "INVALID_INPUT");
    assert.strictEqual(mb.motionOf({ getControllerByEntityID: () => null }), null);
  });

  test("MB4 vendor facts: followShipEntity signature, scripted order skipped by the brain before the target, "
    + "manual order keeps extra fields and resume clears it, follow refused in warp, statics in getEntityByID, "
    + "follow range from the surfaces", () => {
    assert.ok(readSource("space/runtime/scene/pilotCommands.js")
      .includes("followShipEntity(entityOrID, targetEntityID, range = 0, options = {})"));
    const brain = readSource("space/npc/npcBehaviorLoop.js");
    const tick = bodyOf(brain, "function tickControllerBehavior(", "\n}\n");
    const scripted = tick.indexOf("manualOrder.type === \"scripted\"");
    assert.ok(scripted >= 0 && scripted < tick.indexOf("resolveDesiredTarget("), "scripted before the target");
    const normalize = bodyOf(brain, "function normalizeManualOrder(", "\n}\n");
    assert.ok(normalize.includes("...order,") && normalize.includes("normalizedType === \"resume\""), normalize);
    const follow = bodyOf(readSource("space/destiny/commands/subwarpCommands.js"),
      "function isInvalidFollowOrbitTarget(", "\n  }\n");
    assert.ok(follow.includes("entity.mode === \"WARP\""), follow);
    const byId = bodyOf(readSource("space/runtime/scene/dynamicEntities.js"), "getEntityByID(entityID) {", "\n  },");
    assert.ok(byId.includes("this.staticEntitiesByID.get(entityKey)"), byId);
    assert.ok(readSource("space/destiny/simulation/evolve.js")
      .includes("finite(ball.followRange, 0) + finite(ball.radius, 0) + finite(target.radius, 0)"));
  });
};
