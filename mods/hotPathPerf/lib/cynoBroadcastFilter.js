"use strict";

const MARKER = "__hotPathPerfCyno";
const DETAIL_MAX = 200;

function normalizePositiveInteger(value, fallback = null) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  const integer = Math.trunc(numeric);
  return integer > 0 ? integer : fallback;
}

function fit(text) {
  const s = String(text);
  return s.length > DETAIL_MAX ? s.slice(0, DETAIL_MAX) : s;
}

function createCynoBroadcastFilter(options) {
  const config = (options && options.config) || {};
  const log = (options && options.log) || (() => {});
  const enabled = config.cynoBroadcastSessionFilter === true;
  let disabledReason = null;
  let sessionRegistry = null;
  const total = { calls: 0, systems: 0, kept: 0, skipped: 0, noop: 0 };
  let win = { calls: 0, systems: 0, kept: 0, skipped: 0, noop: 0 };

  function disable(reason, detail) {
    if (disabledReason) return;
    disabledReason = String(reason);
    log(`WARN cynoBroadcastSessionFilter disabled: ${disabledReason}${detail ? ` (${fit(detail)})` : ""}`);
  }

  function setSessionRegistry(exportsValue) {
    if (!exportsValue || typeof exportsValue !== "object" || typeof exportsValue.getSessions !== "function") return false;
    sessionRegistry = exportsValue;
    return true;
  }

  function occupiedSystems() {
    let sessions;
    try {
      sessions = sessionRegistry.getSessions();
    } catch (error) {
      disable("sessions_error", error && error.message || error);
      return null;
    }
    if (!Array.isArray(sessions)) {
      disable("sessions_shape", typeof sessions);
      return null;
    }
    const occupied = new Set();
    for (const session of sessions) {
      const id = normalizePositiveInteger(session && (session.solarsystemid2 || session.solarsystemid), null);
      if (id) occupied.add(id);
    }
    return occupied;
  }

  function count(field, n) {
    total[field] += n;
    win[field] += n;
  }

  function wrapBroadcast(original) {
    if (typeof original !== "function" || original[MARKER]) return original;
    const wrapped = function hotPathPerfCynoBroadcast(previousRows, nextRows, callOptions) {
      if (!enabled || disabledReason || !sessionRegistry || !callOptions || !Array.isArray(callOptions.systemIDs)) {
        return original.apply(this, arguments);
      }
      let occupied;
      try {
        occupied = occupiedSystems();
      } catch (error) {
        disable("error", error && error.message || error);
        occupied = null;
      }
      if (!occupied) return original.apply(this, arguments);
      const systemIDs = callOptions.systemIDs;
      const kept = systemIDs.filter((id) => occupied.has(normalizePositiveInteger(id, null)));
      count("calls", 1);
      count("systems", systemIDs.length);
      count("kept", kept.length);
      count("skipped", systemIDs.length - kept.length);
      if (kept.length === 0) {
        count("noop", 1);
        return 0;
      }
      return original.call(this, previousRows, nextRows, { ...callOptions, systemIDs: kept });
    };
    Object.defineProperty(wrapped, MARKER, { value: original });
    return wrapped;
  }

  function drainStatsLines() {
    if (win.calls === 0) return [];
    const w = win;
    win = { calls: 0, systems: 0, kept: 0, skipped: 0, noop: 0 };
    return [`cynoBroadcast stats calls=${w.calls} systems=${w.systems} kept=${w.kept} skipped=${w.skipped} noop=${w.noop}`];
  }

  function status() {
    return { enabled, disabledReason, hasSessions: Boolean(sessionRegistry) };
  }

  function snapshot() {
    return { state: !enabled ? "off" : (disabledReason ? "disabled" : "on"), reason: disabledReason, ...total };
  }

  return { wrapBroadcast, setSessionRegistry, drainStatsLines, status, snapshot, disable };
}

module.exports = { createCynoBroadcastFilter, normalizePositiveInteger, MARKER };
