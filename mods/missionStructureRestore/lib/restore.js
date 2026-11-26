"use strict";

const {
  blocksProgress,
  normalizeArray,
  normalizeText,
  toInt,
} = require("./objectiveMatch");
const { isMissionInstance, isObjectiveSatisfied, planRestores, SKIP_REASONS } = require("./restorePlan");

function normalizeObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizeIDList(value) {
  return [...new Set(
    normalizeArray(value)
      .map((entry) => Math.max(0, toInt(entry, 0)))
      .filter((entry) => entry > 0),
  )].sort((left, right) => left - right);
}

function entityIDOf(entry) {
  return Math.max(0, toInt(entry && entry.entity && entry.entity.itemID, 0));
}

function countSkips(skipped) {
  const counts = {};
  for (const row of normalizeArray(skipped)) counts[row.reason] = (counts[row.reason] || 0) + 1;
  return counts;
}

function makeIsPresent(scene, instance, instanceID) {
  const states = normalizeObject(normalizeObject(instance.spawnState).encounterStatesByKey);
  const entities = scene && scene.staticEntitiesByID instanceof Map ? scene.staticEntitiesByID : new Map();
  return (planKey, entryKey) => {
    const state = normalizeObject(states[planKey]);
    const ids = normalizeIDList([...normalizeArray(state.spawnedEntityIDs), ...normalizeArray(state.remainingEntityIDs)]);
    return ids.some((id) => {
      const entity = entities.get(id);
      return Boolean(entity) &&
        normalizeText(entity.dungeonSiteContentKey, "") === entryKey &&
        Math.max(0, toInt(entity.dungeonSiteInstanceID, 0)) === instanceID;
    });
  };
}

function buildStatePatch(state, spawned, identities) {
  const newIDs = spawned.map(entityIDOf);
  const blockingIDs = spawned.filter((entry) => entry.encounterProgressBlocker !== false).map(entityIDOf);
  const nonBlockingIDs = spawned.filter((entry) => entry.encounterProgressBlocker === false).map(entityIDOf);
  const spawnedEntityIDs = normalizeIDList([...normalizeArray(state.spawnedEntityIDs), ...newIDs]);
  const completed = Math.max(0, toInt(state.completedAtMs, 0)) > 0;
  return {
    spawnedEntityIDs,
    spawnCount: spawnedEntityIDs.length,
    objectiveBlockingEntityIDs: normalizeIDList([...normalizeArray(state.objectiveBlockingEntityIDs), ...newIDs]),
    nonBlockingEntityIDs: normalizeIDList([...normalizeArray(state.nonBlockingEntityIDs), ...nonBlockingIDs]),
    ...(completed
      ? {}
      : { remainingEntityIDs: normalizeIDList([...normalizeArray(state.remainingEntityIDs), ...blockingIDs]) }),
    spawnedIdentitiesByEntityID: { ...normalizeObject(state.spawnedIdentitiesByEntityID), ...normalizeObject(identities) },
  };
}

function rollback(scene, spawned, log) {
  for (const entry of spawned) {
    try {
      scene.removeStaticEntity(entityIDOf(entry), { broadcast: true });
    } catch (error) {
      log(`rollback of entity=${entityIDOf(entry)} failed: ${error && error.message}`);
    }
  }
}

