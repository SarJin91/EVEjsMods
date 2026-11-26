"use strict";

const path = require("node:path");
const nodeFs = require("node:fs");

const UI_PREFS_FILE_NAME = "wingUiPrefs.json";
const SCHEMA_VERSION = 1;
const BOM_CODE = 0xfeff;
const STORE_COUNTER_NAMES = Object.freeze([
  "uiPrefs.store.write.ok", "uiPrefs.store.write.failed", "uiPrefs.store.load.corrupt",
  "uiPrefs.store.entry.dropped", "uiPrefs.store.full",
]);

function isObj(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function posInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function createUiPrefsStore(deps) {
  const fsApi = (deps && deps.fs) || nodeFs;
  const now = deps && typeof deps.now === "function" ? deps.now : () => Date.now();
  const filePath = deps && deps.filePath;
  const maxPilots = deps && posInt(deps.maxPilots) ? deps.maxPilots : 0;
  const pilots = new Set();
  const counters = Object.fromEntries(STORE_COUNTER_NAMES.map((name) => [name, 0]));
  let dirty = false;
  let readOnly = false;

  function bump(name, by = 1) {
    counters[name] += by;
  }

  function serialize() {
    const ids = [...pilots].sort((a, b) => a - b);
    const out = {};
    for (const id of ids) out[String(id)] = { openAtLogin: true };
    return `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, pilots: out }, null, 2)}\n`;
  }

  function write() {
    const tmp = `${filePath}.tmp`;
    try {
      if (typeof filePath !== "string" || filePath === "") throw new Error("no ui prefs file path");
      fsApi.mkdirSync(path.dirname(filePath), { recursive: true });
      const fd = fsApi.openSync(tmp, "w");
      try {
        fsApi.writeFileSync(fd, serialize());
        fsApi.fsyncSync(fd);
      } finally {
        fsApi.closeSync(fd);
      }
      fsApi.renameSync(tmp, filePath);
      bump("uiPrefs.store.write.ok");
      return { ok: true };
    } catch (_err) {
      bump("uiPrefs.store.write.failed");
      return { ok: false, reason: "WRITE_FAILED" };
    }
  }

  function quarantine(reason) {
    bump("uiPrefs.store.load.corrupt");
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
    for (const [key, entry] of Object.entries(parsed.pilots)) {
      const id = Number(key);
      if (!posInt(id) || String(id) !== key || !isObj(entry) || entry.openAtLogin !== true
        || pilots.size >= maxPilots) {
        dropped += 1;
        continue;
      }
      pilots.add(id);
    }
    if (dropped > 0) {
      bump("uiPrefs.store.entry.dropped", dropped);
      dirty = true;
    }
    return { ok: true, dropped };
  }

  function load() {
    return { ...loadInner(), readOnly };
  }

  function get(charId) {
    return pilots.has(Number(charId));
  }

  function set(charId, on) {
    const id = Number(charId);
    if (!posInt(id) || typeof on !== "boolean") return { ok: false, reason: "INVALID" };
    const persisted = !readOnly;
    if (!on) {
      if (!pilots.delete(id)) return { ok: true, changed: false, persisted };
      dirty = true;
      return { ok: true, changed: true, persisted };
    }
    if (pilots.has(id)) return { ok: true, changed: false, persisted };
    if (pilots.size >= maxPilots) {
      bump("uiPrefs.store.full");
      return { ok: false, reason: "FULL" };
    }
    pilots.add(id);
    dirty = true;
    return { ok: true, changed: true, persisted };
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

module.exports = { UI_PREFS_FILE_NAME, SCHEMA_VERSION, STORE_COUNTER_NAMES, createUiPrefsStore };
