"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { readStaticMapFrom } = require("../../lib/adapter/staticMap");
const { buildUniverseGraph } = require("../../lib/graph/universeGraph");
const { createRouteFinder } = require("../../lib/graph/routes");
const { openStore } = require("../../lib/persistence/store");
const { seedDbFile } = require("../_support/dbTemplate");
const { createJournal } = require("../../lib/persistence/journal");
const { createManualClock } = require("../../lib/util/clock");
const { createRng } = require("../../lib/util/rng");
const { createIdGenerator } = require("../../lib/util/ids");
const { createViewRegistry } = require("../../lib/observer/views");
const { startScheduler } = require("../../lib/scheduler");
const { startFleets } = require("../../lib/fleets");
const { refitKey, opDoneKey, arrivalKey } = require("../../lib/fleets/travelService");
const { createBattleRepository } = require("../../lib/battle/battleRepository");
const { hashInput, validateResult } = require("../../lib/battle/contract");
const { createSettlement } = require("../../lib/battle/settlement");
const plan = require("../../lib/battle/settlementPlan");
const config = require("../../config");
const { loadSecurityBand } = require("../graph/fixtures/staticMap.fixture");
const { S, rawWorld } = require("../graph/fixtures/routeMap.fixture");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const START_MS = 1760000000000;
const FACTION_A = 500019;
const FACTION_B = 500010;
const FACTION_C = 500001;
const BATTLE_SYSTEM = S.N5;
const REFIT_MS = 600000;
const AVOID = Object.freeze({ avoidSecClasses: ["highsec", "lowsec"] });
const CONFIG = Object.freeze({
  enabled: true,
  modules: { scheduler: { enabled: true }, fleets: { enabled: true } },
  scheduler: { maxAttempts: 5, retryBaseMs: 1000, retryMaxMs: 600000, maxOpenEvents: 50000, maxPayloadBytes: 4096,
    intervalMs: 1000, sliceMs: 4, claimBatchSize: 8, catchUpLagMs: 60000, backlogCountCap: 4096,
    chainedHeadroom: 1000 },
  limits: { maxDueEventsPerPass: 64, maxSchedulerWorkMs: 8, maxCatchUpEventsPerPass: 32, maxVirtualFleets: 50 },
  fleets: { maxCompositionEntries: 32, maxShipsPerFleet: 500, maxFleetsPerOperation: 16, maxJsonBytes: 4096,
    maxListLimit: 500, travelTimeFactor: 1, refitMs: REFIT_MS, operationMaxOverdueRounds: 12 },
  persistence: { journalMaxPayloadBytes: 16384 },
  observer: { galaxyEnabled: false, galaxyFleetsEnabled: false, galaxyFleetsMaxItems: 500,
    galaxyFleetsRefreshMs: 5000 },
});
const BATTLE_LIMITS = Object.freeze({ maxFleetsPerSide: 8, maxCompositionEntries: 32, maxShipsPerFleet: 500,
  maxResolutionMs: 50, maxInputBytes: 65536, maxResultBytes: 65536, maxListLimit: 500, maxSettlementRows: 450 });
const SETTLE_LIMITS = Object.freeze({ maxResultBytes: 65536, maxSettlementRows: 450, retreatSearchMaxJumps: 5,
  retreatSearchMaxSystems: 200, retreatMaxCandidates: 3 });

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function fixtureGraph() {
  const read = readStaticMapFrom({ ensureLoaded: () => rawWorld() }, loadSecurityBand());
  assert.strictEqual(read.ok, true, JSON.stringify(read));
  const built = buildUniverseGraph(read.map);
  assert.strictEqual(built.ok, true);
  const finder = createRouteFinder(built.graph, { cacheSize: 64, maxJumps: 40 });
  return Object.freeze({ ...built.graph, ...finder.publicApi });
}

