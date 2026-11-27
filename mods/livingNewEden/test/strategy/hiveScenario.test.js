"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { decideReview, decideReactive } = require("../../lib/strategy/ai");
const { planHiveBrood, hiveFleetTarget } = require("../../lib/strategy/ai/hive");
const { buildPowerTable, strengthOf } = require("../../lib/strategy/ai/strength");
const { createOperationKinds } = require("../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../lib/strategy/data/operationKinds");
const { DOCTRINES_V1 } = require("../../lib/strategy/data/doctrines");
const { FACTIONS_V1 } = require("../../lib/strategy/data/factions");
const { TARGET_SCORING_V1 } = require("../../lib/strategy/data/targetScoring");
const { FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../lib/fleets/schema");
const { GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { createHostility } = require("../../lib/battle/data/hostility");
const S = require("../../lib/world/occupation/schema");
const M = require("../../lib/world/occupation/machine");
const { createHive } = require("../../lib/strategy/hive");
const { EVENT_TYPE: REVIEW_EVENT } = require("../../lib/strategy/reviewService");
const ns = require("../../lib/adapter/npcSpawn");
const liveProfiles = require("../../lib/adapter/data/liveProfiles");
const { NAVY_PROFILES_BY_FACTION_ID } = require("../../lib/adapter/empireNavyCatalog");
const { createJournal } = require("../../lib/persistence/journal");
const { createWorldStateRepository } = require("../../lib/world/worldStateRepository");
const { createViewRegistry } = require("../../lib/observer/views");
const { buildFactionOverviewView } = require("../../lib/observer/views/factionOverview");
const { buildUniverseGraph } = require("../../lib/graph/universeGraph");
const { createRouteFinder } = require("../../lib/graph/routes");
const { k3StaticMap, system } = require("./fixtures/k3Cluster.fixture");
const { resolveConfig } = require("../../config");
const { createManualClock } = require("../../lib/util/clock");
const { createRng } = require("../../lib/util/rng");
const { createIdGenerator } = require("../../lib/util/ids");
const { harness: H } = require("../battle/settlement.test");
const { harness: R } = require("./review.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const REPO_ROOT = path.resolve(MOD_DIR, "..", "..");
const AT = 1760000000000;
const HOUR = 3600000;
const STEP = 900000;
const HIVE = 500025;
const AMARR = 500003;
const SANSHA = 500019;
const isHostile = createHostility();

const kinds = (() => {
  const k = createOperationKinds({ version: OPERATION_KINDS_VERSION, kinds: OPERATION_KINDS_V1 },
    { operationTypes: OPERATION_TYPES, objectives: OBJECTIVES, fleetRoles: FLEET_ROLES });
  assert.ok(k.ok, JSON.stringify(k));
  return k.kinds;
})();
const POWER = buildPowerTable(GROUPS);
const BIG = [{ hullGroup: "cruiser", typeId: null, count: 4 }];
const C = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: "x" } }).config;
const OCC = Object.freeze({ ...C.occupation, maxFactionsPerSystem: C.world.maxFactionsPerSystem });
const D = DOCTRINES_V1.find((x) => x.doctrineId === "rogue-hive-v1");
const DOCTRINE = Object.freeze({ doctrineId: D.doctrineId, canOccupy: D.canOccupy, expandsBeyondTheatre: false,
  operationTypes: [...D.operationTypes], reachJumps: D.reachJumps, templates: D.templates, ownSpace: null,
  borderReachKey: null, borderTargets: false, borderCaptures: false, captureTargets: [...D.captureTargets],
  targetSecClasses: [...D.targetSecClasses], returnToBase: D.returnToBase, confinedToBelt: false,
  buildsStations: false, capturesStations: false, consolidates: D.consolidates, hullsRequired: false,
  fieldsHunters: false, hunterTemplate: [], hunterComposition: [], hoardCapped: true, raidsBeyondTheatre: true,
  hive: true });
const HIVE_SETTINGS = Object.freeze({ ...C.hive, enabled: true, nodesPerRegion: 1, fleetsPerNode: 2, maxFleets: 5 });
const HIVE_P = Object.freeze({ maxFleets: 5, fleetsPerNode: 2, maxFrontsPerAttacker: 1, assumedGarrisonFleets: 2,
  captureSlowFactor: HIVE_SETTINGS.captureSlowFactor });
