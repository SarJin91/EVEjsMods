"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { openStore } = require("../../lib/persistence/store");
const { MIGRATIONS, LATEST_SCHEMA_VERSION } = require("../../lib/persistence/migrations");
const { TABLE_POLICY, ACTION } = require("../../lib/persistence/worldReset");
const { startTrade } = require("../../lib/economy/trade");
const { startTreasury, createUnavailableTreasury } = require("../../lib/economy/treasury");
const TS = require("../../lib/economy/treasury/schema");
const { createHullValueTable } = require("../../lib/economy/treasury/hullValues");
const { applyDebits } = require("../../lib/economy/treasury/treasuryRepository");
const { netOf } = require("../../lib/economy/treasury/treasuryService");
const { buildFactionsView } = require("../../lib/strategy/factionsView");
const { createRecipeTable, recipeParamsOf } = require("../../lib/economy/production/recipes");
const hullRecipes = require("../../lib/economy/data/hullRecipes");
const { REF_PRICE_MILLI, HULL_VALUE_FACTOR_PERMILLE } = require("../../lib/economy/data/mineralRefPrices");
const { HULL_GROUPS } = require("../../lib/fleets/schema");
const { planTreasury, feeOf: aiFeeOf } = require("../../lib/strategy/ai/treasury");
const { feeOf, thresholdsOf, nextMode } = require("../../lib/economy/treasury/austerity");
const { treasuryParamsOf, TREASURY_PARAM_KEYS } = require("../../lib/strategy/reviewService");
const { reviewRowBound, TREASURY_BASE_ROWS } = require("../../lib/strategy/reviewRows");
const { FACTION_AGGREGATE, EVENT_STRATEGY_INTENT } = require("../../lib/strategy/schema");
const { harness: H } = require("../battle/settlement.test");
const { DESERTERS_TREASURY_METHODS } = require("../../lib/heavyEvents/world/schema");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const F = 500003;
const F2 = 500019;
const P = 3600000;
const ON = Object.freeze({ EVEJS_LNE_TREASURY_ENABLED: "1", EVEJS_LNE_TRADE_CONTRACTS_ENABLED: "0" });
const AMARR_UPKEEP = Object.freeze({ mode: "ready", controlledCount: 10, stationCount: 5 });
const FLEETS = Object.freeze([{ composition: [{ hullGroup: "battleship", count: 3 }, { hullGroup: "frigate", count: 10 }] }]);

const resolve = (env) => config.resolveConfig({ modDir: MOD_DIR, env });

