"use strict";

const assert = require("node:assert");

const { createJournal } = require("../../lib/persistence/journal");
const { startScheduler } = require("../../lib/scheduler");
const { startFleets } = require("../../lib/fleets");
const { startStations } = require("../../lib/stations");
const { createRepairLocator } = require("../../lib/stations/repairLocator");
const { createFootholdRepairNodes, composeRepairNodes } = require("../../lib/stations/repairNodes");
const { createBattleRepository } = require("../../lib/battle/battleRepository");
const { createSettlement } = require("../../lib/battle/settlement");
const { refitSeekKey } = require("../../lib/fleets/travelService");
const { createViewRegistry } = require("../../lib/observer/views");
const { harness: H } = require("../battle/settlement.test");

const { S, FACTION_A, FACTION_B } = H;
const INVADER = 500001;
const HIVE = 500025;
const RECHECK_MS = 3600000;
const COMP = Object.freeze([{ hullGroup: "frigate", count: 3 }]);
const STATIONS = Object.freeze({ enabled: true, startStationsPerFaction: 5, maxPerSystem: 8, maxPerSystemPerFaction: 3,
  maxPerFaction: 64, maxStations: 2000, maxStockItemsPerStation: 256, maxStockQuantity: 1000000000000,
  maxDeltasPerChange: 32, repairSearchMaxJumps: 20, repairSearchMaxSystems: 2000, repairMaxCandidates: 3,
  refitSeekRecheckMs: RECHECK_MS, refitSeekMaxRounds: 24 });
const KINDS = Object.freeze({ [FACTION_A]: "empire", [FACTION_B]: "pirate", [INVADER]: "invader" });

const registry = Object.freeze({
  getFaction: (id) => (KINDS[Number(id)] ? { factionId: Number(id), kind: KINDS[Number(id)], startStations: [] } : null),
  listFactions: () => [],
  listActiveFactions: () => [],
  isActive: (id) => Boolean(KINDS[Number(id)]),
});

function configOf(flag) {
  return { ...H.CONFIG, modules: { ...H.CONFIG.modules, strategy: { enabled: true } },
    fleets: { ...H.CONFIG.fleets, refitPolicy: "station" }, stations: { ...STATIONS },
    invasions: { ...(H.CONFIG.invasions || {}), refitAtFootholdEnabled: flag },
    persistence: { ...H.CONFIG.persistence, maxRowsPerTransaction: 500 } };
}

const graphService = (graph) => ({ whenReady: () => Promise.resolve({ ok: true, graph }),
  getGraph: () => ({ ok: true, graph }) });

