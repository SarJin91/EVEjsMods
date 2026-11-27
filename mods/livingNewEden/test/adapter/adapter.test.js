"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { probeModules, formatProbeLog } = require("../../lib/adapter/probe");
const { findServerSrcInCache } = require("../../lib/adapter/locator");
const { createAdapter } = require("../../lib/adapter");

const ROOT = path.join(path.sep, "x", "server");
const SRC = path.join(ROOT, "src");

function sym(name, kind, consumers = ["graph"]) {
  return { name, kind, consumers, phase: "test" };
}

function runtimeLikeExports() {
  class SpaceRuntime {
    constructor() { this.scenes = new Map(); }
  }
  Object.defineProperty(SpaceRuntime.prototype, "attachSession", {
    value() {}, enumerable: false, writable: true, configurable: true,
  });
  const runtimeExports = {};
  const singleton = new SpaceRuntime();
  Object.setPrototypeOf(runtimeExports, Object.getPrototypeOf(singleton));
  Object.assign(runtimeExports, singleton);
  return runtimeExports;
}

module.exports = ({ test }) => {
  test("A1 probe: ok, DRIFT with name, MISSING, throwing load, prototypeMethod; report + summary line", () => {
    const table = [
      { path: "a/full", symbols: [sym("f", "export"), sym("flag", "property")] },
      { path: "a/drift", symbols: [sym("f", "export"), sym("x", "export")] },
      { path: "a/gone", symbols: [sym("f", "export", ["sites"])] },
      { path: "a/throws", symbols: [sym("f", "export", ["events"])] },
    ];
    const loads = {
      "a/full": () => ({ ok: true, exports: { f() {}, flag: false } }),
      "a/drift": () => ({ ok: true, exports: { f() {} } }),
      "a/gone": () => ({ ok: false, reason: "file_not_found" }),
      "a/throws": () => { throw new Error("boom"); },
    };
    const report = probeModules(table, { load: (p) => loads[p]() });
    assert.deepStrictEqual(report.modules.map((m) => [m.path, m.status, m.missing]), [
      ["a/full", "ok", []],
      ["a/drift", "DRIFT", ["x"]],
      ["a/gone", "MISSING", ["f"]],
      ["a/throws", "MISSING", ["f"]],
    ]);
    assert.strictEqual(report.passed, false);
    assert.strictEqual(report.disabledModules.graph, "drift:a/drift.x");
    assert.strictEqual(report.modules[2].reason, "file_not_found");
    assert.ok(report.modules[3].reason.startsWith("require_failed:"), report.modules[3].reason);
    assert.strictEqual(formatProbeLog(report)[0], "probe failed (1 ok, 1 drift, 2 missing)");

    const exportsObj = runtimeLikeExports();
    const proto = probeModules([{ path: "space/runtime", symbols: [sym("attachSession", "prototypeMethod"),
      sym("scenes", "property")] }], { load: () => ({ ok: true, exports: exportsObj }) });
    assert.strictEqual(proto.modules[0].status, "ok");
    assert.strictEqual(proto.passed, true);
    const asExport = probeModules([{ path: "space/runtime", symbols: [sym("attachSession", "export")] }],
      { load: () => ({ ok: true, exports: exportsObj }) });
    assert.strictEqual(asExport.modules[0].status, "DRIFT", "prototype method is not an own export");
  });

  test("A1c probe classPrototypeMethod: class method yes, static method and object no", () => {
    class Service {
      Handle_CmdDock() { return null; }
      static Handle_Static() { return null; }
    }
    const probe = (exportsObject, name) => probeModules([{ path: "services/ship/beyonceService",
      symbols: [sym(name, "classPrototypeMethod", ["loyaltyDock"])] }], { load: () => ({ ok: true, exports: exportsObject }) })
      .modules[0].status;
    assert.strictEqual(probe(Service, "Handle_CmdDock"), "ok");
    assert.strictEqual(probe(Service, "Handle_Static"), "DRIFT", "static method is not on the prototype");
    assert.strictEqual(probe({ Handle_CmdDock() {} }, "Handle_CmdDock"), "DRIFT", "an object is not a class");
  });

  test("A2 locator + requireGame: cache walk, whitelist, not_booted before boot, no serverSrc", () => {
    const cache = { [path.join(SRC, "gameStore", "index.js")]: { exports: { _processRole: "world" } } };
    const readiness = path.join(SRC, "services", "exploration", "wormholes", "wormholeRuntimeState.js");
    assert.deepStrictEqual(findServerSrcInCache(cache, readiness, 6).srcDir, SRC);
    assert.deepStrictEqual(findServerSrcInCache(cache, path.join(ROOT, "bootstrap.js"), 6).srcDir, SRC);
    assert.deepStrictEqual(findServerSrcInCache(cache, readiness, 1), { ok: false, reason: "gamestore_not_cached" });

    const required = [];
    const moduleApi = { _cache: { [path.join(SRC, "a", "cached.js")]: { exports: { f() {} } } } };
    const gameModules = [
      { path: "a/cached", symbols: [sym("f", "export")] },
      { path: "a/lazy", symbols: [sym("f", "export")] },
    ];
    const adapter = createAdapter({
      moduleApi, gameModules, existsSync: () => true,
      requireFn: (abs) => { required.push(abs); return { f() {} }; },
    });
    assert.strictEqual(adapter.requireGame("a/cached").reason, "server_src_unknown");
    assert.deepStrictEqual(adapter.setServerSrc(SRC), { ok: true, reason: null });
    assert.deepStrictEqual(adapter.setServerSrc(ROOT), { ok: false, reason: "server_src_already_set" });
    assert.strictEqual(adapter.requireGame("gameStore/index").reason, "not_in_game_modules");
    assert.strictEqual(adapter.requireGame("a/cached").ok, true, "cache is available before boot");
    assert.strictEqual(adapter.requireGame("a/lazy").reason, "not_booted");
    assert.deepStrictEqual(required, [], "requireFn untouched before boot");
    adapter.markBooted();
    assert.strictEqual(adapter.requireGame("a/lazy").ok, true);
    assert.deepStrictEqual(required, [path.join(SRC, "a", "lazy.js")]);

    const blind = createAdapter({ moduleApi: { _cache: {} }, gameModules });
    const report = blind.runProbe();
    assert.strictEqual(report.error, "server_src_not_found");
    assert.strictEqual(report.passed, false);
    assert.deepStrictEqual(report.modules, []);
    assert.deepStrictEqual(blind.getDisabledModules(), { graph: "server_src_not_found" });
    assert.ok(Object.isFrozen(blind.getProbeReport()), "report frozen");
  });

  test("A3 checkTradeSeams on v0.12.9 vendor shapes: frozen constants, plain ITEM_FLAGS, daemon instance -> ok", () => {
    const f = () => {};
    class MarketDaemonClient { async call() { return null; } }
    const vendor = {
      "services/contracts/contractRuntimeState": {
        createContract: f, getContractRecord: f, deleteContract: f, listContractRecords: f,
        CONTRACT_STATUS: Object.freeze({ OUTSTANDING: 0 }),
      },
      "services/contracts/contractSettlementState": {
        listPendingContractSettlements: f, findPendingContractSettlement: f, getPendingContractSettlement: f,
      },
      "services/corporation/corpWalletState": { adjustCorporationWalletDivisionBalanceAsync: f, getCorporationWallet: f },
      "services/corporation/corporationRuntimeState": { getCorporationRuntime: f },
      "services/corporation/corporationState": { getCorporationRecord: f },
      "services/inventory/itemStore": { listContainerItems: f, ITEM_FLAGS: { HANGAR: 4, CORP_DELIVERIES: 62 } },
      "services/inventory/itemCustody": {
        transfer: f, getCommittedReceipt: f,
        CUSTODY_REASON: Object.freeze({ CONTRACT: "contract" }),
        custodyRef: Object.freeze({ ownerLocation() {}, void() {} }),
      },
      "services/market/marketDaemonClient": { MarketDaemonClient, marketDaemonClient: new MarketDaemonClient() },
      "services/industry/industryPricing": { resolveAdjustedAverageTypePrice: f },
    };
    const byAbs = {};
    for (const rel of Object.keys(vendor)) byAbs[path.join(SRC, `${rel}.js`)] = vendor[rel];
    const make = (exportsByAbs) => {
      const adapter = createAdapter({
        moduleApi: { _cache: {} }, existsSync: () => true,
        requireFn: (abs) => exportsByAbs[abs] || {},
      });
      adapter.setServerSrc(SRC);
      adapter.markBooted();
      return adapter;
    };
    assert.deepStrictEqual(make(byAbs).checkTradeSeams(), { ok: true });

    const broken = { ...byAbs };
    const runtimeAbs = path.join(SRC, "services/contracts/contractRuntimeState.js");
    broken[runtimeAbs] = { ...vendor["services/contracts/contractRuntimeState"], createContract: {}, CONTRACT_STATUS: undefined };
    const refused = make(broken).checkTradeSeams();
    assert.strictEqual(refused.reason, "TRADE_SEAM_UNAVAILABLE");
    assert.deepStrictEqual(refused.missing, [
      "services/contracts/contractRuntimeState.createContract",
      "services/contracts/contractRuntimeState.CONTRACT_STATUS",
    ]);

    const noPending = { ...byAbs };
    const settlementAbs = path.join(SRC, "services/contracts/contractSettlementState.js");
    noPending[settlementAbs] = { ...vendor["services/contracts/contractSettlementState"], getPendingContractSettlement: undefined };
    const refusedPending = make(noPending).checkTradeSeams();
    assert.strictEqual(refusedPending.reason, "TRADE_SEAM_UNAVAILABLE");
    assert.deepStrictEqual(refusedPending.missing, ["services/contracts/contractSettlementState.getPendingContractSettlement"]);
  });

  test("A4 /2/6 installTradeHooks on the vendor signature: notifyContractAccepted(record, session) -> nudge only for [LNE, result unchanged; uninstall clears", () => {
    const notifications = { notifyContractAccepted(contract, _sourceSession = null) { return contract && contract.contractID ? 1 : 0; } };
    const original = notifications.notifyContractAccepted;
    const abs = path.join(SRC, "services/contracts/contractNotifications.js");
    const adapter = createAdapter({ moduleApi: { _cache: {} }, existsSync: () => true,
      requireFn: (p) => (p === abs ? notifications : {}) });
    adapter.setServerSrc(SRC);
    adapter.markBooted();
    assert.deepStrictEqual(adapter.installTradeHooks(), { ok: false, reason: "NUDGE_NOT_SET" });
    let nudges = 0;
    assert.deepStrictEqual(adapter.setTradeNudge(() => { nudges += 1; }), { ok: true });
    assert.deepStrictEqual(adapter.installTradeHooks(), { ok: true });
    assert.strictEqual(notifications.notifyContractAccepted({ contractID: 5, description: "[LNE:to_9] buy" }, { id: 1 }), 1);
    assert.strictEqual(nudges, 1, "LNE contract nudges");
    assert.strictEqual(notifications.notifyContractAccepted({ contractID: 6, description: "player" }, null), 1);
    assert.strictEqual(nudges, 1, "other contract does not nudge");
    assert.deepStrictEqual(adapter.uninstallTradeHooks(), { ok: true });
    assert.strictEqual(notifications.notifyContractAccepted, original, "original restored");
    assert.deepStrictEqual(adapter.installTradeHooks(), { ok: false, reason: "NUDGE_NOT_SET" }, "uninstall clears the nudge");
  });

  test("A5 tradeReadWallet reads wallet.divisions[accountKey]; no wallet/division or { balance } shape -> null", () => {
    const CORP = 98000001;
    let wallet = {
      divisions: { 1005: { key: 1005, name: "", balance: 1234.5 }, 1006: { key: 1006, name: "", balance: 900 } },
      lpBalance: 0, billBalance: 0, authorityReceipts: [],
    };
    const getCorporationWallet = (id) => (id === CORP && wallet ? JSON.parse(JSON.stringify(wallet)) : null);
    const corpWalletState = {
      getCorporationWallet,
      getCorporationWalletDivision(id, accountKey = 1000) {
        const w = getCorporationWallet(id);
        if (!w || !w.divisions || !w.divisions[String(accountKey)]) return null;
        return { ...w.divisions[String(accountKey)] };
      },
      getCorporationWalletBalance(id, accountKey = 1000) {
        const division = this.getCorporationWalletDivision(id, accountKey);
        return division ? Number(division.balance) || 0 : 0;
      },
      adjustCorporationWalletDivisionBalanceAsync: async () => ({ success: true }),
    };
    const abs = path.join(SRC, "services/corporation/corpWalletState.js");
    const adapter = createAdapter({ moduleApi: { _cache: {} }, existsSync: () => true,
      requireFn: (p) => (p === abs ? corpWalletState : {}) });
    adapter.setServerSrc(SRC);
    adapter.markBooted();
    assert.deepStrictEqual(adapter.tradeReadWallet(CORP, 1005), { ok: true, balanceIsk: 1234.5 });
    assert.deepStrictEqual(adapter.tradeReadWallet(CORP, 1006), { ok: true, balanceIsk: 900 });
    assert.deepStrictEqual(adapter.tradeReadWallet(CORP, 1003), { ok: true, balanceIsk: null }, "missing division");
    assert.deepStrictEqual(adapter.tradeReadWallet(CORP + 1, 1006), { ok: true, balanceIsk: null }, "no wallet");
    wallet = { balance: 1000000000 };
    assert.deepStrictEqual(adapter.tradeReadWallet(CORP, 1006), { ok: true, balanceIsk: null }, "{ balance } is not the vendor shape");
  });

  test("A6-VC-NOTE1 virtualIdentityExists: corporation found by foundingOperationID (no lneIdentityKey) -> found:true with corporationID", () => {
    const CORP_ID = 2000001;
    const FOUNDING_OP = "lne:v1:f:500019:corp:0";
    const corporationState = {
      findCorporationByFoundingOperationID: (foundingOperationID) => {
        if (foundingOperationID === FOUNDING_OP) {
          return { corporationID: CORP_ID, corporationName: "Test Corp", tickerName: "TSTC", foundingOperationID: FOUNDING_OP, allianceID: 0 };
        }
        return null;
      },
    };
    const byAbs = {
      [path.join(SRC, "services/corporation/corporationState.js")]: corporationState,
    };
    const adapter = createAdapter({
      moduleApi: { _cache: {} }, existsSync: () => true,
      requireFn: (abs) => byAbs[abs] || {},
    });
    adapter.setServerSrc(SRC);
    adapter.markBooted();

    const exists = adapter.virtualIdentityExists("corporation", 0, FOUNDING_OP);
    assert.strictEqual(exists.ok, true, "should succeed");
    assert.strictEqual(exists.found, true, "should be found");
    assert.strictEqual(exists.corporationId, CORP_ID, "should return correct corporationID");
    assert.ok(exists.record, "should return record");
    assert.strictEqual(exists.record.corporationID, CORP_ID);
    assert.strictEqual(exists.record.foundingOperationID, FOUNDING_OP);

    const notFound = adapter.virtualIdentityExists("corporation", 0, "lne:v1:f:500019:corp:99");
    assert.strictEqual(notFound.ok, true, "should succeed");
    assert.strictEqual(notFound.found, false, "should not be found");

    const noFO = adapter.virtualIdentityExists("corporation", 0, "");
    assert.strictEqual(noFO.ok, false, "should fail without foundingOp");
    assert.ok(noFO.reason.includes("foundingOp_required"), "reason should mention foundingOp required");
  });

  test("A6-VC-NOTE1 virtualIdentityExists: alliance found by foundingOperationID (no lneIdentityKey) -> found:true with allianceID", () => {
    const ALLIANCE_ID = 3000001;
    const FOUNDING_OP = "lne:v1:f:500019:alliance";
    const corporationState = {
      findAllianceByFoundingOperationID: (foundingOperationID) => {
        if (foundingOperationID === FOUNDING_OP) {
          return { allianceID: ALLIANCE_ID, name: "Test Alliance", shortName: "TSTA", foundingOperationID: FOUNDING_OP, isNPC: false };
        }
        return null;
      },
    };
    const byAbs = {
      [path.join(SRC, "services/corporation/corporationState.js")]: corporationState,
    };
    const adapter = createAdapter({
      moduleApi: { _cache: {} }, existsSync: () => true,
      requireFn: (abs) => byAbs[abs] || {},
    });
    adapter.setServerSrc(SRC);
    adapter.markBooted();

    const exists = adapter.virtualIdentityExists("alliance", 0, FOUNDING_OP);
    assert.strictEqual(exists.ok, true, "should succeed");
    assert.strictEqual(exists.found, true, "should be found");
    assert.strictEqual(exists.allianceId, ALLIANCE_ID, "should return correct allianceID");
    assert.ok(exists.record, "should return record");
    assert.strictEqual(exists.record.allianceID, ALLIANCE_ID);
    assert.strictEqual(exists.record.foundingOperationID, FOUNDING_OP);

    const notFound = adapter.virtualIdentityExists("alliance", 0, "lne:v1:f:500019:alliance:99");
    assert.strictEqual(notFound.ok, true, "should succeed");
    assert.strictEqual(notFound.found, false, "should not be found");

    const noFO = adapter.virtualIdentityExists("alliance", 0, "");
    assert.strictEqual(noFO.ok, false, "should fail without foundingOp");
    assert.ok(noFO.reason.includes("foundingOp_required"), "reason should mention foundingOp required");
  });
};
