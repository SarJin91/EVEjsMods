"use strict";

const SHIP_WING_UI_KEY = Symbol.for("evejs.shipWing.uiPrefs.v1");
const SHIP_WING_UI_VERSION = 1;
const MAX_REASON = 40;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const codeOf = (value) => String(value ?? "UNKNOWN").replace(/[^\w:.\-]/g, "_").slice(0, MAX_REASON);

function apiOf(globalObj) {
  try {
    const api = globalObj ? globalObj[SHIP_WING_UI_KEY] : null;
    if (!api || typeof api !== "object" || api.version !== SHIP_WING_UI_VERSION) return null;
    if (typeof api.get !== "function" || typeof api.set !== "function" || typeof api.open !== "function") return null;
    return api;
  } catch (_err) {
    return null;
  }
}

function createShipWingUi(deps) {
  const globalObj = deps && deps.globalObj !== undefined ? deps.globalObj : globalThis;
  const unavailable = () => ({ ok: false, available: false, reason: "WING_UNAVAILABLE" });

  function callApi(name, charId, extra, shape) {
    const api = apiOf(globalObj);
    if (!api) return unavailable();
    if (!isId(charId)) return { ok: false, available: true, reason: "BAD_ID" };
    let out;
    try {
      out = extra === undefined ? api[name](charId) : api[name](charId, extra);
    } catch (_err) {
      return { ok: false, available: true, reason: "WING_FAILED" };
    }
    if (!out || typeof out !== "object") return { ok: false, available: true, reason: "WING_FAILED" };
    if (out.ok !== true) return { ok: false, available: true, reason: codeOf(out.reason) };
    return shape(out);
  }

  return Object.freeze({
    available: () => apiOf(globalObj) !== null,
    get: (charId) => callApi("get", charId, undefined, (out) => ({ ok: true, available: true,
      openAtLogin: out.openAtLogin === true })),
    set: (charId, on) => callApi("set", charId, on === true, (out) => ({ ok: true, available: true,
      openAtLogin: out.openAtLogin === true, persisted: out.persisted === true })),
    open: (charId) => callApi("open", charId, undefined, () => ({ ok: true, available: true })),
  });
}

module.exports = { SHIP_WING_UI_KEY, SHIP_WING_UI_VERSION, createShipWingUi };
