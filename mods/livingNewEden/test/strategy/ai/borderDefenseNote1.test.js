"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const { resolveConfig } = require("../../../config");
const { planMining } = require("../../../lib/strategy/ai/mining");
const { hotSystems } = require("../../../lib/strategy/ai/garrison");
const { planMinerEscorts } = require("../../../lib/strategy/ai/minerEscorts");
const { observationFronts } = require("../../../lib/strategy/ai/housekeeping");
const { decideReview } = require("../../../lib/strategy/ai");
const { buildPowerTable, strengthOf } = require("../../../lib/strategy/ai/strength");
const { createOperationKinds } = require("../../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../../lib/strategy/data/operationKinds");
const { TARGET_SCORING_V1 } = require("../../../lib/strategy/data/targetScoring");
const { FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../../lib/fleets/schema");
const { GROUPS } = require("../../../lib/battle/data/strengthCatalog");
const { INTEL_TABLE_NAME } = require("../../../lib/strategy/schema");
const { createManualClock } = require("../../../lib/util/clock");
const { createRng } = require("../../../lib/util/rng");
const { createIdGenerator } = require("../../../lib/util/ids");
const { harness: H } = require("../../battle/settlement.test");
const { harness: R } = require("../review.test");

const AT = 1760000000000;
const HOUR = 3600000;
const F = 7;
const HOSTILE = 9;

const kinds = (() => {
  const k = createOperationKinds({ version: OPERATION_KINDS_VERSION, kinds: OPERATION_KINDS_V1 },
    { operationTypes: OPERATION_TYPES, objectives: OBJECTIVES, fleetRoles: FLEET_ROLES });
  assert.ok(k.ok, JSON.stringify(k));
  return k.kinds;
})();
const POWER = buildPowerTable(GROUPS);
const SIX = [{ hullGroup: "cruiser", typeId: null, count: 6 }];
const ESCORT = Object.freeze({ maxPerFaction: 2, maxPerReview: 2, windowMs: HOUR, minShiftLeftMs: HOUR / 2,
  threatJumps: 2, secClasses: Object.freeze(["lowsec", "nullsec"]), minShips: 3, idleMs: HOUR / 4, maxJumps: 4,
  maxEnemyRatio: 1.5, defensiveSharePermille: 1000 });
const POSTS = Object.freeze({ maxPerFaction: 3, maxPerReview: 2, windowMs: HOUR, idleMs: HOUR / 4, minShips: 6,
  maxJumps: 0, maxEnemyRatio: 1.5, secClasses: Object.freeze(["lowsec", "nullsec"]), defensiveSharePermille: 1000 });
const HUNT = Object.freeze({ enabled: true, maxHuntersPerFaction: 0, strikeMaxJumps: 5, dwellMs: 300000,
  maxBfsSystems: 500 });
const MINING = (() => {
  const r = resolveConfig({ modDir: path.resolve(__dirname, "..", "..", ".."), env: { EVEJS_DATA_ROOT: os.tmpdir() } });
  assert.deepStrictEqual(r.errors || [], []);
  assert.strictEqual(r.config.mining.avoidHostileIntel, true);
  return Object.freeze({ ...r.config.mining });
})();

const PARAMS = Object.freeze({ maxReachJumps: 10, supplyChainJumps: 10, captureRangeFromStationJumps: 5,
  maxAssemblyJumps: 8, maxBfsSystems: 2000, mobilizeFallbackJumps: 0, mobilizeFallbackMaxSystems: 2000,
  maxTargetCandidates: 40, targetPickTopK: 1, maxOperationsPerReview: 2, maxFleetsPerOperation: 4,
  maxFleetsPerFaction: 12, maxMobilizationsPerReview: 3, mobilizeResourcePerShip: 10, mobilizeReservePerShip: 1,
  attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR, maxObservationsPerReview: 8, reconWindowMs: HOUR / 2,
  attackWindowMs: 2 * HOUR, operationGraceMs: HOUR, maxHousekeepingPerReview: 4, maxRefitRequestsPerReview: 2,
  returnAfterIdleMs: HOUR / 2, returnWindowMs: 2 * HOUR, maxReturnsPerReview: 3,
  returnFleetRoles: [...kinds.get("return").fleetRoles],
  kinds: kinds.list, scoring: TARGET_SCORING_V1, powerTable: POWER, frontLimitCap: 2, routeMaxJumps: 40,
  minerEscort: ESCORT });

function fleet(fleetId, systemId, extra = {}) {
  return { fleetId, version: 3, state: "IDLE", fleetRole: "patrol", systemId, refitPending: false, shipCount: 6,
    strength: strengthOf(SIX, POWER), composition: SIX, operationId: null, legSeq: 0, homeSystemId: systemId,
    updatedAt: AT - HOUR, ...extra };
}
const miner = (fleetId, systemId, ships = 3) => fleet(fleetId, systemId, { fleetRole: "mining", state: "STAGED",
  operationId: `op-${fleetId}`, shipCount: ships });
const trip = (fleetId, systemId, extra = {}) => ({ tripId: `t-${fleetId}`, fleetId, systemId, secClass: "lowsec",
  state: "MINING", miningEndsAt: AT + 2 * HOUR, ...extra });
const intel = (systemId, hostileStrength) => ({ systemId, observedAt: AT - 60000, hostileFleets: 1, hostileShips: 6,
  hostileStrength, hostileStations: 0, controllerFactionId: null });

function snap(o = {}) {
  const own = (systemId) => ({ systemId, controllerFactionId: F, occupationState: "STABLE", controllerGarrison: 0,
    hostileStations: 0, observed: false });
  const s = { v: 1, factionId: F, round: 3, at: AT, seed: 11,
    faction: { status: "ACTIVE", homeSystemId: 20, doctrineId: "es", resourceUnits: 100000, reserveUnits: 10000,
      frontLimit: 1, version: 1 },
    entry: { kind: "empire", maxActiveFronts: 1, allies: [], homeRegionIds: [], ownerCorporationId: 1 },
    doctrine: { doctrineId: "es", canOccupy: false, reachJumps: 30, operationTypes: ["recon", "defense", "return"],
      fieldsHunters: true, templates: { scout: [{ hullGroup: "frigate", count: 1 }],
        mining: [{ hullGroup: "mining_frigate", count: 3 }] } },
    theatre: [], expansion: [],
    neighbors: (id) => [id - 1, id + 1].filter((x) => x >= 1 && x <= 40), regionOf: () => null,
    isHostile: (x) => x === HOSTILE, isPlaying: () => true, isHive: () => false,
    stationsMode: "ready", stations: [{ systemId: 20, stationId: "st20" }],
    systems: [own(20), own(21)],
    fleets: o.fleets || [fleet("e20", 20), fleet("e30", 30, { updatedAt: AT }), miner("m18", 18), miner("m30", 30, 2),
      miner("m30b", 30, 4)],
    fleetsTruncated: false, operations: [], operationsTruncated: false,
    intel: o.intel || [], sightings: [], occupations: [], territory: [], territoryTruncated: false,
    mining: { mode: "ready", sites: [18, 21, 22, 30].map((systemId) => ({ systemId, richnessPermille: 500,
      projected: true })), openByBelt: [], busyFleetIds: [],
    openTrips: [trip("m18", 18), trip("m30", 30, { miningEndsAt: AT + 3 * HOUR }), trip("m30b", 30)] },
    borderLine: [{ systemId: 30, secClass: "lowsec", neighbours: [] }],
    threats: { mode: "ready", items: [] } };
  if (o.extraIntel) s.extraIntel = o.extraIntel;
  return s;
}

const escortPlan = (s) => planMinerEscorts(s, null, PARAMS, new Set(), 2, {});
const miningPlan = (s) => planMining(s, { stationSystems: [20] }, { ...PARAMS, mining: MINING }, null);
const hot = (s) => [...hotSystems(s, PARAMS)].sort((a, b) => a - b);

module.exports = ({ test, skip }) => {
  test("N1: extra intel in snapshot.extraIntel - mining and garrison plans as without it, the escort "
    + "plan as with the rows in intel", () => {
    const rows = [intel(21, 40), intel(22, 40), intel(16, 50)];
    const base = snap();
    const extra = snap({ extraIntel: rows });
    const merged = snap({ intel: rows });
    const got = {
      mining: JSON.stringify(miningPlan(extra)) === JSON.stringify(miningPlan(base)),
      garrison: [hot(extra), hot(base), hot(merged)],
      miningSeesIntel: JSON.stringify(miningPlan(merged)) !== JSON.stringify(miningPlan(base)),
      escort: JSON.stringify(escortPlan(extra)) === JSON.stringify(escortPlan(merged)),
      escortSeesExtra: JSON.stringify(escortPlan(extra)) !== JSON.stringify(escortPlan(base)),
    };
    assert.deepStrictEqual(got, { mining: true, garrison: [[], [], [16, 21, 22]], miningSeesIntel: true, escort: true,
      escortSeesExtra: true });
  });

  test("N3: observationFronts excludes blockade, escort and patrol", () => {
    const op = (operationType, targetSystemId) => ({ operationType, targetSystemId });
    assert.deepStrictEqual(observationFronts([op("blockade", 1), op("escort", 2), op("patrol", 3), op("recon", 4),
      op("invasion", 5), op("recon", 4)]), [4, 5]);
  });

  test("N5: a LAUNCH hunt takes an operation slot from the posts and the escorts", () => {
    const s = snap({ intel: [intel(16, 50), intel(35, 50)], fleets: [fleet("e20", 19, { homeSystemId: 20 }),
      fleet("e30", 30, { updatedAt: AT }), fleet("p34", 34), fleet("h20", 20, { fleetRole: "hunter" }),
      miner("m18", 18), miner("m30", 30, 2), miner("m30b", 30, 4)] });
    s.borderLine = [{ systemId: 34, secClass: "lowsec", neighbours: [{ systemId: 35, controllerFactionId: null }] },
      { systemId: 30, secClass: "lowsec", neighbours: [] }];
    s.huntReady = true;
    s.coreOwners = new Map();
    const p = { ...PARAMS, maxOperationsPerReview: 3, borderPosts: POSTS, hunt: HUNT };
    const d = decideReview(s, p);
    assert.strictEqual(d.outcome, "REVIEWED", d.reason);
    const launches = d.intents.filter((i) => i.type === "LAUNCH" && i.kind !== "return");
    assert.deepStrictEqual({ kinds: launches.map((i) => i.kind).sort(), max: p.maxOperationsPerReview }, {
      kinds: ["blockade", "escort", "hunt"], max: 3 });
  });

  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  async function bootWithTrip(reopen, env, hooks) {
    const clock = createManualClock(R.START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(53) }), graph: R.graphOf(),
      controllers: new Map(R.THEATRE.map((id) => [id, R.SANSHA])) };
    const e = await R.bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: String(R.SANSHA),
      EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8", EVEJS_LNE_PRODUCTION_TARGET_STOCK_FLEETS: "0",
      EVEJS_LNE_STRATEGY_MINER_ESCORT_ENABLED: "1", ...env }, { hooks, mining: true });
    const base = e.q("SELECT system_id FROM world_stations WHERE owner_faction_id = ? AND state = 'ONLINE' "
      + "ORDER BY station_id", R.SANSHA)[0];
    assert.ok(base, "a Sansha station");
    const c = e.fleets.createFleet({ factionId: R.SANSHA, currentSystemId: base.system_id,
      homeSystemId: base.system_id, fleetRole: "mining",
      composition: [{ hullGroup: "mining_frigate", typeId: null, count: 3 }] }, "n1m:create");
    assert.ok(c.ok, JSON.stringify(c));
    e.tx((db) => db.prepare(`INSERT INTO world_mining_trips (trip_id, idempotency_key, faction_id, fleet_id,
      origin_system_id, belt_system_id, state, sec_class, richness_permille, mining_ends_at, dispatched_at, created_at,
      updated_at, version) VALUES (?, ?, ?, ?, ?, ?, 'MINING', 'nullsec', 500, ?, ?, ?, ?, 1)`)
      .run("trip-n1", "n1:trip", R.SANSHA, c.fleetId, base.system_id, base.system_id, R.START_MS + 8 * HOUR,
        R.START_MS, R.START_MS, R.START_MS));
    return { e, shared, base: base.system_id };
  }

  needsDriver("N2: minerEscortEnabled on - the extra intel rows in snapshot.extraIntel, never in "
    + "snapshot.intel", () => H.withStore(driver, async (reopen) => {
    const seen = [];
    const hooks = { beforeEffect: (d, snapshot) => {
      if (d.factionId === R.SANSHA && seen.length === 0) seen.push(snapshot);
      return d;
    } };
    const { e, shared, base } = await bootWithTrip(reopen, {}, hooks);
    const near = new Set([base]);
    let ring = [base];
    for (let j = 0; j < 3; j += 1) {
      ring = ring.flatMap((id) => shared.graph.getNeighbors(id)).filter((id) => !near.has(id));
      for (const id of ring) near.add(id);
    }
    e.tx((db) => {
      const ins = db.prepare(`INSERT INTO ${INTEL_TABLE_NAME} (faction_id, system_id, observed_at,
        controller_faction_id, hostile_fleets, hostile_ships, hostile_strength, hostile_stations, source, updated_at,
        version) VALUES (?, ?, ?, NULL, 1, 6, 40, 0, 'sighting', ?, 1)`);
      for (const id of near) ins.run(R.SANSHA, id, R.START_MS, R.START_MS);
    });
    await R.passesAt(e, shared, R.START_MS + R.I);
    assert.strictEqual(seen.length, 1, "a Sansha review ran");
    const s = seen[0];
    const intelIds = new Set(s.intel.map((x) => x.systemId));
    const extraIds = Array.isArray(s.extraIntel) ? s.extraIntel.map((x) => x.systemId) : null;
    assert.ok(extraIds !== null && extraIds.length > 0, `extraIntel: ${JSON.stringify(s.extraIntel)}`);
    assert.deepStrictEqual({ disjoint: extraIds.every((id) => !intelIds.has(id)),
      planted: extraIds.every((id) => near.has(id)),
      shape: Object.keys(s.extraIntel[0]).join(",") === Object.keys(s.intel[0] || s.extraIntel[0]).join(",") },
    { disjoint: true, planted: true, shape: true });
    e.strategy.stop("test");
  }));

  needsDriver("N4: minerEscortIntelTruncated only for a review that went through", () =>
    H.withStore(driver, async (reopen) => {
      const state = { fail: true, calls: 0 };
      const hooks = { beforeEffect: (d) => {
        if (d.factionId !== R.SANSHA) return d;
        state.calls += 1;
        if (state.fail) throw new Error("N4 injected failure after the read");
        return d;
      } };
      const { e, shared } = await bootWithTrip(reopen, { EVEJS_LNE_STRATEGY_MINER_ESCORT_INTEL_MAX_SYSTEMS: "0" },
        hooks);
      const count = () => e.strategy.getStatus().ai.review.counters.minerEscortIntelTruncated;
      await R.passesAt(e, shared, R.START_MS + R.I);
      const failed = { calls: state.calls, counter: count() };
      state.fail = false;
      for (let k = 2; k <= 6 && count() === 0; k += 1) await R.passesAt(e, shared, R.START_MS + k * R.I);
      assert.deepStrictEqual({ failed, later: count() > 0 }, { failed: { calls: failed.calls, counter: 0 },
        later: true });
      assert.ok(failed.calls >= 1, "the failing review ran");
      e.strategy.stop("test");
    }));
};
