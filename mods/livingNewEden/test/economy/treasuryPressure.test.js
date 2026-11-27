"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { openStore } = require("../../lib/persistence/store");
const { MIGRATIONS, LATEST_SCHEMA_VERSION } = require("../../lib/persistence/migrations");
const { startTrade } = require("../../lib/economy/trade");
const { startTreasury } = require("../../lib/economy/treasury");
const TS = require("../../lib/economy/treasury/schema");
const { adminDailyOf, warRoomOf, fitIskOf } = require("../../lib/strategy/ai/warChest");
const { planTreasury, projectTreasury } = require("../../lib/strategy/ai/treasury");
const { treasuryParamsOf, TREASURY_PARAM_KEYS } = require("../../lib/strategy/reviewService");
const { FACTION_AGGREGATE, EVENT_STRATEGY_INTENT } = require("../../lib/strategy/schema");
const { harness: H } = require("../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const REPO_DIR = path.resolve(MOD_DIR, "..", "..");
const F = 500003;
const P = 3600000;
const DAY = 86400000;
const PRESSURE_KEYS = Object.freeze(["pressureEnabled", "adminIskPerCapturedSystemPerDay", "adminSprawlSystems",
  "savingsDrawPermillePerDay", "captureLaunchIsk", "mobilizeFitPermille", "productionRoomSharePermille",
  "lossesInRoomPermille"]);
const ON = Object.freeze({ EVEJS_LNE_TREASURY_ENABLED: "1", EVEJS_LNE_TRADE_CONTRACTS_ENABLED: "0",
  EVEJS_LNE_TREASURY_INITIAL_ISK_EMPIRE: "1000000000" });
const CAPTURED = Object.freeze(Array.from({ length: 50 }, (_, i) => ({ systemId: 30000001 + i, state: "STABLE" })));
const UPKEEP = Object.freeze({ mode: "ready", controlledCount: 10, stationCount: 5, captured: CAPTURED });
const FLEETS = Object.freeze([{ composition: [{ hullGroup: "frigate", count: 10 }] }]);
const RESULT_KEYS_BEFORE = ["ok", "seeded", "periods", "charged", "income", "fleetUpkeep", "tradeFundedIsk", "tradeLimited",
  "tradeRefused", "unpaid", "productionFees", "productionFeesPaid", "mode", "modeChanged", "notes"];

const resolve = (env) => config.resolveConfig({ modDir: MOD_DIR, env });

function boot(opened, shared, env) {
  const cfg = resolve({ ...ON, ...env }).config;
  const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
  const persistence = { ok: true, store: opened.store, journal };
  const tr = startTrade({ config: cfg, persistence, clock: shared.clock, ids: shared.ids });
  assert.ok(tr.ok, JSON.stringify(tr));
  const h = { cfg, journal, params: treasuryParamsOf(cfg) };
  const t = startTreasury({ config: cfg, persistence, clock: shared.clock, getTrade: () => tr.trade });
  assert.ok(t.ok, JSON.stringify(t));
  h.treasury = t.treasury;
  h.tx = (fn) => {
    const r = opened.store.transaction("test", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  return h;
}

function round(h, at, n, warSpend) {
  const read = h.tx((db) => h.treasury.readForReview(db, F, { at, npcStations: 0, kind: "empire" }));
  assert.ok(read.ok, JSON.stringify(read));
  const plan = planTreasury({ at, treasury: read.treasury, upkeep: UPKEEP, fleets: FLEETS }, { treasury: h.params });
  assert.strictEqual(plan.intents.length, 1, JSON.stringify(plan));
  const intent = plan.intents[0];
  const ik = `strategy:review:${F}:${n}:0:TREASURY`;
  let value = null;
  const res = h.tx((db) => h.journal.applyOnce(db, { key: ik, aggregate: { type: FACTION_AGGREGATE, id: String(F) },
    eventType: EVENT_STRATEGY_INTENT, payload: { seed: 1, intent } }, (tx) => {
    value = h.treasury.settleIntentInTx(tx, { ...intent, factionId: F, at,
      ...(warSpend !== undefined ? { warSpend } : {}) }, ik);
    return value;
  }));
  return { read, plan, intent, ik, res, value };
}

const rowOf = (h) => h.tx((db) => db.prepare("SELECT * FROM world_faction_treasury WHERE faction_id = ?").get(F));
const dayOf = (h, day) => h.tx((db) => db.prepare("SELECT * FROM world_faction_treasury_days WHERE faction_id = ? "
  + "AND day = ?").get(F, day));

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("IP1 warChest: admin 7.5e9 at c=50, linear at S=0, saturation; war room half a day, draw only, fit", () => {
    const T = { adminIskPerCapturedSystemPerDay: 1e8, adminSprawlSystems: 100 };
    assert.deepStrictEqual([adminDailyOf(50, T), adminDailyOf(100, T), adminDailyOf(0, T),
      adminDailyOf(50, { ...T, adminSprawlSystems: 0 })], [7.5e9, 2e10, 0, 5e9]);
    assert.deepStrictEqual([adminDailyOf(1e7, { adminIskPerCapturedSystemPerDay: 1e11, adminSprawlSystems: 1 }),
      adminDailyOf(150, { adminIskPerCapturedSystemPerDay: 1e11, adminSprawlSystems: 1 })], [1e15, 1e15]);
    const R = { savingsDrawPermillePerDay: 1, lossesInRoomPermille: 1000 };
    const base = { balanceIsk: 5e12, incomeDaily: 2e10, fleetUpkeepDaily: 3e9, adminDaily: 7e9, at: 10 * DAY };
    assert.deepStrictEqual(warRoomOf({ ...base, at: 10 * DAY + DAY / 2, today: { warSpend: 1e9, productionFees: 2e9,
      tradeOut: 0, losses: 5e8 } }, R), { dayBudget: 1.5e10, accrued: 7.5e9, spentToday: 3.5e9, room: 4e9 });
    assert.deepStrictEqual(warRoomOf({ ...base, incomeDaily: 9e9, at: 10 * DAY + DAY / 4, today: null }, R),
      { dayBudget: 4e9, accrued: 1e9, spentToday: 0, room: 1e9 });
    assert.strictEqual(warRoomOf({ ...base, incomeDaily: 0, today: null }, R).dayBudget, 0);
    assert.strictEqual(warRoomOf({ ...base, balanceIsk: 1e15, incomeDaily: 1e15, at: DAY - 1, today: null },
      { ...R, savingsDrawPermillePerDay: 1000 }).dayBudget, 1e15);
    assert.deepStrictEqual([fitIskOf([{ hullGroup: "battleship", count: 3 }, { hullGroup: "nope", count: 9 }],
      { battleship: 185e6 }, 300), fitIskOf([{ hullGroup: "capital", count: 1e9 }], { capital: 1e10 }, 10000)],
    [166500000, 1e15]);
  });

  needsDriver("IP2 flag off: plan/projection = the variant without pressure keys; intent without admin, result keys "
    + "of before", () => H.withStore(driver, async (reopen) => {
    const off = treasuryParamsOf(resolve(ON).config);
    assert.strictEqual(off.pressureEnabled, false);
    const bare = Object.fromEntries(Object.entries(off).filter(([k]) => !PRESSURE_KEYS.includes(k)));
    const tr = { mode: "ready", seeded: true, kind: "empire", initialIsk: 5e12, balanceIsk: 4e12, accountMode: "NORMAL",
      paidUntil: 7 * P, valueByGroup: { frigate: 1e6 }, tradeHeldIsk: 0, tradeEligible: true,
      factionTradeOutToday: 0, galaxyTradeOutToday: 0 };
    const snap = { at: 10 * P + 5, treasury: tr, upkeep: UPKEEP, fleets: FLEETS };
    assert.deepStrictEqual(planTreasury(snap, { treasury: off }, { produce: 1 }),
      planTreasury(snap, { treasury: bare }, { produce: 1 }));
    assert.deepStrictEqual(projectTreasury(snap, { treasury: off }), projectTreasury(snap, { treasury: bare }));
    const plan = planTreasury(snap, { treasury: off });
    assert.deepStrictEqual(["admin" in plan.intents[0], "adminPerPeriod" in plan.rates], [false, false]);

    const shared = H.sharedOf();
    const h = boot(reopen(), shared, {});
    const at0 = Math.floor(shared.clock.now() / P) * P + 1000;
    const r1 = round(h, at0, 1);
    assert.deepStrictEqual(Object.keys(r1.value), RESULT_KEYS_BEFORE);
    const r2 = round(h, at0 + 2 * P, 2, 0);
    assert.deepStrictEqual(["admin" in r2.intent, "today" in r2.read.treasury], [false, false]);
    assert.deepStrictEqual(Object.keys(r2.value), RESULT_KEYS_BEFORE);
    const row = rowOf(h);
    assert.deepStrictEqual([row.admin_total, row.war_spend_total], [0, 0]);
  }));

  needsDriver("IP3 flag on: admin + warSpend booked (totals, day, today), shortfall -> unpaid, repeated key -> no "
    + "second charge", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const h = boot(reopen(), shared, { EVEJS_LNE_TREASURY_PRESSURE_ENABLED: "1" });
    const at0 = Math.floor(shared.clock.now() / P) * P + 1000;
    const r1 = round(h, at0, 1);
    assert.deepStrictEqual([r1.intent.admin, r1.plan.rates.adminPerPeriod], [0, 312500000]);

    const at2 = at0 + 2 * P;
    const before = rowOf(h);
    const r2 = round(h, at2, 2, 2e8);
    assert.strictEqual(r2.intent.admin, 625000000);
    assert.deepStrictEqual([r2.value.admin, r2.value.adminPaid, r2.value.warSpend, r2.value.warSpendPaid],
      [625000000, 625000000, 2e8, 2e8]);
    const after = rowOf(h);
    assert.strictEqual(after.isk_balance, before.isk_balance + r2.value.income - r2.value.fleetUpkeep - 625000000 - 2e8);
    assert.deepStrictEqual([after.admin_total, after.war_spend_total, after.unpaid_total], [625000000, 2e8, 0]);
    const d2 = dayOf(h, TS.dayOf(at2));
    assert.deepStrictEqual([d2.admin, d2.war_spend], [625000000, 2e8]);

    const again = h.tx((db) => h.journal.applyOnce(db, { key: r2.ik, aggregate: { type: FACTION_AGGREGATE,
      id: String(F) }, eventType: EVENT_STRATEGY_INTENT, payload: { seed: 1, intent: r2.intent } },
    () => assert.fail("effect ran twice")));
    assert.strictEqual(again.duplicate, true);
    const nested = h.tx((db) => h.treasury.settleIntentInTx(db, { ...r2.intent, paidUntilFrom: after.paid_until,
      factionId: F, at: at2, warSpend: 2e8 }, r2.ik));
    assert.deepStrictEqual([nested.ok, nested.reason], [false, "NESTED_KEY_REUSED"]);
    assert.strictEqual(rowOf(h).isk_balance, after.isk_balance);

    const at3 = at0 + 3 * P;
    const read = h.tx((db) => h.treasury.readForReview(db, F, { at: at3, npcStations: 0, kind: "empire" }));
    const d3 = dayOf(h, TS.dayOf(at3));
    assert.deepStrictEqual(read.treasury.today, d3 ? { tradeOut: d3.trade_out, warSpend: d3.war_spend,
      productionFees: d3.production_fees, losses: d3.losses } : { tradeOut: 0, warSpend: 0, productionFees: 0,
      losses: 0 });
    const r3 = round(h, at3, 3, 1e13);
    const last = rowOf(h);
    assert.strictEqual(last.isk_balance, 0);
    assert.ok(r3.value.warSpendPaid < 1e13 && r3.value.unpaid === 1e13 - r3.value.warSpendPaid, JSON.stringify(r3.value));
    assert.deepStrictEqual([last.unpaid_total, last.war_spend_total, last.admin_total],
      [r3.value.unpaid, 2e8 + r3.value.warSpendPaid, 625000000 + r3.value.adminPaid]);
  }));

  needsDriver("IP4 migration 56 on a database of 55 with a treasury row: new columns 0, old values unchanged", () => {
    assert.ok(LATEST_SCHEMA_VERSION >= 56);
    assert.deepStrictEqual([MIGRATIONS[55].version, MIGRATIONS[55].name], [56, "world_faction_treasury_pressure"]);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-m56-"));
    const stores = [];
    const open = (migrations) => {
      const o = openStore({ filePath: path.join(tmp, "db.sqlite"), openDatabase: (f) => new driver.Database(f),
        exclusiveLock: true, busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5,
        randomSeed: () => 1, migrations });
      assert.ok(o.ok, JSON.stringify(o));
      stores.push(o.store);
      return o;
    };
    try {
      const old = open(MIGRATIONS.slice(0, 55));
      old.store.transaction("t", (db) => {
        db.prepare(`INSERT INTO world_faction_treasury (faction_id, kind, initial_isk, isk_balance, fleet_upkeep_total,
          created_at, updated_at, version) VALUES (?, 'empire', 5000, 4000, 70, 1, 2, 3)`).run(F);
        db.prepare(`INSERT INTO world_faction_treasury_days (faction_id, day, income, trade_out, balance_end,
          updated_at) VALUES (?, 9, 11, 22, 4000, 2)`).run(F);
      });
      old.store.close("upgrade");
      stores.length = 0;
      const up = open(MIGRATIONS);
      assert.deepStrictEqual([up.schemaVersion, up.applied], [LATEST_SCHEMA_VERSION, LATEST_SCHEMA_VERSION - 55]);
      const got = up.store.transaction("t", (db) => [
        db.prepare("SELECT isk_balance, fleet_upkeep_total, version, admin_total, war_spend_total "
          + "FROM world_faction_treasury").get(),
        db.prepare("SELECT income, trade_out, balance_end, admin, war_spend FROM world_faction_treasury_days").get(),
      ]).value;
      assert.deepStrictEqual(got.map((r) => ({ ...r })), [
        { isk_balance: 4000, fleet_upkeep_total: 70, version: 3, admin_total: 0, war_spend_total: 0 },
        { income: 11, trade_out: 22, balance_end: 4000, admin: 0, war_spend: 0 }]);
    } finally {
      for (const s of stores) s.close("test");
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test("IP5 config: 8 pressure keys in SCHEMA / TREASURY_PARAM_KEYS / .env.example, compose :-0, warning", () => {
    const byKey = new Map(config.SCHEMA.map((row) => [row.key, row]));
    const example = fs.readFileSync(path.join(MOD_DIR, ".env.example"), "utf8");
    for (const k of PRESSURE_KEYS) {
      const row = byKey.get(`treasury.${k}`);
      assert.ok(row, k);
      assert.ok(TREASURY_PARAM_KEYS.includes(k), k);
      assert.ok(example.includes(`# ${row.env}=`), row.env);
    }
    assert.deepStrictEqual([byKey.get("treasury.pressureEnabled").default,
      byKey.get("treasury.pressureEnabled").env], [false, "EVEJS_LNE_TREASURY_PRESSURE_ENABLED"]);
    const compose = fs.readFileSync(path.join(REPO_DIR, "compose.yaml"), "utf8");
    assert.ok(compose.includes("EVEJS_LNE_TREASURY_PRESSURE_ENABLED: ${EVEJS_LNE_TREASURY_PRESSURE_ENABLED:-0}"));
    const warn = (env) => resolve(env).warnings.filter((w) => w.startsWith("treasury.pressureEnabled"));
    assert.strictEqual(warn({ EVEJS_LNE_TREASURY_ENABLED: "0", EVEJS_LNE_TREASURY_PRESSURE_ENABLED: "1" }).length, 1);
    assert.strictEqual(warn({ EVEJS_LNE_TREASURY_ENABLED: "1", EVEJS_LNE_TREASURY_PRESSURE_ENABLED: "1" }).length, 0);
    assert.strictEqual(warn({ EVEJS_LNE_TREASURY_ENABLED: "1" }).length, 0);
    assert.strictEqual(warn({ EVEJS_LNE_TREASURY_ENABLED: "1", EVEJS_LNE_TREASURY_PRESSURE_ENABLED: "1",
      EVEJS_LNE_UPKEEP_ENABLED: "0" }).length, 1);
  });
};
