"use strict";

const DRILL_PACK_ID = "planetary-drill";
const PI_PACK_ID = "pi-blueprints";
const OFFICER_PACK_ID = "officer-blueprints";
const INDUSTRY_SKILL_TYPE_ID = 3380;

const ORIGINAL_TAG = "o";

function priceClassOf(packID, definition) {
  if (packID === OFFICER_PACK_ID) return "officer";
  if (packID === DRILL_PACK_ID) return "drill";
  if (packID !== PI_PACK_ID) return "default";
  const manufacturing = definition && definition.activities && definition.activities.manufacturing;
  const skills = manufacturing && Array.isArray(manufacturing.skills) ? manufacturing.skills : [];
  const industry = skills.find((skill) => skill && skill.typeID === INDUSTRY_SKILL_TYPE_ID);
  const level = industry ? industry.level : 0;
  return Number.isSafeInteger(level) && level >= 1 && level <= 4 ? `P${level}` : "default";
}

function runsOf(cfg, maxRuns) {
  if (cfg.blueprintKind !== "copy") return null;
  return Math.max(1, Math.min(cfg.copyRuns, maxRuns));
}

function kindTagOf(runs) {
  return runs === null ? ORIGINAL_TAG : `c${runs}`;
}

function buildCatalog(plan, cfg) {
  const entries = [];
  const overrides = cfg.priceOverrides instanceof Map ? cfg.priceOverrides : new Map();
  for (const pack of (plan && Array.isArray(plan.packs) ? plan.packs : [])) {
    const hints = pack.shop && typeof pack.shop === "object" ? pack.shop : {};
    for (const definition of (Array.isArray(pack.definitions) ? pack.definitions : [])) {
      const typeID = definition && definition.blueprintTypeID;
      if (!Number.isSafeInteger(typeID) || typeID <= 0) continue;
      const hint = hints[String(typeID)] || null;
      if (hint && hint.listed === false) continue;
      const packPrice = hint && Number.isSafeInteger(hint.price) && hint.price > 0 ? hint.price : null;
      const priceClass = priceClassOf(pack.packID, definition);
      const maxRuns = Number.isSafeInteger(definition.maxProductionLimit) && definition.maxProductionLimit > 0
        ? definition.maxProductionLimit : 1;
      const runs = runsOf(cfg, maxRuns);
      const officer = priceClass === "officer";
      entries.push({
        typeID,
        name: String(definition.blueprintName || `Blueprint ${typeID}`),
        packID: pack.packID,
        priceClass,
        price: overrides.has(typeID) ? overrides.get(typeID) : (packPrice !== null ? packPrice : cfg.price[priceClass]),
        maxRuns,
        runs,
        kindTag: kindTagOf(runs),
        stations: officer ? [...(Array.isArray(cfg.officerStations) ? cfg.officerStations : [])] : null,
        perType: officer ? cfg.officerContractsPerType : null,
      });
    }
  }
  return entries.sort((left, right) => left.typeID - right.typeID);
}

function unknownOverrideTypeIDs(catalog, cfg) {
  const known = new Set(catalog.map((entry) => entry.typeID));
  const overrides = cfg.priceOverrides instanceof Map ? cfg.priceOverrides : new Map();
  return [...overrides.keys()].filter((typeID) => !known.has(typeID)).sort((left, right) => left - right);
}

module.exports = {
  DRILL_PACK_ID,
  INDUSTRY_SKILL_TYPE_ID,
  OFFICER_PACK_ID,
  ORIGINAL_TAG,
  PI_PACK_ID,
  buildCatalog,
  kindTagOf,
  priceClassOf,
  unknownOverrideTypeIDs,
};
