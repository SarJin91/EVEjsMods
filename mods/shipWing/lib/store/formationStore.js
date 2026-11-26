"use strict";

const path = require("node:path");
const nodeFs = require("node:fs");

const FORMATION_FILE_NAME = "wingFormations.json";
const SCHEMA_VERSION = 1;
const NONE = "none";
const BOM_CODE = 0xfeff;
const STORE_COUNTER_NAMES = Object.freeze([
  "formation.store.write.ok", "formation.store.write.failed", "formation.store.load.corrupt",
  "formation.store.entry.dropped", "formation.store.full",
]);

function isObj(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function posInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function createFormationStore(deps) {
  const fsApi = (deps && deps.fs) || nodeFs;
  const now = deps && typeof deps.now === "function" ? deps.now : () => Date.now();
  const filePath = deps && deps.filePath;
  const maxPilots = deps && posInt(deps.maxPilots) ? deps.maxPilots : 0;
  const isKnownDep = deps && typeof deps.isKnown === "function" ? deps.isKnown : () => false;
  const pilots = new Map();
  const counters = Object.fromEntries(STORE_COUNTER_NAMES.map((name) => [name, 0]));
  let dirty = false;
  let readOnly = false;

  function bump(name, by = 1) {
    counters[name] += by;
  }

  function storable(name) {
    if (typeof name !== "string" || name === NONE) return false;
    try {
      return isKnownDep(name) === true;
    } catch (_err) {
      return false;
    }
  }

  function serialize() {
    const ids = [...pilots.keys()].sort((a, b) => a - b);
    const out = {};
    for (const id of ids) out[String(id)] = pilots.get(id);
    return `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, pilots: out }, null, 2)}\n`;
  }

  function write() {
    const tmp = `${filePath}.tmp`;
    try {
      if (typeof filePath !== "string" || filePath === "") throw new Error("no formation file path");
      fsApi.mkdirSync(path.dirname(filePath), { recursive: true });
      const fd = fsApi.openSync(tmp, "w");
      try {
        fsApi.writeFileSync(fd, serialize());
        fsApi.fsyncSync(fd);
      } finally {
        fsApi.closeSync(fd);
      }
      fsApi.renameSync(tmp, filePath);
      bump("formation.store.write.ok");
      return { ok: true };
    } catch (_err) {
      bump("formation.store.write.failed");
      return { ok: false, reason: "WRITE_FAILED" };
    }
  }

  function quarantine(reason) {
    bump("formation.store.load.corrupt");
    const movedTo = `${filePath}.corrupt-${now()}`;
    try {
      fsApi.renameSync(filePath, movedTo);
      return { reason, movedTo };
    } catch (_err) {
      readOnly = true;
      return { reason, movedTo: null };
    }
  }

  function loadInner() {
    pilots.clear();
    dirty = false;
    readOnly = false;
    let text;
    try {
      text = fsApi.readFileSync(filePath, "utf8");
    } catch (err) {
      if (err && err.code === "ENOENT") return { ok: true, dropped: 0 };
      return { ok: true, dropped: 0, recovered: quarantine("read_failed") };
    }
    let parsed;
    try {
      const raw = String(text);
      parsed = JSON.parse(raw.charCodeAt(0) === BOM_CODE ? raw.slice(1) : raw);
    } catch (_err) {
      return { ok: true, dropped: 0, recovered: quarantine("bad_json") };
    }
    if (!isObj(parsed) || !isObj(parsed.pilots)) return { ok: true, dropped: 0, recovered: quarantine("bad_shape") };
    if (!posInt(parsed.schemaVersion)) return { ok: true, dropped: 0, recovered: quarantine("bad_version") };
    if (parsed.schemaVersion > SCHEMA_VERSION) return { ok: true, dropped: 0, recovered: quarantine("future_version") };
    let dropped = 0;
    for (const [key, name] of Object.entries(parsed.pilots)) {
      const id = Number(key);
      if (!posInt(id) || String(id) !== key || !storable(name) || pilots.size >= maxPilots) {
        dropped += 1;
        continue;
      }
      pilots.set(id, name);
    }
    if (dropped > 0) {
      bump("formation.store.entry.dropped", dropped);
      dirty = true;
    }
    return { ok: true, dropped };
  }

  function load() {
    return { ...loadInner(), readOnly };
  }

  function get(charId) {
    return pilots.get(Number(charId)) || NONE;
  }

  function set(charId, name) {
    const id = Number(charId);
    if (!posInt(id)) return { ok: false, reason: "INVALID" };
    if (readOnly) return { ok: false, reason: "READ_ONLY" };
    if (name === NONE) {
      if (!pilots.delete(id)) return { ok: true, changed: false };
      dirty = true;
      return { ok: true, changed: true };
    }
    if (!storable(name)) return { ok: false, reason: "INVALID" };
    if (pilots.get(id) === name) return { ok: true, changed: false };
    if (!pilots.has(id) && pilots.size >= maxPilots) {
      bump("formation.store.full");
      return { ok: false, reason: "FULL" };
    }
    pilots.set(id, name);
    dirty = true;
    return { ok: true, changed: true };
  }

  function flush() {
    if (!dirty) return { ok: true, written: false };
    if (readOnly) return { ok: false, reason: "READ_ONLY" };
    const written = write();
    if (!written.ok) return written;
    dirty = false;
    return { ok: true, written: true };
  }

  function stats() {
    return { pilots: pilots.size, dirty, readOnly, counters: { ...counters } };
  }

  return { filePath, load, get, set, flush, stats, isDirty: () => dirty, isReadOnly: () => readOnly };
}

module.exports = { FORMATION_FILE_NAME, SCHEMA_VERSION, STORE_COUNTER_NAMES, createFormationStore };
