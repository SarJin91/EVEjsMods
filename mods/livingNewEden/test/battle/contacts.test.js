"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../config");
const { openStore } = require("../../lib/persistence/store");
const { createJournal } = require("../../lib/persistence/journal");
const { createViewRegistry } = require("../../lib/observer/views");
const { startScheduler } = require("../../lib/scheduler");
const { startFleets } = require("../../lib/fleets");
const { startWrecks } = require("../../lib/world/wrecks");
const { startBattle, createUnavailableBattle } = require("../../lib/battle");
const { seedDemo } = require("../../lib/battle/demo");
const { planContact } = require("../../lib/battle/contacts");
const { createHostility } = require("../../lib/battle/data/hostility");
const realResolver = require("../../lib/battle/resolverInternalV1");
const { harness: H } = require("./settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SANSHA = 500019;
const GURISTAS = 500010;
const BLOOD = 500012;
const ANGEL = 500011;
const SERPENTIS = 500020;
const COMP = Object.freeze([{ hullGroup: "cruiser", count: 4 }, { hullGroup: "logistics", count: 1 }]);
const ENGAGE_MS = 60000;
const HOLD_MS = 60000;
const COOLDOWN_MS = 1800000;

function testConfig(over = {}) {
  const c = JSON.parse(JSON.stringify(config.resolveConfig({ modDir: MOD_DIR, env: {} }).config));
  for (const [dotted, value] of Object.entries(over)) {
    const parts = dotted.split(".");
    let node = c;
    for (const part of parts.slice(0, -1)) node = node[part];
    node[parts[parts.length - 1]] = value;
  }
  return c;
}

function fakeTelemetry() {
  const counts = {};
  return { counts, count(name, n = 1) {
    counts[name] = (counts[name] || 0) + n;
  }, gauge() {}, observe() {} };
}

function seamResolver(pick) {
  const seam = { calls: 0, RESOLVER_VERSION: realResolver.RESOLVER_VERSION, estimateWorkUnits: realResolver.estimateWorkUnits,
    resolve(input, catalog, params) {
      if (input.battleId === "battle_selftest_0001_0001") return realResolver.resolve(input, catalog, params);
      seam.calls += 1;
      const r = pick(input);
      if (r === "REAL") return realResolver.resolve(input, catalog, params);
      if (typeof r === "string") return { ok: true, result: H.resultFor(input, r) };
      return r;
    } };
  return seam;
}

function createEnv(driver, opts = {}) {
  const cfg = testConfig(opts.config || {});
  const opened = openStore({ filePath: ":memory:", openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
    busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 3 });
  assert.ok(opened.ok, JSON.stringify(opened));
  const shared = opts.shared || H.sharedOf();
  const store = opened.store;
  const telemetry = fakeTelemetry();
  const lines = [];
  const logger = { log: (line) => lines.push(line) };
  const graph = opts.graph || shared.graph;
  const env = { store, clock: shared.clock, shared, cfg, telemetry, lines, graph };
  env.boot = () => {
    const journal = createJournal({ clock: shared.clock, maxPayloadBytes: cfg.persistence.journalMaxPayloadBytes,
      maxRows: 500 });
    env.journal = journal;
    const persistence = { ok: true, store, journal, worldSeed: opened.worldSeed, filePath: "test.sqlite" };
    const sr = startScheduler({ config: cfg, persistence: { ok: true, store }, clock: shared.clock, ids: shared.ids,
      telemetry, logger, nowMs: () => 0 });
    assert.ok(sr.ok, JSON.stringify(sr));
    const fr = startFleets({ config: cfg, persistence, clock: shared.clock, ids: shared.ids, scheduler: sr.scheduler,
      graph: { getGraph: () => ({ ok: true, graph }) }, presence: null, views: createViewRegistry(), telemetry, logger,
      adapter: opts.adapter });
    assert.ok(fr.ok, JSON.stringify(fr));
    const wr = startWrecks({ config: cfg, persistence, clock: shared.clock, scheduler: sr.scheduler, telemetry, logger });
    assert.ok(wr.ok, JSON.stringify(wr));
    const views = createViewRegistry();
    env.battleDeps = { config: cfg, persistence, clock: shared.clock, ids: shared.ids, scheduler: sr.scheduler,
      fleets: fr.fleets, graph: { getGraph: () => ({ ok: true, graph }) }, wrecks: wr.wrecks,
      presence: opts.presence || null, views, telemetry, logger, nowMs: () => 0, resolver: opts.resolver,
      hooks: opts.hooks, getStructureSeam: opts.getStructureSeam,
      world: opts.world, getStations: opts.getStations };
    const br = startBattle(env.battleDeps);
    assert.ok(br.ok, JSON.stringify(br));
    Object.assign(env, { scheduler: sr.scheduler, fleets: fr.fleets, wrecks: wr.wrecks, battle: br.battle, views });
  };
  env.stop = () => {
    env.battle.stop("test");
    env.wrecks.stop("test");
    env.fleets.stop("test");
    env.scheduler.stop("test");
  };
  env.restart = () => {
    env.stop();
    env.boot();
  };
  env.close = () => {
    env.stop();
    store.close("test_cleanup");
  };
  env.q = (sql, ...args) => {
    const r = store.transaction("test.read", (db) => db.prepare(sql).all(...args));
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  env.n = (sql, ...args) => env.q(sql, ...args)[0].n;
  env.event = (key) => env.q("SELECT * FROM world_scheduled_events WHERE idempotency_key = ?", key)[0];
  env.battles = () => env.q("SELECT * FROM battle_records ORDER BY created_at, battle_id");
  env.fleet = (id) => env.fleets.getFleet(id).fleet;
  env.newFleet = (tag, factionId, systemId, composition = COMP) => {
    const r = env.fleets.createFleet({ factionId, currentSystemId: systemId, homeSystemId: systemId,
      fleetRole: "patrol", composition: composition.map((e) => ({ ...e })) }, `test:${tag}`);
    assert.ok(r.ok, JSON.stringify(r));
    return r.fleetId;
  };
  env.travel = (fleetId, factionId, from, to, tag) => {
    const op = env.fleets.createOperation({ operationType: "patrol", factionId, originSystemId: from,
      targetSystemId: to, objective: "patrol", dueAt: shared.clock.now() + 3600000,
      fleets: [{ fleetId, expectedVersion: env.fleet(fleetId).version }] }, `test:op:${tag}`);
    assert.ok(op.ok, JSON.stringify(op));
    const p = env.fleets.planTravel({ fleetId, targetSystemId: to }, `test:plan:${tag}`);
    assert.ok(p.ok, JSON.stringify(p));
    return p;
  };
  env.check = (systemId, tag) => {
    const at = shared.clock.now();
    const r = env.scheduler.enqueue("BATTLE_CONTACT_CHECK", systemId, at, { systemId, at, triggerFleetId: null },
      `contact:${systemId}:test:${tag}`);
    assert.ok(r.ok, JSON.stringify(r));
  };
  env.drive = async (untilMs) => {
    for (let i = 0; i < 20000; i += 1) {
      const r = await env.scheduler.runPass();
      assert.ok(r.ok, JSON.stringify(r));
      const now = shared.clock.now();
      if (!r.skipped && r.jobs > 0) continue;
      if (now >= untilMs) return;
      const next = env.scheduler.getStatus().nextDueAt;
      shared.clock.set(Math.min(untilMs, next === null || next <= now ? now + cfg.scheduler.intervalMs : next));
    }
    throw new Error("drive: no end");
  };
  env.boot();
  return env;
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("T1 contact on arrival: 1 check, 1 battle, resolve:0 at +engageDelay; a third fleet during the "
    + "battle makes no second battle with A/B; settled once, recheck after", async () => {
    const env = createEnv(driver);
    try {
      const S = H.S;
      const a = env.newFleet("a", SANSHA, S.N5);
      const b = env.newFleet("b", GURISTAS, S.N0);
      const c = env.newFleet("c", BLOOD, S.N6);
      const pb = env.travel(b, GURISTAS, S.N0, S.N5, "b");
      await env.drive(pb.arriveAt);
      const checks = env.q("SELECT * FROM world_scheduled_events WHERE event_type = 'BATTLE_CONTACT_CHECK'");
      assert.strictEqual(checks.length, 1, JSON.stringify(checks));
      assert.strictEqual(checks[0].idempotency_key, `contact:${S.N5}:arr:${b}:${pb.legSeq}`);
      let battles = env.battles();
      assert.strictEqual(battles.length, 1);
      assert.strictEqual(battles[0].state, "PENDING");
      const battleId = battles[0].battle_id;
      assert.strictEqual(env.event(`battle:${battleId}:resolve:0`).due_at, pb.arriveAt + ENGAGE_MS);
      assert.deepStrictEqual([env.fleet(a).state, env.fleet(b).state], ["ENGAGED", "ENGAGED"]);

      const pc = env.travel(c, BLOOD, S.N6, S.N5, "c");
      assert.ok(pc.arriveAt < pb.arriveAt + ENGAGE_MS, "C arrives during the battle");
      await env.drive(pc.arriveAt);
      const cCheck = env.event(`contact:${S.N5}:arr:${c}:${pc.legSeq}`);
      assert.deepStrictEqual([cCheck.state, cCheck.outcome], ["DONE", "NO_HOSTILES"]);
      assert.strictEqual(env.battles().length, 1, "no second battle while A/B are engaged");

      await env.drive(pb.arriveAt + ENGAGE_MS);
      battles = env.battles();
      const first = battles.find((x) => x.battle_id === battleId);
      assert.strictEqual(first.state, "COMPLETED");
      assert.strictEqual(env.n("SELECT count(*) AS n FROM world_event_journal WHERE event_type = 'BATTLE_SETTLED' "
        + "AND aggregate_id = ?", battleId), 1);
      const parts = env.q("SELECT fleet_id, count(*) AS n FROM battle_participants WHERE battle_id = ? GROUP BY 1",
        battleId);
      assert.deepStrictEqual(parts.map((p) => p.fleet_id).sort(), [a, b].sort());
      const left = [a, b].some((id) => ["STAGED", "IDLE"].includes(env.fleet(id).state));
      if (left) {
        assert.ok(env.event(`contact:${S.N5}:after:${battleId}`) || env.event(`contact:${S.N5}:cool:${battleId}`),
          "recheck after the settlement (cool when the loser stayed)");
      }
      assert.ok(env.lines.some((l) => l.startsWith(`battle: settled ${battleId} system=${S.N5}`)), env.lines.join("\n"));
    } finally {
      env.close();
    }
  });

  needsDriver("T2 friendly -> no battle; DRAW -> cooldown until at+30 min, ON_COOLDOWN before, recheck at "
    + "until -> second battle", async () => {
    const resolver = seamResolver(() => "DRAW");
    const env = createEnv(driver, { resolver });
    try {
      const S = H.S;
      env.newFleet("s1", SANSHA, S.N6);
      env.newFleet("s2", SANSHA, S.N6);
      env.newFleet("an", ANGEL, S.N7);
      env.newFleet("se", SERPENTIS, S.N7);
      env.check(S.N6, "same");
      env.check(S.N7, "allies");
      await env.drive(env.clock.now());
      assert.strictEqual(env.event(`contact:${S.N6}:test:same`).outcome, "NO_HOSTILES");
      assert.strictEqual(env.event(`contact:${S.N7}:test:allies`).outcome, "NO_HOSTILES");
      assert.strictEqual(env.battles().length, 0);

      env.newFleet("g", GURISTAS, S.N9);
      env.newFleet("s3", SANSHA, S.N9);
      const at = env.clock.now();
      env.check(S.N9, "draw");
      await env.drive(at + ENGAGE_MS);
      const [first] = env.battles();
      assert.strictEqual(first.state, "COMPLETED");
      const cd = env.q("SELECT * FROM battle_contact_cooldowns WHERE system_id = ?", S.N9);
      assert.deepStrictEqual(cd.map((r) => [r.faction_lo, r.faction_hi, r.until_at, r.battle_id]),
        [[GURISTAS, SANSHA, at + ENGAGE_MS + COOLDOWN_MS, first.battle_id]]);
      env.check(S.N9, "early");
      await env.drive(env.clock.now());
      assert.strictEqual(env.event(`contact:${S.N9}:test:early`).outcome, "ON_COOLDOWN");
      assert.strictEqual(env.event(`contact:${S.N9}:cool:${first.battle_id}`).due_at, at + ENGAGE_MS + COOLDOWN_MS);
      await env.drive(at + ENGAGE_MS + COOLDOWN_MS + 1);
      assert.strictEqual(env.battles().length, 2, "second battle after the cooldown");
    } finally {
      env.close();
    }
  });

  needsDriver("T3 observed -> PENDING AWAITING_LIVE, resolver not called, hold:<b>; unobserved -> COMPLETED "
    + "stale -> hold, PRESENCE_DISABLED -> resolved", async () => {
    const presence = { observed: true, st: { available: true, stale: false, reason: null },
      getStatus() { return this.st; }, isObserved() { return this.observed; } };
    const resolver = seamResolver(() => "DRAW");
    const env = createEnv(driver, { resolver, presence });
    try {
      const S = H.S;
      env.newFleet("a", SANSHA, S.N6);
      env.newFleet("b", GURISTAS, S.N6);
      const at = env.clock.now();
      env.check(S.N6, "obs");
      await env.drive(at + ENGAGE_MS);
      let [battle] = env.battles();
      assert.deepStrictEqual([battle.state, battle.hold_reason], ["PENDING", "AWAITING_LIVE"]);
      assert.strictEqual(resolver.calls, 0);
      const bucket = Math.floor((at + ENGAGE_MS) / HOLD_MS) + 1;
      assert.strictEqual(env.event(`battle:${battle.battle_id}:hold:${bucket}`).state, "QUEUED");
      presence.observed = false;
      await env.drive(bucket * HOLD_MS);
      [battle] = env.battles();
      assert.deepStrictEqual([battle.state, battle.hold_reason], ["COMPLETED", null]);
      assert.strictEqual(resolver.calls, 1);

      env.newFleet("c", SANSHA, S.N7);
      env.newFleet("d", GURISTAS, S.N7);
      presence.st = { available: true, stale: true, reason: null };
      env.check(S.N7, "stale");
      await env.drive(env.clock.now() + ENGAGE_MS);
      const stale = env.battles().find((x) => x.system_id === S.N7);
      assert.deepStrictEqual([stale.state, stale.hold_reason], ["PENDING", "AWAITING_LIVE"]);
      presence.st = { available: false, reason: "PRESENCE_DISABLED" };
      await env.drive(env.clock.now() + 2 * HOLD_MS);
      assert.strictEqual(env.battles().find((x) => x.system_id === S.N7).state, "COMPLETED");
    } finally {
      env.close();
    }
  });

  needsDriver("T7 refusals: RESOLVER_BUDGET -> FAILED + released + cooldown; RESOLVER_INTERNAL -> QUARANTINED "
    + "event DONE after 1 attempt; transient to the last attempt -> FAILED RETRIES_EXHAUSTED; reconcile revives",
  async () => {
    const S = H.S;
    const resolver = seamResolver((input) => {
      if (input.systemId === S.N6) return { ok: false, reason: "RESOLVER_BUDGET", detail: "test" };
      if (input.systemId === S.N7) return { ok: false, reason: "RESOLVER_INTERNAL", detail: "test" };
      return "DRAW";
    });
    let failing = null;
    const hooks = { beforeSettle(battleId) {
      if (battleId === failing) throw new Error("injected");
    } };
    const env = createEnv(driver, { resolver, hooks });
    try {
      const f = {};
      for (const [tag, sys] of [["b6", S.N6], ["b7", S.N7], ["b9", S.N9]]) {
        f[`${tag}a`] = env.newFleet(`${tag}a`, SANSHA, sys);
        f[`${tag}b`] = env.newFleet(`${tag}b`, GURISTAS, sys);
        env.check(sys, tag);
      }
      await env.drive(env.clock.now());
      const bySys = () => Object.fromEntries(env.battles().reverse().map((x) => [x.system_id, x]));
      failing = bySys()[S.N9].battle_id;
      await env.drive(env.clock.now() + 2 * 3600000);
      const b = bySys();
      assert.strictEqual(b[S.N6].state, "FAILED");
      assert.strictEqual(JSON.parse(b[S.N6].error_json).reason, "RESOLVER_BUDGET");
      assert.deepStrictEqual([env.fleet(f.b6a).state, env.fleet(f.b6b).state], ["IDLE", "IDLE"]);
      assert.strictEqual(env.n("SELECT count(*) AS n FROM battle_contact_cooldowns WHERE system_id = ?", S.N6), 1);
      assert.strictEqual(b[S.N7].state, "QUARANTINED");
      const e7 = env.event(`battle:${b[S.N7].battle_id}:resolve:0`);
      assert.deepStrictEqual([e7.state, e7.attempts], ["DONE", 1]);
      assert.strictEqual(b[S.N9].state, "FAILED");
      assert.strictEqual(JSON.parse(b[S.N9].error_json).reason, "RESOLUTION_RETRIES_EXHAUSTED");
      const e9 = env.event(`battle:${b[S.N9].battle_id}:resolve:0`);
      assert.deepStrictEqual([e9.state, e9.attempts], ["DONE", env.cfg.scheduler.maxAttempts]);

      failing = null;
      env.newFleet("r1", SANSHA, S.N10);
      env.newFleet("r2", GURISTAS, S.N10);
      env.check(S.N10, "rec");
      await env.drive(env.clock.now());
      const rb = bySys()[S.N10];
      const key = `battle:${rb.battle_id}:resolve:0`;
      const now = env.clock.now();
      assert.ok(env.store.transaction("test.q", (db) => db.prepare("UPDATE world_scheduled_events SET state = "
        + "'QUARANTINED', last_error = 'test', finished_at = ? WHERE idempotency_key = ?").run(now, key)).ok);
      env.restart();
      await env.drive(now + 4 * HOLD_MS + env.cfg.battle.reconcileDelayMs);
      assert.strictEqual(bySys()[S.N10].state, "COMPLETED");
      assert.ok(env.lines.some((l) => /^battle: reconcile revived=1 /.test(l)), env.lines.join("\n"));
    } finally {
      env.close();
    }
  });


  needsDriver("T9 A_WIN, the loser repairs in place (REFITTING) -> cooldown of the pair, no recheck "
    + "after, ON_COOLDOWN before until, recheck cool at until -> the next battle", async () => {
    const resolver = seamResolver((input) => ({ ok: true, result: H.resultFor(input, "A_WIN",
      Object.fromEntries(input.sideB.fleets.map((f) => [f.fleetId, (e) => ({ d: 0, e: e.count })]))) }));
    const env = createEnv(driver, { resolver });
    try {
      const S = H.S;
      const x = env.newFleet("x", SANSHA, S.N9);
      const y = env.newFleet("y", GURISTAS, S.N9);
      const at = env.clock.now();
      env.check(S.N9, "win");
      await env.drive(at + ENGAGE_MS);
      const [first] = env.battles();
      assert.strictEqual(first.state, "COMPLETED");
      assert.deepStrictEqual([env.fleet(x).state, env.fleet(y).state].sort(), ["IDLE", "REFITTING"],
        "the winner stays IDLE, the loser (no retreat target) repairs in place");
      const until = at + ENGAGE_MS + COOLDOWN_MS;
      const cd = env.q("SELECT * FROM battle_contact_cooldowns WHERE system_id = ?", S.N9);
      assert.deepStrictEqual(cd.map((r) => [r.faction_lo, r.faction_hi, r.until_at, r.battle_id]),
        [[GURISTAS, SANSHA, until, first.battle_id]]);
      assert.strictEqual(env.event(`contact:${S.N9}:after:${first.battle_id}`), undefined, "no chase recheck");
      assert.strictEqual(env.event(`contact:${S.N9}:cool:${first.battle_id}`).due_at, until);
      await env.drive(at + ENGAGE_MS + 10 * ENGAGE_MS);
      assert.strictEqual(env.battles().length, 1, "no second battle every engageDelayMs");
      env.check(S.N9, "early");
      await env.drive(env.clock.now());
      assert.strictEqual(env.event(`contact:${S.N9}:test:early`).outcome, "ON_COOLDOWN");
      await env.drive(until + ENGAGE_MS);
      assert.strictEqual(env.battles().length, 2, "the next battle only after the cooldown");
      assert.strictEqual(resolver.calls, 2);
    } finally {
      env.close();
    }
  });

  needsDriver("T10 demo DEMO_PARTIAL rolls the whole transaction back (no half-written fleets "
    + "no check)", async () => {
    const env = createEnv(driver);
    try {
      const S = H.S;
      const lines = [];
      const pre = env.store.transaction("test.demoA", (db) => env.fleets.repository.createFleet(db, {
        fleetId: "lnedemo-a", factionId: 500019, currentSystemId: S.N5, homeSystemId: S.N5, fleetRole: "patrol",
        composition: [{ hullGroup: "cruiser", count: 4 }, { hullGroup: "logistics", count: 1 }] },
      "battle-demo:v1:fleet:a"));
      assert.ok(pre.ok && pre.value.ok, JSON.stringify(pre));
      const before = env.n("SELECT count(*) AS n FROM world_event_journal");
      const r = seedDemo({ store: env.store, fleetRepository: env.fleets.repository, scheduler: env.scheduler,
        graph: env.graph, presence: null, testing: { battleDemoSystemId: S.N5, battleDemoDelayMs: 1000 },
        filePath: "bench.sqlite", clock: env.clock, logger: { log: (l) => lines.push(l) } });
      assert.deepStrictEqual(r, { ok: false, reason: "DEMO_PARTIAL" });
      assert.strictEqual(env.fleets.getFleet("lnedemo-b").fleet, null, "fleet b rolled back");
      assert.strictEqual(env.n("SELECT count(*) AS n FROM world_event_journal"), before);
      assert.strictEqual(env.n("SELECT count(*) AS n FROM world_scheduled_events WHERE event_type = "
        + "'BATTLE_CONTACT_CHECK'"), 0);
      assert.ok(lines.includes("battle: demo refused - DEMO_PARTIAL"), lines.join("\n"));
    } finally {
      env.close();
    }
  });

  needsDriver("SB5 demo ship multiplier: m=1 as before (13 ships), m=3 -> counts x3 (39), restart with "
    + "the same m -> already seeded, another m -> refused; config clamp 9 -> 3", async () => {
    const S = H.S;
    const seedWith = (env, m, lines) => seedDemo({ store: env.store, fleetRepository: env.fleets.repository,
      scheduler: env.scheduler, graph: env.graph, presence: null,
      testing: { battleDemoSystemId: S.N5, battleDemoDelayMs: 1000, ...(m === undefined ? {} : {
        battleDemoShipMultiplier: m }) },
      filePath: "bench.sqlite", clock: env.clock, logger: { log: (l) => lines.push(l) } });
    const comp = (env, id) => env.fleet(id).composition.map((e) => [e.hullGroup, e.count]);
    const keys = (env) => env.q("SELECT idempotency_key AS k FROM world_event_journal WHERE idempotency_key LIKE "
      + "'battle-demo:%' ORDER BY idempotency_key").map((r) => r.k);
    for (const [m, factor, ships] of [[undefined, 1, 13], [1, 1, 13], [3, 3, 39]]) {
      const env = createEnv(driver);
      try {
        const lines = [];
        assert.deepStrictEqual(seedWith(env, m, lines), { ok: true, systemId: S.N5, seeded: true }, String(m));
        assert.deepStrictEqual(comp(env, "lnedemo-a"), [["cruiser", 4 * factor], ["logistics", factor]]);
        assert.deepStrictEqual(comp(env, "lnedemo-b"), [["frigate", 6 * factor], ["tackle", 2 * factor]]);
        assert.deepStrictEqual(keys(env), ["battle-demo:v1:fleet:a", "battle-demo:v1:fleet:b"], "keys unchanged");
        assert.ok(lines.includes(`battle: demo fleets lnedemo-a,lnedemo-b system=${S.N5} ships=${ships} check in `
          + "1000ms"), lines.join("\n"));
        if (m === 3) {
          assert.deepStrictEqual(seedWith(env, 3, lines), { ok: true, systemId: S.N5, seeded: false });
          assert.ok(lines.includes(`battle: demo already seeded system=${S.N5}`), lines.join("\n"));
          assert.deepStrictEqual(seedWith(env, 1, lines), { ok: false, reason: "IDEMPOTENCY_CONFLICT" },
            "another multiplier on the same database");
          assert.deepStrictEqual(comp(env, "lnedemo-a"), [["cruiser", 12], ["logistics", 3]], "no write");
          assert.strictEqual(env.n("SELECT count(*) AS n FROM world_scheduled_events WHERE event_type = "
            + "'BATTLE_CONTACT_CHECK'"), 1);
        }
      } finally {
        env.close();
      }
    }
    const cfg = (v) => config.resolveConfig({ modDir: MOD_DIR,
      env: v === undefined ? {} : { EVEJS_LNE_TEST_BATTLE_DEMO_SHIP_MULTIPLIER: v } }).config.testing
      .battleDemoShipMultiplier;
    assert.deepStrictEqual([cfg(undefined), cfg("2"), cfg("9"), cfg("0")], [1, 2, 3, 1]);
  });

  needsDriver("T11 startBattle throwing after the registration takes its handlers and the arrival "
    + "listener back: the next start succeeds", async () => {
    const env = createEnv(driver);
    try {
      env.battle.stop("test");
      const throwing = { log(line) {
        if (String(line).startsWith("battle: running")) throw new Error("injected");
      } };
      const views = createViewRegistry();
      const bad = startBattle({ ...env.battleDeps, logger: throwing, views });
      assert.deepStrictEqual([bad.ok, bad.reason, bad.detail], [false, "BATTLE_START_FAILED", "injected"]);
      assert.strictEqual(views.getView("battles"), null, "view taken back");
      const good = startBattle(env.battleDeps);
      assert.ok(good.ok, JSON.stringify(good));
      env.battle = good.battle;
      const S = H.S;
      env.newFleet("a", SANSHA, S.N5);
      const b = env.newFleet("b", GURISTAS, S.N0);
      const pb = env.travel(b, GURISTAS, S.N0, S.N5, "b");
      await env.drive(pb.arriveAt);
      assert.strictEqual(env.q("SELECT * FROM world_scheduled_events WHERE event_type = 'BATTLE_CONTACT_CHECK'")
        .length, 1, "one arrival listener (the failed start left none behind)");
    } finally {
      env.close();
    }
  });

  needsDriver("RC1 release contact: two calls -> one event contact:<sys>:rel:<id> (second duplicate) "
    + "drained -> one battle with the released fleet on side A", async () => {
    const env = createEnv(driver);
    try {
      const S = H.S;
      const a = env.newFleet("rc1a", GURISTAS, S.N9);
      const b = env.newFleet("rc1b", SANSHA, S.N9);
      const info = { releaseId: "ph:x:1", fleetId: a, systemId: S.N9, at: env.clock.now() };
      const call = () => {
        const r = env.store.transaction("test.release", (db) => env.battle.requestReleaseContactInTx(db, info));
        assert.ok(r.ok, JSON.stringify(r));
        return r.value;
      };
      assert.deepStrictEqual(call(), { ok: true, duplicate: false });
      assert.deepStrictEqual(call(), { ok: true, duplicate: true });
      const key = `contact:${S.N9}:rel:ph:x:1`;
      assert.strictEqual(env.n("SELECT count(*) AS n FROM world_scheduled_events WHERE idempotency_key = ?", key), 1);
      assert.strictEqual(env.telemetry.counts["battle.contacts.releaseQueued"], 1, JSON.stringify(env.telemetry.counts));
      await env.drive(env.clock.now());
      const battles = env.battles();
      assert.strictEqual(battles.length, 1, JSON.stringify(battles));
      const sides = env.q("SELECT fleet_id, side FROM battle_participants WHERE battle_id = ? ORDER BY side",
        battles[0].battle_id);
      assert.deepStrictEqual(sides.map((p) => [p.fleet_id, p.side]), [[a, "A"], [b, "B"]]);
    } finally {
      env.close();
    }
  });

  needsDriver("RC2 release contact: flag off -> DISABLED, 0 rows; stopped -> BATTLE_STOPPED; the method "
    + "on the READY facade and on createUnavailableBattle", () => {
    const env = createEnv(driver, { config: { "battle.releaseContact.enabled": false } });
    try {
      const S = H.S;
      const a = env.newFleet("rc2a", GURISTAS, S.N9);
      env.newFleet("rc2b", SANSHA, S.N9);
      const info = { releaseId: "fx:x:1", fleetId: a, systemId: S.N9, at: env.clock.now() };
      const call = () => env.store.transaction("test.release", (db) => env.battle.requestReleaseContactInTx(db, info))
        .value;
      assert.deepStrictEqual(call(), { ok: true, skipped: "DISABLED" });
      assert.strictEqual(env.n("SELECT count(*) AS n FROM world_scheduled_events WHERE idempotency_key LIKE ?",
        `contact:${S.N9}:rel:%`), 0);
      const stub = createUnavailableBattle("disabled_by_config");
      for (const name of Object.keys(stub)) {
        if (typeof stub[name] === "function") assert.strictEqual(typeof env.battle[name], "function", name);
      }
      assert.strictEqual(typeof env.battle.requestReleaseContactInTx, "function");
      assert.deepStrictEqual(stub.requestReleaseContactInTx({}, info), { ok: false, reason: "disabled_by_config" });
      env.battle.stop("test");
      assert.deepStrictEqual(call(), { ok: false, reason: "BATTLE_STOPPED" });
    } finally {
      env.close();
    }
  });

  test("T8 planContact (pure) + config: defaults without warnings, testing.battleDemo=1 -> test profile", () => {
    const isHostile = createHostility();
    const fl = (fleetId, factionId, shipCount, extra = {}) => ({ fleetId, factionId, shipCount, version: 1,
      operationId: null, composition: [{ hullGroup: "frigate", typeId: null, count: shipCount }], ...extra });
    const fleets = [fl("x1", BLOOD, 3), fl("x2", SANSHA, 9), fl("x3", GURISTAS, 5), fl("x4", SANSHA, 1)];
    const r = planContact({ fleets, triggerFleetId: "x3", isHostile, cooldowns: new Map(), at: 0,
      limits: { maxFleetsPerSide: 8, maxSettlementRows: 450 } });
    assert.deepStrictEqual([r.contact.sideA.factionId, r.contact.sideB.factionId], [GURISTAS, SANSHA]);
    assert.deepStrictEqual(r.contact.sideB.fleets.map((x) => x.fleetId), ["x2", "x4"]);
    const big = planContact({ fleets, triggerFleetId: null, isHostile, cooldowns: new Map(), at: 0,
      limits: { maxFleetsPerSide: 8, maxSettlementRows: 20 } });
    assert.deepStrictEqual([big.contact.sideA.fleets.length, big.contact.sideB.fleets.length], [1, 1]);
    assert.strictEqual(planContact({ fleets, triggerFleetId: null, isHostile, cooldowns: new Map(), at: 0,
      limits: { maxFleetsPerSide: 8, maxSettlementRows: 19 } }).reason, "TOO_LARGE");
    assert.deepStrictEqual(config.resolveConfig({ modDir: MOD_DIR, env: {} }).warnings, []);
    const demo = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_TEST_BATTLE_DEMO: "1" } });
    assert.ok(demo.warnings.some((w) => w.includes("testing.battleDemo=true - test profile")), demo.warnings.join("\n"));
  });

  test("T9 D-3: a faction of only evasive fleets takes no part in a contact", () => {
    const isHostile = createHostility();
    const fl = (fleetId, factionId, shipCount, extra = {}) => ({ fleetId, factionId, shipCount, version: 1,
      operationId: null, composition: [{ hullGroup: "frigate", typeId: null, count: shipCount }], ...extra });
    const plan = (fleets, triggerFleetId) => planContact({ fleets, triggerFleetId, isHostile, cooldowns: new Map(),
      at: 0, limits: { maxFleetsPerSide: 8, maxSettlementRows: 450 } });
    const h1 = fl("h1", SANSHA, 10, { fleetRole: "hunter" });
    const g1 = fl("g1", GURISTAS, 4, { fleetRole: "patrol" });
    for (const trig of ["h1", "g1"]) {
      assert.deepStrictEqual(plan([h1, g1], trig), { ok: true, contact: null, reason: "NO_HOSTILES" }, trig);
    }
    const withStrike = plan([h1, g1, fl("s1", SANSHA, 20, { fleetRole: "invasion" })], "s1");
    assert.deepStrictEqual([withStrike.contact.sideA.factionId, withStrike.contact.sideA.fleets.map((x) => x.fleetId),
      withStrike.contact.sideB.factionId], [SANSHA, ["s1", "h1"], GURISTAS]);
    const third = plan([h1, g1, fl("b1", BLOOD, 3, { fleetRole: "patrol" })], "h1");
    const sides = [third.contact.sideA, third.contact.sideB];
    assert.deepStrictEqual(sides.map((s) => s.factionId).sort(), [GURISTAS, BLOOD].sort());
    assert.ok(sides.every((s) => s.fleets.every((x) => x.fleetId !== "h1")), "h1 on no side");
  });
};

Object.assign(module.exports, { harness: Object.freeze({ createEnv, seamResolver, testConfig, SANSHA, GURISTAS }) });
