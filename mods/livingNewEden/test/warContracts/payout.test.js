"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { startWarContracts } = require("../../lib/warContracts");
const { createWarContractRepository } = require("../../lib/warContracts/repository");
const { decideSettle } = require("../../lib/warContracts/rules");
const WS = require("../../lib/warContracts/schema");
const FS = require("../../lib/frontJobs/schema");
const { createPayoutPump } = require("../../lib/frontJobs/payoutPump");
const { harness: H } = require("../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const AT = Date.UTC(2026, 10, 16, 12, 0, 0);
const DAY = 86400000;
const CALDARI = 500001;
const S1 = 30000001;
const LP_CORP = 1000035;

function configOf(env) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_WAR_CONTRACTS_ENABLED: "1", ...env } });
  assert.ok(r.ok, JSON.stringify(r.errors));
  return r.config;
}

function tx(store, fn) {
  const r = store.transaction("test", fn);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

function fakeAdapter() {
  const receipts = new Map();
  const credits = [];
  const calls = [];
  const fail = { isk: new Map(), lp: new Map(), std: new Map() };
  const adapter = {
    rewardSeams: () => ({ ok: true }),
    checkStandingWrite: () => ({ ok: true }),
    async rewardCreditIsk(spec) {
      calls.push(["isk", spec]);
      if (fail.isk.has(spec.characterId)) return fail.isk.get(spec.characterId);
      if (receipts.has(spec.commandId)) return { ok: true, duplicate: true, fingerprintMismatch: false };
      receipts.set(spec.commandId, spec);
      credits.push(spec.commandId);
      return { ok: true, duplicate: false, fingerprintMismatch: false };
    },
    rewardCreditLp(spec) {
      calls.push(["lp", spec]);
      if (fail.lp.has(spec.characterId)) return fail.lp.get(spec.characterId);
      if (receipts.has(spec.commandId)) return { ok: true, duplicate: true };
      receipts.set(spec.commandId, spec);
      credits.push(spec.commandId);
      return { ok: true, duplicate: false };
    },
    applyStandingGrant(grant, data) {
      calls.push(["std", grant, data]);
      if (fail.std.has(grant.characterId)) return fail.std.get(grant.characterId);
      if (receipts.has(grant.key)) return { ok: true, outcome: "DUPLICATE", previousStanding: 0, standing: 0 };
      receipts.set(grant.key, grant);
      credits.push(grant.key);
      return { ok: true, outcome: "APPLIED", previousStanding: 0, standing: grant.rawChange };
    },
  };
  return { adapter, credits, calls, fail };
}

function seedRow(store, offerId, settle) {
  const repo = createWarContractRepository();
  tx(store, (db) => {
    const ins = repo.insertOpenInTx(db, { offerId, factionId: CALDARI, stationId: "npc-1", systemId: S1,
      itemKind: "hull", itemKey: `type:${offerId}`, typeId: 621, quantity: 4, iskTotal: 50000000,
      lpCorporationId: LP_CORP, iskAmount: 0, lpAmount: 1500, standingMicro: 10000,
      description: `Living New Eden: war contract 4x type 621 for Faction ${CALDARI}`, at: settle.at });
    assert.ok(ins.ok, JSON.stringify(ins));
    const s = repo.settleInTx(db, { offerId, expectedVersion: 1, ...settle });
    assert.deepStrictEqual(s, { ok: true, changed: true });
  });
}

const AWARD = (characterId, at, legs = { isk: "SKIPPED", lp: "PENDING", std: "PENDING" }, payoutState = "PENDING") =>
  ({ to: "AWARDED", characterId, legs, payoutState, at });

const rowsOf = (store) => tx(store, (db) => db.prepare(`SELECT offer_id AS id, state, isk_state AS i, lp_state AS l,
  std_state AS s, payout_state AS p, attempts AS a, next_attempt_at AS n, ended_at AS e FROM world_war_contracts
  ORDER BY offer_id`).all());

function boot(store, adapter, env = {}, opts = {}) {
  const names = [];
  const spy = { limits: store.limits, transaction: (name, fn) => {
    names.push(name);
    return opts.transaction ? opts.transaction(name, fn) : store.transaction(name, fn);
  } };
  const lines = [];
  const started = startWarContracts({ config: configOf(env), ctx: { persistence: { ok: true, store: spy } },
    clock: { now: () => (opts.now ? opts.now() : AT) }, adapter, logger: { log: (l) => lines.push(l) },
    setTimer: () => ({ cancel() {}, hasRef: () => false }) });
  assert.ok(started.ok, JSON.stringify(started));
  return { wc: started.warContracts, names, lines };
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("WP1 AWARDED LP + standing -> PAID with ended_at; keys lne:wc:<id>:lp|std, WAR_CONTRACT, event 486, ISK "
    + "SKIPPED; tx warContracts.payoutRead / payoutMark; LEG / PAYOUT = frontJobs states", () =>
    H.withStore(driver, async (reopen) => {
      const { store } = reopen();
      seedRow(store, "to_a", AWARD(9001, AT));
      const { adapter, calls, credits } = fakeAdapter();
      const { wc, names } = boot(store, adapter);
      const summary = await wc.payoutPass(AT);
      assert.deepStrictEqual([summary.outcome, summary.paid, summary.failed], ["DONE", 1, 0]);
      assert.deepStrictEqual(rowsOf(store).map((r) => [r.id, r.state, r.i, r.l, r.s, r.p, r.e]),
        [["to_a", "AWARDED", "SKIPPED", "DONE", "DONE", "PAID", AT]]);
      assert.deepStrictEqual(calls.map((c) => c[0]), ["lp", "std"], "ISK SKIPPED: no ISK call");
      assert.deepStrictEqual(calls[0][1], { characterId: 9001, amountLp: 1500, issuerCorporationId: LP_CORP,
        commandId: "lne:wc:to_a:lp" });
      assert.deepStrictEqual(calls[1][1], { key: "lne:wc:to_a:std", characterId: 9001, factionId: CALDARI,
        rawChange: 0.01, reason: "WAR_CONTRACT" });
      assert.deepStrictEqual(calls[1][2], { eventTypeId: 486,
        msgByReason: { WAR_CONTRACT: "War contract (Living New Eden)" } });
      assert.deepStrictEqual(credits, ["lne:wc:to_a:lp", "lne:wc:to_a:std"]);
      assert.ok(names.includes("warContracts.payoutRead") && names.includes("warContracts.payoutMark")
        && names.includes("warContracts.prune"), names.join(","));
      assert.ok(!names.some((n) => n.startsWith("frontJobs.")), names.join(","));
      const st = wc.getStatus();
      assert.deepStrictEqual([st.counters.payoutsPaid, st.payout.passes, st.payout.seamsMissing], [1, 1, false]);
      assert.deepStrictEqual([{ ...WS.LEG }, { ...WS.PAYOUT }], [{ ...FS.LEG_STATE }, { ...FS.ROW_STATE }]);
      await wc.payoutPass(AT + 1000);
      assert.strictEqual(calls.length, 2, "a PAID row never returns to the pump");
      wc.stop("test");
    }));

  needsDriver("WP2 crash before the marker -> PENDING; next pass = vendor duplicates -> PAID once; transient leg -> "
    + "attempts 1 and the base backoff", () =>
    H.withStore(driver, async (reopen) => {
      const { store } = reopen();
      seedRow(store, "to_a", AWARD(9001, AT));
      const { adapter, credits, fail } = fakeAdapter();
      let crashes = 1;
      const transaction = (name, fn) => (name === "warContracts.payoutMark" && crashes-- > 0
        ? store.transaction(name, () => { throw new Error("crash before the marker"); })
        : store.transaction(name, fn));
      let now = AT;
      const { wc } = boot(store, adapter, {}, { transaction, now: () => now });
      const first = await wc.payoutPass(AT);
      assert.deepStrictEqual([first.paid, first.markFailed], [0, 1]);
      assert.deepStrictEqual(rowsOf(store).map((r) => [r.p, r.l, r.s, r.a]), [["PENDING", "PENDING", "PENDING", 0]]);
      now = AT + 1;
      const second = await wc.payoutPass(AT + 1);
      assert.strictEqual(second.paid, 1);
      assert.deepStrictEqual(rowsOf(store).map((r) => [r.p, r.l, r.s]), [["PAID", "DONE", "DONE"]]);
      assert.deepStrictEqual(credits, ["lne:wc:to_a:lp", "lne:wc:to_a:std"], "one credit per key");
      assert.strictEqual(wc.getStatus().counters.legDuplicates, 2);

      seedRow(store, "to_b", AWARD(9002, AT + 2));
      fail.lp.set(9002, { ok: false, reason: "LP_AMBIGUOUS", permanent: false, detail: "LP_WALLET_FLUSH_FAILED" });
      const third = await wc.payoutPass(AT + 2);
      assert.deepStrictEqual([third.retries, third.paid], [1, 0]);
      const b = rowsOf(store).find((r) => r.id === "to_b");
      assert.deepStrictEqual([b.p, b.l, b.s, b.a, b.n, b.e], ["PENDING", "PENDING", "DONE", 1, AT + 2 + 60000, null]);
      assert.strictEqual(wc.getStatus().counters.legRetries, 1);
      wc.stop("test");
    }));

  needsDriver("WP3 prune: old LAPSED and old PAID go, old AWARDED PENDING and fresh PAID stay "
    + "NO_CHARACTER_ACCEPTOR", () =>
    H.withStore(driver, async (reopen) => {
      const { store } = reopen();
      const old = AT - 2 * DAY;
      seedRow(store, "to_lapsed_old", { to: "LAPSED", reason: "EXPIRED", at: old });
      seedRow(store, "to_pending_old", AWARD(9001, old));
      seedRow(store, "to_paid_fresh", AWARD(9002, AT - 1000, { isk: "SKIPPED", lp: "SKIPPED", std: "SKIPPED" }, "PAID"));
      seedRow(store, "to_paid_old", AWARD(9003, old, { isk: "SKIPPED", lp: "SKIPPED", std: "SKIPPED" }, "PAID"));
      const { wc } = boot(store, null, { EVEJS_LNE_WAR_CONTRACTS_RETENTION_MS: String(DAY),
        EVEJS_LNE_WAR_CONTRACTS_ADOPT_LATE_MS: String(DAY / 2) });
      const s = await wc.payoutPass(AT);
      assert.deepStrictEqual([s.outcome, s.pruned], ["SEAMS_MISSING", 2]);
      assert.deepStrictEqual(rowsOf(store).map((r) => [r.id, r.p]), [["to_paid_fresh", "PAID"],
        ["to_pending_old", "PENDING"]]);
      assert.strictEqual(wc.getStatus().counters.pruned, 2);
      wc.stop("test");

      const row = { iskAmount: 0, lpAmount: 1500, lpCorporationId: LP_CORP, standingMicro: 10000 };
      const opts = { awardsInWindow: 0, maxAwards: 10, tradeStandingGrant: false };
      for (const state of ["ACCEPTED", "INTAKE", "DELIVERED", "LOST"]) {
        assert.deepStrictEqual(decideSettle(row, { state, acceptorCharacterId: null, endReason: null }, opts),
          { action: "LAPSE", reason: "NO_CHARACTER_ACCEPTOR" }, state);
      }
      assert.deepStrictEqual(decideSettle(row, { state: "CANCELLED", endReason: "EXPIRED" }, opts),
        { action: "LAPSE", reason: "EXPIRED" }, "other ends unchanged");
      assert.ok(WS.END_REASON_NO_CHARACTER.length <= WS.MAX_END_REASON);
    }));

  test("WP4 pump labels: none -> tx frontJobs.*, warContracts labels -> warContracts.*; invalid -> defaults + one log",
    async () => {
      const run = async (labels) => {
        const names = [];
        const lines = [];
        const store = { limits: { maxRowsPerTransaction: 1000 }, transaction: (name, fn) => {
          names.push(name);
          return { ok: true, value: fn({}) };
        } };
        const repo = {
          listDuePayoutsInTx: () => ({ ok: true, rows: [{ payoutKey: "k:1", characterId: 9001, issuerFactionId: CALDARI,
            systemId: S1, lpCorporationId: LP_CORP, iskAmount: 5, lpAmount: 0, standingMicro: 1000, description: "d",
            iskState: "PENDING", lpState: "SKIPPED", stdState: "PENDING", attempts: 0, nextAttemptAt: AT }] }),
          markPayoutInTx: () => ({ ok: true, changed: true }),
          pruneInTx: () => ({ ok: true, progress: 0, jobs: 0, payouts: 0 }),
        };
        const { adapter, calls } = fakeAdapter();
        const pump = createPayoutPump({ store, repo, adapter, labels, log: (l) => lines.push(l),
          params: { payoutEnabled: true, payoutMaxPerPass: 5, payoutMaxAttempts: 3, payoutRetryBaseMs: 1000,
            payoutRetryMaxMs: 60000, retentionMs: DAY, payoutRetentionMs: DAY, prunePerPass: 10 },
          count: () => {}, isStopped: () => false });
        const s = await pump.runPass(AT);
        assert.strictEqual(s.paid, 1);
        return { names, lines, isk: calls.find((c) => c[0] === "isk")[1], std: calls.find((c) => c[0] === "std") };
      };
      const plain = await run(undefined);
      assert.deepStrictEqual(plain.names, ["frontJobs.payoutRead", "frontJobs.payoutMark", "frontJobs.prune"]);
      assert.deepStrictEqual([plain.isk.source, plain.std[1].reason, plain.std[2].msgByReason],
        ["lne-frontjobs", "FRONT_JOB", { FRONT_JOB: "Front job (Living New Eden)" }]);
      assert.deepStrictEqual(plain.lines, []);
      const data = require("../../lib/warContracts/data");
      const war = await run({ txPrefix: "warContracts", standingReason: data.STANDING_REASON,
        standingData: data.STANDING_DATA, iskSource: data.ISK_SOURCE });
      assert.deepStrictEqual(war.names, ["warContracts.payoutRead", "warContracts.payoutMark", "warContracts.prune"]);
      assert.deepStrictEqual([war.isk.source, war.std[1].reason, war.std[2]], ["lne-warcontracts", "WAR_CONTRACT",
        data.STANDING_DATA]);
      const bad = await run({ txPrefix: "", standingReason: "WAR_CONTRACT" });
      assert.deepStrictEqual([bad.names[0], bad.std[1].reason, bad.lines],
        ["frontJobs.payoutRead", "FRONT_JOB", ["payout labels invalid - the front job labels are used"]]);
    });
};
