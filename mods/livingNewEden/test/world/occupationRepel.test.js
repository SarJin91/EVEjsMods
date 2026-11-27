"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const S = require("../../lib/world/occupation/schema");
const M = require("../../lib/world/occupation/machine");
const { createWorldStateRepository } = require("../../lib/world/worldStateRepository");
const { startOccupation, createUnavailableOccupation } = require("../../lib/world/occupation");
const { createOccupationService } = require("../../lib/world/occupation/occupationService");
const { createHostility } = require("../../lib/battle/data/hostility");
const { GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { expandStrengthGroups } = require("../../lib/battle/strength");
const { buildPowerTable } = require("../../lib/strategy/ai/strength");
const { createViewRegistry } = require("../../lib/observer/views");
const { createRng } = require("../../lib/util/rng");
const { resolveConfig, SCHEMA } = require("../../config");
const { harness: H } = require("../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const ENV_EXAMPLE = path.join(MOD_DIR, ".env.example");
const HOUR = 3600000;
const LIMITS = Object.freeze({ maxFactionsPerSystem: 8, maxBatchReadIds: 400, maxListLimit: 500 });
const AMARR = 500003;
const SANSHA = 500019;
const GURISTAS = 500010;
const isHostile = createHostility();

const PARAMS = Object.freeze({ evalIntervalMs: 900000, idleEvalIntervalMs: 7200000, maxActiveSystems: 64,
  reconTimeoutMs: 2 * HOUR, contestTimeoutMs: 6 * HOUR, invasionHoldMs: 6 * HOUR, occupiedSettleMs: 6 * HOUR,
  consolidateMs: 24 * HOUR, invasionMinScore: 30, occupyMinScore: 60, occupyMaxDefenderScore: 30, stableMinScore: 80,
  stableMaxResidualScore: 20, battleWinPoints: 20, battleLossPoints: 15, holdPointsPerHour: 10,
  stationPointsPerHour: 5, stationBonusCap: 3, decayPointsPerHour: 5, requireNoDefenderStations: true,
  garrisonFleetsTarget: 1, detachedUpkeepStep: 0.5, detachedUpkeepPeriodMs: 24 * HOUR, detachedUpkeepMaxFactor: 4,
  maxFactionsPerSystem: 8, stableBaselineScore: 60, stableRecoverPointsPerHour: 1, stableForeignDecayPointsPerHour: 1,
  stableForeignFloorScore: 0, garrisonFromRoles: Object.freeze(["invasion", "patrol", "scout", "reserve"]) });

function view(o = {}) {
  const range = new Set(o.range || []);
  return { systemId: 30002000, state: o.state || S.INVASION, controller: o.controller === undefined ? AMARR : o.controller,
    occupier: o.occupier === undefined ? SANSHA : o.occupier, previousController: null, sinceAt: o.sinceAt || 0,
    seq: o.seq || 4, evaluatedAt: o.evaluatedAt === undefined ? null : o.evaluatedAt,
    capturedAt: o.capturedAt === undefined ? null : o.capturedAt, detachedSinceAt: null, home: null,
    coreOwner: o.coreOwner === undefined ? null : o.coreOwner,
    influence: new Map(Object.entries(o.influence || {}).map(([f, score]) => [Number(f), { score, garrison: 0 }])),
    presence: new Map(Object.entries(o.presence || {}).map(([f, strength]) => [Number(f), { strength,
      fleets: [{ fleetId: `fl:${f}`, version: 1, state: "IDLE", fleetRole: "invasion", refitPending: false }] }])),
    stations: new Map(), inRange: (f) => range.has(f), isHostile, presenceTruncated: false, at: o.at || HOUR,
    rangeKnown: true };
}
const repel = (loserFactionId) => ({ kind: "repel", huntId: "ph:fl:1:3", loserFactionId });

function configOf(env = {}) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } });
  assert.deepStrictEqual(r.errors || [], []);
  return r.config;
}

function bootRepel(opened, shared, envOver = {}, occOver = {}) {
  const env = H.boot(opened, shared);
  const config = configOf({ EVEJS_LNE_OCCUPATION_PLAYER_REPEL_ENABLED: "1", ...envOver });
  const repo = createWorldStateRepository({ journal: env.journal, clock: shared.clock, limits: LIMITS });
  const r = startOccupation({ config, persistence: { ok: true, store: env.store, journal: env.journal },
    clock: shared.clock, scheduler: env.scheduler, fleets: env.fleets, world: { repository: repo },
    graph: { getGraph: () => ({ ok: true, graph: shared.graph }) }, getStations: () => null,
    views: createViewRegistry(), logger: { log() {} }, nowMs: () => 0, ...occOver });
  assert.ok(r.ok, JSON.stringify(r));
  return { ...env, repo, occupation: r.occupation, config, worldSeed: opened.worldSeed };
}

