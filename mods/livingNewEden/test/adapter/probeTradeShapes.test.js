"use strict";

const assert = require("node:assert");

const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const { probeModules, formatProbeLog } = require("../../lib/adapter/probe");

function noop() {}

class MarketDaemonClient {
  call() { return null; }
}

const VENDOR_LIKE = Object.freeze({
  "services/contracts/contractRuntimeState": {
    createContract: noop, getContractRecord: noop, deleteContract: noop, listContractRecords: noop,
    CONTRACT_STATUS: Object.freeze({ OUTSTANDING: 0, FINISHED: 4, DELETED: 7 }),
    TABLE: "contractRuntime",
    completeContract: noop,
  },
  "services/inventory/itemStore": {
    listContainerItems: noop, getItemMetadata: noop, ITEM_FLAGS: { HANGAR: 4, CORP_DELIVERIES: 62 },
    grantItemToOwnerLocationIdempotent: noop, getIdempotentGrantReceipt: noop,
    pruneIdempotentGrantReceipts: noop,
    consumeInventoryItemQuantityIdempotent: noop,
    findItemById: noop, isCapsuleTypeID: noop,
    listStarbaseItems: noop,
    updateInventoryItem: noop,
    removeInventoryItem: noop,
    listOwnedItems: noop,
  },
  "services/inventory/itemCustody": {
    transfer: noop, getCommittedReceipt: noop,
    CUSTODY_REASON: Object.freeze({ INDUSTRY_MATERIAL_COMMIT: "industry_material_commit" }),
    custodyRef: Object.freeze({ ownerLocation: noop, void: noop }),
  },
  "services/market/marketDaemonClient": { marketDaemonClient: new MarketDaemonClient() },
});

module.exports = ({ test }) => {
  test("TP1 probe: trade seams with v0.12.9 shapes (object constants / instance) -> 0 drift, trade not disabled", () => {
    const table = GAME_MODULES.filter((m) => Object.prototype.hasOwnProperty.call(VENDOR_LIKE, m.path));
    assert.strictEqual(table.length, 4, "the four trade modules are in GAME_MODULES");
    const report = probeModules(table, { load: (p) => ({ ok: true, exports: VENDOR_LIKE[p] }) });
    assert.deepStrictEqual(report.counts, { ok: 4, drift: 0, missing: 0 }, formatProbeLog(report).join(" | "));
    assert.strictEqual(report.passed, true);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(report.disabledModules, "trade"), false);
  });
};
