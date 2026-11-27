"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { createJournal } = require("../../lib/persistence/journal");
const { LATEST_SCHEMA_VERSION, MIGRATIONS } = require("../../lib/persistence/migrations");
const { startScheduler } = require("../../lib/scheduler");
const { startFleets } = require("../../lib/fleets");
const { startStations } = require("../../lib/stations");
const { startConstruction } = require("../../lib/stations/construction");
const { startOccupation } = require("../../lib/world/occupation");
const { startWrecks } = require("../../lib/world/wrecks");
const { createWorldStateRepository } = require("../../lib/world/worldStateRepository");
const { rowsBound, SCORE_MAX } = require("../../lib/world/occupation/schema");
const { startSiege, createUnavailableSiege } = require("../../lib/stations/siege");
const M = require("../../lib/stations/siege/siegeMachine");
const SS = require("../../lib/stations/siege/schema");
const { parseCheckPayload, parseStepPayload } = require("../../lib/stations/siege/siegeService");
const D = require("../../lib/stations/data/structureDefense");
const { GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { createViewRegistry } = require("../../lib/observer/views");
const { harness: H } = require("../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const FULL = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir() } }).config;
const { S, FACTION_A: SANSHA, FACTION_B: OWNER } = H;
const AMARR = 500003;
const CALDARI = 500001;
const HOUR = 3600000;
const CORP_OF = Object.freeze({ [SANSHA]: 1000161, [OWNER]: 1000162, [AMARR]: 1000163, [CALDARI]: 1000164 });
const KNOWN = Object.freeze([SANSHA, OWNER, AMARR, CALDARI]);
const FLEET = Object.freeze([{ hullGroup: "battleship", count: 20 }]);
const M34 = "mineral/type:34";
const M35 = "mineral/type:35";
const KITS = Object.freeze({ mini: Object.freeze({ kind: "upwell", structureFamily: "astrahus", typeId: 35832,
  items: Object.freeze({ [M34]: 3000, [M35]: 1000 }) }) });

function registryOf(canOccupy) {
  return Object.freeze({
    getFaction: (id) => (KNOWN.includes(Number(id)) ? { factionId: Number(id), startStations: [],
      ownerCorporationId: CORP_OF[Number(id)], doctrineId: `d${id}`, allies: [] } : null),
    listFactions: () => KNOWN.map((factionId) => ({ factionId })),
    listActiveFactions: () => [],
    isActive: (id) => KNOWN.includes(Number(id)),
    corporationFor: (id) => (KNOWN.includes(Number(id)) ? CORP_OF[Number(id)] : null),
    getDoctrine: (d) => ({ doctrineId: d, canOccupy: canOccupy.includes(Number(String(d).slice(1))) }),
  });
}

function testConfig(opts = {}) {
  return { ...H.CONFIG, modules: { ...H.CONFIG.modules, strategy: { enabled: true } },
    stations: { ...DEFAULTS.stations, ...(opts.stations || {}) },
    construction: { ...DEFAULTS.construction, kitId: "mini", supplyTimeoutMs: 4 * HOUR, recheckMs: HOUR,
      anchoringMs: 100 * HOUR },
    siege: { ...DEFAULTS.siege, maxWaitRounds: 2, ...(opts.siege || {}) },
    world: DEFAULTS.world,
    persistence: { ...H.CONFIG.persistence, maxRowsPerTransaction: 500 },
    ...(opts.grid ? { grid: opts.grid } : {}),
    ...(opts.wrecks ? { wrecks: opts.wrecks } : {}),
    ...(opts.observer ? { observer: opts.observer } : {}) };
}

function fakeWorld(systems) {
  return { repository: { getSystems(tx, ids) {
    return { ok: true, systems: ids.filter((id) => systems.has(id)).map((id) => ({ systemId: id, ...systems.get(id) })),
      missing: ids.filter((id) => !systems.has(id)) };
  } } };
}

async function boot(opened, shared, opts = {}) {
  const cfg = testConfig(opts);
  const registry = registryOf(opts.canOccupy || []);
  const rows = [];
  const real = opened.store;
  const store = { ...real, transaction: (name, fn) => {
    const r = real.transaction(name, fn);
    rows.push({ name, rows: r.rows });
    return r;
  } };
  const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
  const sr = startScheduler({ config: cfg, persistence: { ok: true, store }, clock: shared.clock, ids: shared.ids,
    nowMs: () => 0 });
  assert.ok(sr.ok, JSON.stringify(sr));
  const holder = { stations: null, construction: null, occupation: null };
  const persistence = { ok: true, store, journal, worldSeed: opened.worldSeed };
  const graph = { getGraph: () => ({ ok: true, graph: shared.graph }),
    whenReady: () => Promise.resolve({ ok: true, graph: shared.graph }) };
  const fr = startFleets({ config: cfg, persistence, clock: shared.clock, ids: shared.ids, scheduler: sr.scheduler,
    graph, presence: null, views: createViewRegistry(), getStations: () => holder.stations,
    ...(opts.gridAdapter ? { adapter: opts.gridAdapter } : {}) });
  assert.ok(fr.ok, JSON.stringify(fr));
  const st = startStations({ config: cfg, persistence, strategy: { registry }, graph, clock: shared.clock });
  assert.ok(st.ok, JSON.stringify(st));
  holder.stations = st.stations;
  await st.stations.whenReady();
  const lines = [];
  const logger = { log: (l) => lines.push(l) };
  const repo = createWorldStateRepository({ journal, clock: shared.clock,
    limits: { maxFactionsPerSystem: 8, maxBatchReadIds: 400, maxListLimit: 500 } });
  if (opts.occupation === true) {
    const or = startOccupation({ config: FULL, persistence, clock: shared.clock, scheduler: sr.scheduler,
      fleets: fr.fleets, world: { repository: repo }, graph, getStations: () => holder.stations, logger,
      nowMs: () => 0 });
    assert.ok(or.ok, JSON.stringify(or));
    holder.occupation = or.occupation;
  }
  if (opts.sites) {
    const cr = startConstruction({ config: cfg, persistence, clock: shared.clock, ids: shared.ids,
      scheduler: sr.scheduler, world: fakeWorld(opts.sites), strategy: { registry },
      getStations: () => holder.stations, logger, kitsData: KITS });
    assert.ok(cr.ok, JSON.stringify(cr));
    holder.construction = cr.construction;
  }
  let wrecks = null;
  if (opts.wrecks && opts.wrecks.enabled === true) {
    const wr = startWrecks({ config: { ...cfg, modules: { ...cfg.modules, world: { enabled: true } } }, persistence,
      clock: shared.clock, scheduler: sr.scheduler, logger });
    assert.ok(wr.ok, JSON.stringify(wr));
    wrecks = wr.wrecks;
  }
  const hook = { enqueue: null };
  const scheduler = { ...sr.scheduler, enqueue: (...a) => {
    const replaced = hook.enqueue ? hook.enqueue(a) : undefined;
    if (replaced !== undefined) return replaced;
    return sr.scheduler.enqueue(...a);
  } };
  const started = startSiege({ config: cfg, persistence, clock: shared.clock, ids: shared.ids, scheduler,
    fleets: fr.fleets, strategy: { registry }, graph, getStations: () => holder.stations,
    getOccupation: () => opts.occupationFake || holder.occupation, getConstruction: () => holder.construction, getWrecks: () => wrecks,
    coreIndex: opts.coreIndex, views: opts.views || null, adapter: opts.adapter || null, logger });
  const tx = (fn) => {
    const r = real.transaction("test", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  return { store: real, scheduler: sr.scheduler, fleets: fr.fleets, stations: st.stations, repo,
    occupation: holder.occupation, construction: holder.construction, siege: started.ok ? started.siege : null,
    started, lines, rows, hook, tx };
}

function stopAll(env) {
  if (env.siege) env.siege.stop("restart");
  if (env.construction) env.construction.stop("restart");
  if (env.occupation) env.occupation.stop("restart");
  env.stations.stop("restart");
  env.store.close("restart");
}

function addStation(env, id, systemId, owner, at, kind = "upwell", npcStationId = undefined) {
  const spec = kind === "npc" ? { stationId: id, kind, npcStationId, systemId, ownerFactionId: owner,
    ownerCorporationId: CORP_OF[owner], origin: "seed", at }
    : { stationId: id, kind, typeId: 35832, structureFamily: "astrahus", systemId, ownerFactionId: owner,
      ownerCorporationId: CORP_OF[owner], origin: "built", at };
  const r = env.tx((db) => env.stations.repository.createStation(db, spec, `test:station:${id}`));
  assert.ok(r.ok, JSON.stringify(r));
}

function putStock(env, stationId, at) {
  const r = env.tx((db) => env.stations.repository.applyStockChange(db, { stationId, key: `test:stock:${stationId}`,
    reason: "TEST", at, deltas: [{ itemKind: "mineral", itemKey: "type:34", delta: 5000 },
      { itemKind: "hull", itemKey: "group:frigate", delta: 3 }] }));
  assert.ok(r.ok, JSON.stringify(r));
}

function newFleet(env, tag, factionId, systemId, role = "invasion") {
  const r = env.fleets.createFleet({ factionId, currentSystemId: systemId, homeSystemId: systemId, fleetRole: role,
    composition: FLEET }, `${tag}:create`);
  assert.ok(r.ok, JSON.stringify(r));
  return r.fleetId;
}

function engage(env, id, tag) {
  return env.tx((db) => {
    const f = env.fleets.repository.getFleet(db, id).fleet;
    const e = env.fleets.repository.transition(db, { fleetId: id, expectedVersion: f.version, from: f.state,
      to: "ENGAGED" }, `${tag}:engage`);
    assert.ok(e.ok, JSON.stringify(e));
    return e.version;
  });
}

function destroyFleet(env, id, tag) {
  const f0 = env.tx((db) => env.fleets.repository.getFleet(db, id).fleet);
  const version = f0.state === "ENGAGED" ? f0.version : engage(env, id, tag);
  env.tx((db) => {
    const l = env.fleets.repository.applyLosses(db, { fleetId: id, expectedVersion: version,
      losses: f0.composition.map((c) => ({ hullGroup: c.hullGroup, typeId: null, count: c.count })) },
    `${tag}:loss`);
    assert.ok(l.ok && l.destroyed, JSON.stringify(l));
  });
}

function requestCheck(env, shared, systemId, key, triggerFleetId = null) {
  const r = env.tx((db) => env.siege.requestCheckInTx(db, { systemId, at: shared.clock.now(), key, triggerFleetId }));
  assert.ok(r.ok, JSON.stringify(r));
}

const countOf = (env, sql, ...args) => env.tx((db) => db.prepare(sql).get(...args)).n;
const stationOf = (env, id) => env.tx((db) => env.stations.repository.getStation(db, id)).record;
const siegeOf = (env, id) => env.tx((db) => env.siege.repository.getSiege(db, id)).siege;
const siegeOfStation = (env, stationId) => {
  const row = env.tx((db) => db.prepare("SELECT siege_id FROM world_station_sieges WHERE station_id = ? "
    + "ORDER BY siege_no DESC").get(stationId));
  return row ? siegeOf(env, row.siege_id) : null;
};
const totalsOf = (env, f) => env.tx((db) => env.siege.repository.readTotals(db, f)).totals;
const stockRows = (env, id) => countOf(env, "SELECT count(*) AS n FROM world_station_stock WHERE station_id = ?", id);
const journalOf = (env, type, aggregateId) => countOf(env, "SELECT count(*) AS n FROM world_event_journal WHERE "
  + "event_type = ? AND aggregate_id = ?", type, aggregateId);
const nextStepDue = (env) => env.tx((db) => db.prepare("SELECT min(due_at) AS t FROM world_scheduled_events WHERE "
  + "event_type = 'STATION_SIEGE_STEP' AND state = 'QUEUED'").get()).t;

async function settleAt(env, shared, at) {
  shared.clock.set(Math.max(shared.clock.now(), at));
  for (let i = 0; i < 16; i += 1) {
    const p = await env.scheduler.runPass();
    assert.ok(p.ok, JSON.stringify(p));
    if (p.jobs === 0) return;
  }
  throw new Error("queue did not settle");
}

async function drive(env, shared, stop, max = 40) {
  for (let i = 0; i < max; i += 1) {
    if (stop && stop()) return;
    const t = nextStepDue(env);
    if (t === null || t === undefined) return;
    await settleAt(env, shared, Number(t));
  }
  throw new Error(`siege did not end: ${JSON.stringify(env.tx((db) => db.prepare("SELECT station_id, state, "
    + "wait_round FROM world_station_sieges").all()))} ${JSON.stringify(env.siege.getStatus())}`);
}

const siege = (o) => ({ open: true, phaseSeq: 1, waitRound: 0, state: "SHIELD_ASSAULT", ownerFactionId: OWNER,
  plan: M.buildPlan({ kind: "upwell", structureFamily: "astrahus" }, "nullsec", { timerScale: 0.25,
    assaultMinMs: 900000, assaultMaxMs: 21600000 }).plan, ...o });
const stationRow = (o) => ({ stationId: "st", kind: "upwell", state: "ONLINE", ownerFactionId: OWNER, version: 1,
  ...o });
const STRONG = Object.freeze({ attackerShips: 20, attackerDps: 3466, engaged: false, contested: false });

module.exports = ({ test, skip }) => {
  test("S1 pure: siege edges, decideStep / decideEnd / assaultMsOf / planStart, payloads, siege.* defaults "
    + "the stub, vendor facts of structureConstants.js", () => {
    const allowed = new Set(["SHIELD_ASSAULT>ARMOR_TIMER", "ARMOR_TIMER>ARMOR_ASSAULT", "ARMOR_ASSAULT>HULL_TIMER",
      "HULL_TIMER>HULL_ASSAULT", "HULL_ASSAULT>DESTROYED", "HULL_ASSAULT>CAPTURED", "HULL_ASSAULT>SACKED",
      "ANCHOR_ASSAULT>DESTROYED", ...SS.OPEN_SIEGE_STATES.flatMap((s) => [`${s}>REPELLED`, `${s}>ABORTED`])]);
    for (const a of SS.SIEGE_STATES) {
      for (const b of SS.SIEGE_STATES) {
        const r = M.canTransitionSiege(a, b);
        assert.strictEqual(r.ok, allowed.has(`${a}>${b}`), `${a}>${b}`);
        if (!r.ok) assert.strictEqual(r.reason, "TRANSITION_NOT_ALLOWED");
      }
    }
    assert.strictEqual(M.canTransitionSiege("X", "REPELLED").reason, "UNKNOWN_STATE");
    assert.deepStrictEqual(SS.OPEN_SIEGE_STATES.map(M.stationStateFor), ["ONLINE", "ARMOR_REINFORCE",
      "ARMOR_REINFORCE", "HULL_REINFORCE", "HULL_REINFORCE", "ANCHORING"]);

    const P = { timerScale: 0.25, assaultMinMs: 900000, assaultMaxMs: 21600000 };
    const astra = M.buildPlan({ kind: "upwell", structureFamily: "astrahus" }, "nullsec", P).plan;
    assert.deepStrictEqual([astra.family, astra.band, astra.armorTimerMs, astra.hullTimerMs, astra.ehp.anchor],
      ["astrahus", "null", 75600000, 54000000, 3600000]);
    const npc = M.buildPlan({ kind: "npc", structureFamily: null }, "highsec", P).plan;
    assert.deepStrictEqual([npc.family, npc.armorTimerMs, npc.hullTimerMs, npc.ehp.hull], ["npc", 21600000, 97200000,
      21600000]);
    assert.strictEqual(M.buildPlan({ kind: "upwell", structureFamily: "moon_x" }, "nullsec", P).reason, "UNKNOWN_FAMILY");
    assert.strictEqual(M.buildPlan({ kind: "npc" }, "nullsec", { ...P, assaultMaxMs: 1 }).reason, "PARAMS_INVALID");
    assert.ok(JSON.stringify(astra).length <= SS.MAX_PLAN_BYTES);
    assert.deepStrictEqual(M.assaultMsOf(astra, "shield", 1000), { ok: true, ms: 3600000 });
    assert.deepStrictEqual(M.assaultMsOf(astra, "armor", 1e9), { ok: true, ms: 900000 }, "cap 5000 -> 360 s -> min");
    assert.strictEqual(M.assaultMsOf(astra, "hull", 50).reason, "INSUFFICIENT_FORCE");
    assert.strictEqual(M.assaultMsOf(astra, "hull", 0).reason, "INSUFFICIENT_FORCE");

    const F = { at: 1000, phaseSeq: 1, round: 0, maxWaitRounds: 2, canCapture: false, captureUpwell: false };
    const armorSt = stationRow({ state: "ARMOR_REINFORCE" });
    const hullSt = stationRow({ state: "HULL_REINFORCE" });
    const cases = [
      [null, stationRow(), STRONG, F, { action: "STALE" }],
      [siege({ open: false }), stationRow(), STRONG, F, { action: "STALE" }],
      [siege({ phaseSeq: 2 }), stationRow(), STRONG, F, { action: "STALE" }],
      [siege(), null, STRONG, F, { action: "ABORT", reason: "STATION_GONE", stationTo: null }],
      [siege({ state: "ARMOR_TIMER" }), stationRow({ state: "ARMOR_REINFORCE", ownerFactionId: AMARR }), STRONG, F,
        { action: "ABORT", reason: "OWNER_CHANGED", stationTo: "ONLINE" }],
      [siege({ state: "ANCHOR_ASSAULT" }), stationRow(), STRONG, F,
        { action: "ABORT", reason: "STATION_STATE_CHANGED", stationTo: null }],
      [siege({ state: "ARMOR_TIMER" }), armorSt, { ...STRONG, contested: true }, F, { action: "WAIT", round: 1 }],
      [siege({ state: "ARMOR_TIMER", waitRound: 2 }), armorSt, { ...STRONG, engaged: true }, { ...F, round: 2 },
        { action: "REPEL", reason: "CONTESTED_TIMEOUT", stationTo: "ONLINE" }],
      [siege(), stationRow(), { ...STRONG, attackerShips: 0, attackerDps: 0 }, F,
        { action: "REPEL", reason: "ATTACKER_GONE", stationTo: null }],
      [siege({ state: "ARMOR_TIMER" }), armorSt, { ...STRONG, attackerDps: 10 }, F,
        { action: "REPEL", reason: "INSUFFICIENT_FORCE", stationTo: "ONLINE" }],
      [siege(), stationRow(), STRONG, F, { action: "ADVANCE", to: "ARMOR_TIMER", phaseEndsAt: 1000 + 75600000,
        station: { from: "ONLINE", to: "ARMOR_REINFORCE", stateUntilAt: 1000 + 75600000 } }],
      [siege({ state: "ARMOR_TIMER" }), armorSt, STRONG, F, { action: "ADVANCE", to: "ARMOR_ASSAULT",
        phaseEndsAt: 1000 + 900000, station: null }],
      [siege({ state: "ARMOR_ASSAULT" }), armorSt, STRONG, F, { action: "ADVANCE", to: "HULL_TIMER",
        phaseEndsAt: 1000 + 54000000, station: { from: "ARMOR_REINFORCE", to: "HULL_REINFORCE",
          stateUntilAt: 1000 + 54000000 } }],
      [siege({ state: "HULL_TIMER" }), hullSt, STRONG, F, { action: "ADVANCE", to: "HULL_ASSAULT",
        phaseEndsAt: 1000 + 900000, station: null }],
      [siege({ state: "HULL_ASSAULT" }), hullSt, STRONG, F, { action: "END", to: "DESTROYED", anchoring: false }],
      [siege({ state: "HULL_ASSAULT" }), hullSt, STRONG, { ...F, canCapture: true, captureUpwell: true },
        { action: "END", to: "CAPTURED", anchoring: false }],
      [siege({ state: "HULL_ASSAULT" }), stationRow({ kind: "npc", state: "HULL_REINFORCE" }), STRONG,
        { ...F, canCapture: true }, { action: "END", to: "CAPTURED", anchoring: false }],
      [siege({ state: "ANCHOR_ASSAULT" }), stationRow({ state: "ANCHORING" }), STRONG, F,
        { action: "END", to: "DESTROYED", anchoring: true }],
    ];
    for (const [sg, st, hold, facts, want] of cases) {
      const d = M.decideStep(sg, st, hold, facts);
      assert.deepStrictEqual(d, want, JSON.stringify([sg && sg.state, st && st.state, hold, d]));
      if (d.to && sg) assert.ok(M.canTransitionSiege(sg.state, d.to).ok, `${sg.state}>${d.to}`);
    }
    const npcSt = { kind: "npc", state: "HULL_REINFORCE" };
    assert.deepStrictEqual([
      M.decideEnd(npcSt, { canOccupy: true, captureLimitsOk: true }),
      M.decideEnd(npcSt, { canOccupy: false }),
      M.decideEnd(npcSt, { canOccupy: true, captureLimitsOk: false }),
      M.decideEnd({ kind: "upwell", state: "HULL_REINFORCE" }, { canOccupy: true, captureUpwell: false }),
      M.decideEnd({ kind: "upwell", state: "ANCHORING" }, { canOccupy: true, captureUpwell: true }),
    ], ["CAPTURED", "SACKED", "SACKED", "DESTROYED", "DESTROYED"]);

    const fleet = (fleetId, factionId, state = "IDLE", fleetRole = "invasion") => ({ fleetId, factionId, state,
      fleetRole, composition: FLEET });
    const base = { system: { systemId: 1, secClass: "nullsec" }, openSieges: [], openTotal: 0,
      openByAttacker: new Map(), triggerFleetId: null, at: 0, isHostile: (a, b) => a !== b, isActive: () => true,
      groups: GROUPS, params: { ...P, allowHighsec: false, maxOpenSieges: 64, maxOpenSiegesPerFaction: 4 },
      stations: [{ stationId: "b", kind: "upwell", structureFamily: "astrahus", state: "ONLINE", ownerFactionId: OWNER },
        { stationId: "a", kind: "npc", state: "ONLINE", ownerFactionId: OWNER },
        { stationId: "z", kind: "upwell", structureFamily: "astrahus", state: "ANCHORING", ownerFactionId: OWNER }],
      fleets: [fleet("f1", SANSHA), fleet("f2", AMARR, "STAGED")] };
    assert.strictEqual(M.planStart({ ...base, system: { systemId: 1, secClass: "highsec" } }).reason, "HIGHSEC");
    assert.strictEqual(M.planStart({ ...base, fleets: [...base.fleets, fleet("f3", CALDARI, "ENGAGED")] }).reason,
      "ENGAGED");
    assert.strictEqual(M.planStart(base).reason, "CONTESTED", "Sansha and Amarr contest each other");
    const one = M.planStart({ ...base, fleets: [fleet("f1", SANSHA), fleet("f9", SANSHA, "IDLE", "scout")] });
    assert.deepStrictEqual([one.start.stationId, one.start.state, one.start.attackerFactionId, one.start.attackerShips],
      ["z", "ANCHOR_ASSAULT", SANSHA, 20], "ANCHORING first; a scout does not besiege");
    const iso = (stations) => M.planStart({ ...base, fleets: [fleet("f1", SANSHA)], stations });
    assert.strictEqual(iso(base.stations.slice(0, 2)).start.stationId, "b", "Upwell before NPC");
    assert.strictEqual(M.planStart({ ...base, fleets: [fleet("f1", SANSHA)], openTotal: 64 }).reason, "LIMIT");
    assert.strictEqual(M.planStart({ ...base, fleets: [fleet("f1", SANSHA)], openSieges: [{ stationId: "q",
      attackerFactionId: SANSHA }] }).reason, "BUSY");
    assert.strictEqual(M.planStart({ ...base, fleets: [{ ...fleet("f1", SANSHA), composition: [{ hullGroup: "frigate",
      count: 1 }] }] }).reason, "INSUFFICIENT_FORCE");
    assert.strictEqual(M.planStart({ ...base, fleets: [fleet("f1", SANSHA)], truncated: true }).reason, "CONTESTED");
    const sacked = { ...base, fleets: [fleet("f1", SANSHA)], stations: base.stations.slice(1, 2),
      params: { ...base.params, sackCooldownMs: 100 },
      lastSieges: new Map([["a", { state: "SACKED", attackerFactionId: SANSHA, endedAt: 0 }]]) };
    assert.deepStrictEqual([M.planStart({ ...sacked, at: 99 }).reason, M.planStart({ ...sacked, at: 100 }).start
      .stationId], ["BUSY", "a"]);
    const amarrOnly = { ...sacked, fleets: [fleet("f2", AMARR)] };
    assert.deepStrictEqual([M.planStart({ ...amarrOnly, at: 99 }).reason, M.planStart({ ...amarrOnly, at: 100 }).start
      .attackerFactionId], ["BUSY", AMARR]);
    assert.strictEqual(M.planStart({ ...amarrOnly, at: 1, lastSieges: new Map([["a", { state: "REPELLED",
      attackerFactionId: SANSHA, endedAt: 0 }]]) }).start.stationId, "a");
    assert.strictEqual(M.planStart({ ...amarrOnly, at: 1, params: base.params }).start.stationId, "a");
    const ships = (fleetId, count) => ({ ...fleet(fleetId, SANSHA), composition: [{ hullGroup: "battleship", count }] });
    const npcOnly = base.stations.slice(1, 2);
    const planNpc = M.buildPlan(npcOnly[0], "nullsec", P).plan;
    const weakDps = M.holdOf([ships("w", 3)], SANSHA, (a, b) => a !== b, GROUPS).attackerDps;
    assert.deepStrictEqual([M.assaultMsOf(planNpc, "shield", weakDps).ok, M.assaultMsOf(planNpc, "hull", weakDps).ok],
      [true, false], `fixture: weak DPS ${weakDps} between the shield and the hull threshold`);
    const weak = { ...base, fleets: [ships("w", 3)], stations: npcOnly };
    assert.strictEqual(M.planStart(weak).reason, "INSUFFICIENT_FORCE");
    assert.strictEqual(M.planStart({ ...weak, stations: base.stations.slice(0, 1) }).start.state, "SHIELD_ASSAULT",
      "the Astrahus: the shield is the highest threshold");
    const strongDps = M.holdOf([ships("s", 6)], SANSHA, (a, b) => a !== b, GROUPS).attackerDps;
    const strong = M.planStart({ ...weak, fleets: [ships("s", 6)] });
    assert.deepStrictEqual([strong.start.stationId, strong.start.state, strong.start.phaseEndsAt],
      ["a", "SHIELD_ASSAULT", base.at + M.assaultMsOf(planNpc, "shield", strongDps).ms]);
    const weakHold = M.holdOf([ships("w", 3)], SANSHA, (a, b) => a !== b, GROUPS);
    const repel = M.decideStep(siege({ state: "HULL_TIMER", plan: planNpc }),
      stationRow({ stationId: "a", kind: "npc", state: "HULL_REINFORCE" }), weakHold, F);
    assert.deepStrictEqual(repel, { action: "REPEL", reason: "INSUFFICIENT_FORCE", stationTo: "ONLINE" });
    assert.strictEqual(M.planStart({ ...weak, at: F.at, params: { ...base.params, sackCooldownMs: HOUR },
      lastSieges: new Map([["a", { state: "REPELLED", attackerFactionId: SANSHA, endedAt: F.at }]]) }).reason,
    "INSUFFICIENT_FORCE");

    assert.strictEqual(parseCheckPayload({ systemId: 1, at: 0, triggerFleetId: null, x: 1 }), null);
    assert.deepStrictEqual(parseCheckPayload({ systemId: 1, at: 0, triggerFleetId: "f" }),
      { systemId: 1, at: 0, triggerFleetId: "f" });
    assert.strictEqual(parseStepPayload({ siegeId: "sg_x", phaseSeq: 0 }), null);

    const c = DEFAULTS.siege;
    assert.deepStrictEqual([c.enabled, c.timerScale, c.assaultMinMs, c.assaultMaxMs, c.recheckMs, c.maxWaitRounds,
      c.maxOpenSieges, c.maxOpenSiegesPerFaction, c.maxFleetsReadPerCheck, c.maxChecksPerPass, c.maxStepsPerPass,
      c.captureUpwell, c.allowHighsec, c.retentionMs, c.sackCooldownMs, c.pruneBatch, c.reconcileMaxSieges],
    [true, 0.25, 900000, 21600000, 300000, 6, 64, 4, 64, 32, 16, false, false, 604800000, 259200000, 16, 256]);
    const siegeOfEnv = (env) => config.resolveConfig({ modDir: MOD_DIR, env }).config.siege;
    assert.deepStrictEqual([siegeOfEnv({ EVEJS_LNE_SIEGE_RETENTION_MS: "3600000" }).sackCooldownMs,
      siegeOfEnv({ EVEJS_LNE_SIEGE_SACK_COOLDOWN_MS: "1" }).sackCooldownMs], [259200000, 3600000]);
    const endRows = SS.siegeEndRows(rowsBound(DEFAULTS.world.maxFactionsPerSystem),
      DEFAULTS.stations.maxStockItemsPerStation);
    assert.ok(endRows <= DEFAULTS.persistence.maxRowsPerTransaction, String(endRows));
    const stub = createUnavailableSiege("x");
    assert.deepStrictEqual([stub.getMode(), stub.requestCheckInTx().reason], ["off", "SIEGE_UNAVAILABLE"]);
    assert.strictEqual(startSiege({ config: testConfig({ siege: { enabled: false } }) }).reason, "disabled_by_config");

    const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
    assert.ok(found.ok, JSON.stringify(found));
    const text = fs.readFileSync(path.join(found.srcDir, "services", "structure", "structureConstants.js"), "utf8");
    const num = (name) => {
      const m = new RegExp(`\\b${name}: (\\d+),`).exec(text);
      assert.ok(m, name);
      return Number(m[1]);
    };
    assert.deepStrictEqual([num("ARMOR_REINFORCE"), num("HULL_REINFORCE"), num("ANCHOR_VULNERABLE")], [111, 113, 115]);
    const T = D.TIMER_SECONDS;
    const pairs = [["REPAIR_DEFAULT", T.repairDefault], ["REPAIR_HULL", T.repairHull],
      ["ARMOR_REINFORCE_DEFAULT", T.armorDefault]];
    for (const band of ["wormhole", "triglavian", "null", "low", "high"]) {
      pairs.push([`ARMOR_REINFORCE_MEDIUM_${band.toUpperCase()}`, T.armorMedium[band]]);
      pairs.push([`HULL_REINFORCE_${band.toUpperCase()}`, T.hull[band]]);
    }
    for (const [name, value] of pairs) assert.strictEqual(num(name), value, name);
    assert.strictEqual(DEFAULTS.siege.assaultMinMs, T.repairDefault * 1000);
  });

  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("S2 full cycle of an Astrahus without defenders: arrival -> CHECK -> SHIELD -> ARMOR_TIMER -> "
    + "ARMOR -> HULL_TIMER -> HULL -> DESTROYED; stock = lost_units, totals, influence +20 / -15 and occ event; "
    + "one journal entry per edge; end rows <= bound; migration 21", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = await boot(reopen(), shared, { occupation: true });
    assert.ok(env.started.ok, JSON.stringify(env.started));
    assert.deepStrictEqual([MIGRATIONS[20].name, LATEST_SCHEMA_VERSION >= 21], ["world_station_sieges", true]);
    assert.ok(env.lines.includes("siege: running open=0 scale=0.25 captureUpwell=false"), env.lines.join("\n"));
    const t0 = shared.clock.now();
    addStation(env, "st-own", S.N5, OWNER, t0);
    addStation(env, "st-san", S.N0, SANSHA, t0);
    putStock(env, "st-own", t0);
    const seeded = env.tx((db) => env.repo.applyChange(db, { systemId: S.N5, expectedVersion: 0, reason: "SEED_CONTROL",
      state: { securityClass: "nullsec", controllerFactionId: OWNER },
      influence: [{ factionId: OWNER, influenceScore: 60 }] }, `world:seed:v1:${S.N5}`));
    assert.ok(seeded.ok, JSON.stringify(seeded));
    const sig = env.tx((db) => env.occupation.signalInTx(db, { systemId: S.N5, factionId: SANSHA, signal: "INVASION",
      at: t0 }, "test:sig"));
    assert.deepStrictEqual([sig.ok, sig.state], [true, "CONTESTED"], JSON.stringify(sig));

    const fleet = newFleet(env, "s2f", SANSHA, S.N0);
    const op = env.fleets.createOperation({ operationType: "invasion", factionId: SANSHA, originSystemId: S.N0,
      targetSystemId: S.N5, objective: "capture", dueAt: t0 + 1000 * HOUR, fleets: [{ fleetId: fleet,
        expectedVersion: 1 }] }, "s2f:op");
    assert.ok(op.ok, JSON.stringify(op));
    const p = env.fleets.planTravel({ fleetId: fleet, targetSystemId: S.N5 }, "s2f:plan");
    assert.ok(p.ok, JSON.stringify(p));
    for (let i = 0; i < 120 && !siegeOfStation(env, "st-own"); i += 1) await settleAt(env, shared, t0 + i * 60000);
    let sg = siegeOfStation(env, "st-own");
    assert.ok(sg, env.lines.join("\n"));
    assert.deepStrictEqual([sg.state, sg.attackerFactionId, sg.ownerFactionId, sg.siegeNo, sg.attackerShips],
      ["SHIELD_ASSAULT", SANSHA, OWNER, 1, 20]);
    const id = sg.siegeId;
    await drive(env, shared, () => siegeOf(env, id).state === "HULL_ASSAULT");
    const before = env.tx((db) => env.repo.getSystem(db, S.N5)).system;
    const score = (sys, f) => ((sys.influence || []).find((i) => i.factionId === f) || { influenceScore: 0 })
      .influenceScore;
    const rowsFrom = env.rows.length;
    await drive(env, shared, () => !siegeOf(env, id).open);
    sg = siegeOf(env, id);
    const st = stationOf(env, "st-own");
    assert.deepStrictEqual([sg.state, sg.open, sg.lostItems, sg.lostUnits, sg.endReason, st.state],
      ["DESTROYED", false, 2, 5003, "DESTROYED", "DESTROYED"], env.lines.join("\n"));
    assert.strictEqual(stockRows(env, "st-own"), 0, "stock wiped");
    const a = totalsOf(env, SANSHA);
    const o = totalsOf(env, OWNER);
    assert.deepStrictEqual([a.started, a.won, a.repelled, o.besieged, o.lostDestroyed, o.stockUnitsLost, o.defended],
      [1, 1, 0, 1, 1, 5003, 0]);
    assert.deepStrictEqual([journalOf(env, "SIEGE_STARTED", id), journalOf(env, "SIEGE_TRANSITION", id),
      journalOf(env, "STATION_TRANSITION", "st-own"), journalOf(env, "OCCUPATION_STRUCTURE_OUTCOME", String(S.N5))],
    [1, 5, 3, 1]);
    const change = env.tx((db) => db.prepare("SELECT payload FROM world_event_journal WHERE idempotency_key LIKE ?")
      .get(`siege:${id}:%:occ:world:${S.N5}`));
    const inf = JSON.parse(change.payload).influence;
    const after = (f) => (inf.find((i) => i.factionId === f) || { influenceScore: score(before, f) }).influenceScore;
    assert.deepStrictEqual([after(SANSHA), after(OWNER)], [Math.min(SCORE_MAX, score(before, SANSHA) + 20),
      score(before, OWNER) - 15], JSON.stringify(inf));
    assert.strictEqual(countOf(env, "SELECT count(*) AS n FROM world_scheduled_events WHERE idempotency_key LIKE ?",
      `occ:${S.N5}:%:b:${id}`), 1, "occupation evaluation event");
    const maxRows = Math.max(...env.rows.slice(rowsFrom).map((r) => r.rows || 0));
    assert.ok(maxRows <= SS.SIEGE_END_FIXED_ROWS + rowsBound(DEFAULTS.world.maxFactionsPerSystem) + 2,
      `end rows ${maxRows}`);
    const status = env.siege.getStatus();
    assert.deepStrictEqual([status.open, status.counters.started, status.counters.advanced,
      status.counters.destroyed], [0, 1, 4, 1], JSON.stringify(status));
  }));

  needsDriver("S3 restart and idempotency: a crashed deadline effect retried with the same result; a replayed "
    + "CHECK adds no siege; reconcile after a restart only finds duplicates; siege.enabled=false parks the deadline",
  () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    let env = await boot(reopen(), shared);
    const t0 = shared.clock.now();
    addStation(env, "st-own", S.N5, OWNER, t0);
    const fleet = newFleet(env, "s3f", SANSHA, S.N5);
    requestCheck(env, shared, S.N5, "s3:chk", fleet);
    await settleAt(env, shared, t0);
    let sg = siegeOfStation(env, "st-own");
    assert.strictEqual(sg.state, "SHIELD_ASSAULT", env.lines.join("\n"));
    const id = sg.siegeId;
    requestCheck(env, shared, S.N5, "s3:chk2", fleet);
    await settleAt(env, shared, t0 + 1);
    assert.strictEqual(countOf(env, "SELECT count(*) AS n FROM world_station_sieges"), 1);
    const dup = env.tx((db) => env.siege.repository.createSiege(db, { stationId: "st-own", siegeNo: 1,
      systemId: S.N5, ownerFactionId: OWNER, attackerFactionId: SANSHA, state: "SHIELD_ASSAULT", phaseEndsAt: t0,
      plan: sg.plan, attackerShips: 20, attackerStrength: 1, at: t0 }, SS.startKey("st-own", 1)));
    assert.deepStrictEqual([dup.ok, dup.duplicate, dup.siegeId], [true, true, id]);

    let crashes = 0;
    env.hook.enqueue = (a) => {
      if (a[0] === SS.STEP_EVENT_TYPE && crashes === 0) {
        crashes += 1;
        throw new Error("crash after the writes");
      }
    };
    await settleAt(env, shared, sg.phaseEndsAt);
    assert.strictEqual(crashes, 1);
    assert.strictEqual(siegeOf(env, id).state, "SHIELD_ASSAULT", "rolled back");
    assert.strictEqual(stationOf(env, "st-own").state, "ONLINE", "rolled back");
    await settleAt(env, shared, sg.phaseEndsAt + 10 * 60000);
    sg = siegeOf(env, id);
    assert.deepStrictEqual([sg.state, sg.phaseSeq, stationOf(env, "st-own").state], ["ARMOR_TIMER", 1,
      "ARMOR_REINFORCE"], env.lines.join("\n"));
    assert.deepStrictEqual([journalOf(env, "SIEGE_TRANSITION", id), journalOf(env, "STATION_TRANSITION", "st-own")],
      [1, 1]);

    stopAll(env);
    env = await boot(reopen(), shared);
    assert.strictEqual(env.siege.getStatus().open, 1);
    assert.deepStrictEqual(env.siege.reconcile(), { ok: true, open: 1, enqueued: 0, duplicates: 1 });

    stopAll(env);
    env = await boot(reopen(), shared, { siege: { enabled: false } });
    assert.deepStrictEqual([env.started.ok, env.started.reason], [false, "disabled_by_config"]);
    await settleAt(env, shared, sg.phaseEndsAt + 1000);
    assert.strictEqual(env.tx((db) => db.prepare("SELECT state FROM world_station_sieges WHERE siege_id = ?")
      .get(id)).state, "ARMOR_TIMER", "frozen while off");
    assert.strictEqual(countOf(env, "SELECT count(*) AS n FROM world_scheduled_events WHERE idempotency_key = ? AND "
      + "state = 'QUEUED'", SS.stepKey(id, 1, 0)), 1, "parked");
    stopAll(env);
    env = await boot(reopen(), shared);
    await settleAt(env, shared, shared.clock.now() + 1000);
    assert.strictEqual(siegeOf(env, id).state, "ARMOR_ASSAULT", env.lines.join("\n"));
  }));

  needsDriver("S4 defense: owner fleet -> WAIT x maxWaitRounds then ADVANCE (waitRound 0); ENGAGED -> WAIT "
    + "attackers gone -> REPELLED, station ONLINE, timer reset, totals", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = await boot(reopen(), shared);
    const t0 = shared.clock.now();
    addStation(env, "st-own", S.N5, OWNER, t0);
    const attacker = newFleet(env, "s4a", SANSHA, S.N5);
    requestCheck(env, shared, S.N5, "s4:chk", attacker);
    await settleAt(env, shared, t0);
    let sg = siegeOfStation(env, "st-own");
    const id = sg.siegeId;
    await settleAt(env, shared, sg.phaseEndsAt);
    sg = siegeOf(env, id);
    assert.strictEqual(sg.state, "ARMOR_TIMER");

    const defender = newFleet(env, "s4d", OWNER, S.N5, "patrol");
    const recheck = DEFAULTS.siege.recheckMs;
    await settleAt(env, shared, sg.phaseEndsAt);
    assert.deepStrictEqual([siegeOf(env, id).state, siegeOf(env, id).waitRound], ["ARMOR_TIMER", 1]);
    await settleAt(env, shared, shared.clock.now() + recheck);
    assert.deepStrictEqual([siegeOf(env, id).state, siegeOf(env, id).waitRound], ["ARMOR_TIMER", 2]);
    destroyFleet(env, defender, "s4d");
    await settleAt(env, shared, shared.clock.now() + recheck);
    sg = siegeOf(env, id);
    assert.deepStrictEqual([sg.state, sg.waitRound, sg.phaseSeq], ["ARMOR_ASSAULT", 0, 2], "ADVANCE resets the wait");

    const other = newFleet(env, "s4c", CALDARI, S.N5, "patrol");
    engage(env, other, "s4c");
    await settleAt(env, shared, sg.phaseEndsAt);
    assert.deepStrictEqual([siegeOf(env, id).state, siegeOf(env, id).waitRound], ["ARMOR_ASSAULT", 1], "ENGAGED");
    destroyFleet(env, other, "s4c");
    destroyFleet(env, attacker, "s4a");
    await settleAt(env, shared, shared.clock.now() + recheck);
    sg = siegeOf(env, id);
    const st = stationOf(env, "st-own");
    assert.deepStrictEqual([sg.state, sg.endReason, sg.open, st.state, st.stateUntilAt],
      ["REPELLED", "ATTACKER_GONE", false, "ONLINE", null], env.lines.join("\n"));
    assert.deepStrictEqual([totalsOf(env, OWNER).defended, totalsOf(env, SANSHA).repelled, totalsOf(env, SANSHA).won],
      [1, 1, 0]);
    assert.strictEqual(countOf(env, "SELECT count(*) AS n FROM world_scheduled_events WHERE idempotency_key = ?",
      SS.endCheckKey(S.N5, id)), 1);
    assert.strictEqual(env.siege.getStatus().counters.waits, 3);
  }));

  needsDriver("PH1: the only attacker fleet goes IDLE -> MATERIALIZED (player hunt) -> the "
    + "siege step reads it and holds the field (ADVANCE, no REPEL ATTACKER_GONE); an enemy hunting fleet does not "
    + "contest", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = await boot(reopen(), shared);
    const t0 = shared.clock.now();
    addStation(env, "st-ph", S.N5, OWNER, t0);
    const attacker = newFleet(env, "ph1a", SANSHA, S.N5);
    requestCheck(env, shared, S.N5, "ph1:chk", attacker);
    await settleAt(env, shared, t0);
    const sg = siegeOfStation(env, "st-ph");
    assert.strictEqual(sg.state, "SHIELD_ASSAULT", env.lines.join("\n"));
    const defender = newFleet(env, "ph1d", OWNER, S.N5, "patrol");
    for (const [id, tag] of [[attacker, "ph1a"], [defender, "ph1d"]]) {
      env.tx((db) => {
        const f = env.fleets.repository.getFleet(db, id).fleet;
        const r = env.fleets.repository.transition(db, { fleetId: id, expectedVersion: f.version, from: "IDLE",
          to: "MATERIALIZED", patch: {} }, `phunt:${tag}:lock`);
        assert.ok(r.ok, JSON.stringify(r));
      });
    }
    await settleAt(env, shared, sg.phaseEndsAt);
    const after = siegeOf(env, sg.siegeId);
    assert.deepStrictEqual([after.state, after.open, after.endReason || null, after.waitRound],
      ["ARMOR_TIMER", true, null, 0], env.lines.join("\n"));
    const hold = M.holdOf([{ fleetId: "a", factionId: SANSHA, fleetRole: "invasion", state: "MATERIALIZED",
      composition: FLEET }, { fleetId: "d", factionId: OWNER, fleetRole: "patrol", state: "MATERIALIZED",
      composition: FLEET }], SANSHA, (a, b) => a !== b, GROUPS);
    assert.deepStrictEqual([hold.attackerShips, hold.attackerDps > 0, hold.contested, hold.engaged],
      [20, true, false, false]);
  }));

  needsDriver("SO5b HULL_ASSAULT while the attacker fights a LIVE battle (fleet ENGAGED) -> WAIT, not END; the "
    + "fleet released after the settlement -> END DESTROYED once (one fall, nothing on later steps)",
  () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = await boot(reopen(), shared);
    const t0 = shared.clock.now();
    addStation(env, "st-so5", S.N5, OWNER, t0);
    const attacker = newFleet(env, "so5a", SANSHA, S.N5);
    requestCheck(env, shared, S.N5, "so5:chk", attacker);
    await settleAt(env, shared, t0);
    const id = siegeOfStation(env, "st-so5").siegeId;
    await drive(env, shared, () => siegeOf(env, id).state === "HULL_ASSAULT");
    const engagedVersion = engage(env, attacker, "so5a");
    await settleAt(env, shared, siegeOf(env, id).phaseEndsAt);
    const got = { engaged: [siegeOf(env, id).state, siegeOf(env, id).waitRound, stationOf(env, "st-so5").state] };
    const released = env.tx((db) => env.fleets.repository.transition(db, { fleetId: attacker,
      expectedVersion: engagedVersion, from: "ENGAGED", to: "IDLE" }, "so5a:release"));
    assert.ok(released.ok, JSON.stringify(released));
    const recheck = DEFAULTS.siege.recheckMs;
    await settleAt(env, shared, shared.clock.now() + recheck);
    got.released = [siegeOf(env, id).state, siegeOf(env, id).open, stationOf(env, "st-so5").state,
      totalsOf(env, OWNER).lostDestroyed];
    await settleAt(env, shared, shared.clock.now() + 4 * recheck);
    got.later = [siegeOf(env, id).state, totalsOf(env, OWNER).lostDestroyed, totalsOf(env, SANSHA).won];
    assert.deepStrictEqual(got, { engaged: ["HULL_ASSAULT", 1, "HULL_REINFORCE"],
      released: ["DESTROYED", false, "DESTROYED", 1], later: ["DESTROYED", 1, 1] }, env.lines.join("\n"));
  }));

  needsDriver("S5 end variants: NPC + Amarr -> CAPTURED; NPC + no canOccupy -> SACKED; NPC over the limit -> "
    + "SACKED; ANCHORING -> DESTROYED + build FAILED; highsec -> no start; captureStation refusals write nothing",
  () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const sites = new Map([[S.N9, { controllerFactionId: OWNER, occupationState: "STABLE" }]]);
    const env = await boot(reopen(), shared, { canOccupy: [AMARR], sites,
      stations: { maxPerSystemPerFaction: 1 } });
    assert.ok(env.started.ok, JSON.stringify(env.started));
    const t0 = shared.clock.now();
    addStation(env, "st-npc1", S.N5, OWNER, t0, "npc", 60000001);
    addStation(env, "st-npc2", S.N6, OWNER, t0, "npc", 60000002);
    addStation(env, "st-npc3", S.N7, OWNER, t0, "npc", 60000003);
    addStation(env, "st-am7", S.N7, AMARR, t0);
    addStation(env, "st-hs", S.H1, OWNER, t0);
    for (const id of ["st-npc1", "st-npc2", "st-npc3"]) putStock(env, id, t0);
    const plan = env.tx((db) => env.construction.planInTx(db, { factionId: OWNER, systemId: S.N9, kitId: "mini",
      at: t0 }, "s5:plan"));
    assert.ok(plan.ok, JSON.stringify(plan));
    const anchored = env.tx((db) => env.construction.receiveInTx(db, { stationId: plan.stationId, factionId: OWNER,
      convoyId: "cv_s5", cargo: { [M34]: 3000, [M35]: 1000 }, at: t0 }));
    assert.ok(anchored.ok && anchored.anchored, JSON.stringify(anchored));
    const amarrLive = () => countOf(env, "SELECT count(*) AS n FROM world_stations WHERE owner_faction_id = ? AND "
      + "state <> 'DESTROYED'", AMARR);
    assert.strictEqual(amarrLive(), 1);

    newFleet(env, "s5a5", AMARR, S.N5);
    newFleet(env, "s5s6", SANSHA, S.N6);
    newFleet(env, "s5a7", AMARR, S.N7);
    newFleet(env, "s5s9", SANSHA, S.N9);
    newFleet(env, "s5h1", SANSHA, S.H1);
    for (const sys of [S.N5, S.N6, S.N7, S.N9, S.H1]) requestCheck(env, shared, sys, `s5:chk:${sys}`);
    await settleAt(env, shared, t0);
    assert.strictEqual(siegeOfStation(env, "st-hs"), null, "highsec: no start");
    assert.strictEqual(siegeOfStation(env, plan.stationId).state, "ANCHOR_ASSAULT");
    await drive(env, shared, () => countOf(env, "SELECT count(*) AS n FROM world_station_sieges WHERE open = 1") === 0);

    const npc1 = stationOf(env, "st-npc1");
    assert.deepStrictEqual([siegeOfStation(env, "st-npc1").state, npc1.state, npc1.ownerFactionId,
      npc1.ownerCorporationId, stockRows(env, "st-npc1"), amarrLive()],
    ["CAPTURED", "ONLINE", AMARR, CORP_OF[AMARR], 0, 2], env.lines.join("\n"));
    const npc2 = stationOf(env, "st-npc2");
    assert.deepStrictEqual([siegeOfStation(env, "st-npc2").state, npc2.state, npc2.ownerFactionId,
      stockRows(env, "st-npc2")], ["SACKED", "ONLINE", OWNER, 0]);
    assert.strictEqual(countOf(env, "SELECT count(*) AS n FROM world_station_sieges WHERE station_id = ?", "st-npc2"),
      1, "sack wait wired");
    const s3 = siegeOfStation(env, "st-npc3");
    assert.deepStrictEqual([s3.state, s3.endReason, s3.lostUnits, stationOf(env, "st-npc3").ownerFactionId,
      stockRows(env, "st-npc3")], ["SACKED", "CAPTURE_LIMIT", 5003, OWNER, 0]);
    const build = env.tx((db) => env.construction.builds.getBuild(db, plan.stationId)).build;
    assert.deepStrictEqual([siegeOfStation(env, plan.stationId).state, stationOf(env, plan.stationId).state,
      build.state], ["DESTROYED", "DESTROYED", "FAILED"]);
    const am = totalsOf(env, AMARR);
    assert.deepStrictEqual([am.won, am.gainedCaptured, totalsOf(env, OWNER).lostCaptured, totalsOf(env, OWNER).sacked,
      totalsOf(env, SANSHA).won], [2, 1, 1, 2, 2]);
    const status = env.siege.getStatus().counters;
    assert.deepStrictEqual([status.captured, status.sacked, status.destroyed, status.anchorKilled,
      status.occupationRefused], [1, 2, 1, 1, 4], JSON.stringify(status));

    const hs = stationOf(env, "st-hs");
    const r1 = env.tx((db) => env.stations.repository.transitionStation(db, { stationId: "st-hs",
      expectedVersion: hs.version, from: "ONLINE", to: "ARMOR_REINFORCE", key: "s5:hs", reason: "TEST", at: t0 }));
    assert.ok(r1.ok, JSON.stringify(r1));
    const journalBefore = countOf(env, "SELECT count(*) AS n FROM world_event_journal");
    const cap = (from, owner, key) => env.tx((db) => env.stations.repository.captureStation(db, { stationId: "st-hs",
      expectedVersion: hs.version + 1, from, ownerFactionId: owner, ownerCorporationId: CORP_OF[owner], key,
      reason: "TEST", at: t0 }));
    assert.strictEqual(cap("ARMOR_REINFORCE", OWNER, "s5:c1").reason, "SAME_OWNER");
    assert.strictEqual(cap("HULL_REINFORCE", AMARR, "s5:c2").reason, "STATE_MISMATCH");
    assert.strictEqual(countOf(env, "SELECT count(*) AS n FROM world_event_journal"), journalBefore);
    assert.deepStrictEqual([stationOf(env, "st-hs").state, stationOf(env, "st-hs").ownerFactionId],
      ["ARMOR_REINFORCE", OWNER]);
    assert.strictEqual(env.tx((db) => env.stations.repository.transitionStation(db, { stationId: "st-hs",
      expectedVersion: hs.version + 1, from: "ARMOR_REINFORCE", to: "DESTROYED", key: "s5:w", reason: "TEST", at: t0,
      wipeStock: true })).detail, "change.wipeStock");
  }));

  async function destroyBoth(reopen, wrecks, enqueueHook = null) {
    const shared = H.sharedOf();
    const sites = new Map([[S.N9, { controllerFactionId: OWNER, occupationState: "STABLE" }]]);
    const env = await boot(reopen(), shared, { sites, wrecks });
    assert.ok(env.started.ok, JSON.stringify(env.started));
    env.hook.enqueue = enqueueHook;
    const t0 = shared.clock.now();
    addStation(env, "st-up", S.N5, OWNER, t0);
    putStock(env, "st-up", t0);
    const plan = env.tx((db) => env.construction.planInTx(db, { factionId: OWNER, systemId: S.N9, kitId: "mini",
      at: t0 }, "s6:plan"));
    assert.ok(plan.ok, JSON.stringify(plan));
    const anchored = env.tx((db) => env.construction.receiveInTx(db, { stationId: plan.stationId, factionId: OWNER,
      convoyId: "cv_s6", cargo: { [M34]: 3000, [M35]: 1000 }, at: t0 }));
    assert.ok(anchored.ok && anchored.anchored, JSON.stringify(anchored));
    newFleet(env, "s6s5", SANSHA, S.N5);
    newFleet(env, "s6s9", SANSHA, S.N9);
    for (const sys of [S.N5, S.N9]) requestCheck(env, shared, sys, `s6:chk:${sys}`);
    await settleAt(env, shared, t0);
    assert.deepStrictEqual([siegeOfStation(env, "st-up").state, siegeOfStation(env, plan.stationId).state],
      ["SHIELD_ASSAULT", "ANCHOR_ASSAULT"]);
    await drive(env, shared, () => countOf(env, "SELECT count(*) AS n FROM world_station_sieges WHERE open = 1") === 0);
    const up = siegeOfStation(env, "st-up");
    const an = siegeOfStation(env, plan.stationId);
    const build = env.tx((db) => env.construction.builds.getBuild(db, plan.stationId)).build;
    assert.deepStrictEqual([up.state, stationOf(env, "st-up").state, an.state, stationOf(env, plan.stationId).state,
      build.state], ["DESTROYED", "DESTROYED", "DESTROYED", "DESTROYED", "FAILED"], env.lines.join("\n"));
    assert.strictEqual(countOf(env, "SELECT count(*) AS n FROM world_scheduled_events WHERE event_type = "
      + "'STATION_SIEGE_STEP' AND (attempts > 1 OR state <> 'DONE')"), 0, "no STEP retried or left open");
    const fields = env.tx((db) => db.prepare("SELECT field_id AS id, source, system_id AS sys, salvage_units AS s, "
      + "loot_units AS l, state, end_reason AS er FROM world_wreck_fields ORDER BY field_id").all());
    const ids = { up: `wf:st:st-up:${up.siegeNo}`, an: `wf:st:${plan.stationId}:${an.siegeNo}` };
    const status = env.siege.getStatus();
    const wrappers = countOf(env, "SELECT count(*) AS n FROM world_event_journal WHERE event_type = ?",
      SS.EVENT_SIEGE_WRECK);
    stopAll(env);
    return { fields, ids, status, wrappers, lines: env.lines.slice() };
  }

  needsDriver("S6 END -> DESTROYED with wrecks: DEFAULTS.wrecks (Upwell after HULL_ASSAULT, a build in "
    + "ANCHORING) -> station DESTROYED + structure wreck field wf:st:<id>:<siegeNo>; wrecks.enabled=false -> no field",
  async () => {
    assert.strictEqual(DEFAULTS.wrecks.enabled, true);
    await H.withStore(driver, async (reopen) => {
      const { fields, ids } = await destroyBoth(reopen, DEFAULTS.wrecks);
      const astra = D.STRUCTURE_DEFENSE.astrahus.wreck;
      assert.deepStrictEqual(fields.map((f) => [f.id, f.sys, f.s]).sort(),
        [[ids.an, S.N9, astra.salvage], [ids.up, S.N5, astra.salvage]].sort(), JSON.stringify(fields));
      const upField = fields.find((f) => f.id === ids.up);
      assert.strictEqual(upField.l, astra.loot + Math.floor(5003 * DEFAULTS.wrecks.stockLootPermille / 1000));
    });
    await H.withStore(driver, async (reopen) => {
      const { fields } = await destroyBoth(reopen, { ...DEFAULTS.wrecks, enabled: false });
      assert.deepStrictEqual(fields, []);
    });
  });

  needsDriver("S7: the second structure wreck field (maxFieldsGlobal=1) evicts the first, then its "
    + "WRECK_FIELD_EXPIRE is refused (QUEUE_FULL) -> the field savepoint rolls back: the END step commits, no new "
    + "field, the first field stays ACTIVE, counter wreckRefused = 1", async () => {
    await H.withStore(driver, async (reopen) => {
      let expires = 0;
      const refuseSecond = (a) => {
        if (a[0] !== "WRECK_FIELD_EXPIRE") return undefined;
        expires += 1;
        return expires === 2 ? { ok: false, reason: "QUEUE_FULL" } : undefined;
      };
      const { fields, status, wrappers, lines } = await destroyBoth(reopen,
        { ...DEFAULTS.wrecks, maxFieldsGlobal: 1 }, refuseSecond);
      assert.strictEqual(expires, 2);
      assert.deepStrictEqual(fields.map((f) => [f.state, f.er]), [["ACTIVE", null]], JSON.stringify(fields));
      assert.deepStrictEqual([status.counters.destroyed, status.counters.wreckRefused, wrappers], [2, 1, 1],
        JSON.stringify(status));
      assert.strictEqual(status.lastRefusal, "WRECK_QUEUE_FULL");
      assert.deepStrictEqual([status.lastWreckRefusal.reason, status.lastWreckRefusal.stage,
        status.lastWreckRefusal.error], ["QUEUE_FULL", "enqueue", null], JSON.stringify(status.lastWreckRefusal));
      assert.strictEqual(lines.filter((l) => / DESTROYED .* WARN wreck=QUEUE_FULL stage=enqueue/.test(l)).length, 1,
        lines.join("\n"));
    });
  });

  needsDriver("S8 SWEEP-20261021-siege: a JS exception (TypeError) inside the wreck field savepoint -> the END step "
    + "commits, lastRefusal = WRECK_APPLY_FAILED, lastWreckRefusal.error = the TypeError message, logged", async () => {
    await H.withStore(driver, async (reopen) => {
      const throwOnExpire = (a) => {
        if (a[0] !== "WRECK_FIELD_EXPIRE") return undefined;
        throw new TypeError("boom is not a function");
      };
      const { fields, status, lines } = await destroyBoth(reopen, DEFAULTS.wrecks, throwOnExpire);
      assert.deepStrictEqual(fields, []);
      assert.deepStrictEqual([status.counters.destroyed, status.counters.wreckRefused], [2, 2], JSON.stringify(status));
      assert.strictEqual(status.lastRefusal, "WRECK_APPLY_FAILED");
      assert.deepStrictEqual([status.lastWreckRefusal.reason, status.lastWreckRefusal.stage,
        status.lastWreckRefusal.error], ["APPLY_FAILED", "exception", "TypeError: boom is not a function"]);
      assert.strictEqual(lines.filter((l) => /WARN wreck=APPLY_FAILED stage=exception error="TypeError: boom/.test(l))
        .length, 2, lines.join("\n"));
    });
  });

  needsDriver("ND2/ND3 applyNativeDestruction: HULL_ASSAULT -> station + siege DESTROYED (NATIVE_DESTROYED) "
    + "one occupation outcome for the attacker, no wreck field, second call DUPLICATE, the planned STEP STALE; "
    + "NO_SIEGE / NOT_ASSAULT / STATION_STATE_CHANGED write nothing; NN4 STALE_DESTRUCTION writes nothing, "
    + "ANCHOR_ASSAULT -> DESTROYED + build FAILED + anchorKilled", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const occ = [];
    const occupationFake = { applyStructureOutcomeInTx: (_tx, spec, key) => {
      occ.push({ spec, key });
      return { ok: true, outcome: "TEST" };
    } };
    const sites = new Map([[S.N9, { controllerFactionId: OWNER, occupationState: "STABLE" }]]);
    const env = await boot(reopen(), shared, { occupationFake, wrecks: DEFAULTS.wrecks, sites });
    assert.ok(env.started.ok, JSON.stringify(env.started));
    const t0 = shared.clock.now();
    addStation(env, "st-a", S.N5, OWNER, t0);
    addStation(env, "st-b", S.N6, OWNER, t0);
    addStation(env, "st-c", S.N7, OWNER, t0);
    newFleet(env, "nda", SANSHA, S.N5);
    newFleet(env, "ndb", SANSHA, S.N6);
    requestCheck(env, shared, S.N5, "nd:chk:a");
    requestCheck(env, shared, S.N6, "nd:chk:b");
    await settleAt(env, shared, t0);
    const native = (stationId, destroyedAt = shared.clock.now()) => env.siege.applyNativeDestruction({ stationId,
      structureId: 1030000000001, destroyedAt, at: shared.clock.now() });
    const journalRows = () => countOf(env, "SELECT count(*) AS n FROM world_event_journal");
    const j0 = journalRows();
    assert.deepStrictEqual([native("st-c"), native("st-a")], [{ ok: true, outcome: "NO_SIEGE" },
      { ok: true, outcome: "NOT_ASSAULT" }]);
    assert.strictEqual(journalRows(), j0, "no write");
    const a = siegeOfStation(env, "st-a").siegeId;
    const b = siegeOfStation(env, "st-b").siegeId;
    await drive(env, shared, () => siegeOf(env, a).state === "HULL_ASSAULT" && siegeOf(env, b).state === "HULL_ASSAULT");
    const sb = stationOf(env, "st-b");
    const tr = env.tx((db) => env.stations.repository.transitionStation(db, { stationId: "st-b",
      expectedVersion: sb.version, from: "HULL_REINFORCE", to: "ONLINE", key: "nd:b:online", reason: "TEST",
      at: shared.clock.now(), patch: { stateUntilAt: null } }));
    assert.ok(tr.ok, JSON.stringify(tr));
    const j1 = journalRows();
    assert.deepStrictEqual(native("st-b"), { ok: true, outcome: "STATION_STATE_CHANGED" });
    assert.strictEqual(journalRows(), j1, "no write");

    const j2 = journalRows();
    assert.deepStrictEqual(native("st-a", siegeOf(env, a).phaseStartedAt - 1),
      { ok: true, outcome: "STALE_DESTRUCTION" });
    assert.strictEqual(journalRows(), j2, "no write");
    assert.deepStrictEqual([siegeOf(env, a).state, stationOf(env, "st-a").state], ["HULL_ASSAULT", "HULL_REINFORCE"]);
    assert.deepStrictEqual(native("st-a", "x").reason, "INVALID_INPUT", "destroyedAt required");

    const due = siegeOf(env, a).phaseEndsAt;
    assert.deepStrictEqual(native("st-a"), { ok: true, outcome: "DESTROYED" }, env.lines.join("\n"));
    const sg = siegeOf(env, a);
    assert.deepStrictEqual([sg.state, sg.open, sg.endReason, stationOf(env, "st-a").state],
      ["DESTROYED", false, "NATIVE_DESTROYED", "DESTROYED"]);
    assert.strictEqual(occ.length, 1);
    assert.deepStrictEqual([occ[0].spec.winnerFactionId, occ[0].spec.loserFactionId, occ[0].key],
      [SANSHA, OWNER, `${SS.nativeKey(a)}:occ`]);
    assert.deepStrictEqual([countOf(env, "SELECT count(*) AS n FROM world_wreck_fields"),
      journalOf(env, SS.EVENT_SIEGE_WRECK, a), journalOf(env, SS.EVENT_SIEGE_NATIVE, a)], [0, 0, 1], "skipWreck");
    assert.deepStrictEqual(native("st-a"), { ok: true, outcome: "DUPLICATE" });
    assert.strictEqual(occ.length, 1, "no second occupation outcome");
    const stale = env.siege.getStatus().counters.stale;
    await settleAt(env, shared, due);
    const status = env.siege.getStatus();
    assert.ok(status.counters.stale > stale, JSON.stringify(status.counters));
    assert.deepStrictEqual([siegeOf(env, a).endReason, status.counters.destroyed, status.counters.nativeEnded,
      occ.length], ["NATIVE_DESTROYED", 1, 1, 1]);

    const t1 = shared.clock.now();
    const plan = env.tx((db) => env.construction.planInTx(db, { factionId: OWNER, systemId: S.N9, kitId: "mini",
      at: t1 }, "nn4:plan"));
    assert.ok(plan.ok, JSON.stringify(plan));
    const anchored = env.tx((db) => env.construction.receiveInTx(db, { stationId: plan.stationId, factionId: OWNER,
      convoyId: "cv_nn4", cargo: { [M34]: 3000, [M35]: 1000 }, at: t1 }));
    assert.ok(anchored.ok && anchored.anchored, JSON.stringify(anchored));
    newFleet(env, "nn4s9", SANSHA, S.N9);
    requestCheck(env, shared, S.N9, "nn4:chk:n9");
    await settleAt(env, shared, t1);
    const n = siegeOfStation(env, plan.stationId);
    assert.strictEqual(n.state, "ANCHOR_ASSAULT", env.lines.join("\n"));
    const anchorKilled = env.siege.getStatus().counters.anchorKilled;
    assert.deepStrictEqual(native(plan.stationId), { ok: true, outcome: "DESTROYED" }, env.lines.join("\n"));
    const ns = siegeOf(env, n.siegeId);
    const build = env.tx((db) => env.construction.builds.getBuild(db, plan.stationId)).build;
    assert.deepStrictEqual([ns.state, ns.endReason, stationOf(env, plan.stationId).state, build.state,
      env.siege.getStatus().counters.anchorKilled - anchorKilled],
    ["DESTROYED", "NATIVE_DESTROYED", "DESTROYED", "FAILED", 1]);
    assert.deepStrictEqual([occ.length, occ[1].key], [2, `${SS.nativeKey(n.siegeId)}:occ`]);
  }));

  test("NN3 decideNative: OWNER_CHANGED, NOT_ASSAULT, STATION_STATE_CHANGED "
    + "CORE_PROTECTED, STALE_DESTRUCTION, window boundary, ANCHOR_ASSAULT", () => {
    const sg = (state) => ({ state, ownerFactionId: OWNER, phaseStartedAt: 5000 });
    const st = (state, owner = OWNER) => ({ state, ownerFactionId: owner });
    const f = (destroyedAt, coreProtected = false) => ({ destroyedAt, coreProtected });
    const got = [
      M.decideNative(sg("HULL_ASSAULT"), st("HULL_REINFORCE", AMARR), f(6000)),
      M.decideNative(sg("SHIELD_ASSAULT"), st("ONLINE"), f(6000)),
      M.decideNative(sg("HULL_ASSAULT"), st("ONLINE"), f(6000)),
      M.decideNative(sg("HULL_ASSAULT"), st("HULL_REINFORCE"), f(6000, true)),
      M.decideNative(sg("HULL_ASSAULT"), st("HULL_REINFORCE"), f(4999)),
      M.decideNative(sg("HULL_ASSAULT"), st("HULL_REINFORCE"), f(5000)),
      M.decideNative(sg("ANCHOR_ASSAULT"), st("ANCHORING"), f(5000)),
    ];
    assert.deepStrictEqual(got, ["OWNER_CHANGED", "NOT_ASSAULT", "STATION_STATE_CHANGED", "CORE_PROTECTED",
      "STALE_DESTRUCTION", null, null]);
  });

  test("K3 core station: planStart skips core base station, only non-core targeted; decideStep REPEL on coreProtected", () => {
    const owner = OWNER;
    const attacker = SANSHA;
    const system = { systemId: 1, secClass: "nullsec" };
    const baseStation = { stationId: "core-base", kind: "npc", state: "ONLINE", ownerFactionId: owner };
    const otherStation = { stationId: "other", kind: "npc", state: "ONLINE", ownerFactionId: owner };
    const fleets = [{ fleetId: "f1", factionId: attacker, state: "IDLE", fleetRole: "invasion", composition: FLEET }];
    const P = { timerScale: 0.25, assaultMinMs: 900000, assaultMaxMs: 21600000 };
    const params = { ...P, allowHighsec: false, maxOpenSieges: 64, maxOpenSiegesPerFaction: 4, sackCooldownMs: 100 };
    const groups = GROUPS;
    const isHostile = (a, b) => a !== b;
    const isActive = () => true;

    const coreIndex = { enabled: true, stations: new Map([["core-base", owner]]) };
    const isCoreStation = (id) => coreIndex.enabled && coreIndex.stations.has(id);

    const plan1 = M.planStart({ system, stations: [baseStation, otherStation], fleets, openSieges: [],
      openTotal: 0, openByAttacker: new Map(), triggerFleetId: null, at: 0, isHostile, isActive, groups, params,
      lastSieges: new Map(), isCoreStation });
    assert.strictEqual(plan1.start.stationId, "other", "non-core station chosen when core base present");

    const plan2 = M.planStart({ system, stations: [baseStation], fleets, openSieges: [],
      openTotal: 0, openByAttacker: new Map(), triggerFleetId: null, at: 0, isHostile, isActive, groups, params,
      lastSieges: new Map(), isCoreStation });
    assert.strictEqual(plan2.reason, "CORE_PROTECTED", "core base only -> CORE_PROTECTED");

    const siegeRow = { open: true, phaseSeq: 1, waitRound: 0, state: "SHIELD_ASSAULT", ownerFactionId: owner,
      plan: M.buildPlan({ kind: "npc", structureFamily: null }, "nullsec", P).plan };
    const stationRow = { kind: "npc", state: "ONLINE", ownerFactionId: owner, version: 1 };
    const hold = { attackerShips: 20, attackerDps: 3466, engaged: false, contested: false };
    const facts = { at: 1000, phaseSeq: 1, round: 0, maxWaitRounds: 2, canCapture: false, captureUpwell: false, coreProtected: true };
    const d = M.decideStep(siegeRow, stationRow, hold, facts);
    assert.deepStrictEqual(d, { action: "REPEL", reason: "CORE_PROTECTED", stationTo: null });
  });

  const repelBase = () => {
    const fleets = [{ fleetId: "fa", factionId: SANSHA, state: "IDLE", fleetRole: "invasion", composition: FLEET }];
    const params = { timerScale: 0.25, assaultMinMs: 900000, assaultMaxMs: 21600000, allowHighsec: false,
      maxOpenSieges: 64, maxOpenSiegesPerFaction: 4, sackCooldownMs: 100 };
    return { system: { systemId: 1, secClass: "nullsec" },
      stations: [{ stationId: "st", kind: "npc", state: "ONLINE", ownerFactionId: OWNER }], fleets, openSieges: [],
      openTotal: 0, openByAttacker: new Map(), triggerFleetId: null, at: 10 * HOUR, isHostile: (a, b) => a !== b,
      isActive: () => true, groups: GROUPS, params, lastSieges: new Map() };
  };
  const pairMap = (state, endedAt) => new Map([["st", new Map([[SANSHA, { state, endedAt,
    attackerFactionId: SANSHA }]])]]);

  test("SRC1 planStart: a REPELLED pair waits repelCooldownMs, another attacker may besiege, the wait ends", () => {
    const b = repelBase();
    const on = { ...b, params: { ...b.params, repelCooldownMs: 86400000 }, lastByPair: pairMap("REPELLED", b.at - HOUR) };
    assert.deepStrictEqual(M.planStart(on), { start: null, reason: "REPEL_COOLDOWN" });
    const withAmarr = M.planStart({ ...on, fleets: [{ ...b.fleets[0], factionId: AMARR, fleetId: "fb" }] });
    assert.deepStrictEqual([withAmarr.start && withAmarr.start.attackerFactionId], [AMARR], JSON.stringify(withAmarr));
    const later = M.planStart({ ...on, at: b.at - HOUR + 86400000 });
    assert.deepStrictEqual([later.start && later.start.attackerFactionId, later.start && later.start.stationId],
      [SANSHA, "st"], JSON.stringify(later));
  });

  test("SRC2 planStart off: key 0 / no lastByPair = the result of before (bit for bit); ABORTED never waits", () => {
    const b = repelBase();
    const before = M.planStart(b);
    assert.ok(before.start, JSON.stringify(before));
    assert.deepStrictEqual(M.planStart({ ...b, params: { ...b.params, repelCooldownMs: 0 },
      lastByPair: pairMap("REPELLED", b.at - HOUR) }), before);
    assert.deepStrictEqual(M.planStart({ ...b, params: { ...b.params, repelCooldownMs: 86400000 } }), before);
    assert.deepStrictEqual(M.planStart({ ...b, params: { ...b.params, repelCooldownMs: 86400000 },
      lastByPair: pairMap("ABORTED", b.at - HOUR) }), before);
  });

  needsDriver("SRC3 service + repository: the last row of the station by another attacker - the pair row "
    + "of the attacker still waits (REPEL_COOLDOWN, counter repelCooldown)", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = await boot(reopen(), shared, { siege: { repelCooldownMs: 86400000 } });
    assert.ok(env.started.ok, JSON.stringify(env.started));
    const t0 = shared.clock.now();
    addStation(env, "st-rp", S.N5, OWNER, t0, "npc", 60000001);
    const plan = M.buildPlan({ kind: "npc" }, "nullsec", { timerScale: 0.25, assaultMinMs: 900000,
      assaultMaxMs: 21600000 }).plan;
    const repelled = (no, attacker) => env.tx((db) => {
      const c = env.siege.repository.createSiege(db, { stationId: "st-rp", siegeNo: no, systemId: S.N5,
        ownerFactionId: OWNER, attackerFactionId: attacker, state: "SHIELD_ASSAULT", phaseEndsAt: t0, plan,
        attackerShips: 20, attackerStrength: 1, at: t0 }, SS.startKey("st-rp", no));
      assert.ok(c.ok, JSON.stringify(c));
      db.prepare("UPDATE world_station_sieges SET state = 'REPELLED', open = 0, ended_at = ?, "
        + "end_reason = 'CONTESTED_TIMEOUT' WHERE siege_id = ?").run(t0, c.siegeId);
    });
    repelled(1, SANSHA);
    repelled(2, AMARR);
    const last = env.tx((db) => env.siege.repository.getLastByStation(db, "st-rp")).siege;
    const pair = env.tx((db) => env.siege.repository.getLastByStationAttacker(db, "st-rp", SANSHA)).siege;
    assert.deepStrictEqual([last.attackerFactionId, pair.attackerFactionId, pair.siegeNo, pair.state],
      [AMARR, SANSHA, 1, "REPELLED"]);
    newFleet(env, "src3", SANSHA, S.N5);
    requestCheck(env, shared, S.N5, "src3:chk");
    await settleAt(env, shared, t0);
    const counters = env.siege.getStatus().counters;
    assert.deepStrictEqual([counters.repelCooldown, counters.started,
      countOf(env, "SELECT count(*) AS n FROM world_station_sieges WHERE station_id = ?", "st-rp")], [1, 0, 2],
    JSON.stringify(counters));
    env.siege.stop("test");
  }));

  needsDriver("K3b core station service: onCheck skips enemy core base, onStep REPELs with coreProtected counter", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const enemyCoreStationId = "npc-60014284";
      const coreIndex = { enabled: true, stations: new Map([[enemyCoreStationId, SANSHA]]) };
      const env = await boot(reopen(), shared, { occupation: true, coreIndex });
      assert.ok(env.started.ok, JSON.stringify(env.started));
      const t0 = shared.clock.now();

      addStation(env, enemyCoreStationId, S.N5, SANSHA, t0, "upwell");
      const seeded = env.tx((db) => env.repo.applyChange(db, { systemId: S.N5, expectedVersion: 0, reason: "SEED_CONTROL",
        state: { securityClass: "nullsec", controllerFactionId: SANSHA },
        influence: [{ factionId: SANSHA, influenceScore: 60 }] }, `world:seed:v1:${S.N5}`));
      assert.ok(seeded.ok, JSON.stringify(seeded));

      const fleet = newFleet(env, "k3f-a", AMARR, S.N5);
      requestCheck(env, shared, S.N5, "k3a:chk", fleet);
      await settleAt(env, shared, t0);

      assert.strictEqual(siegeOfStation(env, enemyCoreStationId), null, "no siege on enemy core base");
      const s1 = env.siege.getStatus();
      assert.strictEqual(s1.counters.coreProtected, 1, "coreProtected incremented on check (a)");

      const P = { timerScale: 0.25, assaultMinMs: 900000, assaultMaxMs: 21600000 };
      const plan = M.buildPlan({ kind: "upwell", structureFamily: "astrahus" }, "nullsec", P).plan;
      const siegeId = env.tx((db) => env.siege.repository.createSiege(db, {
        stationId: enemyCoreStationId, siegeNo: 1, systemId: S.N5, ownerFactionId: SANSHA, attackerFactionId: AMARR,
        state: "SHIELD_ASSAULT", phaseEndsAt: t0, plan, attackerShips: 20, attackerStrength: 1, at: t0
      }, SS.startKey(enemyCoreStationId, 1))).siegeId;
      assert.ok(siegeId, "siege created on core station");

      const dueAt = t0 + 1000;
      env.scheduler.enqueue(SS.STEP_EVENT_TYPE, siegeId, dueAt,
        { siegeId, phaseSeq: 0, round: 0 },
        SS.stepKey(siegeId, 0, 0));

      await settleAt(env, shared, dueAt);

      const sg = siegeOf(env, siegeId);
      assert.deepStrictEqual([sg.state, sg.endReason, sg.open], ["REPELLED", "CORE_PROTECTED", false], "siege REPELLED CORE_PROTECTED");
      const s2 = env.siege.getStatus();
      assert.ok(s2.counters.coreProtected >= 1, "coreProtected >= 1 (check + step + end check)");
      assert.strictEqual(s2.counters.repelled, 1, "repelled counter incremented");

      env.siege.stop("test");
    }));

  needsDriver("SV1 startSiege with views registers panel sieges + layer-sieges in the map layers", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const views = createViewRegistry();
      const observer = { ...DEFAULTS.observer, galaxyEnabled: true, galaxySiegesEnabled: true };
      const nameReads = { n: 0 };
      const adapter = { readFactionNames: () => {
        nameReads.n += 1;
        return { ok: true, names: new Map([[500001, "Caldari State"]]) };
      } };
      const env = await boot(reopen(), shared, { views, observer, adapter });
      assert.ok(env.started.ok, JSON.stringify(env.started));
      assert.strictEqual(nameReads.n, 1, "readFactionNames of the adapter read for the panel");
      assert.ok(views.getView("sieges"), "panel sieges registered");
      assert.ok(views.getView("layer-sieges"), "layer layer-sieges registered");
      assert.ok(views.listMapLayers().some((l) => l.id === "layer-sieges"), JSON.stringify(views.listMapLayers()));
      env.siege.stop("test");
      assert.strictEqual(views.getView("sieges"), null, "panel freed on stop");
      assert.strictEqual(views.getView("layer-sieges"), null, "layer freed on stop");
    }));
};

Object.assign(module.exports, { harness: Object.freeze({ boot, stopAll, addStation, newFleet, siegeOfStation, siegeOf,
  countOf, settleAt, drive, nextStepDue, requestCheck, registryOf, testConfig, DEFAULTS, SANSHA, OWNER, FLEET,
  HOUR }) });