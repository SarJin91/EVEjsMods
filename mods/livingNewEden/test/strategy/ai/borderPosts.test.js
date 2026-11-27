"use strict";

const assert = require("node:assert");

const { planBorderPosts } = require("../../../lib/strategy/ai/borderPosts");
const { territoryLine, borderLineOf } = require("../../../lib/strategy/ai/border");
const { createBorderIndex } = require("../../../lib/strategy/border");
const { decideReview } = require("../../../lib/strategy/ai");
const { buildPowerTable, strengthOf } = require("../../../lib/strategy/ai/strength");
const { createOperationKinds } = require("../../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../../lib/strategy/data/operationKinds");
const { TARGET_SCORING_V1 } = require("../../../lib/strategy/data/targetScoring");
const { FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../../lib/fleets/schema");
const { GROUPS } = require("../../../lib/battle/data/strengthCatalog");
const { startBlockade, createUnavailableBlockade } = require("../../../lib/strategy/blockade");
const { createManualClock } = require("../../../lib/util/clock");
const { createRng } = require("../../../lib/util/rng");
const { createIdGenerator } = require("../../../lib/util/ids");
const { harness: H } = require("../../battle/settlement.test");
const { harness: R } = require("../review.test");

const AT = 1760000000000;
const HOUR = 3600000;
const F = 7;
const HOSTILE = 9;
const NEUTRAL = 11;

const kinds = (() => {
  const k = createOperationKinds({ version: OPERATION_KINDS_VERSION, kinds: OPERATION_KINDS_V1 },
    { operationTypes: OPERATION_TYPES, objectives: OBJECTIVES, fleetRoles: FLEET_ROLES });
  assert.ok(k.ok, JSON.stringify(k));
  return k.kinds;
})();
const POWER = buildPowerTable(GROUPS);
const SIX = [{ hullGroup: "cruiser", typeId: null, count: 6 }];
const POSTS = Object.freeze({ maxPerFaction: 3, maxPerReview: 2, windowMs: HOUR, idleMs: HOUR / 4, minShips: 6,
  maxJumps: 4, maxEnemyRatio: 1.5, secClasses: Object.freeze(["lowsec", "nullsec"]), defensiveSharePermille: 1000 });

const PARAMS = Object.freeze({ maxReachJumps: 10, supplyChainJumps: 10, captureRangeFromStationJumps: 5,
  maxAssemblyJumps: 8, maxBfsSystems: 2000, mobilizeFallbackJumps: 0, mobilizeFallbackMaxSystems: 2000,
  maxTargetCandidates: 40, targetPickTopK: 1, maxOperationsPerReview: 2, maxFleetsPerOperation: 4,
  maxFleetsPerFaction: 12, maxMobilizationsPerReview: 3, mobilizeResourcePerShip: 10, mobilizeReservePerShip: 1,
  attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR, maxObservationsPerReview: 8, reconWindowMs: HOUR / 2,
  attackWindowMs: 2 * HOUR, operationGraceMs: HOUR, maxHousekeepingPerReview: 4, maxRefitRequestsPerReview: 2,
  returnAfterIdleMs: HOUR / 2, returnWindowMs: 2 * HOUR, maxReturnsPerReview: 3,
  returnFleetRoles: [...kinds.get("return").fleetRoles],
  kinds: kinds.list, scoring: TARGET_SCORING_V1, powerTable: POWER, frontLimitCap: 2, routeMaxJumps: 40,
  borderPosts: POSTS });

function fleet(fleetId, systemId, extra = {}) {
  return { fleetId, version: 3, state: "IDLE", fleetRole: "patrol", systemId, refitPending: false, shipCount: 6,
    strength: strengthOf(SIX, POWER), composition: SIX, operationId: null, legSeq: 0, homeSystemId: 20,
    updatedAt: AT - HOUR, ...extra };
}

const intel = (systemId, hostileStrength) => ({ systemId, observedAt: AT - 60000, hostileFleets: 1, hostileShips: 6,
  hostileStrength, hostileStations: 0, controllerFactionId: null });

const LINE = Object.freeze([
  { systemId: 5, secClass: "highsec", neighbours: [{ systemId: 4, controllerFactionId: HOSTILE }] },
  { systemId: 10, secClass: "nullsec", neighbours: [{ systemId: 11, controllerFactionId: NEUTRAL }] },
  { systemId: 20, secClass: "nullsec", neighbours: [{ systemId: 19, controllerFactionId: HOSTILE }] },
  { systemId: 30, secClass: "lowsec", neighbours: [{ systemId: 31, controllerFactionId: NEUTRAL }] },
]);

function snap(o = {}) {
  const row = (systemId, controllerFactionId) => ({ systemId, controllerFactionId, occupationState: "STABLE",
    controllerGarrison: 0, hostileStations: 0, observed: false });
  const s = { v: 1, factionId: F, round: 3, at: AT, seed: 11,
    faction: { status: "ACTIVE", homeSystemId: 20, doctrineId: "bp", resourceUnits: 100000, reserveUnits: 10000,
      frontLimit: 1, version: 1 },
    entry: { kind: "empire", maxActiveFronts: 1, allies: [], homeRegionIds: [], ownerCorporationId: 1 },
    doctrine: { doctrineId: "bp", canOccupy: false, reachJumps: 30, operationTypes: o.operationTypes
      || ["recon", "defense", "return"], templates: { scout: [{ hullGroup: "frigate", count: 1 }] } },
    theatre: [], expansion: [],
    neighbors: (id) => [id - 1, id + 1].filter((x) => x >= 1 && x <= 40), regionOf: () => null,
    isHostile: (x) => x === HOSTILE, isPlaying: () => true, isHive: () => false,
    stationsMode: "ready", stations: [{ systemId: 20, stationId: "st20" }],
    systems: [row(19, HOSTILE), row(20, F)],
    fleets: o.fleets || [fleet("f30", 30, { updatedAt: AT }), fleet("f22", 22)], fleetsTruncated: false,
    operations: o.operations || [], operationsTruncated: false,
    intel: o.intel || [intel(31, 50)], sightings: [], occupations: [], territory: [], territoryTruncated: false };
  if (o.borderLine !== null) s.borderLine = o.borderLine || LINE;
  return s;
}

const plan = (s, o = {}) => planBorderPosts(s, null, { ...PARAMS, ...(o.params || {}) }, o.used || new Set(),
  o.room === undefined ? 2 : o.room, o.opts);
const targetsOf = (r) => r.intents.map((i) => [i.target.systemId, i.fleets[0].fleetId]);
const blockades = (d) => d.intents.filter((i) => i.type === "LAUNCH" && i.kind === "blockade");

module.exports = ({ test, skip }) => {
  test("BP1 planBorderPosts: ranking (fresh enemy > hostile neighbour, no highsec / neutral-only), budget, rest "
    + "only for a fleet that flies, in place without rest, TOO_STRONG skips the candidate", () => {
    const used = new Set();
    const r = plan(snap(), { used });
    assert.deepStrictEqual(r.intents[0], { type: "LAUNCH", kind: "blockade",
      target: { kind: "system", systemId: 30, ref: null }, originSystemId: 30,
      fleets: [{ fleetId: "f30", expectedVersion: 3 }], mobilize: [], dueAt: AT + HOUR });
    assert.deepStrictEqual([targetsOf(r), r.notes], [[[30, "f30"], [20, "f22"]], ["BORDER_POST:30", "BORDER_POST:20"]]);
    assert.deepStrictEqual([...used].sort(), ["f22", "f30"]);
    assert.deepStrictEqual(plan(snap()), plan(snap()), "deterministic");
    const tired = snap({ fleets: [fleet("f30", 30, { updatedAt: AT }), fleet("f22", 22, { updatedAt: AT })] });
    assert.deepStrictEqual(targetsOf(plan(tired)), [[30, "f30"]]);
    const noSince = snap({ fleets: [fleet("f22", 22, { updatedAt: undefined })] });
    assert.deepStrictEqual(plan(noSince).notes, ["BORDER_POST_NO_IDLE_SINCE"]);
    const share = (permille) => ({ params: { borderPosts: { ...POSTS, defensiveSharePermille: permille } } });
    assert.deepStrictEqual(plan(snap(), share(300)), { intents: [], notes: [] });
    assert.deepStrictEqual(plan(snap({ borderLine: [] }), share(300)), { intents: [], notes: [] });
    const busy = snap({ fleets: [fleet("f30", 30, { updatedAt: AT }), fleet("f22", 22), fleet("x1", 1),
      fleet("p8", 8, { state: "STAGED", operationId: "o1" })], operations: [{ operationId: "o1", version: 1,
      state: "ACTIVE", operationType: "blockade", originSystemId: 8, targetSystemId: 8, dueAt: AT + HOUR }] });
    assert.deepStrictEqual(targetsOf(plan(busy, share(500))), [[30, "f30"]]);
    assert.deepStrictEqual(plan(busy, share(250)), { intents: [], notes: ["BORDER_POST_CAPPED"] });
    const strong = plan(snap({ intel: [intel(31, 50), intel(30, 1000000)] }));
    assert.deepStrictEqual([targetsOf(strong), strong.notes], [[[20, "f22"]],
      ["BORDER_POST_TOO_STRONG", "BORDER_POST:20"]]);
    assert.deepStrictEqual(plan(snap(), { room: 0 }), { intents: [], notes: [] });
    assert.deepStrictEqual(targetsOf(plan(snap(), { opts: { targets: new Set([30]) } })), [[20, "f22"]]);
    assert.deepStrictEqual(plan(snap({ operationTypes: ["recon", "return"] })).intents, []);
  });

  test("BP5 (): the posts read snapshot.extraIntel through intelWithExtra - the fresh rows "
    + "only in extraIntel give the plan of the same rows in intel (and not the plan without them)", () => {
    const extraOnly = snap({ intel: [] });
    extraOnly.extraIntel = [intel(31, 50), intel(30, 1000000)];
    const got = plan(extraOnly);
    assert.deepStrictEqual(got, plan(snap({ intel: [intel(31, 50), intel(30, 1000000)] })));
    assert.notDeepStrictEqual(got, plan(snap({ intel: [] })), "the extra rows change the plan");
  });

  test("BP2 flag off: decideReview with params.borderPosts null = the decision without borderLine and the key = "
    + "a fresh ai/index with a planner stub; on -> LAUNCH blockade", () => {
    const { borderPosts: _b, ...noKey } = PARAMS;
    const off = decideReview(snap(), { ...PARAMS, borderPosts: null });
    assert.strictEqual(off.outcome, "REVIEWED", off.reason);
    assert.deepStrictEqual(off, decideReview(snap({ borderLine: null }), noKey));
    assert.ok(blockades(off).length === 0 && !off.notes.some((n) => n.startsWith("BORDER_POST")));
    const aiPath = require.resolve("../../../lib/strategy/ai");
    const postsPath = require.resolve("../../../lib/strategy/ai/borderPosts");
    const [aiEntry, postsEntry] = [require.cache[aiPath], require.cache[postsPath]];
    let noPlanner;
    try {
      delete require.cache[aiPath];
      require.cache[postsPath] = { ...postsEntry, exports: { ...postsEntry.exports,
        planBorderPosts: () => ({ intents: [], notes: [] }) } };
      noPlanner = require("../../../lib/strategy/ai").decideReview;
    } finally {
      require.cache[aiPath] = aiEntry;
      require.cache[postsPath] = postsEntry;
    }
    assert.notStrictEqual(noPlanner, decideReview, "a fresh ai/index");
    assert.deepStrictEqual(off, noPlanner(snap(), { ...PARAMS, borderPosts: null }), "flag off = no planner");
    const on = decideReview(snap(), PARAMS);
    assert.strictEqual(on.outcome, "REVIEWED", on.reason);
    assert.ok(blockades(on).length >= 1, JSON.stringify(on.notes));
    assert.ok(on.notes.includes(`BORDER_POST:${blockades(on)[0].target.systemId}`));
  });

  test("BP4 border line: territoryLine, lineOf (ownSpaceBelt line, cache, off / error), borderLineOf of "
    + "readBorderLine (source by lineOf result, secClass filter before the cut to maxSystems)", () => {
    const linear = (id) => [id - 1, id + 1].filter((x) => x >= 1 && x <= 8);
    const sys = (id) => (id >= 1 && id <= 8 ? { systemId: id, regionId: 100,
      secClass: id <= 4 ? "lowsec" : (id === 5 ? "highsec" : "nullsec"), factionId: id <= 4 ? F : (id === 5 ? 3 : null) }
      : null);
    assert.deepStrictEqual(territoryLine([3, 1, 2, 2], linear), [{ systemId: 3, outside: [4] }]);
    assert.deepStrictEqual(territoryLine([6, 3], (id) => (id === 3 ? null : linear(id))),
      [{ systemId: 6, outside: [5, 7] }]);
    assert.deepStrictEqual(territoryLine([], linear), []);
    const graph = { getSystemsBySecClass: (c) => [1, 2, 3, 4, 5, 6, 7, 8].filter((id) => sys(id).secClass === c),
      getSystem: sys, getNeighbors: linear };
    const doctrines = { own: { ownSpace: { secClasses: ["lowsec"], sovereignty: "self" } }, none: { ownSpace: null } };
    const entries = { [F]: { doctrineId: "own", homeRegionIds: [100] }, [NEUTRAL]: { doctrineId: "none",
      homeRegionIds: [100] } };
    const registry = { getFaction: (f) => entries[f] || null, isActive: () => true, getDoctrine: (d) => doctrines[d] };
    const index = createBorderIndex({ registry, getGraph: () => graph, settings: { maxBfsSystems: 2000 } });
    const line = index.lineOf(F);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(line)), { ok: true, mode: "ready",
      line: [{ systemId: 4, outside: [5] }] });
    assert.ok(Object.isFrozen(line.line) && Object.isFrozen(line.line[0]), "frozen line");
    assert.strictEqual(index.lineOf(F), line, "cached per graph and faction");
    assert.deepStrictEqual(index.lineOf(NEUTRAL), { ok: true, mode: "off", reason: "NO_OWN_SPACE" });
    assert.deepStrictEqual(index.lineOf(HOSTILE), { ok: true, mode: "off", reason: "NOT_IN_REGISTRY" });
    assert.deepStrictEqual(createBorderIndex({ registry, getGraph: () => null, settings: {} }).lineOf(F),
      { ok: false, reason: "GRAPH_NOT_READY" });
    const input = { own: line, territoryIds: [6, 7], neighbors: linear, secClassOf: (id) => (sys(id) || {}).secClass
      || null, secClasses: ["lowsec", "nullsec"], maxSystems: 64 };
    assert.deepStrictEqual(borderLineOf(input), [{ systemId: 4, outside: [5] }], "own space line");
    const territory = [{ systemId: 6, outside: [5] }, { systemId: 7, outside: [8] }];
    assert.deepStrictEqual(borderLineOf({ ...input, own: null }), territory, "no border index -> territory");
    assert.deepStrictEqual(borderLineOf({ ...input, own: index.lineOf(NEUTRAL) }), territory, "NO_OWN_SPACE");
    for (const own of [{ ok: true, mode: "off", reason: "NO_SOURCES" }, { ok: false, reason: "GRAPH_NOT_READY" }]) {
      assert.deepStrictEqual(borderLineOf({ ...input, own }), [], own.reason);
    }
    const mixed = { ok: true, mode: "ready", line: [1, 2, 3, 10, 11, 12].map((systemId) => ({ systemId, outside: [] })) };
    const secOf = (id) => (id <= 3 ? "highsec" : (id === 10 ? "lowsec" : "nullsec"));
    assert.deepStrictEqual(borderLineOf({ ...input, own: mixed, secClassOf: secOf, maxSystems: 2 })
      .map((x) => x.systemId), [10, 11]);
    assert.deepStrictEqual(borderLineOf({ ...input, own: mixed, secClassOf: secOf, secClasses: [] }), []);
    assert.deepStrictEqual(borderLineOf({ ...input, own: mixed, secClassOf: secOf, maxSystems: 0 }), []);
  });

  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("BP3 LAUNCH blockade of a fleet in T on a real store: real registerBlockadeInTx with maxFleets, STAGED "
    + "in place, operation ACTIVE, FLEET_OPERATION_COMPLETE at dueAt, no FLEET_ARRIVAL, replay = duplicate; "
    + "stub BLOCKADE_DISABLED keeps the LAUNCH (borderPostScanRefused)", () => H.withStore(driver, async (reopen) => {
    const clock = createManualClock(R.START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(47) }), graph: R.graphOf(),
      controllers: new Map(R.THEATRE.map((id) => [id, R.SANSHA])) };
    const holder = { blockade: null };
    const calls = [];
    const state = { fleetId: null, systemId: null, dueAt: 0, injected: 0 };
    const hooks = { beforeEffect: (d, snapshot) => {
      if (d.factionId !== R.SANSHA || d.outcome !== "REVIEWED" || state.fleetId === null
        || state.injected >= state.round) return d;
      const x = snapshot.fleets.find((y) => y.fleetId === state.fleetId);
      if (!x) return d;
      state.injected += 1;
      const intents = d.intents.filter((i) => !JSON.stringify(i).includes(state.fleetId));
      const touch = intents.findIndex((i) => i.type === "FACTION_TOUCH");
      intents.splice(touch < 0 ? intents.length : touch, 0, { type: "LAUNCH", kind: "blockade",
        target: { kind: "system", systemId: state.systemId, ref: null }, originSystemId: state.systemId,
        fleets: [{ fleetId: x.fleetId, expectedVersion: x.version }], mobilize: [], dueAt: state.dueAt });
      return { ...d, intents };
    } };
    const opened = reopen();
    const e = await R.bootAll(opened, shared, { EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: String(R.SANSHA),
      EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8", EVEJS_LNE_PRODUCTION_TARGET_STOCK_FLEETS: "0",
      EVEJS_LNE_STRATEGY_BLOCKADE_ENABLED: "1", EVEJS_LNE_PERSISTENCE_MAX_ROWS_PER_TRANSACTION: "1100" },
    { hooks, getBlockade: () => holder.blockade });
    const real = startBlockade({ config: e.config, persistence: { ok: true, store: opened.store, journal: e.journal,
      worldSeed: opened.worldSeed }, scheduler: e.scheduler, fleets: e.fleets });
    assert.ok(real.ok, JSON.stringify(real));
    assert.deepStrictEqual(Object.keys(real.blockade).sort(), ["countScan", "getMode", "getStatus",
      "registerBlockadeInTx", "stop"]);
    const counted = [];
    holder.blockade = { ...real.blockade, registerBlockadeInTx: (tx, spec, opts) => {
      calls.push({ spec, opts });
      return real.blockade.registerBlockadeInTx(tx, spec, opts);
    }, countScan: (scan) => {
      counted.push(scan);
      return real.blockade.countScan(scan);
    } };
    const base = e.q("SELECT system_id FROM world_stations WHERE owner_faction_id = ? AND state = 'ONLINE' "
      + "ORDER BY station_id", R.SANSHA)[0];
    assert.ok(base, "a Sansha station");
    const create = (tag) => {
      const c = e.fleets.createFleet({ factionId: R.SANSHA, currentSystemId: base.system_id,
        homeSystemId: base.system_id, fleetRole: "patrol", composition: SIX }, `${tag}:create`);
      assert.ok(c.ok, JSON.stringify(c));
      return c.fleetId;
    };
    Object.assign(state, { fleetId: create("bp3a"), systemId: base.system_id, dueAt: R.START_MS + R.I * 8, round: 1 });
    await R.passesAt(e, shared, R.START_MS + R.I);
    assert.strictEqual(state.injected, 1, "a Sansha review ran");
    const S = Math.min(e.config.strategy.borderPostScanMaxFleets, e.config.strategy.blockadeActivationScanMaxFleets);
    assert.deepStrictEqual(calls.map((c) => [c.spec.systemId, c.spec.factionId, c.spec.dueAt, c.opts]),
      [[base.system_id, R.SANSHA, state.dueAt, { chained: true, maxFleets: S }]]);
    const f1 = e.q("SELECT state, current_system_id AS s, operation_id AS op FROM virtual_fleets WHERE fleet_id = ?",
      state.fleetId)[0];
    assert.deepStrictEqual([f1.state, f1.s], ["STAGED", base.system_id]);
    const op = e.q("SELECT state, operation_type AS t, target_system_id AS s FROM world_operations "
      + "WHERE operation_id = ?", f1.op)[0];
    assert.deepStrictEqual([op.state, op.t, op.s], ["ACTIVE", "blockade", base.system_id]);
    const events = (type, id) => e.q("SELECT due_at FROM world_scheduled_events WHERE event_type = ? "
      + "AND aggregate_id = ?", type, id).map((x) => Number(x.due_at));
    assert.deepStrictEqual(events("FLEET_OPERATION_COMPLETE", f1.op), [state.dueAt]);
    assert.deepStrictEqual(events("FLEET_ARRIVAL", state.fleetId), []);
    const c1 = e.strategy.getStatus().ai.review.counters;
    assert.deepStrictEqual([c1.borderPostLaunched, c1.borderPostScanRefused], [1, 0]);
    assert.deepStrictEqual(counted, [{ ok: true, queued: 0, truncated: false, refused: 0 }]);
    assert.strictEqual(e.fleets.travel.getCounters().stagedInPlace, 1);
    const key = e.q("SELECT idempotency_key AS k FROM world_event_journal WHERE idempotency_key LIKE ?",
      `%:go:${state.fleetId}`)[0].k;
    const again = e.tx((db) => e.fleets.travel.stageInPlaceInTx(db, { fleetId: state.fleetId,
      at: R.START_MS + R.I }, key, { chained: true }));
    assert.deepStrictEqual([again.ok, again.duplicate], [true, true]);
    assert.strictEqual(e.fleets.travel.getCounters().stagedInPlace, 1);

    holder.blockade = createUnavailableBlockade("BLOCKADE_DISABLED");
    Object.assign(state, { fleetId: create("bp3b"), dueAt: R.START_MS + R.I * 9, round: 2 });
    await R.passesAt(e, shared, R.START_MS + 2 * R.I);
    assert.strictEqual(state.injected, 2, "a second Sansha review ran");
    assert.strictEqual(calls.length, 1, "the stub is not the spy");
    const f2 = e.q("SELECT state FROM virtual_fleets WHERE fleet_id = ?", state.fleetId)[0];
    assert.strictEqual(f2.state, "STAGED");
    const c2 = e.strategy.getStatus().ai.review.counters;
    assert.deepStrictEqual([c2.borderPostLaunched, c2.borderPostScanRefused], [2, 1]);
    real.blockade.stop();
    e.strategy.stop("test");
  }));
};
