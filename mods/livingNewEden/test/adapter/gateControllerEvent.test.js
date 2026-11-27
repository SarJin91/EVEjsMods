"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const fx = require("../../lib/adapter/gateJumpFx");
const bountyScene = require("../../lib/adapter/bountyScene");
const dormancyGuard = require("../../lib/adapter/dormancyGuard");

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const GATE = 50000010;
const SHIP = 9100000001;

function readSource(rel) {
  return fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
}

function fakeScene(sessionResults) {
  const queued = [];
  const entities = new Map([[GATE, { itemID: GATE, kind: "stargate" }], [40000001, { itemID: 40000001,
    kind: "planet" }], [SHIP, { itemID: SHIP, kind: "ship" }]]);
  const sessions = new Map(sessionResults.map((r, i) => [i + 1, { clientID: i + 1, result: r }]));
  const scene = {
    sessions,
    getEntityByID: (id) => entities.get(id) || null,
    queueCharacterHistory(session, updates) {
      if (session.result === "throw") throw new Error("history boom");
      queued.push([session.clientID, updates]);
      return session.result;
    },
  };
  return { scene, queued, entities };
}

module.exports = ({ test }) => {
  test("GCE1 broadcastGateEvent: three-argument payload to every scene session, null stamp not counted, "
    + "NO_GATE / GONE / FX_UNAVAILABLE / INVALID_INPUT / FX_FAILED", () => {
    const f = fakeScene([7, null]);
    assert.deepStrictEqual(fx.broadcastGateEvent(f.scene, GATE, SHIP, fx.GATE_EVENT.ARRIVAL),
      { ok: true, sent: true, queued: 1 });
    const payload = ["OnClientControllerEvent", [GATE, SHIP, "Arrival"]];
    assert.deepStrictEqual(f.queued, [[1, [payload]], [2, [payload]]]);
    assert.strictEqual(fx.CONTROLLER_EVENT, "OnClientControllerEvent");
    assert.deepStrictEqual(fx.GATE_EVENT, { ARRIVAL: "Arrival", DEPARTURE: "Departure" });
    assert.deepStrictEqual(fx.broadcastGateEvent(fakeScene([null]).scene, GATE, SHIP, "Departure"),
      { ok: true, sent: false, queued: 0 });
    assert.deepStrictEqual(fx.broadcastGateEvent(f.scene, 40000001, SHIP, "Arrival"), { ok: false, reason: "NO_GATE" });
    assert.deepStrictEqual(fx.broadcastGateEvent(f.scene, GATE, SHIP + 1, "Arrival"), { ok: false, reason: "GONE" });
    const noHistory = { ...f.scene, queueCharacterHistory: undefined };
    assert.strictEqual(fx.broadcastGateEvent(noHistory, GATE, SHIP, "Arrival").reason, "FX_UNAVAILABLE");
    assert.strictEqual(fx.broadcastGateEvent({ ...f.scene, sessions: {} }, GATE, SHIP, "Arrival").reason,
      "FX_UNAVAILABLE");
    for (const [g, s, e] of [[GATE, SHIP, "arrival"], [0, SHIP, "Arrival"], [GATE, 1.5, "Departure"]]) {
      assert.strictEqual(fx.broadcastGateEvent(f.scene, g, s, e).reason, "INVALID_INPUT", `${g} ${s} ${e}`);
    }
    const boom = fx.broadcastGateEvent(fakeScene([1, "throw"]).scene, GATE, SHIP, "Arrival");
    assert.deepStrictEqual([boom.ok, boom.reason, boom.detail], [false, "FX_FAILED", "history boom"]);
  });

  test("GCE2 vendor facts: stargate controller payload over scene.sessions, queueCharacterHistory signature, "
    + "bare payload accepted, Departure before detachSession", () => {
    const jump = readSource("space/runtime/spaceRuntime/stargateJump.js");
    assert.ok(jump.includes("const payload = [\"OnClientControllerEvent\", [Number(gateEntity.itemID), "
      + "Number(shipID), String(eventName)]];"), "payload");
    assert.ok(jump.includes("for (const other of scene.sessions instanceof Map ? scene.sessions.values() : [])"));
    assert.ok(jump.includes("if (scene.queueCharacterHistory(other, [payload]) !== null) {"), "null = not queued");
    assert.ok(jump.includes("gateEntity.kind !== \"stargate\""), "gate kind");
    const history = readSource("space/runtime/scene/destinyHistory.js");
    assert.ok(history.includes("\nqueueCharacterHistory(session, updates, options = {}) {"), "signature");
    const pay = history.slice(history.indexOf("function payloadOf(update) {"));
    assert.ok(pay.slice(0, 200).includes("if (Array.isArray(update) && typeof update[0] === \"string\") {"), "bare");
    const tr = readSource("space/transitions.js");
    const dep = tr.indexOf("activeShip.itemID, \"Departure\");");
    assert.ok(dep > 0 && tr.indexOf("spaceRuntime.detachSession(session, {", dep) > dep, "Departure first");
    assert.ok(tr.includes("moveResult.data.itemID, \"Arrival\");"), "Arrival");
  });

  test("GCE4 bounty adapter: gateTo spawn with gateEvents sends Arrival for every ship after publish, "
    + "presentGateDeparture at the gate, gateEvents off = no history", () => {
    const TO = 30002511;
    const SYSTEM = 30002510;
    const gate = { kind: "stargate", itemID: GATE, destinationSolarSystemID: TO, radius: 5000,
      position: { x: 1e7, y: 0, z: 0 } };
    const ships = new Map();
    const calls = [];
    const scene = { staticEntities: [gate], sessions: new Map([[1, { clientID: 1 }]]),
      getEntityByID: (id) => (id === GATE ? gate : ships.get(id) || null),
      broadcastSpecialFx: () => ({ deliveredCount: 1 }),
      queueCharacterHistory(session, updates) {
        calls.push(["history", ...updates]);
        return 3;
      } };
    const npc = { getControllerByEntityID: () => null, issueManualOrder: () => ({ success: true }),
      wakeNpcController: () => ({ success: true }) };
    const modules = { "space/runtime": { isSolarSystemSceneLoaded: (id) => id === SYSTEM,
      scenes: new Map([[SYSTEM, scene]]) }, "space/npc/npcService": npc };
    let next = 8200000;
    const spawn = { resolveProfiles: () => ({ ok: true, profiles: ["parity_guristas_frigate_1"] }),
      spawnShip: () => {
        next += 1;
        ships.set(next, { itemID: next, kind: "ship", position: { x: 0, y: 0, z: 0 } });
        return { ok: true, entityId: next };
      },
      publish: (_sys, ids) => {
        calls.push(["publish", ...ids]);
        return { ok: true };
      },
      despawn: () => ({ ok: true }) };
    const seam = bountyScene.createBountyScene({ requireGame: (rel) => (modules[rel] ? { ok: true,
      exports: modules[rel] } : { ok: false }), getSpawn: () => spawn, getSpawnTools: () => ({ ok: false }) });
    assert.ok(bountyScene.SEAM_METHODS.includes("presentGateDeparture"));
    const spec = { systemId: SYSTEM, anchor: { kind: "gateTo", systemId: TO, index: 0, gateFallback: true },
      factionId: 500010, boss: { kind: "hull", hullClass: "frigate" },
      escorts: [{ hullClass: "frigate" }], slimName: null, archetype: "RUNNER", seedKey: "bnt:1:1" };
    const r = seam.spawnGroup({ ...spec, gateEvents: true });
    assert.ok(r.ok === true && r.arrivalGate === true, JSON.stringify(r));
    const made = [r.bossId, ...r.escortIds];
    assert.deepStrictEqual([made.length, r.arrivals], [2, 2]);
    assert.deepStrictEqual(calls, [["publish", ...made],
      ...made.map((id) => ["history", ["OnClientControllerEvent", [GATE, id, "Arrival"]]])]);

    calls.length = 0;
    const off = seam.spawnGroup(spec);
    assert.ok(off.ok === true && off.arrivals === undefined);
    assert.deepStrictEqual(calls.map((c) => c[0]), ["publish"], "gateEvents off: no history");
    assert.strictEqual(seam.spawnGroup({ ...spec, gateEvents: 1 }).reason, "INVALID_INPUT");

    calls.length = 0;
    assert.deepStrictEqual(seam.presentGateDeparture(SYSTEM, r.bossId, GATE), { ok: true, sent: true, queued: 1 });
    assert.deepStrictEqual(calls, [["history", ["OnClientControllerEvent", [GATE, r.bossId, "Departure"]]]]);
    assert.strictEqual(seam.presentGateDeparture(SYSTEM + 1, r.bossId, GATE).reason, "SCENE_NOT_LOADED");
    assert.strictEqual(seam.presentGateDeparture(SYSTEM, r.bossId + 99, GATE).reason, "GONE");
    assert.strictEqual(seam.presentGateDeparture(SYSTEM, 0, GATE).reason, "INVALID_INPUT");
    for (let id = 8200001; id <= next; id += 1) dormancyGuard.release(id);
  });
};
