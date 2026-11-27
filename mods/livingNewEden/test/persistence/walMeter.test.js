"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { openStore } = require("../../lib/persistence/store");
const { createWalMeter } = require("../../lib/persistence/walMeter");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const WAL_HEADER = 32;
const FRAME_HEADER = 24;

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function walSize(file) {
  const st = fs.statSync(`${file}-wal`, { throwIfNoEntry: false });
  return st ? st.size : 0;
}

function withTmp(prefix, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  try {
    return fn(tmp);
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (_err) {
    }
  }
}

function walCycle(driver, file, limit) {
  const db = new driver.Database(file);
  try {
    db.pragma("locking_mode = EXCLUSIVE");
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = NORMAL");
    db.pragma("wal_autocheckpoint = 10000");
    if (limit) db.pragma("journal_size_limit = 0");
    const frameBytes = Number(db.pragma("page_size", { simple: true })) + FRAME_HEADER;
    db.exec("CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)");
    const ins = db.prepare("INSERT INTO t(v) VALUES (?)");
    const tx = db.transaction((n) => {
      for (let i = 0; i < n; i += 1) ins.run("x".repeat(500));
    });
    tx(200);
    const before = walSize(file);
    const ck = db.pragma("wal_checkpoint(PASSIVE)")[0];
    tx(1);
    const afterSmall = walSize(file);
    tx(3);
    return { frameBytes, before, ck, afterSmall, afterNext: walSize(file) };
  } finally {
    db.close();
  }
}

function openTestStore(driver, file, extra) {
  const r = openStore({ filePath: file, exclusiveLock: true, busyTimeoutMs: 0, maxRowsPerTransaction: 500,
    maxWriteMsPerPass: 5, randomSeed: () => 1, migrations: MIGRATIONS.slice(0, 1),
    openDatabase: (f) => new driver.Database(f), ...extra });
  assert.ok(r.ok, JSON.stringify(r));
  return r.store;
}

