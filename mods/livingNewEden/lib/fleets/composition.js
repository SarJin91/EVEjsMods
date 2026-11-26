"use strict";

const { HULL_GROUPS, CAPITAL_HULL_GROUPS } = require("./schema");
const { stableJson } = require("../util/fingerprint");

function invalid(detail) {
  return { ok: false, reason: "FLEET_INVALID_INPUT", detail };
}

function isPositiveInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function compareEntries(a, b) {
  if (a.hullGroup !== b.hullGroup) return a.hullGroup < b.hullGroup ? -1 : 1;
  return (a.typeId || 0) - (b.typeId || 0);
}

function normalizeEntry(entry, where) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return invalid(`${where}: not an object`);
  for (const key of Object.keys(entry)) {
    if (key !== "hullGroup" && key !== "typeId" && key !== "count") return invalid(`${where}: field ${key}`);
  }
  if (typeof entry.hullGroup !== "string") return invalid(`${where}.hullGroup`);
  if (!HULL_GROUPS.includes(entry.hullGroup)) {
    return { ok: false, reason: "UNKNOWN_HULL_GROUP", hullGroup: entry.hullGroup };
  }
  const typeId = entry.typeId === undefined ? null : entry.typeId;
  if (typeId !== null && !isPositiveInt(typeId)) return invalid(`${where}.typeId`);
  if (!isPositiveInt(entry.count)) return invalid(`${where}.count`);
  return { ok: true, entry: Object.freeze({ hullGroup: entry.hullGroup, typeId, count: entry.count }) };
}

function normalizeEntries(list, maxEntries, what) {
  if (!Array.isArray(list)) return invalid(`${what}: not an array`);
  if (list.length === 0) return invalid(`${what}: empty`);
  if (list.length > maxEntries) return invalid(`${what}: ${list.length} entries > ${maxEntries}`);
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    const r = normalizeEntry(list[i], `${what}[${i}]`);
    if (!r.ok) return r;
    out.push(r.entry);
  }
  out.sort(compareEntries);
  for (let i = 1; i < out.length; i += 1) {
    if (compareEntries(out[i - 1], out[i]) === 0) {
      return invalid(`${what}: duplicate ${out[i].hullGroup}/${out[i].typeId}`);
    }
  }
  return { ok: true, entries: Object.freeze(out), shipCount: out.reduce((sum, e) => sum + e.count, 0) };
}

function normalizeComposition(list, limits) {
  const r = normalizeEntries(list, limits.maxCompositionEntries, "composition");
  if (!r.ok) return r;
  if (r.shipCount > limits.maxShipsPerFleet) {
    return invalid(`composition: ${r.shipCount} ships > maxShipsPerFleet ${limits.maxShipsPerFleet}`);
  }
  return { ok: true, composition: r.entries, shipCount: r.shipCount };
}

function normalizeLosses(list, limits) {
  const r = normalizeEntries(list, limits.maxCompositionEntries, "losses");
  if (!r.ok) return r;
  return { ok: true, losses: r.entries, shipCount: r.shipCount };
}

function subtractLosses(composition, losses) {
  const left = composition.map((e) => ({ ...e }));
  for (const loss of losses) {
    const entry = left.find((e) => compareEntries(e, loss) === 0);
    const have = entry ? entry.count : 0;
    if (loss.count > have) {
      return { ok: false, reason: "NEGATIVE_COMPOSITION", hullGroup: loss.hullGroup, typeId: loss.typeId, have,
        lost: loss.count };
    }
    entry.count -= loss.count;
  }
  const out = Object.freeze(left.filter((e) => e.count > 0).map((e) => Object.freeze(e)));
  return { ok: true, composition: out, shipCount: out.reduce((sum, e) => sum + e.count, 0) };
}

