"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const config = require("../../config");
const { startBattle, lazyTreasuryConsequence } = require("../../lib/battle");
const plan = require("../../lib/battle/settlementPlan");
const { createViewRegistry } = require("../../lib/observer/views");
const { createTreasuryRepository } = require("../../lib/economy/treasury/treasuryRepository");
const { createTreasuryService } = require("../../lib/economy/treasury/treasuryService");
const { createUnavailableTreasury } = require("../../lib/economy/treasury");
const { lossChargesOf, createTreasuryLossConsequence } = require("../../lib/economy/treasury/lossConsequence");
const TS = require("../../lib/economy/treasury/schema");
const { harness: H } = require("../battle/settlement.test");
const { harness: C } = require("../battle/contacts.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const A = H.FACTION_A;
const B = H.FACTION_B;
const PASSIVE = 500018;
const CRUISER = 13000000;
const BATTLESHIP = 185000000;
const VALUES = Object.freeze({ cruiser: CRUISER, battleship: BATTLESHIP });
const HULL_VALUES = Object.freeze({ version: "test", valueOf: (g) => (Object.prototype.hasOwnProperty.call(VALUES, g)
  ? VALUES[g] : null), all: () => VALUES });
const LOST = Object.freeze([{ hullGroup: "cruiser", count: 3 }, { hullGroup: "battleship", count: 1 }]);
const DEBIT = 3 * CRUISER + BATTLESHIP;
const ON = Object.freeze({ EVEJS_LNE_TREASURY_ENABLED: "1", EVEJS_LNE_TREASURY_LOSSES_ENABLED: "1" });
const KINDS = Object.freeze({ [A]: "pirate", [B]: "pirate", [PASSIVE]: "neutral" });
const REGISTRY = Object.freeze({
  isActive: (f) => f === A || f === B,
  getFaction: (f) => (KINDS[f] ? { factionId: f, kind: KINDS[f] } : null),
});

function boot(opened, shared, opts = {}) {
  const cfg = config.resolveConfig({ modDir: MOD_DIR, env: { ...ON, ...(opts.env || {}) } }).config;
  const holder = { treasury: null };
  const env = H.boot(opened, shared, { consequences: [lazyTreasuryConsequence(() => holder.treasury)] });
  env.now = () => shared.clock.now();
  env.repository = createTreasuryRepository({ journal: env.journal, clock: shared.clock });
  env.treasury = createTreasuryService({ store: env.store, repository: env.repository, config: cfg,
    clock: shared.clock, hullValues: HULL_VALUES, getStrategy: () => ({ registry: REGISTRY }) });
  env.holder = holder;
  env.cfg = cfg;
  holder.treasury = env.treasury;
  return env;
}

const seed = (env, f, initialIsk) => {
  const r = env.tx((db) => env.repository.seedInTx(db, { factionId: f, kind: KINDS[f], initialIsk, at: env.now() },
    TS.seedKey(f)));
  assert.ok(r.ok && r.duplicate === false, JSON.stringify(r));
};
const rowOf = (env, f) => env.tx((db) => db.prepare("SELECT * FROM world_faction_treasury WHERE faction_id = ?")
  .get(f)) || null;
const dayOf = (env, f) => env.tx((db) => db.prepare("SELECT * FROM world_faction_treasury_days WHERE faction_id = ?")
  .get(f)) || null;
const treasuryRows = (env) => H.n(env, "SELECT count(*) AS n FROM world_faction_treasury");

function lossBattle(env, tag, opts = {}) {
  const factionB = opts.factionB || B;
  const fa = H.newFleet(env, `${tag}:a`, A, LOST);
  const fb = H.newFleet(env, `${tag}:b`, factionB, opts.bComp || [{ hullGroup: "frigate", count: 2 }]);
  const battle = H.battleOfFleets(env, tag, [fa], [fb], { factionB, mode: opts.mode });
  const all = (e) => ({ d: e.count, e: 0 });
  const result = H.resultFor(battle.input, opts.bLost ? "DRAW" : "B_WIN",
    { [fa]: all, ...(opts.bLost ? { [fb]: all } : {}) });
  return { battle, result };
}

const settleLive = (env, battle, result) => env.tx((db) => env.settlement.settleLive(db,
  { battleId: battle.battleId, result, at: env.now() }, 1));

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("TL1 lossChargesOf: 3 cruisers + 1 battleship -> lossFit 224 mln / lossValue 448 mln / 4 ships; unvalued; "
    + "fit 0; count 0 refused", () => {
    const rows = [{ factionId: A, hullGroup: "cruiser", count: 3 }, { factionId: A, hullGroup: "battleship", count: 1 }];
    const out = [];
    out.push(lossChargesOf(rows, HULL_VALUES.valueOf, 1000));
    out.push(lossChargesOf([...rows, { factionId: B, hullGroup: "mystery", count: 2 }], HULL_VALUES.valueOf, 1000));
    out.push(lossChargesOf(rows, HULL_VALUES.valueOf, 0));
    out.push(lossChargesOf([{ factionId: A, hullGroup: "cruiser", count: 0 }], HULL_VALUES.valueOf, 1000).reason);
    out.push(lossChargesOf([{ factionId: 0, hullGroup: "cruiser", count: 1 }], HULL_VALUES.valueOf, 1000).reason);
    assert.deepStrictEqual(out, [
      { ok: true, charges: [{ factionId: A, lossFit: 224000000, lossValue: 448000000, shipsLost: 4, unvalued: 0 }] },
      { ok: true, charges: [{ factionId: B, lossFit: 0, lossValue: 0, shipsLost: 2, unvalued: 2 },
        { factionId: A, lossFit: 224000000, lossValue: 448000000, shipsLost: 4, unvalued: 0 }] },
      { ok: true, charges: [{ factionId: A, lossFit: 0, lossValue: 224000000, shipsLost: 4, unvalued: 0 }] },
      "TREASURY_INVALID_INPUT",
      "TREASURY_INVALID_INPUT",
    ]);
  });

  needsDriver("TL2 VIRTUAL settle: debit 224 mln, totals + day row, mode / paid_until untouched, duplicate settle "
    + "charges nothing, panel today losses / lossValue / shipsLost", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = boot(reopen(), shared);
    seed(env, A, 1e12);
    const before = rowOf(env, A);
    const { battle, result } = lossBattle(env, "tl2");
    const r = H.settleIn(env, env.settlement, battle, result);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual([r.duplicate, r.outcome, r.consequences], [false, "COMPLETED",
      { applied: ["treasury"], refused: [] }]);
    const row = rowOf(env, A);
    assert.deepStrictEqual([row.isk_balance, row.loss_total, row.loss_value_total, row.ships_lost_total,
      row.unpaid_total, row.mode, row.paid_until, row.mode_changed_at],
    [1e12 - DEBIT, DEBIT, 2 * DEBIT, 4, 0, before.mode, before.paid_until, before.mode_changed_at]);
    const day = dayOf(env, A);
    assert.deepStrictEqual([day.day, day.losses, day.loss_value, day.ships_lost, day.unpaid, day.balance_end],
      [TS.dayOf(env.now()), DEBIT, 2 * DEBIT, 4, 0, 1e12 - DEBIT]);
    assert.strictEqual(rowOf(env, B), null, "B lost nothing: no row");
    const key = `${plan.settleKey(battle.battleId, 1)}:c:treasury:${A}`;
    assert.strictEqual(H.n(env, "SELECT count(*) AS n FROM world_event_journal WHERE idempotency_key = ?", key), 1);

    const again = H.settleIn(env, env.settlement, battle, result);
    assert.deepStrictEqual([again.ok, again.duplicate], [true, true], JSON.stringify(again));
    assert.deepStrictEqual(rowOf(env, A), row, "no second debit");
    assert.deepStrictEqual(env.treasury.getStatus().counters.lossSettled, 1);
    assert.deepStrictEqual(env.treasury.getStatus().counters.lossFitIsk, DEBIT);

    const panel = env.treasury.listForPanel();
    assert.ok(panel.ok, JSON.stringify(panel));
    const today = panel.rows.find((x) => x.factionId === A).today;
    assert.deepStrictEqual([today.losses, today.lossValue, today.shipsLost], [DEBIT, 2 * DEBIT, 4]);
  }));

  needsDriver("TL3 LIVE settleLive: the same debit; balance 100 mln -> balance 0 + unpaid 124 mln (row and day)",
    async () => {
      const run = (initialIsk) => H.withStore(driver, async (reopen) => {
        const env = boot(reopen(), H.sharedOf());
        seed(env, A, initialIsk);
        const { battle, result } = lossBattle(env, "tl3", { mode: "LIVE_EVEJS" });
        const r = settleLive(env, battle, result);
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        assert.deepStrictEqual([r.outcome, r.consequences], ["COMPLETED", { applied: ["treasury"], refused: [] }]);
        const row = rowOf(env, A);
        const day = dayOf(env, A);
        return [row.isk_balance, row.loss_total, row.loss_value_total, row.ships_lost_total, row.unpaid_total,
          day.losses, day.unpaid, env.treasury.getStatus().counters.unpaid];
      });
      assert.deepStrictEqual(await run(1e12), [1e12 - DEBIT, DEBIT, 2 * DEBIT, 4, 0, DEBIT, 0, 0]);
      assert.deepStrictEqual(await run(1e8), [0, 1e8, 2 * DEBIT, 4, DEBIT - 1e8, 1e8, DEBIT - 1e8, DEBIT - 1e8]);
    });

  needsDriver("TL4 passive 500018 vs pirate: no 500018 row, lossSkipped 1, the pirate seeded + charged; stub / stopped "
    + "service -> skipped TREASURY_OFF, no treasury row", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = boot(reopen(), shared);
    env.holder.treasury = createUnavailableTreasury("TREASURY_DISABLED", "disabled_by_config");
    const off1 = lossBattle(env, "tl4-stub");
    const s1 = H.settleIn(env, env.settlement, off1.battle, off1.result);
    const stopped = createTreasuryService({ store: env.store, repository: env.repository, config: env.cfg,
      clock: shared.clock, hullValues: HULL_VALUES, getStrategy: () => ({ registry: REGISTRY }) });
    stopped.stop("test");
    const viaStopped = stopped.lossConsequence.apply(null, { losses: [{ factionId: A, hullGroup: "cruiser",
      count: 1 }], at: 0 }, "k");
    assert.deepStrictEqual([s1.ok, s1.consequences, viaStopped, treasuryRows(env)],
      [true, { applied: ["treasury"], refused: [] }, { ok: true, skipped: "TREASURY_OFF" }, 0]);

    env.holder.treasury = env.treasury;
    const { battle, result } = lossBattle(env, "tl4", { factionB: PASSIVE,
      bComp: [{ hullGroup: "cruiser", count: 2 }], bLost: true });
    const r = H.settleIn(env, env.settlement, battle, result);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.deepStrictEqual(r.consequences, { applied: ["treasury"], refused: [] });
    assert.strictEqual(rowOf(env, PASSIVE), null, "passive faction: never seeded, never charged");
    const row = rowOf(env, A);
    assert.ok(row.initial_isk > DEBIT, String(row.initial_isk));
    assert.deepStrictEqual([row.kind, row.isk_balance, row.loss_total, row.ships_lost_total],
      ["pirate", row.initial_isk - DEBIT, DEBIT, 4]);
    assert.strictEqual(H.n(env, "SELECT count(*) AS n FROM world_event_journal WHERE idempotency_key = ?",
      TS.seedKey(A)), 1);
    const c = env.treasury.getStatus().counters;
    assert.deepStrictEqual([c.lossSkipped, c.lossSettled, c.seeded], [1, 1, 1]);
  }));

  needsDriver("TL5 gate: source fact, getStatus().consequences has treasury only with strategy + treasury.enabled + "
    + "lossesEnabled (both on by default since ISK-4); config defaults; no settleRowsReserve warning with every "
    + "consequence on", () => {
    const src = fs.readFileSync(path.join(MOD_DIR, "lib", "battle", "index.js"), "utf8");
    assert.ok(/\.\.\.\(treasuryLossOn \? \[lazyTreasuryConsequence\(deps\.getTreasury\)\] : \[\]\)[\],]/.test(src),
      "consequence list entry");
    assert.ok(/config\.treasury\.enabled === true && config\.treasury\.lossesEnabled === true/.test(src), "gate");

    const consequencesOf = (over) => {
      const env = C.createEnv(driver, { config: over });
      try {
        env.battle.stop("test");
        const r = startBattle({ ...env.battleDeps, views: createViewRegistry(), getTreasury: () => null });
        assert.ok(r.ok, JSON.stringify(r));
        env.battle = r.battle;
        return [...r.battle.getStatus().consequences];
      } finally {
        env.close();
      }
    };
    const all = { "treasury.enabled": true, "treasury.lossesEnabled": true };
    const lists = [consequencesOf({}), consequencesOf(all),
      consequencesOf({ ...all, "modules.strategy.enabled": false }),
      consequencesOf({ "treasury.enabled": true, "treasury.lossesEnabled": false }),
      consequencesOf({ "treasury.enabled": false, "treasury.lossesEnabled": true })];
    assert.deepStrictEqual(lists.map((l) => l.includes("treasury")), [true, true, false, false, false]);
    assert.strictEqual(lists[1][lists[1].length - 1], "treasury", "after intel");

    const bare = config.resolveConfig({ modDir: MOD_DIR, env: {} });
    const def = bare.config;
    assert.deepStrictEqual([def.treasury.enabled, def.treasury.lossesEnabled, def.treasury.fitValuePermille,
      TS.TREASURY_LOSS_ROWS_BOUND, def.battle.settleRowsReserve], [true, true, 1000, 11, 56]);
    assert.deepStrictEqual(bare.warnings.filter((w) => w.startsWith("battle.settleRowsReserve")), []);
    const on = config.resolveConfig({ modDir: MOD_DIR, env: { ...ON } });
    assert.deepStrictEqual([on.config.wrecks.enabled, on.config.occupation.enabled, on.config.siege.enabled,
      on.config.battle.settleRowsReserve], [true, true, true, 56]);
    assert.deepStrictEqual(on.warnings.filter((w) => w.startsWith("battle.settleRowsReserve")), []);
    const tight = config.resolveConfig({ modDir: MOD_DIR, env: { ...ON, EVEJS_LNE_BATTLE_SETTLE_ROWS_RESERVE: "55" } });
    assert.deepStrictEqual(tight.warnings.filter((w) => w.startsWith("battle.settleRowsReserve")).map((w) =>
      w.slice(0, 40)), ["battle.settleRowsReserve=55 below 56 (wr"]);
  });

  test("TL6 a hive loss seeds no treasury row and adds no unpaid; the pirate beside it is charged", () => {
    const HIVE = 500025;
    const kinds = { [HIVE]: "hive", [B]: "pirate" };
    const seeds = [];
    const settles = [];
    const counts = {};
    const consequence = createTreasuryLossConsequence({
      repository: { settleInTx: (_tx, row, key) => {
        settles.push([row.factionId, key]);
        return { ok: true, duplicate: false, paid: { lossFit: 0 }, unpaid: row.debits.lossFit };
      } },
      hullValues: HULL_VALUES, fitValuePermille: 1000,
      seedIfMissingInTx: (_tx, f) => {
        seeds.push(f);
        return { ok: true, seeded: true };
      },
      getRegistry: () => ({ isActive: () => true, getFaction: (f) => ({ factionId: f, kind: kinds[f] }) }),
      isRunning: () => true,
      count: (name, n) => { counts[name] = (counts[name] || 0) + n; },
    });
    const hiveOnly = consequence.apply({}, { at: 1, losses: [{ factionId: HIVE, hullGroup: "cruiser", count: 3 }] },
      "b:hive");
    assert.deepStrictEqual([hiveOnly.ok, hiveOnly.charged, hiveOnly.skipped], [true, [], 1]);
    assert.deepStrictEqual([seeds, settles, counts.unpaid, counts.seeded], [[], [], 0, 0]);
    const both = consequence.apply({}, { at: 1, losses: [{ factionId: HIVE, hullGroup: "cruiser", count: 1 },
      { factionId: B, hullGroup: "cruiser", count: 1 }] }, "b:both");
    assert.deepStrictEqual([both.ok, both.charged.map((c) => c.factionId), both.skipped], [true, [B], 1]);
    assert.deepStrictEqual([seeds, settles], [[B], [[B, `b:both:${B}`]]]);
  });
};
