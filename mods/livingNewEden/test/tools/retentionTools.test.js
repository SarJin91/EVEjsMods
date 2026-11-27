"use strict";

const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const stats = require("../../tools/retentionStats");
const compact = require("../../tools/compactWorld");
const backups = require("../../tools/offlineBackups");
const { seedDbFile } = require("../_support/dbTemplate");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const NOW = Date.UTC(2026, 9, 29, 10, 20, 30);
const HASH = "a".repeat(64);
const FLEET = "fleet_mgx2k1a0_0001_k3f9";

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

let seq = 0;
function insertEvent(db, key, eventType, state, payload) {
  seq += 1;
  const done = state === "DONE";
  db.prepare("INSERT INTO world_scheduled_events (event_id, idempotency_key, event_type, aggregate_type, aggregate_id, "
    + "priority, due_at, payload, payload_hash, state, attempts, outcome, created_at, finished_at, version) "
    + "VALUES (?, ?, ?, 'test', 'x', 3, 1, ?, ?, ?, 0, ?, 1, ?, 1)")
    .run(`event_t${seq}`, key, eventType, payload, HASH, state, done ? "OK" : null, done ? 1 : null);
}

function insertJournal(db, key, kind, state, payload) {
  const applied = state === "APPLIED";
  db.prepare("INSERT INTO world_event_journal (idempotency_key, kind, aggregate_type, aggregate_id, event_type, "
    + "payload, payload_hash, state, created_at, applied_at) VALUES (?, ?, 'test', 'x', 'TEST', ?, ?, ?, 1, ?)")
    .run(key, kind, payload, HASH, state, applied ? 1 : null);
}

function insertEventAt(db, key, eventType, state, payload, createdAt, finishedAt) {
  seq += 1;
  db.prepare("INSERT INTO world_scheduled_events (event_id, idempotency_key, event_type, aggregate_type, aggregate_id, "
    + "priority, due_at, payload, payload_hash, state, attempts, outcome, created_at, finished_at, version) "
    + "VALUES (?, ?, ?, 'test', 'x', 3, 1, ?, ?, ?, 0, ?, ?, ?, 1)")
    .run(`event_t${seq}`, key, eventType, payload, HASH, state, state === "DONE" ? "OK" : null, createdAt,
      finishedAt === undefined ? null : finishedAt);
}

function insertJournalAt(db, key, kind, state, eventType, payload, createdAt) {
  db.prepare("INSERT INTO world_event_journal (idempotency_key, kind, aggregate_type, aggregate_id, event_type, "
    + "payload, payload_hash, state, created_at, applied_at) VALUES (?, ?, 'test', 'x', ?, ?, ?, ?, ?, ?)")
    .run(key, kind, eventType, payload, HASH, state, createdAt, state === "APPLIED" ? createdAt : null);
}

function withLockHolder(driver, file, fn) {
  const holder = new driver.Database(file);
  try {
    holder.pragma("locking_mode = EXCLUSIVE");
    holder.exec("BEGIN IMMEDIATE");
    holder.exec("COMMIT");
    fn();
  } finally {
    holder.close();
  }
}

