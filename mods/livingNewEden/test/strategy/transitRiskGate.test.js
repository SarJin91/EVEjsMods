"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const { gateOn, riskOf, skippedByRisk, raisedByRisk, operationShipCountOf } = require("../../lib/strategy/ai/transitRiskGate");
const { createTransitRiskReader } = require("../../lib/strategy/transitRiskReader");
const { describeNote } = require("../../lib/strategy/activity/notes");
const { resolveConfig } = require("../../config");
const { createRng } = require("../../lib/util/rng");
const { createIdGenerator } = require("../../lib/util/ids");
const { createManualClock } = require("../../lib/util/clock");
const { harness: G } = require("./attackLossGate.test");
const { harness: H } = require("../battle/settlement.test");
const { harness: R } = require("./review.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const GATE = Object.freeze({ skipPermille: 700, raiseStepPermille: 500 });

const fakeRisk = (entries) => {
  const m = new Map(entries);
  return { of: (from, to) => (m.has(`${from}:${to}`) ? m.get(`${from}:${to}`) : 0), stats: () => ({}) };
};
const withRisk = (s, entries) => ({ ...s, transitRisk: fakeRisk(entries) });

const LAUNCH_OF = (kind, systemId, fleetId, dueAt) => ({ type: "LAUNCH", kind,
  target: { kind: "system", systemId, ref: null }, originSystemId: 20, fleets: [{ fleetId, expectedVersion: 2 }],
  mobilize: [], dueAt });
const BEFORE_SUB3 = Object.freeze({
  ops: { intents: [{ slot: 0, ...LAUNCH_OF("invasion", 24, "inv1", 1760007200000) }], notes: [],
    targets: [{ systemId: 24, score: 860, candidates: 1 }], frontCount: 1 },
  pt: { intents: [LAUNCH_OF("patrol", 21, "p1", 1760003600000)], notes: ["PATROL:21"] },
  mr: { intents: [LAUNCH_OF("gank", 18, "r20", 1760003600000)], notes: ["MINER_RAID:18"], seen: 2 },
});

function configOf(env) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } });
  assert.deepStrictEqual(r.errors || [], []);
  return r;
}

