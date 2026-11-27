"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../../config");
const { startTransit, createUnavailableTransit, settingsOf, REQUIRED, SOFT_ROOTS } = require("../../../lib/strategy/transit");
const { createRiskIndex, SEED_READY } = require("../../../lib/strategy/transit/riskIndex");
const { createTransitService } = require("../../../lib/strategy/transit/service");
const { routeContactPermille } = require("../../../lib/strategy/transit/rules");
const { startWorld } = require("../../../lib/world");
const { createUnavailableSentries } = require("../../../lib/sentries");
const { createUnavailablePresence } = require("../../../lib/presence");
const { harness: H } = require("../../battle/settlement.test");
const { harness: C } = require("../../battle/contacts.test");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const S = H.S;
const DEATHLESS = 500029;
const HOUR = 3600000;
const AVOID = Object.freeze({ avoidSecClasses: ["highsec", "lowsec"] });
const TEN = Object.freeze([{ hullGroup: "cruiser", count: 10 }]);

const SUB1 = Object.freeze({ basePermille: 80, controlPermille: 80, maxChancePermille: 400 });

function defaultSettings(over = {}) {
  const c = JSON.parse(JSON.stringify(config.resolveConfig({ modDir: MOD_DIR, env: {} }).config));
  c.transit = { ...c.transit, ...SUB1, ...over };
  const s = settingsOf(c);
  assert.ok(s.ok, JSON.stringify(s));
  return s.settings;
}

function fakeWorld(rows, holder = {}) {
  const world = { calls: [], getStatus: () => ({ state: "ready" }), listSystems(opts) {
    world.calls.push({ ...opts });
    if (holder.refuseNext) {
      holder.refuseNext = false;
      return { ok: false, reason: "TX_BUSY" };
    }
    const all = (holder.rows || rows).filter((r) => r.systemId > opts.afterSystemId);
    const page = all.slice(0, opts.limit);
    return { ok: true, systems: page, nextAfterSystemId: page.length === opts.limit ? page[page.length - 1].systemId
      : null };
  } };
  return world;
}

const row = (systemId, securityClass, controllerFactionId, influence = []) => ({ systemId, securityClass,
  controllerFactionId, influence: influence.map(([factionId, influenceScore, garrisonStrength]) => ({ systemId,
    factionId, influenceScore, garrisonStrength })) });

function fakeTimers() {
  const list = [];
  return { list, live: () => list.filter((t) => !t.cancelled), setTimer(fn, ms) {
    const t = { fn, ms, cancelled: false };
    list.push(t);
    return { cancel: () => {
      t.cancelled = true;
    }, hasRef: () => false };
  }, run() {
    for (const t of list.filter((x) => !x.cancelled && !x.fired)) {
      t.fired = true;
      t.cancelled = true;
      t.fn();
    }
  } };
}

function fakeTelemetry() {
  const counts = {};
  const observed = {};
  const gauges = {};
  return { counts, observed, gauges, count(name, n = 1) {
    counts[name] = (counts[name] || 0) + n;
  }, observe(name, v) {
    (observed[name] = observed[name] || []).push(v);
  }, gauge(name, v) {
    gauges[name] = v;
  } };
}

function cfgOf(env, transit = {}) {
  const c = JSON.parse(JSON.stringify(env.cfg));
  c.modules.strategy = { enabled: true };
  c.transit = { ...c.transit, enabled: true, ...SUB1, ...transit };
  return c;
}

function bootTransit(env, cfg, world, extra = {}) {
  const listeners = [];
  const removed = [];
  const travel = { ...env.fleets.travel, addDepartureListener: (fn) => {
    listeners.push(fn);
    const r = env.fleets.travel.addDepartureListener(fn);
    return r.ok ? { ok: true, remove: () => {
      removed.push(fn);
      r.remove();
    } } : r;
  } };
  const timers = fakeTimers();
  const telemetry = fakeTelemetry();
  const lines = [];
  const started = startTransit({ config: cfg, fleets: { ...env.fleets, travel }, world, telemetry,
    logger: { log: (l) => lines.push(l) }, setTimer: timers.setTimer, getSentries: extra.getSentries,
    nowMs: extra.nowMs });
  return { started, listeners, removed, timers, telemetry, lines, facade: started.ok ? started.transit : null };
}

