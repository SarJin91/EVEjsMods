"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { planMerges, MERGE_ROLES_ALLOWED } = require("../../../lib/strategy/ai/merge");
const { reviewRowBound, MERGE_ROWS } = require("../../../lib/strategy/reviewRows");
const { resolveConfig } = require("../../../config");
const { createManualClock } = require("../../../lib/util/clock");
const { createRng } = require("../../../lib/util/rng");
const { createIdGenerator } = require("../../../lib/util/ids");
const { harness: H } = require("../../battle/settlement.test");
const { harness: R } = require("../review.test");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const SANSHA = 500019;
const P = (over) => ({ merge: { roles: ["scout", "garrison"], maxPerReview: 2, maxShipsPerFleet: 500, ...over } });
const fleet = (fleetId, systemId, shipCount, over) => ({ fleetId, version: 3, state: "IDLE", fleetRole: "scout",
  systemId, refitPending: false, shipCount, operationId: null, ...over });

module.exports = ({ test, skip }) => {
  test("MG1 merge: 3 scouts in one system -> 1 intent (keeper = smallest fleetId on a ship tie), note MERGE; "
    + "2 groups in 2 systems -> 2 intents, limit 1 -> MERGE_LIMIT", () => {
    const one = planMerges({ fleets: [fleet("s3", 10, 1), fleet("s1", 10, 1), fleet("s2", 10, 1)] }, P(), new Set());
    assert.deepStrictEqual(one, { intents: [{ type: "MERGE", systemId: 10, fleetRole: "scout",
      keeper: { fleetId: "s1", expectedVersion: 3 }, absorbed: { fleetId: "s2", expectedVersion: 3 } }],
    notes: ["MERGE"] });
    const big = planMerges({ fleets: [fleet("a", 10, 1), fleet("b", 10, 4)] }, P(), new Set());
    assert.deepStrictEqual([big.intents[0].keeper.fleetId, big.intents[0].absorbed.fleetId], ["b", "a"]);
    const two = [fleet("g2", 20, 2, { fleetRole: "garrison" }), fleet("g1", 20, 1, { fleetRole: "garrison" }),
      fleet("s1", 10, 1), fleet("s2", 10, 1)];
    const both = planMerges({ fleets: two }, P(), new Set());
    assert.deepStrictEqual(both.intents.map((i) => [i.systemId, i.fleetRole, i.keeper.fleetId, i.absorbed.fleetId]),
      [[10, "scout", "s1", "s2"], [20, "garrison", "g2", "g1"]]);
    assert.deepStrictEqual(both.notes, ["MERGE"]);
    const used = new Set();
    const lim = planMerges({ fleets: two }, P({ maxPerReview: 1 }), used);
    assert.deepStrictEqual([lim.intents.length, lim.intents[0].systemId, lim.notes], [1, 10, ["MERGE", "MERGE_LIMIT"]]);
    assert.deepStrictEqual([...used].sort(), ["s1", "s2"], "the merged fleets join `used`");
  });

  test("MG2 merge: an operation, a refit, `used`, another role, TRAVELLING, truncated read or a sum above "
    + "maxShipsPerFleet -> no intent; merge off -> nothing", () => {
    const base = fleet("s1", 10, 2);
    const cases = [{ operationId: "op1" }, { refitPending: true }, { fleetRole: "garrison" }, { state: "TRAVELLING" },
      { fleetRole: "logistics" }];
    for (const over of cases) {
      const r = planMerges({ fleets: [base, fleet("s2", 10, 1, over)] }, P(), new Set());
      assert.deepStrictEqual(r, { intents: [], notes: [] }, JSON.stringify(over));
    }
    const pair = [base, fleet("s2", 10, 1)];
    assert.deepStrictEqual(planMerges({ fleets: pair }, P(), new Set(["s2"])).intents, []);
    assert.deepStrictEqual(planMerges({ fleets: pair, fleetsTruncated: true }, P(), new Set()).intents, []);
    assert.deepStrictEqual(planMerges({ fleets: pair }, P({ maxShipsPerFleet: 2 }), new Set()).intents, []);
    assert.deepStrictEqual(planMerges({ fleets: pair }, { merge: null }, new Set()).intents, []);
    assert.deepStrictEqual(planMerges({ fleets: pair }, P({ roles: ["logistics", "garrison"] }), new Set()).intents, []);
    const skip3 = planMerges({ fleets: [fleet("k", 10, 4), fleet("a", 10, 3), fleet("b", 10, 1)] },
      P({ maxShipsPerFleet: 5 }), new Set());
    assert.deepStrictEqual(skip3.intents.map((i) => [i.keeper.fleetId, i.absorbed.fleetId]), [["k", "b"]]);
  });

  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("MG3 merge on a real store: 2 idle garrison fleets at a Sansha station -> the absorbed one DESTROYED "
    + "(composition []), the keeper has the sum, 3 journal rows + 2 fleet rows (MERGE_ROWS 5), counter merged 1; "
    + "the replayed effect is a duplicate without a write", () => H.withStore(driver, async (reopen) => {
    const clock = createManualClock(R.START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(31) }), graph: R.graphOf(),
      controllers: new Map(R.THEATRE.map((id) => [id, SANSHA])) };
    const holder = { mark: false, effect: null };
    const hooks = { beforeEffect: (d) => {
      if (!holder.effect && d.factionId === SANSHA && (d.intents || []).some((i) => i.type === "MERGE")) {
        holder.mark = true;
      }
      return d;
    } };
    const wrapScheduler = (sch) => ({ ...sch, registerHandler: (type, h, o) => sch.registerHandler(type, (ev, hctx) => {
      const r = h(ev, hctx);
      if (r && r.effect && holder.mark) {
        holder.mark = false;
        holder.effect = r.effect;
      }
      return r;
    }, o) });
    const e = await R.bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: String(SANSHA),
      EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8", EVEJS_LNE_PRODUCTION_TARGET_STOCK_FLEETS: "0",
      EVEJS_LNE_STRATEGY_MERGE_ENABLED: "1" }, { hooks, wrapScheduler });
    const base = e.q("SELECT system_id FROM world_stations WHERE owner_faction_id = ? AND state = 'ONLINE' "
      + "ORDER BY station_id", SANSHA)[0];
    assert.ok(base, "a Sansha station");
    const mk = (key, composition) => {
      const r = e.fleets.createFleet({ factionId: SANSHA, currentSystemId: base.system_id,
        homeSystemId: base.system_id, fleetRole: "garrison", composition }, key);
      assert.ok(r.ok, JSON.stringify(r));
      return r.fleetId;
    };
    const big = mk("mg3:big", [{ hullGroup: "frigate", count: 3 }]);
    const small = mk("mg3:small", [{ hullGroup: "frigate", count: 1 }, { hullGroup: "destroyer", count: 1 }]);
    const row = (id) => e.q("SELECT state, ship_count AS n, version AS v, composition_json AS c FROM virtual_fleets "
      + "WHERE fleet_id = ?", id)[0];
    const v0 = [row(big).v, row(small).v];
    await R.passesAt(e, shared, R.START_MS + R.I);
    assert.ok(typeof holder.effect === "function", "the MERGE was planned");
    const k = row(big);
    const a = row(small);
    assert.deepStrictEqual([a.state, a.n, JSON.parse(a.c)], ["DESTROYED", 0, []]);
    assert.strictEqual(k.state, "IDLE");
    assert.strictEqual(k.n, 5);
    assert.deepStrictEqual(JSON.parse(k.c).map((x) => [x.hullGroup, x.count]), [["destroyer", 1], ["frigate", 4]]);
    assert.deepStrictEqual([k.v - v0[0], a.v - v0[1]], [1, 1], "one fleet row write each");
    const keys = e.q("SELECT idempotency_key AS k FROM world_event_journal WHERE idempotency_key LIKE ? "
      + "ORDER BY idempotency_key", `strategy:review:${SANSHA}:%:MERGE%`).map((x) => x.k);
    assert.strictEqual(keys.length, 3, JSON.stringify(keys));
    assert.deepStrictEqual(keys.slice(1), [`${keys[0]}:fleet`, `${keys[0]}:merge`]);
    assert.strictEqual(MERGE_ROWS, 5);
    const c = e.strategy.getStatus().ai.review.counters;
    assert.deepStrictEqual([c.merged, c.mergeRefused || 0], [1, 0], JSON.stringify(c));
    assert.ok(e.lines.some((l) => l.includes(` merge ${small} -> ${big} garrison`)), JSON.stringify(e.lines));
    const rows = () => e.q("SELECT (SELECT count(*) FROM world_event_journal) AS j, (SELECT group_concat(version) "
      + "FROM virtual_fleets WHERE fleet_id IN (?, ?)) AS v", big, small)[0];
    const before = rows();
    const replay = e.tx((db) => holder.effect(db));
    assert.ok(replay.ok && replay.applied.MERGE === undefined, JSON.stringify(replay));
    assert.deepStrictEqual(rows(), before, "duplicate: no write");
    e.strategy.stop("test");
  }));

  test("MG4 merge config: defaults (on since IF2, 2, scout,garrison), a role with its own counters refused "
    + "(warning, default kept), reviewRowBound + MERGE_ROWS x maxMergesPerReview (10) only with the flag", () => {
    const resolve = (env) => resolveConfig({ modDir: MOD_DIR, env });
    const def = resolve({});
    const S = def.config.strategy;
    assert.deepStrictEqual([S.mergeEnabled, S.maxMergesPerReview, S.mergeRoles], [true, 2, "scout,garrison"]);
    assert.ok(!def.warnings.some((w) => w.includes("MERGE")), def.warnings.join("\n"));
    for (const bad of ["logistics", "scout,mining", "hunter", "capsuleer", "mercenary", "scout,scout", "ghost"]) {
      const r = resolve({ EVEJS_LNE_STRATEGY_MERGE_ROLES: bad });
      assert.strictEqual(r.config.strategy.mergeRoles, "scout,garrison", bad);
      assert.ok(r.warnings.some((w) => w.startsWith(`EVEJS_LNE_STRATEGY_MERGE_ROLES=`) || w.includes("mergeRoles")),
        r.warnings.join("\n"));
    }
    assert.strictEqual(resolve({ EVEJS_LNE_STRATEGY_MERGE_ROLES: "none" }).config.strategy.mergeRoles, "none");
    assert.strictEqual(resolve({ EVEJS_LNE_STRATEGY_MERGE_ROLES: "patrol,reserve" }).config.strategy.mergeRoles,
      "patrol,reserve");
    assert.ok(!MERGE_ROLES_ALLOWED.includes("logistics") && MERGE_ROLES_ALLOWED.includes("garrison"));
    const c = def.config;
    const args = [c.strategy, c.mining, c.production,
      { maxAbandonsPerReview: c.upkeep.maxAbandonsPerReview, maxFactionsPerSystem: c.world.maxFactionsPerSystem },
      c.logistics, c.construction, { maxReliefPerReview: c.siege.maxReliefPerReview },
      { maxOffersPerReview: c.trade.maxOffersPerReview, maxCancelsPerReview: c.trade.maxCancelsPerReview },
      { maxDefensePerReview: c.strategy.maxDefensePerReview }, null, null];
    const off = reviewRowBound(...args);
    assert.strictEqual(off, 976, "GD4 unchanged");
    assert.strictEqual(reviewRowBound(...args, null), off);
    assert.strictEqual(reviewRowBound(...args, { maxMergesPerReview: S.maxMergesPerReview }) - off, 10);
    assert.strictEqual(reviewRowBound(...args, { maxMergesPerReview: S.maxMergesPerReview }), 986,
      "GD4 with the default merge flag");
    const offFlag = resolve({ EVEJS_LNE_STRATEGY_MERGE_ENABLED: "0" });
    assert.deepStrictEqual([offFlag.config.strategy.mergeEnabled, offFlag.warnings], [false, []]);
  });
};
