"use strict";

const assert = require("node:assert");

const { targetHostilityOf } = require("../../lib/strategy/truce/view");
const { chooseNextOperation } = require("../../lib/strategy/ai/operations");
const { planMinerRaids } = require("../../lib/strategy/ai/minerRaids");
const { planPatrols } = require("../../lib/strategy/ai/patrol");
const { planDefense } = require("../../lib/strategy/ai/defense");
const { evaluateSupplyAndFronts } = require("../../lib/strategy/ai/supply");
const { buildPowerTable, strengthOf } = require("../../lib/strategy/ai/strength");
const { createOperationKinds } = require("../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../lib/strategy/data/operationKinds");
const { TARGET_SCORING_V1 } = require("../../lib/strategy/data/targetScoring");
const { FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../lib/fleets/schema");
const { GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { createViewRegistry } = require("../../lib/observer/views");
const { createManualClock } = require("../../lib/util/clock");
const { createRng } = require("../../lib/util/rng");
const { createIdGenerator } = require("../../lib/util/ids");
const { harness: H } = require("../battle/settlement.test");
const { harness: R } = require("./review.test");

const AT = 1760000000000;
const HOUR = 3600000;
const F = 7;
const PARTNER = 9;
const OTHER = 11;
const BASE = 20;

const kinds = (() => {
  const k = createOperationKinds({ version: OPERATION_KINDS_VERSION, kinds: OPERATION_KINDS_V1 },
    { operationTypes: OPERATION_TYPES, objectives: OBJECTIVES, fleetRoles: FLEET_ROLES });
  assert.ok(k.ok, JSON.stringify(k));
  return k.kinds;
})();
const POWER = buildPowerTable(GROUPS);
const WING = [{ hullGroup: "cruiser", typeId: null, count: 6 }];

const PARAMS = Object.freeze({ maxReachJumps: 10, supplyChainJumps: 10, captureRangeFromStationJumps: 5,
  maxAssemblyJumps: 5, maxBfsSystems: 2000, mobilizeFallbackJumps: 0, mobilizeFallbackMaxSystems: 2000,
  maxTargetCandidates: 40, targetPickTopK: 1, maxOperationsPerReview: 1, maxFleetsPerOperation: 4,
  maxFleetsPerFaction: 32, maxMobilizationsPerReview: 3, mobilizeResourcePerShip: 10, mobilizeReservePerShip: 1,
  attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR, reconWindowMs: HOUR / 2, attackWindowMs: 2 * HOUR,
  patrolWindowMs: HOUR, kinds: kinds.list, scoring: TARGET_SCORING_V1, powerTable: POWER, frontLimitCap: 6,
  routeMaxJumps: 40, claimFrontGraceMs: 0, reconUnblockEnabled: false, raidFrontLimitEnabled: false,
  hostilePremiumCaptureOnly: false });

const RAW = (x) => x === PARTNER || x === OTHER;
const TRUCED = targetHostilityOf(RAW, [PARTNER]);

const row = (systemId, controllerFactionId) => ({ systemId, controllerFactionId, occupationState: "STABLE",
  controllerGarrison: 0, hostileStations: 0, observed: false, ownInfluence: 0 });
const intelOf = (systemId, controllerFactionId) => ({ systemId, observedAt: AT - HOUR, hostileFleets: 0,
  hostileShips: 0, hostileStrength: 0, hostileStations: 0, controllerFactionId });
const fleet = (fleetId, systemId, fleetRole) => ({ fleetId, version: 2, state: "IDLE", fleetRole, systemId,
  refitPending: false, shipCount: 6, strength: strengthOf(WING, POWER), operationId: null, legSeq: 0,
  homeSystemId: BASE, updatedAt: AT - 2 * HOUR });

function snap(o, isHostile) {
  return { v: 1, factionId: F, round: 3, at: AT, seed: 11,
    faction: { status: "ACTIVE", homeSystemId: BASE, resourceUnits: 100000, reserveUnits: 10000, frontLimit: 6,
      version: 1 },
    entry: { maxActiveFronts: 6, allies: [], homeRegionIds: [] },
    doctrine: { doctrineId: "tv", canOccupy: true, reachJumps: 30, returnToBase: false,
      operationTypes: o.operationTypes || ["recon", "invasion", "raid"],
      templates: { scout: [{ hullGroup: "frigate", count: 1 }], invasion: WING,
        patrol: [{ hullGroup: "cruiser", count: 2 }] } },
    theatre: o.theatre || [], expansion: [], raidTargets: [],
    border: { mode: "off", reach: null, captures: false, candidates: [], rejected: 0 },
    neighbors: (id) => [id - 1, id + 1].filter((x) => x >= 1 && x <= 40), regionOf: () => null,
    isHostile,
    stationsMode: "ready", stations: [{ systemId: BASE, stationId: "st20" }], captureAnchors: [BASE],
    systems: [row(BASE, F), ...(o.systems || [])], fleets: o.fleets || [], fleetsTruncated: false,
    operations: [], operationsTruncated: false, intel: o.intel || [], sightings: [], occupations: [],
    territory: [], territoryTruncated: false, capturedIds: [], footholds: [],
    ...(o.minerTargets ? { minerTargets: o.minerTargets } : {}),
    ...(o.intruders ? { intruders: o.intruders } : {}) };
}
const targets = (r) => r.intents.filter((i) => i.type === "LAUNCH").map((i) => i.target.systemId);

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("TV1 targetHostilityOf: partner false, other enemy true, non-hostile false, no partner = the same function", () => {
    assert.deepStrictEqual([TRUCED(PARTNER), TRUCED(OTHER), TRUCED(F), TRUCED(13)], [false, true, false, false]);
    assert.deepStrictEqual([RAW(PARTNER), RAW(OTHER)], [true, true], "the raw hostility untouched");
    assert.strictEqual(targetHostilityOf(RAW, []), RAW);
    assert.strictEqual(targetHostilityOf(RAW, null), RAW);
  });

  test("TV2 planPatrols (role patrol sortie) / planMinerRaids: the truce partner is no target, the other enemy is", () => {
    const PATROL = { windowMs: HOUR, idleMs: HOUR / 2, minShips: 6, garrisonMaxJumps: 2, scoutMaxJumps: 5,
      maxGarrisonsPerPost: 3, garrisonFleetsTarget: 2, maxOpenPickets: 0, roleMaxJumps: 6, roleMaxEnemyRatio: 1.5 };
    const pt = (h, reach) => planPatrols(snap({ operationTypes: ["recon", "raid", "patrol", "return"],
      systems: [row(21, null), row(26, PARTNER)], fleets: [fleet("p1", BASE, "patrol")] }, h),
    { stationSystems: [BASE], reach, frontTargets: [] }, { ...PARAMS, patrol: PATROL }, new Set(), 2);
    const both = new Map([[21, 1], [26, 6]]);
    assert.deepStrictEqual(targets(pt(RAW, both)), [26], "without the truce: the sortie on the hostile 26");
    assert.deepStrictEqual(targets(pt(TRUCED, both)), [21], "truce: 26 is no target");
    assert.deepStrictEqual(targets(pt(TRUCED, new Map([[26, 6]]))), [], "truce, only 26 in reach: no sortie");

    const RAID = { maxPerReview: 1, windowMs: HOUR, maxJumps: 5, minShips: 3, minShipRatioPermille: 1000,
      minShiftLeftMs: HOUR / 2, highsec: false, maxFleetsScanned: 12 };
    const miner = (systemId, factionId) => ({ tripId: `t${systemId}`, factionId, fleetId: `m${systemId}`, systemId,
      secClass: "lowsec", miningEndsAt: AT + 2 * HOUR, ships: 3 });
    const mr = (h) => planMinerRaids(snap({ operationTypes: ["recon", "raid", "return"],
      fleets: [fleet("r20", BASE, "patrol")],
      minerTargets: { targets: [miner(18, PARTNER), miner(24, OTHER)], truncated: false } }, h),
    { stationSystems: [BASE], reach: new Map([[18, 2], [24, 4]]), frontTargets: [] },
    { ...PARAMS, minerRaid: RAID }, new Set(), 2);
    assert.deepStrictEqual(targets(mr(RAW)), [18], "without the truce: the nearer partner miners");
    assert.deepStrictEqual(targets(mr(TRUCED)), [24], "truce: the miners of the other enemy");
  });

  test("TV3 chooseNextOperation: no LAUNCH on the partner (the other enemy instead / none); planDefense against a "
    + "partner intruder in an own system = LAUNCH defense as without the truce", () => {
    const ops = (s) => chooseNextOperation(s, evaluateSupplyAndFronts(s, PARAMS), PARAMS, createRng(5), null);
    const scene = (h, theatre) => snap({ theatre, systems: [row(21, PARTNER), row(24, OTHER)],
      intel: [intelOf(21, PARTNER), intelOf(24, OTHER)], fleets: [fleet("inv1", BASE, "invasion")] }, h);
    const raw = ops(scene(RAW, [21, 24]));
    assert.deepStrictEqual(targets(raw), [21], JSON.stringify(raw.notes));
    const truced = ops(scene(TRUCED, [21, 24]));
    assert.deepStrictEqual(targets(truced), [24], JSON.stringify(truced.notes));
    const only = ops(scene(TRUCED, [21]));
    assert.deepStrictEqual(targets(only), [], JSON.stringify(only.notes));
    assert.deepStrictEqual(targets(ops(scene(RAW, [21]))), [21]);

    const D = { ...PARAMS, defense: { enabled: true, maxPerReview: 1, intruders: { maxPerReview: 1 } } };
    const intruders = { mode: "ready", truncated: false,
      items: [{ systemId: 22, hostileStrength: 1, hostileFleets: 1, factionIds: [PARTNER] }] };
    const def = (h) => planDefense(snap({ operationTypes: ["recon", "invasion", "raid", "defense"],
      systems: [row(22, F)], fleets: [fleet("d1", BASE, "invasion")], intruders }, h), null, D,
    { targets: new Set() });
    const withTruce = def(TRUCED);
    assert.deepStrictEqual(targets(withTruce), [22], JSON.stringify(withTruce.notes));
    assert.deepStrictEqual(withTruce, def(RAW));
  });

  needsDriver("TV4 k3 review: flag off -> no snapshot.truce, isHostile(Sansha) true; flag on + truce row Amarr-Sansha "
    + "-> truce [Sansha], isHostile(Sansha) false, note TRUCE:<Sansha>, counter truceActive", async () => {
    const runOnce = (env) => H.withStore(driver, async (reopen) => {
      const clock = createManualClock(R.START_MS);
      const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(31) }), graph: R.graphOf(),
        controllers: new Map(R.THEATRE.map((id) => [id, R.SANSHA])) };
      const seen = [];
      const hooks = { beforeEffect: (d, s) => {
        if (s && s.factionId === R.AMARR) seen.push(s);
        return d;
      } };
      const views = createViewRegistry();
      const e = await R.bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8", ...env },
        { hooks, strategyViews: views });
      e.tx((db) => db.prepare("INSERT INTO world_war_pairs (faction_lo, faction_hi, state, series_start_at, "
        + "last_battle_at, truce_until, truce_initiator, cooldown_until, updated_at, version) "
        + "VALUES (?, ?, 'TRUCE', ?, ?, ?, ?, ?, ?, 1)").run(R.AMARR, R.SANSHA, R.START_MS, R.START_MS,
        R.START_MS + 100 * R.I, R.AMARR, R.START_MS + 200 * R.I, R.START_MS));
      await R.passesAt(e, shared, R.START_MS + R.I);
      assert.ok(seen.length > 0, "an Amarr review ran");
      const s = seen[seen.length - 1];
      const memory = views.getView("factions").getData().factions.find((x) => x.factionId === R.AMARR).lastReview;
      const counters = e.strategy.getStatus().ai.review.counters;
      e.strategy.stop("test");
      e.stations.stop("test");
      return { s, memory, counters };
    });
    const off = await runOnce({});
    assert.ok(!Object.hasOwn(off.s, "truce"), "flag off: no field");
    assert.strictEqual(off.s.isHostile(R.SANSHA), true);
    assert.ok(!off.memory.notes.some((n) => n.startsWith("TRUCE")), JSON.stringify(off.memory.notes));
    assert.strictEqual(off.counters.truceActive, 0);
    const on = await runOnce({ EVEJS_LNE_STRATEGY_TRUCE_ENABLED: "1" });
    assert.deepStrictEqual(on.s.truce, [R.SANSHA]);
    assert.strictEqual(on.s.isHostile(R.SANSHA), false);
    assert.ok(on.memory.notes.includes(`TRUCE:${R.SANSHA}`), JSON.stringify(on.memory.notes));
    assert.ok(on.counters.truceActive >= 1, JSON.stringify(on.counters.truceActive));
  });
};
