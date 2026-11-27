"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const seams = require("../../lib/adapter/highsecTrafficScene");
const ballUpdates = require("../../lib/adapter/ballUpdates");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const SYS = 30000144;
const STAMP = 777;

function readSource(rel) {
  return fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
}

function bodyFrom(source, head, end) {
  const start = source.indexOf(head);
  assert.ok(start >= 0, `${head.trim()} not found`);
  return source.slice(start, source.indexOf(end, start));
}

function fakeGameScene(opts) {
  const o = opts || {};
  const log = [];
  const shots = [];
  const entities = new Map([[50001, { itemID: 50001, kind: "stargate" }]]);
  const scene = {
    getEntityByID: (id) => entities.get(id) || null,
    nextDestinyStamp: STAMP,
    queueBubbleHistory: (updates) => {
      log.push(["queue", updates]);
      return STAMP;
    },
    broadcastSpecialFx: (shipId, guid) => {
      log.push(["fx", shipId, guid]);
      return { stamp: STAMP, deliveredCount: 1 };
    },
    sessions: new Map(),
  };
  const runtime = { scenes: new Map([[SYS, scene]]), isSolarSystemSceneLoaded: (id) => id === SYS };
  let nextId = 9000;
  const spawn = {
    pickGridAnchor: () => ({ ok: true, anchorDescriptor: { kind: "entity", itemID: 50001 }, radiusMeters: 0 }),
    spawnShip: (_sys, options) => {
      shots.push(options);
      nextId += 1;
      entities.set(nextId, { itemID: nextId, kind: "ship" });
      return { ok: true, entityId: nextId };
    },
    publish: (_sys, ids) => {
      log.push(["publish", ...ids]);
      return { ok: true, published: ids.length };
    },
    despawn: (_sys, ids) => {
      for (const id of ids) entities.delete(id);
      return { ok: true };
    },
  };
  const actions = { buildSetBallRotationPayload: (id, r) => ["SetBallRotation", [id, r.x, r.y, r.z, r.w]] };
  const byPath = { "space/runtime": runtime };
  if (o.noActions !== true) byPath[ballUpdates.ACTIONS_PATH] = actions;
  const requireGame = (rel) => (byPath[rel] ? { ok: true, exports: byPath[rel] } : { ok: false });
  const seam = seams.createHighsecTrafficScene({ requireGame, getNpcSpawn: () => spawn, getHuntScene: () => null });
  return { seam, log, shots };
}

