"use strict";

const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { main, backupNameOf, EXIT } = require("../../tools/resetWorld");
const { seedDbFile } = require("../_support/dbTemplate");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const NOW = Date.UTC(2026, 9, 21, 12, 34, 56);
const HASH = "a".repeat(64);

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function journalKeys(driver, file) {
  const db = new driver.Database(file, { fileMustExist: true });
  try {
    db.pragma("locking_mode = EXCLUSIVE");
    return db.prepare("SELECT idempotency_key FROM world_event_journal ORDER BY 1").pluck().all();
  } finally {
    db.close();
  }
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const name = "RW4 resetWorld CLI: dry-run unchanged, lock -> 2, --apply backup quick_check ok, backup exists -> 2";
  if (!driver.ok) {
    skip(name, `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }
  test(name, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-rw-"));
    const file = path.join(tmp, "world.sqlite");
    const lines = [];
    const run = (...argv) => main({ argv: ["--db", file, ...argv], env: {}, now: () => NOW, driver,
      print: (l) => lines.push(l) });
    try {
      seedDbFile(driver, file, { migrations: MIGRATIONS, seed: 1 });
      const setup = new driver.Database(file);
      for (const key of ["world:seed:v1:30000001", "lne:std:9000001:20000:k1"]) {
        setup.prepare("INSERT INTO world_event_journal (idempotency_key, kind, aggregate_type, aggregate_id, "
          + "event_type, payload, payload_hash, state, created_at, applied_at) "
          + "VALUES (?, 'APPLY', 'test', 'x', 'TEST', '{}', ?, 'APPLIED', 1, 1)").run(key, HASH);
      }
      setup.close();

      const before = sha256(file);
      assert.strictEqual(run(), EXIT.OK, lines.join("\n"));
      assert.strictEqual(sha256(file), before, "dry-run must not change the file");
      assert.ok(lines.some((l) => l.startsWith("world_event_journal") && l.includes("PARTIAL_JOURNAL")), lines.join("\n"));
      assert.ok(lines.some((l) => l.startsWith("DRY-RUN")), lines.join("\n"));
      const backup = path.join(tmp, backupNameOf(file, NOW));
      assert.strictEqual(path.basename(backup), "world.sqlite.pre-reset-20261021-123456Z");
      assert.strictEqual(fs.existsSync(backup), false);

      const holder = new driver.Database(file);
      try {
        holder.pragma("locking_mode = EXCLUSIVE");
        holder.exec("BEGIN IMMEDIATE");
        holder.exec("COMMIT");
        lines.length = 0;
        assert.strictEqual(run("--apply"), EXIT.REFUSED, lines.join("\n"));
        assert.ok(lines.some((l) => l.includes("the server is running")), lines.join("\n"));
      } finally {
        holder.close();
      }
      assert.strictEqual(fs.existsSync(backup), false, "no backup without the lock");

      lines.length = 0;
      assert.strictEqual(run("--apply"), EXIT.OK, lines.join("\n"));
      assert.ok(fs.existsSync(backup), lines.join("\n"));
      const check = new driver.Database(backup, { fileMustExist: true });
      try {
        check.pragma("locking_mode = EXCLUSIVE");
        assert.strictEqual(check.pragma("quick_check", { simple: true }), "ok");
      } finally {
        check.close();
      }
      assert.deepStrictEqual(journalKeys(driver, backup), ["lne:std:9000001:20000:k1", "world:seed:v1:30000001"]);
      assert.deepStrictEqual(journalKeys(driver, file), ["lne:std:9000001:20000:k1"]);

      lines.length = 0;
      assert.strictEqual(run("--apply"), EXIT.REFUSED, lines.join("\n"));
      assert.ok(lines.some((l) => l.includes("already exists")), lines.join("\n"));
      assert.strictEqual(run("--dry-run", "--apply"), EXIT.USAGE);
    } finally {
      try {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch (_err) {
      }
    }
  });
};