module.exports = ({ test, skip }) => {
  test("RC1 retentionStats prefixOf: segments before the first number or durable id", () => {
    assert.strictEqual(stats.prefixOf("strategy:review:500000:3"), "strategy:review:");
    assert.strictEqual(stats.prefixOf(`arrival:${FLEET}:2`), "arrival:");
    assert.strictEqual(stats.prefixOf("contact:30000142:arr:x:1"), "contact:");
    assert.strictEqual(stats.prefixOf("42:x"), "");
    assert.strictEqual(stats.prefixOf("lne:boot"), "lne:boot:");
  });

  test("CW1 planSpace: one device adds up, 1 B short -> not ok; parseBackupName rejects -wal, .tmp, other db", () => {
    const base = { live: 1000, walBytes: 50, margin: compact.SPACE_MARGIN };
    const apart = backups.planSpace({ ...base, dbFree: 1e9, backupFree: 1e9, sameDevice: false });
    assert.strictEqual(apart.ok, true);
    assert.ok(apart.needDb >= (2 * 1000 + 50) * 1.1 && apart.needBackup >= 1000 * 1.1, JSON.stringify(apart));
    assert.strictEqual(backups.planSpace({ ...base, dbFree: apart.needDb, backupFree: apart.needBackup,
      sameDevice: false }).ok, true);
    assert.strictEqual(backups.planSpace({ ...base, dbFree: apart.needDb, backupFree: apart.needBackup - 1,
      sameDevice: false }).ok, false, "backup directory 1 B short");
    const same = backups.planSpace({ ...base, dbFree: apart.needDb + apart.needBackup, backupFree: 0, sameDevice: true });
    assert.deepStrictEqual([same.ok, same.needDb, same.freeBackup], [true, apart.needDb + apart.needBackup,
      apart.needDb + apart.needBackup]);
    assert.strictEqual(backups.planSpace({ ...base, dbFree: apart.needDb + apart.needBackup - 1, backupFree: 1e9,
      sameDevice: true }).ok, false, "same device, 1 B short");
    assert.strictEqual(backups.planSpace({ ...base, dbFree: apart.needDb, backupFree: 1e9, sameDevice: true }).ok, false,
      "same device: the free space of the database directory must hold both");

    const p = (name) => backups.parseBackupName(name, "world.sqlite");
    assert.deepStrictEqual(p("world.sqlite.pre-compact-20261102-101500Z"),
      { kind: "pre-compact", stampMs: Date.UTC(2026, 10, 2, 10, 15, 0) });
    assert.deepStrictEqual(p("world.sqlite.pre-reset-20261101-000001Z"),
      { kind: "pre-reset", stampMs: Date.UTC(2026, 10, 1, 0, 0, 1) });
    assert.deepStrictEqual(p("world-20261102-101500Z.sqlite"), { kind: "online", stampMs: Date.UTC(2026, 10, 2, 10, 15, 0) });
    for (const bad of ["world.sqlite.pre-compact-20261102-101500Z-wal", "world.sqlite.pre-compact-20261102-101500Z-shm",
      "world.sqlite.pre-compact-20261102-101500Z.tmp", "other.sqlite.pre-compact-20261102-101500Z",
      "world.sqlite", "world.sqlite-wal", "world.sqlite.pre-compact-20261302-101500Z", "world-20261102-101500Z.sqlite-wal",
      "xworld.sqlite.pre-reset-20261102-101500Z"]) {
      assert.strictEqual(p(bad), null, bad);
    }
  });

  test("CW2 planPrune: keep 1 removes 2 pre-compact + 1 pre-reset, online never; keep 0 removes every pre-*", () => {
    const e = (kind, day) => ({ file: `/d/${kind}-${day}`, name: `${kind}-${day}`, kind,
      stampMs: Date.UTC(2026, 10, day), bytes: 10 });
    const list = [e("pre-compact", 1), e("pre-compact", 3), e("pre-compact", 2), e("pre-reset", 1), e("pre-reset", 2),
      e("online", 1), e("online", 2)];
    const one = backups.planPrune(list, 1);
    assert.deepStrictEqual(one.remove.map((x) => x.name), ["pre-compact-2", "pre-compact-1", "pre-reset-1"]);
    assert.deepStrictEqual(one.keep.map((x) => x.name), ["pre-compact-3", "pre-reset-2"]);
    const zero = backups.planPrune(list, 0);
    assert.deepStrictEqual(zero.remove.map((x) => x.kind).sort(),
      ["pre-compact", "pre-compact", "pre-compact", "pre-reset", "pre-reset"]);
    assert.strictEqual([...zero.remove, ...zero.keep].some((x) => x.kind === "online"), false, "online never planned");
  });

  test("RC4 retentionStats: after close no retry of side files the first attempt removed (SWEEP, Linux)", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-rs4-"));
    const file = path.join(tmp, "world.sqlite");
    const atClose = [];
    class FakeDatabase {
      constructor(f) {
        this.file = f;
        fs.writeFileSync(`${f}-wal`, "");
        fs.writeFileSync(`${f}-shm`, "tool");
      }
      pragma() { return 0; }
      prepare() { return { get: () => ({ n: 0 }), all: () => [], iterate: () => [][Symbol.iterator]() }; }
      close() {
        atClose.push(fs.existsSync(`${this.file}-wal`), fs.existsSync(`${this.file}-shm`));
        fs.writeFileSync(`${this.file}-wal`, "");
        fs.writeFileSync(`${this.file}-shm`, "server");
      }
    }
    try {
      fs.writeFileSync(file, "x");
      const lines = [];
      stats.main({ argv: ["--db", file], env: {}, driver: { Database: FakeDatabase }, print: (l) => lines.push(l) });
      assert.deepStrictEqual(atClose, [false, false], `first attempt removed the tool files\n${lines.join("\n")}`);
      assert.ok(fs.existsSync(`${file}-wal`), "server -wal created after close() must stay");
      assert.strictEqual(fs.readFileSync(`${file}-shm`, "utf8"), "server", "server -shm created after close() must stay");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  const cw4Name = "CW4 compactWorld --prune-backups: --backup-dir alias of the db directory (symlink) keeps the newest";
  const makeBackupDir = (prefix) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const dbDir = path.join(tmp, "db");
    fs.mkdirSync(dbDir);
    fs.writeFileSync(path.join(dbDir, "world.sqlite"), "x");
    for (const day of ["01", "02", "03"]) fs.writeFileSync(path.join(dbDir, `world.sqlite.pre-compact-202610${day}-000000Z`), "x");
    return { tmp, dbDir, file: path.join(dbDir, "world.sqlite") };
  };
  const pruneRun = (file, argv, extra = {}) => {
    const lines = [];
    const unlinked = [];
    const code = compact.main({ argv: ["--db", file, ...argv], env: {}, print: (l) => lines.push(l),
      unlink: (f) => { unlinked.push(path.basename(f)); fs.unlinkSync(f); }, ...extra });
    return { code, lines, unlinked };
  };
  const NEWEST = "world.sqlite.pre-compact-20261003-000000Z";
  {
    const { tmp, dbDir, file } = makeBackupDir("lne-cw4-");
    const alias = path.join(tmp, "alias");
    let linked = null;
    try {
      fs.symlinkSync(dbDir, alias, process.platform === "win32" ? "junction" : "dir");
      linked = true;
    } catch (err) {
      linked = `symlink unavailable (${err && err.code ? err.code : err})`;
    }
    if (linked !== true) {
      fs.rmSync(tmp, { recursive: true, force: true });
      skip(cw4Name, linked);
    } else {
      test(cw4Name, () => {
        try {
          const list = pruneRun(file, ["--list-backups", "--backup-dir", alias]);
          assert.strictEqual(list.code, compact.EXIT.OK, list.lines.join("\n"));
          assert.ok(list.lines.some((l) => l.startsWith("Total: 3 backups")), list.lines.join("\n"));
          const r = pruneRun(file, ["--prune-backups", "--keep", "1", "--apply", "--backup-dir", alias]);
          assert.strictEqual(r.code, compact.EXIT.OK, r.lines.join("\n"));
          assert.deepStrictEqual(r.unlinked.sort(), ["world.sqlite.pre-compact-20261001-000000Z",
            "world.sqlite.pre-compact-20261002-000000Z"], r.lines.join("\n"));
          assert.ok(fs.existsSync(path.join(dbDir, NEWEST)), "the newest copy stays");
        } finally {
          fs.rmSync(tmp, { recursive: true, force: true });
        }
      });
    }
  }

  test("CW5 --prune-backups: ./ and other-case alias read once, a hard link listed once (dev, ino), recheck before unlink", () => {
    const { tmp, dbDir, file } = makeBackupDir("lne-cw5-");
    try {
      const same = `${process.platform === "win32" ? dbDir.toUpperCase() : dbDir}${path.sep}.`;
      const list = pruneRun(file, ["--list-backups", "--backup-dir", same]);
      assert.ok(list.lines.some((l) => l.startsWith("Total: 3 backups")), list.lines.join("\n"));

      const other = path.join(tmp, "other");
      fs.mkdirSync(other);
      let hard = true;
      try {
        fs.linkSync(path.join(dbDir, NEWEST), path.join(other, NEWEST));
      } catch (_err) {
        hard = false;
      }
      if (hard) {
        const listed = backups.listBackups([dbDir, other], "world.sqlite");
        assert.deepStrictEqual(listed.map((e) => e.name), [NEWEST, "world.sqlite.pre-compact-20261002-000000Z",
          "world.sqlite.pre-compact-20261001-000000Z"], JSON.stringify(listed));
        fs.unlinkSync(path.join(other, NEWEST));
      }

      const r = pruneRun(file, ["--prune-backups", "--keep", "1", "--apply", "--backup-dir", same], {
        lstat: (f) => (path.basename(f).includes("20261001") ? { isFile: () => false } : fs.lstatSync(f)) });
      assert.strictEqual(r.code, compact.EXIT.FAILED, r.lines.join("\n"));
      assert.deepStrictEqual(r.unlinked, ["world.sqlite.pre-compact-20261002-000000Z"], r.lines.join("\n"));
      assert.ok(r.lines.some((l) => l.includes("changed before removal: not a regular file")),
        r.lines.join("\n"));
      assert.deepStrictEqual(fs.readdirSync(dbDir).sort(), ["world.sqlite", "world.sqlite.pre-compact-20261001-000000Z",
        NEWEST]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  const driver = loadDriver();
  const statsName = "RC2 retentionStats: rows/bytes per prefix x state x event_type, class ids, read only, lock -> 2";
  const compactName = "RC3 compactWorld: dry-run unchanged, lock -> 2, --apply backup quick_check ok + smaller file";
  const rs1Name = "RS1 retentionStats --shape: <id>/<n> shapes, old only past refNow - minAgeMs, journal event_type";
  const rs2Name = "RS2 retentionStats: growth per UTC day, sizes without dbstat -> count/null, --json one object";
  const cw3Name = "CW3 compactWorld: too little space -> 2 without a backup, --skip-space-check, prune only with --apply";
  if (!driver.ok) {
    for (const name of [statsName, compactName, rs1Name, rs2Name, cw3Name]) {
      skip(name, `better-sqlite3 unavailable (${driver.detail})`);
    }
    return;
  }

  const DAY = 86400000;
  const REF = Date.UTC(2026, 10, 2, 12, 0, 0);
  const MIN_AGE = 7 * DAY;
  const ID = "mt_mgx2k1a0_0001_k3f9";

  test(rs1Name, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-rs1-"));
    const file = path.join(tmp, "world.sqlite");
    try {
      seedDbFile(driver, file, { migrations: MIGRATIONS, seed: 1 });
      const db = new driver.Database(file);
      try {
        assert.strictEqual(stats.shapeOf(`mining:due:${ID}:3:0`), "mining:due:<id>:<n>:<n>");
        assert.strictEqual(stats.shapeOf("strategy:review:500000:3:touch"), "strategy:review:<n>:<n>:touch");
        insertEventAt(db, `mining:due:${ID}:3:0`, "MINING_DUE", "DONE", "{}", REF - 10 * DAY, REF - 9 * DAY);
        insertEventAt(db, `mining:due:${ID}:4:1`, "MINING_DUE", "DONE", "{}", REF - 2 * DAY, REF - DAY);
        insertEventAt(db, `mining:due:${ID}:5:0`, "MINING_DUE", "PENDING", "{}", REF - 10 * DAY);
        insertEventAt(db, "strategy:review:500000:3", "FACTION_STRATEGY_REVIEW", "DONE", "{}", REF - DAY, REF);
        insertJournalAt(db, "strategy:review:500000:3:touch", "APPLY", "APPLIED", "REVIEW_TOUCH", "{}", REF - 8 * DAY);
        insertJournalAt(db, "strategy:review:500000:4:touch", "APPLY", "APPLIED", "REVIEW_TOUCH", "{}", REF - 3600000);
        assert.strictEqual(stats.refNowOf(db), REF, "refNow = last activity (max finished_at)");
        const result = stats.collectStats(db, { shape: true, refNow: REF, minAgeMs: MIN_AGE });
        const got = result.groups.map((g) => [g.table, g.prefix, g.state, g.eventType, g.rows, g.old]).sort();
        assert.deepStrictEqual(got, [
          ["events", "mining:due:<id>:<n>:<n>", "DONE", "MINING_DUE", 2, 1],
          ["events", "mining:due:<id>:<n>:<n>", "PENDING", "MINING_DUE", 1, 0],
          ["events", "strategy:review:<n>:<n>", "DONE", "FACTION_STRATEGY_REVIEW", 1, 0],
          ["journal", "strategy:review:<n>:<n>:touch", "APPLY/APPLIED", "REVIEW_TOUCH", 2, 1],
        ]);
        assert.deepStrictEqual([result.totals.events.old, result.totals.journal.old], [1, 1]);
        const plain = stats.collectStats(db, { refNow: REF, minAgeMs: MIN_AGE });
        assert.ok(plain.groups.some((g) => g.prefix === "mining:due:" && g.old === 1), JSON.stringify(plain.groups));
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test(rs2Name, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-rs2-"));
    const file = path.join(tmp, "world.sqlite");
    try {
      seedDbFile(driver, file, { migrations: MIGRATIONS, seed: 1 });
      const db = new driver.Database(file);
      try {
        insertJournalAt(db, "a:1", "APPLY", "APPLIED", "T", "{\"a\":1}", Date.UTC(2026, 9, 31, 11, 0, 0));
        insertJournalAt(db, "a:2", "APPLY", "APPLIED", "T", "{\"a\":12}", Date.UTC(2026, 10, 1, 23, 59, 0));
        insertJournalAt(db, "a:3", "APPLY", "APPLIED", "T", "{}", Date.UTC(2026, 10, 2, 0, 1, 0));
        insertJournalAt(db, "a:4", "APPLY", "APPLIED", "T", "{}", REF);
        insertEventAt(db, "b:1", "X", "PENDING", "{}", Date.UTC(2026, 10, 1, 1, 0, 0));
        const growth = stats.collectGrowth(db, { refNow: REF, days: 2 });
        assert.deepStrictEqual(growth.map((g) => [g.table, g.day, g.rows, g.bytes]), [
          ["events", "2026-11-01", 1, 2],
          ["journal", "2026-11-01", 1, 8],
          ["journal", "2026-11-02", 2, 4],
        ]);
        const real = stats.collectTableSizes(db);
        assert.ok(real.tables.some((t) => t.name === "world_event_journal"), JSON.stringify(real));
      } finally {
        db.close();
      }

      const fake = { prepare(sql) {
        if (sql.includes("dbstat")) throw new Error("no such table: dbstat");
        if (sql.includes("sqlite_master")) return { all: () => [{ name: "a" }, { name: "b" }] };
        return { get: () => ({ n: sql.includes("\"a\"") ? 3 : 5 }) };
      } };
      assert.deepStrictEqual(stats.collectTableSizes(fake),
        { source: "count", tables: [{ name: "b", rows: 5, bytes: null }, { name: "a", rows: 3, bytes: null }] });
      assert.deepStrictEqual(stats.collectTableSizes({ prepare() { throw new Error("x"); } }),
        { source: "count", tables: [] });

      const out = [];
      const err = [];
      assert.strictEqual(stats.main({ argv: ["--db", file, "--json", "--shape", "--min-age-ms", String(MIN_AGE)],
        env: {}, driver, print: (l) => out.push(l), printErr: (l) => err.push(l) }), stats.EXIT.OK, err.join("\n"));
      assert.strictEqual(out.length, 1, out.join("\n"));
      const obj = JSON.parse(out[0]);
      assert.deepStrictEqual(Object.keys(obj), ["db", "refNow", "minAgeMs", "shape", "totals", "groups", "growth", "tables"]);
      assert.deepStrictEqual([obj.db, obj.refNow, obj.minAgeMs, obj.shape], ["world.sqlite", REF, MIN_AGE, true]);
      assert.ok(!out[0].includes(tmp) && !out[0].includes(JSON.stringify(tmp).slice(1, -1)), "no host directory in JSON");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test(cw3Name, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-cw3-"));
    const file = path.join(tmp, "world.sqlite");
    const lines = [];
    const run = (argv, extra = {}) => compact.main({ argv: ["--db", file, ...argv], env: {}, now: () => NOW, driver,
      print: (l) => lines.push(l), ...extra });
    const full = () => ({ bavail: 1e12, bsize: 1 });
    try {
      seedDbFile(driver, file, { migrations: MIGRATIONS, seed: 1 });
      const backup = path.join(tmp, compact.backupNameOf(file, NOW));

      assert.strictEqual(run([], { statfs: full }), compact.EXIT.OK, lines.join("\n"));
      assert.ok(lines.some((l) => l.startsWith("Space: need") && l.includes("free")), lines.join("\n"));

      lines.length = 0;
      assert.strictEqual(run(["--apply"], { statfs: () => ({ bavail: 1, bsize: 4096 }) }), compact.EXIT.REFUSED,
        lines.join("\n"));
      assert.ok(lines.some((l) => l.startsWith("REFUSED: not enough space")), lines.join("\n"));
      lines.length = 0;
      assert.strictEqual(run(["--apply"], { statfs: () => { throw new Error("ENOSYS"); } }), compact.EXIT.REFUSED,
        lines.join("\n"));
      assert.ok(lines.some((l) => l.includes("--skip-space-check")), lines.join("\n"));
      assert.deepStrictEqual(fs.readdirSync(tmp), ["world.sqlite"], "no backup, no other file after a refusal");

      lines.length = 0;
      assert.strictEqual(run(["--apply", "--skip-space-check"], { statfs: () => { throw new Error("never"); } }),
        compact.EXIT.OK, lines.join("\n"));
      assert.ok(fs.existsSync(backup), "backup written with --skip-space-check");

      const touch = (name) => fs.writeFileSync(path.join(tmp, name), "x");
      touch("world.sqlite.pre-compact-20261001-000000Z");
      touch("world.sqlite.pre-compact-20261002-000000Z");
      touch("world.sqlite.pre-reset-20261003-000000Z");
      touch("world-20261004-000000Z.sqlite");
      touch("world.sqlite.pre-compact-20261001-000000Z-wal");
      fs.mkdirSync(path.join(tmp, "backups"));
      fs.writeFileSync(path.join(tmp, "backups", "world-20261005-000000Z.sqlite"), "xy");
      const before = fs.readdirSync(tmp).sort();

      lines.length = 0;
      assert.strictEqual(run(["--list-backups"]), compact.EXIT.OK, lines.join("\n"));
      assert.ok(lines.some((l) => l.startsWith("Total: 6 backups")), lines.join("\n"));
      assert.strictEqual(run(["--prune-backups", "--skip-space-check"]), compact.EXIT.USAGE);
      assert.strictEqual(run(["--keep", "0"]), compact.EXIT.USAGE);

      lines.length = 0;
      assert.strictEqual(run(["--prune-backups", "--keep", "0"]), compact.EXIT.OK, lines.join("\n"));
      assert.deepStrictEqual(fs.readdirSync(tmp).sort(), before, "no --apply: nothing removed");

      const unlinked = [];
      lines.length = 0;
      assert.strictEqual(run(["--prune-backups", "--keep", "1", "--apply"],
        { unlink: (f) => { unlinked.push(path.basename(f)); fs.unlinkSync(f); } }), compact.EXIT.OK, lines.join("\n"));
      assert.deepStrictEqual(unlinked.sort(), ["world.sqlite.pre-compact-20261001-000000Z",
        "world.sqlite.pre-compact-20261002-000000Z"], "keep 1: the newest pre-compact (the real one) and pre-reset stay");

      lines.length = 0;
      assert.strictEqual(run(["--prune-backups", "--keep", "0", "--apply"], { unlink: () => { throw new Error("EBUSY"); } }),
        compact.EXIT.FAILED, "a failed unlink -> exit 3");
      assert.strictEqual(run(["--prune-backups", "--keep", "0", "--apply"]), compact.EXIT.OK, lines.join("\n"));
      assert.deepStrictEqual(fs.readdirSync(tmp).sort(), ["backups", "world-20261004-000000Z.sqlite", "world.sqlite",
        "world.sqlite.pre-compact-20261001-000000Z-wal"], "only pre-compact/pre-reset copies removed");
      assert.deepStrictEqual(fs.readdirSync(path.join(tmp, "backups")), ["world-20261005-000000Z.sqlite"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test(statsName, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-rs-"));
    const file = path.join(tmp, "world.sqlite");
    const lines = [];
    try {
      seedDbFile(driver, file, { migrations: MIGRATIONS, seed: 1 });
      const setup = new driver.Database(file);
      insertEvent(setup, "strategy:review:500000:3", "FACTION_STRATEGY_REVIEW", "DONE", "{\"a\":1}");
      insertEvent(setup, "strategy:review:500000:4", "FACTION_STRATEGY_REVIEW", "DONE", "{\"a\":22}");
      insertEvent(setup, "strategy:review:500000:5", "FACTION_STRATEGY_REVIEW", "PENDING", "{}");
      insertEvent(setup, `arrival:${FLEET}:2`, "FLEET_ARRIVAL", "DONE", "{\"x\":\"abcdef\"}");
      insertEvent(setup, "trade:offer:7", "TRADE_OFFER_EXPIRE", "DONE", "{}");
      insertJournal(setup, "strategy:review:500000:3:touch", "APPLY", "APPLIED", "{\"t\":1}");
      insertJournal(setup, `arrival:${FLEET}:2`, "OUTBOX", "PENDING", "{}");
      setup.close();

      const before = sha256(file);
      const opened = new driver.Database(file);
      let result;
      try {
        result = stats.collectStats(opened);
      } finally {
        opened.close();
      }
      const find = (table, prefix, state, eventType) => result.groups.filter((g) => g.table === table
        && g.prefix === prefix && g.state === state && (eventType === undefined || g.eventType === eventType));
      const review = find("events", "strategy:review:", "DONE", "FACTION_STRATEGY_REVIEW");
      assert.deepStrictEqual(review.map((g) => [g.classId, g.rows, g.bytes]), [["strategy-review", 2, 7 + 8]]);
      assert.deepStrictEqual(find("events", "strategy:review:", "PENDING").map((g) => [g.classId, g.rows]),
        [["strategy-review", 1]]);
      assert.deepStrictEqual(find("events", "arrival:", "DONE").map((g) => [g.classId, g.rows, g.bytes]),
        [["fleet-arrival", 1, 14]]);
      assert.deepStrictEqual(find("events", "trade:offer:", "DONE").map((g) => g.classId), [stats.NO_CLASS]);
      assert.deepStrictEqual(find("journal", "strategy:review:", "APPLY/APPLIED").map((g) => [g.classId, g.rows]),
        [["journal-review-intent", 1]]);
      assert.deepStrictEqual(find("journal", "arrival:", "OUTBOX/PENDING").map((g) => g.classId), [stats.NO_CLASS],
        "OUTBOX never belongs to a journal class");
      assert.strictEqual(result.totals.events.rows, 5);
      assert.strictEqual(result.totals.events.classRows, 4);
      assert.strictEqual(result.totals.journal.classRows, 1);
      for (let i = 1; i < result.groups.length; i += 1) {
        assert.ok(result.groups[i - 1].bytes >= result.groups[i].bytes, "sorted by bytes, descending");
      }

      const listBefore = fs.readdirSync(tmp).sort();
      assert.deepStrictEqual(listBefore, ["world.sqlite"]);
      assert.strictEqual(stats.main({ argv: ["--db", file], env: {}, driver, print: (l) => lines.push(l) }),
        stats.EXIT.OK, lines.join("\n"));
      assert.ok(lines.some((l) => l.startsWith("events") && l.includes("strategy-review")), lines.join("\n"));
      assert.strictEqual(sha256(file), before, "retentionStats must not change the file");
      assert.deepStrictEqual(fs.readdirSync(tmp).sort(), listBefore, "No new -wal/-shm next to the database");

      const crashDir = path.join(tmp, "crash");
      fs.mkdirSync(crashDir);
      const crash = path.join(crashDir, "world.sqlite");
      const writer = new driver.Database(file);
      try {
        writer.pragma("wal_autocheckpoint = 0");
        insertEvent(writer, "strategy:review:500000:9", "FACTION_STRATEGY_REVIEW", "DONE", "{}");
        fs.copyFileSync(file, crash);
        fs.copyFileSync(`${file}-wal`, `${crash}-wal`);
      } finally {
        writer.close();
      }
      const crashList = fs.readdirSync(crashDir).sort();
      const walSha = sha256(`${crash}-wal`);
      assert.ok(fs.statSync(`${crash}-wal`).size > 0, "crash image has WAL frames");
      lines.length = 0;
      assert.strictEqual(stats.main({ argv: ["--db", crash], env: {}, driver, print: (l) => lines.push(l) }),
        stats.EXIT.OK, lines.join("\n"));
      assert.ok(lines.some((l) => l.startsWith("events") && l.includes("rows 6,")), `WAL frames read\n${lines.join("\n")}`);
      assert.deepStrictEqual(fs.readdirSync(crashDir).sort(), crashList, "crash -wal kept, no new side files");
      assert.strictEqual(sha256(`${crash}-wal`), walSha, "crash -wal unchanged");

      lines.length = 0;
      withLockHolder(driver, file, () => {
        assert.strictEqual(stats.main({ argv: ["--db", file], env: {}, driver, print: (l) => lines.push(l) }),
          stats.EXIT.REFUSED, lines.join("\n"));
      });
      assert.ok(lines.some((l) => l.startsWith("REFUSED")), lines.join("\n"));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  test(compactName, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-cw-"));
    const file = path.join(tmp, "world.sqlite");
    const lines = [];
    const run = (...argv) => compact.main({ argv: ["--db", file, ...argv], env: {}, now: () => NOW, driver,
      print: (l) => lines.push(l) });
    try {
      seedDbFile(driver, file, { migrations: MIGRATIONS, seed: 1 });
      const setup = new driver.Database(file);
      const big = JSON.stringify({ blob: "x".repeat(4000) });
      setup.exec("BEGIN");
      for (let i = 0; i < 300; i += 1) insertEvent(setup, `strategy:review:500000:${i}`, "FACTION_STRATEGY_REVIEW", "DONE", big);
      setup.exec("COMMIT");
      setup.exec("DELETE FROM world_scheduled_events");
      setup.close();

      const before = sha256(file);
      const sizeBefore = fs.statSync(file).size;
      assert.strictEqual(run(), compact.EXIT.OK, lines.join("\n"));
      assert.strictEqual(sha256(file), before, "dry-run must not change the file");
      assert.ok(lines.some((l) => l.startsWith("DRY-RUN")), lines.join("\n"));
      const backup = path.join(tmp, compact.backupNameOf(file, NOW));
      assert.strictEqual(path.basename(backup), "world.sqlite.pre-compact-20261029-102030Z");
      assert.strictEqual(fs.existsSync(backup), false);

      lines.length = 0;
      withLockHolder(driver, file, () => {
        assert.strictEqual(run("--apply"), compact.EXIT.REFUSED, lines.join("\n"));
      });
      assert.ok(lines.some((l) => l.startsWith("REFUSED")), lines.join("\n"));
      assert.strictEqual(fs.existsSync(backup), false, "no backup when refused");

      lines.length = 0;
      const normal = new driver.Database(file);
      try {
        normal.prepare("SELECT count(*) AS n FROM sqlite_master").get();
        assert.strictEqual(run("--apply"), compact.EXIT.REFUSED, lines.join("\n"));
      } finally {
        normal.close();
      }
      assert.ok(lines.some((l) => l.startsWith("REFUSED")), lines.join("\n"));
      assert.strictEqual(fs.existsSync(backup), false, "no backup when refused (NORMAL lock)");

      lines.length = 0;
      assert.strictEqual(run("--apply"), compact.EXIT.OK, lines.join("\n"));
      assert.ok(fs.existsSync(backup), "backup written");
      assert.ok(lines.some((l) => l.includes("quick_check ok")), lines.join("\n"));
      const sizeAfter = fs.statSync(file).size;
      assert.ok(sizeAfter < sizeBefore - 300 * 2048, `file smaller: ${sizeBefore} -> ${sizeAfter}`);
      assert.strictEqual(fs.existsSync(`${file}-wal`) ? fs.statSync(`${file}-wal`).size : 0, 0, "WAL truncated");

      lines.length = 0;
      assert.strictEqual(run("--apply"), compact.EXIT.REFUSED, "backup of the same name exists");
      assert.strictEqual(run("--dry-run", "--apply"), compact.EXIT.USAGE);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
};