function restoreAfterMaterialize(deps, scene, result, options) {
  const opts = normalizeObject(options);
  if (!result || result.success !== true || opts.spawnEncounters === false) {
    return { ok: false, reason: "NOT_APPLICABLE" };
  }
  const { service, dungeonRuntime, dungeonAuthority } = deps;
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const logError = typeof deps.logError === "function" ? deps.logError : log;
  const data = normalizeObject(result.data);
  const instanceID = Math.max(0, toInt(data.instanceID, 0));
  const instance = instanceID > 0 ? dungeonRuntime.getInstance(instanceID) : null;
  if (!instance) return { ok: false, reason: "INSTANCE_GONE" };
  if (!isMissionInstance(instance)) return { ok: false, reason: "NOT_MISSION" };
  if (isObjectiveSatisfied(instance)) return { ok: false, reason: "OBJECTIVE_SATISFIED" };
  const template = dungeonAuthority.getTemplateByID(instance.templateID);
  if (!template) return { ok: false, reason: "TEMPLATE_MISSING" };
  const siteID = Math.max(0, toInt(data.siteID, 0));
  const siteEntity = (scene && scene.staticEntitiesByID instanceof Map && scene.staticEntitiesByID.get(siteID)) ||
    service.buildSiteEntity(instance);
  if (!siteEntity) return { ok: false, reason: "SITE_MISSING" };

  const hints = service._testing.resolvePopulationHints(instance, template);
  const plans = service._testing.resolveEncounterPlans(hints);
  const completion = (hints && hints.completion) || {};
  const sitePosition = siteEntity.position || null;
  const plan = planRestores({
    instance,
    plans,
    completion,
    isPresent: makeIsPresent(scene, instance, instanceID),
    roomAnchor: (roomKey) => (roomKey ? service.homefrontPorts.roomAnchor(sitePosition, template, roomKey) : null),
    sitePosition,
  });
  if (!plan.ok) return plan;

  const nowMs = Math.max(0, toInt(opts.nowMs, 0)) || deps.nowMs();
  let restored = 0;
  let patchFailed = 0;
  for (const group of plan.groups) {
    const spawned = normalizeArray(service.homefrontPorts.structure(scene, instance, siteEntity, group.plan, group.entries, {
      anchorPosition: group.anchorPosition,
      broadcast: opts.broadcast === true,
      excludedSession: opts.excludedSession || null,
    }))
      .filter((entry) => entityIDOf(entry) > 0)
      .map((entry) => ({
        ...entry,
        encounterProgressBlocker: blocksProgress(entry.spawnEntry, group.plan),
        objectiveProgressBlocker: true,
      }));
    if (spawned.length === 0) continue;
    service._testing.applyNpcSentryEncounterProgressPolicy(spawned, template);
    for (const entry of spawned) {
      entry.entity.dungeonEncounterBlocksProgress = entry.encounterProgressBlocker !== false;
      entry.entity.dungeonObjectiveProgressTarget = true;
      entry.entity.dungeonObjectiveTargetKey = normalizeText(entry.spawnEntry && entry.spawnEntry.key, "") || null;
    }

    let merged = null;
    try {
      const fresh = dungeonRuntime.getInstance(instanceID);
      if (fresh) {
        const all = normalizeObject(normalizeObject(fresh.spawnState).encounterStatesByKey);
        const state = normalizeObject(all[group.planKey]);
        const patch = buildStatePatch(state, spawned, service._testing.buildSpawnedIdentityMap(spawned));
        merged = dungeonRuntime.mergeSpawnState(instanceID, {
          encounterStatesByKey: { ...all, [group.planKey]: { ...state, ...patch, key: group.planKey } },
        }, { nowMs });
      }
    } catch (error) {
      logError(`state patch failed instance=${instanceID} plan=${group.planKey}: ${error && error.message}`);
      merged = null;
    }
    if (!merged) {
      rollback(scene, spawned, logError);
      patchFailed += 1;
      continue;
    }
    for (const entry of spawned) {
      restored += 1;
      log(
        `restored instance=${instanceID} template=${instance.templateID} plan=${group.planKey} ` +
          `entry=${entry.entity.dungeonObjectiveTargetKey} entity=${entityIDOf(entry)} room=${group.plan.roomKey || "room:entry"}`,
      );
    }
  }
  const skipped = countSkips(plan.skipped);
  if (patchFailed > 0) return { ok: false, reason: "PATCH_FAILED", restored, skipped, patchFailed };
  return { ok: true, restored, skipped };
}

module.exports = {
  SKIP_REASONS,
  buildStatePatch,
  normalizeIDList,
  restoreAfterMaterialize,
};
