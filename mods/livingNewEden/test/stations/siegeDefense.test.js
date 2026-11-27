"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { startScheduler } = require("../../lib/scheduler");
const { startFleets } = require("../../lib/fleets");
const { refitKey, refitSeekKey } = require("../../lib/fleets/travelService");
const { startStations } = require("../../lib/stations");
const { startSiege, createUnavailableSiege } = require("../../lib/stations/siege");
const SS = require("../../lib/stations/siege/schema");
const { createContactService } = require("../../lib/battle/contactService");
const { createBattleRepository } = require("../../lib/battle/battleRepository");
const { createSettlement } = require("../../lib/battle/settlement");
const { lazySiegeConsequence } = require("../../lib/battle");
const { createViewRegistry } = require("../../lib/observer/views");
const { harness: H } = require("../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir() } }).config;
const { S, FACTION_A: SANSHA, FACTION_B: OWNER } = H;
const CORP_OF = Object.freeze({ [SANSHA]: 1000161, [OWNER]: 1000162 });
const KNOWN = Object.freeze([SANSHA, OWNER]);
const FLEET = Object.freeze([{ hullGroup: "battleship", count: 20 }]);
const SMALL = Object.freeze([{ hullGroup: "frigate", count: 2 }]);
const BATTLE_LIMITS = Object.freeze({ maxFleetsPerSide: 8, maxCompositionEntries: 32, maxShipsPerFleet: 500,
  maxResolutionMs: 50, maxInputBytes: 65536, maxResultBytes: 65536, maxListLimit: 500, maxSettlementRows: 450 });
const SETTLE_LIMITS = Object.freeze({ maxResultBytes: 65536, maxSettlementRows: 450, retreatSearchMaxJumps: 5,
  retreatSearchMaxSystems: 200, retreatMaxCandidates: 3 });

function contactSpec(opts = {}) {
  const created = [];
  const fleets = [{ fleetId: "fa", factionId: SANSHA, state: "STAGED", shipCount: 5, operationId: null, version: 1,
    composition: SMALL }, { fleetId: "fb", factionId: OWNER, state: "IDLE", shipCount: 5, operationId: null, version: 1,
    composition: SMALL }];
  const stations = opts.stations;
  const svc = createContactService({
    store: { transaction: (name, fn) => ({ ok: true, value: fn({ inTransaction: true }) }) },
    scheduler: { enqueue: () => ({ ok: true }) },
    battleRepository: { createBattle: (tx, spec) => {
      created.push(spec);
      return { ok: true, battleId: "b1", duplicate: false };
    } },
    cooldownRepository: { listForSystem: () => ({ ok: true, cooldowns: new Map() }) },
    fleetRepository: { listFleetsInSystem: () => ({ ok: true, fleets, nextAfterFleetId: null }) },
    getGraph: () => ({ getSystem: (id) => ({ systemId: id, secClass: "nullsec" }) }),
    worldRepository: { getSystem: () => ({ ok: true, system: { influence: [{ factionId: OWNER,
      garrisonStrength: opts.influence || 0 }] } }) },
    resolverVersion: "internal-v1",
    settings: { engageDelayMs: 1000, recontactCooldownMs: 1, contactScanMaxFleets: 64, maxResolutionMs: 20,
      stationGarrisonEnabled: opts.off !== true, structureLiveCombatEnabled: opts.slc === true },
    getStations: stations === undefined ? undefined : () => ({ getMode: () => opts.mode || "ready",
      repository: { listStationsInSystem: () => ({ ok: true, records: stations }) } }),
    getSiege: opts.sieges === undefined ? undefined : () => ({ repository: { getOpenByStation: (tx, stationId) =>
      ({ ok: true, siege: opts.sieges[stationId] || null }) } }),
    limits: { maxFleetsPerSide: 8, maxSettlementRows: 450 }, isHostile: () => true, bump: () => {},
    logger: { log() {} }, isActive: () => true });
  const r = svc.onContactCheck({ payload: { systemId: S.N5, at: 0, triggerFleetId: "fa" } });
  assert.strictEqual(r.outcome, "BATTLE", JSON.stringify(r));
  assert.ok(r.effect({ inTransaction: true }, { idempotencyKey: "contact:k" }).ok);
  return created[0];
}

const station = (owner, state, kind = "upwell") => ({ stationId: `st-${owner}-${state}`, kind, state,
  structureFamily: kind === "npc" ? null : "astrahus", ownerFactionId: owner });

function registryOf() {
  return Object.freeze({
    getFaction: (id) => (KNOWN.includes(Number(id)) ? { factionId: Number(id), startStations: [],
      ownerCorporationId: CORP_OF[Number(id)], doctrineId: `d${id}`, allies: [] } : null),
    listFactions: () => KNOWN.map((factionId) => ({ factionId })),
    listActiveFactions: () => [],
    isActive: (id) => KNOWN.includes(Number(id)),
    corporationFor: (id) => (KNOWN.includes(Number(id)) ? CORP_OF[Number(id)] : null),
    getDoctrine: (d) => ({ doctrineId: d, canOccupy: false }),
  });
}

async function boot(opened, shared) {
  const cfg = { ...H.CONFIG, modules: { ...H.CONFIG.modules, strategy: { enabled: true } },
    stations: DEFAULTS.stations, siege: DEFAULTS.siege, world: DEFAULTS.world,
    persistence: { ...H.CONFIG.persistence, maxRowsPerTransaction: 500 } };
  const registry = registryOf();
  const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
  const store = opened.store;
  const sr = startScheduler({ config: cfg, persistence: { ok: true, store }, clock: shared.clock, ids: shared.ids,
    nowMs: () => 0 });
  assert.ok(sr.ok, JSON.stringify(sr));
  const holder = { stations: null, siege: null, siegeStations: null };
  const persistence = { ok: true, store, journal, worldSeed: opened.worldSeed };
  const graph = { getGraph: () => ({ ok: true, graph: shared.graph }),
    whenReady: () => Promise.resolve({ ok: true, graph: shared.graph }) };
  const fr = startFleets({ config: cfg, persistence, clock: shared.clock, ids: shared.ids, scheduler: sr.scheduler,
    graph, presence: null, views: createViewRegistry(), getStations: () => holder.stations });
  assert.ok(fr.ok, JSON.stringify(fr));
  const st = startStations({ config: cfg, persistence, strategy: { registry }, graph, clock: shared.clock });
  assert.ok(st.ok, JSON.stringify(st));
  holder.stations = st.stations;
  await st.stations.whenReady();
  const sg = startSiege({ config: cfg, persistence, clock: shared.clock, ids: shared.ids, scheduler: sr.scheduler,
    fleets: fr.fleets, strategy: { registry }, graph, getStations: () => holder.siegeStations || holder.stations,
    getOccupation: () => null, getConstruction: () => null });
  assert.ok(sg.ok, JSON.stringify(sg));
  holder.siege = sg.siege;
  const battles = createBattleRepository({ journal, fleetRepository: fr.fleets.repository, clock: shared.clock,
    ids: shared.ids, worldSeed: opened.worldSeed, limits: BATTLE_LIMITS });
  const settlement = createSettlement({ journal, battleRepository: battles, fleetRepository: fr.fleets.repository,
    travel: fr.fleets.travel, getGraph: () => shared.graph, worldRepository: { getSystems: (tx, ids) => ({ ok: true,
      systems: [], missing: ids }) }, limits: SETTLE_LIMITS,
    consequences: [lazySiegeConsequence(() => holder.siege)] });
  const tx = (fn) => {
    const r = store.transaction("test", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  return { store, scheduler: sr.scheduler, fleets: fr.fleets, stations: st.stations, battles, settlement, holder,
    tx, now: () => shared.clock.now() };
}

function addAstrahus(env, id, systemId, owner) {
  const r = env.tx((db) => env.stations.repository.createStation(db, { stationId: id, kind: "upwell", typeId: 35832,
    structureFamily: "astrahus", systemId, ownerFactionId: owner, ownerCorporationId: CORP_OF[owner], origin: "built",
    at: env.now() }, `test:station:${id}`));
  assert.ok(r.ok, JSON.stringify(r));
}

function newFleet(env, tag, factionId, systemId, composition = FLEET, role = "invasion") {
  const r = env.fleets.createFleet({ factionId, currentSystemId: systemId, homeSystemId: systemId, fleetRole: role,
    composition }, `${tag}:create`);
  assert.ok(r.ok, JSON.stringify(r));
  return r.fleetId;
}

const fleetOf = (env, id) => env.tx((db) => env.fleets.repository.getFleet(db, id)).fleet;
const countOf = (env, sql, ...args) => env.tx((db) => db.prepare(sql).get(...args)).n;
const eventOf = (env, key) => env.tx((db) => db.prepare("SELECT state, outcome FROM world_scheduled_events WHERE "
  + "idempotency_key = ?").get(key));

async function settleAt(env, shared, at) {
  shared.clock.set(Math.max(shared.clock.now(), at));
  for (let i = 0; i < 16; i += 1) {
    const p = await env.scheduler.runPass();
    assert.ok(p.ok, JSON.stringify(p));
    if (p.jobs === 0) return;
  }
  throw new Error("queue did not settle");
}

module.exports = ({ test, skip }) => {
  test("D1 station garrison in the contact (pure): ONLINE B adds its points to the influence garrison "
    + "ARMOR_REINFORCE adds nothing, A only -> side A; no station / no service / off -> the battle spec", () => {
    const base = contactSpec({ influence: 30 });
    assert.deepStrictEqual(base.garrison, { side: "B", factionId: OWNER, strength: 30 });
    for (const o of [{ stations: [] }, { stations: [station(OWNER, "ONLINE")], mode: "pending" },
      { stations: [station(OWNER, "ONLINE")], off: true }, { stations: [station(OWNER, "ARMOR_REINFORCE")] }]) {
      assert.deepStrictEqual(contactSpec({ influence: 30, ...o }), base, JSON.stringify(o));
    }
    assert.deepStrictEqual(contactSpec({ influence: 30, stations: [station(OWNER, "ONLINE", "npc"),
      station(OWNER, "ONLINE")] }).garrison, { side: "B", factionId: OWNER, strength: 30 + 80 + 40 });
    assert.deepStrictEqual(contactSpec({ stations: [station(SANSHA, "ONLINE")] }).garrison,
      { side: "A", factionId: SANSHA, strength: 40 });
    assert.strictEqual(contactSpec({ stations: [station(SANSHA, "HULL_REINFORCE")] }).garrison, null);
    assert.deepStrictEqual(contactSpec({ stations: [station(SANSHA, "ONLINE"), station(OWNER, "ONLINE")] }).garrison,
      { side: "B", factionId: OWNER, strength: 40 }, "B first (the defender of the system)");
  });

  test("SO5a producer (pure): a contact at a mod station in HULL_ASSAULT (owner B, attacker A), flag on -> "
    + "structureId / structureTypeId / structureSide B; flag off, HULL_TIMER, another attacker, a garrison -> the "
    + "spec (and input) of before; two stations -> the smallest stationId", () => {
    const AMARR_ID = 500003;
    const upwell = (id, evejsItemId) => ({ stationId: id, kind: "upwell", state: "HULL_REINFORCE", typeId: 35832,
      structureFamily: "astrahus", ownerFactionId: OWNER, evejsItemId });
    const open = (state, attacker = SANSHA) => ({ state, ownerFactionId: OWNER, attackerFactionId: attacker });
    const stations = [upwell("st-b", 1030000000002), upwell("st-a", 1030000000001)];
    const sieges = { "st-a": open("HULL_ASSAULT"), "st-b": open("HULL_ASSAULT") };
    const base = contactSpec({ stations });
    const marked = contactSpec({ stations, sieges, slc: true });
    assert.strictEqual(marked.sideB.factionId, OWNER);
    const out = [[marked.structureId, marked.structureTypeId, marked.structureSide]];
    const { structureId: _i, structureTypeId: _t, structureSide: _s, ...rest } = marked;
    out.push(JSON.stringify(rest) === JSON.stringify(base));
    for (const o of [{ stations, sieges, slc: false }, { stations, slc: true, sieges: { "st-a": open("HULL_TIMER"),
      "st-b": open("ARMOR_ASSAULT") } }, { stations, slc: true, sieges: { "st-a": open("HULL_ASSAULT", AMARR_ID) } },
    { stations: [{ ...stations[1], evejsItemId: null }], sieges, slc: true }]) {
      out.push(JSON.stringify(contactSpec(o)) === JSON.stringify(base));
    }
    const garrisoned = contactSpec({ stations, sieges, slc: true, influence: 30 });
    out.push([garrisoned.structureId, garrisoned.garrison.side]);
    assert.deepStrictEqual(out, [[1030000000001, 35832, "B"], true, true, true, true, true, [undefined, "B"]]);
  });

  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("D2 consequence siege: attacker wins and stays next to a hostile Astrahus -> one CHECK "
    + "`${ck}:check` -> SHIELD_ASSAULT; duplicate settle adds nothing; stub -> SIEGE_OFF, settlement completes; "
    + "readForFaction; the reserve formula", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = await boot(reopen(), shared);
    addAstrahus(env, "st-own", S.N5, OWNER);
    const attacker = newFleet(env, "d2a", SANSHA, S.N5);
    const defender = newFleet(env, "d2d", OWNER, S.N5, SMALL, "patrol");
    const battle = H.battleOfFleets(env, "d2", [attacker], [defender]);
    const result = H.resultFor(battle.input, "A_WIN", { [defender]: (e) => ({ d: e.count, e: 0 }) });
    const settled = H.settleIn(env, env.settlement, battle, result);
    assert.deepStrictEqual([settled.ok, settled.outcome, settled.consequences], [true, "COMPLETED",
      { applied: ["siege"], refused: [] }], JSON.stringify(settled));
    const checks = () => env.tx((db) => db.prepare("SELECT idempotency_key AS k FROM world_scheduled_events WHERE "
      + "event_type = ?").all(SS.CHECK_EVENT_TYPE)).map((r) => r.k);
    assert.deepStrictEqual(checks(), [`battle:${battle.battleId}:settle:v1:c:siege:check`]);
    const again = H.settleIn(env, env.settlement, battle, result);
    assert.ok(again.ok && again.duplicate, JSON.stringify(again));
    assert.strictEqual(checks().length, 1);
    await settleAt(env, shared, env.now());
    const sieges = env.tx((db) => db.prepare("SELECT state, attacker_faction_id AS a FROM world_station_sieges").all());
    assert.deepStrictEqual(sieges.map((x) => [x.state, x.a]), [["SHIELD_ASSAULT", SANSHA]]);
    assert.strictEqual(env.holder.siege.getStatus().counters.checkAfterBattle, 1);
    const rf = env.tx((db) => env.holder.siege.readForFaction(db, OWNER, {}));
    assert.deepStrictEqual([rf.ok, rf.attacking, rf.defending.map((x) => [x.stationId, x.attackerFactionId, x.state]),
      rf.truncated], [true, [], [["st-own", SANSHA, "SHIELD_ASSAULT"]], false]);
    assert.deepStrictEqual(env.tx((db) => env.holder.siege.readForFaction(db, SANSHA, {})).attacking
      .map((x) => [x.systemId, x.stationId]), [[S.N5, "st-own"]]);

    env.holder.siege = createUnavailableSiege("test");
    const a2 = newFleet(env, "d2a2", SANSHA, S.N5);
    const d2 = newFleet(env, "d2d2", OWNER, S.N5, SMALL, "patrol");
    const b2 = H.battleOfFleets(env, "d2b", [a2], [d2]);
    const s2 = H.settleIn(env, env.settlement, b2, H.resultFor(b2.input, "A_WIN", { [d2]: (e) => ({ d: e.count,
      e: 0 }) }));
    assert.deepStrictEqual([s2.ok, s2.outcome, s2.consequences.applied], [true, "COMPLETED", ["siege"]]);
    assert.strictEqual(checks().length, 1, "no check while off");

    const warn = (env2) => config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_BATTLE_SETTLE_ROWS_RESERVE: "38",
      EVEJS_LNE_TREASURY_LOSSES_ENABLED: "0", EVEJS_LNE_STRATEGY_RECON_LOSS_ENABLED: "0", ...env2 } }).warnings;
    assert.ok(warn({}).some((w) => w.startsWith("battle.settleRowsReserve=38 below 39") && w.includes("siege 2")),
      warn({}).join("\n"));
    assert.deepStrictEqual(warn({ EVEJS_LNE_SIEGE_ENABLED: "0" }), []);
  }));

  needsDriver("Consequence siege in mode pending: one CHECK `${ck}:check`, duplicate settle adds "
    + "nothing, the check retries STATIONS_NOT_READY and starts the siege when ready; mode off / stopped -> SIEGE_OFF "
    + "+ consequenceSkipped, no check", () => H.withStore(driver, async (reopen) => {
    assert.ok(H.CONFIG.scheduler.maxAttempts > 1, "the check needs a retry");
    const shared = H.sharedOf();
    const env = await boot(reopen(), shared);
    addAstrahus(env, "st-own", S.N5, OWNER);
    const checks = () => env.tx((db) => db.prepare("SELECT idempotency_key AS k, state, attempts, due_at AS dueAt "
      + "FROM world_scheduled_events WHERE event_type = ? ORDER BY idempotency_key").all(SS.CHECK_EVENT_TYPE));
    const won = (tag) => {
      const a = newFleet(env, `${tag}a`, SANSHA, S.N5);
      const d = newFleet(env, `${tag}d`, OWNER, S.N5, SMALL, "patrol");
      const battle = H.battleOfFleets(env, tag, [a], [d]);
      return { battle, result: H.resultFor(battle.input, "A_WIN", { [d]: (e) => ({ d: e.count, e: 0 }) }) };
    };

    env.holder.siegeStations = { getMode: () => "pending" };
    assert.strictEqual(env.holder.siege.getMode(), "pending");
    const w = won("n1");
    const settled = H.settleIn(env, env.settlement, w.battle, w.result);
    assert.deepStrictEqual([settled.ok, settled.outcome, settled.consequences], [true, "COMPLETED",
      { applied: ["siege"], refused: [] }], JSON.stringify(settled));
    const key = `battle:${w.battle.battleId}:settle:v1:c:siege:check`;
    assert.deepStrictEqual(checks().map((r) => r.k), [key]);
    const again = H.settleIn(env, env.settlement, w.battle, w.result);
    assert.ok(again.ok && again.duplicate, JSON.stringify(again));
    assert.strictEqual(checks().length, 1, "duplicate settle adds nothing");

    await settleAt(env, shared, env.now());
    const retried = checks()[0];
    assert.deepStrictEqual([retried.state, retried.attempts], ["RETRY", 1], JSON.stringify(retried));
    assert.strictEqual(env.tx((db) => db.prepare("SELECT last_error AS e FROM world_scheduled_events WHERE "
      + "idempotency_key = ?").get(key)).e, "STATIONS_NOT_READY");
    assert.strictEqual(countOf(env, "SELECT count(*) AS n FROM world_station_sieges"), 0);

    env.holder.siegeStations = null;
    await settleAt(env, shared, retried.dueAt);
    const sieges = env.tx((db) => db.prepare("SELECT state, attacker_faction_id AS a FROM world_station_sieges").all());
    assert.deepStrictEqual(sieges.map((x) => [x.state, x.a]), [["SHIELD_ASSAULT", SANSHA]]);
    assert.strictEqual(eventOf(env, key).state, "DONE");
    const st = env.holder.siege.getStatus().counters;
    assert.deepStrictEqual([st.checkAfterBattle, st.consequenceSkipped], [1, 0]);

    env.holder.siegeStations = { getMode: () => "off" };
    const w2 = won("n2");
    const s2 = H.settleIn(env, env.settlement, w2.battle, w2.result);
    assert.deepStrictEqual([s2.ok, s2.outcome, s2.consequences.applied], [true, "COMPLETED", ["siege"]]);
    assert.strictEqual(checks().length, 1, "no check while off");
    assert.strictEqual(env.holder.siege.getStatus().counters.consequenceSkipped, 1);

    env.holder.siegeStations = null;
    env.holder.siege.stop();
    const w3 = won("n3");
    const s3 = H.settleIn(env, env.settlement, w3.battle, w3.result);
    assert.deepStrictEqual([s3.ok, s3.outcome, s3.consequences.applied], [true, "COMPLETED", ["siege"]]);
    assert.strictEqual(checks().length, 1, "no check while stopped");
    assert.strictEqual(env.holder.siege.getStatus().counters.consequenceSkipped, 2);
  }));

  needsDriver("D3 repair at a lost station: REFITTING + refit_pending, own Astrahus -> ARMOR_REINFORCE -> "
    + "IDLE + refit_pending + legSeq + 1 + FLEET_REFIT_SEEK, old FLEET_REFIT_COMPLETE STALE; no refit_pending -> "
    + "normal IDLE", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = await boot(reopen(), shared);
    addAstrahus(env, "st-own", S.N5, OWNER);
    const t0 = env.now();
    const engaged = (tag) => {
      const id = newFleet(env, tag, OWNER, S.N5, SMALL, "patrol");
      env.tx((db) => {
        const e = env.fleets.repository.transition(db, { fleetId: id, expectedVersion: 1, from: "IDLE",
          to: "ENGAGED" }, `${tag}:engage`);
        assert.ok(e.ok, JSON.stringify(e));
      });
      return id;
    };
    const f1 = engaged("d3a");
    const v1 = fleetOf(env, f1).version;
    const rel = env.tx((db) => env.fleets.travel.releaseFromBattleInTx(db, { fleetId: f1, expectedVersion: v1, at: t0,
      disposition: "RETREAT", retreatTargets: [] }, "d3a:rel"));
    assert.deepStrictEqual([rel.ok, rel.disposition], [true, "REFITTING"], JSON.stringify(rel));
    const r1 = fleetOf(env, f1);
    assert.deepStrictEqual([r1.state, r1.refitPending], ["REFITTING", true]);
    const f2 = engaged("d3b");
    const due = t0 + H.CONFIG.fleets.refitMs;
    const f2Row = fleetOf(env, f2);
    env.tx((db) => {
      const m = env.fleets.repository.transition(db, { fleetId: f2, expectedVersion: f2Row.version, from: "ENGAGED",
        to: "REFITTING", patch: { nextActionAt: due, legSeq: f2Row.legSeq + 1 } }, "d3b:refit");
      assert.ok(m.ok, JSON.stringify(m));
    });
    const e2 = env.scheduler.enqueue("FLEET_REFIT_COMPLETE", f2, due, { fleetId: f2, legSeq: f2Row.legSeq + 1 },
      refitKey(f2, f2Row.legSeq + 1));
    assert.ok(e2.ok, JSON.stringify(e2));
    const st = env.tx((db) => env.stations.repository.getStation(db, "st-own")).record;
    const tr = env.tx((db) => env.stations.repository.transitionStation(db, { stationId: "st-own",
      expectedVersion: st.version, from: "ONLINE", to: "ARMOR_REINFORCE", key: "d3:reinforce", reason: "TEST",
      at: t0 }));
    assert.ok(tr.ok, JSON.stringify(tr));
    await settleAt(env, shared, due);
    const a = fleetOf(env, f1);
    assert.deepStrictEqual([a.state, a.refitPending, a.legSeq], ["IDLE", true, r1.legSeq + 1]);
    assert.strictEqual(eventOf(env, refitSeekKey(f1, r1.legSeq + 1, 0)).state, "QUEUED", "FLEET_REFIT_SEEK round 0");
    assert.strictEqual(eventOf(env, refitKey(f1, r1.legSeq)).outcome, "STRANDED");
    assert.strictEqual(env.fleets.travel.getCounters().refitStationLost, 1);
    const version = a.version;
    assert.ok(env.scheduler.enqueue("FLEET_REFIT_COMPLETE", f1, due, { fleetId: f1, legSeq: r1.legSeq },
      `${refitKey(f1, r1.legSeq)}:replay`).ok);
    await settleAt(env, shared, due + 1);
    assert.strictEqual(fleetOf(env, f1).version, version, "STALE");
    const b = fleetOf(env, f2);
    assert.deepStrictEqual([b.state, b.refitPending], ["IDLE", false]);
    assert.strictEqual(countOf(env, "SELECT count(*) AS n FROM world_scheduled_events WHERE event_type = "
      + "'FLEET_REFIT_SEEK' AND aggregate_id = ?", f2), 0);
  }));
};