function seedInvasion(env, systemId, controller, occupier, influence) {
  const r = env.tx((db) => env.repo.applyChange(db, { systemId, expectedVersion: 0, reason: "SEED_CONTROL",
    state: { securityClass: "nullsec", controllerFactionId: controller },
    influence: Object.entries(influence).map(([f, s]) => ({ factionId: Number(f), influenceScore: s })) },
  `world:seed:v1:${systemId}`));
  assert.ok(r.ok, JSON.stringify(r));
  const u = env.tx((db) => env.repo.applyChange(db, { systemId, expectedVersion: 1, reason: "OCCUPATION_PHASE",
    state: { occupationState: S.INVASION, occupierFactionId: occupier, phaseSeq: 2 } }, `test:invasion:${systemId}`));
  assert.ok(u.ok, JSON.stringify(u));
}

const systemOf = (env, id) => env.tx((db) => env.repo.getSystem(db, id, { includeInfluence: true })).system;
const scoreOf = (sys, f) => ((sys.influence || []).find((i) => i.factionId === f) || { influenceScore: 0 })
  .influenceScore;
const keyCount = (env, table, key) => env.tx((db) => db.prepare(`SELECT count(*) AS n FROM ${table}
  WHERE idempotency_key = ?`).get(key)).n;
const rowsOf = (env) => env.tx((db) => ({
  journal: db.prepare("SELECT count(*) AS n FROM world_event_journal").get().n,
  events: db.prepare("SELECT count(*) AS n FROM world_scheduled_events").get().n,
}));

