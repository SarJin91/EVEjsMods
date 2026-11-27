"use strict";

const assert = require("node:assert");

const { startTransit, settingsOf, REQUIRED } = require("../../../lib/strategy/transit");
const { createTransitService } = require("../../../lib/strategy/transit/service");
const { harness: H } = require("../../battle/settlement.test");
const { harness: C } = require("../../battle/contacts.test");

const S = H.S;
const DEATHLESS = 500029;
const HOUR = 3600000;
const TEN = Object.freeze([{ hullGroup: "cruiser", count: 10 }]);
const THREE = Object.freeze([{ hullGroup: "frigate", count: 3 }]);
const BASE_ROUTE = Object.freeze([S.N0, S.N5, S.N6]);
const DETOUR = Object.freeze([S.N0, S.H1, S.N9, S.N7, S.N6]);

function cfgOf(env, transit = {}) {
  const c = JSON.parse(JSON.stringify(env.cfg));
  c.modules.strategy = { enabled: true };
  c.persistence.maxRowsPerTransaction = 1100;
  c.transit = { ...c.transit, enabled: true, mode: "on", advisorEnabled: true, basePermille: 300, ...transit };
  return c;
}

const sysRow = (systemId) => ({ systemId, securityClass: "nullsec", controllerFactionId: DEATHLESS,
  influence: [{ systemId, factionId: DEATHLESS, influenceScore: 0, garrisonStrength: 0 }] });

function fakeWorld(rows) {
  const byId = new Map(rows.map((r) => [r.systemId, r]));
  const sorted = [...rows].sort((a, b) => a.systemId - b.systemId);
  return { getStatus: () => ({ state: "ready" }), listSystems(opts) {
    const page = sorted.filter((r) => r.systemId > opts.afterSystemId).slice(0, opts.limit);
    return { ok: true, systems: page, nextAfterSystemId: page.length === opts.limit ? page[page.length - 1].systemId
      : null };
  }, repository: {
    getSystem: (_tx, id) => ({ ok: true, system: byId.get(id) || null }),
    getSystems: (_tx, ids) => ({ ok: true, systems: ids.map((id) => byId.get(id)).filter(Boolean),
      missing: ids.filter((id) => !byId.has(id)) }),
  } };
}

function boot(env, cfg) {
  const timers = [];
  const lines = [];
  const started = startTransit({ config: cfg, persistence: { ok: true, store: env.store, journal: env.journal,
    worldSeed: 11 }, scheduler: env.scheduler, fleets: env.fleets,
  world: fakeWorld([sysRow(S.N5), sysRow(S.N6), sysRow(S.N7)]), logger: { log: (l) => lines.push(l) },
  setTimer: (fn) => {
    const t = { fn, done: false };
    timers.push(t);
    return { cancel: () => {
      t.done = true;
    }, hasRef: () => false };
  }, getBattle: () => env.battle, getPresence: () => null });
  if (started.ok) {
    for (const t of timers.filter((x) => !x.done)) {
      t.done = true;
      t.fn();
    }
  }
  return { started, lines, facade: started.ok ? started.transit : null };
}

function opFleet(env, tag, factionId, composition = TEN) {
  const r = env.fleets.createFleet({ factionId, currentSystemId: S.N0, homeSystemId: S.N0, fleetRole: "invasion",
    composition: composition.map((e) => ({ ...e })) }, `t:f:${tag}`);
  assert.ok(r.ok, JSON.stringify(r));
  const op = env.fleets.createOperation({ operationType: "invasion", factionId, originSystemId: S.N0,
    targetSystemId: S.N6, objective: "capture", dueAt: env.clock.now() + HOUR,
    fleets: [{ fleetId: r.fleetId, expectedVersion: env.fleet(r.fleetId).version }] }, `t:op:${tag}`);
  assert.ok(op.ok, JSON.stringify(op));
  return r.fleetId;
}