const PARAMS = Object.freeze({ maxReachJumps: C.strategy.maxReachJumps, supplyChainJumps: 10,
  captureRangeFromStationJumps: 5, maxAssemblyJumps: C.strategy.maxAssemblyJumps, maxBfsSystems: 2000,
  mobilizeFallbackJumps: 0, mobilizeFallbackMaxSystems: 2000, maxTargetCandidates: 40, targetPickTopK: 1,
  maxOperationsPerReview: 3, maxFleetsPerOperation: 4, maxFleetsPerFaction: 40, maxMobilizationsPerReview: 3,
  mobilizeResourcePerShip: 10, mobilizeReservePerShip: 1, attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR,
  maxObservationsPerReview: 8, reconWindowMs: HOUR / 2, attackWindowMs: 2 * HOUR, operationGraceMs: HOUR,
  maxHousekeepingPerReview: 4, maxRefitRequestsPerReview: 2, returnAfterIdleMs: HOUR / 2, returnWindowMs: 2 * HOUR,
  maxReturnsPerReview: 3, returnFleetRoles: [...kinds.get("return").fleetRoles], kinds: kinds.list,
  scoring: TARGET_SCORING_V1, powerTable: POWER, frontLimitCap: 3, routeMaxJumps: 40,
  defense: { enabled: true, maxPerReview: 2 },
  patrol: { windowMs: HOUR, idleMs: C.strategy.patrolIdleMs, minShips: 1, garrisonMaxJumps: 4, scoutMaxJumps: 4,
    maxGarrisonsPerPost: 2, maxOpenPickets: 0, scoutReserve: 0, roleMaxJumps: C.strategy.patrolRoleMaxJumps,
    roleMaxEnemyRatio: 1, garrisonFleetsTarget: 1 },
  merge: { roles: ["patrol"], maxPerReview: 2, maxShipsPerFleet: 100 },
  hive: HIVE_P });

const REGIONS = Object.freeze({ 1: [101, 102, 103, 104], 2: [201, 202, 203, 204], 3: [301, 302, 303, 304] });
const HOME = Object.freeze([...REGIONS[1], ...REGIONS[2], ...REGIONS[3]]);
const BORDER = 202;
const NEIGHBOUR = 900;
const ADJ = (() => {
  const adj = new Map([...HOME, NEIGHBOUR].map((id) => [id, []]));
  const link = (a, b) => {
    adj.get(a).push(b);
    adj.get(b).push(a);
  };
  for (let i = 1; i < HOME.length; i += 1) link(HOME[i - 1], HOME[i]);
  link(BORDER, NEIGHBOUR);
  return adj;
})();
const GRAPH = Object.freeze({ getNeighbors: (id) => ADJ.get(id) || [],
  getSystemsInRegion: (id) => REGIONS[id] || [] });

const row = (systemId, controllerFactionId, extra = {}) => ({ systemId, controllerFactionId, occupationState: "STABLE",
  ownInfluence: 0, occupierFactionId: null, homeFactionId: HOME.includes(systemId) ? HIVE : null,
  controllerGarrison: 0, hostileStations: 0, liveStations: 0, ownLiveStations: 0, observed: false, ...extra });
const fleet = (fleetId, systemId) => ({ fleetId, version: 2, state: "IDLE", fleetRole: "patrol", systemId,
  refitPending: false, shipCount: 4, strength: strengthOf(BIG, POWER), operationId: null, legSeq: 0,
  homeSystemId: systemId, composition: BIG, updatedAt: AT - 60000 });
const intel = (systemId) => ({ systemId, observedAt: AT - HOUR, hostileFleets: 1, hostileShips: 1, hostileStrength: 1,
  hostileStations: 0, controllerFactionId: AMARR, source: "fleet" });
const OFF = Object.freeze({ mode: "off", truncated: false, items: [] });
const LOST_OFF = Object.freeze({ mode: "off", truncated: false, afterSystemId: 0, nextAfterSystemId: 0, systemIds: [] });

