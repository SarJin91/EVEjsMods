"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const { createJournal } = require("../../lib/persistence/journal");
const { createManualClock } = require("../../lib/util/clock");
const { createRng } = require("../../lib/util/rng");
const { createIdGenerator } = require("../../lib/util/ids");
const { buildUniverseGraph } = require("../../lib/graph/universeGraph");
const { createRouteFinder } = require("../../lib/graph/routes");
const { createViewRegistry } = require("../../lib/observer/views");
const { startScheduler } = require("../../lib/scheduler");
const { getEventType } = require("../../lib/scheduler/eventTypes");
const { startFleets } = require("../../lib/fleets");
const { startStations } = require("../../lib/stations");
const { startSiege, createUnavailableSiege } = require("../../lib/stations/siege");
const { REVIEW_ROWS, reliefRows } = require("../../lib/strategy/reviewRows");
const { EVENT_STRATEGY_INTENT } = require("../../lib/strategy/schema");
const { startStrategy } = require("../../lib/strategy");
const { createReactiveService } = require("../../lib/strategy/reactiveService");
const { startBlockade, createUnavailableBlockade } = require("../../lib/strategy/blockade");
const R_ROWS = require("../../lib/strategy/reviewRows");
const { createWorldStateRepository } = require("../../lib/world/worldStateRepository");
const { resolveConfig } = require("../../config");
const { harness: H } = require("../battle/settlement.test");
const { k3StaticMap } = require("./fixtures/k3Cluster.fixture");
const { HULL_GROUPS, FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../lib/fleets/schema");
const { createHostility } = require("../../lib/battle/data/hostility");
const { GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { REGISTRY_DATA_V1, createFactionRegistry } = require("../../lib/strategy/registry");
const { createOperationKinds } = require("../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../lib/strategy/data/operationKinds");
const { TARGET_SCORING_V1 } = require("../../lib/strategy/data/targetScoring");
const { SIEGE_ROLES } = require("../../lib/stations/siege/schema");
const { buildPowerTable, strengthOf } = require("../../lib/strategy/ai/strength");
const { decideReview, decideReactive, reactiveCanAct, idleReactive } = require("../../lib/strategy/ai");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const START_MS = 1760000000000;
const AMARR = 500003;
const SANSHA = 500019;
const SAMINER = 30001721;
const A_DZA8 = 30001954;
const THREATENED = 30001953;
const THREATENED_2 = A_DZA8;
const SERPENTIS = 500020;
const REVIEW = "FACTION_STRATEGY_REVIEW";
const LEGACY = "FACTION_REACTIVE_REVIEW";
const REACTIVE = "FACTION_REACTIVE_SWEEP";
const R = 60000;
const pad12 = (b) => String(b).padStart(12, "0");
const sweepKey = (b, r = R) => `strategy:sweep:${r}:${pad12(b)}`;
const HOUR = 3600000;
const THEATRE = [1867, 1868, 1869, 1870, 1871, 1872, 1893, 1894, 1895, 1896, 1897, 1898, 1899, 1900, 1901, 1902, 1903,
  1904, 1923, 1924, 1925, 1926, 1927, 1928, 1929, 1930, 1948, 1949, 1950, 1951, 1952, 1953, 1954, 1955]
  .map((n) => 30000000 + n);

const graph = (() => {
  const built = buildUniverseGraph(k3StaticMap());
  assert.ok(built.ok);
  return Object.freeze({ ...built.graph, ...createRouteFinder(built.graph, { cacheSize: 64, maxJumps: 40 }).publicApi });
})();

const registry = (() => {
  const r = createFactionRegistry(REGISTRY_DATA_V1, { hullGroups: HULL_GROUPS, fleetRoles: FLEET_ROLES,
    operationTypes: OPERATION_TYPES, hostility: createHostility(), maxFactions: 64, maxCampaignSystems: 40,
    maxShipsPerFleet: 500, maxCompositionEntries: 32, maxResourceUnits: 1000000000 });
  assert.ok(r.ok);
  return r.registry;
})();
const kinds = (() => {
  const k = createOperationKinds({ version: OPERATION_KINDS_VERSION, kinds: OPERATION_KINDS_V1 },
    { operationTypes: OPERATION_TYPES, objectives: OBJECTIVES, fleetRoles: FLEET_ROLES });
  assert.ok(k.ok, JSON.stringify(k));
  return k.kinds;
})();
const POWER = buildPowerTable(GROUPS);
const hostility = createHostility();
const PARAMS = Object.freeze({ maxReachJumps: 10, supplyChainJumps: 10, captureRangeFromStationJumps: 5,
  maxAssemblyJumps: 15, maxBfsSystems: 2000, maxTargetCandidates: 40, targetPickTopK: 3, maxOperationsPerReview: 1,
  maxFleetsPerOperation: 4, maxFleetsPerFaction: 12, maxMobilizationsPerReview: 2, mobilizeResourcePerShip: 10,
  mobilizeReservePerShip: 1, attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR, maxObservationsPerReview: 8,
  reconWindowMs: HOUR / 2, attackWindowMs: 2 * HOUR, operationGraceMs: HOUR, maxHousekeepingPerReview: 4,
  maxRefitRequestsPerReview: 2, kinds: kinds.list, scoring: TARGET_SCORING_V1, powerTable: POWER, frontLimitCap: 2,
  routeMaxJumps: 40, maxCapturedSystemsPerFaction: 24, captureRequiresAdjacency: true,
  defense: { enabled: true, maxPerReview: 1 }, maxThreatsRead: 32, maxLostHomeRead: 32,
  siege: { reliefEnabled: true, reliefLeadMs: HOUR, reliefHoldMs: HOUR, maxReliefPerReview: 1,
    fleetRoles: SIEGE_ROLES } });
const COMP = Object.freeze([{ hullGroup: "cruiser", typeId: null, count: 4 }]);
const fleet = (fleetId, systemId, extra = {}) => ({ fleetId, version: 1, state: "IDLE", fleetRole: "invasion",
  systemId, refitPending: false, shipCount: 4, strength: strengthOf(COMP, POWER), operationId: null, legSeq: 0,
  homeSystemId: systemId, ...extra });

function fullSnap(o) {
  const entry = registry.getFaction(AMARR);
  const doctrine = registry.getDoctrine(entry.doctrineId);
  const controllers = new Map(THEATRE.map((id) => [id, SANSHA]));
  const ids = [...new Set([...THEATRE, SAMINER])].sort((a, b) => a - b);
  return {
    v: 1, factionId: AMARR, round: 7, at: START_MS, seed: 12345,
    faction: { status: "ACTIVE", homeSystemId: entry.hqSystemId, doctrineId: doctrine.doctrineId, resourceUnits: 20000,
      reserveUnits: 300, frontLimit: 1, version: 3 },
    entry: { kind: entry.kind, maxActiveFronts: entry.maxActiveFronts, allies: [...entry.allies],
      homeRegionIds: [...entry.homeRegionIds], ownerCorporationId: entry.ownerCorporationId },
    doctrine: { doctrineId: doctrine.doctrineId, canOccupy: doctrine.canOccupy,
      operationTypes: [...doctrine.operationTypes], reachJumps: doctrine.reachJumps, templates: doctrine.templates,
      captureTargets: doctrine.captureTargets },
    theatre: THEATRE,
    neighbors: (id) => graph.getNeighbors(id),
    regionOf: (id) => (graph.getSystem(id) ? graph.getSystem(id).regionId : null),
    isHostile: (x) => x !== AMARR && !entry.allies.includes(x) && hostility(AMARR, x),
    stationsMode: "ready", stations: [{ systemId: SAMINER, stationId: "st0" }], captureAnchors: [SAMINER],
    systems: ids.map((systemId) => ({ systemId, controllerFactionId: controllers.get(systemId) || null,
      occupationState: "STABLE", controllerGarrison: 0, hostileStations: 0, observed: false, homeFactionId: null })),
    fleets: o.fleets, fleetsTruncated: false, operations: [], operationsTruncated: false, intel: [], sightings: [],
    threats: o.threats || { mode: "off", items: [] }, siege: o.siege || null,
    lostHome: { mode: "off", systemIds: [] }, capturedIds: [], upkeep: { mode: "off" }, territoryTruncated: false,
    occupations: [],
  };
}

const reactiveOf = (s, room) => ({ v: 1, factionId: s.factionId, round: s.round, at: s.at,
  doctrine: { doctrineId: s.doctrine.doctrineId, canOccupy: s.doctrine.canOccupy,
    operationTypes: s.doctrine.operationTypes }, fleets: s.fleets, operations: s.operations,
  operationsTruncated: s.operationsTruncated, threats: s.threats, siege: s.siege, neighbors: s.neighbors,
  reactive: { room } });

function configOf(env) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(),
    EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: String(AMARR), EVEJS_LNE_UPKEEP_ENABLED: "0",
    EVEJS_LNE_STRATEGY_BORDER_ENABLED: "0", ...env } });
  assert.deepStrictEqual(r.errors || [], []);
  return r.config;
}

function threatWorld(holder) {
  const controllers = new Map(THEATRE.map((id) => [id, SANSHA]));
  for (const id of [SAMINER, THREATENED, THREATENED_2]) controllers.set(id, AMARR);
  for (const [id, f] of holder.ctrl || []) controllers.set(id, f);
  const threatOf = (f, occupier) => (id) => ({ systemId: id, controllerFactionId: f, occupationState: "INVASION",
    occupierFactionId: occupier, phaseDueAt: null, influence: [{ factionId: occupier, garrisonStrength: 1 }] });
  return { repository: { limits: { maxBatchReadIds: 8 }, getChangeCount: () => 0,
    getSystem: (tx, id) => ({ ok: true, system: controllers.has(id)
      ? { systemId: id, controllerFactionId: controllers.get(id) } : null }),
    getSystems: (tx, ids) => ({ ok: true, systems: ids.filter((id) => controllers.has(id)).map((id) => ({ systemId: id,
      controllerFactionId: controllers.get(id), occupationState: "STABLE", influence: [] })), missing: [] }),
    listThreatened: (tx, f) => ({ ok: true, systems: f === AMARR ? holder.threats.map(threatOf(AMARR, SANSHA))
      : ((holder.others && holder.others[f]) || []).map(threatOf(f, AMARR)) }),
    listLostHome: () => ({ ok: true, systems: [] }),
    listByOccupier: (tx, f) => ({ ok: true, systems: (f === AMARR && holder.claims) || [] }),
    listControlledByFaction: () => ({ ok: true, systems: [] }),
    countControlledByFaction: () => ({ ok: true, count: 3 }),
    ...(holder.controllers ? { listThreatenedControllers: () => {
      if (holder.controllers === "fail") return { ok: false, reason: "RXG_BOOM" };
      const ids = [...(holder.threats.length > 0 ? [AMARR] : []), ...Object.keys(holder.others || {}).map(Number)
        .filter((f) => holder.others[f].length > 0)].sort((a, b) => a - b);
      return { ok: true, factionIds: ids, truncated: holder.controllers === "truncated" };
    } } : {}) } };
}

