"use strict";

const path = require("node:path");
const nodeFs = require("node:fs");

const SCHEMA_VERSION = 2;
const STATES = Object.freeze(["LAUNCHING", "ACTIVE", "RETURNING", "LOST", "SETTLED"]);
const SWEPT_STATES = Object.freeze(["LAUNCHING", "ACTIVE", "RETURNING"]);
const RESTART_REASON = "RESTART";

const LOSS_DEFAULTS = Object.freeze({
  lossCause: null, lossAtMs: 0, wreckId: 0, settleAttempts: 0, nextSettleAtMs: 0, settledAtMs: 0,
  settleOutcome: null,
});

const MIGRATIONS = Object.freeze({
  1: (file) => ({
    ...file,
    schemaVersion: 2,
    records: file.records.map((r) => (isObj(r) ? { ...LOSS_DEFAULTS, ...r } : r)),
  }),
});

const COUNTER_NAMES = Object.freeze([
  "store.write.ok", "store.write.failed", "store.load.corrupt", "store.record.dropped", "store.sweep.cleared",
  "store.write.readOnly", "store.load.backup",
]);

function isObj(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function posInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function migrate(file) {
  const version = file.schemaVersion;
  if (!posInt(version)) return { ok: false, reason: "bad_version" };
  if (version > SCHEMA_VERSION) return { ok: false, reason: "future_version" };
  let current = file;
  for (let v = version; v < SCHEMA_VERSION; v += 1) {
    if (typeof MIGRATIONS[v] !== "function") return { ok: false, reason: "migration_missing" };
    current = MIGRATIONS[v](current);
  }
  return { ok: true, file: current };
}

function validRecord(record) {
  return isObj(record) && posInt(record.shipItemId) && posInt(record.ownerCharacterId)
    && STATES.includes(record.state);
}

function createWingStore(deps) {
  const fsApi = (deps && deps.fs) || nodeFs;
  const now = (deps && typeof deps.now === "function") ? deps.now : () => Date.now();
  const filePath = deps && deps.filePath;
  const records = new Map();
  const counters = Object.fromEntries(COUNTER_NAMES.map((name) => [name, 0]));
  let readOnly = false;

  function readOnlyRefusal(extra) {
    bump("store.write.readOnly");
    return { ok: false, reason: "STORE_WRITE_FAILED", readOnly: true, ...extra };
  }

  function bump(name, by = 1) {
    counters[name] += by;
  }

  function serialize() {
    const list = [...records.values()].sort((a, b) => a.shipItemId - b.shipItemId);
    return `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, records: list }, null, 2)}\n`;
  }

  function write() {
    const tmp = `${filePath}.tmp`;
    try {
      if (typeof filePath !== "string" || filePath === "") throw new Error("no state file path");
      fsApi.mkdirSync(path.dirname(filePath), { recursive: true });
      const fd = fsApi.openSync(tmp, "w");
      try {
        fsApi.writeFileSync(fd, serialize());
        fsApi.fsyncSync(fd);
      } finally {
        fsApi.closeSync(fd);
      }
      fsApi.renameSync(tmp, filePath);
      bump("store.write.ok");
      return { ok: true };
    } catch (err) {
      bump("store.write.failed");
      return { ok: false, reason: "STORE_WRITE_FAILED", error: String((err && err.message) || err) };
    }
  }

  function quarantine(reason) {
    bump("store.load.corrupt");
    const movedTo = `${filePath}.corrupt-${now()}`;
    try {
      fsApi.renameSync(filePath, movedTo);
      return { reason, movedTo };
    } catch (err) {
      readOnly = true;
      return { reason, movedTo: null, error: String((err && err.message) || err) };
    }
  }

  function backupDropped() {
    const copyTo = `${filePath}.corrupt-${now()}`;
    try {
      fsApi.copyFileSync(filePath, copyTo);
      bump("store.load.backup");
      return { backedUpTo: copyTo };
    } catch (err) {
      readOnly = true;
      return { backedUpTo: null, backupError: String((err && err.message) || err) };
    }
  }

  function load() {
    const result = loadInner();
    return { ...result, readOnly };
  }

  function loadInner() {
    records.clear();
    readOnly = false;
    let text;
    try {
      text = fsApi.readFileSync(filePath, "utf8");
    } catch (err) {
      if (err && err.code === "ENOENT") return { ok: true, count: 0, dropped: 0, recovered: null };
      return { ok: true, count: 0, dropped: 0, recovered: quarantine("read_failed") };
    }
    let parsed;
    try {
      parsed = JSON.parse(String(text).replace(/^\uFEFF/, ""));
    } catch (_err) {
      return { ok: true, count: 0, dropped: 0, recovered: quarantine("bad_json") };
    }
    if (!isObj(parsed) || !Array.isArray(parsed.records)) {
      return { ok: true, count: 0, dropped: 0, recovered: quarantine("bad_shape") };
    }
    const migrated = migrate(parsed);
    if (!migrated.ok) return { ok: true, count: 0, dropped: 0, recovered: quarantine(migrated.reason) };
    let dropped = 0;
    for (const record of migrated.file.records) {
      if (!validRecord(record) || records.has(record.shipItemId)) {
        dropped += 1;
        continue;
      }
      records.set(record.shipItemId, { ...record });
    }
    if (dropped === 0) return { ok: true, count: records.size, dropped, recovered: null };
    bump("store.record.dropped", dropped);
    return { ok: true, count: records.size, dropped, recovered: null, ...backupDropped() };
  }

  function list() {
    return [...records.values()].sort((a, b) => a.shipItemId - b.shipItemId).map((r) => ({ ...r }));
  }

  function get(shipItemId) {
    const record = records.get(shipItemId);
    return record ? { ...record } : null;
  }

  function put(record) {
    if (!validRecord(record)) return { ok: false, reason: "BAD_RECORD" };
    if (readOnly) return readOnlyRefusal();
    const previous = records.get(record.shipItemId);
    records.set(record.shipItemId, { ...record });
    const written = write();
    if (!written.ok) {
      if (previous) records.set(record.shipItemId, previous);
      else records.delete(record.shipItemId);
    }
    return written;
  }

  function remove(shipItemId) {
    if (readOnly) return readOnlyRefusal({ removed: false });
    if (!records.delete(shipItemId)) return { ok: true, removed: false };
    const written = write();
    return written.ok ? { ok: true, removed: true } : { ...written, removed: true };
  }

  function bootSweep() {
    if (readOnly) {
      const refused = readOnlyRefusal();
      return { ok: false, cleared: 0, keptLost: records.size, reason: refused.reason, endReason: RESTART_REASON };
    }
    let cleared = 0;
    let keptLost = 0;
    for (const [id, record] of [...records.entries()]) {
      if (SWEPT_STATES.includes(record.state)) {
        records.delete(id);
        cleared += 1;
      } else {
        keptLost += 1;
      }
    }
    if (cleared === 0) return { ok: true, cleared, keptLost, reason: null, endReason: RESTART_REASON };
    bump("store.sweep.cleared", cleared);
    const written = write();
    return { ok: written.ok, cleared, keptLost, reason: written.ok ? null : written.reason, endReason: RESTART_REASON };
  }

  function stats() {
    return { records: records.size, readOnly, counters: { ...counters } };
  }

  return { filePath, load, list, get, put, remove, bootSweep, stats, isReadOnly: () => readOnly };
}

module.exports = {
  SCHEMA_VERSION, STATES, SWEPT_STATES, LOSS_DEFAULTS, MIGRATIONS, COUNTER_NAMES, migrate, createWingStore,
};