function boot(opened, shared, env = {}) {
  const cfg = resolve({ ...ON, ...env }).config;
  const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
  const persistence = { ok: true, store: opened.store, journal };
  const tr = startTrade({ config: cfg, persistence, clock: shared.clock, ids: shared.ids });
  assert.ok(tr.ok, JSON.stringify(tr));
  assert.strictEqual(tr.trade.getMode(), "run-no-contracts");
  const h = { cfg, journal, store: opened.store, trade: tr.trade, params: treasuryParamsOf(cfg) };
  const t = startTreasury({ config: cfg, persistence, clock: shared.clock, getTrade: () => h.trade });
  assert.ok(t.ok, JSON.stringify(t));
  h.treasury = t.treasury;
  h.tx = (fn) => {
    const r = opened.store.transaction("test", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  return h;
}

function review(h, f, { at, round, npcStations = 0, kind = "empire", upkeep = AMARR_UPKEEP, fleets = FLEETS,
  feeRuns }) {
  const read = h.tx((db) => h.treasury.readForReview(db, f, { at, npcStations, kind }));
  assert.ok(read.ok, JSON.stringify(read));
  const plan = planTreasury({ at, treasury: read.treasury, upkeep, fleets }, { treasury: h.params },
    { produce: feeRuns ? feeRuns.length : 0 });
  if (plan.intents.length === 0) return { read, plan, res: null, value: null };
  const ik = `strategy:review:${f}:${round}:0:TREASURY`;
  return { read, plan, ik, ...applyIntent(h, f, plan.intents[0], at, ik, feeRuns) };
}

function applyIntent(h, f, intent, at, ik, feeRuns) {
  let value = null;
  const res = h.tx((db) => h.journal.applyOnce(db, { key: ik, aggregate: { type: FACTION_AGGREGATE, id: String(f) },
    eventType: EVENT_STRATEGY_INTENT, payload: { seed: 1, intent } }, (tx) => {
    value = h.treasury.settleIntentInTx(tx, { ...intent, factionId: f, at, ...(feeRuns ? { feeRuns } : {}) }, ik);
    return value;
  }));
  return { res, value };
}

const rowOf = (h, f) => h.tx((db) => db.prepare("SELECT * FROM world_faction_treasury WHERE faction_id = ?").get(f));
const daysOf = (h, f) => h.tx((db) => db.prepare("SELECT * FROM world_faction_treasury_days WHERE faction_id = ? "
  + "ORDER BY day").all(f));
const budgetOf = (h, f) => h.tx((db) => h.trade.readBudget(db, f)).budget;
const journalCount = (h) => h.tx((db) => db.prepare("SELECT count(*) AS n FROM world_event_journal").get()).n;

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("TR1 migration 36 world_faction_treasury from zero and 35 -> 36 (STRICT, day index), TABLE_POLICY WIPE",
    () => {
      assert.deepStrictEqual([MIGRATIONS[35].version, MIGRATIONS[35].name], [36, "world_faction_treasury"]);
      assert.ok(LATEST_SCHEMA_VERSION >= 36);
      assert.deepStrictEqual([TABLE_POLICY.world_faction_treasury, TABLE_POLICY.world_faction_treasury_days],
        [ACTION.WIPE, ACTION.WIPE]);
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-m36-"));
      const stores = [];
      const open = (file, migrations) => {
        const o = openStore({ filePath: path.join(tmp, file), openDatabase: (f) => new driver.Database(f),
          exclusiveLock: true, busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5,
          randomSeed: () => 1, migrations });
        assert.ok(o.ok, JSON.stringify(o));
        return o;
      };
      const master = (o) => o.store.transaction("t", (db) => db.prepare(`SELECT type, name, sql FROM sqlite_master
        WHERE tbl_name IN ('world_faction_treasury', 'world_faction_treasury_days') AND sql IS NOT NULL
        ORDER BY type, name`).all()).value;
      try {
        const fresh = open("fresh.sqlite", MIGRATIONS.slice(0, 36));
        stores.push(fresh.store);
        assert.strictEqual(fresh.schemaVersion, 36);
        const m = master(fresh);
        assert.deepStrictEqual(m.map((x) => `${x.type}:${x.name}`), ["index:world_faction_treasury_days_day",
          "table:world_faction_treasury", "table:world_faction_treasury_days"]);
        for (const t of m.filter((x) => x.type === "table")) assert.ok(/\)\s*STRICT$/.test(t.sql), t.name);
        const old = open("old.sqlite", MIGRATIONS.slice(0, 35));
        old.store.close("upgrade");
        const up = open("old.sqlite", MIGRATIONS.slice(0, 36));
        stores.push(up.store);
        assert.deepStrictEqual([up.schemaVersion, up.applied], [36, 1]);
        const n = up.store.transaction("t", (db) => [
          db.prepare("SELECT count(*) AS n FROM world_faction_treasury").get().n,
          db.prepare("SELECT count(*) AS n FROM world_faction_treasury_days").get().n]).value;
        assert.deepStrictEqual(n, [0, 0]);
      } finally {
        for (const s of stores) s.close("test");
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    });

  test("TR2 hull values: battleship 185 mln +- 1 mln, capital ~1.955 bn, industrial 2.07 mln, every group > 0", () => {
    const c = resolve({}).config;
    const values = createHullValueTable(createRecipeTable(hullRecipes, recipeParamsOf(c.production)),
      REF_PRICE_MILLI, HULL_VALUE_FACTOR_PERMILLE);
    const all = values.all();
    assert.deepStrictEqual(Object.keys(all).sort(), [...HULL_GROUPS].sort());
    for (const g of HULL_GROUPS) assert.ok(Number.isSafeInteger(all[g]) && all[g] > 0, `${g}=${all[g]}`);
    assert.ok(Math.abs(values.valueOf("battleship") - 185e6) <= 1e6, String(values.valueOf("battleship")));
    assert.ok(Math.abs(values.valueOf("capital") - 1955e6) <= 10e6, String(values.valueOf("capital")));
    assert.ok(Math.abs(values.valueOf("industrial") - 2.07e6) <= 0.01e6, String(values.valueOf("industrial")));
    assert.strictEqual(values.valueOf("nope"), null);
    assert.throws(() => createHullValueTable(createRecipeTable(hullRecipes, recipeParamsOf(c.production)),
      { "type:34": 3780 }, {}), TypeError);
  });

  test("TR2b capital FAX ISK factor: force_auxiliary factor 2000 (~3.05 bn), carrier / dreadnought 3200", () => {
    assert.deepStrictEqual([HULL_VALUE_FACTOR_PERMILLE.force_auxiliary, HULL_VALUE_FACTOR_PERMILLE.carrier,
      HULL_VALUE_FACTOR_PERMILLE.dreadnought], [2000, 3200, 3200]);
    const c = resolve({}).config;
    const values = createHullValueTable(createRecipeTable(hullRecipes, recipeParamsOf(c.production)),
      REF_PRICE_MILLI, HULL_VALUE_FACTOR_PERMILLE);
    const fax = values.valueOf("force_auxiliary");
    assert.ok(Math.abs(fax - 3.05e9) <= 0.05e9, String(fax));
  });

  test("TR8 pirate base income: env 4e9 -> 4e9, no env / empty env -> default 2e9; compose pass-through", () => {
    const pirate = (env) => resolve(env);
    for (const env of [{}, { EVEJS_LNE_TREASURY_BASE_INCOME_ISK_PER_DAY_PIRATE: "" }]) {
      const r = pirate(env);
      assert.strictEqual(r.config.treasury.baseIncomeIskPerDayPirate, 2e9, JSON.stringify(env));
      assert.deepStrictEqual(r.warnings, [], JSON.stringify(env));
    }
    assert.strictEqual(pirate({ EVEJS_LNE_TREASURY_BASE_INCOME_ISK_PER_DAY_PIRATE: "4000000000" })
      .config.treasury.baseIncomeIskPerDayPirate, 4e9);
    const compose = fs.readFileSync(path.join(MOD_DIR, "..", "..", "compose.yaml"), "utf8");
    assert.ok(compose.includes("EVEJS_LNE_TREASURY_BASE_INCOME_ISK_PER_DAY_PIRATE: "
      + "${EVEJS_LNE_TREASURY_BASE_INCOME_ISK_PER_DAY_PIRATE:-}"));
  });

  needsDriver("TR3 planner + effect: seed 5e12 + anchor, +2 periods = income - fleet upkeep, trade transfer = what "
    + "the budget took, faction day limit", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const h = boot(reopen(), shared);
    const anchor = Math.floor(shared.clock.now() / P) * P;
    const at0 = anchor + 1000;

    const r1 = review(h, F, { at: at0, round: 1 });
    assert.deepStrictEqual([r1.read.treasury.seeded, r1.read.treasury.initialIsk], [false, 5e12]);
    assert.ok(r1.plan.notes.includes("TREASURY_ANCHOR"), JSON.stringify(r1.plan.notes));
    assert.ok(r1.res.ok && !r1.res.duplicate, JSON.stringify(r1.res));
    assert.deepStrictEqual([r1.value.seeded, r1.value.income, r1.value.fleetUpkeep, r1.value.tradeFundedIsk],
      [true, 0, 0, 0]);
    const row1 = rowOf(h, F);
    assert.deepStrictEqual([row1.kind, row1.initial_isk, row1.isk_balance, row1.paid_until, row1.mode, row1.version],
      ["empire", 5e12, 5e12, anchor, "NORMAL", 2]);

    const v = r1.read.treasury.valueByGroup;
    const fleetValue = 3 * v.battleship + 10 * v.frigate;
    const income = Math.floor(12.5e9 / 24);
    const upkeep = Math.floor(Math.floor(fleetValue / 100) / 24);
    const r2 = review(h, F, { at: at0 + 2 * P, round: 2 });
    assert.deepStrictEqual([r2.plan.intents[0].periods, r2.plan.intents[0].charged], [2, 2]);
    assert.deepStrictEqual([r2.value.income, r2.value.fleetUpkeep, r2.value.seeded], [2 * income, 2 * upkeep, false]);
    const row2 = rowOf(h, F);
    assert.strictEqual(row2.isk_balance, 5e12 + 2 * income - 2 * upkeep);
    assert.deepStrictEqual([row2.paid_until, row2.income_total, row2.fleet_upkeep_total, row2.unpaid_total],
      [anchor + 2 * P, 2 * income, 2 * upkeep, 0]);

    h.tx((db) => assert.ok(h.trade.budgets.fundIskInTx(db, { factionId: F, isk: 3e9, capIsk: 5e10, at: at0 },
      "test:prefill").ok));
    const r3 = review(h, F, { at: at0 + 2 * P + 1, round: 3, npcStations: 1 });
    assert.deepStrictEqual([r3.plan.intents[0].periods, r3.plan.intents[0].tradeWantIsk], [0, 7e9]);
    assert.strictEqual(r3.value.tradeFundedIsk, 7e9);
    const b3 = budgetOf(h, F);
    assert.deepStrictEqual([b3.availableIsk, b3.fundedUnitsTotal], [1e10, 0]);
    const row3 = rowOf(h, F);
    assert.deepStrictEqual([row3.isk_balance, row3.trade_out_total, row3.paid_until],
      [row2.isk_balance - 7e9, 7e9, anchor + 2 * P]);

    h.tx((db) => assert.ok(h.trade.budgets.adjustInDb(db, F, { availableDelta: -6e9, spentTotal: 6e9 }, at0).ok));
    const r4 = review(h, F, { at: at0 + 2 * P + 2, round: 4, npcStations: 1 });
    assert.ok(r4.plan.notes.includes("TREASURY_TRADE_LIMIT_FACTION"), JSON.stringify(r4.plan.notes));
    assert.deepStrictEqual([r4.plan.intents[0].tradeWantIsk, r4.value.tradeFundedIsk], [3e9, 3e9]);
    assert.strictEqual(budgetOf(h, F).availableIsk, 4e9 + 3e9);
    assert.strictEqual(rowOf(h, F).isk_balance, row3.isk_balance - 3e9);
    const days = daysOf(h, F);
    assert.strictEqual(days.length, 1);
    assert.deepStrictEqual([days[0].day, days[0].income, days[0].fleet_upkeep, days[0].trade_out, days[0].balance_end],
      [TS.dayOf(at0), 2 * income, 2 * upkeep, 1e10, rowOf(h, F).isk_balance]);
    assert.strictEqual(review(h, F, { at: at0 + 2 * P + 3, round: 5, npcStations: 1 }).plan.intents.length, 0);

    shared.clock.set(at0 + 2 * P);
    const panel = h.treasury.listForPanel();
    assert.ok(panel.ok, JSON.stringify(panel));
    assert.deepStrictEqual([panel.rows.length, panel.rows[0].treasury.balanceIsk, panel.rows[0].today.tradeOut,
      panel.rows[0].yesterday, panel.rows[0].avg7dNetIsk, panel.rows[0].forecast],
    [1, rowOf(h, F).isk_balance, 1e10, null, null, { trend: "FLAT", daysToZero: null, daysToAusterity: null,
      austerityEnterIsk: 5e11, austerityExitIsk: 1e12 }]);
  }));

  needsDriver("TR4 idempotency: the same intent key = duplicate, nothing written twice; a throw after "
    + "fundFromTreasuryInTx -> treasury, budget and day row unchanged", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const h = boot(reopen(), shared);
    const at0 = Math.floor(shared.clock.now() / P) * P + 1000;
    assert.ok(review(h, F, { at: at0, round: 1 }).res.ok);
    const r2 = review(h, F, { at: at0 + P, round: 2 });
    assert.ok(r2.res.ok && !r2.res.duplicate);
    const before = { row: rowOf(h, F), days: daysOf(h, F), journal: journalCount(h) };
    const again = applyIntent(h, F, r2.plan.intents[0], at0 + P, r2.ik);
    assert.ok(again.res.ok && again.res.duplicate === true, JSON.stringify(again.res));
    assert.strictEqual(again.value, null);
    assert.deepStrictEqual({ row: rowOf(h, F), days: daysOf(h, F), journal: journalCount(h) }, before);
    const stale = h.tx((db) => h.treasury.settleIntentInTx(db, { ...r2.plan.intents[0], factionId: F, at: at0 + P },
      r2.ik));
    assert.strictEqual(stale.reason, "TREASURY_STALE", JSON.stringify(stale));
    const dup = h.tx((db) => h.treasury.settleIntentInTx(db, { ...r2.plan.intents[0], factionId: F, at: at0 + P,
      paidUntilFrom: before.row.paid_until }, r2.ik));
    assert.strictEqual(dup.reason, "NESTED_KEY_REUSED", JSON.stringify(dup));
    assert.deepStrictEqual(rowOf(h, F), before.row);

    const real = h.trade;
    let funded = 0;
    h.trade = { ...real, fundFromTreasuryInTx: (db, spec, key) => {
      const t = real.fundFromTreasuryInTx(db, spec, key);
      funded = t.fundedIsk;
      throw new Error("boom after fundFromTreasuryInTx");
    } };
    const r3 = review(h, F, { at: at0 + 2 * P, round: 3, npcStations: 1 });
    assert.strictEqual(funded, 1e10, "the budget took the ISK inside the savepoint");
    assert.strictEqual(r3.res.reason, "APPLY_FAILED", JSON.stringify(r3.res));
    assert.deepStrictEqual([rowOf(h, F), daysOf(h, F), budgetOf(h, F), journalCount(h)],
      [before.row, before.days, null, before.journal]);
    h.trade = real;
    const r4 = review(h, F, { at: at0 + 2 * P, round: 4, npcStations: 1 });
    assert.ok(r4.res.ok && r4.value.tradeFundedIsk === 1e10, JSON.stringify(r4.value));
    assert.strictEqual(rowOf(h, F).isk_balance, before.row.isk_balance + r4.value.income - r4.value.fleetUpkeep - 1e10);
  }));

  needsDriver("TR5 ISK-4 on by default + galaxy 1e11 +.env.example Default lines; explicit off: no "
    + "start, stub, no params / intent, reviewRowBound 976 unchanged, +10 when on; warnings, galaxy day limit: the "
    + "second faction gets the rest", () => H.withStore(driver, async (reopen) => {
    const bare = resolve({});
    assert.deepStrictEqual(bare.warnings, [], "defaults: no treasury / settleRowsReserve warning");
    assert.deepStrictEqual([bare.config.treasury.enabled, bare.config.treasury.lossesEnabled,
      bare.config.treasury.tradeTransferMaxIskPerDayGalaxy], [true, true, 1e11]);
    const envText = fs.readFileSync(path.join(MOD_DIR, ".env.example"), "utf8");
    const blockOf = (name) => envText.split(/\r?\n\r?\n/).find((b) => b.includes(`# ${name}=`)) || "";
    assert.deepStrictEqual([blockOf("EVEJS_LNE_TREASURY_ENABLED").includes("# Default: true."),
      blockOf("EVEJS_LNE_TREASURY_LOSSES_ENABLED").includes("# Default: true."),
      blockOf("EVEJS_LNE_TREASURY_TRADE_TRANSFER_MAX_ISK_PER_DAY_GALAXY").includes("# Default: 100000000000.")],
    [true, true, true]);
    const off = resolve({ EVEJS_LNE_TREASURY_ENABLED: "0" });
    assert.deepStrictEqual(off.warnings, []);
    const c = off.config;
    assert.strictEqual(c.treasury.enabled, false);
    assert.deepStrictEqual(startTreasury({ config: c, persistence: { ok: true, store: {}, journal: {} },
      clock: { now: () => 0 } }), { ok: false, reason: "disabled_by_config" });
    const stub = createUnavailableTreasury("TREASURY_DISABLED", "disabled_by_config");
    assert.deepStrictEqual([stub.getMode(), stub.fundsTrade(), stub.readForReview().treasury.mode,
      stub.settleIntentInTx().reason], ["off", false, "off", "TREASURY_DISABLED"]);
    assert.strictEqual(treasuryParamsOf(c), null);
    const ready = { mode: "ready", seeded: false, kind: "empire", paidUntil: null, valueByGroup: {},
      tradeEligible: true, tradeHeldIsk: null, factionTradeOutToday: 0, galaxyTradeOutToday: 0 };
    assert.deepStrictEqual(planTreasury({ at: 0, treasury: ready }, { treasury: null }),
      { intents: [], notes: [], rates: null });
    const args = [c.strategy, c.mining, c.production,
      { maxAbandonsPerReview: c.upkeep.maxAbandonsPerReview, maxFactionsPerSystem: c.world.maxFactionsPerSystem },
      c.logistics, c.construction, { maxReliefPerReview: c.siege.maxReliefPerReview },
      { maxOffersPerReview: c.trade.maxOffersPerReview, maxCancelsPerReview: c.trade.maxCancelsPerReview },
      { maxDefensePerReview: c.strategy.maxDefensePerReview }, null];
    assert.strictEqual(reviewRowBound(...args), 976, "no 11th argument = treasury off");
    assert.strictEqual(reviewRowBound(...args, null), 976);
    assert.strictEqual(reviewRowBound(...args, { pruneBatch: c.treasury.pruneBatch }), 976 + TS.TREASURY_ROWS);
    assert.strictEqual(TS.TREASURY_ROWS, TREASURY_BASE_ROWS + c.treasury.pruneBatch);
    const on = resolve(ON);
    assert.deepStrictEqual(on.warnings, []);
    assert.strictEqual(treasuryParamsOf(on.config).tradeBudgetTargetIsk, 1e10);
    const bad = resolve({ ...ON, EVEJS_LNE_TREASURY_TRADE_BUDGET_TARGET_ISK: "60000000000",
      EVEJS_LNE_TREASURY_TRADE_TRANSFER_MAX_ISK_PER_DAY_GALAXY: "1000" });
    assert.ok(bad.warnings.some((w) => w.startsWith("treasury.tradeBudgetTargetIsk=")), bad.warnings.join("\n"));
    assert.ok(bad.warnings.some((w) => w.startsWith("treasury.tradeTransferMaxIskPerDayGalaxy=")), bad.warnings.join("\n"));

    const shared = H.sharedOf();
    const h = boot(reopen(), shared, { EVEJS_LNE_TREASURY_TRADE_TRANSFER_MAX_ISK_PER_DAY_GALAXY: "15000000000" });
    const at0 = Math.floor(shared.clock.now() / P) * P + 1000;
    const a = review(h, F, { at: at0, round: 1, npcStations: 1 });
    const b = review(h, F2, { at: at0, round: 1, npcStations: 1, kind: "pirate" });
    assert.deepStrictEqual([a.value.tradeFundedIsk, b.value.tradeFundedIsk], [1e10, 5e9]);
    assert.ok(b.plan.notes.includes("TREASURY_TRADE_LIMIT_GALAXY"), JSON.stringify(b.plan.notes));
    assert.deepStrictEqual([rowOf(h, F2).initial_isk, rowOf(h, F2).isk_balance, budgetOf(h, F2).availableIsk],
      [1e12, 1e12 - 5e9, 5e9]);
    assert.strictEqual(review(h, F2, { at: at0 + 1, round: 2, npcStations: 1, kind: "pirate" }).plan.intents.length, 0);
  }));

  needsDriver("TA1 production fee: feeRuns cruiser x3 + battleship x1 -> one debit "
    + "productionFees = feeOf sum in the same settlement (row, day, journal ${ik}:treasury), AI feeOf parity, no "
    + "PRODUCE -> no fee", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const h = boot(reopen(), shared);
    const at0 = Math.floor(shared.clock.now() / P) * P + 1000;
    const r1 = review(h, F, { at: at0, round: 1 });
    assert.ok(r1.res.ok);
    const v = r1.read.treasury.valueByGroup;
    const fee = feeOf(3, v.cruiser, 100) + feeOf(1, v.battleship, 100);
    assert.ok(Math.abs(feeOf(1, v.battleship, 100) - 18.5e6) <= 0.1e6, String(v.battleship));
    assert.ok(Math.abs(fee - (0.3 * v.cruiser + 0.1 * v.battleship)) <= 2, String(fee));
    for (const value of [0, 1, 999, 1001, 7654321, ...Object.values(v), 1e13]) {
      for (const runs of [1, 3, 100]) {
        for (const permille of [0, 100, 1000]) {
          assert.strictEqual(aiFeeOf(runs, value, permille), feeOf(runs, value, permille), `${runs} ${value} ${permille}`);
        }
      }
    }
    const before = rowOf(h, F);
    const feeRuns = [{ hullGroup: "cruiser", runs: 3 }, { hullGroup: "battleship", runs: 1 }];
    const r2 = review(h, F, { at: at0 + 10, round: 2, feeRuns });
    assert.ok(r2.res.ok && !r2.res.duplicate, JSON.stringify(r2.res));
    assert.deepStrictEqual([r2.plan.intents[0].periods, r2.value.productionFees, r2.value.productionFeesPaid,
      r2.value.unpaid, r2.value.mode, r2.value.modeChanged], [0, fee, fee, 0, "NORMAL", null]);
    const row = rowOf(h, F);
    assert.deepStrictEqual([row.isk_balance, row.production_fee_total], [before.isk_balance - fee, fee]);
    assert.strictEqual(daysOf(h, F)[0].production_fees, fee);
    const payloadOf = (key) => JSON.parse(h.tx((db) => db.prepare("SELECT payload FROM world_event_journal WHERE "
      + "idempotency_key = ?").get(key)).payload);
    assert.strictEqual(payloadOf(`${r2.ik}:treasury`).debits.productionFees, fee);
    assert.strictEqual(payloadOf(r2.ik).intent.feeRuns, undefined, "feeRuns never in the wrapper payload");
    assert.strictEqual(review(h, F, { at: at0 + 20, round: 3 }).plan.intents.length, 0);
    assert.strictEqual(rowOf(h, F).production_fee_total, fee);
  }));

  needsDriver("TA2 hysteresis: 99 permille -> AUSTERITY, 150 -> no change, 200 -> NORMAL; "
    + "the effect writes mode + mode_changed_at once, note TREASURY_AUSTERITY_ENTER, then no second transition",
  () => H.withStore(driver, async (reopen) => {
    const th = thresholdsOf(1e12, 100, 200);
    assert.deepStrictEqual(th, { enterIsk: 1e11, exitIsk: 2e11 });
    assert.deepStrictEqual([nextMode("NORMAL", 0.99e11, th), nextMode("NORMAL", 1.5e11, th),
      nextMode("AUSTERITY", 1.5e11, th), nextMode("AUSTERITY", 2e11, th), nextMode("NORMAL", 1e11, th)],
    ["AUSTERITY", "NORMAL", "AUSTERITY", "NORMAL", "NORMAL"]);
    assert.deepStrictEqual(thresholdsOf(0, 100, 200), { enterIsk: 0, exitIsk: 0 });
    assert.strictEqual(nextMode("NORMAL", 0, thresholdsOf(0, 100, 200)), "NORMAL", "initial 0: never AUSTERITY");
    assert.deepStrictEqual(thresholdsOf(1e12, 200, 100), { enterIsk: 2e11, exitIsk: 2e11 }, "exit >= enter");

    const shared = H.sharedOf();
    const h = boot(reopen(), shared);
    const at0 = Math.floor(shared.clock.now() / P) * P + 1000;
    assert.ok(review(h, F2, { at: at0, round: 1, kind: "pirate" }).res.ok);
    h.tx((db) => db.prepare("UPDATE world_faction_treasury SET isk_balance = 90000000000 WHERE faction_id = ?").run(F2));
    const r2 = review(h, F2, { at: at0 + P, round: 2, kind: "pirate" });
    assert.ok(r2.res.ok, JSON.stringify(r2.res));
    assert.strictEqual(r2.value.modeChanged, "ENTER");
    assert.ok(r2.value.notes.includes("TREASURY_AUSTERITY_ENTER"), JSON.stringify(r2.value.notes));
    const row2 = rowOf(h, F2);
    assert.ok(row2.isk_balance > 9e10 && row2.isk_balance < 1e11, String(row2.isk_balance));
    assert.deepStrictEqual([row2.mode, row2.mode_changed_at], ["AUSTERITY", at0 + P]);
    const r3 = review(h, F2, { at: at0 + 2 * P, round: 3, kind: "pirate" });
    assert.ok(r3.plan.notes.includes("TREASURY_AUSTERITY"), JSON.stringify(r3.plan.notes));
    assert.deepStrictEqual([r3.value.modeChanged, r3.value.notes], [null, []]);
    assert.deepStrictEqual([rowOf(h, F2).mode, rowOf(h, F2).mode_changed_at], ["AUSTERITY", at0 + P]);
  }));

  needsDriver("TA4 anti death spiral: balance 0 -> the fee of 1 job goes to unpaid; AUSTERITY "
    + "-> no transfer even for a stale want; the base income lifts the balance to the exit threshold -> NORMAL",
  () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const h = boot(reopen(), shared, { EVEJS_LNE_TREASURY_BASE_INCOME_ISK_PER_DAY_PIRATE: "1000000000000" });
    const at0 = Math.floor(shared.clock.now() / P) * P + 1000;
    const r1 = review(h, F2, { at: at0, round: 1, kind: "pirate" });
    assert.ok(r1.res.ok);
    h.tx((db) => db.prepare("UPDATE world_faction_treasury SET isk_balance = 0, mode = 'AUSTERITY' "
      + "WHERE faction_id = ?").run(F2));
    const fee = feeOf(1, r1.read.treasury.valueByGroup.cruiser, 100);
    const r2 = review(h, F2, { at: at0 + 10, round: 2, kind: "pirate", feeRuns: [{ hullGroup: "cruiser", runs: 1 }] });
    assert.ok(r2.res.ok, JSON.stringify(r2.res));
    assert.deepStrictEqual([r2.value.productionFees, r2.value.productionFeesPaid, r2.value.unpaid, r2.value.mode],
      [fee, 0, fee, "AUSTERITY"]);
    assert.deepStrictEqual([rowOf(h, F2).isk_balance, rowOf(h, F2).unpaid_total], [0, fee]);

    const read = h.tx((db) => h.treasury.readForReview(db, F2, { at: at0 + P, npcStations: 1, kind: "pirate" }));
    const plan = planTreasury({ at: at0 + P, treasury: read.treasury, upkeep: AMARR_UPKEEP, fleets: [] },
      { treasury: h.params });
    assert.strictEqual(plan.intents[0].tradeWantIsk, 0);
    const stale = applyIntent(h, F2, { ...plan.intents[0], tradeWantIsk: 1e9 }, at0 + P,
      `strategy:review:${F2}:3:0:TREASURY`);
    assert.ok(stale.res.ok, JSON.stringify(stale.res));
    assert.deepStrictEqual([stale.value.tradeFundedIsk, stale.value.tradeLimited, budgetOf(h, F2)], [0, true, null]);

    let last = rowOf(h, F2).isk_balance;
    const changes = [];
    for (let round = 4; round < 12 && rowOf(h, F2).mode === "AUSTERITY"; round += 1) {
      const at = at0 + P + (round - 3) * 2 * P;
      const r = review(h, F2, { at, round, kind: "pirate", fleets: [] });
      assert.ok(r.res.ok, JSON.stringify(r.res));
      const now = rowOf(h, F2).isk_balance;
      assert.ok(now > last, `round ${round}: ${now} <= ${last}`);
      last = now;
      if (r.value.modeChanged) changes.push([r.value.modeChanged, now >= 2e11]);
    }
    assert.deepStrictEqual(changes, [["EXIT", true]]);
    assert.strictEqual(rowOf(h, F2).mode, "NORMAL");
  }));

  needsDriver("TA5 keys +: 5 treasury keys in TREASURY_PARAM_KEYS and the params "
    + "warnings only with the treasury on (exit < enter warns), paidUntilFrom != paid_until -> TREASURY_STALE "
    + "(row, days, journal unchanged)", () => H.withStore(driver, async (reopen) => {
    const keys = ["productionFeePermille", "austerityEnterPermille", "austerityExitPermille", "austerityJobsPermille",
      "minJobsWhenBroke"];
    const on = resolve(ON).config;
    assert.deepStrictEqual(keys.filter((k) => !TREASURY_PARAM_KEYS.includes(k)), []);
    assert.deepStrictEqual(keys.map((k) => treasuryParamsOf(on)[k]), [100, 100, 200, 500, 1]);
    const BAD = { EVEJS_LNE_TREASURY_TRADE_BUDGET_TARGET_ISK: "60000000000",
      EVEJS_LNE_TREASURY_TRADE_TRANSFER_MAX_ISK_PER_DAY_GALAXY: "1000", EVEJS_LNE_TREASURY_AUSTERITY_EXIT_PERMILLE: "50" };
    assert.deepStrictEqual(resolve({ ...BAD, EVEJS_LNE_TREASURY_ENABLED: "0" }).warnings
      .filter((w) => w.startsWith("treasury.")), [], "off: no warning");
    const warned = resolve({ ...ON, ...BAD }).warnings;
    assert.ok(warned.some((w) => w.startsWith("treasury.austerityExitPermille=50 below")), warned.join("\n"));

    const shared = H.sharedOf();
    const h = boot(reopen(), shared);
    const at0 = Math.floor(shared.clock.now() / P) * P + 1000;
    assert.ok(review(h, F, { at: at0, round: 1 }).res.ok);
    const read = h.tx((db) => h.treasury.readForReview(db, F, { at: at0 + P, npcStations: 0, kind: "empire" }));
    const plan = planTreasury({ at: at0 + P, treasury: read.treasury, upkeep: AMARR_UPKEEP, fleets: FLEETS },
      { treasury: h.params });
    const before = { row: rowOf(h, F), days: daysOf(h, F), journal: journalCount(h) };
    const stale = applyIntent(h, F, { ...plan.intents[0], paidUntilFrom: plan.intents[0].paidUntilFrom - P }, at0 + P,
      `strategy:review:${F}:2:0:TREASURY`);
    assert.strictEqual(stale.res.ok, false);
    assert.strictEqual((stale.res.refusal || stale.res).reason, "TREASURY_STALE", JSON.stringify(stale.res));
    assert.deepStrictEqual({ row: rowOf(h, F), days: daysOf(h, F), journal: journalCount(h) }, before);
    assert.ok(applyIntent(h, F, plan.intents[0], at0 + P, `strategy:review:${F}:2:0:TREASURY`).res.ok);
    assert.strictEqual(rowOf(h, F).paid_until, before.row.paid_until + P);
  }));

  needsDriver("TR6 C5 merc: chargeMercInTx fee / refund -> one settlement each (totals, day merc_fees "
    + "merc_refunds, netOf), fee above the balance -> TREASURY_INSUFFICIENT without a write, AUSTERITY / no row / "
    + "stub refusals, factions panel today.mercFees, facade methods = stub methods", () => H.withStore(driver,
    async (reopen) => {
      const shared = H.sharedOf();
      const h = boot(reopen(), shared);
      const at0 = Math.floor(shared.clock.now() / P) * P + 1000;
      assert.ok(review(h, F, { at: at0, round: 1 }).res.ok);
      const charge = (spec, key) => h.tx((db) => h.treasury.chargeMercInTx(db, { factionId: F, at: at0 + 5, ...spec },
        key));
      const acc = h.tx((db) => h.treasury.readMercAccountInDb(db, F));
      assert.deepStrictEqual(acc, { ok: true, mode: "ready", seeded: true, balanceIsk: 5e12, accountMode: "NORMAL" });
      const fee = charge({ isk: 120e6, direction: "fee" }, "test:merc:fee");
      const refund = charge({ isk: 40e6, direction: "refund" }, "test:merc:refund");
      assert.deepStrictEqual([fee, refund], [{ ok: true, duplicate: false, balanceIsk: 5e12 - 120e6 },
        { ok: true, duplicate: false, balanceIsk: 5e12 - 80e6 }]);
      const row = rowOf(h, F);
      const day = daysOf(h, F)[0];
      assert.deepStrictEqual([row.merc_fee_total, row.merc_refund_total, row.isk_balance, day.merc_fees,
        day.merc_refunds, day.balance_end], [120e6, 40e6, 5e12 - 80e6, 120e6, 40e6, 5e12 - 80e6]);
      const days = h.tx((db) => require("../../lib/economy/treasury/treasuryRepository")
        .createTreasuryRepository({ journal: h.journal, clock: shared.clock }).daysInDb(db, F, { limit: 1 })).days;
      assert.deepStrictEqual([days[0].mercFees, days[0].mercRefunds, netOf(days[0])], [120e6, 40e6, -80e6]);
      assert.deepStrictEqual(charge({ isk: 120e6, direction: "fee" }, "test:merc:fee").duplicate, true);
      assert.strictEqual(rowOf(h, F).isk_balance, 5e12 - 80e6);
      const before = { row: rowOf(h, F), journal: journalCount(h) };
      const big = charge({ isk: 5e12, direction: "fee" }, "test:merc:big");
      assert.deepStrictEqual([big.ok, big.reason], [false, "TREASURY_INSUFFICIENT"]);
      assert.deepStrictEqual({ row: rowOf(h, F), journal: journalCount(h) }, before);
      assert.deepStrictEqual(applyDebits(10, {}, { mercFees: 11 }).reason, "TREASURY_INVALID_INPUT");
      assert.strictEqual(h.tx((db) => h.treasury.chargeMercInTx(db, { factionId: F2, isk: 1, direction: "refund",
        at: at0 }, "test:merc:none")).reason, "NO_TREASURY");
      h.tx((db) => db.prepare("UPDATE world_faction_treasury SET mode = 'AUSTERITY' WHERE faction_id = ?").run(F));
      assert.deepStrictEqual([charge({ isk: 1, direction: "fee" }, "test:merc:aus").reason,
        charge({ isk: 1, direction: "refund" }, "test:merc:aus-refund").ok], ["TREASURY_AUSTERITY", true]);
      const stub = createUnavailableTreasury("TEST");
      assert.deepStrictEqual([stub.readMercAccountInDb(), stub.chargeMercInTx()], [{ ok: true, mode: "off" },
        { ok: false, reason: "TREASURY_OFF" }]);
      assert.deepStrictEqual(Object.keys(h.treasury).sort(), Object.keys(stub).sort());
      shared.clock.set(at0 + 10);
      const view = buildFactionsView({ store: { isOpen: () => true, transaction: (_n, fn) => ({ ok: true,
        value: fn(null) }) }, repository: { listFactions: () => ({ ok: true, records: [{ factionId: F }] }) },
      registry: { getFaction: () => null, getCampaignsForFaction: () => [], listCampaigns: () => [],
        version: { factions: 1, doctrines: 1, campaigns: 1 } }, getStatus: () => ({}),
      getTreasury: () => h.treasury });
      const data = view.getData();
      assert.deepStrictEqual([data.factions[0].treasury.today.mercFees, data.factions[0].treasury.today.mercRefunds,
        data.factions[0].treasury.totals.mercFees], [120e6, 40e6 + 1, 120e6]);
    }));

  needsDriver("TR7 ISK-4 first enable on an existing world: unit-funded budget 3e7 while off -> start on "
    + "first review = seed + TREASURY_ANCHOR (income 0, upkeep 0), transfer = target - held, UPKEEP without units; "
    + "50 periods later charged 48 + TREASURY_FORGIVEN:2, paid_until + 50 P; the same intent again = duplicate",
  () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const opened = reopen();
    const at0 = Math.floor(shared.clock.now() / P) * P + 1000;
    const anchor = at0 - 1000;
    const offCfg = resolve({ ...ON, EVEJS_LNE_TREASURY_ENABLED: "0" }).config;
    const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
    const persistence = { ok: true, store: opened.store, journal };
    const old = startTrade({ config: offCfg, persistence, clock: shared.clock, ids: shared.ids });
    assert.ok(old.ok, JSON.stringify(old));
    assert.deepStrictEqual(startTreasury({ config: offCfg, persistence, clock: shared.clock,
      getTrade: () => old.trade }), { ok: false, reason: "disabled_by_config" });
    const funded = opened.store.transaction("t", (db) => old.trade.fundFromUpkeepInTx(db, { factionId: F, units: 600,
      paidUntilTo: anchor - P, at: anchor - P }, `strategy:review:${F}:0:0:UPKEEP:trade`));
    assert.ok(funded.ok && funded.value.ok && funded.value.fundedIsk === 3e7, JSON.stringify(funded));
    old.trade.stop("test");

    const h = boot(opened, shared);
    assert.strictEqual(rowOf(h, F), undefined, "no row before the first review");
    assert.strictEqual(h.treasury.fundsTrade(), true, "a running treasury: UPKEEP funds no units (tradeUnits 0)");
    const r1 = review(h, F, { at: at0, round: 1, npcStations: 1 });
    assert.deepStrictEqual([r1.read.treasury.seeded, r1.read.treasury.paidUntil, r1.read.treasury.tradeHeldIsk],
      [false, null, 3e7]);
    assert.ok(r1.plan.notes.includes("TREASURY_ANCHOR"), JSON.stringify(r1.plan.notes));
    assert.ok(r1.res.ok && !r1.res.duplicate, JSON.stringify(r1.res));
    assert.deepStrictEqual([r1.value.seeded, r1.value.income, r1.value.fleetUpkeep, r1.value.tradeFundedIsk],
      [true, 0, 0, 1e10 - 3e7]);
    const b1 = budgetOf(h, F);
    assert.deepStrictEqual([b1.availableIsk, b1.fundedUnitsTotal], [1e10, 600]);
    assert.deepStrictEqual([rowOf(h, F).paid_until, rowOf(h, F).income_total, rowOf(h, F).isk_balance],
      [anchor, 0, 5e12 - (1e10 - 3e7)]);

    const r2 = review(h, F, { at: at0 + 50 * P, round: 2 });
    const v = r1.read.treasury.valueByGroup;
    const income = Math.floor(12.5e9 / 24);
    const upkeep = Math.floor(Math.floor((3 * v.battleship + 10 * v.frigate) / 100) / 24);
    assert.deepStrictEqual([r2.plan.intents[0].periods, r2.plan.intents[0].charged], [50, 48]);
    assert.ok(r2.plan.notes.includes("TREASURY_FORGIVEN:2"), JSON.stringify(r2.plan.notes));
    assert.ok(r2.res.ok && !r2.res.duplicate, JSON.stringify(r2.res));
    assert.deepStrictEqual([r2.value.income, r2.value.fleetUpkeep], [48 * income, 48 * upkeep]);
    const row2 = rowOf(h, F);
    assert.deepStrictEqual([row2.paid_until, row2.income_total], [anchor + 50 * P, 48 * income]);

    const before = { row: rowOf(h, F), days: daysOf(h, F), journal: journalCount(h) };
    const again = applyIntent(h, F, r2.plan.intents[0], at0 + 50 * P, r2.ik);
    assert.ok(again.res.ok && again.res.duplicate === true, JSON.stringify(again.res));
    assert.deepStrictEqual({ row: rowOf(h, F), days: daysOf(h, F), journal: journalCount(h) }, before);
  }));

  test("OR-C1 factions view: doctrine without ownSpace -> borderSystems null, with ownSpace -> AI value", () => {
    const doctrines = { pirate: { doctrineId: "pirate", ownSpace: null }, empire: { doctrineId: "empire", ownSpace: { secClasses: ["high"] } } };
    const view = buildFactionsView({ store: { isOpen: () => true, transaction: (_n, fn) => ({ ok: true, value: fn(null) }) },
      repository: { listFactions: () => ({ ok: true, records: [{ factionId: F, doctrineId: "empire" }, { factionId: F2, doctrineId: "pirate" }] }) },
      registry: { getFaction: () => null, getDoctrine: (id) => doctrines[id] || null, getCampaignsForFaction: () => [],
        listCampaigns: () => [], version: { factions: 1, doctrines: 1, campaigns: 1 } },
      getStatus: () => ({}), getAiMemory: () => ({ borderSystems: 0 }) });
    const byId = Object.fromEntries(view.getData().factions.map((f) => [f.factionId, f.borderSystems]));
    assert.deepStrictEqual(byId, { [F]: 0, [F2]: null });
  });

  needsDriver("EA5-5a readUnpaidDaysInDb: only the window days with unpaid > 0, bad input / no tx refused, stopped -> "
    + "off; facade and stub have DESERTERS_TREASURY_METHODS", () => H.withStore(driver, async (reopen) => {
    const h = boot(reopen(), H.sharedOf());
    const at = 40 * TS.DAY_MS + 5000;
    const day = TS.dayOf(at);
    const put = (d, unpaid) => h.tx((db) => db.prepare("INSERT INTO world_faction_treasury_days (faction_id, day, "
      + "unpaid, balance_end, updated_at) VALUES (?, ?, ?, 0, 1)").run(F, d, unpaid));
    for (const [d, unpaid] of [[day, 5], [day - 1, 0], [day - 2, 7], [day - 7, 9]]) put(d, unpaid);
    assert.deepStrictEqual(h.tx((db) => h.treasury.readUnpaidDaysInDb(db, F, { days: 7, at })),
      { ok: true, mode: "ready", days: 7, unpaidDays: 2, unpaidIsk: 12 });
    assert.deepStrictEqual(h.tx((db) => h.treasury.readUnpaidDaysInDb(db, F, { days: 8, at })).unpaidDays, 3);
    assert.deepStrictEqual(h.tx((db) => h.treasury.readUnpaidDaysInDb(db, F2, { days: 7, at })),
      { ok: true, mode: "ready", days: 7, unpaidDays: 0, unpaidIsk: 0 });
    assert.strictEqual(h.tx((db) => h.treasury.readUnpaidDaysInDb(db, F, { days: 33, at })).reason,
      "TREASURY_INVALID_INPUT");
    assert.strictEqual(h.treasury.readUnpaidDaysInDb(null, F, { days: 7, at }).reason, "TX_REQUIRED");
    const stub = createUnavailableTreasury("TEST");
    for (const name of DESERTERS_TREASURY_METHODS) {
      assert.deepStrictEqual([typeof h.treasury[name], typeof stub[name]], ["function", "function"], name);
    }
    assert.deepStrictEqual(stub.readUnpaidDaysInDb(), { ok: true, mode: "off" });
    h.treasury.stop();
    assert.deepStrictEqual(h.tx((db) => h.treasury.readUnpaidDaysInDb(db, F, { days: 7, at })),
      { ok: true, mode: "off" });
  }));
};
