"use strict";

const { toMilli, clampMilli, REJECTED_CODE } = require("./marketPrices");

const MAX_TYPE_IDS = 64;
const MAX_DETAIL = 120;

const isId = (v) => Number.isSafeInteger(v) && v > 0;

async function readStationAsksFrom(marketDaemon, spec) {
  if (!marketDaemon || typeof marketDaemon.call !== "function") return { ok: false, reason: "SEAM_UNAVAILABLE" };
  const typeIds = spec && Array.isArray(spec.typeIds) ? spec.typeIds : null;
  if (!spec || !isId(spec.stationId) || !typeIds || typeIds.length === 0 || typeIds.length > MAX_TYPE_IDS
    || !typeIds.every(isId) || new Set(typeIds).size !== typeIds.length) {
    return { ok: false, reason: "SPEC_INVALID" };
  }
  let rows;
  try {
    rows = await marketDaemon.call("GetStationAsks", { station_id: spec.stationId });
  } catch (err) {
    const code = err && typeof err.code === "string" ? err.code : null;
    const detail = String((err && err.message) || err).slice(0, MAX_DETAIL);
    return { ok: false, reason: code === REJECTED_CODE ? "REJECTED" : "TRANSPORT", detail };
  }
  const wanted = new Set(typeIds);
  const asks = new Map(typeIds.map((t) => [t, null]));
  for (const row of Array.isArray(rows) ? rows : []) {
    const typeId = row ? Number(row.type_id) : NaN;
    if (!wanted.has(typeId)) continue;
    const qty = Number(row.total_ask_quantity);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    const ask = clampMilli(toMilli(row.best_ask_price));
    const prev = asks.get(typeId);
    if (ask !== null && (prev === null || ask < prev)) asks.set(typeId, ask);
  }
  return { ok: true, asks };
}

module.exports = { readStationAsksFrom, MAX_TYPE_IDS };
