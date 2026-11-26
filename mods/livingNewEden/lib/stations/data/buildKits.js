"use strict";

const { STRUCTURE_TYPE_IDS } = require("./structureTypes");
const { INDUSTRY_STRUCTURE_FAMILIES } = require("../../economy/industry/classes");
const { effectiveFactorPermille } = require("../../economy/industry/componentFactor");

const BUILD_KIT_FAMILIES = INDUSTRY_STRUCTURE_FAMILIES;
const BUILD_KITS_VERSION = 2;
const PERMILLE = 1000;
const KIT_KIND = "upwell";
const MINERAL_KEY_RE = /^type:\d+$/;
const REASON = "KITS_INVALID";

const isInt = (v) => Number.isSafeInteger(v);

function invalid(detail) {
  return { ok: false, reason: REASON, detail: String(detail) };
}

function checkParams(params) {
  if (!params || typeof params !== "object") return "params";
  if (!isInt(params.componentWeightPermille) || params.componentWeightPermille < 0) return "componentWeightPermille";
  if (!isInt(params.componentFactorMaxPermille) || params.componentFactorMaxPermille < PERMILLE) {
    return "componentFactorMaxPermille";
  }
  if (!isInt(params.kitComponentFactorPermille) || params.kitComponentFactorPermille < PERMILLE) {
    return "kitComponentFactorPermille";
  }
  return null;
}

function buildKitTable(catalog, params) {
  try {
    const bad = checkParams(params);
    if (bad) return invalid(bad);
    if (!catalog || typeof catalog.kit !== "function") return invalid("catalog");
    const kits = {};
    for (const family of BUILD_KIT_FAMILIES) {
      const row = catalog.kit(family);
      if (!row || !row.minerals || typeof row.minerals !== "object") return invalid(`family ${family}`);
      if (row.typeId !== STRUCTURE_TYPE_IDS[family]) return invalid(`typeId ${family}`);
      const rowFactor = isInt(row.componentFactorPermille) ? row.componentFactorPermille : null;
      if (rowFactor === null || rowFactor < PERMILLE) return invalid(`componentFactorPermille ${family}`);
      const f = effectiveFactorPermille(Math.max(rowFactor, params.kitComponentFactorPermille), params);
      if (f === null) return invalid(`factor ${family}`);
      const items = {};
      for (const k of Object.keys(row.minerals).sort()) {
        const base = row.minerals[k];
        if (!MINERAL_KEY_RE.test(k) || !isInt(base) || base < 0) return invalid(`${family}.${k}`);
        if (base === 0) continue;
        const units = Math.ceil((base * f) / PERMILLE);
        if (!isInt(units)) return invalid(`${family}.${k} overflow`);
        items[`mineral/${k}`] = units;
      }
      if (Object.keys(items).length === 0) return invalid(`${family} has no minerals`);
      kits[family] = Object.freeze({ kind: KIT_KIND, structureFamily: family, typeId: row.typeId,
        factorPermille: f, items: Object.freeze(items) });
    }
    return { ok: true, kits: Object.freeze(kits) };
  } catch (err) {
    return invalid(`throw ${err && err.message}`);
  }
}

module.exports = { BUILD_KIT_FAMILIES, BUILD_KITS_VERSION, buildKitTable };
