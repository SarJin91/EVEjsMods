"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const { startLiberation, createUnavailableLiberation } = require("../../lib/world/liberation");
const { killKey, checkKey, parsePayload, EVENT_TYPE } = require("../../lib/world/liberation/schema");
const { rateBucket, planKillDrop, planLiberationCheck, scoreOf: ruleScore } =
  require("../../lib/world/liberation/liberationRules");
const { startOccupation } = require("../../lib/world/occupation");
const { createRewardRepository } = require("../../lib/world/liberation/rewardRepository");
const { planInfluenceDrop, effectiveScores, stableDrift, driftHours } =
  require("../../lib/world/occupation/influenceRules");
const { createWorldStateRepository } = require("../../lib/world/worldStateRepository");
const { createViewRegistry } = require("../../lib/observer/views");
const { resolveConfig } = require("../../config");
const { harness: H } = require("../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const HOUR = 3600000;
const LIMITS = Object.freeze({ maxFactionsPerSystem: 8, maxBatchReadIds: 400, maxListLimit: 500 });

function configOf(env = {}) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } });
  assert.deepStrictEqual(r.errors || [], [], JSON.stringify(r.errors));
  return r.config;
}

function fakeStations(list) {
  return { getMode: () => "ready", repository: {
    countLiveBySystem(tx, ids) {
      const m = new Map();
      for (const s of list) {
        if (!ids.includes(s.systemId) || s.state === "DESTROYED") continue;
        const k = `${s.systemId}:${s.factionId}`;
        m.set(k, { systemId: s.systemId, factionId: s.factionId, count: ((m.get(k) || {}).count || 0) + 1 });
      }
      return { ok: true, rows: [...m.values()] };
    },
    listStationsOfFaction(tx, f, opts) {
      return { ok: true, records: list.filter((s) => s.factionId === f && (!opts || !opts.states
        || opts.states.includes(s.state))) };
    },
  } };
}

const M607_TEMPO = Object.freeze({ EVEJS_LNE_LIBERATION_KILL_INFLUENCE_POINTS: "1",
  EVEJS_LNE_LIBERATION_HOLD_MS: "3600000", EVEJS_LNE_LIBERATION_MAX_KILLS_PER_PLAYER_SYSTEM_HOUR: "20" });

function bootLib(opened, shared, stations, envOver, handlers, extra) {
  const config = configOf({ ...M607_TEMPO, ...envOver });
  const env = H.boot(opened, shared);
  const scheduler = handlers ? { ...env.scheduler, registerHandler(type, fn, o) {
    handlers.set(type, fn);
    return env.scheduler.registerHandler(type, fn, o);
  } } : env.scheduler;
  env.now = () => shared.clock.now();
  const repo = createWorldStateRepository({ journal: env.journal, clock: shared.clock, limits: LIMITS });
  const lines = [];
  const views = createViewRegistry();
  const r = startOccupation({ config, persistence: { ok: true, store: env.store, journal: env.journal },
    clock: shared.clock, scheduler: env.scheduler, fleets: env.fleets, world: { repository: repo },
    graph: { getGraph: () => ({ ok: true, graph: shared.graph }) }, getStations: () => stations, views,
    logger: { log: (l) => lines.push(l) }, nowMs: () => 0 });
  assert.ok(r.ok, JSON.stringify(r));
  const lib = startLiberation({ config, persistence: { ok: true, store: env.store, journal: env.journal },
    clock: shared.clock, scheduler, occupation: r.occupation, world: { repository: repo },
    graph: { getGraph: () => ({ ok: true, graph: shared.graph }) }, views,
    logger: { log: (l) => lines.push(l) }, nowMs: () => 0, ...(extra || {}) });
  assert.ok(lib.ok, JSON.stringify(lib));
  return { ...env, repo, occupation: r.occupation, liberation: lib.liberation, config, lines, views };
}

const contributionsOf = (env, id) => env.tx((db) => db.prepare(`SELECT controller_faction_id AS f,
  character_id AS c, kills FROM world_liberation_contributions WHERE system_id = ? ORDER BY character_id`).all(id));
const payoutsOf = (env, id) => env.tx((db) => db.prepare(`SELECT * FROM world_liberation_payouts WHERE system_id = ?
  ORDER BY character_id`).all(id));
const libpayJournal = (env) => env.tx((db) => db.prepare(`SELECT idempotency_key AS k, aggregate_type AS t,
  event_type AS e FROM world_event_journal WHERE idempotency_key LIKE 'libpay:%'`).all());

function seedSystem(env, systemId, controller, influence) {
  const r = env.tx((db) => env.repo.applyChange(db, { systemId, expectedVersion: 0, reason: "SEED_CONTROL",
    state: { securityClass: "nullsec", controllerFactionId: controller },
    influence: Object.entries(influence).map(([f, s]) => ({ factionId: Number(f), influenceScore: s })) },
  `world:seed:v1:${systemId}`));
  assert.ok(r.ok, JSON.stringify(r));
}

const systemOf = (env, id) => env.tx((db) => env.repo.getSystem(db, id)).system;
const scoreOf = (sys, f) => ((sys.influence || []).find((i) => i.factionId === f) || { influenceScore: 0 })
  .influenceScore;
const openChecks = (env, id) => env.tx((db) => db.prepare(`SELECT idempotency_key AS k FROM world_scheduled_events
  WHERE event_type = ? AND aggregate_id = ? AND state IN ('QUEUED', 'CLAIMED')`).all(EVENT_TYPE, String(id)));

function signal(env, systemId, factionId, sig, at, key) {
  return env.tx((db) => env.occupation.signalInTx(db, { systemId, factionId, signal: sig, at }, key));
}

