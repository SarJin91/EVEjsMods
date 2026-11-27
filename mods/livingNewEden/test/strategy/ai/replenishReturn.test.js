"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { planReplenishReturns, relabelNoStock, REPLENISH_RETURN_PURPOSE } =
  require("../../../lib/strategy/ai/replenishReturn");
const { decideReview } = require("../../../lib/strategy/ai");
const { createHullLedger } = require("../../../lib/strategy/ai/hulls");
const { buildPowerTable, strengthOf } = require("../../../lib/strategy/ai/strength");
const { createOperationKinds } = require("../../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../../lib/strategy/data/operationKinds");
const { TARGET_SCORING_V1 } = require("../../../lib/strategy/data/targetScoring");
const { HULL_GROUPS, FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../../lib/fleets/schema");
const { GROUPS } = require("../../../lib/battle/data/strengthCatalog");
const RECIPES = require("../../../lib/economy/data/hullRecipes");
const { RETURN_ROWS } = require("../../../lib/strategy/reviewRows");
const { rowBoundsOfConfig } = require("../../../lib/strategy/reviewBound");
const { COUNTER_NAMES, NOTE_COUNTERS, replenishReturnParamsOf } = require("../../../lib/strategy/reviewService");
const { describeNote } = require("../../../lib/strategy/activity/notes");
const { resolveConfig } = require("../../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const AT = 1760000000000;
const HOUR = 3600000;
const MIN = 60000;
const F = 7;

const kinds = (() => {
  const k = createOperationKinds({ version: OPERATION_KINDS_VERSION, kinds: OPERATION_KINDS_V1 },
    { operationTypes: OPERATION_TYPES, objectives: OBJECTIVES, fleetRoles: FLEET_ROLES });
  assert.ok(k.ok, JSON.stringify(k));
  return k.kinds;
})();
const POWER = buildPowerTable(GROUPS);
const recipes = Object.fromEntries(Object.entries(RECIPES.GROUPS).map(([g, r]) => [g, { minerals: r.minerals }]));
const PROD = Object.freeze({ maxJobsPerReview: 2, maxRunsPerJob: 4, maxActiveJobsPerFaction: 8, targetStockFleets: 1,
  mobilizeHulls: "required", miningNeedsHulls: false, mobilizationStations: 1, hullGroups: [...HULL_GROUPS] });
const RR_ON = Object.freeze({ maxJumps: 15, minMissingPermille: 500, maxPerReview: 2, maxSearches: 6 });

const PARAMS = Object.freeze({ maxReachJumps: 10, supplyChainJumps: 10, captureRangeFromStationJumps: 5,
  maxAssemblyJumps: 15, maxBfsSystems: 2000, mobilizeFallbackJumps: 0, mobilizeFallbackMaxSystems: 2000,
  maxTargetCandidates: 40, targetPickTopK: 1, maxOperationsPerReview: 2, maxFleetsPerOperation: 4,
  maxFleetsPerFaction: 12, maxMobilizationsPerReview: 3, mobilizeResourcePerShip: 10, mobilizeReservePerShip: 1,
  attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR, maxObservationsPerReview: 8, reconWindowMs: HOUR / 2,
  attackWindowMs: 2 * HOUR, operationGraceMs: HOUR, maxHousekeepingPerReview: 4, maxRefitRequestsPerReview: 2,
  kinds: kinds.list, scoring: TARGET_SCORING_V1, powerTable: POWER, frontLimitCap: 2, routeMaxJumps: 40,
  production: PROD, replenish: Object.freeze({ maxReplenishPerReview: 2, maxShipsPerFleet: 500 }),
  returnFleetRoles: [...kinds.get("return").fleetRoles], returnKindEnabled: true, returnAfterIdleMs: 30 * MIN,
  returnWindowMs: 2 * HOUR });
const ON = Object.freeze({ ...PARAMS, replenishReturn: RR_ON });

const INVASION = Object.freeze([{ hullGroup: "cruiser", count: 10 }]);
const st = (stationId, systemId, hulls = {}) => ({ stationId, systemId, kind: "npc", lines: 2, activeJobs: [],
  minerals: {}, hulls });
const comp = (n, group = "cruiser") => (n > 0 ? [{ hullGroup: group, typeId: null, count: n }] : []);

function snap(o = {}) {
  const stations = o.stations || [st("st10", 10, { cruiser: 20 })];
  const row = (systemId) => ({ systemId, controllerFactionId: F, occupationState: "STABLE", controllerGarrison: 0,
    hostileStations: 0, observed: false });
  return { v: 1, factionId: F, round: 3, at: AT, seed: 11,
    faction: { status: "ACTIVE", homeSystemId: 10, doctrineId: "rr", resourceUnits: 100000, reserveUnits: 10000,
      frontLimit: 1, version: 1 },
    entry: { kind: "empire", maxActiveFronts: 1, allies: [], homeRegionIds: [], ownerCorporationId: 1 },
    doctrine: { doctrineId: "rr", canOccupy: true, reachJumps: 30, operationTypes: ["recon"],
      templates: { invasion: o.template || INVASION, garrison: INVASION } },
    theatre: [], expansion: [],
    neighbors: (id) => [id - 1, id + 1].filter((x) => x >= 1 && x <= 12), regionOf: () => null,
    isHostile: () => false,
    stationsMode: "ready", stations: stations.map((s) => ({ systemId: s.systemId, stationId: s.stationId })),
    systems: Array.from({ length: 12 }, (_, i) => row(i + 1)),
    fleets: o.fleets || [], fleetsTruncated: false, operations: [], operationsTruncated: false, intel: [],
    sightings: [], production: { mode: "ready", recipesVersion: 1, recipes, inProduction: {}, activeJobsTotal: 0,
      truncated: false, stations },
    ...(o.occupations ? { occupations: o.occupations } : {}) };
}

const fleet = (fleetId, systemId, have, extra = {}) => {
  const composition = extra.composition || comp(have);
  return { fleetId, version: 1, state: "IDLE", fleetRole: "invasion", systemId, refitPending: false,
    shipCount: composition.reduce((n, e) => n + e.count, 0), strength: strengthOf(composition, POWER),
    operationId: null, legSeq: 0, homeSystemId: systemId, composition, updatedAt: AT - 2 * HOUR, ...extra };
};

const plan = (s, params = ON, used = new Set()) => planReplenishReturns(s, params, createHullLedger(s, params), used);
const rrLaunches = (d) => d.intents.filter((i) => i.type === "LAUNCH" && i.purpose === REPLENISH_RETURN_PURPOSE);

module.exports = ({ test }) => {
  test("RR1 flag off: config defaults [false, 15, 500, 2, 6], params null, no warnings; decision byte-identical "
    + "with replenishReturn null / absent; relabelNoStock identity; review bound + 2 x RETURN_ROWS only with the flag",
  () => {
    const resolve = (env) => resolveConfig({ modDir: MOD_DIR, env });
    const def = resolve({});
    const L = def.config.logistics;
    assert.deepStrictEqual([L.replenishReturnEnabled, L.replenishReturnMaxJumps, L.replenishReturnMinMissingPermille,
      L.maxReplenishReturnsPerReview, L.replenishReturnMaxSearchesPerReview], [false, 15, 500, 2, 6]);
    assert.strictEqual(replenishReturnParamsOf(def.config), null);
    assert.deepStrictEqual(def.warnings, []);
    const on = resolve({ EVEJS_LNE_LOGISTICS_REPLENISH_RETURN_ENABLED: "1" });
    assert.deepStrictEqual(on.warnings.filter((w) => w.includes("replenishReturn")), []);
    assert.deepStrictEqual({ ...replenishReturnParamsOf(on.config) }, RR_ON);
    const noRep = resolve({ EVEJS_LNE_LOGISTICS_REPLENISH_RETURN_ENABLED: "1",
      EVEJS_LNE_LOGISTICS_REPLENISH_ENABLED: "0" });
    assert.strictEqual(replenishReturnParamsOf(noRep.config), null);
    assert.ok(noRep.warnings.includes(
      "logistics.replenishReturnEnabled has no effect while logistics.replenishEnabled=false"), noRep.warnings.join("|"));
    assert.strictEqual(rowBoundsOfConfig(on.config).review, rowBoundsOfConfig(def.config).review + 2 * RETURN_ROWS);

    const s = snap({ stations: [st("st5", 5, { frigate: 3 }), st("st10", 10, { cruiser: 20 })],
      fleets: [fleet("fa", 2, 2), fleet("fb", 5, 2)] });
    assert.ok(!Object.prototype.hasOwnProperty.call(PARAMS, "replenishReturn"), "P has no key");
    const off = decideReview(s, { ...PARAMS, replenishReturn: null });
    assert.strictEqual(off.outcome, "REVIEWED", JSON.stringify(off.reason));
    assert.strictEqual(JSON.stringify(off), JSON.stringify(decideReview(s, PARAMS)));
    assert.deepStrictEqual(rrLaunches(off), []);
    assert.ok(off.notes.includes("REPLENISH_NO_STOCK") && !off.notes.includes("REPLENISH_NO_STOCK_LOCAL"),
      JSON.stringify(off.notes));
    const n = ["REPLENISH_NO_STOCK"];
    assert.strictEqual(relabelNoStock(n, { replenishReturn: null }), n);
  });

  test("RR2 happy path: invasion fleet in STABLE 2 missing 80 %, station with cruisers 8 jumps away -> one LAUNCH "
    + "return to 10 (deterministic); next review in 10 -> REPLENISH there, no LAUNCH with purpose", () => {
    const s1 = snap({ fleets: [fleet("f1", 2, 2)] });
    const d1 = decideReview(s1, ON);
    assert.strictEqual(d1.outcome, "REVIEWED", JSON.stringify(d1.reason));
    const l = rrLaunches(d1);
    assert.strictEqual(l.length, 1, JSON.stringify(d1.notes));
    assert.deepStrictEqual(l[0], { type: "LAUNCH", kind: "return", target: { kind: "system", systemId: 10, ref: null },
      originSystemId: 2, fleets: [{ fleetId: "f1", expectedVersion: 1 }], mobilize: [], dueAt: AT + 2 * HOUR,
      purpose: "REPLENISH_RETURN" });
    assert.ok(d1.notes.includes("REPLENISH_RETURN"), JSON.stringify(d1.notes));
    assert.deepStrictEqual(decideReview(s1, ON), d1, "deterministic");

    const s2 = snap({ fleets: [fleet("f1", 10, 2, { version: 3 })] });
    const d2 = decideReview(s2, ON);
    const rep = d2.intents.filter((i) => i.type === "REPLENISH");
    assert.deepStrictEqual(rep.map((i) => [i.fleetId, i.stationId, i.add]),
      [["f1", "st10", [{ hullGroup: "cruiser", count: 8 }]]], JSON.stringify(d2.notes));
    assert.deepStrictEqual(rrLaunches(d2), []);
  });

  test("RR3 no intent: HOLDING / FOOTHOLD_HOLDING / DEFENDING, used, refit, garrison, 40 % missing, idle 10 min, "
    + "local hulls; no updatedAt -> only RETURN_NO_IDLE_SINCE; a claim holder through decideReview", () => {
    const stations = [st("st5", 5, { cruiser: 1 }), st("st10", 10, { cruiser: 20 })];
    const rows = [
      ["HOLDING", fleet("f1", 2, 2, { state: "HOLDING" })],
      ["FOOTHOLD_HOLDING", fleet("f1", 2, 2, { state: "FOOTHOLD_HOLDING" })],
      ["DEFENDING", fleet("f1", 2, 2, { state: "DEFENDING" })],
      ["used", fleet("f1", 2, 2), new Set(["f1"])],
      ["refit", fleet("f1", 2, 2, { refitPending: true })],
      ["garrison", fleet("f1", 2, 2, { fleetRole: "garrison" })],
      ["missing 40 %", fleet("f1", 2, 6)],
      ["idle 10 min", fleet("f1", 2, 2, { updatedAt: AT - 10 * MIN })],
      ["local hulls", fleet("f1", 5, 2)],
    ];
    const out = rows.map(([name, f, used]) => {
      const r = plan(snap({ stations, fleets: [f] }), ON, used || new Set());
      return [name, r.intents.length, r.notes];
    });
    assert.deepStrictEqual(out, rows.map(([name]) => [name, 0, []]));
    const noIdle = plan(snap({ stations, fleets: [fleet("f1", 2, 2, { updatedAt: null })] }));
    assert.deepStrictEqual([noIdle.intents, noIdle.notes], [[], ["RETURN_NO_IDLE_SINCE"]]);
    assert.strictEqual(plan(snap({ stations, fleets: [fleet("f1", 2, 2)] })).intents.length, 1);

    const claim = snap({ fleets: [fleet("f1", 2, 2)],
      occupations: [{ systemId: 2, occupier: F, state: "INVASION", sinceAt: AT - HOUR }] });
    const hold = { ...ON, claimHold: { maxMs: 24 * HOUR, states: ["INVASION"], roles: ["invasion"] } };
    const held = decideReview(claim, hold);
    assert.ok(held.notes.includes("CLAIM_HOLD"), JSON.stringify(held.notes));
    assert.deepStrictEqual(rrLaunches(held), []);
    assert.strictEqual(rrLaunches(decideReview(claim, ON)).length, 1, "without claimHold the fleet flies");
  });

  test("RR4 target, limits, promised: no stock -> NO_STOCK; maxPerReview 2 of 3 -> LIMIT; same hulls -> second "
    + "station; tie -> fewer jumps, then stationId; maxSearches 1 -> SEARCH_LIMIT", () => {
    const targets = (r) => r.intents.map((i) => [i.fleets[0].fleetId, i.target.systemId]);
    const empty = plan(snap({ stations: [st("st10", 10, { frigate: 9 })], fleets: [fleet("f1", 2, 2)] }));
    assert.deepStrictEqual([empty.intents, empty.notes], [[], ["REPLENISH_RETURN_NO_STOCK"]]);
    const far = plan(snap({ fleets: [fleet("f1", 2, 2)] }), { ...ON, replenishReturn: { ...RR_ON, maxJumps: 5 } });
    assert.deepStrictEqual([far.intents, far.notes], [[], ["REPLENISH_RETURN_NO_STOCK"]]);
    const three = plan(snap({ fleets: [fleet("f1", 2, 2), fleet("f2", 3, 2), fleet("f3", 4, 2)] }));
    assert.deepStrictEqual([targets(three), three.notes],
      [[["f1", 10], ["f2", 10]], ["REPLENISH_RETURN", "REPLENISH_RETURN_LIMIT"]]);
    const bc = { template: [{ hullGroup: "battlecruiser", count: 3 }] };
    const promised = plan(snap({ ...bc, stations: [st("sA", 6, { battlecruiser: 3 }), st("sB", 10, { battlecruiser: 3 })],
      fleets: [fleet("f1", 2, 0), fleet("f2", 2, 0)] }));
    assert.deepStrictEqual(targets(promised), [["f1", 6], ["f2", 10]]);
    const near = plan(snap({ ...bc, stations: [st("s-z", 4, { battlecruiser: 3 }), st("s-b", 8, { battlecruiser: 3 })],
      fleets: [fleet("f1", 2, 0)] }));
    assert.deepStrictEqual(targets(near), [["f1", 4]]);
    const tie = plan(snap({ ...bc, stations: [st("s-b", 4, { battlecruiser: 3 }), st("s-a", 8, { battlecruiser: 3 })],
      fleets: [fleet("f1", 6, 0)] }));
    assert.deepStrictEqual(targets(tie), [["f1", 8]]);
    const budget = plan(snap({ stations: [st("st10", 10, { frigate: 9 })], fleets: [fleet("f1", 2, 2), fleet("f2", 3, 2)] }),
      { ...ON, replenishReturn: { ...RR_ON, maxSearches: 1 } });
    assert.deepStrictEqual([budget.intents, budget.notes],
      [[], ["REPLENISH_RETURN_NO_STOCK", "REPLENISH_RETURN_SEARCH_LIMIT"]]);
  });

  test("RR5 notes and counters: flag on -> REPLENISH_NO_STOCK_LOCAL instead of REPLENISH_NO_STOCK; 3 counter names; "
    + "NOTE_COUNTERS closed over COUNTER_NAMES; describeNote knows the 5 codes", () => {
    const s = snap({ stations: [st("st5", 5, { frigate: 3 }), st("st10", 10, { cruiser: 20 })],
      fleets: [fleet("fb", 5, 2)] });
    const d = decideReview(s, ON);
    assert.ok(d.notes.includes("REPLENISH_NO_STOCK_LOCAL") && !d.notes.includes("REPLENISH_NO_STOCK"),
      JSON.stringify(d.notes));
    assert.deepStrictEqual(rrLaunches(d).map((i) => i.target.systemId), [10]);
    for (const c of ["replenishReturns", "replenishReturnNoStock", "replenishNoStock"]) {
      assert.ok(COUNTER_NAMES.includes(c), c);
    }
    assert.deepStrictEqual([NOTE_COUNTERS.REPLENISH_NO_STOCK, NOTE_COUNTERS.REPLENISH_NO_STOCK_LOCAL,
      NOTE_COUNTERS.REPLENISH_RETURN_NO_STOCK], ["replenishNoStock", "replenishNoStock", "replenishReturnNoStock"]);
    assert.ok(Object.values(NOTE_COUNTERS).every((c) => COUNTER_NAMES.includes(c)));
    assert.deepStrictEqual(["REPLENISH_RETURN", "REPLENISH_RETURN_NO_STOCK", "REPLENISH_RETURN_LIMIT",
      "REPLENISH_RETURN_SEARCH_LIMIT", "REPLENISH_NO_STOCK_LOCAL"].map((c) => {
      const x = describeNote(c);
      return [c, x.known, x.category];
    }), [["REPLENISH_RETURN", true, "informacja"], ["REPLENISH_RETURN_NO_STOCK", true, "blokada"],
      ["REPLENISH_RETURN_LIMIT", true, "informacja"], ["REPLENISH_RETURN_SEARCH_LIMIT", true, "informacja"],
      ["REPLENISH_NO_STOCK_LOCAL", true, "oczekiwane"]]);
  });
};

module.exports.harness = { snap, st, fleet, comp, PARAMS, RR_ON, F, AT };