async function boot(opened, shared, env, holder) {
  const config = configOf(env);
  const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500,
    ...(holder.onCount ? { onCount: holder.onCount } : {}) });
  const graphService = { whenReady: () => Promise.resolve({ ok: true, graph }),
    getGraph: () => ({ ok: true, graph }) };
  const persistence = { ok: true, store: opened.store, journal, worldSeed: opened.worldSeed };
  const sr = startScheduler({ config, persistence: { ok: true, store: opened.store }, clock: shared.clock,
    ids: shared.ids, nowMs: () => 0 });
  assert.ok(sr.ok, JSON.stringify(sr));
  const stations = { value: null };
  const fr = startFleets({ config, persistence, clock: shared.clock, ids: shared.ids, scheduler: sr.scheduler,
    graph: graphService, presence: null, views: createViewRegistry(), getStations: () => stations.value });
  assert.ok(fr.ok, JSON.stringify(fr));
  holder.enqueued = [];
  holder.lastEffect = null;
  const wrapScheduler = (sch) => ({ ...sch,
    enqueueMany: (specs) => {
      holder.enqueued.push(...specs.map((s) => s.eventType));
      return sch.enqueueMany(specs);
    },
    registerHandler: (type, h, o) => {
      if (type === REVIEW) return { ok: true, unregister() {} };
      if (type !== REACTIVE) return sch.registerHandler(type, h, o);
      return sch.registerHandler(type, (ev, hctx) => {
        const r = h(ev, hctx);
        if (r && r.effect) holder.lastEffect = r.effect;
        return r;
      }, o);
    } });
  const lines = [];
  const read = (name, f) => {
    if (holder.reads) holder.reads.push([name, f]);
  };
  const spyFleets = { ...fr.fleets, repository: { ...fr.fleets.repository,
    listFleetsByFaction: (db, f, o) => (read("fleets", f), fr.fleets.repository.listFleetsByFaction(db, f, o)),
    listOperations: (db, o) => (read(o.operationTypes ? "incoming" : "operations", o.factionId),
    fr.fleets.repository.listOperations(db, o)) },
    travel: { ...fr.fleets.travel, stageInPlaceInTx: (...a) => (holder.refuseStage
      ? { ok: false, reason: "XP6_STAGE_REFUSED" } : fr.fleets.travel.stageInPlaceInTx(...a)) } };
  const spyJournal = { ...journal, scanKeyRange: (db, from, to, limit) => (read("window",
    Number(String(from).split(":")[2])), journal.scanKeyRange(db, from, to, limit)) };
  let blockade = null;
  if (holder.blockade === "real") {
    const bk = startBlockade({ config, persistence, scheduler: sr.scheduler, fleets: fr.fleets,
      logger: { log: (l) => lines.push(l) } });
    assert.ok(bk.ok, JSON.stringify(bk));
    blockade = bk.blockade;
  } else if (holder.blockade) blockade = holder.blockade;
  const st = startStrategy({ config, persistence: { ...persistence, journal: spyJournal }, clock: shared.clock,
    graph: graphService, world: threatWorld(holder), scheduler: wrapScheduler(sr.scheduler),
    fleets: spyFleets, getStations: () => stations.value, views: createViewRegistry(),
    logger: { log: (l) => lines.push(l) },
    ...(holder.siege ? { getSiege: () => holder.siege } : {}), ...(blockade ? { getBlockade: () => blockade } : {}) });
  assert.ok(st.ok, JSON.stringify(st));
  await st.strategy.whenReady();
  const stR = startStations({ config, persistence, strategy: st.strategy, graph: graphService, clock: shared.clock,
    views: createViewRegistry() });
  assert.ok(stR.ok, JSON.stringify(stR));
  stations.value = stR.stations;
  await stR.stations.whenReady();
  const tx = (fn) => {
    const r = opened.store.transaction("test", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  const q = (sql, ...args) => tx((db) => db.prepare(sql).all(...args));
  return { config, scheduler: sr.scheduler, fleets: fr.fleets, strategy: st.strategy, journal, tx, q, lines,
    store: opened.store, stations: stR.stations, graphService, blockade };
}

async function passesAt(env, shared, at) {
  shared.clock.set(at);
  for (let i = 0; i < 20; i += 1) {
    const p = await env.scheduler.runPass();
    assert.ok(p.ok, JSON.stringify(p));
    if (!p.jobs) return;
  }
}

const chain = (env, state, type = REACTIVE) => env.q(`SELECT idempotency_key AS k, state, due_at AS due, payload,
  outcome FROM world_scheduled_events WHERE event_type = ?${state ? " AND state = ?" : ""}
  ORDER BY due_at, idempotency_key`, type, ...(state ? [state] : []));
const factionRow = (env) => env.q("SELECT * FROM world_factions WHERE faction_id = ?", AMARR)[0];
const defenseOps = (env, f = AMARR) => env.q("SELECT operation_id AS id, idempotency_key AS k, target_system_id AS t, "
  + "state FROM world_operations WHERE faction_id = ? AND operation_type = 'defense' ORDER BY planned_at, operation_id",
  f);
const journalRows = (env) => env.q("SELECT COUNT(*) AS n FROM world_event_journal")[0].n;
const roundOf = (row) => JSON.parse(row.payload).round;
const keysOf = (rows) => rows.map((x) => x.k);

function patrols(env, n, tag, f = AMARR, at = SAMINER) {
  for (let i = 0; i < n; i += 1) {
    const made = env.fleets.createFleet({ factionId: f, currentSystemId: at, homeSystemId: at,
      fleetRole: "patrol", composition: [{ hullGroup: "cruiser", count: 4 }] }, `${tag}:f${i}`);
    assert.ok(made.ok, JSON.stringify(made));
  }
}

const SANSHA_PAIR = (() => {
  for (const a of THEATRE) {
    const near = graph.getNeighbors(a).filter((x) => THEATRE.includes(x));
    if (near.length >= 2) return [a, near[0], near[1]];
  }
  throw new Error("no theatre system with two theatre neighbours");
})();

function seedRow(env, type, key, payload, state, finishedAt) {
  const e = env.scheduler.enqueue(type, type === LEGACY ? String(payload.factionId) : "reactive", START_MS + 1000 * HOUR,
    payload, key);
  assert.ok(e.ok && !e.duplicate, JSON.stringify(e));
  const run = (sql, ...args) => env.tx((db) => db.prepare(sql).run(...args));
  if (state === "DONE") {
    run("UPDATE world_scheduled_events SET state = 'DONE', outcome = 'IDLE', finished_at = ? WHERE idempotency_key = ?",
      finishedAt, key);
  }
  else if (state === "CLAIMED") {
    run("UPDATE world_scheduled_events SET state = 'CLAIMED', claimed_at = ? WHERE idempotency_key = ?", START_MS, key);
  }
}

const rotation = (ids, b) => {
  const s = [...ids].sort((x, y) => x - y);
  const i = b % s.length;
  return [...s.slice(i), ...s.slice(0, i)];
};

const ON = { EVEJS_LNE_STRATEGY_REACTIVE_ENABLED: "1" };

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("RX1 decideReactive parity: INVASION threat and a besieged own station -> intents deepStrictEqual the LAUNCH "
    + "defense of decideReview; room 0 -> none + REACTIVE_CAPPED; every intent LAUNCH defense without mobilization",
  () => {
    const threats = { mode: "ready", truncated: false, items: [{ systemId: A_DZA8, state: "INVASION",
      occupier: SANSHA, occupierStrength: 1000, phaseDueAt: START_MS + HOUR }] };
    const siege = { mode: "ready", attacking: [], truncated: false, defending: [{ siegeId: "sg_rx1", stationId: "st0",
      systemId: SAMINER, state: "SHIELD_ASSAULT", phaseEndsAt: START_MS + HOUR, attackerFactionId: SANSHA,
      attackerStrength: 1 }] };
    const scenarios = [
      fullSnap({ fleets: [fleet("f1", SAMINER), fleet("f2", SAMINER)], threats }),
      fullSnap({ fleets: [fleet("g1", A_DZA8, { fleetRole: "patrol" }), fleet("g2", 30001953)], siege }),
    ];
    for (const s of scenarios) {
      const full = decideReview(s, PARAMS);
      assert.strictEqual(full.outcome, "REVIEWED", JSON.stringify(full.reason));
      const want = full.intents.filter((i) => i.type === "LAUNCH" && i.kind === "defense");
      assert.ok(want.length > 0, JSON.stringify(full.notes));
      const d = decideReactive(reactiveOf(s, 4), PARAMS);
      assert.strictEqual(d.outcome, "REACTED", JSON.stringify(d));
      assert.deepStrictEqual(d.intents, want);
      for (const i of d.intents) assert.deepStrictEqual([i.type, i.kind, i.mobilize], ["LAUNCH", "defense", []]);
      assert.deepStrictEqual(decideReactive(reactiveOf(s, 4), PARAMS), d);
      const capped = decideReactive(reactiveOf(s, 0), PARAMS);
      assert.deepStrictEqual([capped.outcome, capped.intents], ["IDLE", []]);
      assert.ok(capped.notes.includes("REACTIVE_CAPPED"), JSON.stringify(capped.notes));
    }
    const idle = decideReactive(reactiveOf(fullSnap({ fleets: [fleet("h1", SAMINER)] }), 4), PARAMS);
    assert.deepStrictEqual([idle.outcome, idle.intents, idle.notes], ["IDLE", [], []]);
  });

  test("RX1b: a fleet in reach of a besieged station and of a threat goes to the relief only (decideReview "
    + "and decideReactive): one fleet -> relief + DEFENSE_INSUFFICIENT; two fleets -> disjoint relief and defense",
  () => {
    const threats = { mode: "ready", truncated: false, items: [{ systemId: A_DZA8, state: "INVASION",
      occupier: SANSHA, occupierStrength: 1, phaseDueAt: START_MS + HOUR }] };
    const siege = { mode: "ready", attacking: [], truncated: false, defending: [{ siegeId: "sg_rx1b", stationId: "st0",
      systemId: SAMINER, state: "SHIELD_ASSAULT", phaseEndsAt: START_MS + HOUR, attackerFactionId: SANSHA,
      attackerStrength: 1 }] };
    const fleetsOf = (i) => i.fleets.map((f) => f.fleetId);
    const launches = (intents) => intents.filter((i) => i.type === "LAUNCH" && i.kind === "defense");
    const noDuplicate = (intents) => {
      const ids = intents.filter((i) => i.type === "LAUNCH").flatMap(fleetsOf);
      assert.strictEqual(new Set(ids).size, ids.length, JSON.stringify(ids));
    };
    const cases = [
      { fleets: [fleet("c1", THREATENED)], want: [[SAMINER, ["c1"]]], insufficient: true },
      { fleets: [fleet("c1", THREATENED), fleet("c2", THREATENED)], want: [[SAMINER, ["c1"]], [A_DZA8, ["c2"]]],
        insufficient: false },
    ];
    for (const c of cases) {
      const s = fullSnap({ fleets: c.fleets, threats, siege });
      const full = decideReview(s, PARAMS);
      assert.strictEqual(full.outcome, "REVIEWED", JSON.stringify(full.reason));
      noDuplicate(full.intents);
      assert.deepStrictEqual(launches(full.intents).map((i) => [i.target.systemId, fleetsOf(i)]), c.want,
        JSON.stringify(full.notes));
      assert.strictEqual(full.notes.includes(`DEFENSE_INSUFFICIENT:${A_DZA8}`), c.insufficient,
        JSON.stringify(full.notes));
      const d = decideReactive(reactiveOf(s, 4), PARAMS);
      assert.strictEqual(d.outcome, "REACTED", JSON.stringify(d));
      noDuplicate(d.intents);
      assert.deepStrictEqual(d.intents, launches(full.intents));
      assert.strictEqual(d.notes.includes(`DEFENSE_INSUFFICIENT:${A_DZA8}`), c.insufficient, JSON.stringify(d.notes));
    }
  });

  needsDriver("RX2 reactive round on a real store: no threat -> IDLE, no journal row; a threat -> LAUNCH defense "
    + "(operation key strategy:react:, fleet planned), successor round + 1, faction row untouched; the replayed "
    + "effect is a duplicate", () => H.withStore(driver, async (reopen) => {
    const clock = createManualClock(START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(41) }) };
    const holder = { threats: [] };
    const env = await boot(reopen(), shared, ON, holder);
    assert.deepStrictEqual(env.strategy.getStatus().ai.reactive.bootstrap, { enqueued: 1, duplicates: 0,
      reason: null });
    patrols(env, 2, "rx2");
    const [first] = chain(env, "QUEUED");
    const before = factionRow(env);
    const rows0 = journalRows(env);
    await passesAt(env, shared, first.due);
    assert.strictEqual(chain(env).find((x) => x.k === first.k).outcome, "IDLE");
    assert.strictEqual(journalRows(env), rows0, "an idle round writes no journal row");
    const [second] = chain(env, "QUEUED");
    assert.deepStrictEqual([roundOf(second), second.due - first.due], [roundOf(first) + 1, R]);

    holder.threats = [THREATENED];
    await passesAt(env, shared, second.due);
    assert.strictEqual(chain(env).find((x) => x.k === second.k).outcome, "REACTED");
    const ops = defenseOps(env);
    assert.strictEqual(ops.length, 1, env.lines.join("\n"));
    assert.strictEqual(ops[0].k, `strategy:react:${AMARR}:${R}:${pad12(roundOf(second))}:s0:LAUNCH:op`);
    assert.strictEqual(ops[0].t, THREATENED);
    const moving = env.q("SELECT state FROM virtual_fleets WHERE faction_id = ? AND operation_id = ?", AMARR, ops[0].id);
    assert.ok(moving.length === 1 && moving[0].state !== "IDLE", JSON.stringify(moving));
    const after = factionRow(env);
    assert.deepStrictEqual([after.version, after.resource_units, after.reserve_units, after.last_review_at],
      [before.version, before.resource_units, before.reserve_units, before.last_review_at], "R3: no faction write");
    assert.strictEqual(roundOf(chain(env, "QUEUED")[0]), roundOf(second) + 1);
    const c = env.strategy.getStatus().ai.reactive.counters;
    assert.deepStrictEqual([c.sweeps, c.runs, c.idle, c.reacted, c.launches, c.defenses, c.reliefs],
      [2, 2, 1, 1, 1, 1, 0]);
    const replay = env.tx((db) => holder.lastEffect(db));
    assert.ok(replay.ok && replay.factions.length === 1 && replay.factions[0].launches.length === 0
      && replay.factions[0].refused.length === 0, JSON.stringify(replay));
    assert.strictEqual(defenseOps(env).length, 1);
    env.strategy.stop("test");
  }));

  needsDriver("RXR1: two overdue sweep rows (the old chain + the bootstrap "
    + "row after a downtime) run in one bucket -> the second sweep keeps the faction idle (roundRepeated 1), no "
    + "journal conflict, one defense; the successor converges", () => H.withStore(driver, async (reopen) => {
    const clock = createManualClock(START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(61) }) };
    const counted = [];
    const holder = { threats: [THREATENED, THREATENED_2], onCount: (name, n, detail) => counted.push([name, detail]) };
    const env = await boot(reopen(), shared, ON, holder);
    patrols(env, 3, "rxr1");
    const [first] = chain(env, "QUEUED");
    const late = roundOf(first) + 3;
    const e = env.scheduler.enqueue(REACTIVE, "reactive", first.due + 3 * R, { round: late, intervalMs: R },
      sweepKey(late));
    assert.ok(e.ok && !e.duplicate, JSON.stringify(e));
    await passesAt(env, shared, first.due + 10 * R);
    const rows = chain(env);
    assert.deepStrictEqual(rows.filter((x) => x.k === first.k || x.k === sweepKey(late)).map((x) => x.state),
      ["DONE", "DONE"], JSON.stringify(rows));
    assert.deepStrictEqual(counted.filter((x) => x[0] === "journal.conflict"), [], env.lines.join("\n"));
    assert.strictEqual(defenseOps(env).length, 1, env.lines.join("\n"));
    const c = env.strategy.getStatus().ai.reactive.counters;
    assert.deepStrictEqual([c.sweeps, c.launches, c.intentRefused, c.roundRepeated], [2, 1, 0, 1], JSON.stringify(c));
    assert.strictEqual(chain(env, "QUEUED").length, 1, "both successors converge on one key");
    env.strategy.stop("test");
  }));

  needsDriver("RXH1 (replaces) reactive read on a real store: the last holder of a fresh own INVASION "
    + "claim goes to the defense of a threatened own system in the first round (outcome REACTED)",
  () => H.withStore(driver, async (reopen) => {
    const clock = createManualClock(START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(53) }) };
    const claimRow = { systemId: SAMINER, occupationState: "INVASION", occupierFactionId: AMARR,
      lastStateChangeAt: START_MS };
    const holder = { threats: [THREATENED], claims: [claimRow] };
    const env = await boot(reopen(), shared, ON, holder);
    patrols(env, 1, "rxh1");
    const [first] = chain(env, "QUEUED");
    await passesAt(env, shared, first.due);
    assert.strictEqual(chain(env).find((x) => x.k === first.k).outcome, "REACTED", env.lines.join("\n"));
    assert.deepStrictEqual(defenseOps(env).map((o) => o.t), [THREATENED], env.lines.join("\n"));
    env.strategy.stop("test");
  }));

  needsDriver("RX3 hour limit from the journal survives a restart: limit 1 -> round 1 LAUNCH; new process, a new "
    + "threat at round 1 + 5 -> capped; round 1 + W -> LAUNCH", () => H.withStore(driver, async (reopen) => {
    const clock = createManualClock(START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(43) }) };
    const holder = { threats: [THREATENED] };
    const ENV = { ...ON, EVEJS_LNE_STRATEGY_REACTIVE_MAX_LAUNCHES_PER_HOUR: "1" };
    const opened = reopen();
    const env = await boot(opened, shared, ENV, holder);
    patrols(env, 3, "rx3");
    const [first] = chain(env, "QUEUED");
    await passesAt(env, shared, first.due);
    assert.deepStrictEqual(defenseOps(env).map((o) => o.t), [THREATENED], env.lines.join("\n"));
    env.strategy.stop("restart");
    opened.store.close("restart");

    const env2 = await boot(reopen(), shared, ENV, holder);
    holder.threats = [THREATENED, THREATENED_2];
    await passesAt(env2, shared, first.due + 5 * R);
    assert.deepStrictEqual(defenseOps(env2).map((o) => o.t), [THREATENED], "the hour limit holds after a restart");
    assert.strictEqual(env2.strategy.getStatus().ai.reactive.counters.capped, 1);
    const W = Math.ceil(HOUR / R);
    await passesAt(env2, shared, first.due + W * R);
    assert.deepStrictEqual(defenseOps(env2).map((o) => o.t), [THREATENED, THREATENED_2], env2.lines.join("\n"));
    env2.strategy.stop("test");
  }));

  test("RX4 wiring: flag off -> bootstrap enqueues nothing, a queued round ends SKIPPED without a successor; event "
    + "type; env -> config.strategy; STALE_INTERVAL successor = the bootstrap key; key length; real facade methods",
  async () => {
    const t = getEventType(REACTIVE);
    assert.deepStrictEqual([t.priority, t.aggregateType, t.periodic], [4, "strategy", true]);
    const legacy = getEventType(LEGACY);
    assert.deepStrictEqual([legacy.priority, legacy.aggregateType, legacy.periodic], [4, "faction", true]);
    const cfg = configOf({ EVEJS_LNE_STRATEGY_REACTIVE_ENABLED: "1", EVEJS_LNE_STRATEGY_REACTIVE_INTERVAL_MS: "120000",
      EVEJS_LNE_STRATEGY_REACTIVE_MAX_REVIEWS_PER_PASS: "3", EVEJS_LNE_STRATEGY_REACTIVE_MAX_LAUNCHES_PER_HOUR: "2",
      EVEJS_LNE_STRATEGY_REACTIVE_DONE_RETENTION_MS: "700000", EVEJS_LNE_STRATEGY_REACTIVE_PRUNE_BATCH: "5" }).strategy;
    assert.deepStrictEqual([cfg.reactiveEnabled, cfg.reactiveIntervalMs, cfg.maxReactiveReviewsPerPass,
      cfg.reactiveMaxLaunchesPerHour, cfg.reactiveDoneRetentionMs, cfg.reactivePruneBatch],
    [true, 120000, 3, 2, 700000, 5]);
    const def = configOf({}).strategy;
    assert.deepStrictEqual([def.reactiveEnabled, def.reactiveIntervalMs, def.maxReactiveReviewsPerPass,
      def.reactiveMaxLaunchesPerHour, def.reactiveDoneRetentionMs, def.reactivePruneBatch],
    [true, 60000, 4, 4, 3600000, 4]);
    const worst = createReactiveService({ config: { strategy: { reactiveIntervalMs: 900000 } }, worldSeed: 1,
      liveFleetStates: [] }).schedule.keyOf(999999999, 999999999999);
    const farClock = createManualClock(4102444800000);
    const fleetId = createIdGenerator({ clock: farClock, rng: createRng(1) }).next("fleet");
    const longest = `${worst}:s63:LAUNCH:go:${fleetId}`;
    assert.ok(longest.length <= 129, `${longest.length} ${longest}`);

    if (!driver.ok) return;
    await H.withStore(driver, async (reopen) => {
      const clock = createManualClock(START_MS);
      const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(47) }) };
      const holder = { threats: [] };
      const env = await boot(reopen(), shared, { EVEJS_LNE_STRATEGY_REACTIVE_ENABLED: "0" }, holder);
      assert.strictEqual(holder.enqueued.includes(REACTIVE), false, "flag off: no enqueueMany of the chain");
      assert.deepStrictEqual(env.strategy.getStatus().ai.reactive.bootstrap, { enqueued: 0, duplicates: 0,
        reason: null });
      assert.deepStrictEqual(chain(env), []);
      for (const fn of [env.fleets.repository.createOperation, env.fleets.travel.planInTx,
        env.fleets.repository.listOperations, env.fleets.repository.listFleetsByFaction,
        env.journal.scanKeyRange, env.scheduler.purgeDone,
        createWorldStateRepository({ journal: env.journal, clock, limits: { maxFactionsPerSystem: 8,
          maxBatchReadIds: 8, maxListLimit: 64 } }).listThreatened]) assert.strictEqual(typeof fn, "function");
      const sg = startSiege({ config: env.config, persistence: { ok: true, store: env.store, journal: env.journal },
        scheduler: env.scheduler, fleets: env.fleets, strategy: env.strategy, getStations: () => env.stations,
        clock, ids: shared.ids, graph: env.graphService, views: createViewRegistry() });
      assert.ok(sg.ok, JSON.stringify(sg));
      const split = env.tx((db) => sg.siege.readForFactions(db, [AMARR, SANSHA], {}));
      assert.ok(split.ok && split.byFaction instanceof Map, JSON.stringify(split));
      assert.deepStrictEqual([...split.byFaction.keys()], [AMARR, SANSHA]);
      assert.deepStrictEqual(env.tx((db) => sg.siege.readForFaction(db, AMARR, {})),
        { ok: true, ...split.byFaction.get(AMARR), truncated: split.truncated });
      assert.strictEqual(createUnavailableSiege("off").readForFactions().reason, "SIEGE_UNAVAILABLE");
      sg.siege.stop();
      const due = START_MS + R;
      const e = env.scheduler.enqueue(REACTIVE, "reactive", due, { round: 1, intervalMs: R }, sweepKey(1));
      assert.ok(e.ok, JSON.stringify(e));
      await passesAt(env, shared, due);
      assert.deepStrictEqual(chain(env).map((x) => [x.state, x.outcome]), [["DONE", "SKIPPED"]], "no successor");
      env.strategy.stop("test");
    });
    await H.withStore(driver, async (reopen) => {
      const clock = createManualClock(START_MS);
      const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(53) }) };
      const env = await boot(reopen(), shared, ON, { threats: [] });
      const [boot1] = chain(env, "QUEUED");
      const stale = env.scheduler.enqueue(REACTIVE, "reactive", START_MS, { round: 7, intervalMs: 120000 },
        sweepKey(7, 120000));
      assert.ok(stale.ok, JSON.stringify(stale));
      await passesAt(env, shared, START_MS);
      const rows = chain(env);
      assert.deepStrictEqual(rows.map((x) => [x.k, x.state, x.outcome]), [
        [sweepKey(7, 120000), "DONE", "STALE_INTERVAL"], [boot1.k, "QUEUED", null]]);
      assert.strictEqual(env.strategy.getStatus().ai.reactive.counters.stale, 1);
      env.strategy.stop("test");
    });
  });

  needsDriver("RX5 retention: 70 idle rounds (R 60 s, retention 600 s, batch 4) -> DONE rows of the reactive chain "
    + "<= 600000 / 60000 + 4; the rows of the full review untouched", () => H.withStore(driver, async (reopen) => {
    const clock = createManualClock(START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(59) }) };
    const env = await boot(reopen(), shared, { ...ON, EVEJS_LNE_STRATEGY_REACTIVE_DONE_RETENTION_MS: "600000",
      EVEJS_LNE_STRATEGY_REACTIVE_PRUNE_BATCH: "4" }, { threats: [] });
    const full = () => env.q("SELECT idempotency_key AS k, state FROM world_scheduled_events WHERE event_type = ? "
      + "ORDER BY idempotency_key", REVIEW);
    const fullBefore = full();
    const [first] = chain(env, "QUEUED");
    for (let k = 0; k < 70; k += 1) await passesAt(env, shared, first.due + k * R);
    const done = chain(env, "DONE");
    assert.ok(done.every((x) => x.outcome === "IDLE"), JSON.stringify(done.slice(0, 3)));
    assert.ok(done.length <= 600000 / R + 4, `DONE ${done.length}`);
    assert.ok(done.length >= 600000 / R, `DONE ${done.length}: the young rows stay`);
    assert.strictEqual(env.strategy.getStatus().ai.reactive.counters.runs, 70);
    assert.deepStrictEqual(full(), fullBefore);
    env.strategy.stop("test");
  }));

  const ONE_QUERY = { ...ON, EVEJS_LNE_STRATEGY_MAX_OPEN_OPERATIONS_READ: "4" };
  const factionsEnv = (ids, extra = {}) => ({ ...ON, EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: ids.join(","), ...extra });

  needsDriver("RXS1 sweep of 3 factions, one threatened: one event DONE REACTED + successor b+1, journal intent "
    + "strategy:react:<f>:<R>:<b12>:s0:LAUNCH with its operation, sweeps 1 runs 3 reacted 1 idle 2; PLANNED + ACTIVE "
    + "in one query = the old loop per state (operations, truncated)", () => H.withStore(driver, async (reopen) => {
    const clock = createManualClock(START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(61) }) };
    const holder = { threats: [THREATENED] };
    const env = await boot(reopen(), shared, factionsEnv([AMARR, SANSHA, SERPENTIS],
      { EVEJS_LNE_STRATEGY_MAX_OPEN_OPERATIONS_READ: ONE_QUERY.EVEJS_LNE_STRATEGY_MAX_OPEN_OPERATIONS_READ }), holder);
    patrols(env, 2, "rxs1");
    const opIds = [];
    for (let i = 0; i < 6; i += 1) {
      const made = env.fleets.createFleet({ factionId: SERPENTIS, currentSystemId: SAMINER, homeSystemId: SAMINER,
        fleetRole: "patrol", composition: [{ hullGroup: "cruiser", count: 4 }] }, `rxs1:s${i}`);
      assert.ok(made.ok, JSON.stringify(made));
      const [{ version }] = env.q("SELECT version FROM virtual_fleets WHERE fleet_id = ?", made.fleetId);
      const op = env.fleets.createOperation({ operationType: "patrol", factionId: SERPENTIS, originSystemId: SAMINER,
        targetSystemId: THREATENED, objective: "patrol", dueAt: START_MS + HOUR,
        fleets: [{ fleetId: made.fleetId, expectedVersion: version }] }, `rxs1:op${i}`);
      assert.ok(op.ok, JSON.stringify(op));
      opIds.push(op.operationId);
    }
    const sorted = [...opIds].sort();
    env.tx((db) => {
      for (const id of [sorted[1], sorted[3]]) {
        db.prepare("UPDATE world_operations SET state = 'ACTIVE' WHERE operation_id = ?").run(id);
      }
    });
    const repo = env.fleets.repository;
    const max = env.config.strategy.maxOpenOperationsRead;
    const old = env.tx((db) => ["PLANNED", "ACTIVE"].flatMap((state) => repo.listOperations(db,
      { factionId: SERPENTIS, state, limit: max + 1 }).operations));
    const one = env.tx((db) => repo.listOperations(db, { factionId: SERPENTIS, states: ["PLANNED", "ACTIVE"],
      limit: max + 1 }));
    const view = (ops) => ops.map((o) => [o.operationId, o.state]);
    const oldSorted = old.sort((x, y) => (x.operationId < y.operationId ? -1 : 1));
    assert.deepStrictEqual([view(one.operations.slice(0, max)), one.operations.length > max],
      [view(oldSorted.slice(0, max)), oldSorted.length > max]);
    assert.deepStrictEqual([view(oldSorted.slice(0, max)).map((x) => x[1]), oldSorted.length > max],
      [["PLANNED", "ACTIVE", "PLANNED", "ACTIVE"], true]);

    const [first] = chain(env, "QUEUED");
    const b = roundOf(first);
    assert.strictEqual(first.k, sweepKey(b));
    assert.deepStrictEqual(JSON.parse(first.payload), { round: b, intervalMs: R });
    await passesAt(env, shared, first.due);
    assert.deepStrictEqual(chain(env).map((x) => [x.k, x.state, x.outcome]),
      [[sweepKey(b), "DONE", "REACTED"], [sweepKey(b + 1), "QUEUED", null]]);
    const ik = `strategy:react:${AMARR}:${R}:${pad12(b)}:s0:LAUNCH`;
    assert.deepStrictEqual(env.q("SELECT event_type AS t FROM world_event_journal WHERE idempotency_key = ?", ik),
      [{ t: EVENT_STRATEGY_INTENT }]);
    assert.deepStrictEqual(keysOf(defenseOps(env)), [`${ik}:op`]);
    const c = env.strategy.getStatus().ai.reactive.counters;
    assert.deepStrictEqual([c.sweeps, c.runs, c.reacted, c.idle, c.rowCapped, c.readFailed, c.launches],
      [1, 3, 1, 2, 0, 0, 1], JSON.stringify(c));
    env.strategy.stop("test");
  }));

  needsDriver("RXS2 restart / idempotency: a double bootstrap is a duplicate; SQLite rolls the transaction back in "
    + "the intent of the 2nd faction -> no operation at all, RETRY; the retry of the same round -> exactly one "
    + "operation per intent, one successor; the replayed effect adds nothing", () => H.withStore(driver,
    async (reopen) => {
    const clock = createManualClock(START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(67) }) };
    const holder = { threats: [THREATENED], others: { [SANSHA]: [SANSHA_PAIR[1]] } };
    const TWO = factionsEnv([AMARR, SANSHA]);
    const opened = reopen();
    const env1 = await boot(opened, shared, TWO, holder);
    assert.deepStrictEqual(env1.strategy.getStatus().ai.reactive.bootstrap, { enqueued: 1, duplicates: 0,
      reason: null });
    env1.strategy.stop("restart");
    opened.store.close("restart");
    const env = await boot(reopen(), shared, TWO, holder);
    assert.deepStrictEqual(env.strategy.getStatus().ai.reactive.bootstrap, { enqueued: 0, duplicates: 1,
      reason: null });
    patrols(env, 2, "rxs2a");
    patrols(env, 2, "rxs2s", SANSHA, SANSHA_PAIR[0]);
    const [first] = chain(env, "QUEUED");
    const b = roundOf(first);
    const second = rotation([AMARR, SANSHA], b)[1];
    env.tx((db) => db.exec(`CREATE TRIGGER rxs2_boom BEFORE INSERT ON world_operations WHEN NEW.faction_id = ${second}
      BEGIN SELECT RAISE(ROLLBACK, 'rxs2 forced'); END`));
    await passesAt(env, shared, first.due);
    const failed = chain(env).find((x) => x.k === first.k);
    assert.strictEqual(failed.state, "RETRY", JSON.stringify(failed));
    assert.deepStrictEqual([defenseOps(env, AMARR).length, defenseOps(env, SANSHA).length], [0, 0]);
    const intents = () => env.q("SELECT idempotency_key AS k FROM world_event_journal WHERE idempotency_key LIKE ? "
      + "AND event_type = ? ORDER BY idempotency_key", "strategy:react:%", EVENT_STRATEGY_INTENT);
    assert.deepStrictEqual(intents(), []);
    assert.strictEqual(chain(env, "QUEUED").length, 0, "no successor before the round commits");

    env.tx((db) => db.exec("DROP TRIGGER rxs2_boom"));
    await passesAt(env, shared, failed.due);
    assert.deepStrictEqual(chain(env).map((x) => [x.k, x.state, x.outcome]),
      [[sweepKey(b), "DONE", "REACTED"], [sweepKey(b + 1), "QUEUED", null]]);
    assert.deepStrictEqual([defenseOps(env, AMARR).length, defenseOps(env, SANSHA).length], [1, 1]);
    assert.deepStrictEqual(keysOf(intents()), [AMARR, SANSHA].map((f) =>
      `strategy:react:${f}:${R}:${pad12(b)}:s0:LAUNCH`));
    const replay = env.tx((db) => holder.lastEffect(db));
    assert.ok(replay.ok && replay.factions.every((x) => x.launches.length === 0 && x.refused.length === 0),
      JSON.stringify(replay));
    assert.deepStrictEqual([defenseOps(env, AMARR).length, defenseOps(env, SANSHA).length], [1, 1]);
    env.strategy.stop("test");
  }));

  needsDriver("RXS3 legacy chain: a QUEUED FACTION_REACTIVE_REVIEW with the old payload ends SUPERSEDED without a "
    + "successor (superseded 1); its DONE rows older than the retention go with the sweep effect, a young one stays",
  () => H.withStore(driver, async (reopen) => {
    const clock = createManualClock(START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(71) }) };
    const env = await boot(reopen(), shared, ON, { threats: [] });
    const [first] = chain(env, "QUEUED");
    const RET = env.config.strategy.reactiveDoneRetentionMs;
    const lk = (b) => `strategy:react:${AMARR}:${R}:${pad12(b)}`;
    const lp = (b) => ({ factionId: AMARR, round: b, intervalMs: R });
    seedRow(env, LEGACY, lk(1), lp(1), "DONE", START_MS - RET - 1);
    seedRow(env, LEGACY, lk(2), lp(2), "DONE", START_MS - RET - 1);
    seedRow(env, LEGACY, lk(3), lp(3), "DONE", START_MS);
    const q = env.scheduler.enqueue(LEGACY, String(AMARR), START_MS, lp(9), lk(9));
    assert.ok(q.ok, JSON.stringify(q));
    await passesAt(env, shared, first.due);
    assert.deepStrictEqual(chain(env, null, LEGACY).map((x) => [x.k, x.state, x.outcome]),
      [[lk(9), "DONE", "SUPERSEDED"], [lk(3), "DONE", "IDLE"]]);
    assert.strictEqual(chain(env).find((x) => x.k === first.k).outcome, "IDLE");
    const c = env.strategy.getStatus().ai.reactive.counters;
    assert.deepStrictEqual([c.superseded, c.sweeps, c.pruned, c.pruneRefused], [1, 1, 2, 0]);
    env.strategy.stop("test");
  }));

  needsDriver("RXS4 row cap: persistence.maxRowsPerTransaction fits one faction with an intent -> round b: "
    + "the first of the rotation launches, the second rowCapped 1 without an operation; round b + 1 starts with the "
    + "second, which launches (each faction has a 2nd threat: the first one is capped then)", () => H.withStore(driver,
    async (reopen) => {
    const clock = createManualClock(START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(73) }) };
    const holder = { threats: [THREATENED, THREATENED_2], others: { [SANSHA]: [SANSHA_PAIR[1], SANSHA_PAIR[2]] } };
    const BATCH = 64;
    const F = 6;
    const maxRows = REVIEW_ROWS.done + 1 + 3 * BATCH + reliefRows(F);
    const env = await boot(reopen(), shared, factionsEnv([AMARR, SANSHA], {
      EVEJS_LNE_STRATEGY_REACTIVE_PRUNE_BATCH: String(BATCH), EVEJS_LNE_STRATEGY_MAX_FLEETS_PER_OPERATION: String(F),
      EVEJS_LNE_PERSISTENCE_MAX_ROWS_PER_TRANSACTION: String(maxRows) }), holder);
    assert.strictEqual(env.config.persistence.maxRowsPerTransaction, maxRows);
    patrols(env, 3, "rxs4a");
    patrols(env, 3, "rxs4s", SANSHA, SANSHA_PAIR[0]);
    const [first] = chain(env, "QUEUED");
    const b = roundOf(first);
    const order = rotation([AMARR, SANSHA], b);
    await passesAt(env, shared, first.due);
    assert.deepStrictEqual(order.map((f) => defenseOps(env, f).length), [1, 0]);
    assert.strictEqual(chain(env).find((x) => x.k === first.k).outcome, "REACTED");
    assert.strictEqual(env.strategy.getStatus().ai.reactive.counters.rowCapped, 1);
    await passesAt(env, shared, first.due + R);
    assert.deepStrictEqual(rotation([AMARR, SANSHA], b + 1), [order[1], order[0]]);
    assert.deepStrictEqual(order.map((f) => defenseOps(env, f).length), [1, 1], env.lines.join("\n"));
    const c = env.strategy.getStatus().ai.reactive.counters;
    assert.deepStrictEqual([c.rowCapped, c.launches, c.sweeps], [2, 2, 2]);
    env.strategy.stop("test");
  }));

  needsDriver("RXS5 prune: DONE sweep rows older than the retention go with the narrow range; a DONE row of another R "
    + "only in the round b % W === 0; QUEUED and CLAIMED rows never", () => H.withStore(driver, async (reopen) => {
    const clock = createManualClock(START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(79) }) };
    const RET = 600000;
    const env = await boot(reopen(), shared, { ...ON, EVEJS_LNE_STRATEGY_REACTIVE_DONE_RETENTION_MS: String(RET),
      EVEJS_LNE_STRATEGY_REACTIVE_PRUNE_BATCH: "4" }, { threats: [] });
    const W = Math.ceil(RET / R);
    const [first] = chain(env, "QUEUED");
    const b0 = roundOf(first);
    const OLD = START_MS - RET - 1;
    const sp = (b, r = R) => ({ round: b, intervalMs: r });
    seedRow(env, REACTIVE, sweepKey(1), sp(1), "DONE", OLD);
    seedRow(env, REACTIVE, sweepKey(2), sp(2), "DONE", OLD);
    seedRow(env, REACTIVE, sweepKey(3), sp(3), "DONE", first.due);
    seedRow(env, REACTIVE, sweepKey(1, 120000), sp(1, 120000), "DONE", OLD);
    const open = [[sweepKey(4), "QUEUED"], [sweepKey(5), "CLAIMED"], [sweepKey(6, 120000), "QUEUED"],
      [sweepKey(7, 120000), "CLAIMED"]];
    for (const [k, state] of open) {
      const m = /^strategy:sweep:(\d+):0*(\d+)$/.exec(k);
      seedRow(env, REACTIVE, k, sp(Number(m[2]), Number(m[1])), state, null);
    }
    const has = (k) => chain(env).some((x) => x.k === k);
    const seen = [];
    for (let k = 0; k <= W; k += 1) {
      const before = has(sweepKey(1, 120000));
      await passesAt(env, shared, first.due + k * R);
      seen.push([(b0 + k) % W === 0, before, has(sweepKey(1, 120000))]);
      if (k === 0) {
        assert.deepStrictEqual([has(sweepKey(1)), has(sweepKey(2)), has(sweepKey(3))], [false, false, true]);
      }
    }
    const zero = seen.findIndex((x) => x[0]);
    assert.ok(zero > 0, `fixture: the first round must not be b % W === 0 ${JSON.stringify(seen)}`);
    assert.ok(seen.slice(0, zero).every((x) => x[1] && x[2]), JSON.stringify(seen));
    assert.deepStrictEqual(seen[zero].slice(1), [true, false], JSON.stringify(seen));
    const states = new Map(chain(env).map((x) => [x.k, x.state]));
    assert.deepStrictEqual(open.map(([k]) => states.get(k)), open.map(([, s]) => s));
    env.strategy.stop("test");
  }));

  test("RXG1 gate parity: no threat and no defended ready siege -> reactiveCanAct false and "
    + "decideReactive = idleReactive (notes only DEFENSE_OPERATIONS_TRUNCATED); 1 threat / 1 defending -> true", () => {
    const sieges = [null, { mode: "off", attacking: [], defending: [], truncated: false },
      { mode: "ready", attacking: [{ siegeId: "sg_rxg1", stationId: "st9", systemId: A_DZA8, state: "SHIELD_ASSAULT",
        phaseEndsAt: START_MS + HOUR, defenderFactionId: SANSHA, attackerStrength: 1 }], defending: [], truncated: false }];
    const fleetSets = [[], [fleet("d1", SAMINER, { fleetRole: "patrol" }), fleet("d2", THREATENED)],
      [fleet("d3", A_DZA8, { fleetRole: "patrol" })]];
    const ops = [{ operationId: "op1", version: 1, state: "PLANNED", operationType: "defense", targetSystemId: A_DZA8,
      dueAt: START_MS + HOUR }];
    let n = 0;
    for (const siege of sieges) {
      for (const fleets of fleetSets) {
        for (const truncated of [false, true]) {
          for (const room of [0, 5]) {
            for (const threats of [{ mode: "ready", truncated: false, items: [] }, { mode: "off", truncated: false,
              items: [] }]) {
              assert.strictEqual(reactiveCanAct(0, siege), false);
              const s = { ...reactiveOf(fullSnap({ fleets, threats, siege }), room), operations: truncated ? ops : [],
                operationsTruncated: truncated };
              const d = decideReactive(s, PARAMS);
              const idle = idleReactive(s.factionId, s.round);
              assert.deepStrictEqual({ ...d, notes: [] }, idle, JSON.stringify(d));
              assert.ok(d.notes.every((x) => x === "DEFENSE_OPERATIONS_TRUNCATED"), JSON.stringify(d.notes));
              n += 1;
            }
          }
        }
      }
    }
    assert.strictEqual(n, 72);
    const defended = { mode: "ready", attacking: [], defending: [{ siegeId: "sg" }], truncated: false };
    assert.deepStrictEqual([reactiveCanAct(1, null), reactiveCanAct(0, defended),
      reactiveCanAct(0, { ...defended, mode: "off" })], [true, true, false]);
  });

  async function gateRound(controllers, extra = {}) {
    const out = {};
    await H.withStore(driver, async (reopen) => {
      const clock = createManualClock(START_MS);
      const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(83) }) };
      const defending = [{ siegeId: "sg_rxg2", stationId: "st_s", systemId: SANSHA_PAIR[1], state: "SHIELD_ASSAULT",
        phaseEndsAt: START_MS + HOUR, attackerFactionId: AMARR, attackerStrength: 1 }];
      const holder = { threats: [THREATENED], controllers, reads: null, siege: { getMode: () => "ready",
        readForFactions: (db, ids) => ({ ok: true, truncated: false,
          byFaction: new Map(ids.map((f) => [f, { attacking: [], defending: f === SANSHA ? defending : [] }])) }) } };
      const env = await boot(reopen(), shared, factionsEnv([AMARR, SANSHA, SERPENTIS], extra), holder);
      patrols(env, 2, "rxg");
      env.tx((db) => db.exec(`CREATE TEMP TABLE rxg_f AS SELECT * FROM world_factions WHERE faction_id = ${AMARR};
        UPDATE rxg_f SET faction_id = 999001; INSERT INTO world_factions SELECT * FROM rxg_f; DROP TABLE rxg_f;`));
      const [first] = chain(env, "QUEUED");
      holder.reads = [];
      await passesAt(env, shared, first.due);
      const b = roundOf(first);
      const st = env.strategy.getStatus().ai.reactive;
      Object.assign(out, { b, reads: holder.reads, counters: st.counters, lastRefusal: st.lastRefusal,
        chain: chain(env).map((x) => [x.k, x.state, x.outcome]), ops: keysOf(defenseOps(env)) });
      env.strategy.stop("test");
    });
    return out;
  }

  needsDriver("RXG2 sweep gate: fleets / operations / window read only for the threatened "
    + "and the defending faction (runs 3, fullReads 2), Amarr launches as in RXS1; a row outside the registry changes "
    + "neither skipped nor lastRefusal; the fallback (no listThreatenedControllers) = the one-query path", async () => {
    const runs = [];
    for (const controllers of [false, true]) runs.push(await gateRound(controllers));
    const [fallback, gated] = runs;
    for (const r of runs) {
      const readers = (name) => [...new Set(r.reads.filter((x) => x[0] === name).map((x) => x[1]))].sort();
      for (const name of ["fleets", "operations", "window"]) {
        assert.deepStrictEqual(readers(name), [AMARR, SANSHA].sort(), `${name} ${JSON.stringify(r.reads)}`);
      }
      const c = r.counters;
      assert.deepStrictEqual([c.sweeps, c.runs, c.fullReads, c.reacted, c.idle, c.skipped, c.readFailed, c.launches],
        [1, 3, 2, 1, 2, 0, 0, 1], JSON.stringify(c));
      assert.strictEqual(r.lastRefusal, null);
      const ik = `strategy:react:${AMARR}:${R}:${pad12(r.b)}:s0:LAUNCH`;
      assert.deepStrictEqual(r.ops, [`${ik}:op`]);
      assert.deepStrictEqual(r.chain, [[sweepKey(r.b), "DONE", "REACTED"], [sweepKey(r.b + 1), "QUEUED", null]]);
    }
    assert.deepStrictEqual([fallback.counters, fallback.ops, fallback.chain], [gated.counters, gated.ops, gated.chain]);
  });

  needsDriver("RXG3 gate refusal / truncation: {ok:false} -> every faction readFailed, lastRefusal "
    + "READ:THREATS:, DONE with a successor; truncated:true -> every faction read in full (fullReads 3)", async () => {
    const fail = await gateRound("fail");
    assert.deepStrictEqual([fail.counters.readFailed, fail.counters.runs, fail.counters.fullReads], [3, 0, 0]);
    assert.ok(String(fail.lastRefusal).startsWith("READ:THREATS:"), fail.lastRefusal);
    assert.deepStrictEqual(fail.chain, [[sweepKey(fail.b), "DONE", "IDLE"], [sweepKey(fail.b + 1), "QUEUED", null]]);
    assert.deepStrictEqual(fail.reads, []);
    const all = await gateRound("truncated");
    assert.deepStrictEqual([all.counters.runs, all.counters.fullReads, all.counters.launches], [3, 3, 1]);
    assert.deepStrictEqual([...new Set(all.reads.filter((x) => x[0] === "fleets").map((x) => x[1]))].sort(),
      [AMARR, SANSHA, SERPENTIS].sort());
  });

  needsDriver("XP5 listOperations({state, operationTypes}): 10 mining operations before one "
    + "invasion and one raid -> a page of 2 holds both (type filter in SQL), keyset; refusals with factionId / states "
    + "/ without state / empty list, unknown type", () => H.withStore(driver, async (reopen) => {
    const clock = createManualClock(START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(97) }) };
    const env = await boot(reopen(), shared, {}, { threats: [] });
    patrols(env, 12, "xp5");
    const fleetRows = env.q("SELECT fleet_id AS id, version FROM virtual_fleets WHERE faction_id = ? ORDER BY fleet_id",
      AMARR);
    const specs = [...Array.from({ length: 10 }, (_, i) => [`xp5_a${String(i).padStart(2, "0")}`, "mining", "mine"]),
      ["xp5_b00", "invasion", "capture"], ["xp5_c00", "raid", "raid"]];
    specs.forEach(([operationId, operationType, objective], i) => {
      const r = env.tx((db) => env.fleets.repository.createOperation(db, { operationId, operationType, objective,
        factionId: AMARR, originSystemId: SAMINER, targetSystemId: THREATENED, dueAt: START_MS + HOUR,
        fleets: [{ fleetId: fleetRows[i].id, expectedVersion: fleetRows[i].version }] }, `xp5:op:${i}`));
      assert.ok(r.ok, JSON.stringify(r));
    });
    const list = (opts) => env.tx((db) => env.fleets.repository.listOperations(db, opts));
    const ids = (r) => [r.ok, r.ok ? r.operations.map((o) => o.operationId) : r.reason, r.ok
      ? r.nextAfterOperationId : r.detail || r.operationType];
    const types = ["invasion", "raid"];
    assert.deepStrictEqual({
      plain: ids(list({ state: "PLANNED", limit: 2 })),
      page2: ids(list({ state: "PLANNED", operationTypes: types, limit: 2 })),
      page1: ids(list({ state: "PLANNED", operationTypes: types, limit: 1 })),
      after: ids(list({ state: "PLANNED", operationTypes: types, limit: 1, afterOperationId: "xp5_b00" })),
      active: ids(list({ state: "ACTIVE", operationTypes: types, limit: 2 })),
      withFaction: ids(list({ state: "PLANNED", operationTypes: types, factionId: AMARR, limit: 2 })),
      withStates: ids(list({ states: ["PLANNED"], operationTypes: types, factionId: AMARR, limit: 2 })),
      noState: ids(list({ operationTypes: types, limit: 2 })),
      empty: ids(list({ state: "PLANNED", operationTypes: [], limit: 2 })),
      unknown: ids(list({ state: "PLANNED", operationTypes: ["invasion", "nope"], limit: 2 })),
    }, {
      plain: [true, ["xp5_a00", "xp5_a01"], "xp5_a01"],
      page2: [true, ["xp5_b00", "xp5_c00"], "xp5_c00"],
      page1: [true, ["xp5_b00"], "xp5_b00"],
      after: [true, ["xp5_c00"], "xp5_c00"],
      active: [true, [], null],
      withFaction: [false, "FLEET_INVALID_INPUT", "opts.operationTypes"],
      withStates: [false, "FLEET_INVALID_INPUT", "opts.operationTypes"],
      noState: [false, "FLEET_INVALID_INPUT", "opts.operationTypes"],
      empty: [false, "FLEET_INVALID_INPUT", "opts.operationTypes"],
      unknown: [false, "UNKNOWN_OPERATION_TYPE", "nope"],
    });
    env.strategy.stop("test");
  }));

  needsDriver("XP2 gate and parity: reactiveCanAct(0, null, 1) true / (0, null, 0) false "
    + "params.intercept null -> decideReactive with snapshot.incoming = the RX1 decision; the sweep with the flag off "
    + "(and with the flag on but no blockade facade on, P5) never reads operationTypes, fullReads unchanged",
  async () => {
    assert.deepStrictEqual([reactiveCanAct(0, null, 1), reactiveCanAct(0, null, 0), reactiveCanAct(0, null)],
      [true, false, false]);
    const threats = { mode: "ready", truncated: false, items: [{ systemId: A_DZA8, state: "INVASION",
      occupier: SANSHA, occupierStrength: 1000, phaseDueAt: START_MS + HOUR }] };
    const s = reactiveOf(fullSnap({ fleets: [fleet("f1", SAMINER), fleet("f2", SAMINER)], threats }), 4);
    const incoming = [{ operationId: "op_x", factionId: SANSHA, operationType: "invasion", targetSystemId: SAMINER,
      fleets: [{ fleetId: "e1", legSeq: 1, strength: 1, own: [false, true, true, true],
        leg: { systems: [THEATRE[0], A_DZA8, THREATENED, SAMINER], departAt: START_MS - 90000, jumpMs: 60000 } }] }];
    const golden = decideReactive(s, PARAMS);
    assert.strictEqual(golden.outcome, "REACTED");
    assert.deepStrictEqual(decideReactive({ ...s, incoming, fleets: s.fleets.map((x) => ({ ...x, jumpMs: 40000 })) },
      { ...PARAMS, intercept: null }), golden);
    const off = await gateRound(true);
    const gated = await gateRound(true, { EVEJS_LNE_STRATEGY_INTERCEPT_ENABLED: "1" });
    for (const r of [off, gated]) {
      assert.deepStrictEqual(r.reads.filter((x) => x[0] === "incoming"), [], JSON.stringify(r.reads));
      assert.deepStrictEqual([r.counters.fullReads, r.counters.launches, r.counters.intercepts], [2, 1, 0]);
    }
  });

  function routeOfLength(min) {
    const ids = graph.getSystemIds();
    for (const a of ids) {
      for (const b of ids) {
        const r = graph.findRoute(a, b);
        if (r.ok && r.route.length >= min && r.route.length <= min + 2) return [...r.route];
      }
    }
    throw new Error(`no route of ${min} systems`);
  }

  async function interceptScene(reopen, rng, holderExtra, envExtra) {
    const route = routeOfLength(12);
    const clock = createManualClock(START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(rng) }) };
    const ctrl = route.map((id, i) => [id, i === 0 ? SANSHA : AMARR]);
    const holder = { threats: [], controllers: true, ctrl, ...holderExtra };
    const env = await boot(reopen(), shared, { ...ON, EVEJS_LNE_STRATEGY_BLOCKADE_ENABLED: "1",
      EVEJS_LNE_PERSISTENCE_MAX_ROWS_PER_TRANSACTION: "1100", EVEJS_LNE_STRATEGY_INTERCEPT_ENABLED: "1",
      EVEJS_LNE_STRATEGY_INTERCEPT_MAX_JUMPS: "0", EVEJS_LNE_STRATEGY_DEFENSIVE_FLEET_SHARE_PERMILLE: "1000",
      ...envExtra }, holder);
    const made = env.fleets.createFleet({ factionId: SANSHA, currentSystemId: route[0], homeSystemId: route[0],
      fleetRole: "invasion", composition: [{ hullGroup: "cruiser", count: 2 }] }, "xp3:enemy");
    assert.ok(made.ok, JSON.stringify(made));
    const enemy = made.fleetId;
    const op = env.fleets.createOperation({ operationType: "invasion", factionId: SANSHA, originSystemId: route[0],
      targetSystemId: route[route.length - 1], objective: "capture", dueAt: START_MS + 10 * HOUR,
      fleets: [{ fleetId: enemy, expectedVersion: 1 }] }, "xp3:enemy:op");
    assert.ok(op.ok, JSON.stringify(op));
    const plan = env.fleets.planTravel({ fleetId: enemy, targetSystemId: route[route.length - 1] }, "xp3:enemy:go");
    assert.ok(plan.ok, JSON.stringify(plan));
    const leg = env.tx((db) => env.fleets.repository.getFleet(db, enemy)).fleet;
    assert.deepStrictEqual([leg.state, leg.route.systems], ["TRAVELLING", route], "the leg is the fixture route");
    const J = plan.jumpMs;
    const [first] = chain(env, "QUEUED");
    let k = 0;
    while (first.due + k * R - plan.departAt < J) k += 1;
    const dueK = first.due + k * R;
    const lead = env.config.strategy.interceptMinLeadMs;
    const m = route.findIndex((id, i) => i >= 2 && i <= route.length - 2 && plan.departAt + i * J >= dueK + lead);
    assert.ok(m > 0, `no system with lead (J ${J})`);
    const own = env.fleets.createFleet({ factionId: AMARR, currentSystemId: route[m], homeSystemId: route[m],
      fleetRole: "patrol", composition: [{ hullGroup: "cruiser", count: holder.ownCount || 8 }] }, "xp3:own");
    assert.ok(own.ok, JSON.stringify(own));
    for (let i = 0; i < k; i += 1) await passesAt(env, shared, first.due + i * R);
    return { env, shared, route, enemy, plan, J, m, dueK, b: roundOf(first) + k, own: own.fleetId,
      enemyOp: op.operationId };
  }

  const blockadeOps = (env) => env.q("SELECT operation_id AS id, idempotency_key AS k, target_system_id AS t, state "
    + "FROM world_operations WHERE faction_id = ? AND operation_type = 'blockade'", AMARR);

  needsDriver("XP3 sweep on a real store + the REAL blockade facade: a hostile ACTIVE invasion "
    + "in flight through own space to an own target -> LAUNCH intercept_post (operation blockade ACTIVE, the fleet "
    + "STAGED in place), one BLOCKADE_INTERCEPT blockade:<op>:x:<fleet>:<legSeq> due at the crossing; intercepts 1, "
    + "reliefs 0; a second sweep of the round -> roundRepeated, the next round -> no second operation; a blockade "
    + "refusing the scan -> the intent refused, no operation, interceptScanRefused 1", async () => {
    await H.withStore(driver, async (reopen) => {
      const sc = await interceptScene(reopen, 101, { blockade: "real" });
      const { env, shared } = sc;
      const op = env.q("SELECT state FROM world_operations WHERE operation_id = ?", sc.enemyOp)[0];
      assert.strictEqual(op.state, "ACTIVE", "the hostile operation is ACTIVE in flight");
      const twin = env.scheduler.enqueue(REACTIVE, "reactive", sc.dueK, { round: sc.b, intervalMs: R },
        `${sweepKey(sc.b)}:xp3`);
      assert.ok(twin.ok && !twin.duplicate, JSON.stringify(twin));
      await passesAt(env, shared, sc.dueK);
      const ik = `strategy:react:${AMARR}:${R}:${pad12(sc.b)}:s0:LAUNCH`;
      const ops = blockadeOps(env);
      assert.deepStrictEqual(ops.map((o) => [o.k, o.t, o.state]), [[`${ik}:op`, sc.route[sc.m], "ACTIVE"]],
        env.lines.join("\n"));
      const mine = env.tx((db) => env.fleets.repository.getFleet(db, sc.own)).fleet;
      assert.deepStrictEqual([mine.state, mine.currentSystemId, mine.operationId], ["STAGED", sc.route[sc.m],
        ops[0].id]);
      const x = env.q("SELECT idempotency_key AS k, due_at AS due FROM world_scheduled_events "
        + "WHERE event_type = 'BLOCKADE_INTERCEPT'");
      assert.deepStrictEqual(x.map((r) => [r.k, r.due]), [[`blockade:${ops[0].id}:x:${sc.enemy}:${sc.plan.legSeq}`,
        sc.plan.departAt + sc.m * sc.J]]);
      let c = env.strategy.getStatus().ai.reactive.counters;
      assert.deepStrictEqual([c.intercepts, c.reliefs, c.defenses, c.launches, c.roundRepeated, c.intentRefused],
        [1, 0, 0, 1, 1, 0], JSON.stringify(c));
      assert.ok(env.lines.some((l) => l.includes(`launch intercept_post -> ${sc.route[sc.m]} fleets=1`)),
        env.lines.join("\n"));
      await passesAt(env, shared, sc.dueK + R);
      assert.strictEqual(blockadeOps(env).length, 1, "covered: no second intercept");
      c = env.strategy.getStatus().ai.reactive.counters;
      assert.strictEqual(c.intercepts, 1);
      assert.strictEqual(env.blockade.getStatus().counters.crossingsQueued, 1);
      env.blockade.stop();
      env.strategy.stop("test");
    });
    await H.withStore(driver, async (reopen) => {
      const refusing = { ...createUnavailableBlockade("XP3"), getMode: () => "on" };
      const sc = await interceptScene(reopen, 103, { blockade: refusing });
      const { env, shared } = sc;
      await passesAt(env, shared, sc.dueK);
      assert.deepStrictEqual(blockadeOps(env), [], env.lines.join("\n"));
      const ik = `strategy:react:${AMARR}:${R}:${pad12(sc.b)}:s0:LAUNCH`;
      assert.strictEqual(env.tx((db) => env.journal.findByKey(db, ik)).found, false, "the intent rolled back");
      const mine = env.tx((db) => env.fleets.repository.getFleet(db, sc.own)).fleet;
      assert.deepStrictEqual([mine.state, mine.operationId], ["IDLE", null]);
      const c = env.strategy.getStatus().ai.reactive.counters;
      assert.deepStrictEqual([c.interceptScanRefused, c.intentRefused, c.launches, c.intercepts], [1, 1, 0, 0],
        JSON.stringify(c));
      env.strategy.stop("test");
    });
  });

  needsDriver("XP6: the scan queued a crossing, then the stage refused "
    + "-> the intent rolled back, no BLOCKADE_INTERCEPT row and the blockade counters crossingsQueued / enqueueRefused "
    + "stay 0; a fleet too weak for the same hostile operation in 3 sweeps -> interceptNoFleet 1",
  async () => {
    await H.withStore(driver, async (reopen) => {
      const sc = await interceptScene(reopen, 105, { blockade: "real", refuseStage: true });
      const { env, shared } = sc;
      await passesAt(env, shared, sc.dueK);
      assert.deepStrictEqual(blockadeOps(env), [], env.lines.join("\n"));
      assert.deepStrictEqual(env.q("SELECT idempotency_key FROM world_scheduled_events "
        + "WHERE event_type = 'BLOCKADE_INTERCEPT'"), []);
      const c = env.strategy.getStatus().ai.reactive.counters;
      assert.deepStrictEqual([c.intentRefused, c.launches, c.intercepts], [1, 0, 0], JSON.stringify(c));
      const bc = env.blockade.getStatus().counters;
      assert.deepStrictEqual([bc.crossingsQueued, bc.enqueueRefused, bc.activationScanTruncated], [0, 0, 0],
        JSON.stringify(bc));
      env.blockade.stop();
      env.strategy.stop("test");
    });
    await H.withStore(driver, async (reopen) => {
      const sc = await interceptScene(reopen, 107, { blockade: "real", ownCount: 1 });
      const { env, shared } = sc;
      for (let i = 0; i < 3; i += 1) await passesAt(env, shared, sc.dueK + i * R);
      assert.deepStrictEqual(blockadeOps(env), [], env.lines.join("\n"));
      const c = env.strategy.getStatus().ai.reactive.counters;
      assert.ok(c.fullReads >= 3, JSON.stringify(c));
      assert.deepStrictEqual([c.interceptNoFleet, c.interceptCapped, c.intercepts], [1, 0, 0], JSON.stringify(c));
      env.blockade.stop();
      env.strategy.stop("test");
    });
  });

  needsDriver("XP7: strategy.reactivePruneBatch 0 -> a sweep without "
    + "intents has no effect and no summary, the intercept notes still count (interceptNoFleet 1 over 3 sweeps); "
    + "A repeated sweep of the round (roundRepeated) between them keeps the note memory (interceptNoFleet "
    + "stays 1, not 2)", async () => {
    await H.withStore(driver, async (reopen) => {
      const sc = await interceptScene(reopen, 109, { blockade: "real", ownCount: 1 },
        { EVEJS_LNE_STRATEGY_REACTIVE_PRUNE_BATCH: "0" });
      const { env, shared } = sc;
      assert.strictEqual(env.config.strategy.reactivePruneBatch, 0);
      for (let i = 0; i < 3; i += 1) await passesAt(env, shared, sc.dueK + i * R);
      assert.deepStrictEqual(blockadeOps(env), [], env.lines.join("\n"));
      const c = env.strategy.getStatus().ai.reactive.counters;
      assert.ok(c.fullReads >= 3, JSON.stringify(c));
      assert.deepStrictEqual([c.interceptNoFleet, c.interceptCapped, c.intercepts], [1, 0, 0], JSON.stringify(c));
      env.blockade.stop();
      env.strategy.stop("test");
    });
    await H.withStore(driver, async (reopen) => {
      const sc = await interceptScene(reopen, 111, { blockade: "real", ownCount: 1 });
      const { env, shared } = sc;
      await passesAt(env, shared, sc.dueK);
      let c = env.strategy.getStatus().ai.reactive.counters;
      assert.deepStrictEqual([c.interceptNoFleet, c.roundRepeated], [1, 0], JSON.stringify(c));
      const acted = env.tx((db) => env.journal.applyOnce(db, {
        key: `strategy:react:${AMARR}:${R}:${pad12(sc.b)}:xp7`, aggregate: { type: "world_faction", id: String(AMARR) },
        eventType: "STRATEGY_INTENT", payload: { xp7: true } }, () => ({ ok: true })));
      assert.ok(acted.ok && !acted.duplicate, JSON.stringify(acted));
      const twin = env.scheduler.enqueue(REACTIVE, "reactive", sc.dueK, { round: sc.b, intervalMs: R },
        `${sweepKey(sc.b)}:xp7`);
      assert.ok(twin.ok && !twin.duplicate, JSON.stringify(twin));
      await passesAt(env, shared, sc.dueK);
      await passesAt(env, shared, sc.dueK + R);
      c = env.strategy.getStatus().ai.reactive.counters;
      assert.strictEqual(c.roundRepeated, 1, JSON.stringify(c));
      assert.deepStrictEqual([c.interceptNoFleet, c.interceptCapped, c.intercepts], [1, 0, 0], JSON.stringify(c));
      env.blockade.stop();
      env.strategy.stop("test");
    });
  });

  needsDriver("XP4 row bounds: reactiveRowBound at the defaults 85 / 109 / 156 (off "
    + "blockade, blockade + intercept) = reactiveRowBound; rowCapped counts reactiveIntentRowsOf (a limit fitting two "
    + "reliefRows but one interceptRows -> the second faction rowCapped); resolveConfig warnings of the intercept",
  () => H.withStore(driver, async (reopen) => {
    const { rowBoundsOfConfig } = require("../../lib/strategy/reviewBound");
    const cfg = (env) => resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } });
    const BK = { EVEJS_LNE_STRATEGY_BLOCKADE_ENABLED: "1" };
    const IC = { ...BK, EVEJS_LNE_STRATEGY_INTERCEPT_ENABLED: "1" };
    assert.deepStrictEqual([{}, BK, IC].map((e) => rowBoundsOfConfig(cfg(e).config).reactive), [85, 109, 156]);
    assert.strictEqual(R_ROWS.reactiveIntentRowsOf(cfg({}).config.strategy),
      R_ROWS.reliefRows(cfg({}).config.strategy.maxFleetsPerOperation), "flag off: the per-intent rows as before");
    assert.deepStrictEqual([R_ROWS.interceptRows(2, 6), R_ROWS.interceptRows(2, 1), R_ROWS.reliefRows(1, 2)],
      [18, 13, 12]);
    const warn = (e) => cfg(e).warnings.filter((w) => w.startsWith("strategy.interceptEnabled"))
      .map((w) => w.split(" - ")[0]);
    assert.deepStrictEqual([warn(IC), warn({ EVEJS_LNE_STRATEGY_INTERCEPT_ENABLED: "1" }),
      warn({ ...IC, EVEJS_LNE_STRATEGY_REACTIVE_ENABLED: "0" })], [[],
      ["strategy.interceptEnabled with strategy.blockadeEnabled=false"],
      ["strategy.interceptEnabled with strategy.reactiveEnabled=false"]]);

    const clock = createManualClock(START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(107) }) };
    const holder = { threats: [THREATENED], others: { [SANSHA]: [SANSHA_PAIR[1]] } };
    const BATCH = 64;
    const maxRows = REVIEW_ROWS.done + 1 + 3 * BATCH + 2 * R_ROWS.reliefRows(1, 2);
    const env = await boot(reopen(), shared, factionsEnv([AMARR, SANSHA], { ...IC,
      EVEJS_LNE_STRATEGY_REACTIVE_PRUNE_BATCH: String(BATCH), EVEJS_LNE_STRATEGY_MAX_FLEETS_PER_OPERATION: "1",
      EVEJS_LNE_PERSISTENCE_MAX_ROWS_PER_TRANSACTION: String(maxRows) }), holder);
    assert.strictEqual(R_ROWS.reactiveIntentRowsOf(env.config.strategy), 13);
    patrols(env, 1, "xp4a");
    patrols(env, 1, "xp4s", SANSHA, SANSHA_PAIR[0]);
    const [first] = chain(env, "QUEUED");
    const order = rotation([AMARR, SANSHA], roundOf(first));
    await passesAt(env, shared, first.due);
    assert.deepStrictEqual(order.map((f) => defenseOps(env, f).length), [1, 0], env.lines.join("\n"));
    assert.strictEqual(env.strategy.getStatus().ai.reactive.counters.rowCapped, 1);
    env.strategy.stop("test");
  }));
};
