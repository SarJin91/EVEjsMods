"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const { createAdapter } = require("../../lib/adapter");
const { MODULE_NAMES } = require("../../config");

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const CONSUMER = "freeCorpsContracts";
const SEAMS = Object.freeze({
  "services/contracts/contractRuntimeState": ["createContract", "getContractRecord", "deleteContract",
    "listContractRecords", "CONTRACT_STATUS"],
  "services/contracts/contractSettlementState": ["getPendingContractSettlement", "listPendingContractSettlements"],
  "services/contracts/contractNotifications": ["notifyContractAccepted"],
  "services/inventory/itemStore": ["grantItemToOwnerLocationIdempotent", "getIdempotentGrantReceipt",
    "listContainerItems", "ITEM_FLAGS"],
  "services/inventory/itemCustody": ["transfer", "CUSTODY_REASON", "getCommittedReceipt", "custodyRef"],
  "services/inventory/itemTypeRegistry": ["resolveItemByTypeID"],
});
const PUMP_METHODS = Object.freeze(["tradeFindContract", "tradeReadContract", "tradeDeleteContract", "tradeGrantStock",
  "tradeGrantReceipt", "tradeCreateSellContract", "tradeListDeliveredStacks", "tradeVoidStack", "readItemTypeFacts",
  "freeCorpsContractSeams", "addContractAcceptedListener"]);

const readSource = (rel) => fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");

module.exports = ({ test }) => {
  test("CT1 vendor facts, GAME_MODULES consumer freeCorpsContracts, accept fan-out with the trade hook, facade "
    + "methods, blind adapter", () => {
    const src = readSource("services/contracts/contractRuntimeState.js");
    assert.ok(src.includes("contractNotifications.notifyContractAccepted(next, preferredSession)"),
      "accept notification through the module object with the record");
    assert.ok(src.includes("Expiry changes their eligibility only"), "expiry returns nothing (the mod deletes)");
    const flag = src.slice(src.indexOf("function getOwnerDeliveryFlag(forCorp"));
    assert.ok(/^function getOwnerDeliveryFlag\(forCorp\) \{\n {2}return forCorp \? ITEM_FLAGS\.CORP_DELIVERIES : ITEM_FLAGS\.HANGAR;/
      .test(flag), "character delivery flag = HANGAR");
    const get = src.slice(src.indexOf("function getContractRecord(contractID) {"));
    assert.ok(get.slice(0, 400).includes("repo.read(TABLE, `/${String(normalizedContractID)}`)"), "one record by id");
    assert.ok(src.includes("const NUM_CONTRACTS_BY_SKILL = Object.freeze([1, 5, 9, 13, 17, 21]);"));
    assert.ok(src.includes("const NUM_CONTRACTS_BY_SKILL_CORP = Object.freeze([10, 20, 30, 40, 50, 60]);"));
    const limit = src.slice(src.indexOf("function assertOutstandingContractLimit(info, session) {"));
    assert.ok(limit.slice(0, 2200).includes("throwContractUserError(\"ConTooManyContractsMax\""), "the limit throws");
    assert.ok(src.includes("\n  assertOutstandingContractLimit(info, session);\n"), "called by the create");

    assert.ok(!MODULE_NAMES.includes(CONSUMER), "freeCorpsContracts is not a module name");
    for (const [rel, names] of Object.entries(SEAMS)) {
      const entry = GAME_MODULES.find((e) => e.path === rel);
      assert.ok(entry, rel);
      for (const name of names) {
        const s = entry.symbols.find((x) => x.name === name);
        assert.ok(s && s.consumers.includes(CONSUMER), `${rel}.${name} has ${CONSUMER}`);
        assert.ok(s.firstLoad !== true, `${rel}.${name} no first-load`);
        assert.strictEqual(s.wrap === true, name === "notifyContractAccepted", `${rel}.${name} wrap unchanged`);
      }
    }

    const notifications = { notifyContractAccepted(contract) { return contract && contract.contractID ? 1 : 0; } };
    const original = notifications.notifyContractAccepted;
    const abs = path.join(SERVER_SRC, "services/contracts/contractNotifications.js");
    const adapter = createAdapter({ moduleApi: { _cache: {} }, existsSync: () => true,
      requireFn: (p) => (p === abs ? notifications : {}) });
    adapter.setServerSrc(SERVER_SRC);
    adapter.markBooted();
    const got = [];
    const nudges = [];
    assert.strictEqual(adapter.addContractAcceptedListener({ name: "x", tagPrefix: "fcc:", fn() {} }).reason,
      "INVALID_LISTENER");
    const l = adapter.addContractAcceptedListener({ name: "freeCorps", tagPrefix: "[LNE:fcc:",
      fn: (id) => got.push(id) });
    assert.strictEqual(l.ok, true);
    assert.strictEqual(adapter.addContractAcceptedListener({ name: "freeCorps", tagPrefix: "[LNE:fcc:", fn() {} }).reason,
      "LISTENER_EXISTS");
    assert.notStrictEqual(notifications.notifyContractAccepted, original, "the listener installs the wrap");
    assert.deepStrictEqual(adapter.setTradeNudge((...args) => nudges.push(args)), { ok: true });
    assert.deepStrictEqual(adapter.installTradeHooks(), { ok: true }, "trade after a listener");
    assert.deepStrictEqual(adapter.installTradeHooks(), { ok: false, reason: "HOOK_ALREADY_INSTALLED" });
    assert.strictEqual(notifications.notifyContractAccepted({ contractID: 7, description: "x [LNE:fcc:3:4]" }, null), 1);
    assert.strictEqual(notifications.notifyContractAccepted({ contractID: 8, description: "[LNE:to_9] buy" }, null), 1);
    assert.strictEqual(notifications.notifyContractAccepted({ contractID: 9, description: "player" }, null), 1);
    assert.deepStrictEqual(got, [7], "the listener only for its tag");
    assert.deepStrictEqual(nudges, [[], []], "the trade nudge for every [LNE: record, without arguments");
    assert.deepStrictEqual(adapter.uninstallTradeHooks(), { ok: true });
    assert.notStrictEqual(notifications.notifyContractAccepted, original, "a live listener keeps the wrap");
    notifications.notifyContractAccepted({ contractID: 10, description: "[LNE:fcc:1:1]" });
    assert.deepStrictEqual([got, nudges.length], [[7, 10], 2], "trade off, the listener still called");
    const t = adapter.addContractAcceptedListener({ name: "thrower", tagPrefix: "[LNE:fcc:",
      fn: () => { throw new Error("boom"); } });
    assert.strictEqual(notifications.notifyContractAccepted({ contractID: 11, description: "[LNE:fcc:2:2]" }), 1,
      "a throwing listener does not change the result");
    assert.deepStrictEqual(got, [7, 10, 11]);
    t.remove();
    l.remove();
    assert.strictEqual(notifications.notifyContractAccepted, original, "the last remove takes the wrap off");

    const facade = createAdapter({ moduleApi: { _cache: {} } });
    for (const name of PUMP_METHODS) assert.strictEqual(typeof facade[name], "function", name);
    assert.strictEqual(facade.freeCorpsContractSeams().ok, false, "blind: seams refused");
    assert.strictEqual(facade.freeCorpsContractSeams().reason, "SEAM_UNAVAILABLE");
    assert.strictEqual(facade.addContractAcceptedListener({ name: "a", tagPrefix: "[LNE:fcc:", fn() {} }).ok, false,
      "blind: no hook");
  });
};
