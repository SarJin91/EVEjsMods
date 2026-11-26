"use strict";

const HOLD_REASON = "GOVERNOR_HOLD";
const HOLD_REASONS = Object.freeze([HOLD_REASON, "GOVERNOR_DEFERRED"]);
const MODE_TEXT_RE = /^[A-Za-z_]{1,32}$/;

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isHold(data) {
  return isPlainObject(data) && data.available === false && HOLD_REASONS.includes(data.reason);
}

function modeText(value) {
  return typeof value === "string" && MODE_TEXT_RE.test(value) ? value : null;
}

function governorTail(status) {
  if (!isPlainObject(status)) return null;
  const mode = modeText(status.mode);
  if (mode === null) return null;
  return { mode, baseMode: modeText(status.baseMode), overlay: modeText(status.overlay) };
}

function isGood(data, json) {
  return isPlainObject(data) && data.available !== false && typeof json === "string"
    && json.startsWith("{") && json.endsWith("}");
}

function createStaleOnHold() {
  const last = new Map();

  function remember(id, getData, data, json, atMs) {
    if (isGood(data, json)) last.set(id, { getData, json, atMs });
  }

  function touch(id, getData, json, atMs) {
    const entry = last.get(id);
    if (entry && entry.getData === getData && entry.json === json) entry.atMs = atMs;
  }

  function serve(id, getData, data, nowMs, governorStatus) {
    if (!isHold(data)) return null;
    const entry = last.get(id);
    if (!entry || entry.getData !== getData) return null;
    const ageMs = Math.max(0, nowMs - entry.atMs);
    const gov = governorTail(governorStatus);
    const tail = `"stale":true,"staleSinceMs":${JSON.stringify(entry.atMs)},"staleAgeMs":${JSON.stringify(ageMs)},`
      + (gov === null ? "" : `"staleGovernor":${JSON.stringify(gov)},`)
      + `"reason":${JSON.stringify(data.reason)}}`;
    return entry.json === "{}" ? `{${tail}` : `${entry.json.slice(0, -1)},${tail}`;
  }

  function lastAtMs(id, getData) {
    const entry = last.get(id);
    return entry && entry.getData === getData ? entry.atMs : null;
  }

  function forget(id) {
    last.delete(id);
  }

  function size() {
    return last.size;
  }

  return Object.freeze({ remember, touch, serve, lastAtMs, forget, size });
}

module.exports = { HOLD_REASON, HOLD_REASONS, isHold, governorTail, createStaleOnHold };
