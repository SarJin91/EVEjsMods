"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const { planUnitPurchase } = require("../../lib/strategy/ai/unitPurchase");
const { UNIT_PURCHASE_ROWS } = require("../../lib/strategy/reviewRows");
const { rowBoundsOfConfig } = require("../../lib/strategy/reviewBound");
const { createReviewService } = require("../../lib/strategy/reviewService");
const { JOURNAL_TABLE } = require("../../lib/persistence/migrations");
const config = require("../../config");
const { createManualClock } = require("../../lib/util/clock");
const { createRng } = require("../../lib/util/rng");
const { createIdGenerator } = require("../../lib/util/ids");
const { createViewRegistry } = require("../../lib/observer/views");
const { harness: H } = require("../battle/settlement.test");
const { harness: R } = require("./review.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const REVIEW = "FACTION_STRATEGY_REVIEW";
const PRICE = 4000000;

const P = Object.freeze({ offensiveReservePeriods: 12, maxResourceUnits: 1000000000, iskTopUpEnabled: true,
  iskPerUnit: PRICE, iskTopUpMaxUnitsPerPeriod: 50, iskTopUpKinds: "empire", iskTopUpFloorPermille: 800,
  iskTopUpHeadroomPeriods: 2, iskTopUpRoomSharePermille: 500 });
const SNAP = Object.freeze({ entry: { kind: "empire" }, treasury: { initialIsk: 5e12, accountMode: "NORMAL" } });

function upkeepOf(o = {}) {
  return { intents: [{ type: "UPKEEP", periods: 1, charged: 1, income: 360, cost: 338, delta: 22 }], notes: ["X"],
    projected: { resourceUnits: 3481, reserveUnits: 10 }, offensiveAllowed: false, unpaidPeriods: 0,
    rates: { income: 360, cost: 338, reserveIncome: 2, tradeUnits: 0 }, ...o };
}
function projOf(o = {}) {
  return { austerity: false, projectedIsk: 5.03e12, austerityEnterIsk: 5e11,
    war: { room: 2e10, dayBudget: 3e10, spentToday: 0, productionCap: 1e10 }, ...o };
}
const paramsOf = (o = {}) => ({ upkeep: { ...P, ...o } });

module.exports = ({ test, skip }) => {
  test("UP1 brake on the reserve, balance above the floor: purchase <= limit, isk = units x price, ISK projections "
    + "lowered; units covering the need -> offensiveAllowed true", () => {
    const u0 = upkeepOf();
    const p0 = projOf();
    const b = planUnitPurchase(SNAP, u0, p0, paramsOf());
    assert.deepStrictEqual(b.purchase, { units: 50, isk: 50 * PRICE });
    assert.deepStrictEqual(b.notes, ["UNIT_PURCHASE:50"]);
    assert.deepStrictEqual(b.upkeep.intents[0].purchase, b.purchase);
    assert.strictEqual(u0.intents[0].purchase, undefined, "input untouched");
    assert.deepStrictEqual([b.upkeep.projected.resourceUnits, b.upkeep.offensiveAllowed, b.upkeep.notes],
      [3531, false, ["X"]]);
    assert.deepStrictEqual([b.proj.projectedIsk, b.proj.war.room, b.proj.war.productionCap],
      [5.03e12 - 2e8, 2e10 - 2e8, 1e10]);
    const all = planUnitPurchase(SNAP, u0, p0, paramsOf({ iskTopUpMaxUnitsPerPeriod: 5000 }));
    assert.deepStrictEqual([all.purchase.units, all.upkeep.projected.resourceUnits, all.upkeep.offensiveAllowed],
      [1251, 4732, true]);
    const tight = planUnitPurchase(SNAP, u0, projOf({ war: { room: 1e9, productionCap: 9e8 } }),
      paramsOf({ iskTopUpMaxUnitsPerPeriod: 5000 }));
    assert.deepStrictEqual([tight.purchase.units, tight.proj.war.room, tight.proj.war.productionCap],
      [125, 5e8, 5e8]);
  });

  test("UP2 balance at the floor -> UNIT_PURCHASE_NO_ISK; unpaid -> UNIT_PURCHASE_DEBT; pirate -> identity", () => {
    const u0 = upkeepOf();
    const p0 = projOf({ projectedIsk: 4e12 });
    const poor = planUnitPurchase(SNAP, u0, p0, paramsOf());
    assert.deepStrictEqual([poor.purchase, poor.notes, poor.upkeep === u0, poor.proj === p0],
      [null, ["UNIT_PURCHASE_NO_ISK"], true, true]);
    const debt = planUnitPurchase(SNAP, upkeepOf({ unpaidPeriods: 1 }), projOf(), paramsOf());
    assert.deepStrictEqual([debt.purchase, debt.notes], [null, ["UNIT_PURCHASE_DEBT"]]);
    const aus = planUnitPurchase(SNAP, u0, projOf({ austerity: true }), paramsOf());
    assert.deepStrictEqual([aus.purchase, aus.notes], [null, ["UNIT_PURCHASE_AUSTERITY"]]);
    const p1 = projOf();
    const pirate = planUnitPurchase({ ...SNAP, entry: { kind: "pirate" } }, u0, p1, paramsOf());
    assert.deepStrictEqual([pirate.purchase, pirate.notes, pirate.upkeep === u0, pirate.proj === p1],
      [null, [], true, true]);
  });

  test("UP3 flag off / no UPKEEP period -> identity; config keys, row bound +5 only with the flag, start warning",
    () => {
      const u0 = upkeepOf();
      const p0 = projOf();
      for (const [snap, up, params] of [[SNAP, u0, paramsOf({ iskTopUpEnabled: false })], [SNAP, u0, { upkeep: null }],
        [SNAP, upkeepOf({ intents: [{ type: "UPKEEP", periods: 0, charged: 0 }] }), paramsOf()],
        [SNAP, upkeepOf({ offensiveAllowed: true }), paramsOf()]]) {
        const b = planUnitPurchase(snap, up, p0, params);
        assert.deepStrictEqual([b.upkeep === up, b.proj === p0, b.purchase, b.notes], [true, true, null, []]);
      }
      assert.strictEqual(planUnitPurchase(SNAP, u0, null, paramsOf()).proj, null);
      const env = { EVEJS_DATA_ROOT: os.tmpdir(), EVEJS_LNE_PERSISTENCE_MAX_ROWS_PER_TRANSACTION: "1300" };
      const off = config.resolveConfig({ modDir: MOD_DIR, env });
      assert.deepStrictEqual(off.errors, []);
      const u = off.config.upkeep;
      assert.deepStrictEqual([u.iskTopUpEnabled, u.iskPerUnit, u.iskTopUpMaxUnitsPerPeriod, u.iskTopUpKinds,
        u.iskTopUpFloorPermille, u.iskTopUpHeadroomPeriods, u.iskTopUpRoomSharePermille],
      [false, PRICE, 50, "empire", 800, 2, 500]);
      const on = config.resolveConfig({ modDir: MOD_DIR, env: { ...env, EVEJS_LNE_UPKEEP_ISK_TOP_UP_ENABLED: "1",
        EVEJS_LNE_TREASURY_ENABLED: "1" } });
      assert.deepStrictEqual(on.errors, []);
      assert.strictEqual(rowBoundsOfConfig(on.config).review - rowBoundsOfConfig(off.config).review,
        UNIT_PURCHASE_ROWS);
      assert.strictEqual(UNIT_PURCHASE_ROWS, 5);
      assert.ok(!on.warnings.some((w) => w.startsWith("upkeep.iskTopUpEnabled")), on.warnings.join("; "));
      const svc = createReviewService({ store: {}, journal: {},
        strategyRepository: { limits: { maxResourceUnits: 1 } }, intelRepository: {}, registry: {},
        kinds: { list: [], get: () => null }, powerTable: {}, scoring: {}, scheduler: {}, fleets: {},
        clock: { now: () => 0 }, worldSeed: 1, config: on.config, hostility: () => true, isCampaignOk: () => true,
        industryCatalog: {} });
      assert.deepStrictEqual([svc.params.upkeep.iskTopUpEnabled, svc.params.upkeep.iskTopUpKinds], [true, "empire"]);
      const warned = config.resolveConfig({ modDir: MOD_DIR, env: { ...env,
        EVEJS_LNE_UPKEEP_ISK_TOP_UP_ENABLED: "1", EVEJS_LNE_TREASURY_ENABLED: "0" } }).warnings;
      assert.ok(warned.some((w) => w.startsWith("upkeep.iskTopUpEnabled without treasury.enabled")), warned.join("; "));
    });

  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("UP4/UP5 real store: UPKEEP with a purchase -> war_spend, units, journal UNIT_PURCHASE, counters; replay "
    + "= duplicate; a purchase above the balance -> UPKEEP applied, UNIT_PURCHASE_REFUSED:TREASURY_INSUFFICIENT",
  () => H.withStore(driver, async (reopen) => {
    const clock = createManualClock(R.START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(53) }), graph: R.graphOf(),
      controllers: new Map(R.THEATRE.map((id) => [id, R.SANSHA])) };
    for (const id of [30001721, 30001954, 30001955]) shared.controllers.set(id, R.AMARR);
    const hold = { purchase: null, inflate: false, armed: false, effect: null };
    const hooks = { beforeEffect: (d) => {
      if (d.factionId !== R.AMARR) return d;
      const up = d.intents.find((i) => i.type === "UPKEEP" && i.purchase);
      if (!up) return d;
      hold.armed = true;
      if (!hold.inflate) {
        hold.purchase = up.purchase;
        return d;
      }
      const big = { units: 2000000, isk: 2000000 * PRICE };
      return { ...d, intents: d.intents.map((i) => (i === up ? { ...i, purchase: big } : i)) };
    } };
    const wrapScheduler = (sch) => ({ ...sch, registerHandler: (type, h, o) => sch.registerHandler(type, (ev, hctx) => {
      const r = h(ev, hctx);
      if (type === REVIEW && hold.armed && r && r.effect && ev.payload.factionId === R.AMARR) {
        hold.effect = r.effect;
        hold.armed = false;
      }
      return r;
    }, o) });
    const strategyViews = createViewRegistry();
    const env = await R.bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: String(R.AMARR),
      EVEJS_LNE_STRATEGY_CAMPAIGNS: "none", EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8",
      EVEJS_LNE_UPKEEP_PERIOD_MS: String(R.I), EVEJS_LNE_TREASURY_ENABLED: "1",
      EVEJS_LNE_UPKEEP_ISK_TOP_UP_ENABLED: "1", EVEJS_LNE_UPKEEP_OFFENSIVE_RESERVE_PERIODS: "10000",
      EVEJS_LNE_PERSISTENCE_MAX_ROWS_PER_TRANSACTION: "1300" },
    { world: R.upkeepWorld(shared.controllers, new Map()), treasury: true, hooks, wrapScheduler, strategyViews });
    assert.strictEqual(env.treasury.getMode(), "run");
    assert.strictEqual(typeof env.treasury.chargeWarSpendInTx, "function");
    const faction = () => env.q("SELECT * FROM world_factions WHERE faction_id = ?", R.AMARR)[0];
    const tre = () => env.q("SELECT * FROM world_faction_treasury WHERE faction_id = ?", R.AMARR)[0];
    const daySpend = () => env.q("SELECT SUM(war_spend) AS w FROM world_faction_treasury_days WHERE faction_id = ?",
      R.AMARR)[0].w;
    const journalOf = (suffix) => env.q(`SELECT event_type AS e, payload FROM ${JOURNAL_TABLE}
      WHERE idempotency_key LIKE ?`, `%:UPKEEP:${suffix}`).map((r) => ({ e: r.e, p: JSON.parse(r.payload) }));
    const counters = () => env.strategy.getStatus().ai.review.counters;

    await R.passesAt(env, shared, R.START_MS + R.I);
    assert.ok(tre() && tre().mode === "NORMAL", JSON.stringify(tre()));
    assert.deepStrictEqual([hold.purchase, journalOf("units").length, counters().unitPurchases], [null, 0, 0]);
    const res1 = faction().resource_units;
    const t1 = tre();

    await R.passesAt(env, shared, R.START_MS + 2 * R.I);
    assert.ok(hold.purchase && hold.purchase.units > 0 && hold.purchase.units <= 50, JSON.stringify(hold.purchase));
    const n = hold.purchase.units;
    const bought = journalOf("units");
    assert.deepStrictEqual(bought.map((x) => [x.e, x.p.reason, x.p.deltas.resourceUnits]),
      [["FACTION_CHANGED", "UNIT_PURCHASE", n]]);
    const paid = journalOf("faction");
    assert.strictEqual(paid.length, 2, "anchor + one charged period");
    const res2 = faction().resource_units;
    assert.strictEqual(res2, res1 + paid[paid.length - 1].p.deltas.resourceUnits + n);
    const t2 = tre();
    assert.deepStrictEqual([t2.war_spend_total - t1.war_spend_total, daySpend()], [n * PRICE, t2.war_spend_total]);
    const c2 = counters();
    assert.deepStrictEqual([c2.unitPurchases, c2.unitPurchaseUnits, c2.unitPurchaseIsk, c2.unitPurchaseRefused],
      [1, n, n * PRICE, 0]);
    assert.ok(typeof hold.effect === "function", "the effect with the purchase was captured");
    const replay = env.tx((db) => hold.effect(db));
    assert.ok(replay.ok && replay.applied.UPKEEP === undefined, JSON.stringify(replay));
    const t2b = tre();
    assert.deepStrictEqual([t2b.isk_balance, t2b.war_spend_total, faction().resource_units, journalOf("units").length],
      [t2.isk_balance, t2.war_spend_total, res2, 1]);

    hold.inflate = true;
    const paidUntil2 = faction().upkeep_paid_until;
    await R.passesAt(env, shared, R.START_MS + 3 * R.I);
    assert.strictEqual(faction().upkeep_paid_until, paidUntil2 + R.I, "UPKEEP applied");
    assert.deepStrictEqual([tre().war_spend_total, journalOf("units").length], [t2.war_spend_total, 1]);
    const c3 = counters();
    assert.deepStrictEqual([c3.unitPurchases, c3.unitPurchaseRefused, c3.intentRefused || 0], [1, 1, 0]);
    const view = strategyViews.getView("factions").getData().factions.find((x) => x.factionId === R.AMARR);
    assert.ok(view.lastReview.notes.includes("UNIT_PURCHASE_REFUSED:TREASURY_INSUFFICIENT"),
      JSON.stringify(view.lastReview.notes));
    env.strategy.stop("test");
  }));
};
