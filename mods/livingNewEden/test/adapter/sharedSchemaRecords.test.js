"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { attachBuyEscrowFrom, attachSellEscrowFrom, promoteSellEscrowFrom } = require("../../lib/adapter/tradeMarket");
const { placeWreckFrom } = require("../../lib/adapter/nativeWrecks");
const { createTaggedEscrowState, createTaggedWreckStore } = require("../../lib/adapter/vendorTagViews");
const { createFakeVendorTags } = require("../_support/fakeVendorTags");
const { harness } = require("./nativeWrecks.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SEP = "\u001f";
const ORDER_BUY = "9000000001";
const ORDER_SELL = "9000000002";

function loadSchema() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  assert.ok(found.ok, `server/src not found: ${found.reason}`);
  const driver = resolveSqliteDriver(found.srcDir);
  assert.ok(driver.ok, JSON.stringify(driver));
  const shared = path.join(found.srcDir, "gameStore", "shared-schema");
  const { installRuntimeTable } = require(path.join(shared, "install.js"));
  const { TYPED_TABLES } = require(path.join(shared, "version.js"));
  const db = new driver.Database(":memory:");
  for (const t of ["marketEscrow", "npcWrecks", "npcWreckItems"]) installRuntimeTable(db, t, TYPED_TABLES.get(t));
  return { db, srcDir: found.srcDir };
}

function sqlEscrow(db) {
  const read = (id) => {
    const row = db.prepare("SELECT json FROM marketEscrow WHERE key = ?").get(String(id));
    return row ? JSON.parse(row.json) : null;
  };
  return {
    getEscrowRecord: read,
    listEscrowRecords: () => db.prepare("SELECT json FROM marketEscrow WHERE key <> '_meta'").all()
      .map((r) => JSON.parse(r.json)),
    putEscrowRecordDurable: (rec) => {
      db.prepare("DELETE FROM marketEscrow WHERE key = ?").run(String(rec.orderId));
      db.prepare("INSERT INTO marketEscrow (key, json) VALUES (?, ?)").run(String(rec.orderId), JSON.stringify(rec));
      return { success: true };
    },
    removeEscrowRecordDurable: (id) => {
      db.prepare("DELETE FROM marketEscrow WHERE key = ?").run(String(id));
      return { success: true };
    },
  };
}

module.exports = ({ test }) => {
  test("SSR1 vendor facts: shared schema rejects unknown escrow keys, row key separator is \\u001f", () => {
    const { db, srcDir } = loadSchema();
    const source = fs.readFileSync(path.join(srcDir, "gameStore", "sqliteStore.js"), "utf8");
    assert.match(source, /const ROW_KEY_SEP = "\\u001f";/);
    const tags = createFakeVendorTags({ at: 1_700_000_000_000 });
    const view = createTaggedEscrowState(sqlEscrow(db), tags).view;
    const res = attachBuyEscrowFrom(view, { orderId: ORDER_BUY, ownerId: 1000125, typeId: 34, stationId: 60003760,
      priceCents: 525, remainingQuantity: 100, lneOfferId: "trade:1", accountKey: 1000, at: 1_700_000_000_000,
      issuedAt: "2026-11-27T10:00:00.000Z", durationDays: 30 });
    assert.deepStrictEqual(res, { ok: true, outcome: "WRITTEN" });
    const stored = JSON.parse(db.prepare("SELECT json FROM marketEscrow WHERE key = ?").get(ORDER_BUY).json);
    assert.deepStrictEqual([stored.orderId, stored.escrowType, "lneOfferId" in stored], [ORDER_BUY, "buy", false]);
    assert.strictEqual(tags.escrows.get(ORDER_BUY).offerId, "trade:1");
    assert.strictEqual(view.getEscrowRecord(ORDER_BUY).lneOfferId, "trade:1");

    const tagged = JSON.stringify({ ...stored, orderId: "9000000099", lneOfferId: "trade:1" });
    assert.throws(() => db.prepare("INSERT INTO marketEscrow (key, json) VALUES (?, ?)").run("9000000099", tagged),
      /Invalid market escrow field or shape/);
  });

  test("SSR2 sell escrow attach and promote, wreck and wreck item from placeWreckFrom pass the shared schema", () => {
    const { db } = loadSchema();
    const tags = createFakeVendorTags({ at: 1_700_000_000_000 });
    const escrow = createTaggedEscrowState(sqlEscrow(db), tags).view;
    const attached = attachSellEscrowFrom(escrow, { orderId: ORDER_SELL, corporationId: 1000125, typeId: 34,
      stationId: 60003760, quantity: 50, escrowLocationId: 9_100_000_002, hangarFlag: 4, lneOfferId: "trade:2",
      at: 1_700_000_000_000, durationDays: 30 });
    assert.deepStrictEqual(attached, { ok: true, outcome: "WRITTEN" });
    const promoted = promoteSellEscrowFrom(escrow, { orderId: ORDER_SELL, offerId: "trade:2", at: 1_700_000_001_000 });
    assert.deepStrictEqual(promoted, { ok: true, outcome: "WRITTEN" });
    const sell = JSON.parse(db.prepare("SELECT json FROM marketEscrow WHERE key = ?").get(ORDER_SELL).json);
    assert.deepStrictEqual([sell.escrowState, "lneOfferId" in sell], ["active", false]);

    db.prepare("INSERT INTO npcWrecks (key, json) VALUES ('wrecks', '{}')").run();
    db.prepare("INSERT INTO npcWreckItems (key, json) VALUES ('items', '{}')").run();
    const h = harness.makeMods();
    const vendorUpsert = h.mods.store.upsertNativeWreck;
    const vendorItem = h.mods.store.upsertNativeWreckItem;
    h.mods.store.upsertNativeWreck = (record, o) => {
      db.prepare("INSERT INTO npcWrecks (key, json) VALUES (?, ?)").run(`wrecks${SEP}${record.wreckID}`,
        JSON.stringify(record));
      return vendorUpsert(record, o);
    };
    h.mods.store.upsertNativeWreckItem = (record, o) => {
      db.prepare("INSERT INTO npcWreckItems (key, json) VALUES (?, ?)").run(`items${SEP}${record.wreckItemID}`,
        JSON.stringify(record));
      return vendorItem(record, o);
    };
    const store = createTaggedWreckStore(h.mods.store, tags).view;
    const placed = placeWreckFrom({ ...h.mods, store }, harness.baseSpec({ lootRolls: 1 }));
    assert.strictEqual(placed.ok, true, JSON.stringify(placed));
    assert.strictEqual(placed.items, 2);
    const wreck = JSON.parse(db.prepare("SELECT json FROM npcWrecks WHERE key = ?")
      .get(`wrecks${SEP}${placed.wreckId}`).json);
    assert.deepStrictEqual([wreck.wreckID, "lneAnomalyId" in wreck, "lneSlot" in wreck], [placed.wreckId, false, false]);
    assert.strictEqual(db.prepare("SELECT count(*) AS n FROM npcWreckItems WHERE key LIKE 'items_%'").get().n, 2);
    assert.deepStrictEqual(tags.wrecks.get(placed.wreckId), { wreckId: placed.wreckId, anomalyId: "salv:abc", slot: 0,
      createdAt: 1_700_000_000_000 });
  });
};
