"use strict";

const MAX_TYPE_IDS = 64;
const MAX_DETAIL_LENGTH = 200;
const MAX_NAME_LENGTH = 64;

const UNAVAILABLE = "ITEM_TYPES_UNAVAILABLE";
const INVALID = "ITEM_TYPES_INVALID";
const FAILED = "ITEM_TYPES_FAILED";

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const clip = (s) => String(s).slice(0, MAX_DETAIL_LENGTH);

function volumeOf(v) {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

function portionOf(v) {
  return Number.isSafeInteger(v) && v >= 1 ? v : null;
}

function basePriceOf(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
}

function nameOf(v) {
  return typeof v === "string" ? v.slice(0, MAX_NAME_LENGTH) : null;
}

function readItemTypeFactsFrom(registry, typeIds) {
  const resolve = registry && typeof registry.resolveItemByTypeID === "function" ? registry.resolveItemByTypeID : null;
  if (resolve === null) return { ok: false, reason: UNAVAILABLE };
  if (!Array.isArray(typeIds) || typeIds.length === 0 || typeIds.length > MAX_TYPE_IDS || !typeIds.every(isId)) {
    return { ok: false, reason: INVALID, detail: "typeIds" };
  }
  const facts = new Map();
  const missing = [];
  for (const typeId of typeIds) {
    if (facts.has(typeId) || missing.includes(typeId)) continue;
    let entry;
    try {
      entry = resolve.call(registry, typeId);
    } catch (err) {
      return { ok: false, reason: FAILED, detail: clip(`${typeId}: ${(err && err.message) || err}`) };
    }
    if (!entry || typeof entry !== "object") {
      missing.push(typeId);
      continue;
    }
    facts.set(typeId, Object.freeze({
      typeId,
      name: nameOf(entry.name),
      volume: volumeOf(entry.volume),
      portionSize: portionOf(entry.portionSize),
      basePrice: basePriceOf(entry.basePrice),
    }));
  }
  missing.sort((a, b) => a - b);
  return { ok: true, facts, missing };
}

const posIntOrNull = (v) => (Number.isSafeInteger(v) && v > 0 ? v : null);

function readTypeLooksFrom(registry, typeIds) {
  const resolve = registry && typeof registry.resolveItemByTypeID === "function" ? registry.resolveItemByTypeID : null;
  if (resolve === null) return { ok: false, reason: UNAVAILABLE };
  if (!Array.isArray(typeIds) || typeIds.length === 0 || typeIds.length > MAX_TYPE_IDS || !typeIds.every(isId)) {
    return { ok: false, reason: INVALID, detail: "typeIds" };
  }
  const looks = new Map();
  const missing = [];
  for (const typeId of typeIds) {
    if (looks.has(typeId) || missing.includes(typeId)) continue;
    let entry;
    try {
      entry = resolve.call(registry, typeId);
    } catch (err) {
      return { ok: false, reason: FAILED, detail: clip(`${typeId}: ${(err && err.message) || err}`) };
    }
    if (!entry || typeof entry !== "object") {
      missing.push(typeId);
      continue;
    }
    looks.set(typeId, Object.freeze({ typeId, graphicID: posIntOrNull(entry.graphicID),
      categoryID: posIntOrNull(entry.categoryID) }));
  }
  missing.sort((a, b) => a - b);
  return { ok: true, looks, missing };
}

module.exports = { readItemTypeFactsFrom, readTypeLooksFrom, MAX_TYPE_IDS };