module.exports = ({ test }) => {
  test("GAP2 adapter: a posed gate spawn stands still with the given pose, one SetBallRotation follows the publish "
    + "before the JumpIn, rotate false sends none, a station spawn refuses the pose, no builder keeps the pose", () => {
    const yaw = Math.PI / 6;
    const pose = { position: { x: 8000, y: 0, z: 0 }, direction: { x: Math.sin(yaw), y: 0, z: Math.cos(yaw) },
      rotate: true };
    const spec = { profileId: "p", gateId: 50001, spawnOffsetMeters: 3000, jumpInMs: 5000, arrivalPose: pose };
    const g = fakeGameScene();
    assert.deepStrictEqual(g.seam.spawnCivilian(SYS, spec),
      { ok: true, entityId: 9001, jumpIn: true, posed: true, rotated: true });
    assert.deepStrictEqual(g.shots[0].spawnState, { position: pose.position, direction: pose.direction,
      targetPoint: pose.position, mode: "STOP", speedFraction: 0 });
    assert.deepStrictEqual(g.log.map((e) => e[0]), ["publish", "queue", "fx"]);
    const [x, y, z, w] = g.log[1][1][0].payload[1].slice(1);
    assert.deepStrictEqual(g.log[1][1][0].payload.slice(0, 1), ["SetBallRotation"]);
    assert.strictEqual(g.log[1][1][0].payload[1][0], 9001);
    assert.strictEqual(g.log[1][1][0].stamp, STAMP);
    assert.ok(x === 0 && z === 0 && Math.abs(y - Math.sin(yaw / 2)) < 1e-12 && Math.abs(w - Math.cos(yaw / 2)) < 1e-12);

    const still = fakeGameScene();
    assert.deepStrictEqual(still.seam.spawnCivilian(SYS, { ...spec, arrivalPose: { ...pose, rotate: false } }),
      { ok: true, entityId: 9001, jumpIn: true, posed: true, rotated: false });
    assert.deepStrictEqual(still.log.map((e) => e[0]), ["publish", "fx"]);

    const plain = fakeGameScene();
    const { arrivalPose, ...bare } = spec;
    assert.deepStrictEqual(plain.seam.spawnCivilian(SYS, bare), { ok: true, entityId: 9001, jumpIn: true });
    assert.ok(!("spawnState" in plain.shots[0]), "no pose = vendor offset spawn");

    const bad = fakeGameScene();
    const station = { profileId: "p", stationId: 60001, spawnOffsetMeters: 0, arrivalPose: pose };
    assert.strictEqual(bad.seam.spawnCivilian(SYS, station).reason, "INVALID_INPUT");
    assert.strictEqual(bad.seam.spawnCivilian(SYS, { ...station, undock: true, undockRunMeters: 100 }).reason,
      "INVALID_INPUT");
    assert.strictEqual(bad.seam.spawnCivilian(SYS, { ...spec, arrivalPose: { ...pose, direction: { x: 0, y: 0, z: 0 } } })
      .reason, "INVALID_INPUT");
    assert.strictEqual(bad.seam.spawnCivilian(SYS, { ...spec, arrivalPose: { ...pose, rotate: 1 } }).reason,
      "INVALID_INPUT");
    assert.deepStrictEqual(bad.shots, []);

    const none = fakeGameScene({ noActions: true });
    assert.deepStrictEqual(none.seam.spawnCivilian(SYS, { ...spec, jumpInMs: undefined }),
      { ok: true, entityId: 9001, posed: true, rotated: false });
    assert.deepStrictEqual(ballUpdates.queueRotation(() => ({ ok: false }), {}, 9001, pose.direction),
      { ok: false, reason: "FX_UNAVAILABLE" });
    assert.deepStrictEqual(ballUpdates.queueRotation(() => ({ ok: false }), {}, 9001, { x: 0, y: 1, z: 0 }),
      { ok: false, reason: "INVALID_INPUT" });
  });

  test("GAP4 vendor facts: SetBallRotation builder and payload name, explicit spawn state reads direction and mode, "
    + "only GOTO gets a heading at first sight, probe entry for the rotation builder", () => {
    const actions = readSource("space/destiny/stream/actions.js");
    const builder = bodyFrom(actions, "function buildSetBallRotationPayload(entityID, rotation)", "\n}\n");
    assert.match(builder, /"SetBallRotation",\s*\[normalizeActionEntityID\(entityID\), vector\.x, vector\.y, vector\.z, vector\.w\]/);
    assert.match(actions, /module\.exports = \{[\s\S]*\n {2}buildSetBallRotationPayload,/);
    assert.ok(readSource("space/destiny/protocol/payloads.js").includes("\"SetBallRotation\""));
    const anchors = bodyFrom(readSource("space/npc/npcAnchors.js"), "function buildSpawnStateForDefinition", "\n}\n");
    assert.ok(anchors.includes("explicitSpawnState.direction"));
    assert.ok(anchors.includes("String(explicitSpawnState.mode || \"STOP\")"));
    const mode = readSource("space/destiny/presentation/mode.js");
    const sw = bodyFrom(mode, "switch (entity.mode) {", "\n  }\n");
    assert.match(sw, /case "GOTO":\s*updates\.push\(\{\s*stamp: modeStamp,\s*payload: destiny\.buildGotoDirectionPayload/);
    assert.ok(!sw.includes("case \"STOP\""), "STOP gets no heading");
    const entry = GAME_MODULES.find((m) => m.path === "space/destiny/stream/actions");
    assert.ok(entry && entry.symbols.some((s) => s.name === "buildSetBallRotationPayload" && s.kind === "export"));
  });
};
