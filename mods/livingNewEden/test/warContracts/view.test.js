"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { loadDriver, withStore } = require("../notices/storeHelper");
const { resolveConfig } = require("../../config");
const { startWarContracts } = require("../../lib/warContracts");
const { createWarContractRepository } = require("../../lib/warContracts/repository");
const { buildWarContractsView, VIEW_ID, ROW_KEYS } = require("../../lib/warContracts/view");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const AT = Date.UTC(2026, 10, 16, 12, 0, 0);
const CALDARI = 500001;
const S1 = 30000001;
const repo = createWarContractRepository();

const run = (store, fn) => {
  const r = store.transaction("t", fn);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};

function insertRow(store, offerId, at) {
  run(store, (db) => assert.ok(repo.insertOpenInTx(db, { offerId, factionId: CALDARI, stationId: "npc-1", systemId: S1,
    itemKind: "hull", itemKey: `type:${offerId}`, typeId: 621, quantity: 4, iskTotal: 50000000,
    lpCorporationId: 1000035, iskAmount: 0, lpAmount: 500, standingMicro: 10000, description: `war ${offerId}`, at })
    .ok));
}

function settle(store, s) {
  run(store, (db) => assert.ok(repo.settleInTx(db, { expectedVersion: 1, ...s }).changed));
}

function configOf(env) {
  const r = resolveConfig({ modDir: MOD_DIR, env });
  assert.ok(r.ok, JSON.stringify(r.errors));
  return r.config;
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver.ok) {
    skip("WD2-WD3 war contracts panel", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("WD2 panel: empty -> empty lists and zeros; OPEN / AWARDED / LAPSED corp -> lists, sums, corp-accepted", () => {
    withStore(driver, ({ store }) => {
      let admits = true;
      const view = buildWarContractsView({ store, repo, viewRows: 10, viewSumWindowMs: 604800000, now: () => AT + 60,
        names: { faction: (id) => (id === CALDARI ? "Caldari State" : null) },
        getGovernor: () => ({ admits: () => admits }) });
      assert.deepStrictEqual([view.order, view.listed, view.cacheKey()], [68, true, `w${Math.floor((AT + 60) / 60000)}`]);
      assert.deepStrictEqual(view.getData(), { available: true, open: [], recent: [], sums: [],
        payouts: { pending: 0, failed: 0 }, generatedAt: AT + 60 });
      for (const id of ["to_open", "to_paid", "to_pend", "to_corp"]) insertRow(store, id, AT);
      const legs = { isk: "SKIPPED", lp: "DONE", std: "DONE" };
      settle(store, { offerId: "to_paid", to: "AWARDED", characterId: 9001, legs, payoutState: "PAID", at: AT + 1 });
      settle(store, { offerId: "to_pend", to: "AWARDED", characterId: 9002, legs: { ...legs, lp: "PENDING" },
        payoutState: "PENDING", at: AT + 2 });
      settle(store, { offerId: "to_corp", to: "LAPSED", reason: "NO_CHARACTER_ACCEPTOR", at: AT + 3 });
      const d = view.getData();
      assert.strictEqual(d.available, true);
      assert.deepStrictEqual(d.open.map((r) => r.offerId), ["to_open"]);
      assert.deepStrictEqual(Object.keys(d.open[0]), [...ROW_KEYS]);
      assert.deepStrictEqual([d.open[0].faction, d.open[0].factionId, d.open[0].lp, d.open[0].standing],
        ["Caldari State", CALDARI, 500, 0.01]);
      assert.deepStrictEqual(d.recent.map((r) => [r.offerId, r.state, r.endReason, r.characterId]),
        [["to_corp", "LAPSED", "corp-accepted", null], ["to_paid", "AWARDED", null, 9001]]);
      assert.deepStrictEqual(d.sums, [{ faction: "Caldari State", factionId: CALDARI, awarded: 1, lp: 500,
        standing: 0.01, isk: 0 }]);
      assert.deepStrictEqual(d.payouts, { pending: 1, failed: 0 });
      admits = false;
      assert.deepStrictEqual(view.getData(), { available: false, reason: "GOVERNOR_HOLD" });
    });
  });

  test("WD3 service: panel registered by default; viewEnabled=false / module off -> no registerView; stop -> unregister",
    () => {
      withStore(driver, ({ store }) => {
        const boot = (env) => {
          const calls = { register: [], unregister: 0 };
          const views = { registerView: (id, def) => {
            calls.register.push([id, def.order]);
            return { ok: true, unregister: () => { calls.unregister += 1; } };
          } };
          const started = startWarContracts({ config: configOf(env), ctx: { persistence: { ok: true, store }, views },
            clock: { now: () => AT }, adapter: null, setTimer: () => ({ cancel() {}, hasRef: () => false }) });
          return { started, calls };
        };
        const on = boot({ EVEJS_LNE_WAR_CONTRACTS_ENABLED: "1" });
        assert.ok(on.started.ok, JSON.stringify(on.started));
        assert.deepStrictEqual(on.calls.register, [[VIEW_ID, 68]]);
        on.started.warContracts.stop("test");
        on.started.warContracts.stop("again");
        assert.strictEqual(on.calls.unregister, 1);
        const noView = boot({ EVEJS_LNE_WAR_CONTRACTS_ENABLED: "1", EVEJS_LNE_WAR_CONTRACTS_VIEW_ENABLED: "0" });
        assert.ok(noView.started.ok);
        noView.started.warContracts.stop("test");
        assert.deepStrictEqual([noView.calls.register, noView.calls.unregister], [[], 0]);
        const off = boot({});
        assert.deepStrictEqual([off.started.reason, off.calls.register], ["disabled_by_config", []]);
      });
    });
};
