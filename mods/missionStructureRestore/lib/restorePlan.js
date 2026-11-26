"use strict";

const {
  isKillableStructureEntry,
  isObjectiveTargetSpawnEntry,
  matchesObjectiveTarget,
  normalizeArray,
  normalizeLowerText,
  normalizeObjectiveTargets,
  normalizeText,
  toInt,
} = require("./objectiveMatch");

const SKIP_REASONS = Object.freeze([
  "NOT_MISSION",
  "OBJECTIVE_SATISFIED",
  "NO_OBJECTIVE_TARGETS",
  "NOT_SPAWNED",
  "NO_KEY",
  "TARGET_DESTROYED",
  "PRESENT",
  "NO_ROOM_ANCHOR",
]);

const ENTRY_ROOM_KEY = "room:entry";

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function isMissionInstance(instance) {
  if (!instance) return false;
  return normalizeLowerText(instance.siteFamily, "") === "mission" ||
    normalizeLowerText(instance.siteKind, "") === "mission" ||
    normalizeObject(instance.metadata).missionRuntime === true;
}

function isObjectiveSatisfied(instance) {
  return Math.max(0, toInt(instance && instance.objectiveSatisfiedAtMs, 0)) > 0 ||
    Math.max(0, toInt(instance && instance.metadata && instance.metadata.objectiveSatisfiedAtMs, 0)) > 0;
}

function isTargetDestroyed(entry, targets, destroyedKeys) {
  if (targets.length <= 1) return false;
  return targets.some((target, index) => (
    matchesObjectiveTarget(entry, target) && destroyedKeys.includes(target.key || `target_${index}`)
  ));
}

function resolveAnchor(plan, roomAnchor, sitePosition) {
  const roomKey = normalizeText(plan && plan.roomKey, "");
  const anchor = roomAnchor(roomKey || null);
  if (anchor && typeof anchor === "object") return anchor;
  if (!roomKey || roomKey === ENTRY_ROOM_KEY) {
    return sitePosition && typeof sitePosition === "object" ? sitePosition : null;
  }
  return null;
}

function planRestores(input) {
  const { instance, plans, completion, isPresent, roomAnchor, sitePosition } = input || {};
  if (!isMissionInstance(instance)) return { ok: false, reason: "NOT_MISSION" };
  if (isObjectiveSatisfied(instance)) return { ok: false, reason: "OBJECTIVE_SATISFIED" };
  const targets = normalizeObjectiveTargets(completion);
  if (targets.length === 0) return { ok: false, reason: "NO_OBJECTIVE_TARGETS" };

  const states = normalizeObject(normalizeObject(instance.spawnState).encounterStatesByKey);
  const destroyedKeys = normalizeArray(normalizeObject(instance.metadata).objectiveTargetsDestroyed);
  const groups = [];
  const skipped = [];
  for (const plan of normalizeArray(plans)) {
    if (!plan || plan.supported !== true) continue;
    const planKey = normalizeText(plan.key, "") || null;
    const entries = normalizeArray(plan.spawnEntries)
      .filter((entry) => entry && typeof entry === "object")
      .filter((entry) => isKillableStructureEntry(entry) && isObjectiveTargetSpawnEntry(entry, plan, targets));
    if (entries.length === 0) continue;
    const spawnedAtMs = Math.max(0, toInt(normalizeObject(planKey ? states[planKey] : null).spawnedAtMs, 0));
    const missing = [];
    for (const entry of entries) {
      const entryKey = normalizeText(entry.key, "") || null;
      if (spawnedAtMs <= 0) {
        skipped.push({ reason: "NOT_SPAWNED", planKey, entryKey });
      } else if (!entryKey) {
        skipped.push({ reason: "NO_KEY", planKey, entryKey });
      } else if (isTargetDestroyed(entry, targets, destroyedKeys)) {
        skipped.push({ reason: "TARGET_DESTROYED", planKey, entryKey });
      } else if (isPresent(planKey, entryKey)) {
        skipped.push({ reason: "PRESENT", planKey, entryKey });
      } else {
        missing.push(entry);
      }
    }
    if (missing.length === 0) continue;
    const anchorPosition = resolveAnchor(plan, roomAnchor, sitePosition);
    if (!anchorPosition) {
      for (const entry of missing) skipped.push({ reason: "NO_ROOM_ANCHOR", planKey, entryKey: entry.key });
      continue;
    }
    groups.push({ planKey, plan, anchorPosition, entries: missing });
  }
  return { ok: true, groups, skipped };
}

module.exports = {
  ENTRY_ROOM_KEY,
  SKIP_REASONS,
  isMissionInstance,
  isObjectiveSatisfied,
  planRestores,
};