function snap(controllers, footholds, o = {}) {
  const systems = [...HOME, NEIGHBOUR].map((id) => row(id, controllers.get(id)));
  const controlled = HOME.filter((id) => controllers.get(id) === HIVE).length;
  return { v: 1, factionId: HIVE, round: o.round || 3, at: AT, seed: 11,
    faction: { status: "ACTIVE", homeSystemId: 101, doctrineId: DOCTRINE.doctrineId, resourceUnits: 100000,
      reserveUnits: 10000, frontLimit: 3, version: 1 },
    entry: { kind: "hive", maxActiveFronts: 3, allies: [], homeRegionIds: [1, 2, 3], ownerCorporationId: 1 },
    doctrine: DOCTRINE, hive: { homeSystems: HOME.length }, theatre: [], expansion: [], raidTargets: [],
    neighbors: GRAPH.getNeighbors, regionOf: () => null, isHostile: (x) => x === AMARR, isPlaying: () => true,
    stationsMode: "ready", stations: [], captureAnchors: [], systems,
    fleets: o.fleets || [], fleetsTruncated: false, operations: [], operationsTruncated: false,
    intel: o.intel || [], sightings: [], occupations: [], territory: [], territoryTruncated: false, footholds,
    upkeep: { mode: "ready", paidUntil: null, unpaidPeriods: 0, controlledCount: controlled, captured: [],
      capturedTruncated: false, liveShips: 0, stationCount: footholds.length, tradeReady: false, tradeReason: null },
    capturedIds: [], threats: o.threats || OFF, lostHome: o.lostHome || LOST_OFF, huntReady: false };
}

function claimView(controller, occupier) {
  return { systemId: BORDER, state: S.CONTESTED, controller, occupier, previousController: null, sinceAt: 0, seq: 1,
    evaluatedAt: null, capturedAt: null, detachedSinceAt: null, home: HIVE, coreOwner: null,
    influence: new Map([[controller, { score: 60, garrison: 0 }]]),
    presence: new Map([[occupier, { strength: 100, fleets: [] }]]), stations: new Map(),
    inRange: (f) => f === occupier, isHostile, presenceTruncated: false, deferred: false, at: 0, rangeKnown: true,
    consolidates: () => true, drawsGarrison: () => true, captureSlowFactor: 1 };
}

function drive(view, hive, stop) {
  const out = [];
  for (let at = STEP; at <= 48 * HOUR; at += STEP) {
    view.at = at;
    view.captureSlowFactor = hive.captureSlowFactorOf(view.controller, view.home);
    const ev = M.evaluate(view, { kind: M.TRIGGERS.TICK }, OCC);
    for (const e of ev.influence) view.influence.set(e.factionId, { score: e.influenceScore, garrison: e.garrisonStrength });
    view.evaluatedAt = at;
    if (!ev.to) continue;
    const p = ev.statePatch;
    Object.assign(view, { state: ev.to, sinceAt: at, controller: p.controllerFactionId, occupier: p.occupierFactionId,
      previousController: p.previousControllerFactionId, capturedAt: p.capturedAt, detachedSinceAt: p.detachedSinceAt });
    const holder = view.controller;
    view.inRange = (f) => f === holder || f === view.occupier;
    out.push({ to: ev.to, at, capturedAt: p.capturedAt, controller: p.controllerFactionId, notes: ev.notes,
      factor: view.captureSlowFactor });
    if (ev.to === stop) return out;
  }
  return out;
}

