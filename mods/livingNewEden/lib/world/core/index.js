"use strict";

const { FACTION_CORES_VERSION, FACTION_CORES } = require("./data");
const { buildCoreIndex, coreOwnerOf, isCoreStation, coreSystemIds, coreStationIds,
  auditCores, CORE_PROTECTED, CORE_VIOLATION_KINDS, CLAIM_STATES } = require("./coreIndex");
const { selectBastions, bastionOwnerOf, parseBastionKinds, BASTION_KIND_TOKENS } = require("./bastions");
const { NPC_SOV_DATA_VERSION, NPC_SOV_SYSTEMS } = require("./npcSovData");
const { FACTIONS_V1 } = require("../../strategy/data/factions");

const EMPTY_CORE_INDEX = Object.freeze({
  version: FACTION_CORES_VERSION,
  enabled: false,
  systems: new Map(),
  stations: new Map(),
  byFaction: new Map(),
  issues: [],
  bastions: new Map(),
  bastionIssues: [],
  bastionVersion: NPC_SOV_DATA_VERSION,
  bastionByFaction: new Map(),
});

let cachedConfigKey = null;
let cachedIndex = null;

function coresFor(config) {
  const flags = config && config.hive && config.hive.enabled === true ? ["hive"] : [];
  return FACTION_CORES.filter((c) => c.requiresFlag === undefined || flags.includes(c.requiresFlag));
}

function bastionSettingsOf(config) {
  const w = (config && config.world) || {};
  const exclude = String(w.npcSovBastionExcludeFactionIds ?? "").split(",").map((p) => p.trim())
    .filter((p) => /^\d+$/.test(p)).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
  return {
    enabled: w.npcSovBastionsEnabled === true,
    kinds: parseBastionKinds(w.npcSovBastionKinds).kinds,
    excludeFactionIds: [...new Set(exclude)].sort((a, b) => a - b),
    skipForeignHomeRegions: w.npcSovBastionSkipForeignHomeRegions === true,
    maxSystems: Math.max(1, Math.min(8192, Math.floor(Number(w.npcSovBastionMaxSystems) || 1))),
  };
}

function getCoreIndex(config) {
  const enabled = config?.world?.coreProtectionEnabled === true;
  const maxSystems = Math.max(1, Math.min(8, Math.floor(config?.world?.coreMaxSystemsPerFaction ?? 3)));
  const hiveOn = config?.hive?.enabled === true;
  const bs = bastionSettingsOf(config);
  const key = `${enabled}:${maxSystems}:${hiveOn}:${bs.enabled}:${bs.kinds.join(",")}:`
    + `${bs.excludeFactionIds.join(",")}:${bs.skipForeignHomeRegions}:${bs.maxSystems}`;

  if (cachedConfigKey === key && cachedIndex) return cachedIndex;

  if (!enabled && !bs.enabled) {
    cachedConfigKey = key;
    cachedIndex = EMPTY_CORE_INDEX;
    return cachedIndex;
  }

  const cores = buildCoreIndex(coresFor(config), { enabled, maxSystems, version: FACTION_CORES_VERSION });
  const picked = selectBastions(NPC_SOV_SYSTEMS, FACTIONS_V1, bs, cores.systems);
  const systems = new Map(cores.systems);
  for (const [systemId, factionId] of picked.systems) if (!systems.has(systemId)) systems.set(systemId, factionId);
  const idx = Object.freeze({
    version: cores.version,
    enabled: true,
    systems: Object.freeze(systems),
    stations: cores.stations,
    byFaction: cores.byFaction,
    issues: cores.issues,
    bastions: Object.freeze(picked.systems),
    bastionIssues: Object.freeze([...picked.issues]),
    bastionVersion: NPC_SOV_DATA_VERSION,
    bastionByFaction: Object.freeze(picked.byFaction),
  });
  cachedConfigKey = key;
  cachedIndex = idx;
  return idx;
}

module.exports = {
  getCoreIndex,
  coresFor,
  bastionSettingsOf,
  EMPTY_CORE_INDEX,
  FACTION_CORES_VERSION,
  FACTION_CORES,
  NPC_SOV_DATA_VERSION,
  buildCoreIndex,
  coreOwnerOf,
  isCoreStation,
  coreSystemIds,
  coreStationIds,
  auditCores,
  selectBastions,
  bastionOwnerOf,
  parseBastionKinds,
  BASTION_KIND_TOKENS,
  CORE_PROTECTED,
  CORE_VIOLATION_KINDS,
  CLAIM_STATES,
};
