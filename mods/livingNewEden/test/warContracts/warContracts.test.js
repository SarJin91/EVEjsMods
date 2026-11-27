"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { loadDriver, withStore } = require("../notices/storeHelper");
const { resolveConfig } = require("../../config");
const { startWarContracts, createUnavailableWarContracts, FACADE_METHODS } = require("../../lib/warContracts");
const { isWarOffer, rewardOf } = require("../../lib/warContracts/rules");
const { createFrontJobRepository } = require("../../lib/frontJobs/repository");
const { startFrontJobs } = require("../../lib/frontJobs");
const { TABLE_POLICY } = require("../../lib/persistence/worldReset");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const AT = Date.UTC(2026, 10, 15, 12, 0, 0);
const DAY = 86400000;
const CALDARI = 500001;
const GURISTAS = 500010;
const S1 = 30000001;
const LP_CORP = { [CALDARI]: 1000035 };
const lpCorpOf = (f) => LP_CORP[f] || null;

function configOf(env) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_WAR_CONTRACTS_ENABLED: "1", ...env } });
  assert.ok(r.ok, JSON.stringify(r.errors));
  return r.config;
}

const run = (store, fn) => {
  const r = store.transaction("t", fn);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};
const rows = (store, sql, ...args) => run(store, (db) => db.prepare(sql).all(...args));

function insertBudget(store, factionId) {
  run(store, (db) => db.prepare("INSERT INTO world_trade_budgets (faction_id, isk_available, isk_reserved, created_at, "
    + "updated_at, version) VALUES (?, 1000000000, 0, ?, ?, 1)").run(factionId, AT, AT));
}

let seq = 0;
function insertOffer(store, o) {
  seq += 1;
  const v = { factionId: CALDARI, state: "OPEN", kind: "hull", typeId: 621, quantity: 4, iskTotal: 50000000,
    channel: "contract", side: "buy", expiresAt: AT + DAY, ...o };
  run(store, (db) => db.prepare("INSERT INTO world_trade_offers (offer_id, faction_id, station_id, system_id, "
    + "issuer_corporation_id, item_kind, item_key, type_id, quantity, unit_price_milli, isk_total, ref_price_milli, "
    + "price_source, state, created_at, expires_at, updated_at, version, side, channel) VALUES (?, ?, ?, ?, 1000162, "
    + "?, ?, ?, ?, 1000, ?, 1000, 'bid', ?, ?, ?, ?, 1, ?, ?)")
    .run(v.offerId, v.factionId, `npc-${seq}`, S1, v.kind, v.itemKey || `type:${seq}`, v.typeId, v.quantity, v.iskTotal,
      v.state,
      AT, v.expiresAt, AT, v.side, v.channel));
}

function boot(store, env = {}, ctxExtra = {}) {
  const started = startWarContracts({ config: configOf(env), ctx: { persistence: { ok: true, store }, ...ctxExtra },
    clock: { now: () => AT }, adapter: null, setTimer: () => ({ cancel() {}, hasRef: () => false }) });
  assert.ok(started.ok, JSON.stringify(started));
  return started.warContracts;
}

const wcRows = (store) => rows(store, "SELECT offer_id, state, end_reason, character_id, lp_corporation_id, isk_amount, "
  + "lp_amount, standing_micro, isk_state, lp_state, std_state, payout_state, awarded_at, ended_at, version "
  + "FROM world_war_contracts ORDER BY offer_id");

