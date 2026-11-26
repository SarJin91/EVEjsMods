"use strict";

const BASTION_KIND_TOKENS = Object.freeze(["pirate", "empire", "police", "neutral", "invader", "hive", "unregistered"]);
const UNREGISTERED = "unregistered";

function parseBastionKinds(value) {
  const kinds = [];
  const unknown = [];
  for (const raw of String(value === undefined || value === null ? "" : value).split(",")) {
    const token = raw.trim();
    if (token === "") continue;
    if (!BASTION_KIND_TOKENS.includes(token)) unknown.push(token);
    else if (!kinds.includes(token)) kinds.push(token);
  }
  return { kinds, unknown };
}

const emptySkipped = () => ({ kind: 0, excluded: 0, foreignHome: 0, foreignStation: 0, core: 0 });

function selectBastions(catalog, factions, settings, coreSystems) {
  const skipped = emptySkipped();
  if (!settings || settings.enabled !== true || !Array.isArray(catalog)) {
    return { systems: new Map(), byFaction: new Map(), issues: [], skipped };
  }
  const kinds = Array.isArray(settings.kinds) ? settings.kinds : [];
  const excluded = new Set(Array.isArray(settings.excludeFactionIds) ? settings.excludeFactionIds : []);
  const registry = new Map();
  const homeFactionsByRegion = new Map();
  const stationFactionsBySystem = new Map();
  for (const f of Array.isArray(factions) ? factions : []) {
    if (!f || !Number.isSafeInteger(f.factionId)) continue;
    registry.set(f.factionId, f);
    if (f.activity !== "passive") {
      for (const regionId of Array.isArray(f.homeRegionIds) ? f.homeRegionIds : []) {
        if (!homeFactionsByRegion.has(regionId)) homeFactionsByRegion.set(regionId, new Set());
        homeFactionsByRegion.get(regionId).add(f.factionId);
      }
    }
    for (const st of Array.isArray(f.startStations) ? f.startStations : []) {
      if (!st || !Number.isSafeInteger(st.systemId)) continue;
      if (!stationFactionsBySystem.has(st.systemId)) stationFactionsBySystem.set(st.systemId, new Set());
      stationFactionsBySystem.get(st.systemId).add(f.factionId);
    }
  }
  const foreignIn = (set, factionId) => !!set && [...set].some((id) => id !== factionId);
  const cores = coreSystems instanceof Map ? coreSystems : new Map();

  const issues = [];
  const systems = new Map();
  const byFaction = new Map();
  for (const row of catalog) {
    if (!Array.isArray(row)) continue;
    const [systemId, factionId, regionId] = row;
    if (!Number.isSafeInteger(systemId) || !Number.isSafeInteger(factionId) || factionId <= 0) continue;
    const entry = registry.get(factionId);
    const kind = entry ? entry.kind : UNREGISTERED;
    if (!kinds.includes(kind)) { skipped.kind += 1; continue; }
    if (excluded.has(factionId)) { skipped.excluded += 1; continue; }
    if (settings.skipForeignHomeRegions === true && foreignIn(homeFactionsByRegion.get(regionId), factionId)) {
      skipped.foreignHome += 1;
      continue;
    }
    if (foreignIn(stationFactionsBySystem.get(systemId), factionId)) { skipped.foreignStation += 1; continue; }
    const coreOwner = cores.get(systemId);
    if (coreOwner !== undefined && coreOwner !== factionId) {
      skipped.core += 1;
      issues.push(`bastion:${systemId}: core ${coreOwner} wins over ${factionId}`);
      continue;
    }
    systems.set(systemId, factionId);
    byFaction.set(factionId, (byFaction.get(factionId) || 0) + 1);
  }
  const max = Number.isSafeInteger(settings.maxSystems) ? settings.maxSystems : 0;
  if (systems.size > max) {
    issues.push(`BASTIONS_OVER_LIMIT n=${systems.size} max=${max}`);
    return { systems: new Map(), byFaction: new Map(), issues, skipped };
  }
  return { systems, byFaction, issues, skipped };
}

function bastionOwnerOf(index, systemId) {
  if (!index || !index.enabled || !(index.bastions instanceof Map)) return null;
  return index.bastions.get(systemId) ?? null;
}

module.exports = { selectBastions, bastionOwnerOf, parseBastionKinds, BASTION_KIND_TOKENS };
