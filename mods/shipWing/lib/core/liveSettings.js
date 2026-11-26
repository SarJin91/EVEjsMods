"use strict";

const { MOD_ID, SCHEMA } = require("../../config");

const LIVE_REGISTRY_KEY = Symbol.for("evejs.modSettings.live");
const LIVE_KEYS = Object.freeze(["hpWarnPct", "hpCriticalPct", "clientWindowButtonColors", "clientWindowPollMs",
  "commandCooldownMs"]);
const CLIENT_WINDOW_POLL_MIN_MS = 1000;
const ROW_OF = new Map(SCHEMA.filter((r) => LIVE_KEYS.includes(r.key)).map((r) => [r.key, r]));

function validOf(key, value) {
  const row = ROW_OF.get(key);
  if (!row) return false;
  if (row.type === "bool") return typeof value === "boolean";
  if (row.type !== "int" || !Number.isSafeInteger(value)) return false;
  if (typeof row.min === "number" && value < row.min) return false;
  if (typeof row.max === "number" && value > row.max) return false;
  return key !== "clientWindowPollMs" || value === 0 || value >= CLIENT_WINDOW_POLL_MIN_MS;
}

function createLiveSettings(bootConfig) {
  const boot = bootConfig && typeof bootConfig === "object" ? bootConfig : {};
  let current = boot;
  let version = 0;

  function apply(values) {
    if (!values || typeof values !== "object" || Array.isArray(values)) return { ok: false, reason: "BAD_VALUES" };
    const picked = LIVE_KEYS.filter((k) => Object.prototype.hasOwnProperty.call(values, k));
    for (const key of picked) if (!validOf(key, values[key])) return { ok: false, reason: "BAD_VALUE", key };
    const next = { ...current };
    for (const key of picked) next[key] = values[key];
    if (Number.isSafeInteger(next.hpWarnPct) && Number.isSafeInteger(next.hpCriticalPct)
      && next.hpCriticalPct >= next.hpWarnPct) return { ok: false, reason: "BAD_VALUE", key: "hpCriticalPct" };
    current = Object.freeze(next);
    version += 1;
    return { ok: true, applied: picked };
  }

  return Object.freeze({
    get: () => current,
    apply,
    get version() {
      return version;
    },
  });
}

function registryOf(globalObj, create) {
  const g = globalObj || globalThis;
  if (!(g[LIVE_REGISTRY_KEY] instanceof Map)) {
    if (!create) return null;
    g[LIVE_REGISTRY_KEY] = new Map();
  }
  return g[LIVE_REGISTRY_KEY];
}

function registerLive(globalObj, live) {
  const entry = Object.freeze({ keys: LIVE_KEYS, apply: (values) => live.apply(values) });
  registryOf(globalObj, true).set(MOD_ID, entry);
  return entry;
}

function unregisterLive(globalObj, entry) {
  const map = registryOf(globalObj, false);
  if (map && map.get(MOD_ID) === entry) map.delete(MOD_ID);
}

module.exports = { LIVE_REGISTRY_KEY, LIVE_KEYS, createLiveSettings, registerLive, unregisterLive };