function mover(env, tag, factionId, composition = TEN) {
  const fleetId = env.newFleet(tag, factionId, S.N0, composition);
  const op = env.fleets.createOperation({ operationType: "invasion", factionId, originSystemId: S.N0,
    targetSystemId: S.N9, objective: "capture", dueAt: env.clock.now() + HOUR,
    fleets: [{ fleetId, expectedVersion: env.fleet(fleetId).version }] }, `t:op:${tag}`);
  assert.ok(op.ok, JSON.stringify(op));
  const plan = env.fleets.planTravel({ fleetId, targetSystemId: S.N9, constraints: AVOID }, `t:plan:${tag}`);
  assert.ok(plan.ok, JSON.stringify(plan));
  return { fleetId, operationId: op.operationId, plan };
}

function dump(env) {
  const tables = env.q("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);
  return Object.fromEntries(tables.map((t) => [t, env.q(`SELECT * FROM "${t}"`).map((r) => JSON.stringify(r,
    (_k, v) => (typeof v === "bigint" ? String(v) : v))).sort()]));
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const t = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("TR3 riskIndex on fake pages: cold until the last page, entries, gateSentries, refused page, refresh swap", () => {
    const FOE = 30;
    const OTHER = 31;
    const rows = [row(101, "nullsec", FOE, [[OTHER, 90, 0], [FOE, 50, 2000]]), row(102, "nullsec", null),
      row(103, "lowsec", FOE, [[FOE, 100, 0]]), row(104, "nullsec", OTHER), row(105, "nullsec", FOE, [[FOE, 37.5, 0]])];
    const holder = {};
    const world = fakeWorld(rows, holder);
    const refs = [{ anchorKind: "gate", ownerKind: "faction", factionId: FOE },
      { anchorKind: "gate", ownerKind: "player", factionId: FOE }, { anchorKind: "station", ownerKind: "faction",
        factionId: FOE }, { anchorKind: "gate", ownerKind: "faction", factionId: OTHER },
      { anchorKind: "gate", ownerKind: "faction", factionId: FOE }];
    const sentries = { mode: "ready", getMode: () => sentries.mode,
      listLiveInSystem: (id) => (id === 101 ? refs : []) };
    let now = 1000;
    const built = [];
    const refused = [];
    const settings = { ...defaultSettings(), indexPageSize: 2 };
    const index = createRiskIndex({ world, getSentries: () => sentries, settings, nowMs: () => now,
      onBuilt: (info) => built.push(info), onPageRefused: (r) => refused.push(r) });
    assert.deepStrictEqual([index.isWarm(), index.get(101)], [false, null]);
    index.step();
    holder.refuseNext = true;
    index.step();
    assert.deepStrictEqual([refused, index.getStatus().building, index.getStatus().pageRefused],
      [["TX_BUSY"], { pages: 1, afterSystemId: 102 }, 1]);
    index.step();
    assert.strictEqual(index.isWarm(), false, "cold until the last page");
    index.step();
    assert.strictEqual(index.isWarm(), true);
    assert.deepStrictEqual(world.calls.map((c) => [c.afterSystemId, c.limit, c.includeInfluence]),
      [[0, 2, true], [102, 2, true], [102, 2, true], [104, 2, true]]);
    assert.deepStrictEqual(index.get(101), { systemId: 101, controllerFactionId: FOE, secClass: "nullsec",
      influence: 50, garrison: 2000, gateSentries: 2, chanceBase: 210 });
    assert.deepStrictEqual(index.get(104), { systemId: 104, controllerFactionId: OTHER, secClass: "nullsec",
      influence: 0, garrison: 0, gateSentries: 0, chanceBase: 80 });
    assert.deepStrictEqual([index.get(102), index.get(103), index.get(105).chanceBase], [null, null, 110]);
    assert.deepStrictEqual([built.length, built[0].systems, built[0].pages], [1, 3, 3]);
    assert.deepStrictEqual(index.getStatus().state, "warm");

    index.step();
    assert.strictEqual(world.calls.length, 4);
    now += settings.indexRefreshMs;
    sentries.mode = "stopped";
    holder.rows = rows.filter((r) => r.systemId !== 105);
    index.step();
    assert.deepStrictEqual([world.calls.length, index.get(101).gateSentries, index.get(105).chanceBase], [5, 2, 110]);
    index.step();
    index.step();
    assert.deepStrictEqual([index.get(101).gateSentries, index.get(101).chanceBase, index.get(105), built.length],
      [0, 160, null, 2]);
  });

  test("TR6: seed running -> cold, no read, indexWaitSeed; done -> warm; seed back to running at the last page "
    + "drops the build; an exception in step -> stepErrors + onPageRefused", () => {
    const FOE = 30;
    const rows = [row(101, "nullsec", FOE, [[FOE, 50, 0]]), row(102, "nullsec", FOE), row(103, "nullsec", FOE)];
    const seed = { state: "running" };
    const world = fakeWorld(rows);
    world.seed = { getStatus: () => ({ state: seed.state }) };
    const telemetry = fakeTelemetry();
    const holder = {};
    const refused = [];
    const settings = { ...defaultSettings(), indexPageSize: 2 };
    const index = createRiskIndex({ world, settings, nowMs: () => 1000, perfNow: () => 0, onWaitSeed: () => holder.service.noteIndexWaitSeed(), onPageRefused: (r) => {
      refused.push(r);
      holder.service.noteIndexPageRefused(r);
    } });
    holder.service = createTransitService({ fleetRepository: { getOperation: () => null }, index, settings,
      isHostile: () => true, telemetry });
    index.step();
    index.step();
    assert.deepStrictEqual([index.isWarm(), world.calls.length, index.getStatus().waitSeed, index.getStatus().seedWaits,
      holder.service.getStatus().counters.indexWaitSeed, telemetry.counts["transit.indexWaitSeed"]],
    [false, 0, "running", 2, 2, 2]);
    seed.state = "done";
    index.step();
    seed.state = "running";
    index.step();
    assert.deepStrictEqual([index.isWarm(), index.getStatus().building, world.calls.length, index.getStatus().seedWaits],
      [false, null, 2, 3]);
    seed.state = "already_applied";
    index.step();
    index.step();
    assert.deepStrictEqual([index.isWarm(), index.getStatus().systems, index.get(101).chanceBase,
      index.getStatus().waitSeed, world.calls.map((c) => c.afterSystemId)], [true, 3, 120, null, [0, 102, 0, 102]]);
    assert.deepStrictEqual([...SEED_READY], ["done", "already_applied", "skipped", "disabled"]);

    const cold = createRiskIndex({ world: fakeWorld(rows), settings, perfNow: () => {
      throw new Error("boom");
    }, onPageRefused: (r) => refused.push(r) });
    cold.step();
    assert.deepStrictEqual([cold.getStatus().stepErrors, cold.isWarm(), refused], [1, false, ["STEP_THREW:boom"]]);
    const throwingSeed = createRiskIndex({ world: { ...fakeWorld(rows), seed: { getStatus: () => {
      throw new Error("x");
    } } }, settings });
    throwingSeed.step();
    assert.deepStrictEqual([throwingSeed.getStatus().waitSeed, throwingSeed.getStatus().stepErrors], ["unknown", 0]);
  });

  t("TR4 observe on the real env: cold -> listenerIndexCold; warm -> 3 hostile crossings, contact chance; database "
    + "bit for bit; hunter class 250", () => {
    const plain = C.createEnv(driver);
    const env = C.createEnv(driver);
    try {
      const rows = [S.N5, S.N6, S.N7].sort((a, b) => a - b).map((id) => row(id, "nullsec", DEATHLESS,
        [[DEATHLESS, 50, 0]]));
      const tr = bootTransit(env, cfgOf(env), fakeWorld(rows));
      assert.ok(tr.started.ok, JSON.stringify(tr.started));
      assert.deepStrictEqual([tr.facade.getMode(), tr.listeners.length, tr.timers.live().length], ["observe", 1, 1]);
      assert.deepStrictEqual(tr.lines, ["transit: mode=observe handler=none secClasses=nullsec pageSize=256 "
        + "pageMs=2000 refreshMs=600000"]);
      mover(plain, "cold", C.SANSHA);
      mover(env, "cold", C.SANSHA);
      const c0 = tr.facade.getStatus().counters;
      assert.deepStrictEqual([c0.legsSeen, c0.listenerIndexCold, c0.legsHostile], [1, 1, 0]);
      assert.strictEqual(tr.facade.routeRiskOf(C.SANSHA, [S.N0, S.N5, S.N9]), null);

      tr.timers.run();
      assert.strictEqual(tr.facade.getStatus().index.state, "warm");
      assert.deepStrictEqual([tr.telemetry.counts["transit.indexBuilds"], tr.telemetry.gauges["transit.indexSystems"]],
        [1, 3]);
      const m = mover(env, "warm", C.SANSHA);
      mover(plain, "warm", C.SANSHA);
      assert.deepStrictEqual(m.plan.ok && [S.N0, S.N5, S.N6, S.N7, S.N9], env.fleet(m.fleetId).route.systems);
      const c1 = tr.facade.getStatus().counters;
      const expected = routeContactPermille([120, 120, 120]);
      assert.deepStrictEqual([c1.legsSeen, c1.listenerIndexCold, c1.legsHostile, c1.hostileCrossings,
        c1.hostileLegs3, c1[`contactBucket${Math.floor(expected / 100)}`]], [2, 1, 1, 3, 1, 1]);
      assert.deepStrictEqual([tr.telemetry.observed["transit.hostilePerLeg"],
        tr.telemetry.observed["transit.expectedContactPermille"]], [[3], [expected]]);
      assert.strictEqual(tr.telemetry.counts["transit.legsHostile"], 1);
      assert.deepStrictEqual(tr.facade.riskOf(S.N6), { systemId: S.N6, controllerFactionId: DEATHLESS,
        secClass: "nullsec", influence: 50, garrison: 0, gateSentries: 0, chanceBase: 120 });
      assert.strictEqual(tr.facade.routeRiskOf(C.SANSHA, [S.N0, S.N5, S.N6, S.N7, S.N9]).contactPermille, expected);

      assert.deepStrictEqual(dump(env), dump(plain));

      const r = env.store.transaction("t.hunter", (db) => tr.listeners[0](db, Object.freeze({ fleetId: m.fleetId,
        factionId: C.SANSHA, fleetRole: "hunter", shipCount: 10, operationId: m.operationId, legSeq: 9,
        leg: { systems: [S.N0, S.N5, S.N6, S.N7, S.N9], departAt: 0, jumpMs: 1 }, wormholes: false, chained: false })));
      assert.ok(r.ok, JSON.stringify(r));
      assert.deepStrictEqual(tr.telemetry.observed["transit.expectedContactPermille"], [expected,
        routeContactPermille([30, 30, 30])]);
      tr.facade.stop();
    } finally {
      plain.close();
      env.close();
    }
  });

  t("TR5 REQUIRED on the real facades; off -> disabled_by_config, no listener, no timer; stop(); stub; config", () => {
    const env = C.createEnv(driver);
    try {
      const wr = startWorld({ config: env.cfg, persistence: { ok: true, store: env.store, journal: env.journal },
        clock: env.clock });
      assert.ok(wr.ok, JSON.stringify(wr));
      try {
        const roots = { fleets: env.fleets, world: wr.world, sentries: createUnavailableSentries("t"),
          scheduler: env.scheduler, persistence: { store: env.store, journal: env.journal }, battle: env.battle,
          presence: createUnavailablePresence("t") };
        const missing = REQUIRED.filter((p) => {
          const parts = p.split(".");
          let v = roots[parts[0]];
          for (let i = 1; i < parts.length && v; i += 1) v = v[parts[i]];
          return typeof v !== "function";
        });
        assert.deepStrictEqual(missing, []);
        assert.deepStrictEqual([...SOFT_ROOTS], ["sentries", "battle", "presence"]);
        const real = bootTransit(env, cfgOf(env), wr.world);
        assert.ok(real.started.ok, JSON.stringify(real.started));
        real.timers.run();
        assert.deepStrictEqual([real.facade.getStatus().index.state, real.facade.getStatus().index.systems],
          ["warm", 0]);
        real.facade.stop();
      } finally {
        wr.world.stop("test");
      }

      const world = fakeWorld([]);
      const off = bootTransit(env, cfgOf(env, { enabled: false }), world);
      const noStrategy = cfgOf(env);
      noStrategy.modules.strategy = { enabled: false };
      const off2 = bootTransit(env, noStrategy, world);
      for (const o of [off, off2]) {
        assert.deepStrictEqual([o.started, o.listeners.length, o.timers.list.length],
          [{ ok: false, reason: "disabled_by_config" }, 0, 0]);
      }
      assert.deepStrictEqual(bootTransit(env, cfgOf(env, { indexPageSize: 1 }), world).started,
        { ok: false, reason: "INVALID_CONFIG", detail: "transit.indexPageSize" });
      assert.deepStrictEqual(bootTransit(env, cfgOf(env), { getStatus: () => ({ state: "stopped" }) }).started,
        { ok: false, reason: "WORLD_UNAVAILABLE" });

      const on = bootTransit(env, cfgOf(env), world);
      assert.ok(on.started.ok);
      on.facade.stop();
      on.facade.stop();
      assert.deepStrictEqual([on.removed.length, on.timers.live().length, on.facade.getMode(),
        on.facade.getStatus().listeners], [1, 0, "off", 0]);
      mover(env, "after-stop", C.SANSHA);
      assert.strictEqual(on.facade.getStatus().counters.legsSeen, 0);

      const stub = createUnavailableTransit("TRANSIT_DISABLED");
      assert.deepStrictEqual([stub.getMode(), stub.riskOf(1), stub.routeRiskOf(1, [1, 2, 3]), stub.getStatus().reason],
        ["off", null, null, "TRANSIT_DISABLED"]);
    } finally {
      env.close();
    }

    const def = config.resolveConfig({ modDir: MOD_DIR, env: {} });
    assert.deepStrictEqual([def.config.transit.enabled, def.config.transit.mode, def.config.transit.secClasses,
      def.config.transit.exemptOperationTypes, def.config.transit.maxChancePermille, def.config.transit.basePermille,
      def.config.transit.controlPermille, def.config.transit.defenderBonusPermille], [false, "observe", "nullsec",
      "return", 500, 150, 150, 150]);
    assert.deepStrictEqual(def.warnings.filter((w) => w.includes("transit")), []);
    const bad = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_TRANSIT_ENABLED: "1",
      EVEJS_LNE_TRANSIT_MODE: "hold", EVEJS_LNE_WORLD_ENABLED: "0", EVEJS_LNE_TRANSIT_LARGE_FLEET_MIN_SHIPS: "5" } });
    assert.strictEqual(bad.config.transit.mode, "observe");
    assert.strictEqual(config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_TRANSIT_MODE: "on" } }).config
      .transit.mode, "on");
    const tw = bad.warnings.filter((w) => w.includes("TRANSIT") || w.includes("transit."));
    assert.ok(tw.some((w) => w.includes("is not observe or on - ignored")), tw.join("\n"));
    assert.ok(tw.includes("transit.enabled without modules.world - the transit service does not start "
      + "(dependency_disabled:world)"), tw.join("\n"));
    assert.ok(tw.some((w) => w.startsWith("transit.largeFleetMinShips=5 not above transit.smallGangMaxShips=5")),
      tw.join("\n"));
  });
};