function txOf(store) {
  return (fn) => {
    const r = store.transaction("test", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
}

async function boot(opened, shared, flag, footholdsOf) {
  const config = configOf(flag);
  const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
  const sr = startScheduler({ config, persistence: { ok: true, store: opened.store }, clock: shared.clock,
    ids: shared.ids, nowMs: () => 0 });
  assert.ok(sr.ok, JSON.stringify(sr));
  const holder = { stations: null };
  const fr = startFleets({ config, persistence: { ok: true, store: opened.store, journal,
    worldSeed: opened.worldSeed }, clock: shared.clock, ids: shared.ids, scheduler: sr.scheduler,
  graph: { getGraph: () => ({ ok: true, graph: shared.graph }) }, presence: null, views: createViewRegistry(),
  getStations: () => holder.stations });
  assert.ok(fr.ok, JSON.stringify(fr));
  const st = startStations({ config, persistence: { ok: true, store: opened.store, journal },
    strategy: { registry }, graph: graphService(shared.graph), clock: shared.clock, views: createViewRegistry(),
    footholdsOf });
  assert.ok(st.ok, JSON.stringify(st));
  holder.stations = st.stations;
  await st.stations.whenReady();
  const battles = createBattleRepository({ journal, fleetRepository: fr.fleets.repository, clock: shared.clock,
    ids: shared.ids, worldSeed: opened.worldSeed, limits: { maxFleetsPerSide: 8, maxCompositionEntries: 32,
      maxShipsPerFleet: 500, maxResolutionMs: 50, maxInputBytes: 65536, maxResultBytes: 65536, maxListLimit: 500,
      maxSettlementRows: 450 } });
  const settlement = createSettlement({ journal, battleRepository: battles, fleetRepository: fr.fleets.repository,
    travel: fr.fleets.travel, getGraph: () => shared.graph,
    worldRepository: { limits: { maxBatchReadIds: 8 }, getSystems: (tx, ids) => ({ ok: true, systems: [],
      missing: ids }) },
    limits: { maxResultBytes: 65536, maxSettlementRows: 450, retreatSearchMaxJumps: 5, retreatSearchMaxSystems: 200,
      retreatMaxCandidates: 3 } });
  return { store: opened.store, scheduler: sr.scheduler, fleets: fr.fleets, battles, journal, settlement,
    stations: st.stations, tx: txOf(opened.store), now: () => shared.clock.now() };
}

const fleetOf = (env, id) => env.tx((db) => env.fleets.repository.getFleet(db, id)).fleet;

async function passAt(env, shared, at) {
  shared.clock.set(at);
  const p = await env.scheduler.runPass();
  assert.ok(p.ok, JSON.stringify(p));
}

function strand(env, tag, systemId) {
  const fleetId = H.newFleet(env, tag, INVADER, COMP, systemId);
  const stayer = H.newFleet(env, `${tag}:w`, FACTION_A, COMP);
  const battle = H.battleOfFleets(env, tag, [stayer], [fleetId], { systemId, factionB: INVADER });
  const result = H.resultFor(battle.input, "A_WIN", { [fleetId]: (e) => ({ d: 0, e: e.count }) });
  const r = H.settleIn(env, env.settlement, battle, result);
  assert.ok(r.ok, JSON.stringify(r));
  const f = fleetOf(env, fleetId);
  assert.deepStrictEqual([f.state, f.refitPending], ["IDLE", true], tag);
  const r0 = H.eventOf(env, refitSeekKey(fleetId, f.legSeq, 0));
  assert.strictEqual(r0.state, "QUEUED", tag);
  return { fleetId, legSeq: f.legSeq, dueAt: r0.due_at };
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("FR1 foothold repair nodes: invader foothold repairs, [] / not ready -> none, other kinds never read, "
    + "refusal and throw propagate, hive nodes composed", () => {
    const stations = [{ stationId: "s1", systemId: 2, ownerFactionId: FACTION_A, state: "ONLINE" }];
    const repository = {
      listStationsOfFaction: (tx, f) => ({ ok: true, records: stations.filter((s) => s.ownerFactionId === f) }),
      listStationsInSystem: (tx, id) => ({ ok: true, records: stations.filter((s) => s.systemId === id) }),
    };
    const adj = { 1: [2], 2: [1, 3], 3: [2, 4], 4: [3, 5], 5: [4] };
    const graph = { getNeighbors: (id) => adj[id] || [] };
    const limits = { repairSearchMaxJumps: 10, repairSearchMaxSystems: 100, repairMaxCandidates: 4 };
    const kinds = { [FACTION_A]: "empire", [HIVE]: "hive", [INVADER]: "invader" };
    let reads = 0;
    let footholds = { ok: true, footholds: [{ systemId: 4, jumps: 3 }] };
    const footholdsOf = () => { reads += 1; return footholds; };
    const hive = (tx, f) => ({ ok: true, systems: new Set(f === HIVE ? [5] : []) });
    const locatorOf = (reader) => createRepairLocator({ repository, getGraph: () => graph, getMode: () => "ready",
      limits, repairNodesOf: composeRepairNodes(hive,
        createFootholdRepairNodes({ footholdsOf: reader, kindOf: (f) => kinds[f] || null })) });
    const loc = locatorOf(footholdsOf);

    assert.deepStrictEqual([loc.hasRepairStation("tx", INVADER, 4),
      loc.findNearestStations("tx", { factionId: INVADER, fromSystemId: 1 })],
    [{ ok: true, stationId: "hive-node:4" }, { ok: true, targets: [4], visited: 4 }]);
    footholds = { ok: true, footholds: [] };
    assert.deepStrictEqual(loc.hasRepairStation("tx", INVADER, 4), { ok: true, stationId: null });
    const before = reads;
    assert.deepStrictEqual([loc.hasRepairStation("tx", FACTION_A, 2), loc.hasRepairStation("tx", HIVE, 5),
      loc.findNearestStations("tx", { factionId: HIVE, fromSystemId: 1 })],
    [{ ok: true, stationId: "s1" }, { ok: true, stationId: "hive-node:5" }, { ok: true, targets: [5], visited: 4 }]);
    assert.strictEqual(reads, before);
    const nodes = (reader) => createFootholdRepairNodes({ footholdsOf: reader, kindOf: () => "invader" })("tx", INVADER);
    assert.deepStrictEqual([nodes(() => null), nodes(null)], [{ ok: true, systems: new Set() },
      { ok: true, systems: new Set() }]);
    footholds = { ok: false, reason: "TX_FAILED: x" };
    assert.deepStrictEqual(loc.hasRepairStation("tx", INVADER, 4), { ok: false, reason: "TX_FAILED: x" });
    assert.deepStrictEqual(nodes(() => { throw new Error("boom"); }), { ok: false, reason: "FOOTHOLD_REPAIR_THREW" });
    assert.strictEqual(composeRepairNodes(undefined, undefined), undefined);
  });

  needsDriver("FR2 flag on: stranded invader fleet at its ACTIVE foothold -> seek round -> REFITTING -> IDLE; "
    + "foothold gone ([]) -> stays IDLE refit_pending", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    let active = [];
    const env = await boot(reopen(), shared, true,
      (tx, f) => ({ ok: true, footholds: f === INVADER ? active.map((systemId) => ({ systemId, jumps: 0 })) : [] }));
    assert.notStrictEqual(env.stations.refitLocator, env.stations.locator);

    const x = strand(env, "frx", S.N9);
    active = [S.N9];
    await passAt(env, shared, x.dueAt);
    let f = fleetOf(env, x.fleetId);
    assert.deepStrictEqual([f.state, f.currentSystemId, f.refitPending], ["REFITTING", S.N9, true]);
    await passAt(env, shared, f.nextActionAt);
    f = fleetOf(env, x.fleetId);
    assert.deepStrictEqual([f.state, f.refitPending], ["IDLE", false]);

    active = [];
    const y = strand(env, "fry", S.N9);
    await passAt(env, shared, y.dueAt);
    f = fleetOf(env, y.fleetId);
    assert.deepStrictEqual([f.state, f.refitPending], ["IDLE", true]);
    assert.strictEqual(H.eventOf(env, refitSeekKey(y.fleetId, y.legSeq, 1)).state, "QUEUED");
    env.stations.stop("test");
  }));

  needsDriver("FR3 flag off: refitLocator === locator, footholds never read; travel without refitLocator uses locator",
    () => H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      let reads = 0;
      const env = await boot(reopen(), shared, false, () => { reads += 1; return { ok: true, footholds: [] }; });
      assert.strictEqual(env.stations.refitLocator, env.stations.locator);
      const x = strand(env, "fr3", S.N9);
      await passAt(env, shared, x.dueAt);
      assert.deepStrictEqual([fleetOf(env, x.fleetId).state, fleetOf(env, x.fleetId).refitPending], ["IDLE", true]);
      assert.strictEqual(reads, 0);
      env.stations.stop("test");

      const modeWith = (stub) => {
        const sr = startScheduler({ config: configOf(false), persistence: { ok: true, store: env.store },
          clock: shared.clock, ids: shared.ids, nowMs: () => 0 });
        const fr = startFleets({ config: configOf(false), persistence: { ok: true, store: env.store,
          journal: env.journal, worldSeed: 1 }, clock: shared.clock, ids: shared.ids, scheduler: sr.scheduler,
        graph: { getGraph: () => ({ ok: true, graph: shared.graph }) }, presence: null, views: createViewRegistry(),
        getStations: () => stub });
        assert.ok(fr.ok, JSON.stringify(fr));
        const mode = fr.fleets.travel.refitMode();
        fr.fleets.stop("test");
        sr.scheduler.stop("test");
        return mode;
      };
      assert.deepStrictEqual([modeWith({ getMode: () => "ready", locator: env.stations.locator }),
        modeWith({ getMode: () => "off", locator: null, refitLocator: null })], ["station", "legacy"]);
    }));
};
