"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const { createJournal } = require("../../lib/persistence/journal");
const { startScheduler } = require("../../lib/scheduler");
const { startFleets } = require("../../lib/fleets");
const { startStations, createUnavailableStations } = require("../../lib/stations");
const { LAYER_ID } = require("../../lib/stations/stationsLayer");
const { candidatesOf } = require("../../lib/stations/stationSeed");
const { listStationEdges } = require("../../lib/stations/stateMachine");
const { createBattleRepository } = require("../../lib/battle/battleRepository");
const { createSettlement } = require("../../lib/battle/settlement");
const { refitKey, arrivalKey, refitSeekKey } = require("../../lib/fleets/travelService");
const { REGISTRY_DATA_V1, createFactionRegistry } = require("../../lib/strategy/registry");
const { HULL_GROUPS, FLEET_ROLES, OPERATION_TYPES } = require("../../lib/fleets/schema");
const { createHostility } = require("../../lib/battle/data/hostility");
const { createViewRegistry } = require("../../lib/observer/views");
const { harness: H } = require("../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const { S, FACTION_A, FACTION_B } = H;
const FACTION_C = 500001;
const SANSHA = 500019;
const AMARR = 500003;
const CONCORD = 500006;
const SERPENTIS = 500020;
const SOE = 500016;
const RECHECK_MS = 3600000;
const REFIT_MS = H.CONFIG.fleets.refitMs;
const COMP = Object.freeze([{ hullGroup: "frigate", count: 3 }]);
const STATIONS = Object.freeze({ enabled: true, startStationsPerFaction: 5, maxPerSystem: 8, maxPerSystemPerFaction: 3,
  maxPerFaction: 64, maxStations: 2000, maxStockItemsPerStation: 256, maxStockQuantity: 1000000000000,
  maxDeltasPerChange: 32, repairSearchMaxJumps: 20, repairSearchMaxSystems: 2000, repairMaxCandidates: 3,
  refitSeekRecheckMs: RECHECK_MS, refitSeekMaxRounds: 24 });
const OBSERVER = Object.freeze({ galaxyEnabled: true, galaxyStationsEnabled: true, galaxyStationsMaxSystems: 1000,
  galaxyStationsMaxLines: 6, galaxyStationsRefreshMs: 60000, stationsPanelMaxRows: 200, stationsPanelStockLines: 5 });
const REGISTRY_CTX = Object.freeze({ hullGroups: HULL_GROUPS, fleetRoles: FLEET_ROLES, operationTypes: OPERATION_TYPES,
  hostility: createHostility(), maxFactions: 64, maxCampaignSystems: 40, maxShipsPerFleet: 500,
  maxCompositionEntries: 32, maxResourceUnits: 1000000000 });
const SEED_SYSTEMS = Object.freeze([30001868, 30001901, 30001894, 30001951, 30001721, 30004518, 30001718,
  30003563, 30004299, 30004309, 30003562, 30004623, 30004619, 30001978, 30001977, 30001983]);
const SOE_NPC_IDS = Object.freeze(["npc-60012595", "npc-60012598", "npc-60012601", "npc-60013075", "npc-60014056"]);
const AMARR_NPC_IDS = Object.freeze(["npc-60006448", "npc-60006658", "npc-60006673", "npc-60007948"]);

function stationsConfig(opts = {}) {
  return { ...H.CONFIG, modules: { ...H.CONFIG.modules, strategy: { enabled: true } },
    fleets: { ...H.CONFIG.fleets, refitPolicy: opts.refitPolicy || "station" },
    stations: { ...STATIONS, ...(opts.stations || {}) },
    persistence: { ...H.CONFIG.persistence, maxRowsPerTransaction: 500 },
    observer: { ...H.CONFIG.observer, ...(opts.observer || {}) } };
}

const testRegistry = (ids) => Object.freeze({
  getFaction: (id) => (ids.includes(Number(id)) ? { factionId: Number(id), startStations: [] } : null),
  listFactions: () => [],
  listActiveFactions: () => [],
  isActive: (id) => ids.includes(Number(id)),
});

const graphService = (graph) => ({ whenReady: () => Promise.resolve({ ok: true, graph }),
  getGraph: () => ({ ok: true, graph }) });

function fakeWorld(controllers) {
  return { limits: { maxBatchReadIds: 8 }, getSystems(tx, ids) {
    return { ok: true, systems: ids.filter((id) => controllers.has(id))
      .map((id) => ({ systemId: id, controllerFactionId: controllers.get(id) })), missing: [] };
  } };
}

function txOf(store) {
  return (fn) => {
    const r = store.transaction("test", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
}

async function bootStation(opened, shared, opts = {}) {
  const config = stationsConfig(opts);
  const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
  const sr = startScheduler({ config, persistence: { ok: true, store: opened.store }, clock: shared.clock,
    ids: shared.ids, nowMs: () => 0 });
  assert.ok(sr.ok, JSON.stringify(sr));
  const holder = { stations: null };
  const fr = startFleets({ config, persistence: { ok: true, store: opened.store, journal,
    worldSeed: opened.worldSeed }, clock: shared.clock, ids: shared.ids, scheduler: sr.scheduler,
  graph: { getGraph: () => ({ ok: true, graph: shared.graph }) }, presence: null, views: createViewRegistry(),
  getStations: () => (opts.getStations ? opts.getStations() : holder.stations) });
  assert.ok(fr.ok, JSON.stringify(fr));
  const views = createViewRegistry();
  const st = startStations({ config, persistence: { ok: true, store: opened.store, journal },
    strategy: { registry: testRegistry([FACTION_A, FACTION_B, FACTION_C]) }, graph: graphService(shared.graph),
    clock: shared.clock, views });
  assert.ok(st.ok, JSON.stringify(st));
  holder.stations = st.stations;
  await st.stations.whenReady();
  const battles = createBattleRepository({ journal, fleetRepository: fr.fleets.repository, clock: shared.clock,
    ids: shared.ids, worldSeed: opened.worldSeed, limits: { maxFleetsPerSide: 8, maxCompositionEntries: 32,
      maxShipsPerFleet: 500, maxResolutionMs: 50, maxInputBytes: 65536, maxResultBytes: 65536, maxListLimit: 500,
      maxSettlementRows: 450 } });
  const settlement = createSettlement({ journal, battleRepository: battles, fleetRepository: fr.fleets.repository,
    travel: fr.fleets.travel, getGraph: () => shared.graph, worldRepository: fakeWorld(opts.controllers || new Map()),
    limits: { maxResultBytes: 65536, maxSettlementRows: 450, retreatSearchMaxJumps: 5, retreatSearchMaxSystems: 200,
      retreatMaxCandidates: 3 } });
  return { store: opened.store, scheduler: sr.scheduler, fleets: fr.fleets, battles, journal, settlement,
    stations: st.stations, views, tx: txOf(opened.store), now: () => shared.clock.now() };
}

function addStation(env, id, systemId, factionId) {
  const r = env.tx((db) => env.stations.repository.createStation(db, { stationId: id, kind: "upwell", typeId: 35832,
    structureFamily: "astrahus", systemId, ownerFactionId: factionId, ownerCorporationId: 1000162, origin: "built",
    at: env.now() }, `test:station:${id}`));
  assert.ok(r.ok, JSON.stringify(r));
  return r.record;
}

const fleetOf = (env, id) => env.tx((db) => env.fleets.repository.getFleet(db, id)).fleet;
const counters = (env) => env.fleets.getStatus().travel.counters;

function retreatBattle(env, tag, systemId, retreating, opts = {}) {
  const stayer = H.newFleet(env, `${tag}:w`, opts.retreatOnB ? FACTION_A : FACTION_B, COMP);
  const battle = opts.retreatOnB
    ? H.battleOfFleets(env, tag, [stayer], [retreating], { systemId, factionB: opts.factionB })
    : H.battleOfFleets(env, tag, [retreating], [stayer], { systemId });
  const result = H.resultFor(battle.input, opts.retreatOnB ? "A_WIN" : "B_WIN",
    { [retreating]: (e) => ({ d: 0, e: e.count }) });
  return { battle, result, stayer };
}

async function passAt(env, shared, at) {
  shared.clock.set(at);
  const p = await env.scheduler.runPass();
  assert.ok(p.ok, JSON.stringify(p));
  return p;
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("T1 stations seed: the 4 factions of (Sansha 5 / 2 in 37S-KO, Amarr + Serpentis Astrahus "
    + "CONCORD Paye), "
    + "restart adds no "
    + "journal row, limits, no rebirth, NPC mismatch", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const opened = reopen();
    const built = createFactionRegistry(REGISTRY_DATA_V1, { ...REGISTRY_CTX,
      activeFactionIds: [AMARR, CONCORD, SANSHA, SERPENTIS, SOE] });
    assert.ok(built.ok, JSON.stringify(built));
    const registry = built.registry;
    const graph = { hasSystem: (id) => SEED_SYSTEMS.includes(id), getNeighbors: () => [] };
    const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
    const tx = txOf(opened.store);
    const journalRows = () => tx((db) => db.prepare("SELECT count(*) AS n FROM world_event_journal").get().n);
    const rows = () => tx((db) => db.prepare("SELECT station_id, kind, system_id, owner_faction_id, type_id, state "
      + "FROM world_stations ORDER BY station_id").all());
    const boot = (over, adapter) => {
      const lines = [];
      const r = startStations({ config: stationsConfig({ stations: over }), persistence: { ok: true,
        store: opened.store, journal }, strategy: { registry }, graph: graphService(graph), clock: shared.clock,
      adapter, logger: { log: (l) => lines.push(l) } });
      assert.ok(r.ok, JSON.stringify(r));
      return { stations: r.stations, lines };
    };

    const first = boot({});
    assert.strictEqual(first.stations.getMode(), "pending", "starting until the graph is ready");
    await first.stations.whenReady();
    assert.strictEqual(first.stations.getMode(), "ready");
    const seeded = rows();
    assert.strictEqual(seeded.filter((r) => r.owner_faction_id === SANSHA).length, 5);
    assert.strictEqual(seeded.filter((r) => r.owner_faction_id === SANSHA && r.system_id === 30001868).length, 2);
    assert.deepStrictEqual(seeded.filter((r) => r.owner_faction_id !== SANSHA && r.owner_faction_id !== SOE)
      .map((r) => [r.station_id, r.kind, r.type_id, r.state]),
    [...AMARR_NPC_IDS.map((id) => [id, "npc", null, "ONLINE"]),
      ["npc-60012859", "npc", null, "ONLINE"],
      ["npc-60012862", "npc", null, "ONLINE"],
      [`upw-${AMARR}-30001721-1`, "upwell", 35832, "ONLINE"],
      [`upw-${CONCORD}-30001718-1`, "upwell", 35832, "ONLINE"],
      [`upw-${SERPENTIS}-30004518-1`, "upwell", 35832, "ONLINE"]]);
    assert.deepStrictEqual(seeded.filter((r) => r.owner_faction_id === SOE)
      .map((r) => [r.station_id, r.kind, r.system_id, r.state]),
    SOE_NPC_IDS.map((id, i) => [id, "npc", [30001978, 30001977, 30001983, 30001978, 30001978][i], "ONLINE"]));
    assert.deepStrictEqual(first.stations.getStatus().seed.created, 19);
    const before = journalRows();
    const second = boot({});
    await second.stations.whenReady();
    assert.strictEqual(journalRows(), before, "restart: zero new journal rows");
    const seed2 = second.stations.getStatus().seed;
    assert.deepStrictEqual([seed2.created, seed2.existing], [0, 19]);
    first.stations.stop("test");
    second.stations.stop("test");

    await H.withStore(driver, async (reopen2) => {
      const o2 = reopen2();
      const j2 = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
      const t2 = txOf(o2.store);
      const boot2 = async (over, adapter) => {
        const lines = [];
        const r = startStations({ config: stationsConfig({ stations: over }), persistence: { ok: true, store: o2.store,
          journal: j2 }, strategy: { registry }, graph: graphService(graph), clock: shared.clock, adapter,
        logger: { log: (l) => lines.push(l) } });
        assert.ok(r.ok, JSON.stringify(r));
        await r.stations.whenReady();
        r.stations.stop("test");
        return { stations: r.stations, lines };
      };
      const sansha = () => t2((db) => db.prepare("SELECT station_id FROM world_stations WHERE owner_faction_id = ? "
        + "ORDER BY station_id").all(SANSHA).map((r) => r.station_id));
      await boot2({ startStationsPerFaction: 2, maxPerSystemPerFaction: 1 });
      assert.deepStrictEqual(sansha(), ["npc-60014257", "npc-60014284"]);
      const limited = await boot2({ startStationsPerFaction: 5, maxPerSystemPerFaction: 1 });
      assert.ok(limited.lines.some((l) => l.includes("npc-60014149(SYSTEM_FACTION_STATION_LIMIT)")),
        limited.lines.join("\n"));
      assert.strictEqual(sansha().length, 4);
      const repo = limited.stations.repository;
      let rec = t2((db) => repo.getStation(db, "npc-60014284")).record;
      for (const [from, to] of [["ONLINE", "ARMOR_REINFORCE"], ["ARMOR_REINFORCE", "HULL_REINFORCE"],
        ["HULL_REINFORCE", "DESTROYED"]]) {
        const r = t2((db) => repo.transitionStation(db, { stationId: rec.stationId, expectedVersion: rec.version, from,
          to, key: `test:siege:${to}`, reason: "test", at: shared.clock.now() }));
        assert.ok(r.ok, JSON.stringify(r));
        rec = r.record;
      }
      const again = await boot2({ startStationsPerFaction: 5, maxPerSystemPerFaction: 3 });
      assert.strictEqual(again.stations.getStatus().seed.created, 3, "only the never-seeded 60014149 + 2 SoE");
      assert.strictEqual(t2((db) => repo.getStation(db, "npc-60014284")).record.state, "DESTROYED");
      await H.withStore(driver, async (reopen3) => {
        const o3 = reopen3();
        const j3 = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
        const npcStart = (id) => registry.listActiveFactions().flatMap((f) => f.startStations)
          .find((s) => s.kind === "npc" && s.stationId === id);
        const sanshaIds = new Set(registry.getFaction(SANSHA).startStations.map((s) => s.stationId));
        const adapter = { readNpcStations: (ids) => ({ ok: true, stations: new Map(ids.map((id) => [id,
          { stationId: id, systemId: id === 60014257 ? 30001894 : npcStart(id).systemId,
            corporationId: sanshaIds.has(id) ? 1000161 : npcStart(id).corporationId, typeId: 1529, name: `St ${id}`,
            position: { x: 1, y: 2, z: 3 } }])) }) };
        assert.strictEqual(registry.getFaction(SANSHA).startStations[0].corporationId, 1000162);
        const lines = [];
        const r = startStations({ config: stationsConfig({ stations: { startStationsPerFaction: 1 } }),
          persistence: { ok: true, store: o3.store, journal: j3 },
          strategy: { registry }, graph: graphService(graph), clock: shared.clock, adapter,
          logger: { log: (l) => lines.push(l) } });
        await r.stations.whenReady();
        assert.ok(lines.some((l) => l.includes("npc-60014284(NPC_STATION_CORP_MISMATCH)")), lines.join("\n"));
        const t3 = txOf(o3.store);
        assert.strictEqual(t3((db) => r.stations.repository.getStation(db, "npc-60014284")).record, null);
        const row = t3((db) => r.stations.repository.getStation(db, "npc-60014149")).record;
        assert.deepStrictEqual([row.name, row.typeId, row.position, row.ownerCorporationId],
          ["St 60014149", 1529, { x: 1, y: 2, z: 3 }, 1000161]);
        r.stations.stop("test");
        const lines2 = [];
        const r2 = startStations({ config: stationsConfig(), persistence: { ok: true, store: o3.store, journal: j3 },
          strategy: { registry }, graph: graphService(graph), clock: shared.clock, adapter,
          logger: { log: (l) => lines2.push(l) } });
        await r2.stations.whenReady();
        assert.ok(lines2.some((l) => l.includes("npc-60014257(NPC_STATION_MISMATCH)")), lines2.join("\n"));
        r2.stations.stop("test");
      });
    });
    assert.deepStrictEqual(candidatesOf(registry.getFaction(AMARR)).map((c) => c.id), [`upw-${AMARR}-30001721-1`,
      "npc-60006658", "npc-60006673", "npc-60007948", "npc-60006448"]);
    assert.deepStrictEqual(candidatesOf(registry.getFaction(SERPENTIS)).map((c) => c.id),
      [`upw-${SERPENTIS}-30004518-1`, "npc-60012859", "npc-60012862"]);
  }));

  needsDriver("T2b seed on a v13 world: Amarr Upwell only -> v14 adds 4 NPC stations (existing 1), third seed "
    + "adds nothing (same journal rows); Upwell DESTROYED before v14 -> still 4, no rebirth", async () => {
    const shared = H.sharedOf();
    const v13 = JSON.parse(JSON.stringify(REGISTRY_DATA_V1));
    const amarrAt = v13.factions.findIndex((f) => f.factionId === AMARR);
    v13.factions[amarrAt].startStations = v13.factions[amarrAt].startStations.filter((s) => s.kind === "upwell");
    const reg = (data) => {
      const built = createFactionRegistry(data, { ...REGISTRY_CTX, activeFactionIds: [AMARR] });
      assert.ok(built.ok, JSON.stringify(built));
      return built.registry;
    };
    const regV13 = reg(v13);
    const regV14 = reg(REGISTRY_DATA_V1);
    assert.strictEqual(regV13.getFaction(AMARR).startStations.length, 1, "the v13 shape");
    const corpOf = new Map(regV14.getFaction(AMARR).startStations.filter((s) => s.kind === "npc")
      .map((s) => [`npc-${s.stationId}`, s.corporationId]));
    const graph = { hasSystem: (id) => SEED_SYSTEMS.includes(id), getNeighbors: () => [] };
    const upwId = `upw-${AMARR}-30001721-1`;
    for (const destroyUpwell of [false, true]) {
      await H.withStore(driver, async (reopen) => {
        const opened = reopen();
        const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
        const tx = txOf(opened.store);
        const journalRows = () => tx((db) => db.prepare("SELECT count(*) AS n FROM world_event_journal").get().n);
        const seed = async (registry) => {
          const r = startStations({ config: stationsConfig(), persistence: { ok: true, store: opened.store, journal },
            strategy: { registry }, graph: graphService(graph), clock: shared.clock, logger: { log: () => {} } });
          assert.ok(r.ok, JSON.stringify(r));
          await r.stations.whenReady();
          r.stations.stop("test");
          return r.stations;
        };
        const first = await seed(regV13);
        assert.deepStrictEqual([first.getStatus().seed.created, first.getStatus().seed.existing], [1, 0]);
        if (destroyUpwell) {
          let rec = tx((db) => first.repository.getStation(db, upwId)).record;
          for (const [from, to] of [["ONLINE", "ARMOR_REINFORCE"], ["ARMOR_REINFORCE", "HULL_REINFORCE"],
            ["HULL_REINFORCE", "DESTROYED"]]) {
            const r = tx((db) => first.repository.transitionStation(db, { stationId: upwId,
              expectedVersion: rec.version, from, to, key: `test:t2b:${to}`, reason: "test", at: shared.clock.now() }));
            assert.ok(r.ok, JSON.stringify(r));
            rec = r.record;
          }
        }
        const second = await seed(regV14);
        assert.deepStrictEqual([second.getStatus().seed.created, second.getStatus().seed.existing], [4, 1]);
        const rows = tx((db) => db.prepare("SELECT station_id, kind, state, owner_faction_id, owner_corporation_id "
          + "FROM world_stations ORDER BY station_id").all());
        assert.deepStrictEqual(rows.map((r) => [r.station_id, r.kind, r.state, r.owner_faction_id,
          r.owner_corporation_id]).filter((r) => r[1] === "npc"),
        AMARR_NPC_IDS.map((id) => [id, "npc", "ONLINE", AMARR, corpOf.get(id)]));
        assert.strictEqual(rows.find((r) => r.station_id === upwId).state, destroyUpwell ? "DESTROYED" : "ONLINE");
        const before = journalRows();
        const third = await seed(regV14);
        assert.deepStrictEqual([third.getStatus().seed.created, third.getStatus().seed.existing], [0, 5]);
        assert.strictEqual(journalRows(), before, "third seed: zero new journal rows");
      });
    }
  });

  needsDriver("T2 station stock exactly once: deposit, duplicate, insufficient, to zero deletes, siege to DESTROYED "
    + "wipes the stock", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = await bootStation(reopen(), shared);
    assert.deepStrictEqual(listStationEdges().length, 7, "ANCHORING -> ONLINE | DESTROYED");
    const repo = env.stations.repository;
    const st = addStation(env, "s-1", S.N0, FACTION_A);
    const change = (key, deltas, extra = {}) => env.tx((db) => repo.applyStockChange(db, { stationId: "s-1", key,
      reason: "test", at: env.now(), deltas, ...extra }));
    const deposit = [{ itemKind: "mineral", itemKey: "type:34", delta: 100 }, { itemKind: "hull",
      itemKey: "group:frigate", delta: 3 }];
    const r1 = change("mining:t2:deposit", deposit, { expectedVersion: st.version });
    assert.ok(r1.ok, JSON.stringify(r1));
    assert.strictEqual(r1.record.version, st.version + 1);
    assert.deepStrictEqual(r1.items.map((i) => [i.itemKey, i.quantity]), [["group:frigate", 3], ["type:34", 100]]);
    const journalRows = () => H.n(env, "SELECT count(*) AS n FROM world_event_journal");
    const j = journalRows();
    assert.deepStrictEqual(change("mining:t2:deposit", deposit), { ok: true, duplicate: true });
    assert.strictEqual(journalRows(), j);
    const short = change("prod:t2:consume", [{ itemKind: "mineral", itemKey: "type:34", delta: -150 }]);
    assert.deepStrictEqual([short.ok, short.reason, short.have, short.need], [false, "INSUFFICIENT_STOCK", 100, 150]);
    assert.strictEqual(journalRows(), j, "refusal writes nothing");
    assert.strictEqual(change("x", [{ itemKind: "hull", itemKey: "group:no_such_hull", delta: 1 }]).reason, "INVALID_INPUT");
    assert.strictEqual(change("y", [...deposit, deposit[0]]).reason, "INVALID_INPUT", "duplicate item");
    const zero = change("prod:t2:all", [{ itemKind: "mineral", itemKey: "type:34", delta: -100 }]);
    assert.ok(zero.ok, JSON.stringify(zero));
    assert.deepStrictEqual(env.tx((db) => repo.getStock(db, "s-1")).items.map((i) => [i.itemKey, i.quantity]),
      [["group:frigate", 3]], "0 deletes the row");
    let rec = zero.record;
    let lost = null;
    for (const [from, to] of [["ONLINE", "ARMOR_REINFORCE"], ["ARMOR_REINFORCE", "HULL_REINFORCE"],
      ["HULL_REINFORCE", "DESTROYED"]]) {
      const r = env.tx((db) => repo.transitionStation(db, { stationId: "s-1", expectedVersion: rec.version, from, to,
        key: `siege:t2:${to}`, reason: "test", at: env.now() }));
      assert.ok(r.ok, JSON.stringify(r));
      rec = r.record;
      lost = r.lostStock;
    }
    assert.deepStrictEqual(lost.map((i) => [i.itemKind, i.itemKey, i.quantity]), [["hull", "group:frigate", 3]]);
    assert.strictEqual(H.n(env, "SELECT count(*) AS n FROM world_station_stock"), 0);
    assert.strictEqual(change("z", deposit).reason, "STATION_DESTROYED");
    assert.strictEqual(env.tx((db) => repo.transitionStation(db, { stationId: "s-1", expectedVersion: rec.version,
      from: "DESTROYED", to: "ONLINE", key: "k", reason: "r", at: env.now() })).reason, "TRANSITION_NOT_ALLOWED");
    env.stations.stop("test");
  }));

  needsDriver("T6 getStocks: per station exactly getStock (items, order, truncated) for the "
    + "default limit, 1 and 0; empty station and duplicate id; a method of the real repository", () => H.withStore(
    driver, async (reopen) => {
      const env = await bootStation(reopen(), H.sharedOf());
      const repo = env.stations.repository;
      assert.strictEqual(typeof repo.getStocks, "function");
      for (const [id, sys] of [["s-a", S.N0], ["s-b", S.N5], ["s-c", S.N6]]) addStation(env, id, sys, FACTION_A);
      const put = (stationId, deltas) => {
        const r = env.tx((db) => repo.applyStockChange(db, { stationId, key: `t6:${stationId}`, reason: "test",
          at: env.now(), deltas }));
        assert.ok(r.ok, JSON.stringify(r));
      };
      put("s-a", [{ itemKind: "mineral", itemKey: "type:35", delta: 7 }, { itemKind: "hull", itemKey: "group:frigate",
        delta: 2 }, { itemKind: "mineral", itemKey: "type:34", delta: 100 }]);
      put("s-b", [{ itemKind: "mineral", itemKey: "type:36", delta: 5 }]);
      const ids = ["s-c", "s-a", "s-b", "s-a"];
      for (const limit of [undefined, 1, 0]) {
        const opts = limit === undefined ? undefined : { limit };
        const got = env.tx((db) => repo.getStocks(db, ids, opts));
        assert.strictEqual(got.ok, true, JSON.stringify(got));
        assert.deepStrictEqual([...got.byStation.keys()], ["s-a", "s-b", "s-c"]);
        for (const id of ["s-a", "s-b", "s-c"]) {
          const { ok, ...one } = env.tx((db) => repo.getStock(db, id, opts));
          assert.strictEqual(ok, true);
          assert.deepStrictEqual(got.byStation.get(id), one, `${id} limit ${limit}`);
        }
      }
      const cut = env.tx((db) => repo.getStocks(db, ["s-a"], { limit: 1 })).byStation.get("s-a");
      assert.deepStrictEqual([cut.items.map((i) => i.itemKey), cut.truncated], [["group:frigate"], true]);
      assert.strictEqual(env.tx((db) => repo.getStocks(db, [""])).reason, "INVALID_INPUT");
      env.stations.stop("test");
    }));

  needsDriver("T3 repair at a station: retreat to the station before a nearer friendly system, refit in the battle "
    + "system with legSeq + 1, pending -> transient refusal", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = await bootStation(reopen(), shared, { controllers: new Map([[S.N10, FACTION_A]]) });
    addStation(env, "a-n6", S.N6, FACTION_A);
    const a = H.newFleet(env, "t3a", FACTION_A, COMP);
    const sa = retreatBattle(env, "t3a", S.N9, a);
    const r = H.settleIn(env, env.settlement, sa.battle, sa.result);
    assert.ok(r.ok, JSON.stringify(r));
    let f = fleetOf(env, a);
    assert.deepStrictEqual([f.state, f.targetSystemId, f.refitPending], ["RETREATING", S.N6, true]);
    await passAt(env, shared, f.nextActionAt);
    f = fleetOf(env, a);
    assert.deepStrictEqual([f.state, f.currentSystemId, f.refitPending], ["REFITTING", S.N6, true]);
    assert.strictEqual(counters(env).refitAtStation, 1);
    await passAt(env, shared, f.nextActionAt);
    f = fleetOf(env, a);
    assert.deepStrictEqual([f.state, f.refitPending], ["IDLE", false]);

    addStation(env, "a-n9", S.N9, FACTION_A);
    const b = H.newFleet(env, "t3b", FACTION_A, COMP);
    const legSeq = fleetOf(env, b).legSeq;
    const used = env.scheduler.enqueue("FLEET_REFIT_COMPLETE", b, env.now(), { fleetId: b, legSeq },
      refitKey(b, legSeq));
    assert.ok(used.ok, JSON.stringify(used));
    await passAt(env, shared, env.now());
    const sb = retreatBattle(env, "t3b", S.N9, b);
    const rb = H.settleIn(env, env.settlement, sb.battle, sb.result);
    assert.ok(rb.ok, JSON.stringify(rb));
    const fb = fleetOf(env, b);
    assert.deepStrictEqual([fb.state, fb.legSeq, fb.refitPending, fb.nextActionAt],
      ["REFITTING", legSeq + 1, true, env.now() + REFIT_MS]);
    assert.strictEqual(H.eventOf(env, refitKey(b, legSeq + 1)).state, "QUEUED");

    const enemy = H.newFleet(env, "t3d:e", FACTION_B, COMP);
    const bd = H.battleOfFleets(env, "t3d", [b], [enemy], { systemId: S.N9 });
    const rd = H.settleIn(env, env.settlement, bd, H.resultFor(bd.input, "A_WIN",
      { [enemy]: (e) => ({ d: e.count, e: 0 }) }));
    assert.ok(rd.ok, JSON.stringify(rd));
    let fd = fleetOf(env, b);
    assert.deepStrictEqual([fd.state, fd.legSeq, fd.refitPending], ["IDLE", legSeq + 2, true]);
    assert.deepStrictEqual(H.eventOf(env, refitSeekKey(b, legSeq + 2, 0)), { state: "QUEUED", due_at: env.now() });
    assert.strictEqual(counters(env).refitResumed, 1);
    await passAt(env, shared, env.now());
    fd = fleetOf(env, b);
    assert.deepStrictEqual([fd.state, fd.legSeq, fd.refitPending], ["REFITTING", legSeq + 3, true]);
    await passAt(env, shared, fd.nextActionAt);
    fd = fleetOf(env, b);
    assert.deepStrictEqual([fd.state, fd.refitPending], ["IDLE", false]);

    await H.withStore(driver, async (reopen2) => {
      const pending = await bootStation(reopen2(), shared, { getStations: () => ({ getMode: () => "pending",
        locator: null }) });
      const c = H.newFleet(pending, "t3c", FACTION_A, COMP);
      const sc = retreatBattle(pending, "t3c", S.N9, c);
      const journal = H.n(pending, "SELECT count(*) AS n FROM world_event_journal");
      const version = fleetOf(pending, c).version;
      const rc = H.settleIn(pending, pending.settlement, sc.battle, sc.result);
      assert.deepStrictEqual([rc.ok, rc.reason, rc.permanent], [false, "STATIONS_NOT_READY", false]);
      assert.strictEqual(H.n(pending, "SELECT count(*) AS n FROM world_event_journal"), journal);
      assert.deepStrictEqual([fleetOf(pending, c).state, fleetOf(pending, c).version], ["ENGAGED", version]);
      pending.stations.stop("test");
    });
    env.stations.stop("test");
  }));

  needsDriver("T4 no station: stranded release + seek r0, station added -> RETREATING -> REFITTING -> IDLE, fallback "
    + "arrival stranded, duplicate seek effect, seek during a battle waits, max rounds gives up",
  () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = await bootStation(reopen(), shared, { controllers: new Map([[S.N10, FACTION_A]]) });
    const x = H.newFleet(env, "t4x", FACTION_C, COMP, S.N9);
    const sx = retreatBattle(env, "t4x", S.N9, x, { retreatOnB: true, factionB: FACTION_C });
    const legX = fleetOf(env, x).legSeq;
    const rx = H.settleIn(env, env.settlement, sx.battle, sx.result);
    assert.ok(rx.ok, JSON.stringify(rx));
    assert.strictEqual(rx.fleets.find((f) => f.fleetId === x).disposition, "IDLE");
    let fx = fleetOf(env, x);
    assert.deepStrictEqual([fx.state, fx.legSeq, fx.refitPending], ["IDLE", legX + 1, true]);
    const r0 = H.eventOf(env, refitSeekKey(x, legX + 1, 0));
    assert.deepStrictEqual(r0, { state: "QUEUED", due_at: env.now() + RECHECK_MS });

    const y = H.newFleet(env, "t4y", FACTION_A, COMP);
    const sy = retreatBattle(env, "t4y", S.N9, y);
    assert.ok(H.settleIn(env, env.settlement, sy.battle, sy.result).ok);
    let fy = fleetOf(env, y);
    assert.deepStrictEqual([fy.state, fy.targetSystemId, fy.refitPending], ["RETREATING", S.N10, true]);
    const legY = fy.legSeq;
    await passAt(env, shared, fy.nextActionAt);
    fy = fleetOf(env, y);
    assert.deepStrictEqual([fy.state, fy.currentSystemId, fy.legSeq, fy.refitPending], ["IDLE", S.N10, legY + 1, true]);
    assert.strictEqual(H.eventOf(env, refitSeekKey(y, legY + 1, 0)).state, "QUEUED");
    assert.strictEqual(H.eventOf(env, arrivalKey(y, legY)).state, "DONE");

    addStation(env, "c-n5", S.N5, FACTION_C);
    await passAt(env, shared, r0.due_at);
    fx = fleetOf(env, x);
    assert.deepStrictEqual([fx.state, fx.targetSystemId], ["RETREATING", S.N5]);
    assert.strictEqual(counters(env).refitSeek, 1);
    const dup = env.tx((db) => env.fleets.travel.planInTx(db, { fleetId: x, targetSystemId: S.N5, at: r0.due_at },
      `${refitSeekKey(x, legX + 1, 0)}:go`, { mode: "retreat", allowIdle: true }));
    assert.deepStrictEqual([dup.ok, dup.duplicate], [true, true]);
    await passAt(env, shared, fx.nextActionAt);
    fx = fleetOf(env, x);
    assert.deepStrictEqual([fx.state, fx.currentSystemId], ["REFITTING", S.N5]);
    await passAt(env, shared, fx.nextActionAt);
    fx = fleetOf(env, x);
    assert.deepStrictEqual([fx.state, fx.refitPending], ["IDLE", false]);

    env.stations.stop("test");

    await H.withStore(driver, async (reopen2) => {
      const one = await bootStation(reopen2(), shared, { stations: { refitSeekMaxRounds: 1 } });
      const z = H.newFleet(one, "t4z", FACTION_C, COMP, S.N9);
      const sz = retreatBattle(one, "t4z", S.N9, z, { retreatOnB: true, factionB: FACTION_C });
      assert.ok(H.settleIn(one, one.settlement, sz.battle, sz.result).ok);
      const fz = fleetOf(one, z);
      const ev = H.eventOf(one, refitSeekKey(z, fz.legSeq, 0));
      await passAt(one, shared, ev.due_at);
      assert.strictEqual(counters(one).refitSeekGaveUp, 1);
      assert.strictEqual(H.eventOf(one, refitSeekKey(z, fz.legSeq, 1)), undefined);
      assert.deepStrictEqual([fleetOf(one, z).state, fleetOf(one, z).refitPending], ["IDLE", true]);
      const z2 = H.newFleet(one, "t4z2", FACTION_C, COMP, S.N9);
      const sz2 = retreatBattle(one, "t4z2", S.N9, z2, { retreatOnB: true, factionB: FACTION_C });
      assert.ok(H.settleIn(one, one.settlement, sz2.battle, sz2.result).ok);
      addStation(one, "c-n5-z2", S.N5, FACTION_C);
      await passAt(one, shared, H.eventOf(one, refitSeekKey(z2, fleetOf(one, z2).legSeq, 0)).due_at);
      assert.deepStrictEqual([fleetOf(one, z2).state, fleetOf(one, z2).targetSystemId], ["RETREATING", S.N5]);
      assert.strictEqual(counters(one).refitSeekGaveUp, 1);
      one.stations.stop("test");
    });

    await H.withStore(driver, async (reopen3) => {
      const w = await bootStation(reopen3(), shared);
      const v = H.newFleet(w, "t4v", FACTION_C, COMP, S.N9);
      const sv = retreatBattle(w, "t4v", S.N9, v, { retreatOnB: true, factionB: FACTION_C });
      assert.ok(H.settleIn(w, w.settlement, sv.battle, sv.result).ok);
      const fv = fleetOf(w, v);
      const ev = H.eventOf(w, refitSeekKey(v, fv.legSeq, 0));
      retreatBattle(w, "t4v2", S.N9, v, { retreatOnB: true, factionB: FACTION_C });
      assert.strictEqual(fleetOf(w, v).state, "ENGAGED");
      await passAt(w, shared, ev.due_at);
      assert.strictEqual(H.eventOf(w, refitSeekKey(v, fv.legSeq, 0)).state, "DONE");
      assert.deepStrictEqual(H.eventOf(w, refitSeekKey(v, fv.legSeq, 1)), { state: "QUEUED",
        due_at: ev.due_at + RECHECK_MS });
      w.stations.stop("test");
    });
  }));

  needsDriver("T5 layer-stations: 2/1 label, factions, reinforced style, square legend + client shape, panel; "
    + "refitPolicy anywhere -> repair in place", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = await bootStation(reopen(), shared, { observer: OBSERVER });
    const repo = env.stations.repository;
    const tx = env.tx;
    const mk = (id, systemId, factionId) => {
      const r = tx((db) => repo.createStation(db, { stationId: id, kind: "upwell", systemId, ownerFactionId: factionId,
        ownerCorporationId: 1000162, origin: "built", at: env.now() }, `t5:${id}`));
      assert.ok(r.ok || r.reason === "UNKNOWN_FACTION", JSON.stringify(r));
      return r;
    };
    mk("l-1", S.N0, FACTION_A);
    mk("l-2", S.N0, FACTION_A);
    mk("l-3", S.N0, FACTION_B);
    const r6 = mk("l-4", S.N6, FACTION_B);
    assert.deepStrictEqual(env.views.listMapLayers().map((l) => [l.id, l.kind, l.order]), [[LAYER_ID, "marks", 13]]);
    const view = env.views.getView(LAYER_ID);
    let data = view.getData();
    assert.strictEqual(data.available, true, JSON.stringify(data));
    assert.ok(data.legend.every((l) => l[3] === "square"));
    const lo = Math.min(FACTION_A, FACTION_B);
    assert.deepStrictEqual(data.items.map((i) => [i[0], i[1], i[2], i[4]]), [
      [S.N0, "station", "2/1", [[FACTION_A, 2], [FACTION_B, 1]]],
      [S.N6, "station", "1", [[FACTION_B, 1]]]]);
    assert.ok(lo > 0 && data.items[0][3].length === 3);
    const t = tx((db) => repo.transitionStation(db, { stationId: "l-4", expectedVersion: r6.record.version,
      from: "ONLINE", to: "ARMOR_REINFORCE", key: "t5:siege", reason: "test", at: env.now() }));
    assert.ok(t.ok, JSON.stringify(t));
    data = view.getData();
    assert.strictEqual(data.items.find((i) => i[0] === S.N6)[1], "station-reinforced");
    const anch = tx((db) => repo.createStation(db, { stationId: "l-5", kind: "upwell", systemId: S.N9,
      ownerFactionId: FACTION_A, ownerCorporationId: 1000162, origin: "built", at: env.now(),
      initialState: "ANCHORING", stateUntilAt: env.now() + 1 }, "t5:l-5"));
    assert.ok(anch.ok, JSON.stringify(anch));
    data = view.getData();
    assert.deepStrictEqual([data.items.find((i) => i[0] === S.N9)[1],
      data.legend.find((l) => l[0] === "station-anchoring")[5]], ["station-anchoring", "dashed"]);
    const panel = env.views.getView("stations").getData();
    assert.deepStrictEqual([panel.available, panel.stations.length], [true, 5]);

    const sandbox = { window: {} };
    vm.runInNewContext(fs.readFileSync(path.join(MOD_DIR, "web", "galaxy.js"), "utf8"), sandbox,
      { filename: "galaxy.js" });
    assert.strictEqual(sandbox.window.LneGalaxy._pure.markShape("square"), "square");
    env.stations.stop("test");
    assert.strictEqual(env.views.getView(LAYER_ID), null, "stop unregisters the layer");
    assert.strictEqual(createUnavailableStations("X").getMode(), "off");

    await H.withStore(driver, async (reopen2) => {
      const legacy = await bootStation(reopen2(), shared, { refitPolicy: "anywhere" });
      const x = H.newFleet(legacy, "t5x", FACTION_C, COMP, S.N9);
      const sx = retreatBattle(legacy, "t5x", S.N9, x, { retreatOnB: true, factionB: FACTION_C });
      const legSeq = fleetOf(legacy, x).legSeq;
      const r = H.settleIn(legacy, legacy.settlement, sx.battle, sx.result);
      assert.ok(r.ok, JSON.stringify(r));
      const f = fleetOf(legacy, x);
      assert.deepStrictEqual([f.state, f.legSeq, f.refitPending], ["REFITTING", legSeq + 1, false]);
      assert.strictEqual(counters(legacy).refitLegacy, 1);
      legacy.stations.stop("test");
    });
  }));
};
