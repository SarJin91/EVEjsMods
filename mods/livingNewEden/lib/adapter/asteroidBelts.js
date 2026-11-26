"use strict";

const MAX_DETAIL_LENGTH = 200;

const isId = (v) => Number.isSafeInteger(v) && v > 0;

function readSystemBeltsFrom(asteroidData, systemIds) {
  if (!asteroidData || typeof asteroidData.getBeltsForSystem !== "function") {
    return { ok: false, reason: "ASTEROID_DATA_DRIFT", detail: "getBeltsForSystem" };
  }
  if (!Array.isArray(systemIds) || !systemIds.every(isId)) {
    return { ok: false, reason: "ASTEROID_BELTS_FAILED", detail: "systemIds" };
  }
  const counts = new Map();
  try {
    for (const id of systemIds) {
      const belts = asteroidData.getBeltsForSystem(id);
      counts.set(id, Array.isArray(belts) ? belts.length : 0);
    }
  } catch (err) {
    return { ok: false, reason: "ASTEROID_BELTS_FAILED",
      detail: String((err && err.message) || err).slice(0, MAX_DETAIL_LENGTH) };
  }
  return { ok: true, counts };
}

module.exports = { readSystemBeltsFrom };
