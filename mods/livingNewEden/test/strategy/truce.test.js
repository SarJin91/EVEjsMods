"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const { harness: H } = require("../battle/settlement.test");
const { lazyIntelConsequence } = require("../../lib/battle");
const { startStrategy } = require("../../lib/strategy");
const { createJournal } = require("../../lib/persistence/journal");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { TABLE_POLICY, ACTION } = require("../../lib/persistence/worldReset");
const { stepWarPair, effectiveStateOf, pairOf } = require("../../lib/strategy/truce/weariness");
const { createTruceRepository } = require("../../lib/strategy/truce/repository");
const { WAR_PAIR_ROWS_BOUND } = require("../../lib/strategy/truce/schema");
const { settlementRowsLimit } = require("../../lib/battle/settlementPlan");
const { resolveConfig } = require("../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const HOUR = 3600000;
const P = Object.freeze({ windowMs: 72 * HOUR, minLosses: 60, lossRatioPermille: 2000, maxWinPermille: 250,
  truceMs: 48 * HOUR, cooldownMs: 72 * HOUR });
const LO = 500010;
const HI = 500019;
const T0 = 1760000000000;

const battle = (at, lossesLo, lossesHi, winner) => ({ lo: LO, hi: HI, at, lossesLo, lossesHi, winner });
function run(row, battles) {
  let r = row;
  const events = [];
  let last = null;
  for (const b of battles) {
    last = stepWarPair(r, b, P);
    events.push(last.event);
    r = last.row;
  }
  return { row: r, events, last };
}

function configOf(env = {}) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } });
  assert.deepStrictEqual(r.errors || [], []);
  return r;
}

