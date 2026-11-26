"use strict";

const crypto = require("node:crypto");
const { functionBody, fingerprintFunctions } = require("./essRepositoryFast");

const TELEMETRY_PATH = "services/map/mapTelemetryState";
const MAP_SERVICE_PATH = "services/map/mapService";
const EXPORT_NAME = "listJumpHistoryRows";
const FUNCTION_SHA1 = Object.freeze({
  [`${TELEMETRY_PATH}.js:listJumpHistoryRows`]: "0bc132d00c7887602703e85acf9ce8a1a4982f90",
  [`${MAP_SERVICE_PATH}.js:buildHistoryRows`]: "99cef4d72e23c38dd21e358b1fc2a5b37e50aba6",
});
const MAP_HOLDS_MODULE = ["const mapTelemetryState = require", "(path.join(__dirname, \"./mapTelemetryState\"));"]
  .join("");
const MAP_CALL = "mapTelemetryState\n        .listJumpHistoryRows(hours)";
const VENDOR_MAX_WINDOW_HOURS = 24;
const MS_PER_HOUR = 3600000;
const MARKER = Symbol.for("livingNewEden.starmapJumps");
const DETAIL_MAX = 200;
const STATE = Object.freeze({ IDLE: "idle", ACTIVE: "active", PASSTHROUGH: "passthrough", REFUSED: "refused" });

const jumps = { state: STATE.IDLE, reason: null, served: 0, errors: 0, target: null, original: null, wrapper: null,
  slot: null };

function fit(text) {
  const s = String(text);
  return s.length > DETAIL_MAX ? s.slice(0, DETAIL_MAX) : s;
}

function lf(text) {
  return String(text).replace(/\r\n/g, "\n");
}

function windowMsOf(hours) {
  const n = Number(hours);
  const whole = Number.isFinite(n) ? Math.trunc(n) : 0;
  const positive = whole > 0 ? whole : 1;
  return Math.max(1, Math.min(VENDOR_MAX_WINDOW_HOURS, positive)) * MS_PER_HOUR;
}

function sortKey(row) {
  const n = Array.isArray(row) ? Number(row[0]) : NaN;
  return Number.isFinite(n) ? n : 0;
}

function mergeRows(rows, lne) {
  if (!(lne instanceof Map) || lne.size === 0) return rows;
  const out = rows.map((row) => (Array.isArray(row) ? row.slice() : row));
  const byId = new Map();
  for (const row of out) {
    if (Array.isArray(row) && Number.isSafeInteger(row[0]) && row[0] > 0) byId.set(row[0], row);
  }
  for (const [id, n] of lne) {
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isSafeInteger(n) || n <= 0) continue;
    const row = byId.get(id);
    if (row) {
      row[1] = (Number.isFinite(Number(row[1])) ? Number(row[1]) : 0) + n;
    } else {
      const added = [id, n, 0, 0];
      byId.set(id, added);
      out.push(added);
    }
  }
  return out.sort((a, b) => sortKey(a) - sortKey(b));
}

function driftDetail(exportsObject, texts) {
  const telemetryFile = `${TELEMETRY_PATH}.js`;
  const mapFile = `${MAP_SERVICE_PATH}.js`;
  const telemetryText = typeof texts.telemetryText === "string" ? lf(texts.telemetryText) : null;
  const mapText = typeof texts.mapServiceText === "string" ? lf(texts.mapServiceText) : null;
  if (telemetryText === null) return `${telemetryFile}:missing`;
  if (mapText === null) return `${mapFile}:missing`;
  if (fingerprintFunctions(telemetryText, [EXPORT_NAME]).get(EXPORT_NAME)
    !== FUNCTION_SHA1[`${telemetryFile}:${EXPORT_NAME}`]) return `${telemetryFile}:${EXPORT_NAME}`;
  if (fingerprintFunctions(mapText, ["buildHistoryRows"]).get("buildHistoryRows")
    !== FUNCTION_SHA1[`${mapFile}:buildHistoryRows`]) return `${mapFile}:buildHistoryRows`;
  if (!mapText.includes(MAP_HOLDS_MODULE)) return `${mapFile}:module object`;
  if (mapText.split(MAP_CALL).length - 1 !== 1) return `${mapFile}:call sites`;
  const current = exportsObject[EXPORT_NAME];
  if (typeof current !== "function") return `${telemetryFile}:${EXPORT_NAME} missing`;
  if (current[MARKER]) return null;
  if (lf(String(current)) !== functionBody(telemetryText, EXPORT_NAME)) {
    return `${telemetryFile}:${EXPORT_NAME} not the vendor function`;
  }
  return null;
}

