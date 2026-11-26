"use strict";

const path = require("node:path");
const nodeFs = require("node:fs");

const JOURNAL_FILE_NAME = "wingDrones.json";
const SCHEMA_VERSION = 1;
const BOM_CODE = 0xfeff;
const JOURNAL_COUNTER_NAMES = Object.freeze([
  "drone.journal.write.ok", "drone.journal.write.failed", "drone.journal.load.corrupt",
  "drone.journal.entry.dropped",
]);

function isObj(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function posInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validEntry(entry) {
  return isObj(entry) && posInt(entry.droneId) && posInt(entry.shipItemId) && posInt(entry.ownerCharacterId)
    && posInt(entry.systemId) && Number.isFinite(entry.launchedAtMs) && entry.launchedAtMs >= 0;
}

function pickEntry(entry) {
  return { droneId: entry.droneId, shipItemId: entry.shipItemId, ownerCharacterId: entry.ownerCharacterId,
    systemId: entry.systemId, launchedAtMs: entry.launchedAtMs };
}

function createDroneJournal(deps) {
  const fsApi = (deps && deps.fs) || nodeFs;
  const now = (deps && typeof deps.now === "function") ? deps.now : () => Date.now();
  const filePath = deps && deps.filePath;
  const entries = new Map();
  const counters = Object.fromEntries(JOURNAL_COUNTER_NAMES.map((name) => [name, 0]));
  let dirty = false;
  let readOnly = false;

  function bump(name, by = 1) {
    counters[name] += by;
  }

  function serialize() {
    const drones = [...entries.values()].sort((a, b) => a.droneId - b.droneId);
    return `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, drones }, null, 2)}\n`;
  }

  function write() {
    const tmp = `${filePath}.tmp`;
    try {
      if (typeof filePath !== "string" || filePath === "") throw new Error("no journal file path");
      fsApi.mkdirSync(path.dirname(filePath), { recursive: true });
      const fd = fsApi.openSync(tmp, "w");
      try {
        fsApi.writeFileSync(fd, serialize());
        fsApi.fsyncSync(fd);
      } finally {
        fsApi.closeSync(fd);
      }
      fsApi.renameSync(tmp, filePath);
      bump("drone.journal.write.ok");
      return { ok: true };
    } catch (err) {
      bump("drone.journal.write.failed");
      return { ok: false, reason: "JOURNAL_WRITE_FAILED", error: String((err && err.message) || err) };
    }
  }

  function quarantine(reason) {
    bump("drone.journal.load.corrupt");
    const movedTo = `${filePath}.corrupt-${now()}`;
    try {
      fsApi.renameSync(filePath, movedTo);
      return { reason, movedTo };
    } catch (err) {
      readOnly = true;
      return { reason, movedTo: null, error: String((err && err.message) || err) };
    }
  }

  function loadInner() {
    entries.clear();
    dirty = false;
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
      const raw = String(text);
      parsed = JSON.parse(raw.charCodeAt(0) === BOM_CODE ? raw.slice(1) : raw);
    } catch (_err) {
      return { ok: true, count: 0, dropped: 0, recovered: quarantine("bad_json") };
    }
    if (!isObj(parsed) || !Array.isArray(parsed.drones)) {
      return { ok: true, count: 0, dropped: 0, recovered: quarantine("bad_shape") };
    }
    if (!posInt(parsed.schemaVersion)) return { ok: true, count: 0, dropped: 0, recovered: quarantine("bad_version") };
    if (parsed.schemaVersion > SCHEMA_VERSION) {
      return { ok: true, count: 0, dropped: 0, recovered: quarantine("future_version") };
    }
    let dropped = 0;
    for (const entry of parsed.drones) {
      if (!validEntry(entry) || entries.has(entry.droneId)) {
        dropped += 1;
        continue;
      }
      entries.set(entry.droneId, pickEntry(entry));
    }
    if (dropped > 0) {
      bump("drone.journal.entry.dropped", dropped);
      dirty = true;
    }
    return { ok: true, count: entries.size, dropped, recovered: null };
  }

  function load() {
    return { ...loadInner(), readOnly };
  }

  function add(entry) {
    if (!validEntry(entry)) return { ok: false, reason: "BAD_ENTRY" };
    entries.set(entry.droneId, pickEntry(entry));
    dirty = true;
    return { ok: true };
  }

  function remove(droneId) {
    if (!entries.delete(droneId)) return { ok: true, removed: false };
    dirty = true;
    return { ok: true, removed: true };
  }

  function removeShip(shipItemId) {
    let removed = 0;
    for (const [droneId, e] of [...entries]) {
      if (e.shipItemId !== shipItemId) continue;
      entries.delete(droneId);
      removed += 1;
    }
    if (removed > 0) dirty = true;
    return { ok: true, removed };
  }

  function flush() {
    if (!dirty) return { ok: true, written: false };
    if (readOnly) return { ok: false, reason: "JOURNAL_READ_ONLY" };
    const written = write();
    if (!written.ok) return written;
    dirty = false;
    return { ok: true, written: true };
  }

  function list() {
    return [...entries.values()].sort((a, b) => a.droneId - b.droneId).map((e) => ({ ...e }));
  }

  function stats() {
    return { entries: entries.size, dirty, readOnly, counters: { ...counters } };
  }

  return { filePath, load, add, remove, removeShip, flush, list, has: (id) => entries.has(id), stats };
}

module.exports = { JOURNAL_FILE_NAME, SCHEMA_VERSION, JOURNAL_COUNTER_NAMES, createDroneJournal };
