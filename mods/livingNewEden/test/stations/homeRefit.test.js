"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const { createJournal } = require("../../lib/persistence/journal");
const { startScheduler } = require("../../lib/scheduler");
const { startFleets } = require("../../lib/fleets");
const { startStations } = require("../../lib/stations");
const { createRepairLocator } = require("../../lib/stations/repairLocator");
const { createHomeRepairNodes, createFootholdRepairNodes, composeRepairNodes } =
  require("../../lib/stations/repairNodes");
const { createBattleRepository } = require("../../lib/battle/battleRepository");
const { createSettlement } = require("../../lib/battle/settlement");
const { refitSeekKey } = require("../../lib/fleets/travelService");
const { createViewRegistry } = require("../../lib/observer/views");
const { resolveConfig } = require("../../config");
const { harness: H } = require("../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const { S, FACTION_A, FACTION_B } = H;
const INVADER = 500001;
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

function configOf(flags) {
  return { ...H.CONFIG, modules: { ...H.CONFIG.modules, strategy: { enabled: true } },
    fleets: { ...H.CONFIG.fleets, refitPolicy: "station" }, stations: { ...STATIONS },
    invasions: { ...(H.CONFIG.invasions || {}), ...flags },
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

async function boot(opened, shared, flags, readers) {
  const config = configOf(flags);
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
    footholdsOf: readers.footholdsOf, homeOf: readers.homeOf });
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

function escapeAtNode(env, tag, systemId) {
  const fleetId = H.newFleet(env, tag, INVADER, COMP, systemId);
  const stayer = H.newFleet(env, `${tag}:w`, FACTION_A, COMP);
  const battle = H.battleOfFleets(env, tag, [stayer], [fleetId], { systemId, factionB: INVADER });
  const result = H.resultFor(battle.input, "A_WIN", { [fleetId]: (e) => ({ d: 0, e: e.count }) });
  const r = H.settleIn(env, env.settlement, battle, result);
  assert.ok(r.ok, JSON.stringify(r));
  const f = fleetOf(env, fleetId);
  assert.deepStrictEqual([f.state, f.currentSystemId, f.refitPending], ["REFITTING", systemId, true], tag);
  return f;
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

  test("HR1 home repair node: controlled home repairs, null / invalid / no reader -> none, throw -> refusal, "
    + "composed with footholds; config warning without homeBaseEnabled", () => {
    const stations = [{ stationId: "s1", systemId: 2, ownerFactionId: FACTION_A, state: "ONLINE" }];
    const repository = {
      listStationsOfFaction: (tx, f) => ({ ok: true, records: stations.filter((s) => s.ownerFactionId === f) }),
      listStationsInSystem: (tx, id) => ({ ok: true, records: stations.filter((s) => s.systemId === id) }),
    };
    const adj = { 1: [2], 2: [1, 3], 3: [2, 4], 4: [3, 5], 5: [4] };
    const graph = { getNeighbors: (id) => adj[id] || [] };
    const limits = { repairSearchMaxJumps: 10, repairSearchMaxSystems: 100, repairMaxCandidates: 4 };
    let home = { systemId: 5, jumps: 3, home: true };
    const homeOf = (tx, f) => (f === INVADER ? home : null);
    const footholdsOf = () => ({ ok: true, footholds: [{ systemId: 3, jumps: 3 }] });
    const loc = createRepairLocator({ repository, getGraph: () => graph, getMode: () => "ready", limits,
      repairNodesOf: composeRepairNodes(createFootholdRepairNodes({ footholdsOf,
        kindOf: (f) => KINDS[f] || null }), createHomeRepairNodes({ homeOf })) });
    assert.deepStrictEqual([loc.hasRepairStation("tx", INVADER, 5),
      loc.findNearestStations("tx", { factionId: INVADER, fromSystemId: 1 })],
    [{ ok: true, stationId: "hive-node:5" }, { ok: true, targets: [3, 5], visited: 4 }]);
    home = null;
    assert.deepStrictEqual([loc.hasRepairStation("tx", INVADER, 5), loc.hasRepairStation("tx", FACTION_A, 2)],
      [{ ok: true, stationId: null }, { ok: true, stationId: "s1" }]);
    const nodes = (reader) => createHomeRepairNodes({ homeOf: reader })("tx", INVADER);
    const empty = { ok: true, systems: new Set() };
    assert.deepStrictEqual([nodes(null), nodes(() => null), nodes(() => ({ systemId: 0 })),
      nodes(() => ({ systemId: "5" }))], [empty, empty, empty, empty]);
    assert.deepStrictEqual(nodes(() => { throw new Error("boom"); }), { ok: false, reason: "HOME_REPAIR_THREW" });

    const env = { EVEJS_DATA_ROOT: os.tmpdir(), EVEJS_LNE_INVASIONS_REFIT_AT_HOME_ENABLED: "1" };
    const solo = resolveConfig({ modDir: MOD_DIR, env });
    assert.strictEqual(solo.config.invasions.refitAtHomeEnabled, true);
    assert.ok(solo.warnings.some((w) => w.startsWith("invasions.refitAtHomeEnabled without invasions.homeBaseEnabled")),
      JSON.stringify(solo.warnings));
    const both = resolveConfig({ modDir: MOD_DIR, env: { ...env, EVEJS_LNE_INVASIONS_HOME_BASE_ENABLED: "1" } });
    assert.ok(!both.warnings.some((w) => w.startsWith("invasions.refitAtHomeEnabled")), JSON.stringify(both.warnings));
    const def = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir() } });
    assert.strictEqual(def.config.invasions.refitAtHomeEnabled, false);
  });

  needsDriver("HR2 flag on: stranded invader fleet at its home -> REFITTING -> IDLE (settlement and seek round); "
    + "away from home -> RETREATING home; home lost (null) -> stays IDLE refit_pending",
  () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    let home = null;
    const env = await boot(reopen(), shared, { refitAtHomeEnabled: true, homeBaseEnabled: true },
      { homeOf: (tx, f) => (f === INVADER && home !== null ? { systemId: home, jumps: 3, home: true } : null) });
    assert.notStrictEqual(env.stations.refitLocator, env.stations.locator);

    const x = strand(env, "hrx", S.N9);
    home = S.N9;
    await passAt(env, shared, x.dueAt);
    let f = fleetOf(env, x.fleetId);
    assert.deepStrictEqual([f.state, f.currentSystemId, f.refitPending], ["REFITTING", S.N9, true]);
    await passAt(env, shared, f.nextActionAt);
    f = fleetOf(env, x.fleetId);
    assert.deepStrictEqual([f.state, f.refitPending], ["IDLE", false]);
    const w = escapeAtNode(env, "hrw", S.N9);
    await passAt(env, shared, w.nextActionAt);
    assert.deepStrictEqual([fleetOf(env, w.fleetId).state, fleetOf(env, w.fleetId).refitPending], ["IDLE", false]);

    home = S.N7;
    const yId = H.newFleet(env, "hry", INVADER, COMP, S.N9);
    const yb = H.battleOfFleets(env, "hry", [H.newFleet(env, "hry:w", FACTION_A, COMP)], [yId],
      { systemId: S.N9, factionB: INVADER });
    const yr = H.settleIn(env, env.settlement, yb, H.resultFor(yb.input, "A_WIN", { [yId]: (e) => ({ d: 0,
      e: e.count }) }));
    assert.ok(yr.ok, JSON.stringify(yr));
    f = fleetOf(env, yId);
    assert.deepStrictEqual([f.state, f.targetSystemId, f.refitPending], ["RETREATING", S.N7, true]);

    home = null;
    const z = strand(env, "hrz", S.N9);
    await passAt(env, shared, z.dueAt);
    f = fleetOf(env, z.fleetId);
    assert.deepStrictEqual([f.state, f.refitPending], ["IDLE", true]);
    assert.strictEqual(H.eventOf(env, refitSeekKey(z.fleetId, z.legSeq, 1)).state, "QUEUED");
    env.stations.stop("test");
  }));

  needsDriver("HR3 flag off (or without homeBaseEnabled): home never read; refitLocator as before (=== locator "
    + "without footholds, footholds still repair with refitAtFootholdEnabled)", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    let reads = 0;
    const homeOf = () => { reads += 1; return { systemId: S.N9, jumps: 3, home: true }; };
    const opened = reopen();
    for (const flags of [{}, { refitAtHomeEnabled: false, homeBaseEnabled: true },
      { refitAtHomeEnabled: true, homeBaseEnabled: false }]) {
      const env = await boot(opened, shared, flags, { homeOf });
      assert.strictEqual(env.stations.refitLocator, env.stations.locator, JSON.stringify(flags));
      const x = strand(env, `hr3${Object.keys(flags).length}${flags.homeBaseEnabled === true ? "h" : ""}`, S.N9);
      await passAt(env, shared, x.dueAt);
      assert.deepStrictEqual([fleetOf(env, x.fleetId).state, fleetOf(env, x.fleetId).refitPending], ["IDLE", true]);
      env.stations.stop("test");
      env.scheduler.stop("test");
      env.fleets.stop("test");
    }
    const env = await boot(opened, shared, { refitAtFootholdEnabled: true, refitAtHomeEnabled: false,
      homeBaseEnabled: true }, { homeOf, footholdsOf: (tx, f) => ({ ok: true,
      footholds: f === INVADER ? [{ systemId: S.N9, jumps: 0 }] : [] }) });
    assert.notStrictEqual(env.stations.refitLocator, env.stations.locator);
    escapeAtNode(env, "hr3f", S.N9);
    assert.strictEqual(reads, 0);
    env.stations.stop("test");
  }));
};
