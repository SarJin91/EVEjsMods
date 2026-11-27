"use strict";

const VENDOR_ERRORS = {
  DUNGEON_SITE_KEY_IN_USE: "DUNGEON_SITE_KEY_IN_USE",
  DUNGEON_INSTANCE_NOT_FOUND: "DUNGEON_INSTANCE_NOT_FOUND",
  DUNGEON_LIFECYCLE_STATE_REQUIRED: "DUNGEON_LIFECYCLE_STATE_REQUIRED",
};

const ACTIVE_LIFECYCLE_STATES = new Set(["seeded", "active", "paused"]);
const TERMINAL_LIFECYCLE_STATES = new Set(["completed", "failed", "despawned"]);

function toInt(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.trunc(numeric) : fallback;
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeText(value, fallback = "") {
  const normalized = String(value == null ? "" : value).trim();
  return normalized || fallback;
}

function normalizePosition(value) {
  if (!value || typeof value !== "object") return null;
  return {
    x: Number(value.x) || 0,
    y: Number(value.y) || 0,
    z: Number(value.z) || 0,
  };
}

function buildInstanceSummary(instance) {
  return {
    instanceID: instance.instanceID,
    templateID: instance.templateID,
    solarSystemID: instance.solarSystemID,
    siteKey: instance.siteKey,
    lifecycleState: instance.lifecycleState,
    lifecycleReason: instance.lifecycleReason,
    instanceScope: instance.instanceScope,
    siteFamily: instance.siteFamily,
    spawnFamilyKey: resolveInstanceSpawnFamilyKey(instance),
    siteKind: instance.siteKind,
    siteOrigin: instance.siteOrigin,
    source: instance.source,
    sourceDungeonID: instance.sourceDungeonID,
    archetypeID: instance.archetypeID,
    factionID: instance.factionID,
    difficulty: instance.difficulty,
    entryObjectTypeID: instance.entryObjectTypeID,
    dungeonNameID: instance.dungeonNameID,
    position: instance.position,
    ownership: instance.ownership,
    timers: instance.timers,
    roomCount: Object.keys(instance.roomStatesByKey || {}).length,
    gateCount: Object.keys(instance.gateStatesByKey || {}).length,
    completedObjectiveCount: 0,
    runtimeFlags: instance.runtimeFlags,
    metadata: instance.metadata,
  };
}

function resolveInstanceSpawnFamilyKey(instance) {
  return normalizeText(
    instance && instance.metadata && instance.metadata.spawnFamilyKey,
    normalizeText(
      instance && instance.spawnState && instance.spawnState.spawnFamilyKey,
      instance && instance.siteFamily,
    ),
  ).toLowerCase();
}

function isActiveLifecycleState(lifecycleState) {
  return ACTIVE_LIFECYCLE_STATES.has(String(lifecycleState || "").toLowerCase());
}

function createFakeDungeonRuntime() {
  const instances = new Map();
  const siteKeyIndex = new Map();
  let nextInstanceSequence = 1;
  let snapshots = [];

  function getNextInstanceID() {
    return nextInstanceSequence++;
  }

  function findInstanceBySiteKey(siteKey, options = {}) {
    const normalizedSiteKey = normalizeText(siteKey, "");
    if (!normalizedSiteKey) return null;
    const instanceID = siteKeyIndex.get(normalizedSiteKey);
    if (!instanceID) return null;
    const instance = instances.get(String(instanceID));
    if (!instance) return null;
    if (options.activeOnly === true && !isActiveLifecycleState(instance.lifecycleState)) {
      return null;
    }
    return options.full === true ? cloneValue(instance) : cloneValue(buildInstanceSummary(instance));
  }

  function peekNextInstanceID() {
    return nextInstanceSequence;
  }

  function createInstance(options = {}) {
    const siteKey = normalizeText(options.siteKey, "") || null;
    if (siteKey) {
      const existing = findInstanceBySiteKey(siteKey);
      if (existing && isActiveLifecycleState(existing.lifecycleState)) {
        const err = new Error(`Active dungeon instance already exists for site key ${siteKey}`);
        err.code = VENDOR_ERRORS.DUNGEON_SITE_KEY_IN_USE;
        throw err;
      }
    }

    const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
    const instanceID = getNextInstanceID();

    const instance = {
      instanceID,
      templateID: normalizeText(options.templateID, ""),
      solarSystemID: Math.max(0, toInt(options.solarSystemID, 0)),
      siteKey,
      lifecycleState: normalizeText(options.lifecycleState, "active").toLowerCase(),
      lifecycleReason: normalizeText(options.lifecycleReason, "") || null,
      instanceScope: normalizeText(options.instanceScope, "shared"),
      siteFamily: normalizeText(options.siteFamily, "unknown").toLowerCase(),
      siteKind: normalizeText(options.siteKind, "anomaly").toLowerCase(),
      siteOrigin: normalizeText(options.siteOrigin, "lne_event"),
      source: normalizeText(options.source, "manual"),
      sourceDungeonID: Math.max(0, toInt(options.sourceDungeonID, 0)),
      archetypeID: Math.max(0, toInt(options.archetypeID, 0)),
      factionID: Math.max(0, toInt(options.factionID, 0)),
      difficulty: Math.max(0, toInt(options.difficulty, 0)),
      entryObjectTypeID: options.entryObjectTypeID || null,
      dungeonNameID: Math.max(0, toInt(options.dungeonNameID, 0)),
      position: normalizePosition(options.position),
      ownership: options.ownership || {},
      timers: {
        ...(options.timers || {}),
        lastUpdatedAtMs: nowMs,
        activatedAtMs: options.activatedAtMs || nowMs,
        expiresAtMs: options.expiresAtMs || null,
      },
      roomStatesByKey: {},
      gateStatesByKey: {},
      objectiveState: {},
      runtimeFlags: options.runtimeFlags || {},
      metadata: options.metadata || {},
    };

    if (instance.metadata && instance.metadata.siteID) {
      instance.siteID = instance.metadata.siteID;
    }

    instances.set(String(instanceID), instance);

    if (siteKey) {
      const existing = siteKeyIndex.get(siteKey);
      if (!existing || !isActiveLifecycleState(instances.get(String(existing))?.lifecycleState)) {
        siteKeyIndex.set(siteKey, instanceID);
      }
    }

    return cloneValue(buildInstanceSummary(instance));
  }

  function requireInstance(instanceID) {
    const instance = instances.get(String(instanceID));
    if (!instance) {
      const err = new Error(`Instance ${instanceID} not found`);
      err.code = VENDOR_ERRORS.DUNGEON_INSTANCE_NOT_FOUND;
      throw err;
    }
    return cloneValue(instance);
  }

  function setLifecycleState(instanceID, lifecycleState, options = {}) {
    const existing = requireInstance(instanceID);
    const normalizedLifecycleState = normalizeText(lifecycleState, "").toLowerCase();
    if (!normalizedLifecycleState) {
      const err = new Error("Lifecycle state required");
      err.code = VENDOR_ERRORS.DUNGEON_LIFECYCLE_STATE_REQUIRED;
      throw err;
    }

    const nowMs = Math.max(0, toInt(options.nowMs, Date.now()));
    const target = instances.get(String(existing.instanceID));
    if (!target) return cloneValue(existing);

    target.lifecycleState = normalizedLifecycleState;
    target.lifecycleReason = normalizeText(options.lifecycleReason, "") || target.lifecycleReason || null;
    target.timers = target.timers || {};
    target.timers.lastUpdatedAtMs = nowMs;
    if (normalizedLifecycleState === "active" && !target.timers.activatedAtMs) {
      target.timers.activatedAtMs = nowMs;
    }
    if (normalizedLifecycleState === "completed") {
      target.timers.completedAtMs = Math.max(0, toInt(options.completedAtMs, nowMs));
    }
    if (normalizedLifecycleState === "failed") {
      target.timers.failedAtMs = Math.max(0, toInt(options.failedAtMs, nowMs));
    }
    if (normalizedLifecycleState === "despawned") {
      target.timers.despawnAtMs = Math.max(0, toInt(options.despawnAtMs, nowMs));
    }
    if (options.expiresAtMs != null) {
      target.timers.expiresAtMs = Math.max(0, toInt(options.expiresAtMs, 0));
    }

    return cloneValue(buildInstanceSummary(target));
  }

  function purgeInstance(instanceID) {
    const existing = requireInstance(instanceID);
    instances.delete(String(existing.instanceID));
    if (existing.siteKey && siteKeyIndex.get(existing.siteKey) === existing.instanceID) {
      siteKeyIndex.delete(existing.siteKey);
    }
    return true;
  }

  function flushTableSync() {
    return { success: true, errorMsg: null };
  }

  function snapshot() {
    snapshots.push({
      instances: cloneValue(instances),
      siteKeyIndex: cloneValue(siteKeyIndex),
      nextInstanceSequence,
    });
  }

  function restore() {
    if (snapshots.length === 0) return;
    const snap = snapshots.pop();
    instances.clear();
    for (const [k, v] of Object.entries(snap.instances)) {
      instances.set(k, v);
    }
    siteKeyIndex.clear();
    for (const [k, v] of Object.entries(snap.siteKeyIndex)) {
      siteKeyIndex.set(k, v);
    }
    nextInstanceSequence = snap.nextInstanceSequence;
  }

  function clear() {
    instances.clear();
    siteKeyIndex.clear();
    nextInstanceSequence = 1;
    snapshots = [];
  }

  function getStats() {
    return {
      instanceCount: instances.size,
      nextInstanceSequence,
      snapshotsCount: snapshots.length,
    };
  }

  return Object.freeze({
    createInstance,
    findInstanceBySiteKey,
    setLifecycleState,
    purgeInstance,
    peekNextInstanceID,
    requireInstance,
    flushTableSync,
    buildInstanceSummary,
    snapshot,
    restore,
    clear,
    getStats,
    _instances: instances,
    _siteKeyIndex: siteKeyIndex,
    _nextInstanceSequence: () => nextInstanceSequence,
    VENDOR_ERRORS,
    ACTIVE_LIFECYCLE_STATES,
    TERMINAL_LIFECYCLE_STATES,
  });
}

module.exports = { createFakeDungeonRuntime };