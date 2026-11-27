"use strict";

const assert = require("node:assert");

const { planMinerEscorts } = require("../../../lib/strategy/ai/minerEscorts");
const { decideReview } = require("../../../lib/strategy/ai");
const { buildPowerTable, strengthOf } = require("../../../lib/strategy/ai/strength");
const { createOperationKinds } = require("../../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../../lib/strategy/data/operationKinds");
const { TARGET_SCORING_V1 } = require("../../../lib/strategy/data/targetScoring");
const { FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../../lib/fleets/schema");
const { GROUPS } = require("../../../lib/battle/data/strengthCatalog");
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
const intel = (systemId, hostileStrength, extra = {}) => ({ systemId, observedAt: AT - 60000, hostileFleets: 1,
  hostileShips: 6, hostileStrength, hostileStations: 0, controllerFactionId: null, ...extra });

function snap(o = {}) {
  const s = { v: 1, factionId: F, round: 3, at: AT, seed: 11,
    faction: { status: "ACTIVE", homeSystemId: 20, doctrineId: "es", resourceUnits: 100000, reserveUnits: 10000,
      frontLimit: 1, version: 1 },
    entry: { kind: "empire", maxActiveFronts: 1, allies: [], homeRegionIds: [], ownerCorporationId: 1 },
    doctrine: { doctrineId: "es", canOccupy: false, reachJumps: 30, operationTypes: o.operationTypes
      || ["recon", "defense", "return"], templates: { scout: [{ hullGroup: "frigate", count: 1 }] } },
    theatre: [], expansion: [],
    neighbors: (id) => [id - 1, id + 1].filter((x) => x >= 1 && x <= 40), regionOf: () => null,
    isHostile: (x) => x === HOSTILE, isPlaying: () => true, isHive: () => false,
    stationsMode: "ready", stations: [{ systemId: 20, stationId: "st20" }],
    systems: [{ systemId: 20, controllerFactionId: F, occupationState: "STABLE", controllerGarrison: 0,
      hostileStations: 0, observed: false }],
    fleets: o.fleets || [fleet("e20", 20), fleet("e30", 30, { updatedAt: AT }), miner("m18", 18), miner("m30", 30, 2),
      miner("m30b", 30, 4)],
    fleetsTruncated: false, operations: o.operations || [], operationsTruncated: false,
    intel: o.intel || [intel(16, 50)], sightings: [], occupations: [], territory: [], territoryTruncated: false,
    mining: { mode: "ready", sites: [], openByBelt: [], busyFleetIds: [] } };
  if (o.openTrips !== null) {
    s.mining.openTrips = o.openTrips || [trip("m18", 18), trip("m30", 30, { miningEndsAt: AT + 3 * HOUR }),
      trip("m30b", 30)];
  }
  if (o.borderLine !== null) s.borderLine = o.borderLine || [{ systemId: 30, secClass: "lowsec", neighbours: [] }];
  return s;
}

const plan = (s, o = {}) => planMinerEscorts(s, null, { ...PARAMS, ...(o.params || {}) }, o.used || new Set(),
  o.room === undefined ? 2 : o.room, o.opts);
const targetsOf = (r) => r.intents.map((i) => [i.target.systemId, i.fleets[0].fleetId]);
const escortsOf = (d) => d.intents.filter((i) => i.type === "LAUNCH" && i.kind === "escort");
const withEscort = (patch) => ({ params: { minerEscort: { ...ESCORT, ...patch } } });
const with18 = (patch) => [trip("m18", 18, patch), trip("m30", 30, { miningEndsAt: AT + 3 * HOUR }), trip("m30b", 30)];

module.exports = ({ test, skip }) => {
  test("ES1 planMinerEscorts: gates, filters, risk (line / intel <= threatJumps), ranking, rest, opts.busy budget, "
    + "TOO_STRONG, dueAt = min(endsAt, at + window), intent shape", () => {
    const got = {};
    const used = new Set();
    const r = plan(snap(), { used });
    got.first = r.intents[0];
    got.main = [targetsOf(r), r.notes, [...used].sort()];
    got.deterministic = JSON.stringify(plan(snap())) === JSON.stringify(r);
    got.gates = [plan(snap(), { params: { minerEscort: null } }), plan(snap(), { room: 0 }),
      plan(snap({ operationTypes: ["recon", "return"] })), plan(snap({ openTrips: null })),
      plan(snap(), { params: { kinds: kinds.list.filter((k) => k.kind !== "escort") } })]
      .map((x) => x.intents.length + x.notes.length);
    got.cap0 = plan(snap(), withEscort({ defensiveSharePermille: 300 }));
    got.filters = [
      targetsOf(plan(snap({ openTrips: with18({ secClass: "highsec" }) }))),
      targetsOf(plan(snap({ openTrips: with18({ state: "OUTBOUND", miningEndsAt: null }) }))),
      targetsOf(plan(snap({ openTrips: with18({ miningEndsAt: AT + HOUR / 4 }) }))),
      targetsOf(plan(snap({ operations: [{ operationId: "p1", version: 1, state: "ACTIVE", operationType: "blockade",
        originSystemId: 18, targetSystemId: 18, dueAt: AT + HOUR }] }))),
      targetsOf(plan(snap(), { opts: { targets: new Set([18]) } })),
    ];
    got.noRisk = targetsOf(plan(snap({ borderLine: null, intel: [] })));
    got.farIntel = targetsOf(plan(snap({ borderLine: null, intel: [intel(15, 50)] })));
    got.nearIntel = targetsOf(plan(snap({ borderLine: null, intel: [intel(16, 50)] })));
    got.ranking = targetsOf(plan(snap({ intel: [], borderLine: [{ systemId: 18, secClass: "lowsec", neighbours: [] },
      { systemId: 30, secClass: "lowsec", neighbours: [] }] })));
    got.tired = targetsOf(plan(snap({ fleets: [fleet("e20", 20, { updatedAt: AT }), fleet("e30", 30, { updatedAt: AT }),
      miner("m18", 18)] })));
    got.noSince = plan(snap({ fleets: [fleet("e20", 20, { updatedAt: undefined }), miner("m18", 18)] })).notes;
    got.busy2 = plan(snap(), { opts: { busy: 2 } });
    got.busy1 = targetsOf(plan(snap(), { opts: { busy: 1 } }));
    const strong = plan(snap({ intel: [intel(16, 50), intel(18, 1000000)] }));
    got.strong = [targetsOf(strong), strong.notes];
    const short = plan(snap({ openTrips: [trip("m18", 18, { miningEndsAt: AT + 40 * 60000 })] }));
    got.dueAt = [short.intents[0].dueAt - AT, r.intents[1].dueAt - AT];
    assert.deepStrictEqual(got, {
      first: { type: "LAUNCH", kind: "escort", target: { kind: "system", systemId: 18, ref: null },
        originSystemId: 20, fleets: [{ fleetId: "e20", expectedVersion: 3 }], mobilize: [], dueAt: AT + HOUR },
      main: [[[18, "e20"], [30, "e30"]], ["MINER_ESCORT:18", "MINER_ESCORT:30"], ["e20", "e30"]],
      deterministic: true,
      gates: [0, 0, 0, 0, 0],
      cap0: { intents: [], notes: [] },
      filters: [[[30, "e30"]], [[30, "e30"]], [[30, "e30"]], [[30, "e30"]], [[30, "e30"]]],
      noRisk: [], farIntel: [], nearIntel: [[18, "e20"]],
      ranking: [[30, "e30"], [18, "e20"]],
      tired: [[30, "e30"]],
      noSince: ["MINER_ESCORT_NO_IDLE_SINCE"],
      busy2: { intents: [], notes: ["MINER_ESCORT_CAPPED"] },
      busy1: [[18, "e20"]],
      strong: [[[30, "e30"]], ["MINER_ESCORT_TOO_STRONG", "MINER_ESCORT:30"]],
      dueAt: [40 * 60000, HOUR],
    });
  });

  test("ES2 decideReview: flags off = the decision without openTrips and the key; posts + escorts on: escort in the "
    + "room the posts left, post fleets in opts.busy, one intent per fleet, sum of LAUNCH <= maxOperationsPerReview",
  () => {
    const { minerEscort: _e, ...noKey } = PARAMS;
    const off = decideReview(snap(), { ...PARAMS, minerEscort: null });
    assert.strictEqual(off.outcome, "REVIEWED", off.reason);
    assert.deepStrictEqual(off, decideReview(snap({ openTrips: null }), noKey));
    assert.ok(escortsOf(off).length === 0 && !off.notes.some((n) => n.startsWith("MINER_ESCORT")));
    const POSTS = { maxPerFaction: 3, maxPerReview: 2, windowMs: HOUR, idleMs: HOUR / 4, minShips: 6, maxJumps: 0,
      maxEnemyRatio: 1.5, secClasses: ["lowsec", "nullsec"], defensiveSharePermille: 1000 };
    const both = (o = {}) => {
      const s = snap({ intel: [intel(16, 50), intel(35, 50)], borderLine: [{ systemId: 34, secClass: "lowsec",
        neighbours: [{ systemId: 35, controllerFactionId: null }] }, { systemId: 30, secClass: "lowsec",
        neighbours: [] }], fleets: [fleet("e20", 19, { homeSystemId: 20 }), fleet("e30", 30, { updatedAt: AT }),
        fleet("p34", 34), miner("m18", 18), miner("m30", 30, 2), miner("m30b", 30, 4)] });
      s.doctrine.returnToBase = true;
      const p = { ...PARAMS, borderPosts: { ...POSTS, ...(o.posts || {}) }, ...(o.params || {}),
        minerEscort: { ...ESCORT, ...(o.escort || {}) } };
      const d = decideReview(s, p);
      assert.strictEqual(d.outcome, "REVIEWED", d.reason);
      const launches = d.intents.filter((i) => i.type === "LAUNCH" && i.kind !== "return");
      const fleetIds = d.intents.flatMap((i) => (Array.isArray(i.fleets) ? i.fleets.map((x) => x.fleetId)
        : i.fleetId ? [i.fleetId] : []));
      return { posts: launches.filter((i) => i.kind === "blockade").map((i) => i.target.systemId),
        escorts: escortsOf(d).map((i) => [i.target.systemId, i.fleets[0].fleetId]),
        capped: d.notes.includes("MINER_ESCORT_CAPPED"), launches: launches.length,
        oneIntentPerFleet: fleetIds.length === new Set(fleetIds).size, max: p.maxOperationsPerReview };
    };
    const got = {
      room3: both({ params: { maxOperationsPerReview: 3 } }),
      room1: both({ params: { maxOperationsPerReview: 1 } }),
      busy: both({ params: { maxOperationsPerReview: 3 }, escort: { defensiveSharePermille: 700 } }),
      capped: both({ params: { maxOperationsPerReview: 3 }, escort: { defensiveSharePermille: 400 } }),
    };
    for (const k of Object.keys(got)) assert.ok(got[k].launches <= got[k].max, `${k}: ${JSON.stringify(got[k])}`);
    assert.deepStrictEqual(got, {
      room3: { posts: [34], escorts: [[18, "e20"], [30, "e30"]], capped: false, launches: 3, oneIntentPerFleet: true,
        max: 3 },
      room1: { posts: [34], escorts: [], capped: false, launches: 1, oneIntentPerFleet: true, max: 1 },
      busy: { posts: [34], escorts: [[18, "e20"]], capped: false, launches: 2, oneIntentPerFleet: true, max: 3 },
      capped: { posts: [34], escorts: [], capped: true, launches: 1, oneIntentPerFleet: true, max: 3 },
    });
  });

  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("ES3 LAUNCH escort of a fleet in T on a real store: STAGED in place, operation ACTIVE type escort, "
    + "FLEET_OPERATION_COMPLETE at dueAt, no FLEET_ARRIVAL, minerEscortLaunched 1 / recon 0; readSiteState of the "
    + "real mining facade -> openTrips", () => H.withStore(driver, async (reopen) => {
    const clock = createManualClock(R.START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(53) }), graph: R.graphOf(),
      controllers: new Map(R.THEATRE.map((id) => [id, R.SANSHA])) };
    const state = { fleetId: null, systemId: null, dueAt: 0, injected: 0 };
    const hooks = { beforeEffect: (d, snapshot) => {
      if (d.factionId !== R.SANSHA || d.outcome !== "REVIEWED" || state.fleetId === null || state.injected >= 1) {
        return d;
      }
      const x = snapshot.fleets.find((y) => y.fleetId === state.fleetId);
      if (!x) return d;
      state.injected += 1;
      state.read = [Array.isArray(snapshot.mining && snapshot.mining.openTrips), Array.isArray(snapshot.borderLine)];
      const intents = d.intents.filter((i) => !JSON.stringify(i).includes(state.fleetId));
      const touch = intents.findIndex((i) => i.type === "FACTION_TOUCH");
      intents.splice(touch < 0 ? intents.length : touch, 0, { type: "LAUNCH", kind: "escort",
        target: { kind: "system", systemId: state.systemId, ref: null }, originSystemId: state.systemId,
        fleets: [{ fleetId: x.fleetId, expectedVersion: x.version }], mobilize: [], dueAt: state.dueAt });
      return { ...d, intents };
    } };
    const opened = reopen();
    const e = await R.bootAll(opened, shared, { EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: String(R.SANSHA),
      EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8", EVEJS_LNE_PRODUCTION_TARGET_STOCK_FLEETS: "0",
      EVEJS_LNE_STRATEGY_MINER_ESCORT_ENABLED: "1" }, { hooks, mining: true });
    const base = e.q("SELECT system_id FROM world_stations WHERE owner_faction_id = ? AND state = 'ONLINE' "
      + "ORDER BY station_id", R.SANSHA)[0];
    assert.ok(base, "a Sansha station");
    const create = (tag, role, composition) => {
      const c = e.fleets.createFleet({ factionId: R.SANSHA, currentSystemId: base.system_id,
        homeSystemId: base.system_id, fleetRole: role, composition }, `${tag}:create`);
      assert.ok(c.ok, JSON.stringify(c));
      return c.fleetId;
    };
    Object.assign(state, { fleetId: create("es3", "patrol", SIX), systemId: base.system_id,
      dueAt: R.START_MS + R.I * 8 });
    await R.passesAt(e, shared, R.START_MS + R.I);
    assert.strictEqual(state.injected, 1, "a Sansha review ran");
    const f1 = e.q("SELECT state, current_system_id AS s, operation_id AS op FROM virtual_fleets WHERE fleet_id = ?",
      state.fleetId)[0];
    const op = e.q("SELECT state, operation_type AS t, target_system_id AS s, objective FROM world_operations "
      + "WHERE operation_id = ?", f1.op)[0];
    const events = (type, id) => e.q("SELECT due_at FROM world_scheduled_events WHERE event_type = ? "
      + "AND aggregate_id = ?", type, id).map((x) => Number(x.due_at));
    const c = e.strategy.getStatus().ai.review.counters;
    assert.ok(Object.keys(e.mining).includes("readSiteState"), Object.keys(e.mining).join(","));
    const minerId = create("es3m", "mining", [{ hullGroup: "mining_frigate", typeId: null, count: 3 }]);
    const ends = R.START_MS + 2 * HOUR;
    e.tx((db) => db.prepare(`INSERT INTO world_mining_trips (trip_id, idempotency_key, faction_id, fleet_id,
      origin_system_id, belt_system_id, state, sec_class, richness_permille, mining_ends_at, dispatched_at, created_at,
      updated_at, version) VALUES (?, ?, ?, ?, ?, ?, 'MINING', 'nullsec', 500, ?, ?, ?, ?, 1)`)
      .run("trip-es3", "es3:trip", R.SANSHA, minerId, base.system_id, base.system_id, ends, R.START_MS, R.START_MS,
        R.START_MS));
    const site = e.tx((db) => e.mining.readSiteState(db, R.SANSHA));
    const mine = site.openTrips.find((t) => t.tripId === "trip-es3");
    assert.deepStrictEqual({ read: state.read, fleet: [f1.state, f1.s], op: [op.state, op.t, op.s, op.objective],
      complete: events("FLEET_OPERATION_COMPLETE", f1.op), arrival: events("FLEET_ARRIVAL", state.fleetId),
      counters: [c.minerEscortLaunched, c.recon, c.borderPostLaunched],
      stagedInPlace: e.fleets.travel.getCounters().stagedInPlace,
      site: [site.ok, Object.isFrozen(site.openTrips), site.openTrips.every((t) => Object.keys(t).join(",")
        === "tripId,fleetId,systemId,secClass,state,miningEndsAt"), { ...mine }] }, {
      read: [true, true], fleet: ["STAGED", base.system_id], op: ["ACTIVE", "escort", base.system_id, "hold"],
      complete: [state.dueAt],
      arrival: [], counters: [1, 0, 0], stagedInPlace: 1,
      site: [true, true, true, { tripId: "trip-es3", fleetId: minerId, systemId: base.system_id, secClass: "nullsec",
        state: "MINING", miningEndsAt: ends }] });
    e.strategy.stop("test");
  }));
};