async function passesAt(env, shared, at) {
  shared.clock.set(at);
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
  const { S, FACTION_A, FACTION_B } = H;

  test("L1r rules: planKillDrop only validates and returns the controller (score in occupation)", () => {
    const sys = { controllerFactionId: FACTION_B, influence: [{ factionId: FACTION_B, influenceScore: 60 }] };
    const kill = { characterId: 7, victimFactionId: FACTION_B, systemId: S.N5, atMs: 1000 };
    assert.deepStrictEqual(planKillDrop(kill, sys), { ok: true, controller: FACTION_B, target: FACTION_B,
      nonController: false });
    assert.strictEqual(planKillDrop({ ...kill, victimFactionId: FACTION_A }, sys).reason, "NOT_CONTROLLER");
    assert.strictEqual(planKillDrop(kill, null).reason, "NO_ROW");
    assert.strictEqual(planKillDrop(kill, { controllerFactionId: null, influence: [] }).reason, "NO_CONTROLLER");
    assert.strictEqual(planKillDrop({ ...kill, characterId: 0 }, sys).reason, "KILL_INVALID_INPUT");
  });

  test("NC3 rules: planKillDrop with opts.nonController - controller target, non-controller row, no controller", () => {
    const sys = { controllerFactionId: FACTION_A, influence: [{ factionId: FACTION_A, influenceScore: 0 },
      { factionId: FACTION_B, influenceScore: 100 }] };
    const kill = { characterId: 7, victimFactionId: FACTION_A, systemId: S.N5, atMs: 1000 };
    const nc = { nonController: true };
    assert.deepStrictEqual(planKillDrop(kill, sys, nc), { ok: true, controller: FACTION_A, target: FACTION_A,
      nonController: false });
    assert.deepStrictEqual(planKillDrop({ ...kill, victimFactionId: FACTION_B }, sys, nc), { ok: true,
      controller: FACTION_A, target: FACTION_B, nonController: true });
    assert.deepStrictEqual(planKillDrop({ ...kill, victimFactionId: FACTION_B }, { ...sys, controllerFactionId: null },
      nc), { ok: true, controller: null, target: FACTION_B, nonController: true });
    assert.strictEqual(planKillDrop({ ...kill, victimFactionId: FACTION_B }, sys).reason, "NOT_CONTROLLER");
    assert.strictEqual(planKillDrop({ ...kill, victimFactionId: 500099 }, sys, nc).reason, "NOT_CONTROLLER",
      "no influence row -> refusal");
  });

  test("N1 rules: planInfluenceDrop drifts, drops and banks the anchor by whole 0.01 steps; effectiveScores", () => {
    const P = { stableBaselineScore: 60, stableRecoverPointsPerHour: 1, stableForeignDecayPointsPerHour: 1,
      stableForeignFloorScore: 0 };
    const at = 100 * HOUR;
    const row = (state, anchor, inf) => ({ occupationState: state, controllerFactionId: FACTION_B,
      influenceEvaluatedAt: anchor, influence: Object.entries(inf).map(([f, s]) => ({ factionId: Number(f),
        influenceScore: s })) });
    const drop = (sys, points = 1, t = at, f = FACTION_B) => planInfluenceDrop(sys, { factionId: f, points, at: t }, P);
    const a = drop(row("STABLE", at - 5 * HOUR, { [FACTION_B]: 50, [FACTION_A]: 20 }));
    assert.deepStrictEqual([a.before, a.next, a.statePatch, a.drifted, a.banked], [55, 54,
      { influenceEvaluatedAt: at }, 2, false]);
    assert.deepStrictEqual(a.influence, [{ factionId: FACTION_A, influenceScore: 15 },
      { factionId: FACTION_B, influenceScore: 54 }].sort((x, y) => x.factionId - y.factionId));
    const b1 = drop(row("STABLE", at - 10000, { [FACTION_B]: 50 }));
    assert.deepStrictEqual([b1.drifted, b1.statePatch, b1.banked, b1.next], [0, {}, true, 49]);
    const b2 = drop(row("STABLE", at - 50000, { [FACTION_B]: 50 }));
    assert.deepStrictEqual([b2.before, b2.next, b2.statePatch, b2.banked], [50.01, 49.01,
      { influenceEvaluatedAt: at - 50000 + 36000 }, true]);
    const c = drop(row("CONTESTED", at - 5 * HOUR, { [FACTION_B]: 50, [FACTION_A]: 20 }));
    assert.deepStrictEqual([c.before, c.next, c.statePatch, c.drifted, c.influence], [50, 49, {}, 0,
      [{ factionId: FACTION_B, influenceScore: 49 }]]);
    const d = drop(row("CONTESTED", null, { [FACTION_A]: 20 }));
    assert.deepStrictEqual([d.before, d.next, d.influence], [0, 0, []]);
    assert.strictEqual(drop(row("CONTESTED", null, { [FACTION_B]: 0.5 })).next, 0);
    let sys = row("STABLE", at, { [FACTION_B]: 50 });
    for (let i = 1; i <= 400; i += 1) {
      const s = drop(sys, 0.01, at + i * 9000);
      sys = { ...sys, influenceEvaluatedAt: s.statePatch.influenceEvaluatedAt === undefined ? sys.influenceEvaluatedAt
        : s.statePatch.influenceEvaluatedAt, influence: sys.influence.map((x) => {
        const e = s.influence.find((y) => y.factionId === x.factionId);
        return e ? { ...x, influenceScore: e.influenceScore } : x;
      }) };
    }
    assert.strictEqual(sys.influence[0].influenceScore, 47, "a naive anchor = at would freeze the drift (46)");
    const st = row("STABLE", at - 3 * HOUR, { [FACTION_B]: 50, [FACTION_A]: 20 });
    const raw = new Map([[FACTION_B, 50], [FACTION_A, 20]]);
    const expected = new Map(raw);
    for (const e of stableDrift(raw, FACTION_B, driftHours(at - 3 * HOUR, at), P)) expected.set(e.factionId,
      e.influenceScore);
    assert.deepStrictEqual(effectiveScores(st, at, P), expected);
    assert.deepStrictEqual([effectiveScores(st, at, P).get(FACTION_B), effectiveScores(st, at, P).get(FACTION_A)],
      [53, 17]);
    assert.deepStrictEqual(effectiveScores({ ...st, occupationState: "CONTESTED" }, at, P), raw);
  });

  test("L2r rules: the check hysteresis boundary and the keys/bucket/payload", () => {
    const params = { minControllerScore: 25 };
    assert.deepStrictEqual(planLiberationCheck(24.99, params), { liberate: true, reason: "BELOW_THRESHOLD" });
    assert.deepStrictEqual(planLiberationCheck(25, params), { liberate: false, reason: "RECOVERED" });
    assert.deepStrictEqual(planLiberationCheck(NaN, params), { liberate: true, reason: "BELOW_THRESHOLD" });
    assert.strictEqual(rateBucket(HOUR * 3 + 5), 3);
    assert.strictEqual(killKey(30000001, 7, 500001, 123), "libkill:30000001:7:500001:123");
    assert.strictEqual(checkKey(30000001, 4, HOUR * 3 + 5), "lib:30000001:4:t:3");
    assert.deepStrictEqual(parsePayload({ systemId: 1, seq: 0, bucket: 5 }), { systemId: 1, seq: 0, bucket: 5 });
    assert.deepStrictEqual(parsePayload({ systemId: 1, seq: 0, dueAt: HOUR * 2 + 5 }), { systemId: 1, seq: 0,
      bucket: 2 }, "the pre-review shape is still read");
    assert.strictEqual(parsePayload({ systemId: 1, seq: 0 }), null);
    assert.strictEqual(parsePayload({ systemId: 1, seq: 0, bucket: 5, dueAt: 5 }), null);
    assert.strictEqual(parsePayload({ systemId: 1, seq: 0, bucket: 5, extra: 1 }), null);
    assert.strictEqual(parsePayload(null), null);
    assert.deepStrictEqual(ruleScore({ influence: [{ factionId: 3, influenceScore: 7 }] }, 3), 7);
  });

  test("OR-C3 view: more rows than maxRows -> truncated, exactly maxRows -> not; countersSinceStart", () => {
    const { buildLiberationView } = require("../../lib/world/liberation/liberationView");
    const viewOf = (n) => {
      const systems = Array.from({ length: n }, (_v, i) => ({ systemId: i + 1, previousControllerFactionId: 500001,
        lastStateChangeAt: 0, phaseSeq: 1 }));
      return buildLiberationView({ store: { isOpen: () => true, transaction: (_n, fn) => ({ ok: true, value: fn(null) }) },
        repository: { listLiberated: (_db, o) => ({ ok: true, systems: systems.slice(0, o.limit) }) },
        getStatus: () => ({ state: "running", counters: { liberated: 0 } }), maxRows: 2 });
    };
    const exact = viewOf(2).getData();
    assert.strictEqual(viewOf(2).title, "Abandoned systems (no controller)");
    assert.deepStrictEqual([exact.truncated, exact.countersSinceStart, exact.liberated.length], [false, { liberated: 0 }, 2]);
    const more = viewOf(3).getData();
    assert.deepStrictEqual([more.truncated, more.liberated.length], [true, 2]);
  });

  test("L6 disabled: liberation.enabled / occupation.enabled off -> disabled_by_config; unavailable refuses", () => {
    const r1 = startLiberation({ config: configOf({ EVEJS_LNE_LIBERATION_ENABLED: "false" }), persistence: null,
      clock: { now: () => 0 }, scheduler: null });
    assert.deepStrictEqual([r1.ok, r1.reason], [false, "disabled_by_config"]);
    const r2 = startLiberation({ config: configOf({ EVEJS_LNE_OCCUPATION_ENABLED: "false" }), persistence: null,
      clock: { now: () => 0 }, scheduler: null });
    assert.deepStrictEqual([r2.ok, r2.reason], [false, "disabled_by_config"]);
    const dead = createUnavailableLiberation("LIBERATION_DISABLED");
    const r3 = dead.onNpcKill({ characterId: 1, victimFactionId: 2, systemId: 3, atMs: 4 });
    assert.deepStrictEqual([r3.ok, r3.reason], [false, "LIBERATION_DISABLED"]);
  });

  test("LRW6: payoutRetentionMs below rewardSystemCooldownMs warns; the defaults do not", () => {
    const has = (w) => w.some((s) => s.startsWith("liberation.payoutRetentionMs="));
    const defaults = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir() } });
    assert.ok(!has(defaults.warnings), defaults.warnings.join("\n"));
    const bad = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(),
      EVEJS_LNE_LIBERATION_PAYOUT_RETENTION_MS: String(24 * HOUR),
      EVEJS_LNE_LIBERATION_REWARD_SYSTEM_COOLDOWN_MS: String(48 * HOUR) } });
    assert.ok(bad.warnings.some((s) => s.startsWith(`liberation.payoutRetentionMs=${24 * HOUR} below `
      + `liberation.rewardSystemCooldownMs=${48 * HOUR}`)), bad.warnings.join("\n"));
  });

  needsDriver("L1 kill of a non-controller faction (switch off) -> NOT_CONTROLLER, influence untouched", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = bootLib(reopen(), shared, fakeStations([]),
        { EVEJS_LNE_LIBERATION_NON_CONTROLLER_KILLS_ENABLED: "false" });
      seedSystem(env, S.N5, FACTION_B, { [FACTION_B]: 60, [FACTION_A]: 20 });
      const base = shared.clock.now();
      const v0 = systemOf(env, S.N5).version;
      const r = env.liberation.onNpcKill({ characterId: 7, victimFactionId: FACTION_A, systemId: S.N5, atMs: base });
      assert.deepStrictEqual([r.ok, r.outcome], [true, "NOT_CONTROLLER"], JSON.stringify(r));
      assert.deepStrictEqual([scoreOf(systemOf(env, S.N5), FACTION_A), systemOf(env, S.N5).version], [20, v0]);
      assert.strictEqual(scoreOf(systemOf(env, S.N5), FACTION_B), 60);
      assert.strictEqual(env.liberation.getStatus().counters.notController, 1);
      const noRow = env.liberation.onNpcKill({ characterId: 7, victimFactionId: FACTION_B, systemId: 99999999,
        atMs: base });
      assert.deepStrictEqual([noRow.ok, noRow.outcome], [true, "NO_ROW"], JSON.stringify(noRow));
      assert.strictEqual(env.liberation.getStatus().counters.noRow, 1);
    }));

  needsDriver("NC1 kill of a non-controller with a row -> APPLIED nonController (97.5), no check, redelivery DUPLICATE",
    () => H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = bootLib(reopen(), shared, fakeStations([]));
      seedSystem(env, S.N5, FACTION_A, { [FACTION_A]: 0, [FACTION_B]: 100 });
      const base = shared.clock.now();
      const kill = { characterId: 7, victimFactionId: FACTION_B, systemId: S.N5, atMs: base, victimId: 41 };
      const r = env.liberation.onNpcKill(kill);
      assert.deepStrictEqual([r.ok, r.outcome, r.nonController, r.nextScore, r.checkScheduled],
        [true, "APPLIED", true, 97.5, false], JSON.stringify(r));
      const sys = systemOf(env, S.N5);
      assert.deepStrictEqual([scoreOf(sys, FACTION_B), scoreOf(sys, FACTION_A), sys.controllerFactionId],
        [97.5, 0, FACTION_A]);
      assert.strictEqual(openChecks(env, S.N5).length, 0, "no LIBERATION_CHECK for a non-controller");
      const again = env.liberation.onNpcKill(kill);
      assert.deepStrictEqual([again.ok, again.outcome], [true, "DUPLICATE"], JSON.stringify(again));
      assert.strictEqual(systemOf(env, S.N5).version, sys.version);
      const st = env.liberation.getStatus().counters;
      assert.deepStrictEqual([st.nonControllerApplied, st.applied, st.duplicates, st.notController], [1, 0, 1, 0]);
    }));

  needsDriver("NC2 virtual kill with permille 0 and a victim without a row -> NOT_CONTROLLER, row version unchanged",
    () => H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = bootLib(reopen(), shared, fakeStations([]));
      seedSystem(env, S.N5, FACTION_A, { [FACTION_A]: 0, [FACTION_B]: 100 });
      const base = shared.clock.now();
      const v0 = systemOf(env, S.N5).version;
      const virt = env.liberation.onNpcKill({ characterId: 7, victimFactionId: FACTION_B, systemId: S.N5, atMs: base,
        virtual: true });
      assert.deepStrictEqual([virt.ok, virt.outcome], [true, "NOT_CONTROLLER"], JSON.stringify(virt));
      const noRow = env.liberation.onNpcKill({ characterId: 7, victimFactionId: 500099, systemId: S.N5,
        atMs: base + 1 });
      assert.deepStrictEqual([noRow.ok, noRow.outcome], [true, "NOT_CONTROLLER"], JSON.stringify(noRow));
      const sys = systemOf(env, S.N5);
      assert.deepStrictEqual([sys.version, scoreOf(sys, FACTION_B)], [v0, 100]);
      const st = env.liberation.getStatus().counters;
      assert.deepStrictEqual([st.notController, st.nonControllerApplied], [2, 0]);
    }));

  needsDriver("L2 kill of the controller lowers influence exactly once: apply, retry -> DUPLICATE, one check", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = bootLib(reopen(), shared, fakeStations([]));
      seedSystem(env, S.N5, FACTION_B, { [FACTION_B]: 60, [FACTION_A]: 20 });
      const base = shared.clock.now();
      const kill = { characterId: 7, victimFactionId: FACTION_B, systemId: S.N5, atMs: base };
      const r1 = env.liberation.onNpcKill(kill);
      assert.deepStrictEqual([r1.ok, r1.outcome, r1.nextScore], [true, "APPLIED", 59], JSON.stringify(r1));
      const first = systemOf(env, S.N5);
      assert.deepStrictEqual([scoreOf(first, FACTION_B), first.influenceEvaluatedAt], [59, base],
        "The first kill of a seed row starts the drift clock at the kill");
      const r2 = env.liberation.onNpcKill(kill);
      assert.deepStrictEqual([r2.ok, r2.outcome], [true, "DUPLICATE"], JSON.stringify(r2));
      const again = systemOf(env, S.N5);
      assert.deepStrictEqual([scoreOf(again, FACTION_B), again.influenceEvaluatedAt, again.version],
        [59, base, first.version], "a duplicate changes nothing");
      const st = env.liberation.getStatus().counters;
      assert.deepStrictEqual([st.applied, st.duplicates], [1, 1]);
      assert.strictEqual(openChecks(env, S.N5).length, 0, "score 59 is above the default threshold 25");
      const pulse = (victimId) => env.liberation.onNpcKill({ ...kill, atMs: base + 1, victimId }).outcome;
      assert.deepStrictEqual([pulse(101), pulse(102), pulse(103), pulse(101)],
        ["APPLIED", "APPLIED", "APPLIED", "DUPLICATE"]);
      assert.strictEqual(scoreOf(systemOf(env, S.N5), FACTION_B), 56);
      assert.strictEqual(env.liberation.onNpcKill({ ...kill, victimId: 999 }).outcome, "DUPLICATE", "legacy key");
      assert.strictEqual(killKey(1, 7, 500001, 123, 55), "libkill:1:7:500001:123.55");
    }));

  needsDriver("L3 limit: the kills of one player+system+hour are capped, the next bucket counts again", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = bootLib(reopen(), shared, fakeStations([]),
        { EVEJS_LNE_LIBERATION_MAX_KILLS_PER_PLAYER_SYSTEM_HOUR: "2" });
      seedSystem(env, S.N5, FACTION_B, { [FACTION_B]: 60 });
      const base = shared.clock.now();
      const of = (atMs) => env.liberation.onNpcKill({ characterId: 7, victimFactionId: FACTION_B, systemId: S.N5,
        atMs });
      assert.strictEqual(of(base).outcome, "APPLIED");
      assert.strictEqual(of(base + 1).outcome, "APPLIED");
      assert.strictEqual(of(base + 2).outcome, "RATE_LIMITED");
      assert.strictEqual(scoreOf(systemOf(env, S.N5), FACTION_B), 58, "the limited kill wrote nothing");
      assert.strictEqual(of(base + HOUR).outcome, "APPLIED", "a new hour bucket counts again");
      assert.strictEqual(scoreOf(systemOf(env, S.N5), FACTION_B), 58,
        "58 + 1 h of STABLE recovery (1 pt/h) - 1");
      const st = env.liberation.getStatus().counters;
      assert.deepStrictEqual([st.applied, st.rateLimited], [3, 1]);
    }));

  needsDriver("L4 check: enqueued only while the score stays below the threshold (due at +holdMs)", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = bootLib(reopen(), shared, fakeStations([]),
        { EVEJS_LNE_LIBERATION_MIN_CONTROLLER_SCORE: "50" });
      seedSystem(env, S.N5, FACTION_B, { [FACTION_B]: 60 });
      seedSystem(env, S.N0, FACTION_A, { [FACTION_A]: 60 });
      const base = shared.clock.now();
      const ofB = (i) => env.liberation.onNpcKill({ characterId: 7, victimFactionId: FACTION_B, systemId: S.N5,
        atMs: base + i });
      for (let i = 0; i < 9; i += 1) assert.strictEqual(ofB(i).outcome, "APPLIED");
      assert.strictEqual(openChecks(env, S.N5).length, 0, "51 >= 50: no check yet");
      assert.deepStrictEqual(ofB(9).checkScheduled, false, "50 >= 50: still no check");
      const last = ofB(10);
      assert.deepStrictEqual([last.outcome, last.nextScore, last.checkScheduled], ["APPLIED", 49, true]);
      assert.deepStrictEqual(openChecks(env, S.N5).map((e) => e.k),
        [checkKey(S.N5, 0, base + 10 + 3600000)], JSON.stringify(openChecks(env, S.N5)));
      const above = env.liberation.onNpcKill({ characterId: 8, victimFactionId: FACTION_A, systemId: S.N0,
        atMs: base });
      assert.deepStrictEqual([above.outcome, above.checkScheduled], ["APPLIED", false]);
      assert.strictEqual(openChecks(env, S.N0).length, 0, "59 >= 50: no check for the untouched controller");
    }));

  needsDriver("L4b window: more kills below the threshold in one hour window all apply, one check (open or DONE)", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = bootLib(reopen(), shared, fakeStations([]),
        { EVEJS_LNE_LIBERATION_MIN_CONTROLLER_SCORE: "50" });
      seedSystem(env, S.N5, FACTION_B, { [FACTION_B]: 60 });
      const t0 = (rateBucket(shared.clock.now()) + 1) * HOUR + 1000;
      const kill = (i, characterId = 7) => env.liberation.onNpcKill({ characterId, victimFactionId: FACTION_B,
        systemId: S.N5, atMs: t0 + i });
      for (let i = 0; i <= 10; i += 1) assert.strictEqual(kill(i).outcome, "APPLIED");
      for (let i = 11; i <= 13; i += 1) {
        const r = kill(i, 8);
        assert.deepStrictEqual([r.ok, r.outcome, r.checkScheduled], [true, "APPLIED", true], JSON.stringify(r));
      }
      assert.strictEqual(scoreOf(systemOf(env, S.N5), FACTION_B), 46, "14 kills, each counted once");
      assert.deepStrictEqual(openChecks(env, S.N5).map((e) => e.k), [checkKey(S.N5, 0, t0 + HOUR)]);
      assert.strictEqual(env.liberation.getStatus().counters.txFailed, 0);
      const sys = systemOf(env, S.N5);
      const lift = env.tx((db) => env.repo.applyChange(db, { systemId: S.N5, expectedVersion: sys.version,
        reason: "TEST_DRIFT", state: {}, influence: [{ factionId: FACTION_B, influenceScore: 50.5 }] },
      "test:lift:v1"));
      assert.ok(lift.ok, JSON.stringify(lift));
      await passesAt(env, shared, t0 + 10 + HOUR);
      const done = env.tx((db) => db.prepare(`SELECT state FROM world_scheduled_events WHERE idempotency_key = ?`)
        .get(checkKey(S.N5, 0, t0 + HOUR)));
      assert.strictEqual(done.state, "DONE", JSON.stringify(done));
      assert.strictEqual(env.liberation.getStatus().counters.recovered, 1);
      const late = kill(20, 9);
      assert.deepStrictEqual([late.ok, late.outcome, late.nextScore], [true, "APPLIED", 49.5], JSON.stringify(late));
      assert.strictEqual(scoreOf(systemOf(env, S.N5), FACTION_B), 49.5);
      assert.strictEqual(openChecks(env, S.N5).length, 0, "the DONE check of this window is a duplicate");
      const st = env.liberation.getStatus().counters;
      assert.deepStrictEqual([st.applied, st.txFailed], [15, 0]);
    }));

  needsDriver("L5 fire: the check frees the system exactly once (STABLE, controller null, panel lists it)", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = bootLib(reopen(), shared, fakeStations([]),
        { EVEJS_LNE_LIBERATION_MIN_CONTROLLER_SCORE: "50" });
      seedSystem(env, S.N5, FACTION_B, { [FACTION_B]: 60 });
      const base = shared.clock.now();
      for (let i = 0; i <= 11; i += 1) {
        const r = env.liberation.onNpcKill({ characterId: 7, victimFactionId: FACTION_B, systemId: S.N5,
          atMs: base + i });
        assert.strictEqual(r.outcome, "APPLIED", JSON.stringify(r));
      }
      const dueAt = base + 10 + 3600000;
      await passesAt(env, shared, dueAt);
      const freed = systemOf(env, S.N5);
      assert.deepStrictEqual([freed.occupationState, freed.controllerFactionId, freed.previousControllerFactionId],
        ["STABLE", null, FACTION_B], JSON.stringify(freed));
      assert.strictEqual(env.liberation.getStatus().counters.liberated, 1);
      await passesAt(env, shared, dueAt + 60000);
      assert.strictEqual(env.liberation.getStatus().counters.liberated, 1, "the second pass changes nothing");
      assert.strictEqual(openChecks(env, S.N5).length, 0);
      const panel = env.views.getView("liberation").getData();
      assert.strictEqual(panel.available, true, JSON.stringify(panel));
      assert.deepStrictEqual(panel.liberated.map((s) => s.systemId), [S.N5], JSON.stringify(panel));
      assert.strictEqual(panel.liberated[0].previousController, String(FACTION_B));
      assert.strictEqual(panel.countersSinceStart.liberated, 1, JSON.stringify(panel));
      assert.strictEqual(panel.counters, undefined);
      assert.strictEqual(panel.truncated, false);
    }));

  needsDriver("L5b hysteresis: a recovered influence cancels the check (RECOVERED, controller kept)", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = bootLib(reopen(), shared, fakeStations([]),
        { EVEJS_LNE_LIBERATION_MIN_CONTROLLER_SCORE: "50" });
      seedSystem(env, S.N0, FACTION_A, { [FACTION_A]: 60 });
      const base = shared.clock.now();
      for (let i = 0; i <= 10; i += 1) {
        env.liberation.onNpcKill({ characterId: 9, victimFactionId: FACTION_A, systemId: S.N0, atMs: base + i });
      }
      const sys = systemOf(env, S.N0);
      const drift = env.tx((db) => env.repo.applyChange(db, { systemId: S.N0, expectedVersion: sys.version,
        reason: "TEST_DRIFT", state: {},
        influence: [{ factionId: FACTION_A, influenceScore: 55 }] }, "test:drift:v1"));
      assert.ok(drift.ok, JSON.stringify(drift));
      await passesAt(env, shared, base + 10 + 3600000);
      const kept = systemOf(env, S.N0);
      assert.deepStrictEqual([kept.occupationState, kept.controllerFactionId], ["STABLE", FACTION_A]);
      const st = env.liberation.getStatus().counters;
      assert.deepStrictEqual([st.recovered, st.liberated], [1, 0]);
    }));

  needsDriver("L5c conflict: a CONTESTED system is not freed (IN_PROGRESS), no retry storm", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const stations = fakeStations([{ stationId: "st:a", systemId: S.N0, factionId: FACTION_A, state: "ONLINE" }]);
      const env = bootLib(reopen(), shared, stations,
        { EVEJS_LNE_LIBERATION_MIN_CONTROLLER_SCORE: "50" });
      seedSystem(env, S.N5, FACTION_B, { [FACTION_B]: 60 });
      const base = shared.clock.now();
      const sig = signal(env, S.N5, FACTION_A, "INVASION", base, "test:sig:lib");
      assert.deepStrictEqual([sig.ok, sig.state], [true, "CONTESTED"], JSON.stringify(sig));
      for (let i = 0; i <= 10; i += 1) {
        env.liberation.onNpcKill({ characterId: 7, victimFactionId: FACTION_B, systemId: S.N5, atMs: base + i });
      }
      await passesAt(env, shared, base + 10 + 3600000);
      const sys = systemOf(env, S.N5);
      assert.deepStrictEqual([sys.occupationState, sys.controllerFactionId], ["CONTESTED", FACTION_B],
        JSON.stringify(sys));
      assert.strictEqual(env.liberation.getStatus().counters.inProgress, 1);
      assert.strictEqual(env.liberation.getStatus().counters.liberated, 0);
    }));

  needsDriver("L9 restart: the queued check survives the reopen and frees the system after it", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const stations = fakeStations([]);
      const env = bootLib(reopen(), shared, stations,
        { EVEJS_LNE_LIBERATION_MIN_CONTROLLER_SCORE: "50" });
      seedSystem(env, S.N5, FACTION_B, { [FACTION_B]: 60 });
      const base = shared.clock.now();
      for (let i = 0; i <= 11; i += 1) {
        env.liberation.onNpcKill({ characterId: 7, victimFactionId: FACTION_B, systemId: S.N5, atMs: base + i });
      }
      const dueAt = base + 10 + 3600000;
      assert.strictEqual(openChecks(env, S.N5).length, 1);
      const before = systemOf(env, S.N5);
      env.occupation.stop("restart");
      env.liberation.stop("restart");
      env.store.close("restart");
      const env2 = bootLib(reopen(), shared, stations,
        { EVEJS_LNE_LIBERATION_MIN_CONTROLLER_SCORE: "50" });
      assert.strictEqual(systemOf(env2, S.N5).controllerFactionId, FACTION_B, "still occupied after the reopen");
      const dup = env2.liberation.onNpcKill({ characterId: 7, victimFactionId: FACTION_B, systemId: S.N5,
        atMs: base + 11 });
      assert.deepStrictEqual([dup.ok, dup.outcome], [true, "DUPLICATE"], JSON.stringify(dup));
      const after = systemOf(env2, S.N5);
      assert.deepStrictEqual([scoreOf(after, FACTION_B), after.influenceEvaluatedAt, after.version],
        [scoreOf(before, FACTION_B), before.influenceEvaluatedAt, before.version]);
      await passesAt(env2, shared, dueAt);
      const freed = systemOf(env2, S.N5);
      assert.deepStrictEqual([freed.occupationState, freed.controllerFactionId, freed.previousControllerFactionId],
        ["STABLE", null, FACTION_B], JSON.stringify(freed));
      assert.strictEqual(env2.liberation.getStatus().counters.liberated, 1);
    }));

  needsDriver("N2 an AI signal on a system with an old anchor keeps the players' contribution", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const stations = fakeStations([{ stationId: "st:a", systemId: S.N0, factionId: FACTION_A, state: "ONLINE" }]);
      const env = bootLib(reopen(), shared, stations);
      const base = shared.clock.now();
      seedSystem(env, S.N5, FACTION_B, { [FACTION_B]: 59, [FACTION_A]: 20 });
      const seeded = systemOf(env, S.N5);
      const anchored = env.tx((db) => env.repo.applyChange(db, { systemId: S.N5, expectedVersion: seeded.version,
        reason: "TEST_ANCHOR", state: { influenceEvaluatedAt: base - 24 * HOUR } }, "test:anchor:n2"));
      assert.ok(anchored.ok, JSON.stringify(anchored));
      for (let i = 0; i <= 10; i += 1) {
        const r = env.liberation.onNpcKill({ characterId: 7, victimFactionId: FACTION_B, systemId: S.N5,
          atMs: base + i });
        assert.strictEqual(r.outcome, "APPLIED", JSON.stringify(r));
      }
      const killed = systemOf(env, S.N5);
      assert.deepStrictEqual([scoreOf(killed, FACTION_B), scoreOf(killed, FACTION_A), killed.influenceEvaluatedAt],
        [49, 0, base], JSON.stringify(killed));
      assert.strictEqual(env.occupation.getStatus().counters.stableDrift, 1, "only the first kill drifted rows");
      const sig = signal(env, S.N5, FACTION_A, "INVASION", base + 60000, "test:sig:n2");
      assert.deepStrictEqual([sig.ok, sig.state], [true, "CONTESTED"], JSON.stringify(sig));
      assert.strictEqual(scoreOf(systemOf(env, S.N5), FACTION_B), 49.02);
    }));

  needsDriver("N3 the check sees the drift recovery (RECOVERED) and writes the former controller what it saw", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = bootLib(reopen(), shared, fakeStations([]), { EVEJS_LNE_LIBERATION_MIN_CONTROLLER_SCORE: "50" });
      seedSystem(env, S.N5, FACTION_B, { [FACTION_B]: 60 });
      seedSystem(env, S.N0, FACTION_A, { [FACTION_A]: 60 });
      const base = shared.clock.now();
      for (let i = 0; i <= 10; i += 1) {
        env.liberation.onNpcKill({ characterId: 7, victimFactionId: FACTION_B, systemId: S.N5, atMs: base + i });
      }
      for (let i = 0; i <= 11; i += 1) {
        env.liberation.onNpcKill({ characterId: 8, victimFactionId: FACTION_A, systemId: S.N0, atMs: base + i });
      }
      assert.deepStrictEqual([scoreOf(systemOf(env, S.N5), FACTION_B), scoreOf(systemOf(env, S.N0), FACTION_A)],
        [49, 48]);
      await passesAt(env, shared, base + 10 + HOUR);
      const kept = systemOf(env, S.N5);
      assert.deepStrictEqual([kept.occupationState, kept.controllerFactionId], ["STABLE", FACTION_B],
        "49 + 1 h of recovery = 50 >= 50 -> RECOVERED");
      const freed = systemOf(env, S.N0);
      assert.deepStrictEqual([freed.occupationState, freed.controllerFactionId, freed.previousControllerFactionId,
        scoreOf(freed, FACTION_A)], ["STABLE", null, FACTION_A, 49], JSON.stringify(freed));
      const st = env.liberation.getStatus().counters;
      assert.deepStrictEqual([st.recovered, st.liberated], [1, 1]);
    }));

  needsDriver("L10 core protected: abandonInTx CORE_PROTECTED -> ok outcome CORE_PROTECTED, coreProtected counter, no abandonRefused", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const stations = fakeStations([{ stationId: "st:amarr", systemId: S.N0, factionId: FACTION_A, state: "ONLINE" }]);

      const mockCoreIndex = {
        enabled: true,
        systems: new Map([[S.N0, FACTION_A]]),
        stations: new Map(),
        byFaction: new Map(),
        version: 1
      };

      const config = configOf({ EVEJS_LNE_LIBERATION_MIN_CONTROLLER_SCORE: "50" });
      const env = H.boot(reopen(), shared);
      env.now = () => shared.clock.now();
      const repo = createWorldStateRepository({ journal: env.journal, clock: shared.clock, limits: LIMITS });
      const lines = [];
      const views = createViewRegistry();
      const r = startOccupation({ config, persistence: { ok: true, store: env.store, journal: env.journal },
        clock: shared.clock, scheduler: env.scheduler, fleets: env.fleets, world: { repository: repo },
        graph: { getGraph: () => ({ ok: true, graph: shared.graph }) }, getStations: () => stations, views,
        logger: { log: (l) => lines.push(l) }, nowMs: () => 0, coreIndex: mockCoreIndex });
      assert.ok(r.ok, JSON.stringify(r));
      const lib = startLiberation({ config, persistence: { ok: true, store: env.store, journal: env.journal },
        clock: shared.clock, scheduler: env.scheduler, occupation: r.occupation, world: { repository: repo },
        graph: { getGraph: () => ({ ok: true, graph: shared.graph }) }, views,
        logger: { log: (l) => lines.push(l) }, nowMs: () => 0 });
      assert.ok(lib.ok, JSON.stringify(lib));
      const testEnv = { ...env, repo, occupation: r.occupation, liberation: lib.liberation, config, lines, views };
      testEnv.now = () => shared.clock.now();

      seedSystem(testEnv, S.N0, FACTION_A, { [FACTION_A]: 60 });

      const base = shared.clock.now();
      for (let i = 0; i <= 11; i += 1) {
        testEnv.liberation.onNpcKill({ characterId: 7, victimFactionId: FACTION_A, systemId: S.N0, atMs: base + i });
      }

      await passesAt(testEnv, shared, base + 10 + 3600000);

      const status = testEnv.liberation.getStatus();
      assert.strictEqual(status.counters.coreProtected, 1, "coreProtected counter should be 1");
      assert.strictEqual(status.counters.abandonRefused, 0, "abandonRefused counter should be 0");
      assert.strictEqual(status.counters.liberated, 0, "liberated counter should be 0 (core not freed)");
      assert.strictEqual(status.counters.inProgress, 0, "inProgress counter should be 0");

      const sys = systemOf(testEnv, S.N0);
      assert.strictEqual(sys.occupationState, "STABLE", "Core should remain STABLE");
      assert.strictEqual(sys.controllerFactionId, FACTION_A, "Core controller should remain FACTION_A");
    }));

  const killsOf = (env, base, list) => list.map(([characterId, rewardable], i) => env.liberation.onNpcKill({
    characterId, victimFactionId: FACTION_B, systemId: S.N5, atMs: base + i, ...(rewardable ? { rewardable } : {}) }));

  needsDriver("LR1 rewards: a rewardable kill records the contribution (a plain one not), the liberation plans the "
    + "payouts once (1 journal row, PENDING rows), a repeated handler adds nothing", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const handlers = new Map();
      const env = bootLib(reopen(), shared, fakeStations([]), { EVEJS_LNE_LIBERATION_MIN_CONTROLLER_SCORE: "50" },
        handlers);
      seedSystem(env, S.N5, FACTION_B, { [FACTION_B]: 60 });
      const base = shared.clock.now();
      const list = [...Array(8).fill([7, true]), ...Array(3).fill([8, true]), [9, true], [10, false]];
      for (const r of killsOf(env, base, list)) assert.strictEqual(r.outcome, "APPLIED", JSON.stringify(r));
      assert.deepStrictEqual(contributionsOf(env, S.N5), [{ f: FACTION_B, c: 7, kills: 8 },
        { f: FACTION_B, c: 8, kills: 3 }, { f: FACTION_B, c: 9, kills: 1 }], "character 10 (no flag) has no row");
      assert.strictEqual(env.liberation.getStatus().counters.contributions, 12);
      const dueAt = base + 10 + HOUR;
      await passesAt(env, shared, dueAt);
      assert.strictEqual(systemOf(env, S.N5).controllerFactionId, null);
      const libKey = `libpay:${S.N5}:0:${dueAt}`;
      const name = shared.graph.getSystem(S.N5).name || String(S.N5);
      const pick = (r) => [r.payout_key, r.liberation_key, r.character_id, r.controller_faction_id,
        r.beneficiary_faction_id, r.lp_corporation_id, r.kills, r.isk_amount, r.lp_amount, r.description, r.isk_state,
        r.lp_state, r.state, r.attempts, r.next_attempt_at, r.planned_at];
      const row = (c, kills, isk, lp) => [`${libKey}:${c}`, libKey, c, FACTION_B, 500001, 1000035, kills, isk, lp,
        `Living New Eden: liberation of ${name}`, "PENDING", "PENDING", "PENDING", 0, dueAt, dueAt];
      assert.deepStrictEqual(payoutsOf(env, S.N5).map(pick), [row(7, 8, 14545454, 2909), row(8, 3, 5454545, 1090)]);
      assert.deepStrictEqual(libpayJournal(env), [{ k: libKey, t: "liberation_reward", e: "LIBERATION_REWARD" }]);
      assert.deepStrictEqual(contributionsOf(env, S.N5), [], "the window rows of the controller are cleared");
      const st = env.liberation.getStatus().counters;
      assert.deepStrictEqual([st.liberated, st.rewardsPlanned, st.rewardRecipients, st.rewardNoIssuer],
        [1, 1, 2, 0]);
      const again = handlers.get(EVENT_TYPE)({ payload: { systemId: S.N5, seq: 0, bucket: Math.floor(dueAt / HOUR) },
        idempotencyKey: checkKey(S.N5, 0, dueAt) }, { now: dueAt + 1000 });
      assert.deepStrictEqual([again.ok, again.outcome, again.reward], [true, "STALE", undefined],
        JSON.stringify(again));
      assert.deepStrictEqual([payoutsOf(env, S.N5).length, libpayJournal(env).length], [2, 1]);
      assert.strictEqual(env.liberation.getStatus().counters.rewardsPlanned, 1);
    }));

  needsDriver("LR2 rewards: rows above rewardMaxContributorsPerSystem are CAPPED; a payout of the system within the "
    + "cooldown -> COOLDOWN, no plan, the contributions cleared", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = bootLib(reopen(), shared, fakeStations([]), { EVEJS_LNE_LIBERATION_MIN_CONTROLLER_SCORE: "50",
        EVEJS_LNE_LIBERATION_REWARD_MAX_CONTRIBUTORS_PER_SYSTEM: "2" });
      seedSystem(env, S.N5, FACTION_B, { [FACTION_B]: 60 });
      const base = shared.clock.now();
      const earlier = env.tx((db) => createRewardRepository().insertPayoutsInTx(db, [{ payoutKey: "libpay:old:7",
        liberationKey: "libpay:old", systemId: S.N5, characterId: 7, controllerFactionId: FACTION_A,
        beneficiaryFactionId: null, lpCorporationId: null, kills: 3, iskAmount: 5, lpAmount: 0,
        description: "old" }], base - HOUR));
      assert.ok(earlier.ok, JSON.stringify(earlier));
      const list = [...Array(9).fill([7, true]), ...Array(2).fill([8, true]), ...Array(2).fill([9, true])];
      for (const r of killsOf(env, base, list)) assert.strictEqual(r.outcome, "APPLIED", JSON.stringify(r));
      assert.deepStrictEqual(contributionsOf(env, S.N5).map((r) => [r.c, r.kills]), [[7, 9], [8, 2]]);
      let st = env.liberation.getStatus().counters;
      assert.deepStrictEqual([st.contributions, st.contributionsCapped], [11, 2]);
      await passesAt(env, shared, base + 10 + HOUR);
      st = env.liberation.getStatus().counters;
      assert.deepStrictEqual([st.liberated, st.rewardCooldown, st.rewardsPlanned], [1, 1, 0]);
      assert.deepStrictEqual(payoutsOf(env, S.N5).map((r) => r.payout_key), ["libpay:old:7"]);
      assert.deepStrictEqual([libpayJournal(env), contributionsOf(env, S.N5)], [[], []]);
    }));

  needsDriver("LR3 rewards off (liberation.rewardsEnabled=false): no contribution, the liberation plans nothing", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = bootLib(reopen(), shared, fakeStations([]), { EVEJS_LNE_LIBERATION_MIN_CONTROLLER_SCORE: "50",
        EVEJS_LNE_LIBERATION_REWARDS_ENABLED: "false" });
      seedSystem(env, S.N5, FACTION_B, { [FACTION_B]: 60 });
      const base = shared.clock.now();
      for (const r of killsOf(env, base, Array(13).fill([7, true]))) assert.strictEqual(r.outcome, "APPLIED");
      await passesAt(env, shared, base + 10 + HOUR);
      const st = env.liberation.getStatus().counters;
      assert.deepStrictEqual([st.liberated, st.contributions, st.rewardsPlanned, st.rewardNoContributors],
        [1, 0, 0, 0]);
      assert.deepStrictEqual([contributionsOf(env, S.N5), payoutsOf(env, S.N5), libpayJournal(env)], [[], [], []]);
    }));

  const fakeTimers = () => {
    const list = [];
    return { list, setTimer: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      list.push(t);
      return { cancel: () => { t.cancelled = true; }, hasRef: () => false };
    } };
  };
  const countingAdapter = () => {
    const a = { calls: 0, rewardSeams: () => ({ ok: true }),
      rewardCreditIsk: async () => { a.calls += 1; return { ok: true, duplicate: false, fingerprintMismatch: false }; },
      rewardCreditLp: () => { a.calls += 1; return { ok: true, duplicate: false }; } };
    return a;
  };

  needsDriver("LRW4: a navy kill is no contribution; the pump starts with rewardsEnabled, with "
    + "payoutEnabled=false it only prunes (no wallet call), a refused MAINTENANCE defers it, rewardsEnabled=false "
    + "starts no pump", async () => {
    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const timers = fakeTimers();
      const adapter = countingAdapter();
      let admits = true;
      const env = bootLib(reopen(), shared, fakeStations([]), { EVEJS_LNE_LIBERATION_MIN_CONTROLLER_SCORE: "50" },
        undefined, { adapter, setTimer: timers.setTimer, getGovernor: () => ({ admits: (c) => c !== "MAINTENANCE"
          || admits }) });
      seedSystem(env, S.N5, FACTION_B, { [FACTION_B]: 60 });
      const base = shared.clock.now();
      const navy = env.liberation.onNpcKill({ characterId: 7, victimFactionId: FACTION_B, systemId: S.N5, atMs: base,
        rewardable: true, navy: true });
      assert.strictEqual(navy.outcome, "APPLIED", JSON.stringify(navy));
      assert.deepStrictEqual(contributionsOf(env, S.N5), [], "The navy kill lowers the influence only");
      let st = env.liberation.getStatus();
      assert.deepStrictEqual([st.pump, st.payoutEnabled, timers.list.length], ["running", false, 1]);
      env.tx((db) => {
        createRewardRepository().insertPayoutsInTx(db, [{ payoutKey: "libpay:x:7", liberationKey: "libpay:x",
          systemId: S.N6, characterId: 7, controllerFactionId: FACTION_A, beneficiaryFactionId: null,
          lpCorporationId: null, kills: 3, iskAmount: 5, lpAmount: 0, description: "d" }], base);
        db.prepare(`INSERT INTO world_liberation_contributions (system_id, controller_faction_id, character_id, kills,
          first_at, last_at) VALUES (?, ?, 9, 1, ?, ?)`).run(S.N6, FACTION_A, base - 2 * 24 * HOUR, base - 2 * 24 * HOUR);
      });
      admits = false;
      let s = await env.liberation.runPayoutPass(base);
      assert.strictEqual(s.outcome, "DEFERRED");
      admits = true;
      s = await env.liberation.runPayoutPass(base);
      assert.deepStrictEqual([s.outcome, s.contributionsPruned, adapter.calls], ["DONE", 1, 0]);
      assert.deepStrictEqual(payoutsOf(env, S.N6).map((r) => r.state), ["PENDING"]);
      st = env.liberation.getStatus();
      assert.deepStrictEqual([st.counters.payoutDeferred, st.counters.contributionsPruned], [1, 1]);
      await timers.list[0].fn();
      env.liberation.stop();
      assert.strictEqual(env.liberation.getStatus().pump, "stopped");
    });
    await H.withStore(driver, async (reopen) => {
      const timers = fakeTimers();
      const env = bootLib(reopen(), H.sharedOf(), fakeStations([]), { EVEJS_LNE_LIBERATION_REWARDS_ENABLED: "false",
        EVEJS_LNE_LIBERATION_PAYOUT_ENABLED: "true" }, undefined, { adapter: countingAdapter(),
        setTimer: timers.setTimer });
      assert.deepStrictEqual([env.liberation.getStatus().pump, timers.list.length], ["idle", 0]);
      assert.strictEqual((await env.liberation.runPayoutPass(1)).outcome, "OFF");
    });
  });

  needsDriver("LRW5: a failed payout plan comes back with its reason (LIBERATION_REWARD_FAILED, txFailed) "
    + "the abandon is rolled back", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const handlers = new Map();
      const env = bootLib(reopen(), shared, fakeStations([]), { EVEJS_LNE_LIBERATION_MIN_CONTROLLER_SCORE: "50" },
        handlers);
      seedSystem(env, S.N5, FACTION_B, { [FACTION_B]: 60 });
      const base = shared.clock.now();
      for (const r of killsOf(env, base, Array(13).fill([7, true]))) assert.strictEqual(r.outcome, "APPLIED");
      const dueAt = base + 10 + HOUR;
      const pre = env.tx((db) => createRewardRepository().insertPayoutsInTx(db, [{
        payoutKey: `libpay:${S.N5}:0:${dueAt}:7`, liberationKey: "libpay:pre", systemId: S.N5, characterId: 7,
        controllerFactionId: FACTION_B, beneficiaryFactionId: null, lpCorporationId: null, kills: 3, iskAmount: 5,
        lpAmount: 0, description: "pre" }], base - 7 * HOUR));
      assert.ok(pre.ok, JSON.stringify(pre));
      shared.clock.set(dueAt);
      const r = handlers.get(EVENT_TYPE)({ payload: { systemId: S.N5, seq: 0, bucket: Math.floor(dueAt / HOUR) },
        idempotencyKey: checkKey(S.N5, 0, dueAt) }, { now: dueAt });
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.reason, `LIBERATION_REWARD_FAILED:APPLY_REFUSED:libpay:${S.N5}:0:${dueAt}:7`);
      const st = env.liberation.getStatus();
      assert.deepStrictEqual([st.counters.txFailed, st.counters.abandonRefused, st.counters.liberated], [1, 0, 0]);
      assert.ok(st.lastRefusal.startsWith("liberation.reward:"), st.lastRefusal);
      assert.strictEqual(systemOf(env, S.N5).controllerFactionId, FACTION_B, "the abandon is rolled back");
    }));
};

Object.assign(module.exports, { harness: Object.freeze({ bootLib, seedSystem, systemOf, scoreOf, fakeStations }) });