function refuse(reason, detail) {
  const r = { ok: false, reason };
  if (detail !== undefined) r.detail = fit(detail);
  return r;
}

function checkJumps(exportsObject, texts) {
  try {
    if (!exportsObject || typeof exportsObject !== "object") return refuse("STARMAP_SEAM_UNAVAILABLE", "no exports");
    const detail = driftDetail(exportsObject, texts || {});
    return detail === null ? { ok: true } : refuse("STARMAP_DRIFT", detail);
  } catch (err) {
    return refuse("STARMAP_SEAM_UNAVAILABLE", (err && err.message) || err);
  }
}

function makeWrapper(original, provider, slot, onEvent) {
  const event = (name) => {
    if (typeof onEvent !== "function") return;
    try {
      onEvent(name);
    } catch (_err) {
    }
  };
  const wrapper = function listJumpHistoryRows(...args) {
    const rows = original.apply(this, args);
    if (!slot.active || !Array.isArray(rows)) return rows;
    try {
      const merged = mergeRows(rows, provider.jumpCounts(windowMsOf(args[0])));
      jumps.served += 1;
      event("jumpsServed");
      return merged;
    } catch (_err) {
      jumps.errors += 1;
      event("jumpsErrors");
      return rows;
    }
  };
  Object.defineProperty(wrapper, MARKER, { value: slot });
  return wrapper;
}

function installJumps(exportsObject, provider, opts) {
  if (jumps.state === STATE.ACTIVE) return refuse("HOOK_ALREADY_INSTALLED");
  let result;
  try {
    if (!provider || typeof provider.jumpCounts !== "function") {
      result = refuse("STARMAP_SEAM_UNAVAILABLE", "no provider");
    } else {
      const seam = checkJumps(exportsObject, opts || {});
      if (!seam.ok) result = seam;
      else if (exportsObject[EXPORT_NAME][MARKER]) result = refuse("HOOK_ALREADY_INSTALLED");
      else {
        const original = exportsObject[EXPORT_NAME];
        const slot = { active: true };
        const wrapper = makeWrapper(original, provider, slot, opts && opts.onEvent);
        exportsObject[EXPORT_NAME] = wrapper;
        if (exportsObject[EXPORT_NAME] !== wrapper) {
          result = refuse("STARMAP_SEAM_UNAVAILABLE", `${EXPORT_NAME} not writable`);
        } else {
          Object.assign(jumps, { state: STATE.ACTIVE, reason: null, target: exportsObject, original, wrapper, slot });
          return { ok: true };
        }
      }
    }
  } catch (err) {
    result = refuse("STARMAP_SEAM_UNAVAILABLE", (err && err.message) || err);
  }
  if (result.reason !== "HOOK_ALREADY_INSTALLED") {
    Object.assign(jumps, { state: STATE.REFUSED, reason: result.reason });
  }
  return result;
}

function uninstallJumps() {
  if (jumps.state !== STATE.ACTIVE) return { ok: true };
  jumps.slot.active = false;
  let restored = false;
  try {
    if (jumps.target[EXPORT_NAME] === jumps.wrapper) {
      jumps.target[EXPORT_NAME] = jumps.original;
      restored = jumps.target[EXPORT_NAME] === jumps.original;
    }
  } catch (_err) {
    restored = false;
  }
  Object.assign(jumps, { state: restored ? STATE.IDLE : STATE.PASSTHROUGH, reason: null, target: null, original: null,
    wrapper: null, slot: null });
  return { ok: true };
}

function jumpsStatus() {
  const state = jumps.state === STATE.REFUSED ? `${STATE.REFUSED}:${jumps.reason}` : jumps.state;
  return { state, served: jumps.served, errors: jumps.errors };
}

