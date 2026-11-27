"use strict";

const assert = require("node:assert");

const { HOSTILITY_V2, HOSTILITY_V3, createHostility } = require("../../lib/battle/data/hostility");
const { REGISTRY_DATA_V1, createFactionRegistry } = require("../../lib/strategy/registry");
const { HULL_GROUPS, FLEET_ROLES, OPERATION_TYPES } = require("../../lib/fleets/schema");

const KNOWN_V2 = Object.freeze([500001, 500002, 500003, 500004, 500006, 500010, 500011, 500012, 500019, 500020]);
const EMPIRES = Object.freeze([500001, 500002, 500003, 500004]);

module.exports = ({ test }) => {
  test("H1 hostility v3: == v2 on the 10 factions of v2 but the 6 empire pairs; bloc 500027-500006; self "
    + "never hostile; allies of the registry friendly in v3; createHostility() = v3", () => {
    const v2 = createHostility(HOSTILITY_V2);
    const v3 = createHostility(HOSTILITY_V3);
    const changed = [];
    for (const a of KNOWN_V2) {
      for (const b of KNOWN_V2) {
        if (a >= b) continue;
        if (v2(a, b) !== v3(a, b)) changed.push([a, b, v3(a, b)]);
      }
    }
    const empirePairs = [];
    for (const a of EMPIRES) for (const b of EMPIRES) if (a < b) empirePairs.push([a, b, false]);
    assert.deepStrictEqual(changed, empirePairs, "only the 6 empire-empire pairs change, to friendly");
    assert.strictEqual(empirePairs.length, 6);
    assert.strictEqual(v3(500027, 500006), false, "EDENCOM in the bloc with CONCORD");
    assert.strictEqual(v3(500006, 500027), false);
    assert.strictEqual(v3(500027, 500019), true, "EDENCOM hostile to Sansha");
    for (const f of [...KNOWN_V2, 500027, 500026]) assert.strictEqual(v3(f, f), false, `${f} self`);
    assert.strictEqual(v3(500010, 500020), true, "no pirate pair of the SDE (Q2)");
    const built = createFactionRegistry(REGISTRY_DATA_V1, { hullGroups: HULL_GROUPS, fleetRoles: FLEET_ROLES,
      operationTypes: OPERATION_TYPES, hostility: v3, maxFactions: 64, maxCampaignSystems: 40, maxShipsPerFleet: 500,
      maxCompositionEntries: 32, maxResourceUnits: 1000000000 });
    assert.ok(built.ok, JSON.stringify(built));
    for (const f of built.registry.listFactions()) {
      for (const ally of f.allies) assert.strictEqual(v3(f.factionId, ally), false, `${f.factionId} -> ${ally}`);
    }
    const byDefault = createHostility();
    assert.strictEqual(byDefault(500001, 500004), false, "the default table is v3");
    assert.strictEqual(byDefault(500019, 500003), true);
  });
};
