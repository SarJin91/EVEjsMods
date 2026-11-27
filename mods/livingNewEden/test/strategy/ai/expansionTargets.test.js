"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { pickExpansion, expansionCandidates } = require("../../../lib/strategy/ai/expansion");
const { createHostility } = require("../../../lib/battle/data/hostility");
const { decideReview } = require("../../../lib/strategy/ai");
const { adjacentOwn, describe, captureBlock } = require("../../../lib/strategy/ai/targeting");
const { buildPowerTable, strengthOf } = require("../../../lib/strategy/ai/strength");
const { createOperationKinds } = require("../../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../../lib/strategy/data/operationKinds");
const { TARGET_SCORING_V1 } = require("../../../lib/strategy/data/targetScoring");
const { DOCTRINES_V1 } = require("../../../lib/strategy/data/doctrines");
const { FACTIONS_V1 } = require("../../../lib/strategy/data/factions");
const { FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../../lib/fleets/schema");
const { GROUPS } = require("../../../lib/battle/data/strengthCatalog");
const { reviewRowBound } = require("../../../lib/strategy/reviewRows");
const { resolveConfig } = require("../../../config");
const { createManualClock } = require("../../../lib/util/clock");
const { createRng } = require("../../../lib/util/rng");
const { createIdGenerator } = require("../../../lib/util/ids");
const { harness: H } = require("../../battle/settlement.test");
const { harness: R } = require("../review.test");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const AT = 1760000000000;
const HOUR = 3600000;
const F = 7;
const HOSTILE = 9;
const PASSIVE = 11;
const SANSHA = 500019;
const GUARDS = { GURISTAS: 500010, ANGELS: 500011, BLOOD: 500012, SERPENTIS: 500020 };

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
  maxCapturedSystemsPerFaction: 150, captureRequiresAdjacency: true });

const doctrineOf = (factionId) => {
  const entry = FACTIONS_V1.find((x) => x.factionId === factionId);
  const d = DOCTRINES_V1.find((x) => x.doctrineId === entry.doctrineId);
  return { ...d, expandsBeyondTheatre: true };
};

const row = (systemId, controllerFactionId, extra = {}) => ({ systemId, controllerFactionId, occupationState: "STABLE",
  controllerGarrison: 0, hostileStations: 0, observed: false, ownInfluence: 0, ...extra });
const intelOf = (systemId, controllerFactionId, hostileStrength = 0) => ({ systemId, observedAt: AT - HOUR,
  hostileFleets: 0, hostileShips: 0, hostileStrength, hostileStations: 0, controllerFactionId });
const wing = (fleetId, systemId) => ({ fleetId, version: 2, state: "IDLE", fleetRole: "invasion", systemId,
  refitPending: false, shipCount: 6, strength: strengthOf(WING, POWER), operationId: null, legSeq: 0, homeSystemId: 5,
  updatedAt: AT - HOUR });