async function withStore(driver, setupOrFn, maybeTestFn, opts = {}) {
  let setupFn, testFn, options;
  if (typeof maybeTestFn === "function") {
    setupFn = setupOrFn;
    testFn = maybeTestFn;
    options = opts || {};
  } else {
    testFn = setupOrFn;
    options = maybeTestFn && typeof maybeTestFn === "object" ? maybeTestFn : {};
  }
  const { fresh = false } = options;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-st-"));
  const file = path.join(tmp, "world.sqlite");
  const open = [];
  const reopen = () => {
    if (!fresh) seedDbFile(driver, file, { seed: 1 });
    const opened = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1 });
    assert.ok(opened.ok, JSON.stringify(opened));
    open.push(opened.store);
    return opened;
  };
  try {
    if (setupFn) {
      const opened = reopen();
      const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
      await setupFn(tx);
      opened.store.close("test_cleanup_setup");
      const opened2 = reopen();
      const db = (fn) => { const r = opened2.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
      return await testFn(db, opened2.store);
    } else {
      return await testFn(reopen);
    }
  } finally {
    for (const s of open) s.close("test_cleanup");
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (_err) {
    }
  }
}

function fakeWorld(controllers) {
  return { limits: { maxBatchReadIds: 2 }, getSystems(tx, ids) {
    assert.ok(ids.length <= 2, "chunked by maxBatchReadIds");
    return { ok: true, systems: ids.filter((id) => controllers.has(id))
      .map((id) => ({ systemId: id, controllerFactionId: controllers.get(id) })), missing: [] };
  } };
}

