"use strict";

const { HULL_GROUPS } = require("../fleets/schema");
const { WRECK_YIELD } = require("./data/wreckYield");
const {
  PPM, MAX_UNITS, MAX_COMPOSITION_BYTES, FIELD_ID_PREFIX, SOURCE_BATTLE, SOURCE_STRUCTURE, MAX_BATTLE_ID_LENGTH, MAX_ENUM_LENGTH,
  SOURCE_GANK, OUTCOME_GANKED, GANK_FIELD_PREFIX, MAX_FIELD_ID_LENGTH,
} = require("./wreckSchema");

const SETTING_NAMES = Object.freeze(["fieldTtlMs", "decayFloor", "minShipsLost", "maxCompositionEntries",
  "salvageYieldFactor", "lootYieldFactor", "stockLootPermille"]);

const isText = (v, max) => typeof v === "string" && v.length >= 1 && v.length <= max;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isPositiveInt = (v) => Number.isSafeInteger(v) && v > 0;
const isFactor = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const invalid = (detail) => ({ ok: false, reason: "WRECK_INPUT_INVALID", detail });

function checkSettings(s) {
  if (!s || typeof s !== "object") return "settings";
  if (!isPositiveInt(s.fieldTtlMs)) return "fieldTtlMs";
  if (typeof s.decayFloor !== "number" || !(s.decayFloor >= 0 && s.decayFloor <= 1)) return "decayFloor";
  if (!isPositiveInt(s.minShipsLost)) return "minShipsLost";
  if (!isPositiveInt(s.maxCompositionEntries)) return "maxCompositionEntries";
  if (!isFactor(s.salvageYieldFactor)) return "salvageYieldFactor";
  if (!isFactor(s.lootYieldFactor)) return "lootYieldFactor";
  const stockLoot = s.stockLootPermille === undefined ? 100 : s.stockLootPermille;
  if (!Number.isSafeInteger(stockLoot) || stockLoot < 0 || stockLoot > 1000) return "stockLootPermille";
  return null;
}

const byKey = (a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0) || a[2] - b[2];

function aggregate(rows, keepType) {
  const map = new Map();
  for (const r of rows) {
    const typeId = keepType ? r.typeId : 0;
    const key = `${r.factionId}|${r.hullGroup}|${typeId}`;
    const entry = map.get(key);
    if (entry) entry[3] += r.count;
    else map.set(key, [r.factionId, r.hullGroup, typeId, r.count]);
  }
  return [...map.values()].sort(byKey);
}

const units = (base, factor) => Math.min(MAX_UNITS, Math.floor(base * factor));

function buildWreckField(settled, settings) {
  const bad = checkSettings(settings);
  if (bad) return invalid(`settings.${bad}`);
  if (!settled || typeof settled !== "object") return invalid("settled");
  if (!isText(settled.battleId, MAX_BATTLE_ID_LENGTH)) return invalid("battleId");
  if (!isPositiveInt(settled.systemId)) return invalid("systemId");
  if (!isText(settled.environment, MAX_ENUM_LENGTH)) return invalid("environment");
  if (settled.outcome !== null && settled.outcome !== undefined && !isText(settled.outcome, MAX_ENUM_LENGTH)) {
    return invalid("outcome");
  }
  const winner = settled.winnerFactionId === undefined ? null : settled.winnerFactionId;
  if (winner !== null && !isPositiveInt(winner)) return invalid("winnerFactionId");
  if (!isTime(settled.at)) return invalid("at");
  const expiresAt = settled.at + settings.fieldTtlMs;
  if (!Number.isSafeInteger(expiresAt)) return invalid("expiresAt");
  if (!Array.isArray(settled.losses)) return invalid("losses");
  const rows = [];
  let shipsLost = 0;
  let salvageBase = 0;
  let lootBase = 0;
  for (const l of settled.losses) {
    if (!l || !isPositiveInt(l.factionId)) return invalid("losses.factionId");
    if (!HULL_GROUPS.includes(l.hullGroup)) return invalid("losses.hullGroup");
    const typeId = l.typeId === null || l.typeId === undefined ? 0 : l.typeId;
    if (!Number.isSafeInteger(typeId) || typeId < 0) return invalid("losses.typeId");
    if (!isPositiveInt(l.count)) return invalid("losses.count");
    rows.push({ factionId: l.factionId, hullGroup: l.hullGroup, typeId, count: l.count });
    shipsLost += l.count;
    salvageBase += WRECK_YIELD[l.hullGroup].salvage * l.count;
    lootBase += WRECK_YIELD[l.hullGroup].loot * l.count;
  }
  if (!Number.isSafeInteger(shipsLost)) return invalid("losses.count");
  if (shipsLost === 0) return { ok: true, skip: "NO_LOSSES", field: null };
  if (shipsLost < settings.minShipsLost) return { ok: true, skip: "BELOW_MIN_SHIPS", field: null };
  let composition = aggregate(rows, true);
  let collapsed = false;
  if (composition.length > settings.maxCompositionEntries
    || JSON.stringify(composition).length > MAX_COMPOSITION_BYTES) {
    composition = aggregate(rows, false);
    collapsed = true;
  }
  if (JSON.stringify(composition).length > MAX_COMPOSITION_BYTES) return invalid("composition");
  const field = {
    fieldId: `${FIELD_ID_PREFIX}${settled.battleId}`,
    battleId: settled.battleId,
    source: SOURCE_BATTLE,
    systemId: settled.systemId,
    environment: settled.environment,
    outcome: settled.outcome === undefined ? null : settled.outcome,
    winnerFactionId: winner,
    shipsLost,
    composition,
    salvageUnits: units(salvageBase, settings.salvageYieldFactor),
    lootUnits: units(lootBase, settings.lootYieldFactor),
    decayFloorPpm: Math.round(settings.decayFloor * PPM),
    createdAt: settled.at,
    expiresAt,
  };
  return { ok: true, skip: null, field, collapsed };
}