const plan = (env, id, tag) => env.fleets.planTravel({ fleetId: id, targetSystemId: S.N6 }, `t:plan:${tag}`);
const routeOf = (env, id) => [...env.fleet(id).route.systems];

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const t = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  t("TA1 travel soft advice: kept / detour / hard TRANSIT_RISK / invalid soft or detail; who.shipCount", () => {
    const env = C.createEnv(driver);
    try {
      const c = () => env.fleets.travel.getCounters();
      const seen = [];
      const withAdvice = (advice, tag) => {
        const a = env.fleets.travel.addRouteAdvisor((who, q) => {
          seen.push(who);
          return q.route.includes(S.N5) ? advice : null;
        });
        assert.ok(a.ok);
        const id = opFleet(env, tag, C.SANSHA);
        const r = plan(env, id, tag);
        a.remove();
        return { id, r };
      };
      const c0 = c();
      const kept = withAdvice({ avoidSystemIds: [S.N5], detourMaxJumps: 0, soft: true, detail: "TRANSIT_RISK" },
        "kept");
      assert.ok(kept.r.ok, JSON.stringify(kept.r));
      assert.deepStrictEqual(routeOf(env, kept.id), BASE_ROUTE);
      const c1 = c();
      assert.deepStrictEqual([c1.routeAdviceSoftKept - c0.routeAdviceSoftKept,
        c1.routeAdviceRefused - c0.routeAdviceRefused, c1.routeAdvised - c0.routeAdvised], [1, 0, 0]);
      assert.strictEqual(seen[0].shipCount, 10);
      const det = withAdvice({ avoidSystemIds: [S.N5], detourMaxJumps: 2, soft: true, detail: "TRANSIT_RISK" }, "det");
      assert.ok(det.r.ok, JSON.stringify(det.r));
      assert.deepStrictEqual(routeOf(env, det.id), DETOUR);
      const c2 = c();
      assert.deepStrictEqual([c2.routeAdvised - c1.routeAdvised, c2.routeAdvisedSoft - c1.routeAdvisedSoft,
        c2.routeAdviceSoftKept - c1.routeAdviceSoftKept], [1, 1, 0]);
      const hard = withAdvice({ avoidSystemIds: [S.N5], detourMaxJumps: 1, detail: "TRANSIT_RISK" }, "hard");
      assert.deepStrictEqual(hard.r, { ok: false, reason: "TOO_FAR", jumps: 4, detail: "TRANSIT_RISK" });
      assert.strictEqual(env.fleet(hard.id).state, "PLANNED");
      const c3 = c();
      const badDetail = withAdvice({ avoidSystemIds: [S.N5], detourMaxJumps: 2, detail: "X" }, "bad-detail");
      const badSoft = withAdvice({ avoidSystemIds: [S.N5], detourMaxJumps: 2, soft: "yes" }, "bad-soft");
      assert.ok(badDetail.r.ok && badSoft.r.ok);
      assert.deepStrictEqual([routeOf(env, badDetail.id), routeOf(env, badSoft.id)], [BASE_ROUTE, BASE_ROUTE]);
      const c4 = c();
      assert.deepStrictEqual([c4.advisorErrors - c3.advisorErrors, c4.routeAdvised - c3.routeAdvised], [2, 0]);
    } finally {
      env.close();
    }
  });

  t("TA2 transit advisor: regular fleet detours around N5 (advised, advisedSystems, advisors 1); above the chance / "
    + "small gang -> base route; cold index -> advisorIndexCold; advisorEnabled off / observe -> advisors 0", () => {
    assert.ok(REQUIRED.includes("fleets.travel.addRouteAdvisor"));
    const env = C.createEnv(driver);
    try {
      const travel = () => env.fleets.travel.getCounters();
      let tr = boot(env, cfgOf(env));
      assert.ok(tr.started.ok, JSON.stringify(tr.started));
      assert.deepStrictEqual([tr.facade.getStatus().advisors, tr.facade.getStatus().index.state], [1, "warm"]);
      assert.ok(tr.lines[0].endsWith(" advisor=on avoid=250 detour=2"), tr.lines[0]);
      const t0 = travel();
      const a = opFleet(env, "ta2-a", C.SANSHA);
      assert.ok(plan(env, a, "ta2-a").ok);
      assert.deepStrictEqual(routeOf(env, a), DETOUR);
      const st = tr.facade.getStatus().counters;
      assert.deepStrictEqual([st.advised, st.advisedSystems, travel().routeAdvisedSoft - t0.routeAdvisedSoft],
        [1, 1, 1]);
      const g = opFleet(env, "ta2-g", C.SANSHA, THREE);
      assert.ok(plan(env, g, "ta2-g").ok);
      assert.deepStrictEqual([routeOf(env, g), tr.facade.getStatus().counters.advised], [BASE_ROUTE, 1]);
      const c2 = tr.facade.getStatus().counters;
      assert.deepStrictEqual([c2.advisorCalls, c2.advisorHostileRoutes], [2, 2]);
      tr.facade.stop();
      tr = boot(env, cfgOf(env, { advisorAvoidPermille: 301 }));
      const b = opFleet(env, "ta2-b", C.SANSHA);
      assert.ok(plan(env, b, "ta2-b").ok);
      assert.deepStrictEqual([routeOf(env, b), tr.facade.getStatus().counters.advised], [BASE_ROUTE, 0]);
      tr.facade.stop();
      for (const [tag, over] of [["off", { advisorEnabled: false }], ["obs", { mode: "observe" }]]) {
        tr = boot(env, cfgOf(env, over));
        assert.ok(tr.started.ok, JSON.stringify(tr.started));
        const x = opFleet(env, `ta2-${tag}`, C.SANSHA);
        assert.ok(plan(env, x, `ta2-${tag}`).ok);
        assert.deepStrictEqual([tr.facade.getStatus().advisors, routeOf(env, x)], [0, BASE_ROUTE], tag);
        tr.facade.stop();
      }
      const svc = createTransitService({ fleetRepository: {}, settings: settingsOf(cfgOf(env)).settings, mode: "on",
        index: { isWarm: () => false, get: () => null, getStatus: () => null }, isHostile: () => true });
      const advice = svc.routeAdvice({ fleetId: "f", factionId: C.SANSHA, fleetRole: "invasion", shipCount: 10 },
        { start: S.N0, target: S.N6, at: 0, route: BASE_ROUTE, wormholes: false });
      assert.deepStrictEqual([advice, svc.getStatus().counters.advisorIndexCold], [null, 1]);
    } finally {
      env.close();
    }
  });
};