module.exports = ({ test, skip }) => {
  const P = Object.freeze({ includePrivate: false, itemKinds: ["hull", "mineral", "ore"], lpPerMillionIsk: 30,
    lpMin: 200, lpMax: 10000, iskBonusPermille: 0, standingRaw: 0.01 });

  test("W1 isWarOffer / rewardOf: prefixes, channel, side, expiry, private, hullsOnly; LP clamp, no corp, standing", () => {
    const base = { offerId: "to_1", side: "buy", channel: "contract", state: "OPEN", assigneeCharacterId: null,
      itemKind: "hull", itemKey: "group:cruiser", factionId: CALDARI, stationId: "npc-1", systemId: S1, typeId: 621,
      quantity: 4, iskTotal: 50000000, expiresAt: AT + DAY };
    assert.strictEqual(isWarOffer(base, P, AT), true);
    for (const [patch, why] of [[{ offerId: "tp_1" }, "tp_"], [{ offerId: "ts_1" }, "ts_"],
      [{ channel: "market" }, "market"], [{ side: "sell" }, "sell"], [{ expiresAt: AT }, "expired"],
      [{ assigneeCharacterId: 9001 }, "private"], [{ state: "ACCEPTED" }, "accepted"]]) {
      assert.strictEqual(isWarOffer({ ...base, ...patch }, P, AT), false, why);
    }
    assert.strictEqual(isWarOffer({ ...base, assigneeCharacterId: 9001 }, { ...P, includePrivate: true }, AT), true);
    assert.strictEqual(isWarOffer({ ...base, itemKind: "mineral" }, { ...P, itemKinds: ["hull"] }, AT), false,
      "hullsOnly");
    assert.deepStrictEqual(rewardOf(base, P, lpCorpOf),
      { iskAmount: 0, lpAmount: 1500, lpCorporationId: 1000035, standingMicro: 10000 });
    assert.strictEqual(rewardOf({ ...base, iskTotal: 1000000 }, P, lpCorpOf).lpAmount, 200, "lpMin");
    assert.strictEqual(rewardOf({ ...base, iskTotal: 10000000000 }, P, lpCorpOf).lpAmount, 10000, "lpMax");
    assert.strictEqual(rewardOf(base, { ...P, lpMin: 5000, lpMax: 1000 }, lpCorpOf).lpAmount, 1000, "lpMin > lpMax");
    assert.deepStrictEqual(rewardOf({ ...base, factionId: GURISTAS }, P, lpCorpOf),
      { iskAmount: 0, lpAmount: 0, lpCorporationId: null, standingMicro: 10000 });
  });

  const driver = loadDriver();
  if (!driver.ok) {
    skip("W2-W5 war contracts store", `better-sqlite3 unavailable (${driver.detail})`);
  } else {
    test("W2 adoption: to_ adopted once, tp_ and the DELIVER ref skipped; second pass and restart adopt nothing", () => {
      withStore(driver, ({ store }) => {
        insertBudget(store, CALDARI);
        insertOffer(store, { offerId: "to_a" });
        insertOffer(store, { offerId: "to_b" });
        insertOffer(store, { offerId: "tp_c" });
        const job = { jobId: `fj:1:0:${AT}`, day: 1, slot: 0, kind: "DELIVER", issuerFactionId: CALDARI,
          targetFactionId: null, systemId: S1, regionId: null, targetCount: 1, ref: "to_b", iskAmount: 1, lpAmount: 0,
          lpCorporationId: null, standingMicro: 0, maxCompletions: 1, description: "deliver", createdAt: AT,
          expiresAt: AT + DAY };
        run(store, (db) => assert.ok(createFrontJobRepository().insertJobInTx(db, job).ok));
        const env = { EVEJS_LNE_FRONT_JOBS_ENABLED: "1", EVEJS_LNE_FRONT_JOBS_DELIVER_ENABLED: "1" };
        const wc = boot(store, env);
        const after1 = wcRows(store);
        assert.deepStrictEqual(after1.map((r) => [r.offer_id, r.state, r.lp_amount, r.lp_corporation_id,
          r.standing_micro, r.isk_amount]), [["to_a", "OPEN", 1500, 1000035, 10000, 0]]);
        const desc = rows(store, "SELECT description, isk_total, quantity FROM world_war_contracts")[0];
        assert.deepStrictEqual([desc.description, desc.isk_total, desc.quantity],
          ["Living New Eden: war contract 4x unknown item for an unknown faction", 50000000, 4]);
        assert.strictEqual(wc.getStatus().counters.adoptSkippedFrontJob, 1);
        const second = wc.runPass(AT + 1000);
        assert.deepStrictEqual([second.ok, second.outcome, second.adopted], [true, "DONE", 0]);
        wc.stop("test");
        assert.deepStrictEqual(wc.runPass(AT), { ok: false, reason: "WAR_CONTRACTS_UNAVAILABLE" });
        const restarted = boot(store, env);
        assert.strictEqual(restarted.getStatus().counters.adopted, 0);
        assert.deepStrictEqual(wcRows(store), after1);
        restarted.stop("test");
      });
    });

    test("W3 settlement: AWARDED legs, LAPSED, OFFER_GONE, CAPPED, standing grant -> std SKIPPED, idempotent", () => {
      withStore(driver, ({ store }) => {
        insertBudget(store, CALDARI);
        for (const id of ["to_a", "to_b", "to_c", "to_d", "to_e"]) insertOffer(store, { offerId: id });
        const wc = boot(store, { EVEJS_LNE_WAR_CONTRACTS_MAX_AWARDS_PER_CHARACTER_DAY: "1" });
        assert.strictEqual(wc.getStatus().open, 5);
        const set = (sql, ...a) => run(store, (db) => db.prepare(sql).run(...a));
        set("UPDATE world_trade_offers SET state = 'ACCEPTED', acceptor_character_id = 9001 WHERE offer_id = 'to_a'");
        set("UPDATE world_trade_offers SET state = 'CANCELLED', end_reason = 'EXPIRED' WHERE offer_id = 'to_b'");
        set("DELETE FROM world_trade_offers WHERE offer_id = 'to_c'");
        set("UPDATE world_trade_offers SET state = 'DELIVERED', acceptor_character_id = 9002 "
          + "WHERE offer_id IN ('to_d', 'to_e')");
        const r = wc.runPass(AT + 5000);
        assert.deepStrictEqual([r.awarded, r.capped, r.lapsed, r.waits], [2, 1, 2, 0]);
        const got = wcRows(store);
        const at = AT + 5000;
        assert.deepStrictEqual(got.map((x) => [x.offer_id, x.state, x.end_reason, x.character_id, x.isk_state,
          x.lp_state, x.std_state, x.payout_state, x.awarded_at, x.ended_at, x.version]), [
          ["to_a", "AWARDED", null, 9001, "SKIPPED", "PENDING", "PENDING", "PENDING", at, null, 2],
          ["to_b", "LAPSED", "EXPIRED", null, null, null, null, null, null, at, 2],
          ["to_c", "LAPSED", "OFFER_GONE", null, null, null, null, null, null, at, 2],
          ["to_d", "AWARDED", null, 9002, "SKIPPED", "PENDING", "PENDING", "PENDING", at, null, 2],
          ["to_e", "CAPPED", "DAILY_CAP", 9002, null, null, null, null, null, at, 2]]);
        assert.strictEqual(wc.getStatus().open, 0);
        wc.runPass(AT + 6000);
        assert.deepStrictEqual(wcRows(store), got, "second pass changes nothing");
        wc.stop("test");
      });
      withStore(driver, ({ store }) => {
        insertBudget(store, CALDARI);
        insertOffer(store, { offerId: "to_g" });
        const wc = boot(store, { EVEJS_LNE_TRADE_STANDING_GRANT_ENABLED: "1" });
        run(store, (db) => db.prepare("UPDATE world_trade_offers SET state = 'INTAKE', acceptor_character_id = 9003")
          .run());
        assert.strictEqual(wc.runPass(AT + 10).awarded, 1);
        const row = wcRows(store)[0];
        assert.deepStrictEqual([row.lp_state, row.std_state, row.payout_state], ["PENDING", "SKIPPED", "PENDING"]);
        wc.stop("test");
      });
    });

    test("WC3 award mail: one wc:<id> line with the stock effect; notices refusal -> noticeRefused, row AWARDED", () => {
      for (const refuse of [false, true]) {
        withStore(driver, ({ store }) => {
          insertBudget(store, CALDARI);
          insertOffer(store, { offerId: "to_m", itemKey: "group:cruiser" });
          const items = [];
          const notices = { enqueueItemsInTx: (tx, list) => {
            assert.ok(tx && tx.inTransaction, "in the settle transaction");
            items.push(...list);
            return refuse ? { ok: false, reason: "NOTICES_DISABLED" } : { ok: true, inserted: list.length };
          } };
          const stations = { repository: { getStock: (tx, stationId) => ({ ok: true, truncated: false,
            items: [{ itemKind: "hull", itemKey: "group:cruiser", quantity: 7, stationId }] }) } };
          const wc = boot(store, {}, { notices, stations });
          run(store, (db) => db.prepare("UPDATE world_trade_offers SET state = 'DELIVERED', "
            + "acceptor_character_id = 9001").run());
          assert.strictEqual(wc.runPass(AT + 10).awarded, 1);
          assert.strictEqual(items.length, 1);
          assert.deepStrictEqual([items[0].eventKey, items[0].characterId, items[0].kind],
            ["wc:to_m", 9001, "WAR_CONTRACT_AWARD"]);
          assert.ok(items[0].line.includes("an unknown faction now holds 7 x cruiser"), items[0].line);
          const c = wc.getStatus().counters;
          assert.deepStrictEqual([c.awardMails, c.noticeRefused], refuse ? [0, 1] : [1, 0]);
          assert.strictEqual(wcRows(store)[0].state, "AWARDED");
          wc.stop("test");
        });
      }
    });

    test("WC4 late adoption: DELIVERED within adoptLateMs -> row AWARDED in one pass; older -> none; config error", () => {
      withStore(driver, ({ store }) => {
        insertBudget(store, CALDARI);
        insertOffer(store, { offerId: "to_late" });
        insertOffer(store, { offerId: "to_old" });
        const set = (sql, ...a) => run(store, (db) => db.prepare(sql).run(...a));
        set("UPDATE world_trade_offers SET state = 'DELIVERED', acceptor_character_id = 9001, ended_at = ? "
          + "WHERE offer_id = 'to_late'", AT - 3600000);
        set("UPDATE world_trade_offers SET state = 'DELIVERED', acceptor_character_id = 9001, ended_at = ? "
          + "WHERE offer_id = 'to_old'", AT - DAY - 1);
        insertOffer(store, { offerId: "to_x" });
        set("UPDATE world_trade_offers SET state = 'DELIVERED', acceptor_character_id = 9002, ended_at = ? "
          + "WHERE offer_id = 'to_x'", AT - 3600000);
        set("INSERT INTO world_front_jobs (job_id, day, slot, kind, state, issuer_faction_id, target_faction_id, "
          + "system_id, region_id, target_count, ref, isk_amount, lp_amount, lp_corporation_id, standing_micro, "
          + "max_completions, completions, description, created_at, expires_at, updated_at, version) VALUES "
          + "('fj:1:0:1', 1, 0, 'DELIVER', 'FILLED', ?, NULL, ?, NULL, 1, 'to_x', 1, 0, NULL, 0, 1, 1, 'Deliver', ?, ?, ?, 1)",
        CALDARI, S1, AT - DAY, AT, AT - 3600000);
        const wc = boot(store);
        assert.deepStrictEqual(wcRows(store).map((r) => [r.offer_id, r.state, r.character_id]),
          [["to_late", "AWARDED", 9001]]);
        assert.deepStrictEqual([wc.getStatus().counters.adoptedLate, wc.getStatus().counters.awarded,
          wc.getStatus().counters.adoptSkippedFrontJob], [1, 1, 1], "to_x skipped: ref of a FILLED DELIVER job");
        wc.runPass(AT + 1000);
        assert.strictEqual(wcRows(store).length, 1, "second pass: no second row");
        assert.strictEqual(wc.getStatus().counters.adopted, 1);
        wc.stop("test");
      });
      const bad = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_WAR_CONTRACTS_ENABLED: "1",
        EVEJS_LNE_WAR_CONTRACTS_RETENTION_MS: String(DAY), EVEJS_LNE_WAR_CONTRACTS_ADOPT_LATE_MS: String(DAY) } });
      assert.strictEqual(bad.ok, false);
      assert.ok(bad.errors.some((e) => e.startsWith("warContracts.adoptLateMs=")), JSON.stringify(bad.errors));
      const short = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_WAR_CONTRACTS_ENABLED: "1",
        EVEJS_LNE_FRONT_JOBS_RETENTION_MS: String(DAY) } });
      assert.strictEqual(short.ok, false);
      assert.ok(short.errors.some((e) => e.includes("frontJobs.retentionMs")), JSON.stringify(short.errors));
    });

    test("WC5: frontJobs off + OPEN DELIVER job -> no contract for its offer; warContracts off + OPEN contract "
      + "row -> no DELIVER job for its offer", () => {
      withStore(driver, ({ store }) => {
        insertBudget(store, CALDARI);
        insertOffer(store, { offerId: "to_d" });
        insertOffer(store, { offerId: "to_f" });
        const job = { jobId: `fj:1:0:${AT}`, day: 1, slot: 0, kind: "DELIVER", issuerFactionId: CALDARI,
          targetFactionId: null, systemId: S1, regionId: null, targetCount: 1, ref: "to_d", iskAmount: 1, lpAmount: 0,
          lpCorporationId: null, standingMicro: 0, maxCompletions: 1, description: "deliver", createdAt: AT,
          expiresAt: AT + DAY };
        run(store, (db) => assert.ok(createFrontJobRepository().insertJobInTx(db, job).ok));
        const wc = boot(store);
        assert.deepStrictEqual(wcRows(store).map((r) => r.offer_id), ["to_f"]);
        assert.strictEqual(wc.getStatus().counters.adoptSkippedFrontJob, 1);
        wc.stop("test");
      });
      withStore(driver, ({ store }) => {
        insertOffer(store, { offerId: "to_v" });
        insertOffer(store, { offerId: "to_w" });
        const repo = require("../../lib/warContracts/repository").createWarContractRepository();
        run(store, (db) => assert.ok(repo.insertOpenInTx(db, { offerId: "to_w", factionId: CALDARI, stationId: "npc-w",
          systemId: S1, itemKind: "hull", itemKey: "type:w", typeId: 621, quantity: 4, iskTotal: 50000000,
          lpCorporationId: null, iskAmount: 0, lpAmount: 0, standingMicro: 0, description: "war", at: AT }).ok));
        const cfg = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_FRONT_JOBS_ENABLED: "1",
          EVEJS_LNE_FRONT_JOBS_DELIVER_ENABLED: "1", EVEJS_LNE_FRONT_JOBS_JOBS_PER_DAY: "3",
          EVEJS_LNE_FRONT_JOBS_MAX_DELIVER_PER_DAY: "2" } });
        assert.ok(cfg.ok, JSON.stringify(cfg.errors));
        assert.strictEqual(cfg.config.warContracts.enabled, false);
        const fronts = [{ systemId: S1, controllerFactionId: GURISTAS, occupierFactionId: CALDARI,
          previousControllerFactionId: null, occupationState: "INVASION" }];
        const world = { repository: { listActiveOccupations: (_tx, o) => ({ ok: true,
          systems: fronts.filter((f) => f.systemId > o.afterSystemId).slice(0, o.limit), nextAfterSystemId: null }) } };
        const started = startFrontJobs({ config: cfg.config, ctx: { persistence: { ok: true, store, worldSeed: 4242 },
          world }, clock: { now: () => AT }, adapter: null, setTimer: () => ({ cancel() {}, hasRef: () => false }) });
        assert.ok(started.ok, JSON.stringify(started));
        try {
          const refs = rows(store, "SELECT ref FROM world_front_jobs WHERE kind = 'DELIVER' ORDER BY ref")
            .map((r) => r.ref);
          assert.deepStrictEqual(refs, ["to_v"], "the war offer is no DELIVER job");
        } finally {
          started.frontJobs.stop("test");
        }
      });
    });

    test("WC6 debt-sweep: listRecent limit+1 ended -> truncated, limit -> not; pass counts recent.truncated", () => {
      const { createOfferRepository } = require("../../lib/economy/trade/offerRepository");
      const no = () => assert.fail("read only");
      const offers = createOfferRepository({ journal: { applyOnce: no }, budgets: { adjustInDb: no },
        ids: { next: no }, clock: { now: () => AT } });
      withStore(driver, ({ store }) => {
        for (const id of ["to_r1", "to_r2", "to_r3"]) insertOffer(store, { offerId: id });
        run(store, (db) => db.prepare("UPDATE world_trade_offers SET state = 'DELIVERED', ended_at = ?").run(AT - 1000));
        const read = (limit) => run(store, (db) => offers.listRecent(db, { factionId: CALDARI, since: AT - DAY, limit }));
        const cut = read(2);
        assert.deepStrictEqual([cut.ok, cut.truncated, cut.offers.length], [true, true, 2]);
        const all = read(3);
        assert.deepStrictEqual([all.ok, all.truncated, all.offers.length], [true, false, 3]);
      });
      const { adoptInTx } = require("../../lib/warContracts/pass");
      const P = { factionsPerPass: 8, offerScanLimit: 32, maxAdoptPerPass: 16, includePrivate: true,
        itemKinds: ["hull"], lpPerMillionIsk: 30, lpMin: 200, lpMax: 10000, iskBonusPermille: 0, standingRaw: 0.01 };
      const passWith = (params) => {
        let recentCalls = 0;
        const deps = { repo: { getInTx: () => ({ ok: true, row: null }) }, frontJobRepo: null, afterFactionId: 0,
          budgets: { listBudgets: () => ({ ok: true, budgets: [{ factionId: CALDARI }] }) },
          offers: { listOpenOfFaction: () => ({ ok: true, offers: [], truncated: false }),
            listRecent: () => { recentCalls += 1; return { ok: true, offers: [], truncated: true }; } },
          params, lpCorpOf, names: null };
        const r = adoptInTx({}, deps, AT);
        return [r.ok, r.scanTruncated, recentCalls];
      };
      assert.deepStrictEqual(passWith({ ...P, adoptLateMs: DAY }), [true, 1, 1]);
      assert.deepStrictEqual(passWith({ ...P, adoptLateMs: 0 }), [true, 0, 0], "late adoption off: no listRecent");
    });

    test("W5 migration: world_war_contracts with 4 indexes, reset policy KEEP", () => {
      withStore(driver, ({ store }) => {
        const names = rows(store, "SELECT type, name FROM sqlite_master WHERE tbl_name = 'world_war_contracts' "
          + "ORDER BY type, name").map((r) => `${r.type}:${r.name}`);
        assert.deepStrictEqual(names, ["index:world_war_contracts_awards", "index:world_war_contracts_due",
          "index:world_war_contracts_ended", "index:world_war_contracts_open", "index:sqlite_autoindex_world_war_contracts_1",
          "table:world_war_contracts"].sort());
      }, { fresh: true });
      assert.strictEqual(TABLE_POLICY.world_war_contracts, "KEEP");
    });
  }

  test("W4 flag off: disabled_by_config, no timer; stub and facade keys = FACADE_METHODS; config defaults", () => {
    const off = resolveConfig({ modDir: MOD_DIR, env: {} }).config;
    const r = startWarContracts({ config: off, ctx: { persistence: { ok: true, store: { transaction: () =>
      assert.fail("no read") } } }, clock: { now: () => AT }, setTimer: () => assert.fail("no timer") });
    assert.deepStrictEqual(r, { ok: false, reason: "disabled_by_config" });
    assert.deepStrictEqual(Object.keys(createUnavailableWarContracts("WAR_CONTRACTS_DISABLED")).sort(),
      [...FACADE_METHODS].sort());
    const stub = createUnavailableWarContracts("WAR_CONTRACTS_DISABLED");
    assert.deepStrictEqual(stub.runPass(), { ok: false, reason: "WAR_CONTRACTS_UNAVAILABLE" });
    const fakeStore = { limits: { maxRowsPerTransaction: 500 }, transaction: () => ({ ok: false, reason: "TX_FAILED" }) };
    const on = startWarContracts({ config: configOf({}), ctx: { persistence: { ok: true, store: fakeStore } },
      clock: { now: () => AT }, setTimer: () => ({ cancel() {}, hasRef: () => false }) });
    assert.ok(on.ok, JSON.stringify(on));
    assert.deepStrictEqual(Object.keys(on.warContracts).sort(), [...FACADE_METHODS].sort());
    assert.strictEqual(on.warContracts.getStatus().counters.errors, 2, "tx refusal counted, never thrown");
    on.warContracts.stop("test");
    assert.deepStrictEqual({ ...off.warContracts }, { enabled: false, passIntervalMs: 60000, factionsPerPass: 8,
      offerScanLimit: 32, maxAdoptPerPass: 16, settlePerPass: 32, includePrivate: true, hullsOnly: false,
      lpPerMillionIsk: 30, lpMin: 200, lpMax: 10000, standingRaw: 0.01, iskBonusPermille: 0,
      maxAwardsPerCharacterDay: 10, awardWindowMs: 86400000,
      payoutEnabled: true, payoutMaxPerPass: 10, payoutMaxAttempts: 8, payoutRetryBaseMs: 60000,
      payoutRetryMaxMs: 3600000, retentionMs: 2592000000, prunePerPass: 200,
      chatEnabled: true, chatMinIntervalMs: 10000, chatMaxLines: 6, chatMaxChars: 900, chatFrontScan: 16,
      awardMailEnabled: true, announceMailEnabled: false, announceMaxRecipients: 50, adoptLateMs: 86400000,
      viewEnabled: true, viewRows: 50, viewSumWindowMs: 604800000 });
  });
};