module.exports = ({ test, skip }) => {
  test("TA3 transitRiskGate: gateOn, riskOf fail-open, skippedByRisk (equal = no skip), raisedByRisk", () => {
    const s = { transitRisk: fakeRisk([["1:2", 300]]) };
    assert.deepStrictEqual([gateOn(s, { transitRisk: GATE }), gateOn(s, {}), gateOn({}, { transitRisk: GATE }),
      gateOn({ transitRisk: {} }, { transitRisk: GATE })], [true, false, false, false]);
    assert.strictEqual(riskOf(s, 1, 2, {}), 300);
    assert.strictEqual(riskOf({ transitRisk: { of: () => {
      throw new Error("boom");
    } } }, 1, 2, {}), null);
    assert.strictEqual(riskOf({ transitRisk: { of: () => Number.NaN } }, 1, 2, {}), null);
    assert.strictEqual(riskOf({}, 1, 2, {}), null);
    assert.deepStrictEqual([skippedByRisk(700, GATE), skippedByRisk(701, GATE), skippedByRisk(null, GATE),
      skippedByRisk(900, null)], [false, true, false, false]);
    assert.deepStrictEqual([raisedByRisk(100, 300, GATE), raisedByRisk(100, null, GATE), raisedByRisk(100, 0, GATE),
      raisedByRisk(100, 300, null)], [115, 100, 100, 100]);
    const T = [{ count: 4 }, { count: 6 }];
    assert.deepStrictEqual([operationShipCountOf(T, { ...GATE, templateShips: true }), operationShipCountOf(T, GATE),
      operationShipCountOf([{ count: "x" }], { templateShips: true }), operationShipCountOf(null, { templateShips: true })],
    [10, null, null, null]);
  });

  test("TA4 planners: operations skip / raise, patrol group 2 and minerRaids the next target; gate off = as before",
    () => {
      const { snap, row, intelOf, fleet, ops, launches, mrScene, mr, pt, targets, PARAMS, WING, POWER, BASE } = G;
      const on = { ...PARAMS, transitRisk: GATE };
      const { strengthOf } = require("../../lib/strategy/ai/strength");
      const P = strengthOf(WING, POWER);
      const one = () => snap({ theatre: [24], systems: [row(24, null)], intel: [intelOf(24, Math.floor(P / 1.2) - 1)],
        fleets: [fleet("inv1", BASE, "invasion")] });
      assert.deepStrictEqual(launches(ops(one(), PARAMS)), [[24, 1, 0]]);
      const skipped = ops(withRisk(one(), [[`${BASE}:24`, 800]]), on);
      assert.deepStrictEqual(launches(skipped), [], JSON.stringify(skipped.intents));
      assert.deepStrictEqual(skipped.notes.filter((n) => n.startsWith("TRANSIT_RISK")), ["TRANSIT_RISK_SKIP"]);
      const raised = ops(withRisk(one(), [[`${BASE}:24`, 600]]), on);
      assert.deepStrictEqual(launches(raised), [[24, 1, 1]], JSON.stringify(raised));
      assert.deepStrictEqual(raised.notes.filter((n) => n.startsWith("TRANSIT_RISK")), ["TRANSIT_RISK_RAISED"]);
      const ptTwo = () => snap({ operationTypes: ["recon", "raid", "patrol", "return"],
        systems: [row(21, null), row(24, null)], fleets: [fleet("p1", BASE, "patrol")] });
      assert.deepStrictEqual(targets(pt(ptTwo(), PARAMS)), [21]);
      const ptOn = pt(withRisk(ptTwo(), [[`${BASE}:21`, 800]]), on);
      assert.deepStrictEqual([targets(ptOn), ptOn.notes.includes("TRANSIT_RISK_SKIP")], [[24], true]);
      assert.deepStrictEqual(targets(mr(mrScene(), PARAMS)), [18]);
      const mrOn = mr(withRisk(mrScene(), [[`${BASE}:18`, 800]]), on);
      assert.deepStrictEqual([targets(mrOn), mrOn.notes.includes("TRANSIT_RISK_SKIP")], [[24], true]);
      const risky = [[`${BASE}:24`, 800], [`${BASE}:21`, 800], [`${BASE}:18`, 800]];
      for (const r of [ops(one(), PARAMS), ops(withRisk(one(), risky), PARAMS), ops(one(), on)]) {
        assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), BEFORE_SUB3.ops);
      }
      for (const r of [pt(ptTwo(), PARAMS), pt(withRisk(ptTwo(), risky), PARAMS), pt(ptTwo(), on)]) {
        assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), BEFORE_SUB3.pt);
      }
      for (const r of [mr(mrScene(), PARAMS), mr(withRisk(mrScene(), risky), PARAMS), mr(mrScene(), on)]) {
        assert.deepStrictEqual(JSON.parse(JSON.stringify(r)), BEFORE_SUB3.mr);
      }
      const movers = [];
      const spy = (s) => ({ ...s, transitRisk: { of: (a, b, m) => {
        movers.push(m.shipCount);
        return 0;
      }, stats: () => ({}) } });
      ops(spy(one()), on);
      ops(spy(one()), { ...PARAMS, transitRisk: { ...GATE, templateShips: true } });
      const tpl = one().doctrine.templates.invasion;
      assert.deepStrictEqual(movers, [null, tpl.reduce((s, e) => s + e.count, 0)]);
    });

  test("TA5 reader memo / cap / cold; config defaults, W63 / W164 / W165; notes known", () => {
    let finds = 0;
    const graph = { findRoute: (a, b) => {
      finds += 1;
      return { ok: true, route: [a, 99, b], jumps: 2 };
    } };
    let cold = false;
    const transit = { routeRiskOf: (f, systems) => (cold ? null : { contactPermille: systems.length * 100 }) };
    const r = createTransitRiskReader({ graph, transit, factionId: 7, maxRoutes: 1 });
    assert.deepStrictEqual([r.of(1, 2), r.of(1, 2), finds, r.of(3, 4), r.of(5, 5), r.of(0, 2)], [300, 300, 1, null,
      0, null]);
    cold = true;
    assert.strictEqual(r.of(1, 2), null);
    assert.deepStrictEqual(r.stats(), { routes: 1, capped: 1, cold: 1, errors: 0 });

    const d = configOf({}).config.transit;
    assert.deepStrictEqual([d.advisorEnabled, d.advisorAvoidPermille, d.advisorDetourMaxJumps, d.aiGateEnabled,
      d.aiSkipRouteRiskPermille, d.aiRaiseStepPermille, d.aiOperationTemplateShips],
    [false, 250, 2, false, 700, 500, false]);
    const warned = (env, text) => configOf(env).warnings.some((w) => w.includes(text));
    assert.ok(warned({ EVEJS_LNE_TRANSIT_ADVISOR_ENABLED: "1" },
      "transit.advisorEnabled/aiGateEnabled without transit.enabled"));
    assert.ok(warned({ EVEJS_LNE_TRANSIT_ENABLED: "1", EVEJS_LNE_TRANSIT_AI_GATE_ENABLED: "1" },
      "with transit.mode=observe - no effect until mode=on"));
    assert.ok(warned({ EVEJS_LNE_TRANSIT_ENABLED: "1", EVEJS_LNE_TRANSIT_MODE: "on",
      EVEJS_LNE_TRANSIT_ADVISOR_ENABLED: "1", EVEJS_LNE_TRANSIT_ADVISOR_DETOUR_MAX_JUMPS: "64" },
    "transit.advisorDetourMaxJumps=64 above graph.routeMaxJumps=40"));
    assert.ok(!warned({}, "transit.advisorEnabled/aiGateEnabled"));
    assert.deepStrictEqual(["TRANSIT_RISK_SKIP", "TRANSIT_RISK_RAISED"].map((n) => describeNote(n).known),
      [true, true]);
  });

  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };
  needsDriver("TA5r review: snapshot.transitRisk only with the transit facade in mode on (observe -> absent)",
    async () => {
      const run = (mode) => H.withStore(driver, async (reopen) => {
        const clock = createManualClock(R.START_MS);
        const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(23) }), graph: R.graphOf(),
          controllers: new Map(R.THEATRE.map((id) => [id, R.SANSHA])) };
        const seen = [];
        const hooks = { beforeEffect: (dd, snapshot) => {
          seen.push(snapshot.transitRisk ? typeof snapshot.transitRisk.of : "absent");
          return dd;
        } };
        const transit = { getMode: () => mode, routeRiskOf: () => ({ contactPermille: 0 }) };
        const env = await R.bootAll(reopen(), shared, { EVEJS_LNE_TRANSIT_ENABLED: "1", EVEJS_LNE_TRANSIT_MODE: "on",
          EVEJS_LNE_TRANSIT_AI_GATE_ENABLED: "1", EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8" },
        { hooks, getTransit: () => transit });
        await R.passesAt(env, shared, R.START_MS + R.I);
        env.strategy.stop("test");
        env.stations.stop("test");
        return seen;
      });
      const obs = await run("observe");
      const on = await run("on");
      assert.ok(obs.length > 0 && on.length > 0, JSON.stringify({ obs, on }));
      assert.deepStrictEqual([[...new Set(obs)], [...new Set(on)]], [["absent"], ["function"]]);
    });
};