const launches = (d) => d.intents.filter((i) => i.type === "LAUNCH").map((i) => [i.kind, i.target.systemId]);
const mobs = (d) => d.intents.filter((i) => i.type === "MOBILIZE");

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("HVS1 hive scenario (pure, no server): 3 nodes / 12 home systems, pool to hive.maxFleets, neighbour INVASION "
    + "-> LAUNCH defense, no defence -> OCCUPIED ~6 h, lost node leaves footholds and the target drops, RECLAIM + "
    + "invasion, retake OCCUPIED with capturedAt null + HOME_RECLAIMED, STABLE", () => {
    const controllers = new Map([...HOME.map((id) => [id, HIVE]), [NEIGHBOUR, AMARR]]);
    const world = { limits: { maxBatchReadIds: 64 }, getSystems: (tx, ids) => ({ ok: true,
      systems: ids.map((systemId) => ({ systemId, controllerFactionId: controllers.get(systemId) || null })) }) };
    const registry = { listActiveFactions: () => [{ factionId: HIVE, doctrineId: D.doctrineId, homeRegionIds: [1, 2, 3],
      hqSystemId: 101 }], getDoctrine: () => D };
    const hive = createHive({ registry, getGraph: () => GRAPH, getWorldRepository: () => world,
      settings: HIVE_SETTINGS });
    const footholds = () => {
      const r = hive.listNodesInTx(null, HIVE);
      assert.ok(r.ok, JSON.stringify(r));
      return r.footholds;
    };
    assert.deepStrictEqual(footholds().map((x) => x.systemId), [101, BORDER, 301]);
    assert.strictEqual(hive.homeSystemCount(HIVE), HOME.length);
    assert.strictEqual(isHostile(AMARR, HIVE), true);

    let fleets = [];
    const grown = [];
    for (let round = 1; round <= 6; round += 1) {
      const d = decideReview(snap(controllers, footholds(), { round, fleets }), PARAMS);
      assert.strictEqual(d.outcome, "REVIEWED", d.reason);
      const m = mobs(d);
      grown.push(m.length);
      fleets = fleets.concat(m.map((x, i) => fleet(`r${round}-${i}`, x.systemId)));
    }
    assert.deepStrictEqual([grown, fleets.length], [[3, 2, 0, 0, 0, 0], HIVE_P.maxFleets]);
    assert.strictEqual(hiveFleetTarget(3, HOME.length, HOME.length, HIVE_P), HIVE_P.maxFleets);

    const threats = { mode: "ready", truncated: false, items: [{ systemId: BORDER, state: "INVASION", occupier: AMARR,
      occupierStrength: 1, phaseDueAt: AT + HOUR }] };
    const react = (pool) => decideReactive({ v: 1, factionId: HIVE, round: 3, at: AT, doctrine: DOCTRINE,
      fleets: pool, operations: [], operationsTruncated: false, occupations: [], threats, siege: null,
      neighbors: GRAPH.getNeighbors, reactive: { room: 4 } }, PARAMS);
    assert.deepStrictEqual(react(fleets).notes, [`DEFENSE_HELD:${BORDER}`]);
    const away = fleets.map((x) => (x.systemId === BORDER ? { ...x, state: "STAGED", operationId: "op-sortie" } : x));
    const reacted = react(away);
    assert.strictEqual(reacted.outcome, "REACTED", JSON.stringify(reacted));
    assert.deepStrictEqual(reacted.intents.map((i) => [i.type, i.kind, i.target.systemId, i.mobilize.length]),
      [["LAUNCH", "defense", BORDER, 0]]);
    assert.ok(reacted.intents[0].fleets.every((x) => away.find((y) => y.fleetId === x.fleetId).systemId !== BORDER));

    const lost = drive(claimView(HIVE, AMARR), hive, S.OCCUPIED);
    assert.deepStrictEqual(lost.map((t) => [t.to, t.at, t.factor]), [[S.INVASION, 3 * HOUR, 3],
      [S.OCCUPIED, 6 * HOUR, 3]], JSON.stringify(lost));
    assert.deepStrictEqual([lost[1].controller, lost[1].capturedAt], [AMARR, 6 * HOUR]);
    controllers.set(BORDER, AMARR);

    assert.deepStrictEqual(footholds().map((x) => x.systemId), [101, 301]);
    const target = hiveFleetTarget(2, HOME.length - 1, HOME.length, HIVE_P);
    assert.ok(target < HIVE_P.maxFleets, `target ${target}`);
    assert.deepStrictEqual(planHiveBrood({ snapshot: snap(controllers, footholds(), { fleets }), params: PARAMS,
      slots: { mobilizations: 3 }, budget: { resourceUnits: 100000, reserveUnits: 10000 }, mobilized: 0 }).intents, []);

    const d5 = decideReview(snap(controllers, footholds(), { round: 7, fleets, intel: [intel(BORDER)],
      lostHome: { mode: "ready", truncated: false, afterSystemId: 0, nextAfterSystemId: 0, systemIds: [BORDER] } }),
    PARAMS);
    assert.strictEqual(d5.outcome, "REVIEWED", d5.reason);
    assert.ok(launches(d5).some(([k, t]) => k === "invasion" && t === BORDER), JSON.stringify(launches(d5)));
    assert.ok(d5.notes.includes(`RECLAIM:${BORDER}`), JSON.stringify(d5.notes));
    const back = drive(claimView(AMARR, HIVE), hive, S.STABLE);
    assert.deepStrictEqual(back.map((t) => t.to), [S.INVASION, S.OCCUPIED, S.CONSOLIDATING, S.STABLE],
      JSON.stringify(back));
    const reclaimed = back[1];
    assert.deepStrictEqual([reclaimed.at, reclaimed.controller, reclaimed.capturedAt, reclaimed.factor,
      reclaimed.notes.includes("HOME_RECLAIMED")], [2 * HOUR, HIVE, null, 1, true]);
    assert.strictEqual(back[2].factor, HIVE_P.captureSlowFactor, "held home: facade factor > 1, machine pace normal");
    controllers.set(BORDER, HIVE);
    assert.deepStrictEqual(footholds().map((x) => x.systemId), [101, BORDER, 301]);
  });

  needsDriver("HVS2 real store: listLostHome returns the hive home after the attacker took it, not after the retake",
    async () => {
      await H.withStore(driver, async (reopen) => {
        const opened = reopen();
        const clock = createManualClock(AT);
        const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
        const repo = createWorldStateRepository({ journal, clock,
          limits: { maxFactionsPerSystem: 8, maxBatchReadIds: 64, maxListLimit: 64 } });
        const tx = (fn) => {
          const r = opened.store.transaction("hvs2", fn);
          assert.ok(r.ok, JSON.stringify(r));
          return r.value;
        };
        const sys = 30001052;
        const created = tx((db) => repo.applyChange(db, { systemId: sys, expectedVersion: 0, reason: "SEED_CONTROL",
          state: { securityClass: "nullsec", controllerFactionId: HIVE },
          influence: [{ factionId: HIVE, influenceScore: 60 }] }, "hvs2:seed"));
        assert.ok(created.ok, JSON.stringify(created));
        const lostIds = () => tx((db) => repo.listLostHome(db, HIVE, { limit: 10 })).systems.map((s) => s.systemId);
        assert.deepStrictEqual(lostIds(), []);
        const setController = (controllerFactionId, key) => {
          const expectedVersion = tx((db) => repo.getSystem(db, sys)).system.version;
          clock.advance(1000);
          const r = tx((db) => repo.applyChange(db, { systemId: sys, expectedVersion, reason: "TEST",
            state: { controllerFactionId } }, key));
          assert.ok(r.ok, JSON.stringify(r));
        };
        setController(AMARR, "hvs2:lost");
        assert.strictEqual(tx((db) => repo.getSystem(db, sys)).system.homeFactionId, HIVE, "home stays the hive");
        assert.deepStrictEqual(lostIds(), [sys]);
        setController(HIVE, "hvs2:back");
        assert.deepStrictEqual(lostIds(), []);
      });
    });

  test("HVS3 vendor facts (text, no require): rogue_drones hull key and the 8 regions = homeRegionIds; resolveProfiles "
    + "500025 for frigate / cruiser / battleship without NO_PROFILE; compose.yaml keeps the hive off", () => {
    const read = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf8").replace(/\r\n/g, "\n");
    const hulls = read("server/src/space/npc/pirateHullProfiles.js");
    const policy = read("server/src/space/npc/pirateFactionPolicy.js");
    assert.ok(/^\s*rogue_drones: "rogue_drones_deadspace_pve",$/m.test(hulls), "pirateHullProfiles rogue_drones");
    assert.ok(/^\s*500025: "rogue_drones",$/m.test(policy), "pirateFactionPolicy 500025");
    const regions = [...policy.matchAll(/^\s*(1\d{7}): "rogue_drones",$/gm)].map((m) => Number(m[1])).sort((a, b) => a - b);
    const entry = FACTIONS_V1.find((f) => f.factionId === HIVE);
    assert.strictEqual(regions.length, 8, JSON.stringify(regions));
    assert.deepStrictEqual(regions, [...entry.homeRegionIds].sort((a, b) => a - b));
    assert.strictEqual(liveProfiles.PIRATE_KEY_BY_FACTION_ID[String(HIVE)], "rogue_drones");

    const calls = [];
    const pool = new Set(["frigate", "cruiser", "battleship"]);
    const vendorHulls = { resolveFactionHullProfileID(key, hullClass, options) {
      calls.push([key, hullClass, options.seed]);
      return key === "rogue_drones" && pool.has(hullClass) ? `rogue_drones_${hullClass}` : null;
    } };
    const requireGame = (rel) => (rel === ns.MODULE_PATHS.hulls ? { ok: true, exports: vendorHulls }
      : { ok: false, reason: "file_not_found" });
    const seam = ns.createNpcSpawn({ requireGame, navyProfiles: NAVY_PROFILES_BY_FACTION_ID, data: liveProfiles });
    const groups = ["frigate", "cruiser", "battleship"];
    const r = seam.resolveProfiles(groups.map((hullGroup, i) => ({ memberKey: `h${i}`, factionId: HIVE, hullGroup })),
      { seedPrefix: "hive" });
    assert.deepStrictEqual(r, { ok: true, profiles: groups.map((g) => `rogue_drones_${liveProfiles.HULL_CLASS_BY_GROUP[g]}`) });
    assert.deepStrictEqual(calls.map((c) => c[0]), ["rogue_drones", "rogue_drones", "rogue_drones"]);
    const used = new Set(Object.values(D.templates).flat().map((e) => e.hullGroup));
    assert.ok([...used].every((g) => groups.includes(g)), JSON.stringify([...used]));

    assert.ok(/^\s*EVEJS_LNE_HIVE_ENABLED: \$\{EVEJS_LNE_HIVE_ENABLED:-0\}$/m.test(read("compose.yaml")), "compose");
  });

  const MAL = [30001051, 30001052, 30001053, 30001054, 30001055];
  const malGraph = () => {
    const map = k3StaticMap({ extra: MAL.map((id) => system(id, 10000013, 20000150, "nullsec")) });
    const link = (a, b) => map.gates.push({ fromSystemId: a, toSystemId: b }, { fromSystemId: b, toSystemId: a });
    link(30004932, MAL[0]);
    for (let i = 1; i < MAL.length; i += 1) link(MAL[i - 1], MAL[i]);
    const built = buildUniverseGraph(map);
    assert.ok(built.ok);
    return Object.freeze({ ...built.graph, ...createRouteFinder(built.graph, { cacheSize: 64, maxJumps: 40 })
      .publicApi });
  };
  const ON = { EVEJS_LNE_HIVE_ENABLED: "1", EVEJS_LNE_STRATEGY_CAMPAIGNS: "none",
    EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: `${SANSHA},${HIVE}`, EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8" };

  needsDriver("HVS4 real store, hive on: counter hiveBroodMobilized, panel activity hiveNodesActive / "
    + "hiveBroodMobilized (hive row only), factions view and faction-overview without stations, treasury, production",
  async () => {
    await H.withStore(driver, async (reopen) => {
      const clock = createManualClock(R.START_MS);
      const controllers = new Map([...R.THEATRE.map((id) => [id, SANSHA]), ...MAL.map((id) => [id, HIVE])]);
      const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(74) }), graph: malGraph(), controllers };
      const seen = new Map();
      const hooks = { beforeEffect: (d, s) => {
        if (!seen.has(d.factionId)) seen.set(d.factionId, s);
        return d;
      } };
      const views = createViewRegistry();
      const e = await R.bootAll(reopen(), shared, ON, { hooks, world: R.upkeepWorld(controllers, new Map()),
        strategyViews: views });
      await R.passesAt(e, shared, R.START_MS + R.I);
      const nodes = seen.get(HIVE).footholds.length;
      const brood = e.strategy.getStatus().ai.review.counters.hiveBroodMobilized;
      assert.ok(nodes >= 2 && brood >= 1, JSON.stringify({ nodes, brood }));
      const pool = e.q("SELECT fleet_role AS role FROM virtual_fleets WHERE faction_id = ?", HIVE);
      assert.strictEqual(brood, pool.filter((x) => x.role === "patrol").length, JSON.stringify(pool));

      const activity = views.getView("activity").getData();
      assert.strictEqual(activity.available, true, JSON.stringify(activity));
      const rowOf = (f) => activity.factions.find((x) => x.factionId === f);
      const plans = rowOf(HIVE).plans;
      assert.deepStrictEqual([plans.hiveNodesActive, plans.hiveBroodMobilized], [nodes, brood]);
      assert.ok(!("hiveNodesActive" in rowOf(SANSHA).plans), "other factions without the hive fields");
      const line = activity.summary.find((x) => x.plany.includes("hive:"));
      assert.ok(line && line.plany.includes(`hive: nodes ${nodes}, brood ${brood}`), JSON.stringify(activity.summary));

      const factions = views.getView("factions").getData();
      const hiveRow = factions.factions.find((x) => x.factionId === HIVE);
      assert.ok(hiveRow, JSON.stringify(factions.factions.map((x) => x.factionId)));
      assert.strictEqual(hiveRow.treasury, null);
      const overview = buildFactionOverviewView({ views: { getView: (id) => views.getView(id) || null },
        clock: { now: () => clock.now() }, factionNames: new Map([[HIVE, "Rogue Drones"], [SANSHA, "Sansha"]]),
        getGovernor: () => null, telemetry: null, nowMs: () => 0,
        settings: { refreshMs: 15000, maxFactions: 32, maxNotes: 12, maxJobs: 16, maxStations: 16 } });
      const card = overview.getData({ nowMs: clock.now() });
      assert.strictEqual(card.available, true, JSON.stringify(card));
      const hiveCard = card.factions.find((x) => x.factionId === HIVE);
      assert.ok(hiveCard, JSON.stringify(card.factions.map((x) => x.factionId)));
      assert.deepStrictEqual([hiveCard.kind, hiveCard.isk.treasury, hiveCard.production, hiveCard.mining,
        Boolean(hiveCard.strategy && hiveCard.strategy.plans)], ["hive", null, null, null, true], JSON.stringify(hiveCard));
      e.strategy.stop("test");
    });
  });

  needsDriver("HVS5 off after on: the queued hive review ends SKIPPED INACTIVE, the world_factions row and the "
    + "fleets stay, Sansha sees the hive as not playing", async () => {
    await H.withStore(driver, async (reopen) => {
      const clock = createManualClock(R.START_MS);
      const controllers = new Map([...R.THEATRE.map((id) => [id, SANSHA]), ...MAL.map((id) => [id, HIVE])]);
      const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(75) }), graph: malGraph(), controllers };
      const first = reopen();
      const on = await R.bootAll(first, shared, ON, { world: R.upkeepWorld(controllers, new Map()) });
      await R.passesAt(on, shared, R.START_MS + R.I);
      const fleetsOn = on.q("SELECT fleet_id FROM virtual_fleets WHERE faction_id = ? ORDER BY fleet_id", HIVE);
      assert.ok(fleetsOn.length >= 1, "the hive mobilized");
      assert.strictEqual(on.q("SELECT COUNT(*) AS n FROM world_factions WHERE faction_id = ?", HIVE)[0].n, 1);
      on.strategy.stop("restart");
      first.store.close();

      let sansha = null;
      const hooks = { beforeEffect: (d, s) => {
        if (d.factionId === SANSHA) sansha = s;
        return d;
      } };
      const off = await R.bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_CAMPAIGNS: "none",
        EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: String(SANSHA), EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8" },
      { hooks, world: R.upkeepWorld(controllers, new Map()) });
      await R.passesAt(off, shared, R.START_MS + 3 * R.I);
      const c = off.strategy.getStatus().ai.review.counters;
      assert.ok(c.inactive >= 1 && c.skipped >= 1, JSON.stringify({ inactive: c.inactive, skipped: c.skipped }));
      const queued = off.q(`SELECT COUNT(*) AS n FROM world_scheduled_events WHERE event_type = ? AND aggregate_id = ?
        AND state NOT IN ('DONE', 'QUARANTINED')`, REVIEW_EVENT, String(HIVE))[0].n;
      assert.strictEqual(queued, 0, "the hive review chain stops");
      assert.strictEqual(off.q("SELECT COUNT(*) AS n FROM world_factions WHERE faction_id = ?", HIVE)[0].n, 1);
      assert.deepStrictEqual(off.q("SELECT fleet_id FROM virtual_fleets WHERE faction_id = ? ORDER BY fleet_id", HIVE),
        fleetsOn);
      assert.ok(sansha, "Sansha reviewed");
      assert.strictEqual(sansha.isPlaying(HIVE), false);
      off.strategy.stop("test");
    });
  });
};
