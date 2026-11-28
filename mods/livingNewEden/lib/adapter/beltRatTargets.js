"use strict";

const { TRAFFIC_OPERATOR_KIND, LIVE_OPERATOR_KIND } = require("./data/liveProfiles");

const RAT_KIND = "asteroidBeltRat";
const RANGE_METERS = 150000;
const FRIENDLY_KEY = "allowFriendlyNpcTargets";

function eligible(entity, anchor, range) {
  if (entity?.kind !== "ship" || !Number.isSafeInteger(entity.itemID) || entity.itemID <= 0 ||
    Number(entity.groupID) === 29 || entity.stargateJumpCloak || entity.isCloaked || entity.cloaked ||
    Number(entity.cloakMode) > 0 || entity.mode === "WARP" || entity.warpState || !entity.position) return false;
  const { x, y, z } = entity.position;
  return Math.hypot(x - anchor.x, y - anchor.y, z - anchor.z) <= range;
}

function createBeltRatTargeting(getNpc, random = Math.random, simulationOf = () => ({})) {
  const scenes = new WeakMap();

  function chooseTarget(scene, state, group, npc) {
    const candidates = [];
    for (const entity of scene.dynamicEntities.values()) {
      if (!eligible(entity, group.anchor, group.range)) continue;
      const id = entity.itemID;
      if (entity.session?.characterID > 0) {
        candidates.push({ id });
        continue;
      }
      const civilian = entity.nativeNpc === true && (entity.operatorKind === TRAFFIC_OPERATOR_KIND ||
        (entity.operatorKind === LIVE_OPERATOR_KIND && entity.lneCivilianOperation));
      if (!civilian || !npc) continue;
      const controller = npc.getControllerByEntityID(id);
      const lease = state.leases.get(id);
      if (lease && controller === lease.controller) candidates.push({ id, lease });
      else if (controller && controller.operatorKind === entity.operatorKind && !Object.isFrozen(controller)) {
        candidates.push({ id, controller });
      }
    }
    return candidates[Math.floor(random() * candidates.length)];
  }

  function acquire(state, picked, npc) {
    if (!picked.controller) {
      if (picked.lease) picked.lease.users += 1;
      return picked.lease;
    }
    const { id, controller } = picked;
    const lease = { id, controller, operatorKind: controller.operatorKind,
      allowed: controller.behaviorOverrides?.[FRIENDLY_KEY], users: 1 };
    const armed = npc.setBehaviorOverrides(id, { ...controller.behaviorOverrides, [FRIENDLY_KEY]: true });
    if (armed?.success !== true) return null;
    controller.operatorKind = RAT_KIND;
    state.leases.set(id, lease);
    return lease;
  }

  function release(state, lease, npc) {
    if (!lease || --lease.users > 0) return;
    state.leases.delete(lease.id);
    const { id, controller, operatorKind, allowed } = lease;
    if (npc.getControllerByEntityID(id) !== controller || controller.operatorKind !== RAT_KIND) return;
    const overrides = { ...controller.behaviorOverrides };
    if (allowed === undefined) delete overrides[FRIENDLY_KEY];
    else overrides[FRIENDLY_KEY] = allowed;
    npc.setBehaviorOverrides(id, overrides);
    controller.operatorKind = operatorKind;
  }

  function prune(scene) {
    const state = scenes.get(scene);
    const npc = getNpc();
    if (!state || !npc) return;
    const now = scene.getCurrentSimTimeMs();
    if (now < state.nextCheckAt) return;
    state.nextCheckAt = now + 2000;
    for (const group of state.groups) {
      for (const id of group.rats) {
        if (!scene.getEntityByID(id) || !npc.getControllerByEntityID(id)) group.rats.delete(id);
      }
      if (group.rats.size === 0) {
        release(state, group.lease, npc);
        state.groups.delete(group);
        continue;
      }
      if (eligible(scene.getEntityByID(group.targetId), group.anchor, group.range)) continue;
      release(state, group.lease, npc);
      const picked = chooseTarget(scene, state, group, npc);
      group.lease = picked ? acquire(state, picked, npc) : null;
      const targetId = picked && (!picked.controller || group.lease) ? picked.id : 0;
      if (targetId === group.targetId) continue;
      group.targetId = targetId;
      for (const id of group.rats) {
        const controller = npc.getControllerByEntityID(id);
        const overrides = { ...controller.behaviorOverrides };
        if (group.lease) overrides[FRIENDLY_KEY] = true;
        else if (group.allowed === undefined) delete overrides[FRIENDLY_KEY];
        else overrides[FRIENDLY_KEY] = group.allowed;
        npc.setBehaviorOverrides(id, overrides);
        controller.preferredTargetID = targetId;
        npc.wakeNpcController(id, 0);
      }
    }
    if (state.groups.size === 0) scenes.delete(scene);
  }

  function wrapSpawn(original) {
    return function spawnWithBeltTarget(context, selection, options) {
      const scene = context?.scene;
      const anchor = context?.anchorEntity?.position;
      const npc = getNpc();
      if (options?.operatorKind !== RAT_KIND || options.anchorKind !== "asteroidBelt" ||
        !String(options.selectionID || "").startsWith("belt_rat:") || !anchor ||
        !npc || !(scene?.dynamicEntities instanceof Map)) {
        return original.call(this, context, selection, options);
      }
      const simulation = simulationOf();
      if (simulation.beltRatRandomTarget === false) return original.call(this, context, selection, options);
      const state = scenes.get(scene) || { leases: new Map(), groups: new Set(), nextCheckAt: 0 };
      const group = { anchor, range: simulation.beltRatTargetMeters ?? RANGE_METERS,
        allowed: options.behaviorOverrides?.[FRIENDLY_KEY], rats: new Set() };
      const picked = chooseTarget(scene, state, group, npc);
      if (picked) group.lease = acquire(state, picked, npc);
      group.targetId = picked && (!picked.controller || group.lease) ? picked.id : 0;

      try {
        const result = group.targetId ? original.call(this, { ...context, preferredTargetID: group.targetId }, selection, {
          ...options, preferredTargetID: group.targetId,
          behaviorOverrides: { ...options.behaviorOverrides, autoAggro: false, proximityAggroRangeMeters: 0,
            ...(group.lease ? { [FRIENDLY_KEY]: true } : {}) },
        }) : original.call(this, context, selection, options);
        for (const entry of result?.data?.spawned || []) {
          if (Number.isSafeInteger(entry.entity?.itemID)) group.rats.add(entry.entity.itemID);
        }
        if (group.rats.size > 0) {
          state.groups.add(group);
          scenes.set(scene, state);
        }
        return result;
      } finally {
        if (group.rats.size === 0) release(state, group.lease, npc);
      }
    };
  }

  return { wrapSpawn, prune };
}

module.exports = { createBeltRatTargeting };