async function pass(env) {
  for (let i = 0; i < 20; i += 1) {
    const p = await env.scheduler.runPass();
    assert.ok(p.ok, JSON.stringify(p));
    if (!p.jobs) return;
  }
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("RP2 machine repel: INVASION + repel(L=P) with another P fleet in the field -> CONTESTED, notes "
    + "INTERRUPTED + PLAYER_REPEL, occupier kept; L!=P, CONTESTED, RECON -> no transition", () => {
    const v = view({ presence: { [SANSHA]: 100 }, influence: { [SANSHA]: 50, [AMARR]: 40 }, range: [SANSHA] });
    const ev = M.evaluate(v, repel(SANSHA), PARAMS);
    assert.strictEqual(ev.to, S.CONTESTED, JSON.stringify(ev));
    assert.deepStrictEqual(ev.notes.filter((n) => n === "INTERRUPTED" || n === "PLAYER_REPEL"),
      ["INTERRUPTED", "PLAYER_REPEL"]);
    assert.deepStrictEqual([ev.statePatch.occupierFactionId, ev.statePatch.controllerFactionId,
      ev.statePatch.phaseSeq], [SANSHA, AMARR, 5]);
    assert.ok(M.canTransition(S.INVASION, S.CONTESTED, M.TRIGGERS.REPEL));
    assert.strictEqual(M.evaluate(v, { kind: "tick" }, PARAMS).to, null);
    const other = M.evaluate(v, repel(GURISTAS), PARAMS);
    assert.strictEqual(other.to, null);
    assert.ok(!other.notes.includes("PLAYER_REPEL"));
    for (const state of [S.CONTESTED, S.RECON]) {
      const e = M.evaluate(view({ state, presence: { [SANSHA]: 100 }, influence: { [SANSHA]: 10 }, range: [SANSHA],
        at: 60000 }), repel(SANSHA), PARAMS);
      assert.strictEqual(e.to, null, `${state}: ${JSON.stringify(e)}`);
      assert.ok(!e.notes.includes("PLAYER_REPEL"), state);
    }
    const core = M.evaluate(view({ coreOwner: AMARR, presence: { [SANSHA]: 100 } }), repel(SANSHA), PARAMS);
    assert.deepStrictEqual([core.to, core.notes.includes("CORE_PROTECTED"), core.notes.includes("PLAYER_REPEL")],
      [S.CONTESTED, true, false]);
  });

  test("RP2 O1 fuzz with T.REPEL: every transition of evaluate (tick, battle, repel) is an edge of TRANSITIONS "
    + "with its trigger and keeps the invariants", () => {
    const rng = createRng(1860);
    const pick = (list) => list[Math.floor(rng.nextFloat() * list.length)];
    const factions = [AMARR, SANSHA, GURISTAS, null];
    let repelEdges = 0;
    for (let i = 0; i < 3000; i += 1) {
      const state = pick(S.OCCUPATION_STATES);
      const controller = pick(factions);
      let occupier = state === S.STABLE ? null : pick([AMARR, SANSHA, GURISTAS]);
      if (S.HELD_STATES.includes(state)) occupier = controller;
      if (S.CLAIM_STATES.includes(state) && occupier === controller) occupier = controller === SANSHA ? AMARR : SANSHA;
      if (S.HELD_STATES.includes(state) && occupier === null) continue;
      const presence = {};
      for (const f of [AMARR, SANSHA, GURISTAS]) if (rng.nextFloat() < 0.5) presence[f] = Math.floor(rng.nextFloat() * 200);
      const influence = {};
      for (const f of [AMARR, SANSHA, GURISTAS]) if (rng.nextFloat() < 0.6) influence[f] = Math.floor(rng.nextFloat() * 100);
      const v = view({ state, controller, occupier, presence, influence, range: [AMARR, SANSHA, GURISTAS].filter(
        () => rng.nextFloat() < 0.5), at: Math.floor(rng.nextFloat() * 30 * HOUR), capturedAt: rng.nextFloat() < 0.5 ? null : 0,
      coreOwner: rng.nextFloat() < 0.1 ? AMARR : null });
      const trigger = pick([{ kind: "tick" }, { kind: "battle", battleId: "b", winnerFactionId: pick(factions),
        loserFactionId: pick(factions) }, repel(pick([AMARR, SANSHA, GURISTAS]))]);
      const ev = M.evaluate(v, trigger, PARAMS);
      assert.ok(!ev.notes.some((n) => n.startsWith("EVALUATE_THREW")), JSON.stringify(ev.notes));
      if (ev.to === null) continue;
      const edge = M.TRANSITIONS.find((e) => e.from === state && e.to === ev.to);
      assert.ok(edge, `${state} -> ${ev.to}`);
      if (ev.notes.includes("PLAYER_REPEL")) {
        repelEdges += 1;
        assert.deepStrictEqual([state, ev.to, trigger.kind], [S.INVASION, S.CONTESTED, "repel"]);
        assert.ok(edge.triggers.includes(M.TRIGGERS.REPEL));
      }
    }
    assert.ok(repelEdges > 0, "the fuzz reached the repel edge");
  });

  needsDriver("RP3 applyPlayerRepelInTx on a real store: INVASION -> influence of P - 15 and the event "
    + "occ:<sys>:<seq>:r:<huntId> once; same key -> DUPLICATE (version kept); other faction -> NOT_CLAIMANT with no "
    + "write; flag off -> REPEL_DISABLED; the handler -> CONTESTED", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = bootRepel(reopen(), shared);
    assert.strictEqual(env.config.occupation.adjacencyGateEnabled, true);
    const sys = H.S.N5;
    assert.ok(env.tx((db) => env.repo.applyChange(db, { systemId: H.S.N6, expectedVersion: 0, reason: "SEED_CONTROL",
      state: { securityClass: "nullsec", controllerFactionId: SANSHA }, influence: [] }, "rp3:n6")).ok);
    seedInvasion(env, sys, GURISTAS, SANSHA, { [SANSHA]: 50, [GURISTAS]: 40 });
    const at = shared.clock.now();
    const spec = { systemId: sys, factionId: SANSHA, huntId: "ph:fl-x:3", characterId: 90000001, at };
    const claim = env.tx((db) => env.occupation.claimOfInTx(db, sys));
    assert.deepStrictEqual(claim, { ok: true, claim: { systemId: sys, state: S.INVASION, occupierFactionId: SANSHA,
      phaseSeq: 2 } });

    const before = rowsOf(env);
    const wrong = env.tx((db) => env.occupation.applyPlayerRepelInTx(db, { ...spec, factionId: GURISTAS },
      "phunt:ph:fl-x:3:repel"));
    assert.deepStrictEqual(wrong, { ok: false, reason: "NOT_CLAIMANT" });
    assert.deepStrictEqual(rowsOf(env), before, "a refusal writes nothing");

    const r = env.tx((db) => env.occupation.applyPlayerRepelInTx(db, spec, "phunt:ph:fl-x:3:repel"));
    assert.deepStrictEqual(r, { ok: true, outcome: "APPLIED", state: S.INVASION });
    const after = systemOf(env, sys);
    assert.deepStrictEqual([scoreOf(after, SANSHA), scoreOf(after, GURISTAS), after.occupationState], [35, 40,
      S.INVASION]);
    assert.strictEqual(keyCount(env, "world_scheduled_events", S.repelKey(sys, 2, "ph:fl-x:3")), 1);
    assert.strictEqual(keyCount(env, "world_event_journal", "phunt:ph:fl-x:3:repel"), 1);

    const again = env.tx((db) => env.occupation.applyPlayerRepelInTx(db, spec, "phunt:ph:fl-x:3:repel"));
    assert.deepStrictEqual(again, { ok: true, outcome: "DUPLICATE", state: null });
    assert.strictEqual(systemOf(env, sys).version, after.version, "a duplicate changes no row");

    const offCfg = configOf();
    assert.strictEqual(offCfg.occupation.playerRepelEnabled, false, "default off");
    const off = createOccupationService({ store: env.store, journal: env.journal, repository: env.repo,
      fleets: env.fleets, scheduler: env.scheduler, clock: shared.clock, config: offCfg, hostility: isHostile,
      powerTable: buildPowerTable(expandStrengthGroups(GROUPS)), getStations: () => null });
    assert.deepStrictEqual(env.tx((db) => off.applyPlayerRepelInTx(db, { ...spec, huntId: "ph:fl-y:1" },
      "phunt:ph:fl-y:1:repel")), { ok: false, reason: "REPEL_DISABLED" });

    await pass(env);
    const done = systemOf(env, sys);
    assert.deepStrictEqual([done.occupationState, done.occupierFactionId, done.phaseSeq], [S.CONTESTED, SANSHA, 3]);
    const counters = env.occupation.getStatus().counters;
    assert.deepStrictEqual([counters.playerRepelEvals, counters.playerRepelInterrupted], [1, 1]);
    const r2 = env.tx((db) => env.occupation.applyPlayerRepelInTx(db, { ...spec, huntId: "ph:fl-z:2" },
      "phunt:ph:fl-z:2:repel"));
    assert.deepStrictEqual(r2, { ok: true, outcome: "APPLIED", state: S.CONTESTED });
    await pass(env);
    assert.strictEqual(systemOf(env, sys).occupationState, S.CONTESTED);
    assert.deepStrictEqual(env.occupation.getStatus().counters.playerRepelInterrupted, 1);
  }));

  needsDriver("RP5 facade and stub: both have claimOfInTx and applyPlayerRepelInTx, the stub methods are a subset of "
    + "the facade methods, the stub refuses OCCUPATION_UNAVAILABLE; config keys in SCHEMA and .env.example",
  () => H.withStore(driver, async (reopen) => {
    const env = bootRepel(reopen(), H.sharedOf());
    const methods = (o) => Object.keys(o).filter((k) => typeof o[k] === "function").sort();
    const facade = methods(env.occupation);
    const stub = createUnavailableOccupation("OCCUPATION_DISABLED");
    for (const m of ["claimOfInTx", "applyPlayerRepelInTx"]) {
      assert.ok(facade.includes(m), `facade ${m}`);
      assert.ok(methods(stub).includes(m), `stub ${m}`);
    }
    assert.deepStrictEqual(methods(stub).filter((m) => !facade.includes(m)), []);
    const TX = { inTransaction: true };
    assert.strictEqual(stub.claimOfInTx(TX, 1).reason, "OCCUPATION_UNAVAILABLE");
    assert.strictEqual(stub.applyPlayerRepelInTx(TX, {}, "k").reason, "OCCUPATION_UNAVAILABLE");
    assert.strictEqual(env.occupation.claimOfInTx(null, 1).reason, "TX_REQUIRED");
    const keys = ["occupation.playerRepelEnabled", "occupation.repelPoints", "occupation.repelStates",
      "playerHunt.claimRepelLossPermille"];
    const rows = keys.map((k) => SCHEMA.find((row) => row.key === k));
    assert.deepStrictEqual(rows.map((row) => row && row.default), [false, 15, "CONTESTED,INVASION", 500]);
    const text = fs.readFileSync(ENV_EXAMPLE, "utf8");
    for (const row of rows) assert.ok(text.includes(`# ${row.env}=`), row.env);
    assert.deepStrictEqual([S.parseRepelStates("none"), S.parseRepelStates("INVASION,RECON"),
      S.parseRepelStates("OCCUPIED"), S.parseRepelStates("INVASION,INVASION")],
    [[], ["INVASION", "RECON"], null, null]);
    const bad = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(),
      EVEJS_LNE_OCCUPATION_REPEL_STATES: "OCCUPIED" } });
    assert.strictEqual(bad.config.occupation.repelStates, "CONTESTED,INVASION", "an invalid list keeps the default");
  }));
};

Object.assign(module.exports, { harness: Object.freeze({ bootRepel, seedInvasion, systemOf, scoreOf, keyCount,
  pass, configOf, SANSHA, GURISTAS }) });
