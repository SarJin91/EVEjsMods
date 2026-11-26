"use strict";

const PERMILLE = 1000;
const MAX_TYPE_IDS = 64;
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const invalid = (detail) => ({ ok: false, reason: "GOODS_INVALID", detail });

function mineralIdOf(key) {
  const m = /^type:(\d+)$/.exec(String(key));
  const id = m ? Number(m[1]) : 0;
  return isId(id) ? id : 0;
}

function mineralValueMilli(minerals, ref) {
  let sum = 0;
  for (const [key, amount] of Object.entries(minerals || {})) {
    const price = ref[key];
    if (!Number.isSafeInteger(price) || price <= 0 || !Number.isSafeInteger(amount) || amount < 0) return null;
    sum += amount * price;
    if (!Number.isSafeInteger(sum)) return null;
  }
  return sum;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

function buildContractGoods(data) {
  const d = data && typeof data === "object" ? data : null;
  if (!d) return invalid("data");
  for (const k of ["oreBands", "oreTypes", "refPriceMilli", "hullGroups", "hullRaces", "factionRace"]) {
    if (!d[k] || typeof d[k] !== "object") return invalid(k);
  }
  const factors = d.hullValueFactorPermille && typeof d.hullValueFactorPermille === "object"
    ? d.hullValueFactorPermille : {};
  const groupKeys = Array.isArray(d.hullGroupKeys) ? d.hullGroupKeys.filter((g) => typeof g === "string") : [];
  const ref = d.refPriceMilli;
  const typeIds = new Set();
  const ores = {};
  const minerals = {};
  for (const [band, spec] of Object.entries(d.oreBands)) {
    const oreRows = [];
    for (const ore of (spec && Array.isArray(spec.ores)) ? spec.ores : []) {
      const t = ore && d.oreTypes[String(ore.typeId)];
      const value = t ? mineralValueMilli(t.minerals, ref) : null;
      if (!isId(ore && ore.typeId) || !isId(ore.sharePermille) || !isId(value)) continue;
      oreRows.push({ typeId: ore.typeId, weight: ore.sharePermille, portionPriceMilli: value });
      typeIds.add(ore.typeId);
    }
    if (oreRows.length > 0) ores[band] = oreRows;
    const mineralRows = [];
    for (const [key, amount] of Object.entries((spec && spec.mineralsPerMillionM3) || {})) {
      const typeId = mineralIdOf(key);
      const price = ref[key];
      if (!typeId || !isId(amount) || !isId(price)) continue;
      mineralRows.push({ typeId, weight: amount, unitPriceMilli: price });
      typeIds.add(typeId);
    }
    if (mineralRows.length > 0) minerals[band] = mineralRows;
  }
  const hulls = {};
  for (const [race, byGroup] of Object.entries(d.hullRaces)) {
    const rows = [];
    for (const group of groupKeys) {
      const typeId = byGroup ? byGroup[group] : null;
      const g = d.hullGroups[group];
      const value = g ? mineralValueMilli(g.minerals, ref) : null;
      const factor = Number.isSafeInteger(factors[group]) && factors[group] > 0 ? factors[group] : PERMILLE;
      if (!isId(typeId) || !isId(value)) continue;
      const unitPriceMilli = Math.floor(value * factor / PERMILLE);
      if (!isId(unitPriceMilli)) continue;
      rows.push({ typeId, group, unitPriceMilli });
      typeIds.add(typeId);
    }
    if (rows.length > 0) hulls[race] = rows;
  }
  const factionRace = {};
  for (const [factionId, race] of Object.entries(d.factionRace)) {
    if (isId(Number(factionId)) && hulls[String(race)]) factionRace[factionId] = Number(race);
  }
  const ids = [...typeIds].sort((a, b) => a - b);
  if (ids.length === 0) return invalid("no goods");
  if (ids.length > MAX_TYPE_IDS) return invalid(`typeIds ${ids.length} > ${MAX_TYPE_IDS}`);
  const gas = [];
  const gasIds = new Set();
  for (const g of Array.isArray(d.gasTypes) ? d.gasTypes : []) {
    if (!g || !isId(g.typeId) || !isId(g.weight) || !isId(g.unitPriceMilli) || gasIds.has(g.typeId)) continue;
    gas.push({ typeId: g.typeId, weight: g.weight, unitPriceMilli: g.unitPriceMilli });
    gasIds.add(g.typeId);
  }
  if (gas.length === 0) return { ok: true, goods: deepFreeze({ ores, minerals, hulls, factionRace, typeIds: ids }) };
  const gasTypeIds = [...gasIds].sort((a, b) => a - b);
  if (gasTypeIds.length > MAX_TYPE_IDS) return invalid(`gasTypeIds ${gasTypeIds.length} > ${MAX_TYPE_IDS}`);
  return { ok: true, goods: deepFreeze({ ores, minerals, hulls, factionRace, typeIds: ids, gas, gasTypeIds }) };
}

module.exports = { buildContractGoods, MAX_TYPE_IDS };
