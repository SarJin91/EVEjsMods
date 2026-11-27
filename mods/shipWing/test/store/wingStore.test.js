"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createWingStore, migrate, SCHEMA_VERSION, LOSS_DEFAULTS } = require("../../lib/store/wingStore");

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipwing-store-"));
  return { dir, file: path.join(dir, "mods", "shipWing", "wings.json") };
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_err) {
  }
}

function rec(shipItemId, state, extra = {}) {
  return {
    shipItemId, ownerCharacterId: 90000001, hostShipId: 1000000400, systemId: 30000142,
    sceneKey: "system:30000142", shipTypeId: 22544, twinEntityId: state === "LAUNCHING" ? 0 : 4.2e15 + shipItemId,
    state, version: 1, fitDigest: "abc", launchedAtMs: 1000, stateChangedAtMs: 1000, reason: null, ...extra,
  };
}

module.exports = ({ test }) => {
  test("WS1 write/read round trip, atomic (no tmp left), failed write restores memory", () => {
    const { dir, file } = tempFile();
    try {
      const store = createWingStore({ filePath: file });
      assert.deepStrictEqual(store.load(), { ok: true, count: 0, dropped: 0, recovered: null, readOnly: false });
      assert.deepStrictEqual(store.put(rec(502, "ACTIVE")), { ok: true });
      assert.deepStrictEqual(store.put(rec(501, "LAUNCHING")), { ok: true });
      assert.ok(!fs.existsSync(`${file}.tmp`), "tmp renamed away");
      const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
      assert.strictEqual(onDisk.schemaVersion, SCHEMA_VERSION);
      assert.deepStrictEqual(onDisk.records.map((r) => r.shipItemId), [501, 502]);
      const again = createWingStore({ filePath: file });
      assert.strictEqual(again.load().count, 2);
      assert.deepStrictEqual(again.get(502), rec(502, "ACTIVE"));
      assert.deepStrictEqual(again.list(), [rec(501, "LAUNCHING"), rec(502, "ACTIVE")]);
      const brokenFs = { ...fs, renameSync: () => { throw new Error("disk full"); } };
      const broken = createWingStore({ filePath: file, fs: brokenFs });
      broken.load();
      const refused = broken.put(rec(503, "LAUNCHING"));
      assert.strictEqual(refused.ok, false);
      assert.strictEqual(refused.reason, "STORE_WRITE_FAILED");
      assert.strictEqual(broken.get(503), null);
      assert.strictEqual(broken.stats().counters["store.write.failed"], 1);
    } finally {
      cleanup(dir);
    }
  });

  test("WS2 bootSweep: LAUNCHING/ACTIVE/RETURNING cleared (RESTART), LOST kept; second sweep cleared 0", () => {
    const { dir, file } = tempFile();
    try {
      const first = createWingStore({ filePath: file });
      first.load();
      for (const r of [rec(1, "LAUNCHING"), rec(2, "ACTIVE"), rec(3, "RETURNING"), rec(4, "LOST")]) first.put(r);
      const store = createWingStore({ filePath: file });
      assert.strictEqual(store.load().count, 4);
      const swept = store.bootSweep();
      assert.deepStrictEqual(swept, { ok: true, cleared: 3, keptLost: 1, reason: null, endReason: "RESTART" });
      assert.deepStrictEqual(store.list().map((r) => [r.shipItemId, r.state]), [[4, "LOST"]]);
      const writes = store.stats().counters["store.write.ok"];
      const second = store.bootSweep();
      assert.strictEqual(second.cleared, 0);
      assert.strictEqual(second.keptLost, 1);
      assert.strictEqual(store.stats().counters["store.write.ok"], writes, "second sweep writes nothing");
      const reloaded = createWingStore({ filePath: file });
      reloaded.load();
      assert.deepStrictEqual(reloaded.list().map((r) => r.state), ["LOST"]);
    } finally {
      cleanup(dir);
    }
  });

  test("WS3 corrupt JSON -> moved to .corrupt-<ms>, empty state", () => {
    const { dir, file } = tempFile();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "{ not json");
      const store = createWingStore({ filePath: file, now: () => 12345 });
      const loaded = store.load();
      assert.strictEqual(loaded.count, 0);
      assert.deepStrictEqual(loaded.recovered, { reason: "bad_json", movedTo: `${file}.corrupt-12345` });
      assert.ok(fs.existsSync(`${file}.corrupt-12345`));
      assert.ok(!fs.existsSync(file));
      assert.deepStrictEqual(store.list(), []);
      assert.strictEqual(store.stats().counters["store.load.corrupt"], 1);
    } finally {
      cleanup(dir);
    }
  });

  test("WS4 schemaVersion from the future -> rejected (.corrupt-*), v1 migrates to v2 (loss fields)",
    () => {
    const { dir, file } = tempFile();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ schemaVersion: SCHEMA_VERSION + 1, records: [rec(7, "LOST")] }));
      const store = createWingStore({ filePath: file, now: () => 777 });
      const loaded = store.load();
      assert.strictEqual(loaded.count, 0);
      assert.strictEqual(loaded.recovered.reason, "future_version");
      assert.ok(fs.existsSync(`${file}.corrupt-777`));
      const v1 = { schemaVersion: 1, records: [rec(7, "LOST")] };
      assert.deepStrictEqual(migrate(v1), { ok: true,
        file: { schemaVersion: 2, records: [{ ...LOSS_DEFAULTS, ...rec(7, "LOST") }] } });
      assert.strictEqual(SCHEMA_VERSION, 2);
      assert.deepStrictEqual(migrate({ schemaVersion: 0, records: [] }), { ok: false, reason: "bad_version" });
    } finally {
      cleanup(dir);
    }
  });

  test("WS5 read fails AND rename fails -> read-only: put/remove/bootSweep refused "
    + "file bytes unchanged", () => {
    const { dir, file } = tempFile();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, records: [rec(7, "LOST")] }));
      const before = fs.readFileSync(file);
      let busy = true;
      const flaky = { ...fs,
        readFileSync: (...a) => {
          if (busy) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
          return fs.readFileSync(...a);
        },
        renameSync: (...a) => {
          if (busy) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
          return fs.renameSync(...a);
        } };
      const store = createWingStore({ filePath: file, fs: flaky, now: () => 55 });
      const loaded = store.load();
      assert.strictEqual(loaded.recovered.movedTo, null);
      assert.strictEqual(loaded.readOnly, true);
      busy = false;
      assert.deepStrictEqual(store.put(rec(8, "LAUNCHING")),
        { ok: false, reason: "STORE_WRITE_FAILED", readOnly: true });
      assert.strictEqual(store.get(8), null);
      assert.strictEqual(store.remove(7).reason, "STORE_WRITE_FAILED");
      const swept = store.bootSweep();
      assert.deepStrictEqual([swept.ok, swept.reason, swept.cleared], [false, "STORE_WRITE_FAILED", 0]);
      assert.ok(fs.readFileSync(file).equals(before), "state file bytes unchanged");
      assert.ok(!fs.existsSync(`${file}.tmp`));
      assert.strictEqual(store.stats().counters["store.write.readOnly"], 3);
      assert.strictEqual(store.isReadOnly(), true);
    } finally {
      cleanup(dir);
    }
  });

  test("WS6 dropped records -> original copied to .corrupt-<ms> before any write", () => {
    const { dir, file } = tempFile();
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const text = JSON.stringify({ schemaVersion: 1, records: [rec(7, "LOST"), { shipItemId: "bad" }] });
      fs.writeFileSync(file, text);
      const store = createWingStore({ filePath: file, now: () => 99 });
      const loaded = store.load();
      assert.deepStrictEqual([loaded.count, loaded.dropped, loaded.backedUpTo, loaded.readOnly],
        [1, 1, `${file}.corrupt-99`, false]);
      assert.strictEqual(fs.readFileSync(`${file}.corrupt-99`, "utf8"), text);
      assert.strictEqual(store.put(rec(8, "ACTIVE")).ok, true);
      assert.strictEqual(fs.readFileSync(`${file}.corrupt-99`, "utf8"), text, "the copy survives the write");
      fs.writeFileSync(file, text);
      const noCopyFs = { ...fs, copyFileSync: () => { throw new Error("EACCES"); } };
      const noCopy = createWingStore({ filePath: file, fs: noCopyFs });
      assert.strictEqual(noCopy.load().readOnly, true);
      assert.strictEqual(noCopy.put(rec(9, "ACTIVE")).reason, "STORE_WRITE_FAILED");
    } finally {
      cleanup(dir);
    }
  });
};
