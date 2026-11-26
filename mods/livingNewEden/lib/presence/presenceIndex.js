"use strict";

const NOT_READ_YET = "NOT_READ_YET";
const STATES = Object.freeze(["space", "docked", "transit"]);

function noop() {}

function freezePresence(systemId, records, truncated) {
  const counts = { space: 0, docked: 0, transit: 0 };
  const characters = records.map((r) => {
    counts[r.state] += 1;
    return Object.freeze({ characterId: r.characterId, name: r.name, state: r.state });
  });
  return Object.freeze({ systemId, total: records.length, ...counts, characters: Object.freeze(characters),
    ...(truncated ? { truncated: true } : {}) });
}

function createPresenceIndex(opts = {}) {
  const onCallbackError = typeof opts.onCallbackError === "function" ? opts.onCallbackError : noop;
  let fingerprint = null;
  let version = 0;
  let bySystem = new Map();
  let observedList = Object.freeze([]);
  let listCache = Object.freeze([]);
  let characters = 0;
  let truncated = false;
  let stale = true;
  let staleReason = NOT_READ_YET;
  let callbackErrors = 0;
  const observedListeners = new Set();
  const unobservedListeners = new Set();

  function emit(listeners, systemId, info) {
    for (const cb of [...listeners]) {
      try {
        if (info === undefined) cb(systemId);
        else cb(systemId, info);
      } catch (err) {
        callbackErrors += 1;
        try {
          onCallbackError(err);
        } catch (_err) {
        }
      }
    }
  }

  function apply(read) {
    const records = Array.isArray(read && read.characters) ? read.characters : [];
    const overflow = Array.isArray(read && read.overflowSystems) ? read.overflowSystems : [];
    stale = false;
    staleReason = null;
    truncated = Boolean(read && read.truncated);
    const print = records.map((r) => `${r.characterId}|${r.systemId}|${r.state}|${r.name}`).join("\n")
      + (overflow.length ? `\no|${overflow.join(",")}` : "");
    if (print === fingerprint) return { changed: false };
    fingerprint = print;
    version += 1;
    const groups = new Map();
    for (const r of records) {
      if (!STATES.includes(r.state)) continue;
      const list = groups.get(r.systemId);
      if (list) list.push(r);
      else groups.set(r.systemId, [r]);
    }
    const next = new Map();
    for (const [systemId, list] of groups) next.set(systemId, freezePresence(systemId, list, false));
    for (const systemId of overflow) if (!next.has(systemId)) next.set(systemId, freezePresence(systemId, [], true));
    const before = bySystem;
    bySystem = next;
    characters = records.length;
    observedList = Object.freeze([...next.keys()].sort((a, b) => a - b));
    listCache = Object.freeze(observedList.map((id) => next.get(id)));
    const unobserved = [...before.keys()].filter((id) => !next.has(id)).sort((a, b) => a - b);
    const observed = observedList.filter((id) => !before.has(id));
    for (const id of unobserved) emit(unobservedListeners, id);
    for (const id of observed) emit(observedListeners, id, next.get(id));
    return { changed: true, version, observed, unobserved };
  }

  function markStale(reason) {
    stale = true;
    staleReason = String(reason || "READ_FAILED");
  }

  function subscribe(listeners, cb) {
    if (typeof cb !== "function") return { ok: false, reason: "LISTENER_INVALID" };
    const entry = (...args) => cb(...args);
    listeners.add(entry);
    return { ok: true, unsubscribe: () => { listeners.delete(entry); } };
  }

  return Object.freeze({
    apply,
    markStale,
    onSystemObserved: (cb) => subscribe(observedListeners, cb),
    onSystemUnobserved: (cb) => subscribe(unobservedListeners, cb),
    clearListeners() {
      observedListeners.clear();
      unobservedListeners.clear();
    },
    isObserved: (systemId) => bySystem.has(Number(systemId)),
    observedSystems: () => [...observedList],
    getSystemPresence: (systemId) => bySystem.get(Number(systemId)) || null,
    listPresence: () => listCache,
    getVersion: () => version,
    getState: () => Object.freeze({ stale, staleReason, version, characters, systems: observedList.length,
      truncated, callbackErrors }),
  });
}

module.exports = { NOT_READ_YET, createPresenceIndex };
