"use strict";

const MAX_DETAIL_LENGTH = 200;
const MAX_SYSTEMS = 256;
const MAX_ORES = 64;
const MAX_NAME_LENGTH = 64;
const MAX_ICE = 16;
const MAX_ISSUES = 8;
const MAX_FAMILIES = 64;
const MAX_FAMILY_LENGTH = 32;

const DRIFT = "LOCAL_RESOURCES_DRIFT";
const FAILED = "LOCAL_RESOURCES_FAILED";
const SYM_BELTS = "asteroidData.getBeltsForSystem";
const SYM_ENRICHED = "asteroidService._testing.buildEnrichedSystemOrePool";
const SYM_RAW = "miningVisuals.getSolarSystemOreTypeRecords";
const SYM_ICE = "iceSystemAuthority.getIceSystemAuthorityRow";
const SYM_TIER = "oreAnomalySecurityAuthority.resolveSecurityTierForSystemID";
const SYM_CATALOG = "oreAnomalySecurityAuthority.listCatalogEntries";

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const clip = (text) => String(text).slice(0, MAX_DETAIL_LENGTH);
const messageOf = (err) => String((err && err.message) || err);
const refuse = (reason, detail) => ({ ok: false, reason, detail: clip(detail) });
const fnOf = (obj, name) => {
  try {
    return obj && typeof obj[name] === "function" ? obj[name] : null;
  } catch (_err) {
    return null;
  }
};
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function oresOf(rows) {
  const byId = new Map();
  for (const row of rows) {
    const typeId = row && row.typeID;
    if (!isId(typeId) || byId.has(typeId)) continue;
    byId.set(typeId, { typeId, name: typeof row.name === "string" ? row.name.slice(0, MAX_NAME_LENGTH) : null });
  }
  return [...byId.values()].sort((a, b) => a.typeId - b.typeId).slice(0, MAX_ORES);
}

function iceOf(row) {
  if (row === null || row === undefined) return { typeIds: [], names: [] };
  const ids = Array.isArray(row.iceTypeIDs) ? row.iceTypeIDs : [];
  const names = Array.isArray(row.iceTypeNames) ? row.iceTypeNames : [];
  return {
    typeIds: ids.filter(isId).slice(0, MAX_ICE),
    names: names.filter((n) => typeof n === "string").map((n) => n.slice(0, MAX_NAME_LENGTH)).slice(0, MAX_ICE),
  };
}

function familyMatcher(families) {
  if (families.length === 0) return null;
  const sorted = [...families].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
  return new RegExp(`(?<![A-Za-z])(?:${sorted.map(escapeRe).join("|")})(?![A-Za-z])`, "g");
}

function readLocalResourcesFrom(mods, systemIds, families) {
  const m = mods && typeof mods === "object" ? mods : {};
  const getBelts = fnOf(m.asteroidData, "getBeltsForSystem");
  if (!getBelts) return refuse(DRIFT, SYM_BELTS);
  let testing = null;
  try {
    testing = m.asteroidService ? m.asteroidService._testing : null;
  } catch (_err) {
    testing = null;
  }
  const enriched = fnOf(testing, "buildEnrichedSystemOrePool");
  const raw = enriched ? null : fnOf(m.miningVisuals, "getSolarSystemOreTypeRecords");
  if (!enriched && !raw) return refuse(DRIFT, `${SYM_ENRICHED},${SYM_RAW}`);

  if (!Array.isArray(systemIds) || systemIds.length === 0 || systemIds.length > MAX_SYSTEMS
    || !systemIds.every(isId)) {
    return refuse(FAILED, "systemIds");
  }
  if (!Array.isArray(families) || families.length > MAX_FAMILIES
    || !families.every((f) => typeof f === "string" && f.length > 0 && f.length <= MAX_FAMILY_LENGTH)) {
    return refuse(FAILED, "families");
  }

  const drift = [];
  if (!enriched) drift.push(SYM_ENRICHED);
  const getIce = fnOf(m.iceAuthority, "getIceSystemAuthorityRow");
  if (!getIce) drift.push(SYM_ICE);
  const getTier = fnOf(m.anomalyAuthority, "resolveSecurityTierForSystemID");
  const listCatalog = fnOf(m.anomalyAuthority, "listCatalogEntries");
  if (!getTier) drift.push(SYM_TIER);
  if (!listCatalog) drift.push(SYM_CATALOG);
  const matcher = familyMatcher([...new Set(families)]);
  const catalogByTier = new Map();
  const issues = [];
  const issue = (source, systemId, err) => {
    if (issues.length < MAX_ISSUES) issues.push({ source, systemId, detail: clip(messageOf(err)) });
  };

  const systems = new Map();
  for (const id of systemIds) {
    if (systems.has(id)) continue;
    let beltCount;
    let poolSource;
    let ores;
    let step = "belts";
    try {
      const belts = getBelts.call(m.asteroidData, id);
      beltCount = Array.isArray(belts) ? belts.length : 0;
      step = "pool";
      if (beltCount === 0) {
        poolSource = "NONE";
        ores = [];
      } else if (enriched) {
        const pool = enriched.call(testing, id);
        if (!pool || !Array.isArray(pool.orePool)) return refuse(FAILED, `pool:${id}: orePool shape`);
        poolSource = "ENRICHED";
        ores = oresOf(pool.orePool);
      } else {
        const rows = raw.call(m.miningVisuals, id);
        if (!Array.isArray(rows)) return refuse(FAILED, `pool:${id}: ore records shape`);
        poolSource = "RAW";
        ores = oresOf(rows);
      }
    } catch (err) {
      return refuse(FAILED, `${step}:${id}: ${messageOf(err)}`);
    }

    let ice = null;
    if (getIce) {
      try {
        ice = iceOf(getIce.call(m.iceAuthority, id));
      } catch (err) {
        ice = null;
        issue("ice", id, err);
      }
    }

    let anomaly = null;
    if (getTier && listCatalog) {
      try {
        const tier = getTier.call(m.anomalyAuthority, id);
        if (typeof tier !== "string") {
          issue("anomaly", id, "tier is not a string");
        } else {
          if (!catalogByTier.has(tier)) {
            const entries = listCatalog.call(m.anomalyAuthority, tier);
            catalogByTier.set(tier, Array.isArray(entries) ? entries : []);
          }
          const found = new Set();
          if (matcher) {
            for (const entry of catalogByTier.get(tier)) {
              const name = entry && typeof entry.expectedName === "string" ? entry.expectedName : "";
              for (const hit of name.matchAll(matcher)) found.add(hit[0]);
            }
          }
          anomaly = { tier: tier.slice(0, MAX_NAME_LENGTH), families: [...found].sort() };
        }
      } catch (err) {
        anomaly = null;
        issue("anomaly", id, err);
      }
    }
    systems.set(id, { systemId: id, beltCount, poolSource, ores, ice, anomaly });
  }
  return { ok: true, systems, drift, issues };
}

module.exports = { readLocalResourcesFrom, LOCAL_RESOURCES_DRIFT: DRIFT, LOCAL_RESOURCES_FAILED: FAILED };
