"use strict";

const LIVE_REGISTRY_KEY = Symbol.for("evejs.modSettings.live");
const LNE_MOD_ID = "livingNewEden";
const APPLY_LIVE = "live";
const APPLY_RESTART = "restart";
const MAX_DETAIL = 120;
const LIVE_KEYS_LNE = Object.freeze([
  "modsHelp.cooldownMs",
  "modsHelp.maxReplyChars",
  "frontChat.cooldownMs",
  "frontChat.maxReplyChars",
  "inGameMap.chatMinIntervalMs",
]);

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function createLiveConfig(initialFrozenConfig) {
  let current = initialFrozenConfig;
  let version = 0;
  return Object.freeze({
    get: () => current,
    swap(next) {
      if (!isPlainObject(next)) return { ok: false, reason: "BAD_CONFIG" };
      current = next;
      version += 1;
      return { ok: true, version };
    },
    get version() {
      return version;
    },
  });
}

function liveRegistryOf(globalObj) {
  const g = globalObj || globalThis;
  const map = g[LIVE_REGISTRY_KEY];
  return map instanceof Map ? map : null;
}

function createLiveApplier(deps) {
  const liveConfig = deps && deps.liveConfig && typeof deps.liveConfig.swap === "function" ? deps.liveConfig : null;
  const globalObj = (deps && deps.globalObj) || globalThis;

  function registryEntry(modId) {
    const map = liveRegistryOf(globalObj);
    const entry = map ? map.get(modId) : null;
    return entry && Array.isArray(entry.keys) && typeof entry.apply === "function" ? entry : null;
  }

  function isLiveKey(modId, key) {
    if (modId === LNE_MOD_ID) return liveConfig !== null && LIVE_KEYS_LNE.includes(key);
    const entry = registryEntry(modId);
    return entry !== null && entry.keys.includes(key);
  }

  function applyOf(modId, key, provider) {
    try {
      const lock = provider && typeof provider.locked === "function" ? provider.locked(key) : null;
      if (lock && lock.locked === true) return APPLY_RESTART;
      if (isLiveKey(modId, key)) return APPLY_LIVE;
    } catch (_err) {
    }
    return APPLY_RESTART;
  }

  function apply(req) {
    try {
      const r = isPlainObject(req) ? req : {};
      const after = isPlainObject(r.after) ? r.after : null;
      if (!isLiveKey(r.modId, r.key)) return { ok: false, reason: "NOT_LIVE" };
      if (!after || after.ok !== true || !isPlainObject(after.values)) return { ok: false, reason: "CONFIG_ERROR" };
      if (r.modId === LNE_MOD_ID) {
        if (!isPlainObject(after.config)) return { ok: false, reason: "CONFIG_ERROR" };
        const swapped = liveConfig.swap(after.config);
        if (swapped.ok !== true) return { ok: false, reason: swapped.reason };
        const applied = LIVE_KEYS_LNE.filter((k) => k === r.key
          || Object.prototype.hasOwnProperty.call(after.values, k));
        return { ok: true, applied };
      }
      const entry = registryEntry(r.modId);
      const values = Object.fromEntries(entry.keys.filter((k) => Object.prototype.hasOwnProperty.call(after.values, k))
        .map((k) => [k, after.values[k]]));
      const res = entry.apply(values);
      if (!res || res.ok !== true || !Array.isArray(res.applied)) {
        return { ok: false, reason: (res && typeof res.reason === "string" && res.reason) || "APPLY_REFUSED" };
      }
      return { ok: true, applied: res.applied.filter((k) => typeof k === "string") };
    } catch (err) {
      return { ok: false, reason: "APPLY_FAILED", detail: messageOf(err) };
    }
  }

  return Object.freeze({ applyOf, apply });
}

module.exports = { LIVE_REGISTRY_KEY, LIVE_KEYS_LNE, APPLY_LIVE, APPLY_RESTART, createLiveConfig, liveRegistryOf,
  createLiveApplier };