const pairRows = (tx) => tx((db) => db.prepare("SELECT faction_lo AS lo, faction_hi AS hi, state, battles, "
  + "losses_lo AS ll, losses_hi AS lh, wins_lo AS wl, wins_hi AS wh FROM world_war_pairs ORDER BY faction_lo, "
  + "faction_hi").all().map((r) => ({ ...r })));

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("TR1 X loses 70 vs 20 with 0 wins in 3 battles -> WAR_PAIR_TRUCE, initiator X, truceUntil = at + truceMs; "
    + "WAR again at truceUntil", () => {
    assert.deepStrictEqual(pairOf(HI, LO), { lo: LO, hi: HI });
    assert.strictEqual(pairOf(LO, LO), null);
    const out = run(null, [battle(T0, 10, 20, HI), battle(T0 + HOUR, 30, 0, HI), battle(T0 + 2 * HOUR, 30, 0, HI)]);
    assert.deepStrictEqual(out.events, ["WAR_PAIR_CHANGED", "WAR_PAIR_CHANGED", "WAR_PAIR_TRUCE"]);
    const at = T0 + 2 * HOUR;
    assert.deepStrictEqual([out.row.state, out.row.initiator, out.row.truceUntil, out.row.cooldownUntil,
      out.row.trucesTotal, out.row.battles, out.row.lossesLo],
    ["TRUCE", LO, at + P.truceMs, at + P.truceMs + P.cooldownMs, 1, 0, 0]);
    assert.deepStrictEqual(effectiveStateOf(out.row, at + P.truceMs - 1),
      { state: "TRUCE", truceUntil: at + P.truceMs, initiator: LO });
    assert.strictEqual(effectiveStateOf(out.row, at + P.truceMs).state, "WAR");
    assert.strictEqual(effectiveStateOf(null, at).state, "WAR");
  });

  test("TR2 threshold met in the cooldown -> WAR_PAIR_CHANGED; gap > windowMs -> new series; battle in a truce -> "
    + "event null", () => {
    const at = T0 + 2 * HOUR;
    const truce = run(null, [battle(T0, 40, 0, HI), battle(at, 40, 0, HI)]);
    assert.strictEqual(truce.last.event, "WAR_PAIR_TRUCE");
    const inTruce = stepWarPair(truce.row, battle(at + HOUR, 100, 0, HI), P);
    assert.deepStrictEqual([inTruce.event, inTruce.row], [null, truce.row], "No write in a truce");
    const after = at + P.truceMs;
    const cool = run(truce.row, [battle(after, 70, 0, HI), battle(after + HOUR, 70, 0, HI)]);
    assert.deepStrictEqual(cool.events, ["WAR_PAIR_CHANGED", "WAR_PAIR_CHANGED"]);
    assert.deepStrictEqual([cool.row.state, cool.row.seriesStartAt, cool.row.battles, cool.row.lossesLo,
      cool.row.cooldownUntil], ["WAR", after, 2, 140, at + P.truceMs + P.cooldownMs]);
    const gap = stepWarPair(cool.row, battle(after + HOUR + P.windowMs + 1, 5, 1, LO), P);
    assert.deepStrictEqual([gap.event, gap.row.seriesStartAt, gap.row.battles, gap.row.lossesLo, gap.row.lossesHi,
      gap.row.winsLo], ["WAR_PAIR_CHANGED", after + HOUR + P.windowMs + 1, 1, 5, 1, 1]);
  });

  test("TR3 winsX x 1000 > maxWinPermille x battles -> no truce", () => {
    const out = run(null, [battle(T0, 20, 5, LO), battle(T0 + 1, 20, 5, LO), battle(T0 + 2, 25, 0, HI),
      battle(T0 + 3, 25, 0, HI)]);
    assert.deepStrictEqual([out.events[3], out.row.state, out.row.lossesLo, out.row.winsLo, out.row.battles],
      ["WAR_PAIR_CHANGED", "WAR", 90, 2, 4]);
  });

  needsDriver("TR4 two battles -> one row with the sums; the same ck -> duplicate; reopened store + new repository "
    + "-> the same truce partners", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const repoOf = () => createTruceRepository({ journal: createJournal({ clock: shared.clock,
        maxPayloadBytes: 16384, maxRows: 500 }), limits: { maxWarPairRows: 16 }, params: P });
      const first = reopen();
      const tx = (store) => (fn) => {
        const r = store.transaction("test", fn);
        assert.ok(r.ok, JSON.stringify(r));
        return r.value;
      };
      const t1 = tx(first.store);
      const repo = repoOf();
      const r1 = t1((db) => repo.recordBattleInTx(db, battle(T0, 10, 3, HI), "battle:a:settle:v1:c:intel:warpair"));
      const r2 = t1((db) => repo.recordBattleInTx(db, battle(T0 + HOUR, 20, 4, null), "battle:b:settle:v1:c:intel:warpair"));
      assert.deepStrictEqual([r1.event, r2.event], ["WAR_PAIR_CHANGED", "WAR_PAIR_CHANGED"]);
      assert.deepStrictEqual(pairRows(t1), [{ lo: LO, hi: HI, state: "WAR", battles: 2, ll: 30, lh: 7, wl: 0, wh: 1 }]);
      const again = t1((db) => repo.recordBattleInTx(db, battle(T0, 10, 3, HI), "battle:a:settle:v1:c:intel:warpair"));
      assert.deepStrictEqual([again.ok, again.duplicate], [true, true]);
      assert.strictEqual(pairRows(t1)[0].battles, 2, "replay not counted");
      const r3 = t1((db) => repo.recordBattleInTx(db, battle(T0 + 2 * HOUR, 40, 0, HI), "battle:c:settle:v1:c:intel:warpair"));
      assert.deepStrictEqual([r3.event, r3.state], ["WAR_PAIR_TRUCE", "TRUCE"]);
      const at = T0 + 3 * HOUR;
      const before = [t1((db) => repo.listTrucedInDb(db, LO, at)), t1((db) => repo.listTrucedInDb(db, HI, at))];
      assert.deepStrictEqual(before, [{ ok: true, partners: [HI] }, { ok: true, partners: [LO] }]);
      const inTruce = t1((db) => repo.recordBattleInTx(db, battle(at, 5, 5, LO), "battle:d:settle:v1:c:intel:warpair"));
      assert.deepStrictEqual([inTruce.ok, inTruce.skipped], [true, "TRUCE_IN_FORCE"]);
      first.store.close("restart");
      const t2 = tx(reopen().store);
      const repo2 = repoOf();
      assert.deepStrictEqual([t2((db) => repo2.listTrucedInDb(db, LO, at)), t2((db) => repo2.listTrucedInDb(db, HI, at))],
        before);
      assert.deepStrictEqual(t2((db) => repo2.listTrucedInDb(db, LO, T0 + 2 * HOUR + P.truceMs)),
        { ok: true, partners: [] }, "expired truce = WAR");
      const rec = t2((db) => repo2.getPairInDb(db, LO, HI)).record;
      assert.deepStrictEqual([rec.state, rec.initiator, rec.trucesTotal, rec.version], ["TRUCE", LO, 1, 3]);
    }));

  needsDriver("TR5 flag off -> no warPair write, reserveNeed unchanged; flag on -> one pair row; migration 105 + WIPE",
    () => H.withStore(driver, async (reopen) => {
      assert.deepStrictEqual(MIGRATIONS.filter((m) => m.name === "war_pairs").map((m) => m.version), [105]);
      assert.strictEqual(TABLE_POLICY.world_war_pairs, ACTION.WIPE);
      const off = configOf();
      const on = configOf({ EVEJS_LNE_STRATEGY_TRUCE_ENABLED: "1" });
      assert.deepStrictEqual(off.warnings, []);
      assert.deepStrictEqual(on.warnings, []);
      assert.strictEqual(settlementRowsLimit(on.config), settlementRowsLimit(off.config) - WAR_PAIR_ROWS_BOUND);

      const shared = H.sharedOf();
      const opened = reopen();
      let strategy = null;
      const env = H.boot(opened, shared);
      env.now = () => shared.clock.now();
      env.worldRepository = { getSystem: (tx, id) => ({ ok: true, system: { systemId: id, controllerFactionId: null } }) };
      env.settlement = env.makeSettlement({ consequences: [lazyIntelConsequence(() => strategy)] });
      const strategyOf = (config) => {
        const st = startStrategy({ config, persistence: { ok: true, store: opened.store, journal: env.journal,
          worldSeed: opened.worldSeed }, clock: { now: () => env.now() }, fleets: env.fleets,
        world: { repository: env.worldRepository }, logger: { log() {} } });
        assert.ok(st.ok, JSON.stringify(st));
        return st.strategy;
      };
      const fight = (tag) => {
        const a = H.newFleet(env, `${tag}:a`, H.FACTION_A, [{ hullGroup: "frigate", count: 2 }]);
        const b = H.newFleet(env, `${tag}:b`, H.FACTION_B, [{ hullGroup: "cruiser", count: 3 }]);
        const bt = H.battleOfFleets(env, tag, [a], [b]);
        const result = H.resultFor(bt.input, "B_WIN", { [a]: (e) => ({ d: e.count, e: 0 }), [b]: () => ({ d: 1, e: 0 }) });
        const r = H.settleIn(env, env.settlement, bt, result);
        assert.strictEqual(r.outcome, "COMPLETED", JSON.stringify(r));
        assert.deepStrictEqual(r.consequences, { applied: ["intel"], refused: [] });
      };
      const n = () => H.n(env, "SELECT count(*) AS n FROM world_war_pairs");

      strategy = strategyOf(off.config);
      assert.deepStrictEqual(strategy.listTruced(LO, T0), { ok: false, reason: "TRUCE_OFF" });
      fight("tr5off");
      assert.strictEqual(n(), 0, "flag off: no war pair");

      strategy = strategyOf(on.config);
      fight("tr5on");
      const rows = env.tx((db) => db.prepare("SELECT faction_lo AS lo, faction_hi AS hi, battles, losses_lo AS ll, "
        + "losses_hi AS lh, wins_lo AS wl FROM world_war_pairs").all().map((r) => ({ ...r })));
      assert.deepStrictEqual(rows, [{ lo: H.FACTION_B, hi: H.FACTION_A, battles: 1, ll: 1, lh: 2, wl: 1 }]);
      assert.deepStrictEqual(strategy.listTruced(LO, T0), { ok: true, partners: [] });
    }));

  needsDriver("TR-L1 listTrucesInDb: truce in force -> [{partner, until, initiator}] for LO and HI "
    + "at = truceUntil -> []; outside a tx -> TX_REQUIRED; listTrucedInDb keeps {ok, partners}", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const repo = createTruceRepository({ journal: createJournal({ clock: shared.clock, maxPayloadBytes: 16384,
        maxRows: 500 }), limits: { maxWarPairRows: 16 }, params: P });
      const { store } = reopen();
      const t = (fn) => {
        const r = store.transaction("test", fn);
        assert.ok(r.ok, JSON.stringify(r));
        return r.value;
      };
      t((db) => repo.recordBattleInTx(db, battle(T0, 40, 0, HI), "battle:l1a:settle:v1:c:intel:warpair"));
      const r = t((db) => repo.recordBattleInTx(db, battle(T0 + 2 * HOUR, 40, 0, HI), "battle:l1b:settle:v1:c:intel:warpair"));
      assert.strictEqual(r.event, "WAR_PAIR_TRUCE");
      const until = T0 + 2 * HOUR + P.truceMs;
      const at = T0 + 3 * HOUR;
      assert.deepStrictEqual([t((db) => repo.listTrucesInDb(db, LO, at)), t((db) => repo.listTrucesInDb(db, HI, at))], [
        { ok: true, truces: [{ partner: HI, until, initiator: LO }] },
        { ok: true, truces: [{ partner: LO, until, initiator: LO }] }]);
      assert.deepStrictEqual(t((db) => repo.listTrucesInDb(db, LO, until)), { ok: true, truces: [] });
      assert.deepStrictEqual(repo.listTrucesInDb({ inTransaction: false }, LO, at), { ok: false, reason: "TX_REQUIRED" });
      assert.deepStrictEqual(t((db) => repo.listTrucedInDb(db, LO, at)), { ok: true, partners: [HI] });
    }));
};
