"use strict";

// Objective target rules, ported 1:1 from EveJS 261108.1 server/src/services/dungeon/dungeonUniverseSiteService.js.

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function normalizeText(value, fallback = "") {
  const normalized = String(value == null ? "" : value).trim();
  return normalized || fallback;
}

function normalizeLowerText(value, fallback = "") {
  return normalizeText(value, fallback).toLowerCase();
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeObjectiveTargets(completion) {
  const source = completion && typeof completion === "object" ? completion : {};
  return normalizeArray(
    source.objectiveTargets ||
    source.objectiveTarget ||
    source.destroyTargets ||
    source.destroyTarget ||
    source.targetObjects ||
    source.targetObject,
  )
    .filter((entry) => entry && typeof entry === "object")
    .map((entry) => ({
      key: normalizeText(entry.key, "") || null,
      label: normalizeText(entry.label || entry.name, "") || null,
      typeID: Math.max(0, toInt(entry.typeID, 0)) || null,
      dunObjectID: Math.max(0, toInt(entry.dunObjectID, 0)) || null,
      dunObjectNameID: Math.max(0, toInt(entry.dunObjectNameID, 0)) || null,
      nameID: Math.max(0, toInt(entry.nameID, 0)) || null,
    }))
    .filter((entry) => (
      entry.key ||
      entry.label ||
      entry.typeID ||
      entry.dunObjectID ||
      entry.dunObjectNameID ||
      entry.nameID
    ));
}

function matchesObjectiveTarget(candidate, target) {
  if (!candidate || !target) {
    return false;
  }
  const targetKey = normalizeText(target.key, "");
  if (
    targetKey &&
    normalizeText(candidate.key || candidate.dungeonSiteContentKey || candidate.dungeonObjectiveTargetKey, "") === targetKey
  ) {
    return true;
  }
  const targetDunObjectID = Math.max(0, toInt(target.dunObjectID, 0));
  if (
    targetDunObjectID > 0 &&
    Math.max(0, toInt(candidate.dunObjectID, 0)) === targetDunObjectID
  ) {
    return true;
  }
  const targetNameID = Math.max(0, toInt(target.nameID || target.dunObjectNameID, 0));
  if (
    targetNameID > 0 &&
    (
      Math.max(0, toInt(candidate.nameID, 0)) === targetNameID ||
      Math.max(0, toInt(candidate.dunObjectNameID, 0)) === targetNameID
    )
  ) {
    return true;
  }
  const targetTypeID = Math.max(0, toInt(target.typeID, 0));
  if (
    targetTypeID > 0 &&
    Math.max(0, toInt(candidate.typeID, 0)) === targetTypeID
  ) {
    const candidateNameID = Math.max(
      0,
      toInt(candidate.nameID || candidate.dunObjectNameID, 0),
    );
    if (targetNameID > 0 && candidateNameID > 0 && candidateNameID !== targetNameID) {
      return false;
    }
    const targetLabel = normalizeLowerText(target.label, "");
    if (!targetLabel) {
      return true;
    }
    const candidateLabel = normalizeLowerText(candidate.label || candidate.name || candidate.itemName || candidate.slimName, "");
    if (candidateLabel && candidateLabel === targetLabel) {
      return true;
    }
  }
  return false;
}

function isObjectiveTargetSpawnEntry(entry, plan, targets) {
  if (!entry || typeof entry !== "object") {
    return false;
  }
  if (
    entry.objective === true ||
    entry.objectiveTarget === true ||
    entry.blocksObjectiveProgress === true
  ) {
    return true;
  }
  const completionRole = normalizeLowerText(
    (entry && entry.completionRole) ||
      (plan && plan.completionRole),
    "",
  );
  if (completionRole === "objective") {
    return true;
  }
  return normalizeArray(targets).some((target) => matchesObjectiveTarget(entry, target));
}

function isKillableStructureEntry(entry) {
  const entityKind = normalizeLowerText(
    entry && (entry.entityKind || entry.kind || entry.spawnKind || entry.role),
    "",
  ).replace(/[^a-z0-9]+/g, "");
  return Boolean(
    entry &&
      (
        entry.killableStructure === true ||
        entityKind === "killablestructure" ||
        entityKind === "combatstructure" ||
        entityKind === "dungeonstructure"
      )
  );
}

function blocksProgress(entry, plan) {
  if (Object.prototype.hasOwnProperty.call(entry || {}, "blocksEncounterProgress")) {
    return entry.blocksEncounterProgress !== false;
  }
  if (Object.prototype.hasOwnProperty.call(entry || {}, "blocksWaveProgress")) {
    return entry.blocksWaveProgress !== false;
  }
  const explicitSpawnEntries = normalizeArray(plan && plan.spawnEntries)
    .filter((spawnEntry) => spawnEntry && typeof spawnEntry === "object");
  const identitySpawnEntries = explicitSpawnEntries.filter((spawnEntry) => !isKillableStructureEntry(spawnEntry));
  const hasNpcEntries = identitySpawnEntries.length > 0 || explicitSpawnEntries.length <= 0;
  return hasNpcEntries !== true;
}

module.exports = {
  blocksProgress,
  isKillableStructureEntry,
  isObjectiveTargetSpawnEntry,
  matchesObjectiveTarget,
  normalizeArray,
  normalizeLowerText,
  normalizeObjectiveTargets,
  normalizeText,
  toInt,
};
