"use strict";

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const STRIKE_KINDS = Object.freeze(["turret", "missile"]);
const DAMAGE_TYPES = Object.freeze(["em", "thermal", "kinetic", "explosive"]);
const PERMILLE = 1000;

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

function squadronScalePermille(p) {
  if (!isObject(p)) return { ok: false, reason: "NO_ROW" };
  const rowDps = Number(p.rowDps);
  if (!Number.isFinite(rowDps) || rowDps <= 0) return { ok: false, reason: "NO_ROW" };
  if (!Number.isSafeInteger(p.tubes) || p.tubes <= 0) return { ok: false, reason: "BAD_TUBES" };
  const total = Number(p.totalRawDamage);
  const durationMs = Number(p.durationMs);
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(durationMs) || durationMs <= 0) {
    return { ok: false, reason: "NO_RAW_DPS" };
  }
  const rawSquadronDps = total / (durationMs / 1000);
  const targetSquadronDps = (rowDps * Number(p.dpsPermille)) / PERMILLE / p.tubes;
  const max = Math.max(1, Math.trunc(Number(p.scaleMaxPermille)) || 1);
  const permille = Math.round((PERMILLE * targetSquadronDps) / rawSquadronDps);
  return { ok: true, permille: Math.min(max, Math.max(1, Number.isFinite(permille) ? permille : 1)) };
}

function nextCycleDue(state, nowMs) {
  if (!state || !Number.isFinite(state.nextCycleAtMs)) return true;
  return nowMs >= state.nextCycleAtMs;
}

function isStrikeKind(snapshot) {
  return isObject(snapshot) && STRIKE_KINDS.includes(snapshot.offensiveKind);
}

function scaleDamageVector(vector, permille) {
  const out = {};
  const factor = Number(permille) / PERMILLE;
  for (const type of DAMAGE_TYPES) {
    const value = Number(isObject(vector) ? vector[type] : 0);
    out[type] = Number.isFinite(value) && value > 0 && Number.isFinite(factor) ? round6(value * factor) : 0;
  }
  return out;
}

function sumDamage(vector) {
  if (!isObject(vector)) return 0;
  let sum = 0;
  for (const type of DAMAGE_TYPES) {
    const value = Number(vector[type]);
    if (Number.isFinite(value) && value > 0) sum += value;
  }
  return sum;
}

function reverseIndex(index) {
  const out = new Map();
  if (!isObject(index)) return out;
  for (const factionKey of Object.keys(index)) {
    const byClass = index[factionKey];
    if (!isObject(byClass)) continue;
    for (const cls of Object.keys(byClass)) {
      const entry = byClass[cls];
      if (isObject(entry) && typeof entry.profileId === "string") {
        out.set(entry.profileId, { factionId: Number(factionKey), cls, typeId: Number(entry.typeId) });
      }
    }
  }
  return out;
}

function classOfProfile(profileId, index) {
  const reverse = index instanceof Map ? index : reverseIndex(index);
  const entry = typeof profileId === "string" ? reverse.get(profileId) : undefined;
  return entry ? { ok: true, ...entry } : { ok: false, reason: "NO_CLASS" };
}

function rowDpsOf(typeId, cls, catalog) {
  if (!isObject(catalog)) return 0;
  const types = isObject(catalog.TYPES) ? catalog.TYPES : {};
  const rows = isObject(catalog.CAPITAL_STRENGTH_ROWS) ? catalog.CAPITAL_STRENGTH_ROWS : {};
  const key = String(typeId);
  const row = hasOwn(types, key) ? types[key] : (hasOwn(rows, cls) ? rows[cls] : null);
  const dps = Number(row && row.dps);
  return Number.isFinite(dps) && dps > 0 ? dps : 0;
}

module.exports = {
  STRIKE_KINDS,
  DAMAGE_TYPES,
  squadronScalePermille,
  nextCycleDue,
  isStrikeKind,
  scaleDamageVector,
  sumDamage,
  reverseIndex,
  classOfProfile,
  rowDpsOf,
};