const KILLMAIL_PATH = "services/killmail/killmailState";
const FOR_EACH = "forEachKillmailRecordDescending";
const SCOPE_METHOD = "Handle_GetHistory";
const FILETIME_EXPORT = "filetimeFromMs";
const KILLS_STAT_ID = 3;
const KILLS_FUNCTION_SHA1 = Object.freeze({
  listKillHistoryRows: "8e2648219af63062e14601cafb3f6797a61d85d4",
  isKnownShipOrCapsuleType: "6fe4e1041297ac8702a73ed1701974df5489413a",
  isPublicMapSolarSystemID: "cafe92cbd0f917a65d0e9ef1b5c336511cfbf7b6",
  buildHistoryRows: FUNCTION_SHA1[`${MAP_SERVICE_PATH}.js:buildHistoryRows`],
});
const KILLS_METHOD_SHA1 = "a49d04317fa5c6048d9bbf94299926816e3b8b9a";
const MAP_DESTRUCTURES = ["const {\n  forEachKillmailRecordDescending,\n} = require", "(path.join(__dirname, ",
  "\"../killmail/killmailState\"));"].join("");
const MAP_FOR_EACH_CALL = "forEachKillmailRecordDescending((record) => {";
const MAP_KILLS_CONST = `const MAP_HISTORY_STAT_KILLS = ${KILLS_STAT_ID};`;
const FOR_EACH_MARKER = Symbol.for("livingNewEden.starmapOverlay.forEach");
const SCOPE_MARKER = Symbol.for("livingNewEden.starmapOverlay.scope");
const KILLS_STATE = Object.freeze({ OFF: "off", ARMED: "armed", ACTIVE: "active", REFUSED: "refused" });
const NO_RECORDS = Object.freeze([]);

const kills = { state: KILLS_STATE.OFF, reason: null, armed: false, depth: 0, served: 0, errors: 0, maxSynthetic: 0,
  fallbackTypeId: 0, provider: null, filetimeFromMs: null, onEvent: null, cacheVersion: null, records: NO_RECORDS,
  target: null, original: null, wrapper: null, slot: null };

function methodBody(sourceText, name) {
  const text = lf(sourceText || "");
  const start = new RegExp(`^  ${name}\\(`, "m").exec(text);
  if (!start) return null;
  const end = /\n {2}\}(\n|$)/g;
  end.lastIndex = start.index;
  const hit = end.exec(text);
  return hit ? text.slice(start.index + 2, hit.index + 4) : null;
}

function sha1Of(text) {
  return text === null ? null : crypto.createHash("sha1").update(text).digest("hex");
}

function killsEvent(name, value) {
  if (typeof kills.onEvent !== "function") return;
  try {
    kills.onEvent(name, value);
  } catch (_err) {
  }
}

function buildSyntheticKillRecords(snap, opts) {
  if (!snap || !Array.isArray(snap.losses) || !Number.isFinite(snap.builtAtWallMs)) return NO_RECORDS;
  const max = Number.isSafeInteger(opts.maxSynthetic) && opts.maxSynthetic > 0 ? opts.maxSynthetic : 0;
  const out = [];
  for (const loss of snap.losses) {
    if (out.length >= max) break;
    if (!loss || !Number.isSafeInteger(loss.systemId) || loss.systemId <= 0 || !Number.isSafeInteger(loss.count)
      || loss.count < 1 || !Number.isFinite(loss.ageMs) || loss.ageMs < 0) continue;
    const typeId = Number.isSafeInteger(loss.typeId) && loss.typeId > 0 ? loss.typeId : opts.fallbackTypeId;
    const factionId = Number.isSafeInteger(loss.factionId) && loss.factionId > 0 ? loss.factionId : 0;
    const record = Object.freeze({ solarSystemID: loss.systemId, victimShipTypeID: typeId, victimCharacterID: 0,
      victimFactionID: factionId, killTime: opts.filetimeFromMs(snap.builtAtWallMs - loss.ageMs) });
    for (let i = 0; i < loss.count && out.length < max; i += 1) out.push(record);
  }
  return Object.freeze(out);
}