function snap(o) {
  return { v: 1, factionId: F, round: 3, at: AT, seed: 11,
    faction: { status: "ACTIVE", homeSystemId: 5, doctrineId: o.doctrine.doctrineId, resourceUnits: 100000,
      reserveUnits: 10000, frontLimit: 6, version: 1 },
    entry: { kind: o.doctrine.kind, maxActiveFronts: 6, allies: [], homeRegionIds: [], ownerCorporationId: 1 },
    doctrine: o.doctrine, theatre: [], expansion: o.expansion || [], raidTargets: [],
    border: o.border || { mode: "off", reach: null, captures: false, candidates: [], rejected: 0 },
    neighbors: (id) => [id - 1, id + 1].filter((x) => x >= 1 && x <= 12), regionOf: () => null,
    isHostile: (x) => x === HOSTILE || x === PASSIVE, ...(o.isPlaying ? { isPlaying: o.isPlaying } : {}),
    stationsMode: "ready", stations: [{ systemId: 5, stationId: "st5" }], captureAnchors: [5],
    systems: [row(5, F), ...o.systems], fleets: o.fleets || [wing("w1", 5), wing("w2", 5)], fleetsTruncated: false,
    operations: [], operationsTruncated: false, intel: o.intel || [], sightings: [], occupations: [], territory: [],
    territoryTruncated: false, capturedIds: o.capturedIds || [], footholds: [] };
}
const launches = (d) => d.intents.filter((i) => i.type === "LAUNCH").map((i) => [i.kind, i.target.systemId]);

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("EX1: Guristas, Angels, Blood Raiders and Serpentis (doctrine of the registry) take a free system with "
    + "fresh intel by LAUNCH invasion", () => {
    const got = Object.values(GUARDS).map((id) => launches(decideReview(snap({ doctrine: doctrineOf(id),
      systems: [row(6, null)], expansion: [6], intel: [intelOf(6, null)] }), PARAMS)));
    assert.deepStrictEqual(got, Object.values(GUARDS).map(() => [["invasion", 6]]));
  });

  test("EX2 pickExpansion: 70 own systems before 10 free in the scan -> the free ones, order of the scan, limit "
    + "limit 0 / no scan -> none", () => {
    const own = Array.from({ length: 70 }, (_, i) => 1000 + i);
    const free = Array.from({ length: 10 }, (_, i) => 2000 + i);
    const accept = (id) => id >= 2000;
    assert.deepStrictEqual(pickExpansion([...own, ...free], accept, 64), free);
    assert.deepStrictEqual(pickExpansion([...own, ...free], accept, 3), free.slice(0, 3));
    assert.deepStrictEqual([pickExpansion([...free], accept, 0), pickExpansion(undefined, accept, 3)], [[], []]);
  });

  needsDriver("EX2b readSnapshot on a real store: an own expansion system leaves the candidates, its row "
    + "stays in snapshot.systems (adjacentOwn); a passive controller is no candidate unless "
    + "strategy.targetPassiveControllers", async () => {
    const run = (env) => H.withStore(driver, async (reopen) => {
      const clock = createManualClock(R.START_MS);
      const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(53) }), graph: R.graphOf(),
        controllers: new Map(R.THEATRE.map((id) => [id, null])) };
      const seen = [];
      const hooks = { beforeEffect: (d, snapshot) => {
        if (d.factionId === SANSHA) seen.push(snapshot);
        return d;
      } };
      const e = await R.bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: String(SANSHA),
        EVEJS_LNE_STRATEGY_CAMPAIGNS: "none", EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8",
        EVEJS_LNE_PRODUCTION_TARGET_STOCK_FLEETS: "0", ...env }, { hooks });
      await R.passesAt(e, shared, R.START_MS + R.I);
      assert.ok(seen.length >= 1 && seen[0].expansion.length >= 2, JSON.stringify(seen.map((s) => s.expansion)));
      const [mine, drones] = seen[0].expansion;
      shared.controllers.set(mine, SANSHA);
      shared.controllers.set(drones, 500025);
      await R.passesAt(e, shared, R.START_MS + 2 * R.I);
      e.strategy.stop("test");
      const s = seen[seen.length - 1];
      const nb = shared.graph.getNeighbors(mine).find((id) => id !== mine);
      return { mine, drones, expansion: s.expansion, row: s.systems.find((x) => x.systemId === mine) || null,
        adjacent: adjacentOwn(s, { border: new Map() }, nb), playing: s.isPlaying(500025) };
    });
    const off = await run({});
    assert.ok(!off.expansion.includes(off.mine) && !off.expansion.includes(off.drones), JSON.stringify(off.expansion));
    assert.deepStrictEqual([off.row && off.row.controllerFactionId, off.adjacent, off.playing], [SANSHA, true, false]);
    const on = await run({ EVEJS_LNE_STRATEGY_TARGET_PASSIVE_CONTROLLERS: "1" });
    assert.ok(on.expansion.includes(on.drones) && !on.expansion.includes(on.mine), JSON.stringify(on.expansion));
  });

  test("EX3 limit: 149 captured -> invasion, 150 -> TERRITORY_LIMIT and no capture", () => {
    const scene = (n) => snap({ doctrine: doctrineOf(GUARDS.GURISTAS), systems: [row(6, null)], expansion: [6],
      intel: [intelOf(6, null)], capturedIds: Array.from({ length: n }, (_, i) => 5000 + i) });
    const room = decideReview(scene(149), PARAMS);
    assert.deepStrictEqual(launches(room), [["invasion", 6]]);
    assert.ok(!room.notes.includes("TERRITORY_LIMIT"), JSON.stringify(room.notes));
    const full = decideReview(scene(150), PARAMS);
    assert.deepStrictEqual(launches(full).filter((l) => l[0] === "invasion"), []);
    assert.deepStrictEqual(resolveConfig({ modDir: MOD_DIR, env: {} }).config.strategy.maxCapturedSystemsPerFaction, 150);
  });

  test("EX4: empire and pirate take a stable hostile neighbour (category hostile); isPlaying false -> no "
    + "capture; isPlaying true -> capture", () => {
    const AMARR = 500003;
    const hostile = (id, o = {}) => {
      const s = snap({ doctrine: doctrineOf(id), systems: [row(6, HOSTILE)], expansion: [6],
        intel: [intelOf(6, HOSTILE)], ...o });
      s.doctrine = { ...s.doctrine, expandsBeyondTheatre: true };
      return s;
    };
    for (const id of [AMARR, GUARDS.GURISTAS, SANSHA]) {
      const s = hostile(id);
      assert.strictEqual(describe(s, PARAMS, new Map(), 6).category, "hostile", String(id));
      assert.deepStrictEqual(launches(decideReview(s, PARAMS)), [["invasion", 6]], String(id));
    }
    const passive = hostile(GUARDS.GURISTAS, { isPlaying: () => false });
    assert.deepStrictEqual([describe(passive, PARAMS, new Map(), 6).captureAllowed,
      launches(decideReview(passive, PARAMS))], [false, []]);
    const playing = hostile(GUARDS.GURISTAS, { isPlaying: () => true });
    assert.deepStrictEqual(launches(decideReview(playing, PARAMS)), [["invasion", 6]]);
  });

  test("EX5 INSUFFICIENT_FORCE on a strong target -> the next, weaker target gets its LAUNCH in the same review "
    + "the note once", () => {
    const s = snap({ doctrine: doctrineOf(GUARDS.GURISTAS), systems: [row(6, HOSTILE), row(4, null)], expansion: [6, 4],
      intel: [intelOf(6, HOSTILE, 1e9), intelOf(4, null)], fleets: [wing("w1", 5)] });
    const d = decideReview(s, { ...PARAMS, maxFleetsPerOperation: 1 });
    assert.deepStrictEqual(launches(d), [["invasion", 4]], JSON.stringify(d.notes));
    assert.strictEqual(d.notes.filter((n) => n === "INSUFFICIENT_FORCE").length, 1, JSON.stringify(d.notes));
  });

  test("EX6 compose profile (tribute, treasury, merge, garrison release on): review bound 997, no bound "
    + "or fleet-sum warning; trade.wtsEnabled would pass the limit", () => {
    const profile = { EVEJS_LNE_TRIBUTE_ENABLED: "1", EVEJS_LNE_TREASURY_ENABLED: "1",
      EVEJS_LNE_STRATEGY_MERGE_ENABLED: "1", EVEJS_LNE_STRATEGY_PATROL_ENABLED: "1",
      EVEJS_LNE_STRATEGY_GARRISON_REINFORCE_ENABLED: "1" };
    const r = resolveConfig({ modDir: MOD_DIR, env: profile });
    const c = r.config;
    const args = [c.strategy, c.mining, c.production,
      { maxAbandonsPerReview: c.upkeep.maxAbandonsPerReview, maxFactionsPerSystem: c.world.maxFactionsPerSystem },
      c.logistics, c.construction, { maxReliefPerReview: c.siege.maxReliefPerReview },
      { maxOffersPerReview: c.trade.maxOffersPerReview, maxCancelsPerReview: c.trade.maxCancelsPerReview },
      { maxDefensePerReview: c.strategy.maxDefensePerReview }, {}, { pruneBatch: c.treasury.pruneBatch },
      { maxMergesPerReview: c.strategy.maxMergesPerReview }];
    assert.strictEqual(reviewRowBound(...args), 997);
    assert.ok(!r.warnings.some((w) => w.includes("may write") || w.includes("maxFleetsReadPerReview")),
      r.warnings.join("\n"));
    assert.strictEqual(reviewRowBound({ ...c.strategy, garrisonReleaseEnabled: false }, ...args.slice(1)), 991);
    const wts = resolveConfig({ modDir: MOD_DIR, env: { ...profile, EVEJS_LNE_TRADE_WTS_ENABLED: "1" } });
    assert.ok(wts.warnings.some((w) => w.includes("one strategy review may write 1009 rows")),
      wts.warnings.join("\n"));
  });

  test("P1 (live world): X-7OMU granted to 500016 (controller + home), J-CIJV under "
    + "Guristas -> soe-territorial-v1 takes the free nullsec neighbour by LAUNCH invasion; before the grant (X-7OMU "
    + "under Guristas) CAPTURE_NOT_ADJACENT and no LAUNCH; free lowsec is no candidate; a system of 500001 has "
    + "category null", () => {
    const SOE = 500016;
    const GURISTAS = GUARDS.GURISTAS;
    const doctrine = doctrineOf(SOE);
    assert.deepStrictEqual([doctrine.doctrineId, [...doctrine.targetSecClasses]], ["soe-territorial-v1", ["nullsec"]]);
    const hostility = createHostility();
    const soeSnap = (o, x7 = row(5, SOE, { homeFactionId: SOE })) => {
      const s = snap({ doctrine, ...o });
      s.systems[0] = x7;
      s.systems.push(row(4, GURISTAS, { homeFactionId: GURISTAS }), row(3, null));
      return { ...s, factionId: SOE, isHostile: (x) => hostility(SOE, x),
        stations: [5, 5, 5, 4, 3].map((id, i) => ({ systemId: id, stationId: `st${i}` })), captureAnchors: [3, 4, 5] };
    };
    const granted = soeSnap({ systems: [row(6, null)], expansion: [6], intel: [intelOf(6, null)] });
    assert.strictEqual(describe(granted, PARAMS, new Map(), 6).category, "free");
    const g = decideReview(granted, PARAMS);
    assert.deepStrictEqual(launches(g), [["invasion", 6]], JSON.stringify(g.notes));
    assert.ok(!g.notes.includes("CAPTURE_NOT_ADJACENT"), JSON.stringify(g.notes));
    const before = soeSnap({ systems: [row(6, null)], expansion: [6], intel: [intelOf(6, null)] },
      row(5, GURISTAS, { homeFactionId: GURISTAS }));
    const supply = { captureRoom: null, border: new Map() };
    const blockOf = (s) => captureBlock(s, supply, PARAMS, describe(s, PARAMS, new Map(), 6), 6);
    assert.deepStrictEqual([blockOf(before), blockOf(granted)], ["CAPTURE_NOT_ADJACENT", null]);
    const b = decideReview(before, PARAMS);
    assert.deepStrictEqual(launches(b), [], JSON.stringify(b.notes));
    assert.ok(b.notes.includes("NO_TARGET:NO_CANDIDATE"), JSON.stringify(b.notes));
    const SEC = { 4: "lowsec", 5: "nullsec", 6: "nullsec" };
    const scan = expansionCandidates({ enabled: true, stationSystems: [5], theatre: [],
      neighbors: (id) => [id - 1, id + 1].filter((x) => SEC[x] !== undefined),
      getSystem: (id) => (SEC[id] ? { secClass: SEC[id], regionId: 10000023 } : null), jumps: 1, maxSystems: 100,
      limit: 8 });
    assert.deepStrictEqual([scan.includes(6), scan.includes(4)], [true, false], JSON.stringify(scan));
    const empire = soeSnap({ systems: [row(6, 500001)], expansion: [6], intel: [intelOf(6, 500001)] });
    assert.strictEqual(describe(empire, PARAMS, new Map(), 6).category, null);
    assert.deepStrictEqual(launches(decideReview(empire, PARAMS)), []);
  });
};
