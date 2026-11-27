"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { HOSTILITY_V4, HOSTILITY_V5, createHostility } = require("../../lib/battle/data/hostility");
const { REGISTRY_DATA_V1, ACTIVE_KINDS, createFactionRegistry } = require("../../lib/strategy/registry");
const { FACTIONS_V1 } = require("../../lib/strategy/data/factions");
const { HULL_GROUPS, FLEET_ROLES, OPERATION_TYPES } = require("../../lib/fleets/schema");
const HULL_TYPES = require("../../lib/economy/data/hullTradeTypes");
const { capitalClassesOf } = require("../../lib/strategy/data/factionHullClasses");
const { RACE_BY_FACTION_ID } = require("../../lib/adapter/data/industryLiveProfiles");
const { resolveConfig } = require("../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SOE = 500016;
const CTX = Object.freeze({ hullGroups: HULL_GROUPS, fleetRoles: FLEET_ROLES, operationTypes: OPERATION_TYPES,
  hostility: createHostility(), maxFactions: 64, maxCampaignSystems: 40, maxShipsPerFleet: 500,
  maxCompositionEntries: 32, maxResourceUnits: 1000000000 });

function withActiveSoe(doctrineId) {
  const data = JSON.parse(JSON.stringify(REGISTRY_DATA_V1));
  const i = data.factions.findIndex((f) => f.factionId === SOE);
  data.factions[i] = { factionId: SOE, kind: "neutral", ownerCorporationId: 1000130, hqSystemId: 30001978,
    homeRegionIds: [], doctrineId, maxActiveFronts: 6, initialResourceUnits: 8000, initialReserveUnits: 150,
    allies: [], startStations: [{ kind: "upwell", systemId: 30001978, structureFamily: "astrahus" }],
    origin: "test: Sisters of EVE active (S1)" };
  return { data, i };
}

module.exports = ({ test }) => {
  test("S1: neutral in ACTIVE_KINDS, soe-territorial-v1 of the production registry, an active "
    + "500016 builds on it and is refused on a pirate doctrine", () => {
    assert.ok(ACTIVE_KINDS.includes("neutral"));
    const prod = createFactionRegistry(REGISTRY_DATA_V1, CTX);
    assert.ok(prod.ok, JSON.stringify(prod));
    const d = prod.registry.getDoctrine("soe-territorial-v1");
    assert.deepStrictEqual([d.kind, d.fieldsDefense, d.fieldsHunters, d.targetSecClasses, d.hullsRequired],
      ["neutral", true, false, ["nullsec"], true]);
    assert.ok(prod.registry.listActiveFactions().some((f) => f.factionId === SOE), "500016 active since");

    const good = withActiveSoe("soe-territorial-v1");
    const built = createFactionRegistry(good.data, CTX);
    assert.ok(built.ok, JSON.stringify(built));
    assert.ok(built.registry.listActiveFactions().some((f) => f.factionId === SOE && f.kind === "neutral"));

    const bad = withActiveSoe("pirate-territorial-v2");
    assert.deepStrictEqual(createFactionRegistry(bad.data, CTX),
      { ok: false, reason: "REGISTRY_INVALID", detail: `factions[${bad.i}].doctrineId` });
  });

  test("S2: hostility v5 == v4 outside the pairs of 500016; 500016 in the empire bloc, friendly "
    + "to 500018 / 500028, hostile to pirates, invaders, drones; createHostility() = v5", () => {
    const v4 = createHostility(HOSTILITY_V4);
    const v5 = createHostility(HOSTILITY_V5);
    const byDefault = createHostility();
    const ids = FACTIONS_V1.map((f) => f.factionId);
    const changed = [];
    for (const a of ids) {
      for (const b of ids) {
        if (a === SOE || b === SOE) continue;
        if (v4(a, b) !== v5(a, b)) changed.push([a, b]);
      }
    }
    assert.deepStrictEqual(changed, []);
    const rel = (list) => Object.fromEntries(list.map((x) => [x, [v5(SOE, x), v5(x, SOE), byDefault(SOE, x)]]));
    const friends = [500001, 500002, 500003, 500004, 500006, 500027, 500018, 500028];
    const foes = [500010, 500011, 500012, 500019, 500020, 500021, 500025, 500026, 500029];
    assert.deepStrictEqual(rel(friends), Object.fromEntries(friends.map((x) => [x, [false, false, false]])));
    assert.deepStrictEqual(rel(foes), Object.fromEntries(foes.map((x) => [x, [true, true, true]])));
    assert.strictEqual(HOSTILITY_V5.version, 5);
  });

  test("S3: FACTION_RACE 500016 = 8 (Gallente), no capital class, industry race gallente", () => {
    assert.strictEqual(HULL_TYPES.FACTION_RACE["500016"], 8);
    assert.deepStrictEqual(capitalClassesOf(SOE), {});
    assert.strictEqual(RACE_BY_FACTION_ID[SOE], "gallente");
  });

  test("S4: default neutral treasury = pirate parity", () => {
    const { treasury } = resolveConfig({ modDir: MOD_DIR, env: {} }).config;
    assert.deepStrictEqual([treasury.initialIskNeutral, treasury.baseIncomeIskPerDayNeutral], [1e12, 2e9]);
  });
};