module.exports = ({ test, skip }) => {
  test("WM1 SQLite fact: journal_size_limit 0 truncates -wal to its frames at the first commit after a reset", () => {
    const driver = loadDriver();
    if (!driver.ok) return skip("WM1 walMeter", `no sqlite driver: ${driver.detail}`);
    withTmp("lne-wm1-", (tmp) => {
      const on = walCycle(driver, path.join(tmp, "on.sqlite"), true);
      assert.strictEqual(on.ck.busy, 0);
      assert.strictEqual(on.ck.checkpointed, on.ck.log, "complete checkpoint");
      const k = (on.afterSmall - WAL_HEADER) / on.frameBytes;
      assert.ok(Number.isInteger(k) && k >= 1, `after the reset: ${on.afterSmall} = 32 + k x ${on.frameBytes}, k=${k}`);
      assert.ok(on.afterSmall < on.before, `truncated (${on.afterSmall} < ${on.before})`);
      const grow = (on.afterNext - on.afterSmall) / on.frameBytes;
      assert.ok(Number.isInteger(grow) && grow >= 1, `next commit +${grow} frames`);

      const off = walCycle(driver, path.join(tmp, "off.sqlite"), false);
      assert.strictEqual(off.afterSmall, off.before, "without the pragma the -wal file keeps its high-water size");
      assert.strictEqual(off.afterNext, off.before);
    });
  });

  test("WM2 walMeter: uncalibrated null, reset pending, absolute value, deltas, unexpected reset, stat failures", () => {
    const P = 4096;
    const F = P + FRAME_HEADER;
    const size = (frames) => WAL_HEADER + frames * F;
    let next = size(29);
    const meter = createWalMeter({ statBytes: () => (typeof next === "function" ? next() : next), pageSize: P });
    assert.strictEqual(meter.afterTx(), null, "before the first complete checkpoint");
    assert.deepStrictEqual(meter.status(), { calibrated: false, frameBytes: F, statFailed: 0, unexpectedResets: 0 });
    meter.onCheckpoint(false);
    assert.strictEqual(meter.afterTx(), null, "an incomplete checkpoint does not calibrate");
    meter.onCheckpoint(true);
    assert.strictEqual(meter.afterTx(), 0, "no write: the old length stays, the reset still waits");
    next = size(3);
    assert.strictEqual(meter.afterTx(), 3, "first write after the reset = absolute value");
    next = size(4);
    assert.strictEqual(meter.afterTx(), 1, "then deltas");
    assert.strictEqual(meter.afterTx(), 0);
    next = size(2);
    assert.strictEqual(meter.afterTx(), 2, "a shrinking file without a checkpoint = unexpected reset");
    assert.strictEqual(meter.status().unexpectedResets, 1);
    next = () => {
      throw new Error("EIO");
    };
    assert.strictEqual(meter.afterTx(), null);
    next = null;
    assert.strictEqual(meter.afterTx(), null);
    assert.strictEqual(meter.status().statFailed, 2);
    next = size(5);
    assert.strictEqual(meter.afterTx(), 3, "after a failed stat the delta continues from the last good size");
    assert.strictEqual(meter.status().calibrated, true);
    next = 20;
    meter.onCheckpoint(true);
    assert.strictEqual(meter.afterTx(), 0, "a size below one frame = 0 frames");
    assert.throws(() => createWalMeter({ statBytes: () => 0, pageSize: 0 }), RangeError);
  });

  test("WM3 store walPerTx: 7th onTiming argument, labelTx, getWalStatus().perTx; off = 6 arguments, limit -1", () => {
    const driver = loadDriver();
    if (!driver.ok) return skip("WM3 walMeter", `no sqlite driver: ${driver.detail}`);
    withTmp("lne-wm3-", (tmp) => {
      const calls = [];
      const onTiming = (...args) => calls.push(args);
      const store = openTestStore(driver, path.join(tmp, "on.sqlite"), { walPerTx: true, onTiming });
      const txArgs = () => calls.filter((a) => a[2] !== undefined && a[0] !== "wal.checkpoint");
      try {
        let insideLabel;
        let badLabel;
        const r1 = store.transaction("wm.setup", (db) => {
          db.exec("CREATE TABLE wm(id INTEGER PRIMARY KEY, v TEXT)");
          insideLabel = store.labelTx("FLEET_ARRIVAL");
          badLabel = store.labelTx("bad label");
          return db.pragma("journal_size_limit", { simple: true });
        });
        assert.ok(r1.ok, JSON.stringify(r1));
        assert.strictEqual(r1.value, 0, "journal_size_limit = 0 with walPerTx");
        assert.deepStrictEqual([insideLabel, badLabel, store.labelTx("FLEET_ARRIVAL")], [true, false, false]);
        assert.deepStrictEqual(txArgs()[0][6], { frames: null, label: "FLEET_ARRIVAL" }, "uncalibrated = null");
        assert.strictEqual(store.getWalStatus().perTx.calibrated, false);

        assert.strictEqual(store.checkpoint("manual").ok, true);
        assert.strictEqual(store.getWalStatus().perTx.calibrated, true);
        const insert = (n) => store.transaction("wm.insert", (db) => {
          const ins = db.prepare("INSERT INTO wm(v) VALUES (?)");
          for (let i = 0; i < n; i += 1) ins.run("y".repeat(300));
        });
        assert.ok(insert(5).ok);
        const w1 = txArgs().at(-1)[6];
        assert.strictEqual(w1.label, null, "label reset per transaction");
        assert.ok(Number.isInteger(w1.frames) && w1.frames >= 1, JSON.stringify(w1));
        assert.ok(insert(1).ok);
        const w2 = txArgs().at(-1)[6];
        assert.ok(Number.isInteger(w2.frames) && w2.frames >= 1, JSON.stringify(w2));
        const frameBytes = store.getWalStatus().perTx.frameBytes;
        assert.strictEqual(w1.frames + w2.frames, (walSize(path.join(tmp, "on.sqlite")) - WAL_HEADER) / frameBytes,
          "frames since the reset = frames in the -wal file");
        assert.ok(store.transaction("wm.read", (db) => db.prepare("SELECT COUNT(*) AS n FROM wm").get()).ok);
        assert.strictEqual(txArgs().at(-1)[6].frames, 0, "a read writes no frame");
      } finally {
        store.close("test_cleanup");
      }

      const offCalls = [];
      const off = openTestStore(driver, path.join(tmp, "off.sqlite"), { onTiming: (...a) => offCalls.push(a) });
      try {
        const r = off.transaction("wm.off", (db) => {
          const labelled = off.labelTx("FLEET_ARRIVAL");
          return { labelled, limit: db.pragma("journal_size_limit", { simple: true }) };
        });
        assert.deepStrictEqual(r.value, { labelled: false, limit: -1 });
        const last = offCalls.at(-1);
        assert.strictEqual(last[0], "wm.off");
        assert.strictEqual(last.length, 6, "off: the hook gets the arguments of before");
        assert.strictEqual(off.getWalStatus().perTx, null);
      } finally {
        off.close("test_cleanup");
      }
    });
  });
};