function boot(opened, shared, extra = {}) {
  const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
  const sr = startScheduler({ config: CONFIG, persistence: { ok: true, store: opened.store }, clock: shared.clock,
    ids: shared.ids, nowMs: () => 0 });
  assert.ok(sr.ok, JSON.stringify(sr));
  const fr = startFleets({ config: CONFIG, persistence: { ok: true, store: opened.store, journal,
    worldSeed: opened.worldSeed }, clock: shared.clock, ids: shared.ids, scheduler: sr.scheduler,
  graph: { getGraph: () => ({ ok: true, graph: shared.graph }) }, presence: null, views: createViewRegistry() });
  assert.ok(fr.ok, JSON.stringify(fr));
  const fleets = fr.fleets;
  const battles = createBattleRepository({ journal, fleetRepository: fleets.repository, clock: shared.clock,
    ids: shared.ids, worldSeed: opened.worldSeed, limits: BATTLE_LIMITS });
  const world = fakeWorld(new Map([[S.N6, FACTION_B], [S.N0, FACTION_A]]));
  const makeSettlement = (over = {}) => createSettlement({ journal, battleRepository: battles,
    fleetRepository: fleets.repository, travel: over.travel || fleets.travel, getGraph: () => shared.graph,
    worldRepository: world, limits: SETTLE_LIMITS, consequences: over.consequences });
  const store = opened.store;
  const tx = (fn) => {
    const r = store.transaction("test", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  return { store, scheduler: sr.scheduler, fleets, battles, journal, settlement: makeSettlement(extra), makeSettlement,
    tx };
}

function sharedOf() {
  const clock = createManualClock(START_MS);
  return { clock, ids: createIdGenerator({ clock, rng: createRng(7) }), graph: fixtureGraph() };
}

const n = (env, sql, ...args) => env.tx((db) => db.prepare(sql).get(...args)).n;
const totals = (env) => ({
  losses: n(env, "SELECT count(*) AS n FROM battle_losses"),
  journal: n(env, "SELECT count(*) AS n FROM world_event_journal"),
  events: n(env, "SELECT count(*) AS n FROM world_scheduled_events"),
});
const eventOf = (env, key) => env.tx((db) => db.prepare("SELECT state, due_at FROM world_scheduled_events WHERE "
  + "idempotency_key = ?").get(key));
const fleetOf = (env, id) => env.tx((db) => env.fleets.repository.getFleet(db, id)).fleet;
const battleOf = (env, id) => env.tx((db) => env.battles.getBattle(db, id)).battle;
const versionsOf = (env, ids) => ids.map((id) => [fleetOf(env, id).state, fleetOf(env, id).version]);

function newFleet(env, tag, factionId, composition, home = S.N0) {
  const r = env.fleets.createFleet({ factionId, currentSystemId: S.N0, homeSystemId: home, fleetRole: "invasion",
    composition }, `${tag}:create`);
  assert.ok(r.ok, JSON.stringify(r));
  return r.fleetId;
}

function fleetWithOperation(env, tag, composition) {
  const fleetId = newFleet(env, tag, FACTION_A, composition);
  const op = env.fleets.createOperation({ operationType: "invasion", factionId: FACTION_A, originSystemId: S.N0,
    targetSystemId: S.N9, objective: "capture", dueAt: START_MS + 3600000,
    fleets: [{ fleetId, expectedVersion: 1 }] }, `${tag}:op`);
  assert.ok(op.ok, JSON.stringify(op));
  const p = env.fleets.planTravel({ fleetId, targetSystemId: S.N9, constraints: AVOID }, `${tag}:plan`);
  assert.ok(p.ok, JSON.stringify(p));
  return { fleetId, operationId: op.operationId };
}

function battleOfFleets(env, tag, aIds, bIds, opts = {}) {
  const side = (factionId, ids) => ({ factionId,
    fleets: ids.map((fleetId) => ({ fleetId, expectedVersion: fleetOf(env, fleetId).version })) });
  const spec = { systemId: opts.systemId || BATTLE_SYSTEM, environment: "nullsec", objective: "destroy", resolverVersion: "internal-v1",
    maxResolutionMs: 20, garrison: null, sideA: side(FACTION_A, aIds), sideB: side(opts.factionB || FACTION_B, bIds) };
  const created = env.tx((db) => env.battles.createBattle(db, spec, `${tag}:battle`));
  assert.strictEqual(created.ok, true, JSON.stringify(created));
  const battleId = created.battleId;
  const mode = opts.mode || "VIRTUAL";
  let b = battleOf(env, battleId);
  const c = env.tx((db) => env.battles.claim(db, { battleId, expectedVersion: b.version, mode },
    `battle:${battleId}:claim:1:${mode}`));
  assert.strictEqual(c.ok, true, JSON.stringify(c));
  b = battleOf(env, battleId);
  const to = mode === "LIVE_EVEJS" ? "LIVE" : "RESOLVING";
  const t = env.tx((db) => env.battles.transition(db, { battleId, expectedVersion: b.version, from: "CLAIMED", to },
    `battle:${battleId}:CLAIMED>${to}`));
  assert.strictEqual(t.ok, true, JSON.stringify(t));
  return battleOf(env, battleId);
}

function resultFor(input, outcome, spec = {}) {
  const lists = { destroyedShips: [], escapedShips: [], survivingShips: [] };
  for (const side of [input.sideA, input.sideB]) {
    for (const f of side.fleets) {
      for (const e of f.composition) {
        const split = spec[f.fleetId] ? spec[f.fleetId](e) : { d: 0, e: 0 };
        const group = (count) => ({ fleetId: f.fleetId, hullGroup: e.hullGroup, typeId: e.typeId, count });
        if (split.d > 0) lists.destroyedShips.push(group(split.d));
        if (split.e > 0) lists.escapedShips.push(group(split.e));
        const s = e.count - split.d - split.e;
        if (s > 0) lists.survivingShips.push(group(s));
      }
    }
  }
  return { battleId: input.battleId, resolver: input.resolverVersion, outcome, ...lists, objectiveAchieved: true,
    estimatedDurationSec: 90, confidence: 0.8, diagnostics: { rounds: 3 } };
}

const COMP_F1 = Object.freeze([{ hullGroup: "frigate", count: 3 }, { hullGroup: "cruiser", count: 2 }]);
const COMP_F2 = Object.freeze([{ hullGroup: "destroyer", count: 2 }]);
const COMP_F3 = Object.freeze([{ hullGroup: "frigate", typeId: 587, count: 4 }]);
const T1_SPEC = (ids) => ({
  [ids.f1]: (e) => (e.hullGroup === "cruiser" ? { d: 2, e: 0 } : { d: 0, e: 0 }),
  [ids.f2]: (e) => ({ d: e.count, e: 0 }),
  [ids.f3]: (e) => ({ d: 1, e: e.count - 1 }),
});

function sceneT1(env, tag) {
  const { fleetId: f1, operationId } = fleetWithOperation(env, `${tag}:f1`, COMP_F1);
  const f2 = newFleet(env, `${tag}:f2`, FACTION_A, COMP_F2);
  const f3 = newFleet(env, `${tag}:f3`, FACTION_B, COMP_F3);
  const battle = battleOfFleets(env, tag, [f1, f2], [f3]);
  const ids = { f1, f2, f3 };
  return { ids, operationId, battle, result: resultFor(battle.input, "A_WIN", T1_SPEC(ids)) };
}

const settleIn = (env, settlement, battle, result, extra = {}) => env.tx((db) => settlement.settle(db,
  { battleId: battle.battleId, inputHash: hashInput(battle.input), result, at: env.now(), ...extra }, 1));

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };
  const start = (opened, shared, extra) => {
    const env = boot(opened, shared, extra);
    env.now = () => shared.clock.now();
    return env;
  };

  needsDriver("T1 settlement happy path + duplicate: dispositions, losses, BATTLE_SETTLED once, consequences", () =>
    withStore(driver, async (reopen) => {
      const shared = sharedOf();
      let probeCalls = 0;
      const consequences = [
        { name: "probe", apply(db, settled, key) {
          probeCalls += 1;
          assert.ok(Object.isFrozen(settled) && settled.losses.length === 3 && settled.winnerFactionId === FACTION_A);
          return env.journal.applyOnce(db, { key: `${key}:x`, aggregate: { type: "battle", id: settled.battleId },
            eventType: "PROBE", payload: { n: settled.losses.length } }, () => ({ ok: true }));
        } },
        { name: "broken", apply() { throw new Error("boom"); } },
      ];
      const env = start(reopen(), shared, { consequences });
      const { ids, operationId, battle, result } = sceneT1(env, "t1");

      const p = plan.planSettlement(battle.input, validateResult(battle.input, result, { maxResultBytes: 65536 }).result);
      assert.deepStrictEqual(p.fleets.map((f) => [f.fleetId, f.disposition]).sort(),
        [[ids.f1, "STAY"], [ids.f2, "DESTROYED"], [ids.f3, "RETREAT"]].sort());
      assert.strictEqual(plan.settlementRowBound(battle.input), 6 + 3 * 6 + 2 + 1 + 1);
      assert.deepStrictEqual([plan.ROWS_PER_BATTLE, plan.ROWS_PER_FLEET], [6, 6]);
      assert.deepStrictEqual([plan.classifyResolverRefusal("RESOLVER_BUDGET"),
        plan.classifyResolverRefusal("RESOLVER_INTERNAL"), plan.classifyResolverRefusal("WHAT")],
      ["FAIL", "QUARANTINE", "QUARANTINE"]);
      const rowsEnv = (n) => ({ EVEJS_LNE_PERSISTENCE_MAX_ROWS_PER_TRANSACTION: String(n),
        EVEJS_LNE_MINING_ENABLED: "0", EVEJS_LNE_PRODUCTION_ENABLED: "0", EVEJS_LNE_UPKEEP_ENABLED: "0",
        EVEJS_LNE_LOGISTICS_ENABLED: "0", EVEJS_LNE_CONSTRUCTION_ENABLED: "0", EVEJS_LNE_SIEGE_RELIEF_ENABLED: "0",
        EVEJS_LNE_TRADE_ENABLED: "0", EVEJS_LNE_STRATEGY_TERRITORY_TRIM_ENABLED: "0",
        EVEJS_LNE_STRATEGY_DEFENSE_ENABLED: "0",
        EVEJS_LNE_STRATEGY_MAX_OPERATIONS_PER_REVIEW: "1", EVEJS_LNE_STRATEGY_MAX_FLEETS_PER_OPERATION: "4",
        EVEJS_LNE_STRATEGY_MAX_MOBILIZATIONS_PER_REVIEW: "2",
        EVEJS_LNE_STRATEGY_MAX_RETURNS_PER_REVIEW: "0",
        EVEJS_LNE_STRATEGY_MERGE_ENABLED: "0",
        EVEJS_LNE_SENTRIES_FACTION_ENABLED: "0",
        EVEJS_LNE_STRATEGY_GARRISON_RELEASE_ENABLED: "0", EVEJS_LNE_STRATEGY_PATROL_ENABLED: "0",
        EVEJS_LNE_OCCUPATION_MAX_ACTIVE_SYSTEMS: "64",
        EVEJS_LNE_STRATEGY_REACTIVE_ENABLED: "0",
        EVEJS_LNE_LOWSEC_ENABLED: "0" });
      assert.deepStrictEqual(config.resolveConfig({ modDir: MOD_DIR, env: {} }).warnings, []);
      assert.deepStrictEqual(config.resolveConfig({ modDir: MOD_DIR, env: rowsEnv(138) }).warnings, []);
      assert.deepStrictEqual(config.resolveConfig({ modDir: MOD_DIR, env: rowsEnv(137) }).warnings,
        ["smallest full battle settles 82 rows > 81 (persistence.maxRowsPerTransaction - battle.settleRowsReserve)"
          + " - 1 vs 1 fleets with full compositions are refused at creation (BATTLE_TOO_LARGE_TO_SETTLE)"]);

      const r = settleIn(env, env.settlement, battle, result);
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.deepStrictEqual([r.duplicate, r.outcome, r.lossRows], [false, "COMPLETED", 3]);
      assert.deepStrictEqual(r.consequences, { applied: ["probe"], refused: ["broken"] });
      const K = plan.settleKey(battle.battleId, 1);
      assert.strictEqual(r.settlementKey, K);
      const f1 = fleetOf(env, ids.f1);
      const f2 = fleetOf(env, ids.f2);
      const f3 = fleetOf(env, ids.f3);
      assert.deepStrictEqual([f1.state, f1.shipCount, f1.operationId], ["STAGED", 3, operationId]);
      assert.strictEqual(eventOf(env, opDoneKey(operationId)).state, "QUEUED");
      assert.strictEqual(f2.state, "DESTROYED");
      assert.deepStrictEqual([f3.state, f3.targetSystemId, f3.shipCount], ["RETREATING", S.N6, 3]);
      assert.deepStrictEqual(f3.composition, [{ hullGroup: "frigate", typeId: 587, count: 3 }], "escapees stay");
      assert.strictEqual(eventOf(env, arrivalKey(ids.f3, f3.legSeq)).state, "QUEUED");
      assert.deepStrictEqual(r.fleets.find((f) => f.fleetId === ids.f3).retreatTo, S.N6);
      const losses = env.tx((db) => env.battles.getLosses(db, battle.battleId)).losses
        .map((l) => [l.fleetId, l.hullGroup, l.typeId, l.count]);
      assert.deepStrictEqual(losses.sort(), [[ids.f1, "cruiser", null, 2], [ids.f2, "destroyer", null, 2],
        [ids.f3, "frigate", 587, 1]].sort(), "only destroyedShips");
      const b = battleOf(env, battle.battleId);
      assert.deepStrictEqual([b.state, b.settlementKey], ["COMPLETED", K]);
      assert.strictEqual(n(env, "SELECT count(*) AS n FROM world_event_journal WHERE event_type = 'BATTLE_SETTLED'"), 1);
      assert.strictEqual(n(env, "SELECT count(*) AS n FROM world_event_journal WHERE idempotency_key = ?",
        `${K}:c:probe:x`), 1);
      assert.strictEqual(probeCalls, 1);

      const before = { totals: totals(env), versions: versionsOf(env, [ids.f1, ids.f2, ids.f3]) };
      const again = settleIn(env, env.settlement, battle, result);
      assert.deepStrictEqual([again.ok, again.duplicate, again.outcome], [true, true, "COMPLETED"]);
      assert.deepStrictEqual({ totals: totals(env), versions: versionsOf(env, [ids.f1, ids.f2, ids.f3]) }, before);
      const c = env.settlement.getCounters();
      assert.deepStrictEqual([c.completed, c.duplicate, c.consequenceRefused], [1, 1, 1]);
    }));

  needsDriver("T2 settlement crash inside the savepoint -> zero changes; retry settles once", () =>
    withStore(driver, async (reopen) => {
      const shared = sharedOf();
      const env = start(reopen(), shared);
      const { ids, battle, result } = sceneT1(env, "t2");
      let thrown = false;
      const crashing = env.makeSettlement({ travel: { releaseFromBattleInTx(...args) {
        if (!thrown) {
          thrown = true;
          throw new Error("crash in release");
        }
        return env.fleets.travel.releaseFromBattleInTx(...args);
      } } });
      const fleetIds = [ids.f1, ids.f2, ids.f3];
      const before = { totals: totals(env), versions: versionsOf(env, fleetIds), battle: battleOf(env, battle.battleId).version };
      const r = settleIn(env, crashing, battle, result);
      assert.deepStrictEqual([r.ok, r.reason, r.permanent], [false, "APPLY_FAILED", false], JSON.stringify(r));
      assert.deepStrictEqual({ totals: totals(env), versions: versionsOf(env, fleetIds),
        battle: battleOf(env, battle.battleId).version }, before);
      assert.strictEqual(battleOf(env, battle.battleId).state, "RESOLVING");
      const K = plan.settleKey(battle.battleId, 1);
      assert.strictEqual(env.tx((db) => env.journal.findByKey(db, K)).found, false);
      const ok = settleIn(env, env.settlement, battle, result);
      assert.deepStrictEqual([ok.ok, ok.outcome, ok.duplicate], [true, "COMPLETED", false], JSON.stringify(ok));
      assert.strictEqual(n(env, "SELECT count(*) AS n FROM world_event_journal WHERE idempotency_key = ?", K), 1);
    }));

  needsDriver("T3 settlement restart between RESOLVING and settle: the scheduler handler settles once", () =>
    withStore(driver, async (reopen) => {
      const shared = sharedOf();
      const first = start(reopen(), shared);
      const { battle, result } = sceneT1(first, "t3");
      const ev = first.scheduler.enqueue("BATTLE_RESOLUTION", battle.battleId, shared.clock.now(),
        { battleId: battle.battleId }, `battle:${battle.battleId}:resolve`);
      assert.ok(ev.ok, JSON.stringify(ev));
      first.store.close("restart");

      const env = start(reopen(), shared);
      env.scheduler.registerHandler("BATTLE_RESOLUTION", (e) => {
        const read = env.store.transaction("read", (db) => env.battles.getBattle(db, e.payload.battleId));
        if (!read.ok) return { ok: false, reason: read.reason };
        const b = read.value.battle;
        if (!b || b.state !== "RESOLVING") return { ok: true, outcome: "STALE" };
        return { ok: true, outcome: "SETTLED", effect: (tx) => {
          const s = env.settlement.settle(tx, { battleId: b.battleId, inputHash: hashInput(b.input), result,
            at: e.dueAt }, 1);
          return s.ok ? { ok: true } : s;
        } };
      });
      const p = await env.scheduler.runPass();
      assert.ok(p.ok, JSON.stringify(p));
      assert.strictEqual(eventOf(env, `battle:${battle.battleId}:resolve`).state, "DONE");
      assert.strictEqual(battleOf(env, battle.battleId).state, "COMPLETED");
      const K = plan.settleKey(battle.battleId, 1);
      assert.strictEqual(n(env, "SELECT count(*) AS n FROM world_event_journal WHERE idempotency_key = ?", K), 1);
      const again = settleIn(env, env.settlement, battle, result);
      assert.deepStrictEqual([again.ok, again.duplicate], [true, true]);
    }));

  needsDriver("T4 settlement data errors -> QUARANTINED, fleets ENGAGED unchanged, no losses", () =>
    withStore(driver, async (reopen) => {
      const shared = sharedOf();
      const env = start(reopen(), shared);
      const { ids, battle, result } = sceneT1(env, "t4");
      const fleetIds = [ids.f1, ids.f2, ids.f3];
      const before = versionsOf(env, fleetIds);
      const otherHash = hashInput({ ...battle.input, seed: battle.input.seed + 1 });
      const r = settleIn(env, env.settlement, battle, result, { inputHash: otherHash });
      assert.deepStrictEqual([r.ok, r.outcome, r.cause], [true, "QUARANTINED", "INPUT_HASH_MISMATCH"], JSON.stringify(r));
      const b = battleOf(env, battle.battleId);
      assert.deepStrictEqual([b.state, b.error.reason], ["QUARANTINED", "INPUT_HASH_MISMATCH"]);
      assert.deepStrictEqual(versionsOf(env, fleetIds), before);
      assert.ok(before.every(([state]) => state === "ENGAGED"));
      assert.strictEqual(totals(env).losses, 0);

      const two = sceneT1(env, "t4b");
      const unbalanced = JSON.parse(JSON.stringify(two.result));
      unbalanced.survivingShips[0].count -= 1;
      assert.strictEqual(settleIn(env, env.settlement, two.battle, unbalanced).cause, "RESULT_UNBALANCED");
      assert.strictEqual(battleOf(env, two.battle.battleId).state, "QUARANTINED");
      assert.strictEqual(env.settlement.getCounters().lastQuarantine.cause, "RESULT_UNBALANCED");
    }));

  needsDriver("T5 settlement of a LIVE_EVEJS battle -> MODE_MISMATCH, nothing changes", () =>
    withStore(driver, async (reopen) => {
      const shared = sharedOf();
      const env = start(reopen(), shared);
      const a = newFleet(env, "t5:a", FACTION_A, COMP_F1);
      const bf = newFleet(env, "t5:b", FACTION_B, COMP_F3);
      const battle = battleOfFleets(env, "t5", [a], [bf], { mode: "LIVE_EVEJS" });
      assert.strictEqual(battle.state, "LIVE");
      const before = { versions: versionsOf(env, [a, bf]), totals: totals(env) };
      const r = settleIn(env, env.settlement, battle, resultFor(battle.input, "A_WIN"));
      assert.deepStrictEqual([r.ok, r.reason, r.permanent], [false, "MODE_MISMATCH", true], JSON.stringify(r));
      const b = battleOf(env, battle.battleId);
      assert.deepStrictEqual([b.state, b.version], ["LIVE", battle.version]);
      assert.deepStrictEqual({ versions: versionsOf(env, [a, bf]), totals: totals(env) }, before);
    }));

  needsDriver("T6 settlement cancel -> FAILED without losses; repair in place with legSeq + 1", () =>
    withStore(driver, async (reopen) => {
      const shared = sharedOf();
      const env = start(reopen(), shared);
      const { ids, battle } = sceneT1(env, "t6");
      const c = env.tx((db) => env.settlement.cancel(db, { battleId: battle.battleId, at: shared.clock.now(),
        reason: "RESOLVER_BUDGET" }, 1));
      assert.deepStrictEqual([c.ok, c.outcome], [true, "FAILED"], JSON.stringify(c));
      assert.strictEqual(battleOf(env, battle.battleId).state, "FAILED");
      assert.deepStrictEqual([ids.f1, ids.f2, ids.f3].map((id) => fleetOf(env, id).state), ["STAGED", "IDLE", "IDLE"]);
      assert.strictEqual(totals(env).losses, 0);

      const x = newFleet(env, "t6:x", FACTION_C, COMP_F3, BATTLE_SYSTEM);
      const legSeq = fleetOf(env, x).legSeq;
      const used = env.scheduler.enqueue("FLEET_REFIT_COMPLETE", x, shared.clock.now(), { fleetId: x, legSeq },
        refitKey(x, legSeq));
      assert.ok(used.ok, JSON.stringify(used));
      const p = await env.scheduler.runPass();
      assert.ok(p.ok, JSON.stringify(p));
      assert.strictEqual(eventOf(env, refitKey(x, legSeq)).state, "DONE", "the old key is spent");
      const winner = newFleet(env, "t6:w", FACTION_A, COMP_F1);
      const fight = battleOfFleets(env, "t6b", [winner], [x], { factionB: FACTION_C });
      const r = settleIn(env, env.settlement, fight, resultFor(fight.input, "A_WIN",
        { [x]: (e) => ({ d: 0, e: e.count }) }));
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      const fx = fleetOf(env, x);
      assert.deepStrictEqual([fx.state, fx.legSeq, fx.nextActionAt], ["REFITTING", legSeq + 1,
        shared.clock.now() + REFIT_MS]);
      assert.deepStrictEqual(eventOf(env, refitKey(x, legSeq + 1)), { state: "QUEUED",
        due_at: shared.clock.now() + REFIT_MS });
      assert.strictEqual(fleetOf(env, winner).state, "IDLE", "no operation -> IDLE");
      assert.strictEqual(env.settlement.getCounters().refitInPlace, 1);
    }));
};

Object.assign(module.exports, { harness: Object.freeze({ loadDriver, withStore, sharedOf, boot, newFleet,
  battleOfFleets, resultFor, settleIn, n, eventOf, battleOf, CONFIG, START_MS, FACTION_A, FACTION_B, S }) });
