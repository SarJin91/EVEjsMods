"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const seams = require("../../lib/adapter/officerSpawn");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const SYSTEM = 30002510;
const CHAR = 90000123;
const SHIP = 140000001;

function readSource(rel) {
  return fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
}

function fakeGame({ plan, docked = false, loaded = true } = {}) {
  const plans = [];
  const spawns = [];
  const session = { characterID: CHAR, ...(docked ? { stationid: 60000001 } : {}) };
  const ship = { itemID: SHIP, itemName: "Rifter", position: { x: 0, y: 0, z: 0 } };
  const scene = { sessions: new Map([[1, session]]), getShipEntityForSession: (s) => (s === session ? ship : null),
    getEntityByID: () => null };
  const modules = {
    "space/runtime": { isSolarSystemSceneLoaded: (id) => loaded && id === SYSTEM, scenes: new Map([[SYSTEM, scene]]) },
    "space/npc/beltRatRuntime": {
      buildBeltRatSpawnPlan: (systemId, options) => {
        plans.push([systemId, options]);
        return plan ? plan(options) : { success: true, data: { specialSpawnKind: "officer",
          factionKey: options.factionKey || "angels", selectionID: "belt_rat:angels:nullsec:officer", selectionName: "x",
          definitions: [{ d: 1 }], profileIDs: ["parity_angels_officer_1"] } };
      },
    },
  };
  const requireGame = (rel) => (modules[rel] ? { ok: true, exports: modules[rel] } : { ok: false, reason: "missing" });
  const getSpawnTools = () => ({ ok: true, spawnNativeDefinitionsInContext: (context, selection, options) => {
    spawns.push({ context, selection, options });
    return { success: true, data: { spawned: [{ entity: { itemID: 990001 } }] } };
  } });
  return { plans, spawns, requireGame, getSpawnTools };
}

module.exports = ({ test }) => {
  test("OF5 officer seam: plan options, NOT_ELIGIBLE / RESERVE_REFUSED before the spawn, spawn options, factionKeyOf, "
    + "vendor facts, GAME_MODULES consumer", () => {
    let reserveCalls = 0;
    const reserveOk = () => { reserveCalls += 1; return { ok: true }; };
    const g = fakeGame();
    const seam = seams.createOfficerSpawnSeam({ requireGame: g.requireGame, getSpawnTools: g.getSpawnTools });
    const ok = seam.spawnOfficer({ systemId: SYSTEM, characterId: CHAR, factionKey: "guristas", distanceMeters: 30000,
      reserve: reserveOk });
    assert.deepStrictEqual(ok, { ok: true, entityIds: [990001], profileIds: ["parity_angels_officer_1"],
      factionKey: "guristas" });
    assert.deepStrictEqual(g.plans[0], [SYSTEM, { skipSpecialSpawns: true, forceSpecialSpawnKind: "officer",
      factionKey: "guristas" }]);
    assert.strictEqual(reserveCalls, 1);
    const o = g.spawns[0].options;
    assert.deepStrictEqual([o.operatorKind, o.selectionKind, o.transient, o.preferredTargetID, o.anchorKind,
      o.spawnDistanceMeters, o.spreadMeters, o.broadcast], ["lneOfficer", "lneOfficer", true, SHIP, "ship", 30000, 0,
      false]);
    assert.ok(o.spawnSiteID.startsWith(`lneOfficer:${CHAR}:`), o.spawnSiteID);
    assert.strictEqual(g.spawns[0].selection.data.selectionID, "lneOfficer:belt_rat:angels:nullsec:officer");
    seam.spawnOfficer({ systemId: SYSTEM, characterId: CHAR, factionKey: null, distanceMeters: 30000,
      reserve: reserveOk });
    assert.ok(!Object.prototype.hasOwnProperty.call(g.plans[1][1], "factionKey"));

    for (const errorMsg of ["SPECIAL_SPAWN_NOT_ELIGIBLE", "SPECIAL_SPAWN_POOL_NOT_FOUND", "SECURITY_BAND_NOT_ELIGIBLE"]) {
      const bad = fakeGame({ plan: () => ({ success: false, errorMsg }) });
      let called = 0;
      const r = seams.createOfficerSpawnSeam({ requireGame: bad.requireGame, getSpawnTools: bad.getSpawnTools })
        .spawnOfficer({ systemId: SYSTEM, characterId: CHAR, factionKey: "blood", distanceMeters: 30000,
          reserve: () => { called += 1; return { ok: true }; } });
      assert.deepStrictEqual([r.reason, r.detail, called, bad.spawns.length], ["NOT_ELIGIBLE", errorMsg, 0, 0]);
    }
    const refused = fakeGame();
    const rr = seams.createOfficerSpawnSeam({ requireGame: refused.requireGame, getSpawnTools: refused.getSpawnTools })
      .spawnOfficer({ systemId: SYSTEM, characterId: CHAR, factionKey: "blood", distanceMeters: 30000,
        reserve: () => ({ ok: false, reason: "LIMIT_DAY" }) });
    assert.deepStrictEqual([rr.reason, rr.detail, refused.spawns.length], ["RESERVE_REFUSED", "LIMIT_DAY", 0]);
    const docked = fakeGame({ docked: true });
    assert.strictEqual(seams.createOfficerSpawnSeam(docked).spawnOfficer({ systemId: SYSTEM, characterId: CHAR,
      factionKey: null, distanceMeters: 30000, reserve: reserveOk }).reason, "NO_SHIP");
    const unloaded = fakeGame({ loaded: false });
    assert.strictEqual(seams.createOfficerSpawnSeam(unloaded).spawnOfficer({ systemId: SYSTEM, characterId: CHAR,
      factionKey: null, distanceMeters: 30000, reserve: reserveOk }).reason, "SCENE_NOT_LOADED");
    assert.strictEqual(seam.spawnOfficer({ systemId: SYSTEM }).reason, "INVALID_INPUT");

    assert.deepStrictEqual([500010, 500011, 500012, 500019, 500020, 500001].map(seams.factionKeyOf),
      ["guristas", "angels", "blood", "sanshas", "serpentis", null]);

    const belt = readSource("space/npc/beltRatRuntime.js");
    assert.ok(belt.includes("options.forceSpecialSpawnKind"), "forceSpecialSpawnKind");
    assert.ok(belt.includes("const OFFICER_POOL_QUERY_BY_FACTION = Object.freeze({"), "OFFICER_POOL_QUERY_BY_FACTION");
    assert.match(belt, /^ {2}buildBeltRatSpawnPlan,$/m);
    const consumer = (p, name) => (GAME_MODULES.find((e) => e.path === p) || { symbols: [] }).symbols
      .find((s) => s.name === name && s.consumers.includes("officerSpawns"));
    assert.ok(consumer("space/npc/beltRatRuntime", "buildBeltRatSpawnPlan"));
    assert.ok(consumer("space/npc/nativeNpcService", "spawnNativeDefinitionsInContext"));
    assert.ok(consumer("space/runtime", "isSolarSystemSceneLoaded"));
  });
};
