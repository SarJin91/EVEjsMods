"use strict";

function createLoginOpen(deps) {
  const { delayMs, maxPending, enabled, ready, readPref, open, setTimer, bump } = deps;
  const seen = new WeakMap();
  const pending = new Map();

  function cancelHandle(handle) {
    try {
      if (handle && typeof handle.cancel === "function") handle.cancel();
    } catch (_err) {
    }
  }

  function cancel(characterId) {
    const handle = pending.get(characterId);
    if (handle === undefined) return;
    pending.delete(characterId);
    cancelHandle(handle);
  }

  function fire(characterId, handleRef) {
    if (pending.get(characterId) !== handleRef.handle) return;
    pending.delete(characterId);
    if (!ready()) return;
    let out;
    try {
      out = open(characterId);
    } catch (_err) {
      out = { ok: false };
    }
    bump(out && out.ok === true ? "autoOpenSent" : "autoOpenRefused");
  }

  function note(characterId, token, eligible) {
    try {
      if (!enabled || token === null || typeof token !== "object" || !Number.isSafeInteger(characterId)
        || characterId <= 0 || !ready()) {
        return;
      }
      let done = seen.get(token);
      if (done && done.has(characterId)) return;
      if (!done) {
        done = new Set();
        seen.set(token, done);
      }
      done.add(characterId);
      if (eligible !== true) return;
      const pref = readPref(characterId);
      if (!pref || pref.ok !== true) {
        bump("prefsReadFailed");
        return;
      }
      if (pref.openAtLogin !== true) return;
      if (!pending.has(characterId) && pending.size >= maxPending) {
        bump("autoOpenDropped");
        return;
      }
      cancel(characterId);
      const handleRef = { handle: null };
      handleRef.handle = setTimer(() => fire(characterId, handleRef), delayMs);
      pending.set(characterId, handleRef.handle);
      bump("autoOpenScheduled");
    } catch (_err) {
    }
  }

  function clear() {
    for (const handle of pending.values()) cancelHandle(handle);
    pending.clear();
  }

  return Object.freeze({ note, cancel, clear, pendingCount: () => pending.size });
}

module.exports = { createLoginOpen };
