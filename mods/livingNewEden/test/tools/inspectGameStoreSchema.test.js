"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const tool = require("../../tools/inspectGameStoreSchema");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const ROWS = Object.freeze([["a", "{\"v\":1}"], ["b", `{"name":"${String.fromCharCode(0x17c)}"}`],
  ["c", "[1,2,3,4,5,6,7,8,9]"]]);

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

const BIG_ROWS = 2000;
const BIG_JSON = JSON.stringify({ pad: "x".repeat(4000) });
const COPY_DEADLINE_MS = 20000;

function seed(Database, file, opts = {}) {
  const db = new Database(file);
  try {
    if (opts.wal) db.exec("PRAGMA journal_mode = WAL");
    db.exec("CREATE TABLE \"items\"(key TEXT PRIMARY KEY, json TEXT NOT NULL); CREATE TABLE meta(k TEXT, v TEXT);");
    const insert = db.prepare("INSERT INTO \"items\"(key, json) VALUES (?, ?)");
    for (const [k, j] of ROWS) insert.run(k, j);
    for (let i = 0; i < (opts.bigRows || 0); i += 1) insert.run(`big${i}`, BIG_JSON);
    db.prepare("INSERT INTO meta(k, v) VALUES (?, ?)").run("x", "y");
  } finally {
    db.close();
  }
}

function startWriter(Database, file) {
  const db = new Database(file);
  const update = db.prepare("UPDATE meta SET v = ? WHERE k = 'x'");
  let writes = 0;
  let stopped = false;
  const turn = () => {
    if (stopped) return;
    writes += 1;
    update.run(String(writes));
    setImmediate(turn);
  };
  setImmediate(turn);
  return {
    stop() {
      stopped = true;
      db.close();
      return writes;
    },
  };
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const name = "IG1 inspect --bytes: rows + JSON bytes per json table (sorted), no integrity; default keeps integrity";
  const copyName = "IG1b --online-copy: ends while another connection writes the WAL file every turn, same counts, "
    + "DEST_EXISTS on a second run";
  if (!driver.ok) {
    skip(name, `better-sqlite3 unavailable (${driver.detail})`);
    skip(copyName, `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }
  const { Database } = driver;
  const expectedBytes = ROWS.reduce((s, [, j]) => s + Buffer.byteLength(j, "utf8"), 0);
  const maxBytes = Math.max(...ROWS.map(([, j]) => Buffer.byteLength(j, "utf8")));

  test(name, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lne-igs-"));
    try {
      const file = path.join(dir, "gamestore.sqlite");
      seed(Database, file);
      const db = new Database(file, { readonly: true, fileMustExist: true });
      try {
        const withBytes = tool.inspect(db, { bytes: true });
        assert.strictEqual(withBytes.integrity, null);
        assert.deepStrictEqual(withBytes.tables.map((t) => t.name), ["items", "meta"], "json tables first");
        const items = withBytes.tables[0];
        assert.strictEqual(items.rows, 3);
        assert.strictEqual(items.jsonBytes, expectedBytes);
        assert.strictEqual(items.maxRowBytes, maxBytes);
        assert.strictEqual(withBytes.tables[1].jsonBytes, undefined, "no json column -> no byte fields");
        const plain = tool.inspect(db, {});
        assert.strictEqual(plain.integrity, "ok");
        assert.strictEqual(plain.tables.find((t) => t.name === "items").jsonBytes, undefined);
      } finally {
        db.close();
      }
      assert.deepStrictEqual(tool.parseArgs(["--online-copy", "a"], "/srv").reason, "USAGE");
      let backupOpts = null;
      class FakeDb {
        backup(_target, o) {
          backupOpts = o;
          return Promise.reject(new Error("fake"));
        }
        close() {}
      }
      const r = await tool.onlineCopy(FakeDb, file, path.join(dir, "fake-copy.sqlite"));
      assert.strictEqual(r.reason, "COPY_FAILED");
      assert.ok(backupOpts && typeof backupOpts.progress === "function", "progress callback passed");
      assert.strictEqual(backupOpts.progress({ totalPages: 5000, remainingPages: 5000 }), tool.WHOLE_COPY_PAGES);
      assert.strictEqual(tool.parseArgs([file, "--bytes"], "/srv").bytes, true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  const probe = new Database(":memory:");
  const hasBackup = typeof probe.backup === "function";
  probe.close();
  if (!hasBackup) {
    skip(copyName, "the SQLite driver has no backup() (local node:sqlite shim)");
    return;
  }
  test(copyName, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lne-igs-"));
    try {
      const live = path.join(dir, "gamestore.sqlite");
      const dest = path.join(dir, "copy.sqlite");
      seed(Database, live, { wal: true, bigRows: BIG_ROWS });
      const writer = startWriter(Database, live);
      let timer = null;
      const deadline = new Promise((resolve) => {
        timer = setTimeout(() => resolve({ ok: false, reason: "TEST_DEADLINE" }), COPY_DEADLINE_MS);
      });
      let r = null;
      let writes = 0;
      try {
        r = await Promise.race([tool.onlineCopy(Database, live, dest), deadline]);
      } finally {
        clearTimeout(timer);
        writes = writer.stop();
      }
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.ok(writes > 0, "the writer wrote during the copy");
      const db = new Database(dest, { readonly: true, fileMustExist: true });
      try {
        const items = tool.inspect(db, { bytes: true }).tables[0];
        const bigBytes = BIG_ROWS * Buffer.byteLength(BIG_JSON, "utf8");
        assert.deepStrictEqual([items.rows, items.jsonBytes], [3 + BIG_ROWS, expectedBytes + bigBytes]);
      } finally {
        db.close();
      }
      assert.strictEqual((await tool.onlineCopy(Database, live, dest)).reason, "DEST_EXISTS");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });
};
