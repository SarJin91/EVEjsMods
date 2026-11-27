"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const seams = require("../../lib/adapter/highsecTrafficScene");
const mb = require("../../lib/adapter/miningBeams");

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const SYS = 30000144;
const BELT = 40001;

function readSource(rel) {
  return fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
}

function rigOf(opts = {}) {
  const orbits = [];
  const orders = [];
  const wakes = [];
  let orbitResult = true;
  const entities = new Map([[9001, { itemID: 9001, mode: "STOP" }], [9002, { itemID: 9002, mode: "STOP" }],
    [9003, { itemID: 9003, mode: "STOP" }], [BELT, { itemID: BELT, kind: "asteroidBelt" }]]);
  const scene = { getEntityByID: (id) => entities.get(id) || null };
  if (opts.noOrbit !== true) {
    scene.orbitShipEntity = (entity, targetId, meters, options) => {
      orbits.push([entity.itemID, targetId, meters, options]);
      return orbitResult;
    };
  }
  const controllers = new Map([[9001, { manualOrder: null }],
    [9002, { manualOrder: { type: "scripted", lneApproach: true } }], [9003, { manualOrder: null, lastAggressedAtMs: 7 }]]);
  const npc = {
    getControllerByEntityID: (id) => controllers.get(id) || null,
    issueManualOrder: (id, order) => {
      orders.push([id, order]);
      controllers.get(id).manualOrder = order.type === "resume" ? null : order;
      return { success: true };
    },
    wakeNpcController: (id, when) => wakes.push([id, when]),
  };
  const runtime = { scenes: new Map([[SYS, scene]]), isSolarSystemSceneLoaded: (id) => id === SYS };
  const requireGame = (rel) => {
    if (rel === "space/runtime") return { ok: true, exports: runtime };
    if (rel === "space/npc/npcService") return { ok: true, exports: npc };
    return { ok: false };
  };
  const seam = seams.createHighsecTrafficScene({ requireGame, getNpcSpawn: () => null, getHuntScene: () => null });
  return { seam, orbits, orders, wakes, controllers, setOrbit: (v) => { orbitResult = v; } };
}

const OPTS = Object.freeze({ meters: 7500, speedFraction: 0.6 });

module.exports = ({ test }) => {
  test("RP4 patrol orbit: scripted order with the patrol marker and orbitShipEntity around the belt; a foreign order "
    + "= BUSY untouched, a hit ship = AGGRESSED, a refused orbit = release; release keeps the approach marker", () => {
    const r = rigOf();
    assert.deepStrictEqual(r.seam.presentPatrolOrbit(SYS, 9001, BELT, OPTS), { ok: true, orbiting: true });
    assert.deepStrictEqual(r.orders, [[9001, { type: "scripted", lnePatrol: true }]]);
    assert.deepStrictEqual(r.orbits, [[9001, BELT, 7500, { speedFraction: 0.6, queueHistorySafeContract: true,
      suppressFreshAcquireReplay: true }]]);
    assert.deepStrictEqual(r.seam.presentPatrolOrbit(SYS, 9002, BELT, OPTS), { ok: true, orbiting: false,
      reason: "BUSY" });
    assert.deepStrictEqual(r.controllers.get(9002).manualOrder, { type: "scripted", lneApproach: true });
    assert.deepStrictEqual(r.seam.presentPatrolOrbit(SYS, 9003, BELT, OPTS), { ok: true, orbiting: false,
      reason: "AGGRESSED" });
    assert.deepStrictEqual(r.seam.releasePatrolMotion(SYS, 9002), { ok: true, released: false });
    assert.deepStrictEqual(r.controllers.get(9002).manualOrder, { type: "scripted", lneApproach: true });
    assert.deepStrictEqual(r.seam.releasePatrolMotion(SYS, 9001), { ok: true, released: true });
    assert.deepStrictEqual([r.orders[1], r.wakes], [[9001, { type: "resume" }], [[9001, 0]]]);

    r.setOrbit(false);
    assert.deepStrictEqual(r.seam.presentPatrolOrbit(SYS, 9001, BELT, OPTS), { ok: true, orbiting: false,
      reason: "REFUSED" });
    assert.strictEqual(r.controllers.get(9001).manualOrder, null, "refused orbit releases the order");

    assert.deepStrictEqual(r.seam.presentPatrolOrbit(SYS, 9001, BELT, { meters: 0, speedFraction: 0.5 }),
      { ok: false, reason: "INVALID_INPUT" });
    assert.deepStrictEqual(r.seam.presentPatrolOrbit(SYS, 9001, BELT, { meters: 10, speedFraction: 1.5 }),
      { ok: false, reason: "INVALID_INPUT" });
    assert.deepStrictEqual(r.seam.presentPatrolOrbit(SYS + 1, 9001, BELT, OPTS), { ok: false,
      reason: "SCENE_NOT_LOADED" });
    assert.deepStrictEqual(rigOf({ noOrbit: true }).seam.presentPatrolOrbit(SYS, 9001, BELT, OPTS),
      { ok: false, reason: "SEAM_UNAVAILABLE" });

    const plain = mb.motionOf({ getControllerByEntityID: () => ({ manualOrder: { type: "scripted", lnePatrol: true } }),
      issueManualOrder: () => ({ success: true }), wakeNpcController: () => {} });
    assert.deepStrictEqual([plain.ours(1), plain.script(1).reason], [false, "BUSY"],
      "the default marker stays the approach marker");
    assert.deepStrictEqual(mb.APPROACH_ORDER, { type: "scripted", lneApproach: true });
  });

  test("RP5 vendor facts: orbitShipEntity signature in the scene mixin, the orbit command refuses invalid "
    + "follow/orbit targets", () => {
    assert.ok(readSource("space/runtime/scene/pilotCommands.js")
      .includes("orbitShipEntity(entityOrID, targetEntityID, distanceValue = 0, options = {})"));
    const src = readSource("space/destiny/commands/subwarpCommands.js");
    const at = src.indexOf("orbitShipEntity(runtime, entityOrID, targetEntityID, distanceValue = 0, options = {})");
    assert.ok(at >= 0, "orbit command");
    const body = src.slice(at, src.indexOf("queueMovementCommand(", at));
    assert.ok(body.includes("isInvalidFollowOrbitTarget(entity, target)"), body);
  });
};
