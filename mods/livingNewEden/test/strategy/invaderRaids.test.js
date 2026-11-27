"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { decideReview } = require("../../lib/strategy/ai");
const { invaderRaidAnchorsOf, invaderDoctrineOverlay, invaderEntryFronts, invaderRaidNotes } =
  require("../../lib/strategy/ai/invaderEconomy");
const { buildPowerTable, strengthOf } = require("../../lib/strategy/ai/strength");
const { createOperationKinds } = require("../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../lib/strategy/data/operationKinds");
const { TARGET_SCORING_V1 } = require("../../lib/strategy/data/targetScoring");
const { DOCTRINES_V1 } = require("../../lib/strategy/data/doctrines");
const { FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../lib/fleets/schema");
const { GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { invaderEconomyParamsOf, invaderFactionParamsOf } = require("../../lib/strategy/reviewService");
const { resolveConfig } = require("../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const AT = 1760000000000;
const HOUR = 3600000;
const TRIG = 500026;
const DTH = 500029;
const HOSTILE = 9;
const OUTSIDE = 100;
const REGISTRY_FRONTS = 1;
const ON = { EVEJS_DATA_ROOT: "x", EVEJS_LNE_INVADER_ECONOMY_ENABLED: "1", EVEJS_LNE_INVADER_ECONOMY_RAIDS_ENABLED: "1" };

const kinds = (() => {
  const k = createOperationKinds({ version: OPERATION_KINDS_VERSION, kinds: OPERATION_KINDS_V1 },
    { operationTypes: OPERATION_TYPES, objectives: OBJECTIVES, fleetRoles: FLEET_ROLES });
  assert.ok(k.ok, JSON.stringify(k));
  return k.kinds;
})();
const POWER = buildPowerTable(GROUPS);
const WING = [{ hullGroup: "cruiser", typeId: null, count: 6 }];

const PARAMS = Object.freeze({ maxReachJumps: 10, supplyChainJumps: 10, captureRangeFromStationJumps: 15,
  maxAssemblyJumps: 15, maxBfsSystems: 2000, mobilizeFallbackJumps: 0, mobilizeFallbackMaxSystems: 2000,
  maxTargetCandidates: 40, targetPickTopK: 1, maxOperationsPerReview: 2, maxFleetsPerOperation: 4,
  maxFleetsPerFaction: 32, maxMobilizationsPerReview: 3, mobilizeResourcePerShip: 10, mobilizeReservePerShip: 1,
  attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR, maxObservationsPerReview: 12, reconWindowMs: HOUR / 2,
  attackWindowMs: 2 * HOUR, operationGraceMs: HOUR, maxHousekeepingPerReview: 4, maxRefitRequestsPerReview: 2,
  kinds: kinds.list, scoring: TARGET_SCORING_V1, powerTable: POWER, frontLimitCap: 6, routeMaxJumps: 40,
  maxCapturedSystemsPerFaction: 150, captureRequiresAdjacency: true, footholdHold: { minFleets: 1 } });

const TRIG_DOCTRINE = DOCTRINES_V1.find((x) => x.doctrineId === "triglavian-invader-v1");
const resolve = (env) => {
  const r = resolveConfig({ modDir: MOD_DIR, env });
  assert.ok(r.ok, JSON.stringify(r.errors));
  return r.config;
};
const row = (systemId, controllerFactionId) => ({ systemId, controllerFactionId, occupationState: "STABLE",
  controllerGarrison: 0, hostileStations: 0, observed: false, ownInfluence: 0 });
const intelOf = (systemId) => ({ systemId, observedAt: AT - HOUR, hostileFleets: 0, hostileShips: 0,
  hostileStrength: 0, hostileStations: 0, controllerFactionId: HOSTILE });
const fleet = (fleetId, systemId) => ({ fleetId, version: 2, state: "IDLE", fleetRole: "invasion", systemId,
  refitPending: false, shipCount: 6, strength: strengthOf(WING, POWER), operationId: null, legSeq: 0,
  homeSystemId: systemId, updatedAt: AT - HOUR });
const raidOp = (operationId, targetSystemId) => ({ operationId, version: 1, state: "ACTIVE", operationType: "raid",
  objective: "raid", originSystemId: 5, targetSystemId, dueAt: AT + HOUR, members: 1, orderedMembers: 1 });

function snap(E, o = {}) {
  const footholds = o.footholds || [];
  const anchors = invaderRaidAnchorsOf(footholds, E);
  const doctrine = anchors.length > 0 ? invaderDoctrineOverlay(TRIG_DOCTRINE, E) : TRIG_DOCTRINE;
  const hostile = o.hostile || [7];
  return { v: 1, factionId: TRIG, round: 3, at: AT, seed: 11,
    faction: { status: "ACTIVE", homeSystemId: OUTSIDE, doctrineId: TRIG_DOCTRINE.doctrineId,
      resourceUnits: 100000, reserveUnits: 10000, frontLimit: 6, version: 1 },
    entry: { kind: "invader", maxActiveFronts: invaderEntryFronts(REGISTRY_FRONTS, E), allies: [],
      homeRegionIds: [], ownerCorporationId: 1 },
    doctrine, theatre: [], expansion: [],
    raidTargets: doctrine.raidsBeyondTheatre === true ? hostile : [],
    border: { mode: "off", reach: null, captures: false, candidates: [], rejected: 0 },
    neighbors: (id) => [id - 1, id + 1].filter((x) => x >= 1 && x <= 12), regionOf: () => null,
    isHostile: (x) => x === HOSTILE,
    stationsMode: "ready", stations: [], captureAnchors: [],
    systems: [row(5, null), ...hostile.map((id) => row(id, HOSTILE))],
    fleets: o.fleets || [fleet("w1", 5), fleet("w2", 5)], fleetsTruncated: false,
    operations: o.operations || [], operationsTruncated: false, intel: hostile.map(intelOf), sightings: [],
    occupations: [], territory: [], territoryTruncated: false, capturedIds: [], footholds };
}
const FOOTHOLD = [{ systemId: 5, jumps: 1 }];
const launches = (d) => d.intents.filter((i) => i.type === "LAUNCH").map((i) => [i.kind, i.target.systemId]);
const fleetsOf = (d, kind) => d.intents.filter((i) => i.type === "LAUNCH" && i.kind === kind)
  .flatMap((i) => i.fleets.map((x) => x.fleetId));

module.exports = ({ test }) => {
  test("IR1 flag off: no E.raids, the same doctrine / params / entry, the decision deepStrictEqual", () => {
    const offs = [resolve({ EVEJS_DATA_ROOT: "x", EVEJS_LNE_INVADER_ECONOMY_ENABLED: "1" }),
      resolve({ EVEJS_DATA_ROOT: "x", EVEJS_LNE_INVADER_ECONOMY_RAIDS_ENABLED: "1" })];
    const cases = [[offs[0], TRIG], [offs[1], TRIG], [resolve(ON), DTH]];
    for (const [cfg, f] of cases) {
      const E = invaderEconomyParamsOf(cfg, f);
      assert.ok(E === null || !("raids" in E), JSON.stringify(E));
      assert.strictEqual(invaderDoctrineOverlay(TRIG_DOCTRINE, E), TRIG_DOCTRINE, "the same reference");
      assert.strictEqual(invaderEntryFronts(REGISTRY_FRONTS, E), REGISTRY_FRONTS);
      const params = invaderFactionParamsOf(PARAMS, E);
      if (E === null) assert.strictEqual(params, PARAMS);
      else assert.deepStrictEqual(params, { ...PARAMS, invaderEconomy: E }, "params of");
      const s = snap(E, { footholds: FOOTHOLD });
      assert.strictEqual(s.doctrine, TRIG_DOCTRINE);
      assert.deepStrictEqual(s.raidTargets, []);
      const d = decideReview(s, params);
      assert.strictEqual(d.outcome, "REVIEWED", d.reason);
      const before = decideReview({ ...s, doctrine: TRIG_DOCTRINE, entry: { ...s.entry, maxActiveFronts: 1 } },
        E === null ? PARAMS : Object.freeze({ ...PARAMS, invaderEconomy: E }));
      assert.deepStrictEqual(d, before);
      assert.ok(!launches(d).some(([k]) => k === "raid"), JSON.stringify(d.intents));
      assert.ok(!d.notes.includes("INVADER_RAIDS_NO_FOOTHOLDS"), JSON.stringify(d.notes));
    }
    const on = resolve(ON).invaderEconomy;
    assert.deepStrictEqual([on.raidsEnabled, on.triglavian.maxActiveFronts, on.triglavian.maxRaidFronts,
      on.deathless.maxActiveFronts, on.deathless.maxRaidFronts], [true, 3, 2, 0, 0]);
    assert.strictEqual(resolve({ EVEJS_DATA_ROOT: "x" }).invaderEconomy.raidsEnabled, false);
  });

  test("IR2 foothold 5 + hostile 7 in reach 3 + 2 IDLE fleets (one FOOTHOLD_HOLDING) -> LAUNCH raid 7 with "
    + "the free fleet; front limit 3 of the key", () => {
    const E = invaderEconomyParamsOf(resolve(ON), TRIG);
    assert.deepStrictEqual({ ...E.raids }, { maxActiveFronts: 3, maxRaidFronts: 2 });
    const params = invaderFactionParamsOf(PARAMS, E);
    assert.deepStrictEqual([params.raidFrontLimitEnabled, params.maxRaidFronts], [true, 2]);
    assert.deepStrictEqual(invaderRaidAnchorsOf([...FOOTHOLD, { systemId: OUTSIDE, jumps: 3, home: true }], E), [5]);
    const s = snap(E, { footholds: FOOTHOLD });
    assert.deepStrictEqual([...s.doctrine.operationTypes], ["recon", "invasion", "raid"]);
    assert.strictEqual(s.doctrine.raidsBeyondTheatre, true);
    assert.deepStrictEqual([...TRIG_DOCTRINE.operationTypes], ["recon", "invasion"], "the registry doctrine untouched");
    assert.strictEqual(s.entry.maxActiveFronts, 3);
    const d = decideReview(s, params);
    assert.strictEqual(d.outcome, "REVIEWED", d.reason);
    assert.ok(launches(d).some(([k, t]) => k === "raid" && t === 7), JSON.stringify(d.intents));
    assert.ok(d.notes.includes("FOOTHOLD_HOLD"), JSON.stringify(d.notes));
    const raiders = fleetsOf(d, "raid");
    assert.strictEqual(raiders.length, 1, JSON.stringify(d.intents));
    assert.ok(!raiders.includes("w1"), "w1 (fleetId first) holds the foothold");
    const touch = d.intents.find((i) => i.type === "FACTION_TOUCH");
    assert.strictEqual(touch && touch.frontLimit, 3, "FACTION_TOUCH syncs front_limit to min(key 3, cap 6)");
  });

  test("IR3 maxRaidFronts 2 with 2 open raids (3, 8) -> the third raid target 7 is RAID_FRONT_LIMIT", () => {
    const E = invaderEconomyParamsOf(resolve(ON), TRIG);
    const s = snap(E, { footholds: FOOTHOLD, hostile: [3, 7, 8],
      operations: [raidOp("op-a", 3), raidOp("op-b", 8)] });
    const d = decideReview(s, invaderFactionParamsOf(PARAMS, E));
    assert.strictEqual(d.outcome, "REVIEWED", d.reason);
    assert.ok(!launches(d).some(([k]) => k === "raid"), JSON.stringify(d.intents));
    assert.ok(d.notes.includes("RAID_FRONT_LIMIT"), JSON.stringify(d.notes));
    const E3 = invaderEconomyParamsOf(resolve({ ...ON, EVEJS_LNE_INVADER_ECONOMY_TRIGLAVIAN_MAX_RAID_FRONTS: "3",
      EVEJS_LNE_INVADER_ECONOMY_TRIGLAVIAN_MAX_ACTIVE_FRONTS: "4" }), TRIG);
    const d3 = decideReview(snap(E3, { footholds: FOOTHOLD, hostile: [3, 7, 8],
      operations: [raidOp("op-a", 3), raidOp("op-b", 8)] }), invaderFactionParamsOf(PARAMS, E3));
    assert.ok(launches(d3).some(([k, t]) => k === "raid" && t === 7), JSON.stringify(d3.intents));
  });

  test("IR4 no foothold / the home entry only -> INVADER_RAIDS_NO_FOOTHOLDS, zero LAUNCH", () => {
    const E = invaderEconomyParamsOf(resolve(ON), TRIG);
    for (const footholds of [[], [{ systemId: OUTSIDE, jumps: 3, home: true }]]) {
      const s = snap(E, { footholds });
      assert.strictEqual(s.doctrine, TRIG_DOCTRINE, "no overlay without a raid anchor");
      assert.deepStrictEqual(invaderRaidNotes(s, E), ["INVADER_RAIDS_NO_FOOTHOLDS"]);
      const d = decideReview(s, invaderFactionParamsOf(PARAMS, E));
      assert.strictEqual(d.outcome, "REVIEWED", d.reason);
      assert.ok(d.notes.includes("INVADER_RAIDS_NO_FOOTHOLDS"), JSON.stringify(d.notes));
      assert.deepStrictEqual(launches(d), []);
    }
    assert.deepStrictEqual(invaderRaidNotes(snap(E, { footholds: FOOTHOLD }), E), []);
    assert.deepStrictEqual(invaderRaidNotes(snap(null, { footholds: [] }), null), [], "off: no note");
  });
};