function addHulls(composition, add, limits) {
  const r = normalizeEntries(add, limits.maxCompositionEntries, "add");
  if (!r.ok) return r;
  if (r.entries.some((e) => e.typeId !== null && !CAPITAL_HULL_GROUPS.includes(e.hullGroup))) {
    return invalid("add: typeId must be null");
  }
  const out = composition.map((e) => ({ ...e }));
  for (const a of r.entries) {
    const entry = out.find((e) => e.hullGroup === a.hullGroup
      && (a.typeId === null ? (e.typeId === null || e.typeId === undefined) : e.typeId === a.typeId));
    if (entry) entry.count += a.count;
    else out.push({ hullGroup: a.hullGroup, typeId: a.typeId, count: a.count });
  }
  if (out.length > limits.maxCompositionEntries) {
    return invalid(`composition: ${out.length} entries > ${limits.maxCompositionEntries}`);
  }
  out.sort(compareEntries);
  const frozen = Object.freeze(out.map((e) => Object.freeze(e)));
  return { ok: true, composition: frozen, shipCount: frozen.reduce((sum, e) => sum + e.count, 0), added: r.shipCount,
    add: r.entries };
}

function removeHulls(composition, remove, limits) {
  const r = normalizeEntries(remove, limits.maxCompositionEntries, "remove");
  if (!r.ok) return r;
  if (r.entries.some((e) => e.typeId !== null)) return invalid("remove: typeId must be null");
  const left = composition.map((e) => ({ ...e }));
  for (const x of r.entries) {
    const entries = left.filter((e) => e.hullGroup === x.hullGroup)
      .sort((a, b) => (a.typeId === null ? -1 : b.typeId === null ? 1 : a.typeId - b.typeId));
    const have = entries.reduce((n, e) => n + e.count, 0);
    if (x.count > have) return { ok: false, reason: "NEGATIVE_COMPOSITION", hullGroup: x.hullGroup, typeId: null, have,
      lost: x.count };
    let need = x.count;
    for (const e of entries) {
      const n = Math.min(need, e.count);
      e.count -= n;
      need -= n;
      if (need === 0) break;
    }
  }
  const out = Object.freeze(left.filter((e) => e.count > 0).sort(compareEntries).map((e) => Object.freeze(e)));
  return { ok: true, composition: out, shipCount: out.reduce((sum, e) => sum + e.count, 0), removed: r.shipCount,
    remove: r.entries };
}

function jsonBytes(value, what) {
  try {
    const text = stableJson(value);
    return { ok: true, text, bytes: Buffer.byteLength(text, "utf8") };
  } catch (err) {
    return invalid(`${what}: ${(err && err.message) || err}`);
  }
}

function normalizeCargo(cargo, limits) {
  if (cargo === undefined || cargo === null) return { ok: true, cargo: null };
  if (!Array.isArray(cargo)) return invalid("cargo: not an array");
  const out = [];
  for (let i = 0; i < cargo.length; i += 1) {
    const item = cargo[i];
    if (!item || typeof item !== "object" || Array.isArray(item)) return invalid(`cargo[${i}]: not an object`);
    for (const key of Object.keys(item)) {
      if (key !== "typeId" && key !== "quantity") return invalid(`cargo[${i}]: field ${key}`);
    }
    if (!isPositiveInt(item.typeId)) return invalid(`cargo[${i}].typeId`);
    if (!isPositiveInt(item.quantity)) return invalid(`cargo[${i}].quantity`);
    out.push(Object.freeze({ typeId: item.typeId, quantity: item.quantity }));
  }
  out.sort((a, b) => a.typeId - b.typeId);
  for (let i = 1; i < out.length; i += 1) {
    if (out[i - 1].typeId === out[i].typeId) return invalid(`cargo: duplicate typeId ${out[i].typeId}`);
  }
  const size = jsonBytes(out, "cargo");
  if (!size.ok) return size;
  if (size.bytes > limits.maxJsonBytes) return invalid(`cargo: ${size.bytes} bytes > ${limits.maxJsonBytes}`);
  return { ok: true, cargo: Object.freeze(out) };
}

module.exports = { normalizeComposition, normalizeLosses, subtractLosses, addHulls, removeHulls, normalizeCargo,
  jsonBytes, compareEntries };
