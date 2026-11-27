"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { openStore } = require("../../lib/persistence/store");
const { createVendorTagStore } = require("../../lib/persistence/vendorTags");
const { attachBuyEscrowFrom, findBuyOrderFrom, detachEscrowFrom } = require("../../lib/adapter/tradeMarket");
const { createTaggedEscrowState } = require("../../lib/adapter/vendorTagViews");
const { seedDbFile } = require("../_support/dbTemplate");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 1_700_000_000_000;
const GRACE = 60000;

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  assert.ok(found.ok, found.reason);
  return resolveSqliteDriver(found.srcDir);
}

function strictEscrow() {
  const records = new Map();
  return {
    records,
    getEscrowRecord: (id) => (records.has(String(id)) ? { ...records.get(String(id)) } : null),
    listEscrowRecords: () => [...records.values()].map((r) => ({ ...r })),
    putEscrowRecordDurable: (r) => {
      if ("lneOfferId" in r) return { success: false, errorMsg: "Invalid market escrow field or shape" };
      records.set(String(r.orderId), { ...r });
      return { success: true };
    },
    removeEscrowRecordDurable: (id) => ({ success: records.delete(String(id)) }),
  };
}

const daemon = { call: async () => { throw new Error("daemon must not be called"); } };

module.exports = ({ test }) => {
  test("VTV1 escrow tag lives in the LNE store across a reopen; legacy field read by flag; stale tags pruned", async () => {
    const driver = loadDriver();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-vtags-"));
    const file = path.join(tmp, "world.sqlite");
    seedDbFile(driver, file, { migrations: MIGRATIONS, seed: 1 });
    const open = () => {
      const opened = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
        busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1, migrations: MIGRATIONS });
      assert.ok(opened.ok, JSON.stringify(opened));
      return opened.store;
    };
    let clock = T0;
    const opts = { legacyRead: true, pruneMax: 10, pruneGraceMs: GRACE, now: () => clock };
    const vendor = strictEscrow();
    let store = open();
    try {
      let view = createTaggedEscrowState(vendor, createVendorTagStore(store, opts)).view;
      const spec = { orderId: "501", ownerId: 1000125, typeId: 34, stationId: 60003760, priceCents: 100,
        remainingQuantity: 10, lneOfferId: "trade:a", at: T0 };
      assert.deepStrictEqual(attachBuyEscrowFrom(view, spec), { ok: true, outcome: "WRITTEN" });
      assert.strictEqual("lneOfferId" in vendor.records.get("501"), false);
      store.close("test");
      store = open();
      view = createTaggedEscrowState(vendor, createVendorTagStore(store, opts)).view;
      assert.deepStrictEqual(attachBuyEscrowFrom(view, spec), { ok: true, outcome: "PRESENT" });
      const found = await findBuyOrderFrom(daemon, view, { corporationId: 1000125, offerId: "trade:a" });
      assert.deepStrictEqual([found.found, found.orderId], ["escrow", "501"]);
      assert.deepStrictEqual(detachEscrowFrom(view, { orderId: "501", offerId: "trade:a", escrowType: "buy" }),
        { ok: true, outcome: "REMOVED" });
      const tags = createVendorTagStore(store, opts);
      assert.deepStrictEqual(tags.listEscrowTags(), { ok: true, tags: [] });

      vendor.records.set("502", { orderId: "502", escrowType: "buy", lneOfferId: "trade:old" });
      assert.strictEqual(view.getEscrowRecord("502").lneOfferId, "trade:old");
      const strict = createTaggedEscrowState(vendor, createVendorTagStore(store, { ...opts, legacyRead: false })).view;
      assert.strictEqual("lneOfferId" in strict.getEscrowRecord("502"), false);
      assert.deepStrictEqual(attachBuyEscrowFrom(strict, { ...spec, orderId: "502", lneOfferId: "trade:old" }),
        { ok: false, reason: "ESCROW_FOREIGN" });

      assert.strictEqual(tags.putEscrowTag({ orderId: "601", offerId: "trade:x", at: T0 }).outcome, "WRITTEN");
      clock = T0 + GRACE + 1;
      assert.strictEqual(tags.putEscrowTag({ orderId: "602", offerId: "trade:y", at: clock }).outcome, "WRITTEN");
      assert.deepStrictEqual(tags.putEscrowTag({ orderId: "602", offerId: "trade:z", at: clock }).reason, "TAG_CONFLICT");
      view.listEscrowRecords();
      assert.deepStrictEqual(tags.listEscrowTags().tags.map((t) => t.orderId), ["602"]);
    } finally {
      store.close("test");
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
};
