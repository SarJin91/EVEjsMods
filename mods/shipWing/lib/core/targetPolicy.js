"use strict";

const TARGET_REFUSAL = Object.freeze(["NO_TARGET", "TARGET_NOT_NPC", "TARGET_OUT_OF_RANGE"]);

const CONCORD_TYPE = "concord";
const DRIFTER_TYPE = "drifter";
const DRIFTER_FACTION_ID = 500024;
const SITE_KILLABLE_STRUCTURE_KIND = "siteKillableStructure";
const SITE_ENVIRONMENT_PROP_KIND = "siteEnvironmentProp";
const SITE_CONTENT_OWNER_ID = 1;
const ENTITY_CATEGORY_ID = 11;
const SPAWN_CONTAINER_GROUP_ID = 306;
const NPC_FACTION_ID_MIN = 500000;
const NPC_FACTION_ID_MAX = 599999;
const NPC_CORP_ID_MIN = 1000000;
const NPC_CORP_ID_MAX = 1999999;
const CONCORD_OWNER_IDS = new Set([500006, 1000125, 1000137]);

function toInt(value, fallback = 0) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

function refuse(reason) {
  return { ok: false, reason };
}

function entityType(target) {
  return String(target.npcEntityType || "").trim().toLowerCase();
}

function isDrifter(target) {
  return entityType(target) === DRIFTER_TYPE || toInt(target.factionID, 0) === DRIFTER_FACTION_ID;
}

function hasPilot(target) {
  return Boolean(target.session) || toInt(target.pilotCharacterID, 0) > 0 || toInt(target.characterID, 0) > 0;
}

function isNpcShip(target, config) {
  if (target.kind !== "ship" || target.nativeNpc !== true) return false;
  if (hasPilot(target)) return false;
  if (entityType(target) === CONCORD_TYPE) return false;
  if (isDrifter(target) && config.combatAllowDrifterTargets !== true) return false;
  return true;
}

function isNpcOwnerId(ownerId) {
  if (CONCORD_OWNER_IDS.has(ownerId)) return false;
  if (ownerId === 0 || ownerId === SITE_CONTENT_OWNER_ID) return true;
  if (ownerId >= NPC_FACTION_ID_MIN && ownerId <= NPC_FACTION_ID_MAX) return true;
  return ownerId >= NPC_CORP_ID_MIN && ownerId <= NPC_CORP_ID_MAX;
}

function isSiteStructureKind(target) {
  if (target.dungeonMaterializedSiteContent !== true) return false;
  if (target.kind === SITE_KILLABLE_STRUCTURE_KIND) return true;
  if (target.kind !== SITE_ENVIRONMENT_PROP_KIND || target.dungeonMaterializedEnvironment !== true) return false;
  if (toInt(target.categoryID, 0) !== ENTITY_CATEGORY_ID) return false;
  return toInt(target.groupID, 0) !== SPAWN_CONTAINER_GROUP_ID && target.dungeonNativeWeatherAnchor !== true;
}

function isNpcSiteStructure(target, config, c) {
  if (config.combatAllowNpcStructureTargets !== true || c.allowStructures !== true) return false;
  if (!isSiteStructureKind(target)) return false;
  if (hasPilot(target)) return false;
  if (!isNpcOwnerId(toInt(target.ownerID, 0))) return false;
  if (entityType(target) === CONCORD_TYPE) return false;
  if (isDrifter(target) && config.combatAllowDrifterTargets !== true) return false;
  return c.damageable === true;
}

function isAllowedTarget(target, ctx) {
  const c = ctx || {};
  const config = c.config || {};
  if (!target || typeof target !== "object" || c.destroying === true) return refuse("NO_TARGET");
  if (!isNpcShip(target, config) && !isNpcSiteStructure(target, config, c)) return refuse("TARGET_NOT_NPC");
  if (c.twin && toInt(target.itemID, 0) === toInt(c.twin.itemID, 0)) return refuse("TARGET_NOT_NPC");
  if (c.sameScene !== true || c.interacts === false) return refuse("TARGET_OUT_OF_RANGE");
  const distance = Number(c.hostDistanceM);
  const range = Number(config.controlRangeMeters);
  if (!Number.isFinite(distance) || !Number.isFinite(range) || distance > range) return refuse("TARGET_OUT_OF_RANGE");
  return { ok: true };
}

module.exports = { TARGET_REFUSAL, DRIFTER_FACTION_ID, isAllowedTarget };
