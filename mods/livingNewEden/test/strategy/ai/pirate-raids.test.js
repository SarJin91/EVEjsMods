"use strict";

const assert = require("node:assert");

const { chooseNextOperation } = require("../../../lib/strategy/ai/operations");
const { captureOnlyOf, raidSet, chooseTargetSystem } = require("../../../lib/strategy/ai/targeting");
const { createHullLedger } = require("../../../lib/strategy/ai/hulls");
const { buildPowerTable } = require("../../../lib/strategy/ai/strength");
const { createRng } = require("../../../lib/util/rng");
const { DOCTRINES_V1 } = require("../../../lib/strategy/data/doctrines");
const { createOperationKinds } = require("../../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../../lib/strategy/data/operationKinds");
const { TARGET_SCORING_V1 } = require("../../../lib/strategy/data/targetScoring");
const { FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../../lib/fleets/schema");
const { GROUPS } = require("../../../lib/battle/data/strengthCatalog");
const RECIPES = require("../../../lib/economy/data/hullRecipes");

const AT = 1760000000000;
const HOUR = 3600000;
const F = 500010;
const EMPIRE = 500003;
const A = 3;
const B = 2;
const STATION_SYSTEM = 5;
const PIRATE = { ...DOCTRINES_V1.find((d) => d.doctrineId === "pirate-territorial-v2"), captureTargets: ["home"] };

const kinds = (() => {
  const k = createOperationKinds({ version: OPERATION_KINDS_VERSION, kinds: OPERATION_KINDS_V1 },
    { operationTypes: OPERATION_TYPES, objectives: OBJECTIVES, fleetRoles: FLEET_ROLES });
  assert.ok(k.ok, JSON.stringify(k));
  return k.kinds;
})();
const POWER = buildPowerTable(GROUPS);
const recipes = Object.fromEntries(Object.entries(RECIPES.GROUPS).map(([g, r]) => [g, { minerals: r.minerals }]));

const PARAMS = Object.freeze({ maxReachJumps: 10, supplyChainJumps: 10, captureRangeFromStationJumps: 5,
  maxAssemblyJumps: 15, maxBfsSystems: 2000, mobilizeFallbackJumps: 0, mobilizeFallbackMaxSystems: 9000,
  maxTargetCandidates: 40, targetPickTopK: 3, maxOperationsPerReview: 1, maxFleetsPerOperation: 4,
  maxFleetsPerFaction: 12, maxMobilizationsPerReview: 2, mobilizeResourcePerShip: 10, mobilizeReservePerShip: 1,
  attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR, maxObservationsPerReview: 8, reconWindowMs: HOUR / 2,
  attackWindowMs: 2 * HOUR, operationGraceMs: HOUR, maxHousekeepingPerReview: 4, maxRefitRequestsPerReview: 2,
  kinds: kinds.list, scoring: TARGET_SCORING_V1, powerTable: POWER, frontLimitCap: 2, routeMaxJumps: 40,
  production: Object.freeze({ mobilizeHulls: "required", mobilizationStations: 1 }) });

function scene(o) {
  const row = (systemId, controllerFactionId) => ({ systemId, controllerFactionId, occupationState: "STABLE",
    controllerGarrison: 0, hostileStations: 0, observed: false });
  const stations = [{ stationId: "st5", systemId: STATION_SYSTEM, kind: "npc", lines: 2, activeJobs: [], minerals: {},
    hulls: { frigate: 4, cruiser: 2 } }];
  const s = { v: 1, factionId: F, round: 1, at: AT, seed: 1,
    faction: { status: "ACTIVE", homeSystemId: STATION_SYSTEM, frontLimit: 1 }, entry: { homeRegionIds: [] },
    doctrine: { ...PIRATE, raidsBeyondTheatre: true, hoardCapped: true },
    theatre: [], expansion: o.expansion, raidTargets: o.raidTargets,
    neighbors: (id) => [id - 1, id + 1].filter((x) => x >= 1 && x <= 10), regionOf: () => null,
    isHostile: (x) => x === EMPIRE,
    stations: stations.map((x) => ({ systemId: x.systemId, stationId: x.stationId })), captureAnchors: [STATION_SYSTEM],
    systems: [row(B, EMPIRE), row(A, null), row(STATION_SYSTEM, F)], fleets: [], operations: [],
    operationsTruncated: false,
    intel: o.fresh ? [{ systemId: B, observedAt: AT - HOUR, hostileFleets: 0, hostileShips: 0, hostileStrength: 0,
      hostileStations: 0, controllerFactionId: EMPIRE }] : [], sightings: [],
    production: { mode: "ready", recipesVersion: 1, recipes, inProduction: {}, activeJobsTotal: 0, truncated: false,
      stations } };
  const reach = new Map([[A, 2], [B, 3]]);
  const supply = { frontTargets: [], frontLimit: 1, anchors: [STATION_SYSTEM], stationSystems: [STATION_SYSTEM],
    affordable: { resourceUnits: 1e6, reserveUnits: 1e6 }, reach, captureReach: new Map(reach), captureRoom: null,
    border: new Map() };
  const out = chooseNextOperation(s, supply, PARAMS, createRng(1), createHullLedger(s, PARAMS));
  const launches = out.intents.filter((i) => i.type === "LAUNCH").map((i) => [i.kind, i.target.systemId]);
  return { launches, notes: out.notes, snapshot: s };
}

function farScene(o) {
  const N = 20;
  const row = (systemId, controllerFactionId) => ({ systemId, controllerFactionId, occupationState: "STABLE",
    controllerGarrison: 0, hostileStations: 0, observed: false });
  const stations = [{ stationId: "st5", systemId: STATION_SYSTEM, kind: "npc", lines: 2, activeJobs: [], minerals: {},
    hulls: { frigate: 4, cruiser: 2 } }];
  const s = { v: 1, factionId: F, round: 1, at: AT, seed: 1,
    faction: { status: "ACTIVE", homeSystemId: STATION_SYSTEM, frontLimit: 1 }, entry: { homeRegionIds: [] },
    doctrine: { ...PIRATE, raidsBeyondTheatre: true, hoardCapped: true },
    theatre: [], expansion: o.expansion, raidTargets: o.raidTargets,
    neighbors: (id) => [id - 1, id + 1].filter((x) => x >= 1 && x <= N), regionOf: () => null,
    isHostile: (x) => x === EMPIRE,
    stations: stations.map((x) => ({ systemId: x.systemId, stationId: x.stationId })), captureAnchors: [STATION_SYSTEM],
    systems: [...o.hostile.map((id) => row(id, EMPIRE)), row(STATION_SYSTEM, F)], fleets: [], operations: [],
    operationsTruncated: false,
    intel: o.hostile.map((id) => ({ systemId: id, observedAt: AT - HOUR, hostileFleets: 0, hostileShips: 0,
      hostileStrength: 0, hostileStations: 0, controllerFactionId: EMPIRE })), sightings: [],
    production: { mode: "ready", recipesVersion: 1, recipes, inProduction: {}, activeJobsTotal: 0, truncated: false,
      stations } };
  const dist = (id) => Math.abs(id - STATION_SYSTEM);
  const ids = Array.from({ length: N }, (_, i) => i + 1);
  const reach = new Map(ids.filter((id) => dist(id) <= 10 && id !== o.drop).map((id) => [id, dist(id)]));
  const captureReach = new Map(ids.filter((id) => dist(id) <= 5).map((id) => [id, dist(id)]));
  const supply = { frontTargets: [], frontLimit: 1, anchors: [STATION_SYSTEM], stationSystems: [STATION_SYSTEM],
    affordable: { resourceUnits: 1e6, reserveUnits: 1e6 }, reach, captureReach, captureRoom: null,
    border: new Map() };
  const pick = chooseTargetSystem(s, supply, PARAMS, createRng(1));
  const out = chooseNextOperation(s, supply, PARAMS, createRng(1), createHullLedger(s, PARAMS));
  const launches = out.intents.filter((i) => i.type === "LAUNCH").map((i) => [i.kind, i.target.systemId]);
  return { pick: pick.ok ? ["ok", pick.systemId] : [pick.reason], launches, notes: out.notes, snapshot: s };
}

module.exports = ({ test }) => {
  test("HC4 pirate raids beyond the theatre: raid target B (500003) -> LAUNCH raid (never invasion, free A "
    + "never), recon without intel, no raid targets -> NO_TARGET:NO_CANDIDATE, B also in the expansion -> raid", () => {
    const fresh = scene({ expansion: [A], raidTargets: [B], fresh: true });
    const blind = scene({ expansion: [A], raidTargets: [B], fresh: false });
    const none = scene({ expansion: [A, B], raidTargets: [], fresh: true });
    const both = scene({ expansion: [A, B], raidTargets: [B], fresh: true });
    assert.deepStrictEqual({ fresh: fresh.launches, blind: blind.launches, none: [none.launches, none.notes],
      both: [both.launches, both.notes.includes("NO_KIND")],
      captureOnly: [captureOnlyOf(both.snapshot, B), captureOnlyOf(both.snapshot, A), captureOnlyOf(none.snapshot, B),
        raidSet({}).size] }, {
      fresh: [["raid", B]], blind: [["recon", B]], none: [[], ["NO_TARGET:NO_CANDIDATE"]],
      both: [[["raid", B]], false], captureOnly: [false, true, true, 0] },
    JSON.stringify({ fresh: fresh.notes, blind: blind.notes, both: both.notes }));
  });

  test("RR2 raid target 8 jumps away (only in supply.reach, not captureReach) -> chooseTargetSystem ok "
    + "LAUNCH raid (never invasion); out of reach -> NO_CANDIDATE; captureOnly flag = captureOnlyOf", () => {
    const FAR = STATION_SYSTEM + 8;
    const NEAR = STATION_SYSTEM + 3;
    const far = farScene({ expansion: [], raidTargets: [FAR], hostile: [FAR] });
    const gone = farScene({ expansion: [], raidTargets: [FAR], hostile: [FAR], drop: FAR });
    const both = farScene({ expansion: [NEAR], raidTargets: [NEAR], hostile: [NEAR] });
    const expOnly = farScene({ expansion: [NEAR], raidTargets: [], hostile: [NEAR] });
    assert.deepStrictEqual({ far: [far.pick, far.launches], gone: gone.pick, both: [both.pick, both.launches],
      expOnly: expOnly.pick,
      captureOnly: [captureOnlyOf(both.snapshot, NEAR), captureOnlyOf(expOnly.snapshot, NEAR)] }, {
      far: [["ok", FAR], [["raid", FAR]]], gone: ["NO_CANDIDATE"], both: [["ok", NEAR], [["raid", NEAR]]],
      expOnly: ["NO_CANDIDATE"], captureOnly: [false, true] },
    JSON.stringify({ far: far.notes, both: both.notes }));
  });
};
