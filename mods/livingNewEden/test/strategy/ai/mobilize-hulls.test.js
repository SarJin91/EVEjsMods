"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { hullTargets, planProduction, huntersNeedHullsOf, rankMobilizationStations } =
  require("../../../lib/strategy/ai/production");
const { decideReview } = require("../../../lib/strategy/ai");
const { captureBlock, describe } = require("../../../lib/strategy/ai/targeting");
const { FACTIONS_V1 } = require("../../../lib/strategy/data/factions");
const { createHostility } = require("../../../lib/battle/data/hostility");
const { chooseNextOperation } = require("../../../lib/strategy/ai/operations");
const { createHullLedger } = require("../../../lib/strategy/ai/hulls");
const { buildPowerTable, strengthOf } = require("../../../lib/strategy/ai/strength");
const { createRng } = require("../../../lib/util/rng");
const { DOCTRINES_V1 } = require("../../../lib/strategy/data/doctrines");
const { createOperationKinds } = require("../../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../../lib/strategy/data/operationKinds");
const { TARGET_SCORING_V1 } = require("../../../lib/strategy/data/targetScoring");
const { HULL_GROUPS, FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../../lib/fleets/schema");
const { GROUPS } = require("../../../lib/battle/data/strengthCatalog");
const RECIPES = require("../../../lib/economy/data/hullRecipes");
const config = require("../../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const AT = 1760000000000;
const HOUR = 3600000;
const F = 7;
const H = 9;
const PIRATE = DOCTRINES_V1.find((d) => d.doctrineId === "pirate-territorial-v2");

const PROD = Object.freeze({ maxJobsPerReview: 8, maxRunsPerJob: 4, maxActiveJobsPerFaction: 8, targetStockFleets: 2,
  mobilizeHulls: "required", miningNeedsHulls: false, mobilizationStations: 1, hullGroups: [...HULL_GROUPS] });
const recipes = Object.fromEntries(Object.entries(RECIPES.GROUPS).map(([g, r]) => [g, { minerals: r.minerals }]));
const times = (g, n) => Object.fromEntries(Object.entries(RECIPES.GROUPS[g].minerals).map(([k, v]) => [k, v * n]));
const prodOf = (stations) => ({ mode: "ready", recipesVersion: 1, recipes, inProduction: {}, activeJobsTotal: 0,
  truncated: false, stations });
const st = (stationId, systemId, minerals, hulls = {}) => ({ stationId, systemId, kind: "npc", lines: 2,
  activeJobs: [], minerals, hulls });

const kinds = (() => {
  const k = createOperationKinds({ version: OPERATION_KINDS_VERSION, kinds: OPERATION_KINDS_V1 },
    { operationTypes: OPERATION_TYPES, objectives: OBJECTIVES, fleetRoles: FLEET_ROLES });
  assert.ok(k.ok, JSON.stringify(k));
  return k.kinds;
})();
const POWER = buildPowerTable(GROUPS);
const PATROL = Object.freeze([{ hullGroup: "cruiser", count: 2 }]);
const PATROL_STRENGTH = strengthOf(PATROL.map((e) => ({ ...e, typeId: null })), POWER);

const PARAMS = Object.freeze({ maxReachJumps: 10, supplyChainJumps: 10, captureRangeFromStationJumps: 5,
  maxAssemblyJumps: 15, maxBfsSystems: 2000, mobilizeFallbackJumps: 30, mobilizeFallbackMaxSystems: 9000,
  maxTargetCandidates: 40, targetPickTopK: 3, maxOperationsPerReview: 1, maxFleetsPerOperation: 4,
  maxFleetsPerFaction: 12, maxMobilizationsPerReview: 2, mobilizeResourcePerShip: 10, mobilizeReservePerShip: 1,
  attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR, maxObservationsPerReview: 8, reconWindowMs: HOUR / 2,
  attackWindowMs: 2 * HOUR, operationGraceMs: HOUR, maxHousekeepingPerReview: 4, maxRefitRequestsPerReview: 2,
  kinds: kinds.list, scoring: TARGET_SCORING_V1, powerTable: POWER, frontLimitCap: 2, routeMaxJumps: 40,
  production: PROD });

function scene(stations, o = {}) {
  const T = 1;
  const row = (systemId, controllerFactionId) => ({ systemId, controllerFactionId, occupationState: "STABLE",
    controllerGarrison: 0, hostileStations: 0, observed: false });
  const s = { v: 1, factionId: F, round: 1, at: AT, seed: 1,
    faction: { status: "ACTIVE", homeSystemId: 40, frontLimit: 1 }, entry: { homeRegionIds: [] },
    doctrine: { doctrineId: "mh", canOccupy: false, captureTargets: [], operationTypes: ["recon", "raid"],
      templates: { patrol: PATROL, scout: [{ hullGroup: "frigate", count: 1 }] } },
    theatre: [T], expansion: [],
    neighbors: (id) => {
      if (o.calls && id === T) o.calls.n += 1;
      return [id - 1, id + 1].filter((x) => x >= 1 && x <= 40);
    }, regionOf: () => null,
    isHostile: (x) => x === H,
    stations: stations.map((x) => ({ systemId: x.systemId, stationId: x.stationId })),
    systems: [row(T, H)], fleets: [], operations: [], operationsTruncated: false,
    intel: o.noIntel ? [] : [{ systemId: T, observedAt: AT - HOUR, hostileFleets: 0, hostileShips: 0,
      hostileStrength: o.enemy || 0, hostileStations: 0, controllerFactionId: H }], sightings: [],
    production: prodOf(stations) };
  const supply = { frontTargets: [], frontLimit: 1, anchors: [40], stationSystems: stations.map((x) => x.systemId),
    affordable: { resourceUnits: 1e6, reserveUnits: 1e6 }, reach: new Map([[T, 1]]), captureReach: new Map(),
    captureRoom: null, border: new Map() };
  const P = { ...PARAMS, ...(o.params || {}) };
  const ledger = createHullLedger(s, P);
  const out = chooseNextOperation(s, supply, P, createRng(1), ledger);
  const mobs = out.intents.flatMap((i) => (i.type === "MOBILIZE" ? [i] : i.type === "LAUNCH" ? i.mobilize : []));
  const spent = mobs.reduce((a, m) => a + m.cost.resourceUnits + m.cost.reserveUnits, 0);
  return { out, mobs, ledger, supply, spent };
}

module.exports = ({ test }) => {
  test("MH1 bug-faction-mobilize-hulls hullTargets + hunter template: pirate tackle 4, frigate +4; no flag = "
    + "today; fieldsHunters false, hullsRequired false, free group", () => {
    const base = hullTargets(PIRATE, PROD);
    const withH = hullTargets(PIRATE, { ...PROD, huntersNeedHulls: true });
    assert.strictEqual(base.tackle, undefined, JSON.stringify(base));
    assert.strictEqual(withH.tackle, 4, JSON.stringify(withH));
    assert.strictEqual(withH.frigate, (base.frigate || 0) + 4);
    assert.deepStrictEqual({ ...withH, tackle: undefined, frigate: base.frigate },
      { ...base, tackle: undefined }, "other groups unchanged");
    assert.deepStrictEqual(hullTargets({ ...PIRATE, fieldsHunters: false }, { ...PROD, huntersNeedHulls: true }), base);
    assert.deepStrictEqual(hullTargets({ ...PIRATE, hullsRequired: false }, { ...PROD, huntersNeedHulls: true }), {});
    const free = hullTargets(PIRATE, { ...PROD, huntersNeedHulls: true, freeHullGroups: ["tackle"] });
    assert.strictEqual(free.tackle, undefined, "free group skipped");
    assert.strictEqual(free.frigate, withH.frigate);
  });

  test("MH2 bug-faction-mobilize-hulls planProduction pirate: empty stock, tackle minerals -> PRODUCE tackle "
    + "with huntersNeedHulls; without the flag no tackle", () => {
    const snap = { v: 1, factionId: 500010, round: 3, at: AT, seed: 5,
      faction: { status: "ACTIVE", homeSystemId: 30000001, frontLimit: 1, resourceUnits: 1e6, reserveUnits: 1e6 },
      doctrine: PIRATE, stationsMode: "ready", stations: [{ systemId: 30000001, stationId: "st0" }], systems: [],
      neighbors: () => [], regionOf: () => null, isHostile: () => false,
      production: prodOf([st("st0", 30000001, times("tackle", 4))]) };
    const on = planProduction(snap, null, { production: { ...PROD, huntersNeedHulls: true } });
    const tackle = on.intents.filter((i) => i.type === "PRODUCE" && i.hullGroup === "tackle");
    assert.strictEqual(tackle.length, 1, JSON.stringify(on));
    assert.strictEqual(tackle[0].stationId, "st0");
    const off = planProduction(snap, null, { production: PROD });
    assert.deepStrictEqual(off.intents.filter((i) => i.hullGroup === "tackle"), [], JSON.stringify(off.intents));
  });

  test("MH3 bug-faction-mobilize-hulls far mobilization: near station (10) half a template, far (25) whole -> "
    + "MOBILIZE from the far one + MOBILIZE_FAR; fallback 0 -> the near note", () => {
    const stations = [st("near", 10, {}, { cruiser: 1 }), st("far", 25, {}, { cruiser: 2 })];
    const { out, mobs } = scene(stations);
    assert.deepStrictEqual(mobs.map((m) => [m.stationId, m.systemId, m.role]), [["far", 25, "patrol"]],
      JSON.stringify(out));
    assert.deepStrictEqual(mobs[0].hulls, [{ itemKey: "group:cruiser", count: 2 }]);
    assert.deepStrictEqual(out.notes.filter((n) => n === "MOBILIZE_FAR"), ["MOBILIZE_FAR"]);
    assert.ok(!out.notes.includes("INSUFFICIENT_FORCE"), JSON.stringify(out.notes));
    const offRun = scene(stations, { params: { mobilizeFallbackJumps: 0 } });
    assert.deepStrictEqual(offRun.mobs, []);
    assert.deepStrictEqual(offRun.out.notes, ["NO_HULLS:cruiser", "INSUFFICIENT_FORCE"]);
    const equal = scene(stations, { params: { mobilizeFallbackJumps: 15 } });
    assert.deepStrictEqual(equal.mobs, [], "fallback <= maxAssemblyJumps = off");
  });

  test("MH4 bug-faction-mobilize-hulls bounds: far station at 35 > 30, one template for 2 fleets (no double "
    + "count), T never a candidate", () => {
    const beyond = scene([st("near", 10, {}, { cruiser: 1 }), st("far", 35, {}, { cruiser: 2 })]);
    assert.deepStrictEqual(beyond.mobs, []);
    assert.deepStrictEqual(beyond.out.notes, ["NO_HULLS:cruiser", "INSUFFICIENT_FORCE"]);
    const two = scene([st("far", 25, {}, { cruiser: 2 })], { enemy: PATROL_STRENGTH });
    assert.deepStrictEqual(two.out.intents.filter((i) => i.type === "LAUNCH"), [], "required 2 fleets, 1 template");
    assert.deepStrictEqual(two.mobs, [], JSON.stringify(two.out));
    assert.deepStrictEqual(two.out.notes, ["NO_HULLS:cruiser", "INSUFFICIENT_FORCE"]);
    const atT = scene([st("atT", 1, {}, { cruiser: 4 })]);
    assert.deepStrictEqual(atT.mobs, [], JSON.stringify(atT.out));
    assert.ok(!atT.out.notes.includes("MOBILIZE_FAR"), JSON.stringify(atT.out.notes));
  });

  test("NF1 only a far station (25) with one template, 2 fleets required -> rollback: no MOBILIZE, no "
    + "LAUNCH, no MOBILIZE_FAR, hulls and budget untouched", () => {
    const r = scene([st("far", 25, {}, { cruiser: 2 })], { enemy: PATROL_STRENGTH });
    assert.deepStrictEqual(r.out.intents, [], JSON.stringify(r.out));
    assert.deepStrictEqual(r.out.notes, ["NO_HULLS:cruiser", "INSUFFICIENT_FORCE"]);
    assert.strictEqual(r.ledger.available("far", "cruiser"), 2);
    assert.strictEqual(r.spent, 0);
    assert.deepStrictEqual(r.supply.affordable, { resourceUnits: 1e6, reserveUnits: 1e6 });
  });

  test("NF2 far station with 2 templates -> commit: LAUNCH with 2 far mobilize, 2x MOBILIZE_FAR, stock "
    + "-4; the fork has pickWithNote; no intel -> the scouting fallback still works", () => {
    const r = scene([st("far", 25, {}, { cruiser: 4 })], { enemy: PATROL_STRENGTH });
    const launches = r.out.intents.filter((i) => i.type === "LAUNCH");
    assert.strictEqual(launches.length, 1, JSON.stringify(r.out));
    assert.deepStrictEqual(launches[0].mobilize.map((m) => [m.stationId, m.slot]), [["far", 0], ["far", 1]]);
    assert.strictEqual(launches[0].slot, 2);
    assert.ok(launches[0].mobilize.every((m) => !("far" in m)), "far is a result field, never in the intent");
    assert.deepStrictEqual(r.out.notes, ["MOBILIZE_FAR", "MOBILIZE_FAR"]);
    assert.strictEqual(r.ledger.available("far", "cruiser"), 0);
    assert.strictEqual(typeof r.ledger.fork().pickWithNote, "function");
    const scout = scene([st("far", 25, {}, { frigate: 1 })], { noIntel: true });
    const sl = scout.out.intents.filter((i) => i.type === "LAUNCH");
    assert.strictEqual(sl.length, 1, JSON.stringify(scout.out));
    assert.strictEqual(sl[0].kind, "recon");
    assert.deepStrictEqual(sl[0].mobilize.map((m) => m.stationId), ["far"]);
    assert.deepStrictEqual(scout.out.notes, ["MOBILIZE_FAR"]);
  });

  test("NF3 near (10) one template, far without a whole one, 3 fleets required -> standalone MOBILIZE "
    + "only from near, slots from 0; a far trial short of the requirement rolls back stock and slot", () => {
    const enemy = 2 * PATROL_STRENGTH;
    const r = scene([st("near", 10, {}, { cruiser: 2 }), st("far", 25, {}, { cruiser: 1 })], { enemy });
    assert.deepStrictEqual(r.out.intents.map((i) => [i.type, i.slot, i.stationId]), [["MOBILIZE", 0, "near"]],
      JSON.stringify(r.out));
    assert.deepStrictEqual(r.out.notes, ["NO_HULLS:cruiser", "INSUFFICIENT_FORCE"]);
    const t = scene([st("near", 10, {}, { cruiser: 2 }), st("far", 25, {}, { cruiser: 2 })], { enemy });
    assert.deepStrictEqual(t.out.intents.map((i) => [i.type, i.slot, i.stationId]), [["MOBILIZE", 0, "near"]],
      JSON.stringify(t.out));
    assert.ok(!t.out.notes.includes("MOBILIZE_FAR"), JSON.stringify(t.out.notes));
    assert.strictEqual(t.ledger.available("far", "cruiser"), 2);
    assert.strictEqual(t.ledger.available("near", "cruiser"), 0);
  });

  test("NF4 no station with a whole template -> no far BFS (same BFS count as fallback off); a "
    + "whole template far away -> +1 BFS", () => {
    const count = (stations, params) => {
      const calls = { n: 0 };
      scene(stations, { calls, params });
      return calls.n;
    };
    const none = [st("near", 10, {}, { cruiser: 1 }), st("far", 25, {}, { cruiser: 1 })];
    const whole = [st("near", 10, {}, { cruiser: 1 }), st("far", 25, {}, { cruiser: 2 })];
    const off = count(none, { mobilizeFallbackJumps: 0 });
    assert.ok(off >= 1, String(off));
    assert.strictEqual(count(none), off, "pre-check skips the far BFS");
    assert.strictEqual(count(whole), off + 1, "far BFS once when a whole template exists");
  });

  test("MH5 bug-faction-mobilize-hulls config: 3 defaults in SCHEMA, warning fallback > routeMaxJumps, one "
    + "huntersNeedHulls formula (review = panel), hunt off -> false", () => {
    const row = (key) => config.SCHEMA.find((r) => r.key === key);
    assert.deepStrictEqual([row("strategy.mobilizeFallbackJumps").default,
      row("strategy.mobilizeFallbackMaxSystems").default, row("production.hunterHulls").default], [30, 9000, true]);
    const resolve = (env) => config.resolveConfig({ modDir: MOD_DIR, env });
    const def = resolve({});
    assert.strictEqual(def.ok, true);
    assert.ok(!def.warnings.some((w) => w.includes("strategy.mobilizeFallbackJumps")), def.warnings.join("\n"));
    const low = resolve({ EVEJS_LNE_GRAPH_ROUTE_MAX_JUMPS: "20" });
    assert.ok(low.warnings.some((w) => w.includes("strategy.mobilizeFallbackJumps=30 above graph.routeMaxJumps=20")),
      low.warnings.join("\n"));
    assert.strictEqual(huntersNeedHullsOf(def.config), true);
    assert.strictEqual(huntersNeedHullsOf(resolve({ EVEJS_LNE_HUNT_ENABLED: "0" }).config), false);
    assert.strictEqual(huntersNeedHullsOf(resolve({ EVEJS_LNE_HUNT_MAX_HUNTERS_PER_FACTION: "0" }).config), false);
    assert.strictEqual(huntersNeedHullsOf(resolve({ EVEJS_LNE_PRODUCTION_HUNTER_HULLS: "0" }).config), false);
    for (const rel of ["lib/strategy/reviewService.js", "lib/economy/production/productionView.js"]) {
      const src = fs.readFileSync(path.join(MOD_DIR, rel), "utf8");
      assert.ok(/huntersNeedHulls: huntersNeedHullsOf\(config\)/.test(src), `${rel} uses the shared formula`);
    }
  });

  test("P2: 5 SoE start stations of the registry, the whole invasion template of soe-territorial-v1 "
    + "in the 4th -> rankMobilizationStations puts it first and the review launches the invasion mobilized there, no "
    + "NO_HULLS; live world: J-CIJV Guristas, ROIR-Y free, X-7OMU granted (before the grant CAPTURE_NOT_ADJACENT)",
  () => {
    const SOE = 500016;
    const entry = FACTIONS_V1.find((f) => f.factionId === SOE);
    const doctrine = DOCTRINES_V1.find((d) => d.doctrineId === entry.doctrineId);
    const full = Object.fromEntries(doctrine.templates.invasion.map((e) => [e.hullGroup, e.count]));
    const sys = [5, 5, 5, 4, 3];
    const stations = entry.startStations.map((s, i) => st(`npc-${s.stationId}`, sys[i], {}, i === 3 ? full : {}));
    const chosen = `npc-${entry.startStations[3].stationId}`;
    assert.strictEqual(chosen, "npc-60012598");
    const ranked = rankMobilizationStations(stations, hullTargets(doctrine, PROD), recipes, new Map());
    assert.strictEqual(ranked[0].stationId, chosen);
    const hostility = createHostility();
    const GURISTAS = 500010;
    const row = (systemId, c, homeFactionId = c) => ({ systemId, controllerFactionId: c, occupationState: "STABLE",
      controllerGarrison: 0, hostileStations: 0, observed: false, ownInfluence: 0, homeFactionId });
    const scene = (x7) => ({ v: 1, factionId: SOE, round: 3, at: AT, seed: 11,
      faction: { status: "ACTIVE", homeSystemId: 5, doctrineId: doctrine.doctrineId, resourceUnits: 100000,
        reserveUnits: 10000, frontLimit: 6, version: 1 },
      entry: { kind: entry.kind, maxActiveFronts: 6, allies: [], homeRegionIds: [], ownerCorporationId: 1000130 },
      doctrine: { ...doctrine, expandsBeyondTheatre: true }, theatre: [], expansion: [6], raidTargets: [],
      border: { mode: "off", reach: null, captures: false, candidates: [], rejected: 0 },
      neighbors: (id) => [id - 1, id + 1].filter((x) => x >= 1 && x <= 12), regionOf: () => null,
      isHostile: (x) => hostility(SOE, x), stationsMode: "ready",
      stations: stations.map((x) => ({ systemId: x.systemId, stationId: x.stationId })), captureAnchors: [3, 4, 5],
      systems: [x7, row(4, GURISTAS), row(3, null), row(6, null)], fleets: [], fleetsTruncated: false,
      operations: [], operationsTruncated: false, intel: [{ systemId: 6, observedAt: AT - HOUR, hostileFleets: 0,
        hostileShips: 0, hostileStrength: 0, hostileStations: 0, controllerFactionId: null }], sightings: [],
      occupations: [], territory: [], territoryTruncated: false, capturedIds: [], footholds: [],
      production: prodOf(stations) });
    const params = { ...PARAMS, captureRangeFromStationJumps: 15, mobilizeFallbackJumps: 0,
      maxOperationsPerReview: 2, frontLimitCap: 6, maxCapturedSystemsPerFaction: 150, captureRequiresAdjacency: true };
    const d = decideReview(scene(row(5, SOE)), params);
    const launch = d.intents.filter((i) => i.type === "LAUNCH");
    assert.deepStrictEqual(launch.map((i) => [i.kind, i.target.systemId, i.mobilize.map((m) => [m.stationId, m.role])]),
      [["invasion", 6, [[chosen, "invasion"]]]], JSON.stringify(d.notes));
    assert.ok(!d.notes.some((n) => n.startsWith("NO_HULLS")), JSON.stringify(d.notes));
    assert.ok(!d.notes.includes("CAPTURE_NOT_ADJACENT"), JSON.stringify(d.notes));
    const before = scene(row(5, GURISTAS));
    const supply = { captureRoom: null, border: new Map() };
    assert.deepStrictEqual([before, scene(row(5, SOE))].map((x) => captureBlock(x, supply, params,
      describe(x, params, new Map(), 6), 6)), ["CAPTURE_NOT_ADJACENT", null]);
    const b = decideReview(before, params);
    assert.deepStrictEqual(b.intents.filter((i) => i.type === "LAUNCH"), [], JSON.stringify(b.notes));
    assert.ok(b.notes.includes("NO_TARGET:NO_CANDIDATE"), JSON.stringify(b.notes));
  });
};
