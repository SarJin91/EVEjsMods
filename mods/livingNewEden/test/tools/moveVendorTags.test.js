"use strict";

const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { loadDriver } = require("../../tools/offlineDb");
const { main, NEEDED } = require("../../tools/moveVendorTags");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { seedDbFile } = require("../_support/dbTemplate");

const T = Date.UTC(2026, 10, 27, 6, 30, 0);
const ESCROW_TAGGED = { orderId: "7001", escrowType: "buy", ownerId: 1000125, price: 5.5, lneOfferId: "trade:a" };
const ESCROW_PLAIN = { orderId: "7002", escrowType: "sell", ownerId: 90000001, price: 7 };
const WRECK_TAGGED = { wreckID: 9000001, systemID: 30000142, dungeonSiteID: 11, lneAnomalyId: "salv:x", lneSlot: 2 };
const WRECK_PLAIN = { wreckID: 9000002, systemID: 30000142 };

function legacySave(driver, file, { leaseUntil } = {}) {
  const db = new driver.Database(file);
  try {
    db.exec(`
      CREATE TABLE _migrations (table_name TEXT PRIMARY KEY, migrated_at TEXT NOT NULL);
      CREATE TABLE _persistence_owners (owner_id TEXT PRIMARY KEY, active INTEGER NOT NULL, lease_expires_at INTEGER);
      CREATE TABLE _persistence_outbox (id INTEGER PRIMARY KEY, state TEXT);
      CREATE TABLE "marketEscrow" (key TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE "npcWrecks" (key TEXT PRIMARY KEY, json TEXT NOT NULL);
    `);
    const put = db.prepare("INSERT INTO \"marketEscrow\" (key, json) VALUES (?, ?)");
    put.run("_meta", JSON.stringify({ nextSagaID: 3 }));
    put.run(ESCROW_TAGGED.orderId, JSON.stringify(ESCROW_TAGGED));
    put.run(ESCROW_PLAIN.orderId, JSON.stringify(ESCROW_PLAIN));
    db.prepare("INSERT INTO \"npcWrecks\" (key, json) VALUES ('wrecks', ?)").run(JSON.stringify({
      [WRECK_TAGGED.wreckID]: WRECK_TAGGED, [WRECK_PLAIN.wreckID]: WRECK_PLAIN }));
    db.prepare("INSERT INTO _persistence_owners VALUES ('srv', 1, ?)").run(leaseUntil === undefined ? T - 1 : leaseUntil);
    db.prepare("INSERT INTO _persistence_outbox VALUES (1, 'applied')").run();
  } finally {
    db.close();
  }
}

function rig(opts) {
  const driver = loadDriver();
  assert.ok(driver.ok, JSON.stringify(driver));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lne-mvtags-"));
  const storeRoot = path.join(root, "gameStore");
  fs.mkdirSync(storeRoot);
  const vendorFile = path.join(storeRoot, "gamestore.sqlite");
  const worldFile = path.join(root, "world.sqlite");
  legacySave(driver, vendorFile, opts);
  seedDbFile(driver, worldFile, { migrations: MIGRATIONS.slice(0, MIGRATIONS.length - 1), seed: 1 });
  const lines = [];
  const run = (...mode) => main([...mode, "--store-root", storeRoot, "--db", worldFile, "--skip-space-check"],
    { driver, env: {}, now: () => T, print: (l) => lines.push(l) });
  const read = (file, sql) => {
    const db = new driver.Database(file, { readonly: true });
    try {
      return db.prepare(sql).all();
    } finally {
      db.close();
    }
  };
  const backups = () => fs.readdirSync(storeRoot).filter((n) => n.startsWith("backup-"));
  const digest = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  return { run, read, lines, backups, digest, vendorFile, worldFile, cleanup };
}

module.exports = ({ test }) => {
  test("MVT1 --apply moves escrow and wreck tags into the LNE database, strips them, backs up; rerun is a no-op", () => {
    const r = rig();
    try {
      assert.strictEqual(r.run("--check"), NEEDED);
      assert.strictEqual(r.run("--apply"), 0, r.lines.join("\n"));
      assert.deepStrictEqual(r.read(r.worldFile, "SELECT order_id, offer_id FROM lne_market_escrow_tags"),
        [{ order_id: "7001", offer_id: "trade:a" }]);
      assert.deepStrictEqual(r.read(r.worldFile, "SELECT wreck_id, anomaly_id, slot FROM lne_native_wreck_tags"),
        [{ wreck_id: 9000001, anomaly_id: "salv:x", slot: 2 }]);
      const escrows = new Map(r.read(r.vendorFile, "SELECT key, json FROM marketEscrow")
        .map((row) => [row.key, JSON.parse(row.json)]));
      const { lneOfferId: _o, ...escrowRest } = ESCROW_TAGGED;
      assert.deepStrictEqual(escrows.get("7001"), escrowRest);
      assert.deepStrictEqual(escrows.get("7002"), ESCROW_PLAIN);
      assert.deepStrictEqual(escrows.get("_meta"), { nextSagaID: 3 });
      const wrecks = JSON.parse(r.read(r.vendorFile, "SELECT json FROM npcWrecks WHERE key = 'wrecks'")[0].json);
      const { lneAnomalyId: _a, lneSlot: _s, ...wreckRest } = WRECK_TAGGED;
      assert.deepStrictEqual(wrecks, { [WRECK_TAGGED.wreckID]: wreckRest, [WRECK_PLAIN.wreckID]: WRECK_PLAIN });
      const dirs = r.backups();
      assert.deepStrictEqual(dirs, ["backup-20261127-063000-pre-lne-tags"]);
      const backupDir = path.join(path.dirname(r.vendorFile), dirs[0]);
      assert.deepStrictEqual(fs.readdirSync(backupDir).sort(), ["gamestore.sqlite", "world.sqlite"]);
      assert.strictEqual(r.read(path.join(backupDir, "gamestore.sqlite"),
        "SELECT json FROM marketEscrow WHERE key = '7001'")[0].json.includes("trade:a"), true);

      r.lines.length = 0;
      assert.strictEqual(r.run("--apply"), 0);
      assert.ok(r.lines.includes("OK: nothing to do"), r.lines.join("\n"));
      assert.strictEqual(r.backups().length, 1);
      assert.strictEqual(r.run("--check"), 0);
    } finally {
      r.cleanup();
    }
  });

  test("MVT2 an active lease on the game store refuses with code 2 and leaves both files unchanged", () => {
    const r = rig({ leaseUntil: T + 60000 });
    try {
      const before = [r.digest(r.vendorFile), r.digest(r.worldFile)];
      assert.strictEqual(r.run("--apply"), 2);
      assert.ok(r.lines.some((l) => l.startsWith("REFUSED: the game store has an active writer")), r.lines.join("\n"));
      assert.deepStrictEqual([r.digest(r.vendorFile), r.digest(r.worldFile)], before);
      assert.deepStrictEqual(r.backups(), []);
    } finally {
      r.cleanup();
    }
  });
};