function fractionPpm(field, at) {
  const ttl = field.expiresAt - field.createdAt;
  const elapsed = Math.min(Math.max(at - field.createdAt, 0), ttl);
  if (elapsed >= ttl) return field.decayFloorPpm;
  return Math.floor(PPM - ((PPM - field.decayFloorPpm) * elapsed) / ttl);
}

function effectivePool(field, at) {
  if (at >= field.expiresAt) return { salvage: 0, loot: 0, total: 0, expired: true };
  const ppm = fractionPpm(field, at);
  const decayed = (rest) => (rest === 0 ? 0 : Math.floor((rest * ppm + PPM - 1) / PPM));
  const salvage = decayed(leftOf(field.salvageUnits, field.salvagedSalvageUnits));
  const loot = decayed(leftOf(field.lootUnits, field.salvagedLootUnits));
  return { salvage, loot, total: salvage + loot, expired: false };
}

function leftOf(base, taken) {
  return Math.max(0, base - (Number.isSafeInteger(taken) ? taken : 0));
}

function claimShare(field, at, permille) {
  if (!Number.isSafeInteger(permille) || permille < 0 || permille > 1000) return invalid("permille");
  const takenS = Number.isSafeInteger(field.salvagedSalvageUnits) ? field.salvagedSalvageUnits : 0;
  const takenL = Number.isSafeInteger(field.salvagedLootUnits) ? field.salvagedLootUnits : 0;
  const takeS = Math.floor((leftOf(field.salvageUnits, takenS) * permille) / 1000);
  const takeL = Math.floor((leftOf(field.lootUnits, takenL) * permille) / 1000);
  const salvaged = { salvageUnits: takenS + takeS, lootUnits: takenL + takeL };
  const before = effectivePool(field, at);
  const after = effectivePool({ ...field, salvagedSalvageUnits: salvaged.salvageUnits,
    salvagedLootUnits: salvaged.lootUnits }, at);
  const haul = { salvage: before.salvage - after.salvage, loot: before.loot - after.loot };
  return { ok: true, haul, salvaged, empty: takeS + takeL === 0 || haul.salvage + haul.loot === 0 };
}