function syntheticRecords() {
  const snap = kills.provider.snapshot();
  if (!snap) return NO_RECORDS;
  if (snap.version === kills.cacheVersion) return kills.records;
  const records = buildSyntheticKillRecords(snap, { maxSynthetic: kills.maxSynthetic,
    fallbackTypeId: kills.fallbackTypeId, filetimeFromMs: kills.filetimeFromMs });
  kills.records = records;
  kills.cacheVersion = snap.version;
  killsEvent("syntheticKills", records.length);
  return records;
}

function armKills(killmailExports, opts) {
  const exp = killmailExports;
  const d = exp && (typeof exp === "object" || typeof exp === "function")
    ? Object.getOwnPropertyDescriptor(exp, FOR_EACH) : null;
  if (!d || typeof d.value !== "function") return { ok: false, reason: "missing" };
  if (d.writable !== true || Object.isFrozen(exp)) return { ok: false, reason: "not_writable" };
  if (d.value[FOR_EACH_MARKER] || kills.state === KILLS_STATE.ACTIVE) return { ok: false, reason: "already_armed" };
  const o = opts || {};
  if (!Number.isSafeInteger(o.maxSynthetic) || o.maxSynthetic < 1 || !Number.isSafeInteger(o.fallbackTypeId)
    || o.fallbackTypeId < 1) return { ok: false, reason: "invalid_options" };
  const inner = d.value;
  const wrapped = function forEachKillmailRecordDescending(visitor) {
    if (kills.depth <= 0 || kills.state !== KILLS_STATE.ACTIVE || typeof visitor !== "function") {
      return inner.apply(this, arguments);
    }
    let stopped = false;
    const args = Array.prototype.slice.call(arguments);
    args[0] = function lneKillsVisitor() {
      const verdict = visitor.apply(this, arguments);
      if (verdict === false) stopped = true;
      return verdict;
    };
    const result = inner.apply(this, args);
    if (stopped) return result;
    let extra;
    try {
      extra = syntheticRecords();
    } catch (_err) {
      kills.errors += 1;
      killsEvent("killsErrors", 1);
      return result;
    }
    if (extra.length === 0) return result;
    kills.served += 1;
    killsEvent("killsServed", 1);
    for (const record of extra) {
      if (visitor(record) === false) break;
    }
    return result;
  };
  Object.defineProperty(wrapped, FOR_EACH_MARKER, { value: inner });
  exp[FOR_EACH] = wrapped;
  if (exp[FOR_EACH] !== wrapped) return { ok: false, reason: "not_writable" };
  Object.assign(kills, { state: KILLS_STATE.ARMED, reason: null, armed: true, maxSynthetic: o.maxSynthetic,
    fallbackTypeId: o.fallbackTypeId });
  return { ok: true };
}

function killsDriftDetail(serviceClass, mapServiceText) {
  const mapFile = `${MAP_SERVICE_PATH}.js`;
  if (typeof mapServiceText !== "string") return `${mapFile}:missing`;
  const text = lf(mapServiceText);
  const got = fingerprintFunctions(text, Object.keys(KILLS_FUNCTION_SHA1));
  for (const name of Object.keys(KILLS_FUNCTION_SHA1)) {
    if (got.get(name) !== KILLS_FUNCTION_SHA1[name]) return `${mapFile}:${name}`;
  }
  const body = methodBody(text, SCOPE_METHOD);
  if (sha1Of(body) !== KILLS_METHOD_SHA1) return `${mapFile}:${SCOPE_METHOD}`;
  if (!text.includes(MAP_DESTRUCTURES)) return `${mapFile}:destructuring`;
  if (text.split(MAP_FOR_EACH_CALL).length - 1 !== 2) return `${mapFile}:forEach call sites`;
  if (!text.includes(MAP_KILLS_CONST)) return `${mapFile}:MAP_HISTORY_STAT_KILLS`;
  const current = serviceClass.prototype[SCOPE_METHOD];
  if (lf(Function.prototype.toString.call(current)) !== body) return `${mapFile}:${SCOPE_METHOD} not the vendor method`;
  return null;
}

function killsRefused(reason, detail) {
  const r = refuse(reason, detail);
  if (reason !== "HOOK_ALREADY_INSTALLED" && reason !== "KILLS_HOOK_NOT_ARMED") {
    Object.assign(kills, { state: KILLS_STATE.REFUSED, reason });
  }
  return r;
}

