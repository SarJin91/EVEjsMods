"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { HOSTILITY_V3, HOSTILITY_V4, createHostility } = require("../../../lib/battle/data/hostility");
const { planContact } = require("../../../lib/battle/contacts");
const { REGISTRY_DATA_V1, createFactionRegistry } = require("../../../lib/strategy/registry");
const { HULL_GROUPS, FLEET_ROLES, OPERATION_TYPES } = require("../../../lib/fleets/schema");
const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../../lib/adapter/locator");
const { listNpcStationsInSystemFrom } = require("../../../lib/adapter/npcStations");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const CAPS = 500018;

module.exports = ({ test }) => {
  test("C5 hostility v4 (500018), capsuleer fleets evasive -> NO_HOSTILES, vendor getStationsForSystem", () => {
    const v3 = createHostility(HOSTILITY_V3);
    const v4 = createHostility(HOSTILITY_V4);
    const byDefault = createHostility();
    const relations = {};
    for (const f of [500001, 500002, 500003, 500004, 500006, 500027, 500010, 500019]) {
      relations[f] = [v4(CAPS, f), v4(f, CAPS), byDefault(CAPS, f)];
    }
    const no = [false, false, false];
    const yes = [true, true, true];
    assert.deepStrictEqual(relations, { 500001: no, 500002: no, 500003: no, 500004: no, 500006: no, 500027: no,
      500010: yes, 500019: yes });
    const built = createFactionRegistry(REGISTRY_DATA_V1, { hullGroups: HULL_GROUPS, fleetRoles: FLEET_ROLES,
      operationTypes: OPERATION_TYPES, hostility: v4, maxFactions: 64, maxCampaignSystems: 40, maxShipsPerFleet: 500,
      maxCompositionEntries: 32, maxResourceUnits: 1000000000 });
    assert.ok(built.ok, JSON.stringify(built));
    const ids = built.registry.listFactions().map((f) => f.factionId);
    assert.ok(ids.length >= 20 && ids.includes(CAPS), String(ids.length));
    const changed = [];
    for (const a of ids) {
      for (const b of ids) {
        if (a === CAPS || b === CAPS) continue;
        const soe = a === 500016 || b === 500016;
        if (v3(a, b) !== v4(a, b) || (!soe && v4(a, b) !== byDefault(a, b))) changed.push([a, b]);
      }
    }
    assert.deepStrictEqual(changed, []);

    const fl = (fleetId, factionId, fleetRole) => ({ fleetId, factionId, fleetRole, shipCount: 2, version: 1,
      operationId: null, composition: [{ hullGroup: "battleship", typeId: null, count: 2 }] });
    const contact = planContact({ fleets: [fl("c1", CAPS, "capsuleer"), fl("c2", CAPS, "capsuleer"),
      fl("p1", 500019, "patrol")], triggerFleetId: "p1", isHostile: byDefault, cooldowns: new Map(), at: 0,
    limits: { maxFleetsPerSide: 8, maxSettlementRows: 450 } });
    assert.deepStrictEqual([contact.contact, contact.reason], [null, "NO_HOSTILES"]);

    const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
    assert.ok(found.ok, "EveJS server/src not found above the mod");
    const worldData = fs.readFileSync(path.join(found.srcDir, "space", "worldData.js"), "utf8");
    assert.ok(worldData.includes("function getStationsForSystem("), "getStationsForSystem defined");
    assert.ok(worldData.includes("stationsBySystem.get(Number(solarSystemID))"), "copy of stationsBySystem");
    assert.match(worldData, /^ {2}getStationsForSystem,\r?$/m, "getStationsForSystem exported");

    const vendor = { getStationsForSystem: (id) => (id === 30002053 ? [
      { stationID: 60011866, solarSystemID: id, corporationID: 1000110, stationName: "Hek VIII - Moon 12" },
      { stationID: 60004588, solarSystemID: id, corporationID: 0, stationName: "" }, null] : []) };
    assert.deepStrictEqual(listNpcStationsInSystemFrom(vendor, 30002053), { ok: true, stations: [
      { stationId: 60004588, corporationId: null, name: null },
      { stationId: 60011866, corporationId: 1000110, name: "Hek VIII - Moon 12" }] });
    assert.deepStrictEqual(listNpcStationsInSystemFrom({}, 30002053).reason, "WORLD_DATA_DRIFT");
    assert.deepStrictEqual(listNpcStationsInSystemFrom({ getStationsForSystem: () => {
      throw new Error("boom");
    } }, 30002053), { ok: false, reason: "NPC_STATIONS_FAILED", detail: "boom" });
  });
};