function buildStructureWreckField(params, settings) {
  const bad = checkSettings(settings);
  if (bad) return invalid(`settings.${bad}`);
  if (!params || typeof params !== "object") return invalid("params");
  if (!isText(params.stationId, 64)) return invalid("stationId");
  if (!Number.isSafeInteger(params.siegeNo) || params.siegeNo < 1) return invalid("siegeNo");
  if (!isPositiveInt(params.systemId)) return invalid("systemId");
  if (!isText(params.environment, MAX_ENUM_LENGTH)) return invalid("environment");
  if (!isPositiveInt(params.ownerFactionId)) return invalid("ownerFactionId");
  if (!isPositiveInt(params.winnerFactionId)) return invalid("winnerFactionId");
  if (!Number.isSafeInteger(params.typeId) || params.typeId < 0) return invalid("typeId");
  if (!isText(params.family, 32)) return invalid("family");
  if (!Number.isSafeInteger(params.lostUnits) || params.lostUnits < 0) return invalid("lostUnits");
  if (!isTime(params.at)) return invalid("at");
  const expiresAt = params.at + settings.fieldTtlMs;
  if (!Number.isSafeInteger(expiresAt)) return invalid("expiresAt");

  const composition = [[params.ownerFactionId, "capital", params.typeId, 1]];

  const structureDefense = require("../stations/data/structureDefense");
  const familyData = structureDefense.STRUCTURE_DEFENSE[params.family];
  const defenseWreck = (familyData && familyData.wreck) || { salvage: 0, loot: 0 };
  const salvageBase = defenseWreck.salvage;
  const lootBase = defenseWreck.loot + Math.floor(params.lostUnits * settings.stockLootPermille / 1000);

  const fieldId = `wf:st:${params.stationId}:${params.siegeNo}`;
  if (fieldId.length > 80) return invalid("fieldId length");

  const field = {
    fieldId,
    battleId: null,
    source: SOURCE_STRUCTURE,
    systemId: params.systemId,
    environment: params.environment,
    outcome: "DESTROYED",
    winnerFactionId: params.winnerFactionId,
    shipsLost: 1,
    composition,
    salvageUnits: units(salvageBase, settings.salvageYieldFactor),
    lootUnits: units(lootBase, settings.lootYieldFactor),
    decayFloorPpm: Math.round(settings.decayFloor * PPM),
    createdAt: params.at,
    expiresAt,
  };
  return { ok: true, field };
}

const GANK_ENVIRONMENT = "highsec";

function buildGankWreckField(params, settings) {
  const bad = checkSettings(settings);
  if (bad) return invalid(`settings.${bad}`);
  if (!params || typeof params !== "object") return invalid("params");
  if (!isPositiveInt(params.systemId)) return invalid("systemId");
  if (!isTime(params.bucket)) return invalid("bucket");
  if (!isTime(params.at)) return invalid("at");
  if (!isPositiveInt(params.factionId)) return invalid("factionId");
  if (!isPositiveInt(params.ttlMs)) return invalid("ttlMs");
  const victim = params.victim;
  if (!victim || !HULL_GROUPS.includes(victim.hullGroup)) return invalid("victim.hullGroup");
  if (!isPositiveInt(victim.typeId)) return invalid("victim.typeId");
  const gankers = params.gankers;
  if (!gankers || !HULL_GROUPS.includes(gankers.hullGroup)) return invalid("gankers.hullGroup");
  if (!isPositiveInt(gankers.typeId)) return invalid("gankers.typeId");
  if (!Number.isSafeInteger(gankers.count) || gankers.count < 0) return invalid("gankers.count");
  const expiresAt = params.at + params.ttlMs;
  if (!Number.isSafeInteger(expiresAt)) return invalid("expiresAt");
  const fieldId = `${GANK_FIELD_PREFIX}${params.systemId}:${params.bucket}`;
  if (fieldId.length > MAX_FIELD_ID_LENGTH) return invalid("fieldId length");

  const rows = [{ factionId: params.factionId, hullGroup: victim.hullGroup, typeId: victim.typeId, count: 1 }];
  if (gankers.count > 0) {
    rows.push({ factionId: params.factionId, hullGroup: gankers.hullGroup, typeId: gankers.typeId,
      count: gankers.count });
  }
  const composition = aggregate(rows, true);
  let salvageBase = 0;
  let lootBase = 0;
  for (const r of rows) {
    salvageBase += WRECK_YIELD[r.hullGroup].salvage * r.count;
    lootBase += WRECK_YIELD[r.hullGroup].loot * r.count;
  }
  const field = {
    fieldId,
    battleId: null,
    source: SOURCE_GANK,
    systemId: params.systemId,
    environment: GANK_ENVIRONMENT,
    outcome: OUTCOME_GANKED,
    winnerFactionId: null,
    shipsLost: 1 + gankers.count,
    composition,
    salvageUnits: units(salvageBase, settings.salvageYieldFactor),
    lootUnits: units(lootBase, settings.lootYieldFactor),
    decayFloorPpm: Math.round(settings.decayFloor * PPM),
    createdAt: params.at,
    expiresAt,
  };
  return { ok: true, field };
}

module.exports = { SETTING_NAMES, checkSettings, buildWreckField, fractionPpm, effectivePool, claimShare,
  buildStructureWreckField, buildGankWreckField };
