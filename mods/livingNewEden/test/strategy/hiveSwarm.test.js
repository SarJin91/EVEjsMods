"use strict";

const assert = require("node:assert");

const { decideReview } = require("../../lib/strategy/ai");
const { planHiveSwarm, hiveSwarmKey, swarmBucketOf } = require("../../lib/strategy/ai/hiveSwarm");
const { buildPowerTable } = require("../../lib/strategy/ai/strength");
const { createOperationKinds } = require("../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../lib/strategy/data/operationKinds");
const { DOCTRINES_V1 } = require("../../lib/strategy/data/doctrines");
const { TARGET_SCORING_V1 } = require("../../lib/strategy/data/targetScoring");
const { FACTIONS_V1 } = require("../../lib/strategy/data/factions");
const { FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../lib/fleets/schema");
const { GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { NO_TREASURY_KINDS, createTreasuryLossConsequence } = require("../../lib/economy/treasury/lossConsequence");
const { rowBoundsOfConfig } = require("../../lib/strategy/reviewBound");
const { buildUniverseGraph } = require("../../lib/graph/universeGraph");
const { createRouteFinder } = require("../../lib/graph/routes");
const { k3StaticMap, system } = require("./fixtures/k3Cluster.fixture");
const { createManualClock } = require("../../lib/util/clock");
const { createRng } = require("../../lib/util/rng");
const { createIdGenerator } = require("../../lib/util/ids");
const { harness: H } = require("../battle/settlement.test");
const { harness: R } = require("./review.test");

const AT = 1760000000000;
const HOUR = 3600000;
const HIVE = 500025;
const TRIG = 500026;
const SANSHA = 500019;

const kinds = (() => {
  const k = createOperationKinds({ version: OPERATION_KINDS_VERSION, kinds: OPERATION_KINDS_V1 },
    { operationTypes: OPERATION_TYPES, objectives: OBJECTIVES, fleetRoles: FLEET_ROLES });
  assert.ok(k.ok, JSON.stringify(k));
  return k.kinds;
})();
const D = DOCTRINES_V1.find((x) => x.doctrineId === "rogue-hive-v1");
const DOCTRINE = Object.freeze({ doctrineId: D.doctrineId, canOccupy: D.canOccupy, expandsBeyondTheatre: false,
  operationTypes: [...D.operationTypes], reachJumps: D.reachJumps, templates: D.templates, ownSpace: null,
  borderReachKey: null, borderTargets: false, borderCaptures: false, captureTargets: [...D.captureTargets],
  targetSecClasses: [...D.targetSecClasses], returnToBase: D.returnToBase, confinedToBelt: false,
  buildsStations: false, capturesStations: false, consolidates: D.consolidates, hullsRequired: false,
  fieldsHunters: false, hunterTemplate: [], hunterComposition: [], hoardCapped: true, raidsBeyondTheatre: true,
  hive: true });
const SWARM = Object.freeze({ thresholdUnits: 1000, cooldownMs: 3 * 24 * HOUR, fleets: 6, maxJumps: 10 });
const HIVE_P = Object.freeze({ maxFleets: 20, fleetsPerNode: 1, maxFrontsPerAttacker: 1, assumedGarrisonFleets: 2,
  captureSlowFactor: 3, swarm: SWARM });
const PARAMS = Object.freeze({ maxReachJumps: 15, supplyChainJumps: 10, captureRangeFromStationJumps: 5,
  maxAssemblyJumps: 15, maxBfsSystems: 2000, mobilizeFallbackJumps: 0, mobilizeFallbackMaxSystems: 2000,
  maxTargetCandidates: 40, targetPickTopK: 1, maxOperationsPerReview: 3, maxFleetsPerOperation: 4,
  maxFleetsPerFaction: 40, maxMobilizationsPerReview: 8, mobilizeResourcePerShip: 10, mobilizeReservePerShip: 1,
  attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR, maxObservationsPerReview: 8, reconWindowMs: HOUR / 2,
  attackWindowMs: 2 * HOUR, operationGraceMs: HOUR, maxHousekeepingPerReview: 4, maxRefitRequestsPerReview: 2,
  returnAfterIdleMs: HOUR / 2, returnWindowMs: 2 * HOUR, maxReturnsPerReview: 3,
  returnFleetRoles: [...kinds.get("return").fleetRoles], kinds: kinds.list, scoring: TARGET_SCORING_V1,
  powerTable: buildPowerTable(GROUPS), frontLimitCap: 3, routeMaxJumps: 40, defense: { enabled: true, maxPerReview: 2 },
  hive: HIVE_P });

const row = (systemId, controllerFactionId, extra = {}) => ({ systemId, controllerFactionId, occupationState: "STABLE",
  ownInfluence: 0, occupierFactionId: null, homeFactionId: null, controllerGarrison: 0, hostileStations: 0,
  liveStations: 0, ownLiveStations: 0, observed: false, ...extra });
const OFF = Object.freeze({ mode: "off", truncated: false, items: [] });

function snap(o = {}) {
  return { v: 1, factionId: HIVE, round: 3, at: AT, seed: 11,
    faction: { status: "ACTIVE", homeSystemId: 20, doctrineId: DOCTRINE.doctrineId, resourceUnits: 100000,
      reserveUnits: 10000, frontLimit: 3, version: 1 },
    entry: { kind: "hive", maxActiveFronts: 3, allies: [], homeRegionIds: [], ownerCorporationId: 1 },
    doctrine: DOCTRINE, hive: { homeSystems: 10, swarm: o.swarm === undefined ? { bucket: 7, done: false } : o.swarm },
    theatre: [], expansion: [], raidTargets: [],
    neighbors: (id) => [id - 1, id + 1].filter((x) => x >= 1 && x <= 40), regionOf: () => null,
    isHostile: (x) => x === TRIG, isPlaying: () => true,
    stationsMode: "ready", stations: [], captureAnchors: [],
    systems: [row(20, HIVE), row(30, HIVE), row(17, TRIG, { homeFactionId: HIVE })],
    fleets: [], fleetsTruncated: false, operations: [], operationsTruncated: false, intel: [], sightings: [],
    occupations: [], territory: [], territoryTruncated: false,
    footholds: [20, 30].map((systemId) => ({ systemId, jumps: 10 })),
    upkeep: { mode: "ready", paidUntil: null, unpaidPeriods: 0, controlledCount: 10, captured: [],
      capturedTruncated: false, liveShips: 0, stationCount: 2, tradeReady: false, tradeReason: null },
    capturedIds: [], threats: OFF,
    lostHome: { mode: "ready", truncated: false, afterSystemId: 0, nextAfterSystemId: 0, systemIds: [17] },
    huntReady: false };
}
const SUPPLY = Object.freeze({ captureReach: new Map([[17, 3]]), reach: new Map([[17, 3]]), frontTargets: [] });
const BUDGET = Object.freeze({ resourceUnits: 100000, reserveUnits: 10000 });
const SLOTS = Object.freeze({ operations: 3, mobilizations: 8 });
const plan = (s, o = {}) => planHiveSwarm({ snapshot: s, supply: o.supply || SUPPLY, params: o.params || PARAMS,
  budget: o.budget || BUDGET, slots: o.slots || SLOTS });
const EMPTY = Object.freeze({ intents: [], notes: [], cost: { resourceUnits: 0, reserveUnits: 0 } });

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("HS1 planHiveSwarm: surplus, no marker, a lost home of 500026 in captureReach -> one LAUNCH invasion on it "
    + "with min(swarmFleets, maxFleetsPerOperation) MOBILIZE in the nearest node, swarmBucket of the snapshot", () => {
    const r = plan(snap());
    const invasion = D.templates.invasion;
    const ships = invasion.reduce((s, e) => s + e.count, 0);
    const mob = (slot) => ({ type: "MOBILIZE", slot, role: "invasion", systemId: 20, homeSystemId: 20,
      composition: invasion.map((e) => ({ hullGroup: e.hullGroup, typeId: null, count: e.count })),
      cost: { resourceUnits: ships * 10, reserveUnits: ships }, stationId: null, hulls: [] });
    assert.deepStrictEqual(r.intents, [{ type: "LAUNCH", slot: 4, kind: "invasion",
      target: { kind: "system", systemId: 17, ref: null }, originSystemId: 20, fleets: [],
      mobilize: [0, 1, 2, 3].map(mob), dueAt: AT + 2 * HOUR, swarmBucket: 7 }]);
    assert.deepStrictEqual([r.notes, r.cost], [["HIVE_SWARM:17:4"], { resourceUnits: 4 * ships * 10,
      reserveUnits: 4 * ships }]);
    const raid = plan(snap(), { supply: { ...SUPPLY, captureReach: new Map() } }).intents[0];
    assert.deepStrictEqual([raid.kind, raid.mobilize[0].role], ["raid", "patrol"]);
    assert.deepStrictEqual(plan(snap(), { supply: { ...SUPPLY, frontTargets: [17] } }).notes, ["HIVE_SWARM_NO_TARGET"]);
    assert.deepStrictEqual(plan({ ...snap(), isHostile: () => false }).notes, ["HIVE_SWARM_NO_TARGET"]);
    assert.deepStrictEqual(plan(snap(), { params: { ...PARAMS, hive: { ...HIVE_P, swarm: { ...SWARM, maxJumps: 2 } } } })
      .notes, ["HIVE_SWARM_NO_TARGET"]);
    assert.deepStrictEqual([swarmBucketOf(AT, SWARM.cooldownMs), hiveSwarmKey(HIVE, 6790)],
      [Math.floor(AT / SWARM.cooldownMs), "hive:swarm:v1:500025:6790"]);
  });

  test("HS2 below the threshold, the marker of the bucket (done) or the flag off -> no intents; flag off / no "
    + "swarm in the snapshot without a note", () => {
    assert.deepStrictEqual(plan(snap(), { budget: { resourceUnits: 999, reserveUnits: 10000 } }), EMPTY);
    assert.deepStrictEqual(plan(snap({ swarm: { bucket: 7, done: true } })), EMPTY);
    assert.deepStrictEqual(plan(snap(), { params: { ...PARAMS, hive: { ...HIVE_P, swarm: null } } }), EMPTY);
    assert.deepStrictEqual(plan(snap(), { params: { ...PARAMS, hive: null } }), EMPTY);
    assert.deepStrictEqual(plan(snap({ swarm: null })), EMPTY);
    assert.deepStrictEqual(plan({ ...snap(), operationsTruncated: true }).notes, ["HIVE_SWARM_SKIPPED"]);
  });

  test("HS3 slots {operations 1, mobilizations 2} -> 2 MOBILIZE; operations 0 -> HIVE_SWARM_NO_SLOT; decideReview on "
    + "the hive fixture carries the wave, its note and the bucket", () => {
    assert.strictEqual(plan(snap(), { slots: { operations: 1, mobilizations: 2 } }).intents[0].mobilize.length, 2);
    assert.deepStrictEqual(plan(snap(), { slots: { operations: 0, mobilizations: 2 } }), { ...EMPTY,
      notes: ["HIVE_SWARM_NO_SLOT"] });
    const d = decideReview(snap(), PARAMS);
    assert.strictEqual(d.outcome, "REVIEWED", d.reason);
    const waves = d.intents.filter((i) => i.type === "LAUNCH" && i.swarmBucket !== undefined);
    assert.deepStrictEqual(waves.map((i) => [i.kind, i.target.systemId, i.swarmBucket]), [["invasion", 17, 7]],
      JSON.stringify(d.notes));
    assert.ok(d.notes.some((n) => n.startsWith("HIVE_SWARM:17:")), JSON.stringify(d.notes));
    const mobilized = d.intents.reduce((s, i) => s + (i.type === "MOBILIZE" ? 1 : i.type === "LAUNCH"
      ? i.mobilize.length : 0), 0);
    assert.ok(mobilized <= PARAMS.maxMobilizationsPerReview, String(mobilized));
    const off = decideReview(snap(), { ...PARAMS, hive: { ...HIVE_P, swarm: null } });
    assert.ok(!off.intents.some((i) => i.swarmBucket !== undefined));
  });

  needsDriver("HS4 real store: the swarm LAUNCH writes the marker; the next review of the bucket reads done and "
    + "plans no wave; a repeated swarm LAUNCH -> HIVE_SWARM_ALREADY, no second operation; review bound + 1", async () => {
    const MAL = [30001051, 30001052, 30001053, 30001054, 30001055];
    const LOST = MAL[4];
    const graph = (() => {
      const map = k3StaticMap({ extra: MAL.map((id) => system(id, 10000013, 20000150, "nullsec")) });
      const link = (a, b) => map.gates.push({ fromSystemId: a, toSystemId: b }, { fromSystemId: b, toSystemId: a });
      link(30004932, MAL[0]);
      for (let i = 1; i < MAL.length; i += 1) link(MAL[i - 1], MAL[i]);
      const built = buildUniverseGraph(map);
      assert.ok(built.ok);
      return Object.freeze({ ...built.graph, ...createRouteFinder(built.graph, { cacheSize: 64, maxJumps: 40 })
        .publicApi });
    })();
    await H.withStore(driver, async (reopen) => {
      const clock = createManualClock(R.START_MS);
      const controllers = new Map([...R.THEATRE.map((id) => [id, SANSHA]), ...MAL.map((id) => [id, HIVE])]);
      controllers.set(LOST, SANSHA);
      const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(71) }), graph, controllers };
      const seen = [];
      let inject = null;
      const hooks = { beforeEffect: (d, s) => {
        if (d.factionId !== HIVE) return d;
        seen.push({ s, d });
        if (inject && seen.length === 2) {
          const i = d.intents.length - 1;
          return { ...d, intents: [...d.intents.slice(0, i), { ...inject, swarmBucket: s.hive.swarm.bucket },
            ...d.intents.slice(i)] };
        }
        return d;
      } };
      const world = R.upkeepWorld(controllers, new Map());
      world.repository.listLostHome = (tx, f, opts) => ({ ok: true, systems: f === HIVE && opts.afterSystemId < LOST
        ? [{ systemId: LOST }] : [] });
      const env = { EVEJS_LNE_HIVE_ENABLED: "1", EVEJS_LNE_HIVE_SWARM_ENABLED: "1", EVEJS_LNE_HIVE_FLEETS_PER_NODE: "0",
        EVEJS_LNE_STRATEGY_MAX_OPERATIONS_PER_REVIEW: "4", EVEJS_LNE_STRATEGY_MAX_MOBILIZATIONS_PER_REVIEW: "6",
        EVEJS_LNE_PERSISTENCE_MAX_ROWS_PER_TRANSACTION: "1600",
        EVEJS_LNE_HIVE_SWARM_THRESHOLD_UNITS: "0", EVEJS_LNE_STRATEGY_CAMPAIGNS: "none",
        EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: `${SANSHA},${HIVE}`, EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8" };
      const e = await R.bootAll(reopen(), shared, env, { hooks, world });
      const reviewOnce = async () => {
        const n = seen.length;
        for (let t = clock.now() + R.I; seen.length === n && t < R.START_MS + 48 * HOUR; t += R.I) {
          await R.passesAt(e, shared, t);
        }
        assert.ok(seen.length > n, "no hive review");
      };
      await reviewOnce();
      const first = seen[0];
      assert.ok(first.s.hive && first.s.hive.swarm && first.s.hive.swarm.done === false, JSON.stringify(first.s.hive));
      const wave = first.d.intents.find((i) => i.type === "LAUNCH" && i.swarmBucket !== undefined);
      assert.ok(wave, JSON.stringify([first.d.notes, first.d.intents.map((i) => [i.type, i.kind])]));
      const key = hiveSwarmKey(HIVE, first.s.hive.swarm.bucket);
      const marker = e.tx((db) => e.journal.findByKey(db, key));
      assert.deepStrictEqual([marker.ok, marker.found], [true, true], JSON.stringify(marker));
      const opsOnLost = () => e.q("SELECT COUNT(*) AS n FROM world_operations WHERE faction_id = ? AND target_system_id = ?",
        HIVE, LOST)[0].n;
      const ops = opsOnLost();
      assert.ok(ops >= 1, String(ops));
      const counters = () => e.strategy.getStatus().ai.review.counters;
      assert.deepStrictEqual([counters().hiveSwarms, counters().hiveSwarmFleets], [1, wave.mobilize.length]);
      inject = wave;
      await reviewOnce();
      e.strategy.stop("test");
      const second = seen[1];
      assert.deepStrictEqual(second.s.hive.swarm, { bucket: first.s.hive.swarm.bucket, done: true });
      assert.ok(!second.d.intents.some((i) => i.swarmBucket !== undefined), JSON.stringify(second.d.notes));
      assert.deepStrictEqual([counters().hiveSwarms, counters().hiveSwarmRefused, opsOnLost()], [1, 1, ops]);
      const off = rowBoundsOfConfig({ ...e.config, hive: { ...e.config.hive, swarmEnabled: false } }).review;
      assert.strictEqual(rowBoundsOfConfig(e.config).review - off, 1);
    });
  });

  test("HS5 the hive treasury: 500025 has a kind of NO_TREASURY_KINDS; its loss settles nothing (no seed "
    + "no settleInTx, no unpaid)", () => {
    const entry = FACTIONS_V1.find((x) => x.factionId === HIVE);
    assert.ok(entry && NO_TREASURY_KINDS.includes(entry.kind), JSON.stringify(entry && entry.kind));
    const calls = [];
    const consequence = createTreasuryLossConsequence({
      repository: { settleInTx: (_tx, x) => {
        calls.push(["settle", x.factionId]);
        return { ok: true, duplicate: false, paid: { lossFit: 0 }, unpaid: x.debits.lossFit };
      } },
      hullValues: { valueOf: () => 1000000 }, fitValuePermille: 1000,
      seedIfMissingInTx: (_tx, f) => {
        calls.push(["seed", f]);
        return { ok: true, seeded: true };
      },
      getRegistry: () => ({ isActive: () => true, getFaction: (f) => FACTIONS_V1.find((x) => x.factionId === f) || null }),
      isRunning: () => true, count: () => {},
    });
    const r = consequence.apply({}, { at: 1, losses: [{ factionId: HIVE, hullGroup: "cruiser", count: 5 }] }, "b:hs5");
    assert.deepStrictEqual([r.ok, r.charged, r.skipped, calls], [true, [], 1, []]);
  });
};