function installKillsScope(serviceClass, provider, opts) {
  if (kills.state === KILLS_STATE.ACTIVE) return refuse("HOOK_ALREADY_INSTALLED");
  if (!kills.armed) return refuse("KILLS_HOOK_NOT_ARMED");
  const o = opts || {};
  try {
    if (!provider || typeof provider.snapshot !== "function") {
      return killsRefused("STARMAP_SEAM_UNAVAILABLE", "no provider");
    }
    if (typeof o.filetimeFromMs !== "function") return killsRefused("STARMAP_SEAM_UNAVAILABLE", FILETIME_EXPORT);
    if (typeof serviceClass !== "function" || !serviceClass.prototype
      || typeof serviceClass.prototype[SCOPE_METHOD] !== "function") {
      return killsRefused("STARMAP_SEAM_UNAVAILABLE", `mapService ${SCOPE_METHOD}`);
    }
    const proto = serviceClass.prototype;
    if (proto[SCOPE_METHOD][SCOPE_MARKER]) return refuse("HOOK_ALREADY_INSTALLED");
    const drift = killsDriftDetail(serviceClass, o.mapServiceText);
    if (drift !== null) return killsRefused("STARMAP_DRIFT", drift);
    const original = proto[SCOPE_METHOD];
    const slot = { active: true };
    const wrapper = function Handle_GetHistory(args) {
      if (!slot.active || kills.state !== KILLS_STATE.ACTIVE) return original.apply(this, arguments);
      if (Math.trunc(Number(args && args[0])) !== KILLS_STAT_ID) return original.apply(this, arguments);
      kills.depth += 1;
      try {
        return original.apply(this, arguments);
      } finally {
        kills.depth -= 1;
      }
    };
    Object.defineProperty(wrapper, SCOPE_MARKER, { value: slot });
    proto[SCOPE_METHOD] = wrapper;
    if (proto[SCOPE_METHOD] !== wrapper) return killsRefused("STARMAP_SEAM_UNAVAILABLE", `${SCOPE_METHOD} not writable`);
    Object.assign(kills, { state: KILLS_STATE.ACTIVE, reason: null, provider, filetimeFromMs: o.filetimeFromMs,
      onEvent: typeof o.onEvent === "function" ? o.onEvent : null, cacheVersion: null, records: NO_RECORDS,
      target: proto, original, wrapper, slot });
    return { ok: true };
  } catch (err) {
    return killsRefused("STARMAP_SEAM_UNAVAILABLE", (err && err.message) || err);
  }
}

function uninstallKills() {
  if (kills.state !== KILLS_STATE.ACTIVE) return { ok: true };
  kills.slot.active = false;
  try {
    if (kills.target[SCOPE_METHOD] === kills.wrapper) kills.target[SCOPE_METHOD] = kills.original;
  } catch (_err) {
  }
  Object.assign(kills, { state: KILLS_STATE.ARMED, reason: null, provider: null, filetimeFromMs: null, onEvent: null,
    cacheVersion: null, records: NO_RECORDS, target: null, original: null, wrapper: null, slot: null });
  return { ok: true };
}

function killsStatus() {
  const state = kills.state === KILLS_STATE.REFUSED ? `${KILLS_STATE.REFUSED}:${kills.reason}` : kills.state;
  return { state, served: kills.served, errors: kills.errors, depth: kills.depth, syntheticKills: kills.records.length };
}

module.exports = { TELEMETRY_PATH, MAP_SERVICE_PATH, EXPORT_NAME, FUNCTION_SHA1, VENDOR_MAX_WINDOW_HOURS, MARKER,
  windowMsOf, mergeRows, checkJumps, installJumps, uninstallJumps, jumpsStatus,
  KILLMAIL_PATH, FOR_EACH, SCOPE_METHOD, FILETIME_EXPORT, KILLS_STAT_ID, KILLS_FUNCTION_SHA1, KILLS_METHOD_SHA1,
  FOR_EACH_MARKER, SCOPE_MARKER, methodBody, buildSyntheticKillRecords, armKills, installKillsScope, uninstallKills,
  killsStatus };
