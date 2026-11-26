"use strict";

const UI_PREFS_API_KEY = Symbol.for("evejs.shipWing.uiPrefs.v1");
const API_VERSION = 1;

function posSafeInt(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function createUiPrefsApi(deps) {
  const channel = deps && deps.channel;
  const store = deps && deps.store;
  let active = Boolean(channel && store);

  function get(charId) {
    try {
      if (!active) return { ok: false, reason: "WINDOW_OFF" };
      if (!posSafeInt(charId)) return { ok: false, reason: "BAD_ID" };
      return { ok: true, openAtLogin: store.get(charId) === true };
    } catch (_err) {
      return { ok: false, reason: "WINDOW_OFF" };
    }
  }

  function set(charId, on) {
    try {
      if (!active) return { ok: false, reason: "WINDOW_OFF" };
      if (!posSafeInt(charId)) return { ok: false, reason: "BAD_ID" };
      const want = on === true;
      const out = store.set(charId, want);
      if (out && out.ok === true) return { ok: true, openAtLogin: want, persisted: out.persisted === true };
      return { ok: false, reason: out && out.reason === "FULL" ? "FULL" : "BAD_ID" };
    } catch (_err) {
      return { ok: false, reason: "WINDOW_OFF" };
    }
  }

  function open(charId) {
    try {
      if (!active) return { ok: false, reason: "WINDOW_OFF" };
      if (!posSafeInt(charId)) return { ok: false, reason: "CLIENT_NOT_READY" };
      const out = channel.open(charId);
      return out && typeof out === "object" ? out : { ok: false, reason: "SEND_FAILED" };
    } catch (_err) {
      return { ok: false, reason: "SEND_FAILED" };
    }
  }

  const api = Object.freeze({ version: API_VERSION, get, set, open });
  return { api, deactivate: () => { active = false; } };
}

function registerUiPrefsApi(globalObj, api) {
  try {
    globalObj[UI_PREFS_API_KEY] = api;
    return true;
  } catch (_err) {
    return false;
  }
}

function unregisterUiPrefsApi(globalObj, api) {
  try {
    if (!globalObj || globalObj[UI_PREFS_API_KEY] !== api) return false;
    delete globalObj[UI_PREFS_API_KEY];
    return true;
  } catch (_err) {
    return false;
  }
}

module.exports = { UI_PREFS_API_KEY, API_VERSION, createUiPrefsApi, registerUiPrefsApi, unregisterUiPrefsApi };
