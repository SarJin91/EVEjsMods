"use strict";

const STORE_PATH = "gameStore/index";
const TABLE = "incursionLifecycle";
const DETAIL_MAX = 200;

const fit = (text) => {
  const s = String(text);
  return s.length > DETAIL_MAX ? s.slice(0, DETAIL_MAX) : s;
};

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}

function createIncursionTalesRead(deps) {
  const requireGame = deps && typeof deps.requireGame === "function" ? deps.requireGame : null;
  let root = null;
  let tales = null;
  let hits = 0;
  let fills = 0;

  function currentRoot() {
    if (!requireGame) return null;
    try {
      const gs = requireGame(STORE_PATH);
      if (!gs || !gs.ok || !gs.exports || typeof gs.exports.read !== "function") return null;
      const r = gs.exports.read(TABLE, "/");
      return r && r.success === true && r.data && typeof r.data === "object" ? r.data : null;
    } catch (_err) {
      return null;
    }
  }

  function read(lifecycle) {
    try {
      const now = currentRoot();
      if (now !== null && now === root && tales !== null) {
        hits += 1;
        return { ok: true, tales };
      }
      let list;
      try {
        list = lifecycle.listTales();
      } catch (err) {
        root = null;
        tales = null;
        return { ok: false, reason: "INCURSION_READ_FAILED", detail: fit((err && err.message) || err) };
      }
      if (!Array.isArray(list)) {
        root = null;
        tales = null;
        return { ok: false, reason: "INCURSION_READ_FAILED", detail: "not an array" };
      }
      fills += 1;
      root = now;
      tales = now === null ? null : deepFreeze(list);
      return { ok: true, tales: list };
    } catch (err) {
      return { ok: false, reason: "INCURSION_READ_FAILED", detail: fit((err && err.message) || err) };
    }
  }

  function stats() {
    return { hits, fills };
  }

  return { read, stats };
}

module.exports = { createIncursionTalesRead, STORE_PATH, TABLE };
