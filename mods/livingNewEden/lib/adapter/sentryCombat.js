"use strict";

const { SENTRY_TYPES, DEFAULT_AMMO, sentryTypeOf } = require("./data/sentryTypes");
const { aggroesPlayers } = require("./data/npcAggro");

const MAX_DETAIL = 120;
const UNAVAILABLE = "SENTRY_COMBAT_UNAVAILABLE";
const SCENE_NOT_LOADED = "SENTRY_SCENE_NOT_LOADED";
const ACTIVATION_REPEAT = 9999999;
const ATTR = Object.freeze({ shield: 263, armor: 265, hull: 9, range: 76 });
const COMBAT_ATTR = Object.freeze({ multiplier: 64, rateMs: 51, missileMultiplier: 212, missileRateMs: 506,
  signature: 552, designSig: 620 });
const MS_PER_S = 1000;

const COMBAT_REQUIRED = Object.freeze({
  itemStore: Object.freeze(["findItemById"]),
  gm: Object.freeze(["applyPosDamage"]),
  defense: Object.freeze(["getBatteryProfile", "hasUnavailableHealth", "hydrateBatteryActor", "getBatterySession",
    "getBatteryModuleView", "stopBattery", "isBatteryManuallyControlled", "validateBatteryOperation"]),
  runtime: Object.freeze(["isSolarSystemSceneLoaded"]),
});
const SCENE_READ = Object.freeze(["getEntityByID"]);
const SCENE_ENGAGE = Object.freeze(["getEntityByID", "validateTargetLockRequest", "addTarget",
  "activateGenericModule"]);

const isObj = (v) => v !== null && typeof v === "object";
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const detailOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);
const refuse = (reason, detail) => (detail === undefined ? { ok: false, reason } : { ok: false, reason,
  detail: String(detail).slice(0, MAX_DETAIL) });
const refuseTarget = (reason, detail) => ({ ...refuse(reason, detail), scope: "target" });
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const CAPSULE_GROUP_ID = 29;

function pointOf(p) {
  if (!isObj(p)) return null;
  const x = Number(p.x);
  const y = Number(p.y);
  const z = Number(p.z);
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? { x, y, z } : null;
}

function isDead(entity) {
  return entity.destroyed === true || entity.destroying === true
    || ["destroyed", "destroying"].includes(String(entity.destructionState));
}

function checkCombatFrom(vendor) {
  try {
    if (!isObj(vendor)) return refuse(UNAVAILABLE, "vendor");
    for (const key of Object.keys(COMBAT_REQUIRED)) {
      const mod = vendor[key];
      if (!isObj(mod) && typeof mod !== "function") return refuse(UNAVAILABLE, key);
      for (const name of COMBAT_REQUIRED[key]) {
        if (typeof mod[name] !== "function") return refuse(UNAVAILABLE, `${key}.${name}`);
      }
    }
    if (!(vendor.runtime.scenes instanceof Map)) return refuse(UNAVAILABLE, "runtime.scenes");
    return { ok: true };
  } catch (err) {
    return refuse(UNAVAILABLE, detailOf(err));
  }
}

function loadedScene(vendor, systemId, methods) {
  if (vendor.runtime.isSolarSystemSceneLoaded(systemId) !== true) return refuse(SCENE_NOT_LOADED);
  const scene = vendor.runtime.scenes.get(systemId);
  if (!isObj(scene)) return refuse(SCENE_NOT_LOADED);
  for (const name of methods) {
    if (typeof scene[name] !== "function") return refuse(UNAVAILABLE, `scene.${name}`);
  }
  return { ok: true, scene };
}

function damagePlan(maxLayers, condition, hp) {
  const c = isObj(condition) ? condition : {};
  const max = isObj(maxLayers) ? maxLayers : {};
  const shieldLeft = Math.max(0, num(max.shield)) * clamp01(num(c.shieldCharge, 1));
  const armorLeft = Math.max(0, num(max.armor)) * (1 - clamp01(num(c.armorDamage, 0)));
  const hullLeft = Math.max(0, num(max.hull)) * (1 - clamp01(num(c.damage, 0)));
  if (hp <= shieldLeft) return { layer: "shield", amount: hp };
  if (hp - shieldLeft <= armorLeft) return { layer: "armor", amount: hp - shieldLeft };
  const rest = hp - shieldLeft - armorLeft;
  if (rest < hullLeft) return { layer: "hull", amount: rest };
  return { layer: "kill", amount: null };
}

function lockedIdsOf(entity, lockScope) {
  if (Math.trunc(num(entity.groupID)) === CAPSULE_GROUP_ID || !(entity.lockedTargets instanceof Map)) return [];
  const out = [];
  for (const key of entity.lockedTargets.keys()) {
    const id = Math.trunc(num(key));
    if (isId(id) && lockScope.has(id)) out.push(id);
  }
  return out.sort((a, b) => a - b);
}

function playersOf(scene, lockScope) {
  const out = [];
  if (!(scene.sessions instanceof Map) || typeof scene.getShipEntityForSession !== "function") return out;
  const scope = lockScope instanceof Set ? lockScope : null;
  const entities = [];
  for (const session of scene.sessions.values()) {
    if (!isObj(session)) continue;
    const characterId = Math.trunc(num(session.characterID || session.charid));
    if (!isId(characterId)) continue;
    const entity = scene.getShipEntityForSession(session);
    const entityId = Math.trunc(num(entity && entity.itemID));
    const position = pointOf(entity && entity.position);
    if (!isId(entityId) || position === null) continue;
    const corp = Math.trunc(num(session.corporationID || session.corpid));
    out.push({ characterId, entityId, corporationId: isId(corp) ? corp : null, position });
    entities.push(entity);
  }
  if (scope !== null) {
    const full = new Set(scope);
    for (const p of out) full.add(p.entityId);
    out.forEach((p, i) => {
      p.lockedIds = lockedIdsOf(entities[i], full);
    });
  }
  return out;
}

function limitedEngagementFrom(cw, firstCharacterId, secondCharacterId) {
  if (!isId(firstCharacterId) || !isId(secondCharacterId) || firstCharacterId === secondCharacterId) {
    return refuse("INVALID_INPUT");
  }
  try {
    if ((!isObj(cw) && typeof cw !== "function") || typeof cw.hasActiveLimitedEngagement !== "function") {
      return refuse(UNAVAILABLE, "crimewatchState.hasActiveLimitedEngagement");
    }
    return { ok: true, active: cw.hasActiveLimitedEngagement(firstCharacterId, secondCharacterId) === true };
  } catch (err) {
    return refuse("SEAM_ERROR", detailOf(err));
  }
}

function npcsOf(vendor, scene, max) {
  const out = [];
  const entities = scene.dynamicEntities instanceof Map ? scene.dynamicEntities : null;
  if (entities === null) return { npcs: out, truncated: false };
  const registry = isObj(vendor.registry) && typeof vendor.registry.getControllerByEntityID === "function"
    ? vendor.registry : null;
  let read = 0;
  let truncated = false;
  for (const entity of entities.values()) {
    if (read >= max) {
      truncated = true;
      break;
    }
    read += 1;
    try {
      if (!isObj(entity) || entity.kind !== "ship" || entity.nativeNpc !== true || entity.session
        || entity.empireSentry === true || isDead(entity)) continue;
      const entityType = String(entity.npcEntityType || "").trim().toLowerCase();
      if (entityType === "concord") continue;
      const entityId = Math.trunc(num(entity.itemID));
      const position = pointOf(entity.position);
      if (!isId(entityId) || position === null) continue;
      let targetId = 0;
      let aggroPlayers = false;
      if (registry !== null) {
        const c = registry.getControllerByEntityID(entityId);
        if (isObj(c)) {
          const current = Math.trunc(num(c.currentTargetID));
          const order = isObj(c.manualOrder) ? c.manualOrder : null;
          const ordered = order !== null && order.type === "attack" ? Math.trunc(num(order.targetID)) : 0;
          targetId = isId(current) ? current : (isId(ordered) ? ordered : 0);
          aggroPlayers = entityType === "npc" && aggroesPlayers(c);
        }
      }
      out.push({ entityId, position, targetId, aggroPlayers });
    } catch (_err) {
    }
  }
  out.sort((a, b) => a.entityId - b.entityId);
  return { npcs: out, truncated };
}

function sentryViewOf(vendor, scene, itemId) {
  const item = vendor.itemStore.findItemById(itemId);
  if (!isObj(item)) {
    return { itemId, typeId: null, position: null, maxRangeM: 0, targetId: null, active: false, alive: false,
      inScene: Boolean(scene.getEntityByID(itemId)), gone: true };
  }
  const entity = scene.getEntityByID(itemId);
  const inScene = isObj(entity);
  const profile = vendor.defense.getBatteryProfile(item);
  const attrs = isObj(profile) && isObj(profile.attributes) ? profile.attributes : {};
  const effect = inScene && entity.activeModuleEffects instanceof Map ? entity.activeModuleEffects.get(itemId) : null;
  const effectTarget = isObj(effect) ? Math.trunc(num(effect.targetID)) : 0;
  const pending = inScene ? Math.trunc(num(entity.starbaseAutomaticTargetID)) : 0;
  const targetId = isId(effectTarget) ? effectTarget : (isId(pending) ? pending : null);
  const position = inScene ? pointOf(entity.position) : null;
  const condition = isObj(item.conditionState) ? item.conditionState : {};
  return { itemId, typeId: Math.trunc(num(item.typeID)) || null, position,
    maxRangeM: Math.max(0, num(attrs[ATTR.range])), targetId, active: isObj(effect),
    alive: inScene && position !== null && !isDead(entity) && vendor.defense.hasUnavailableHealth(item) !== true,
    incapacitated: condition.incapacitated === true || num(condition.armorDamage, 0) >= 1,
    inScene, gone: false };
}

function readSentrySceneFrom(vendor, systemId, sentryItemIds, lneEntityIds, opts) {
  if (!isId(systemId) || !Array.isArray(sentryItemIds) || !sentryItemIds.every(isId)
    || !Array.isArray(lneEntityIds) || !lneEntityIds.every(isId)) return refuse("INVALID_INPUT");
  const check = checkCombatFrom(vendor);
  if (!check.ok) return check;
  const scanMax = isObj(opts) && isId(opts.defendScanMax) ? opts.defendScanMax : 0;
  try {
    const empty = { ok: true, loaded: false, sentries: [], players: [], positions: new Map(), npcs: [],
      npcScanTruncated: false };
    const got = loadedScene(vendor, systemId, SCENE_READ);
    if (!got.ok) return got.reason === SCENE_NOT_LOADED ? empty : got;
    const scene = got.scene;
    const sentries = sentryItemIds.map((id) => sentryViewOf(vendor, scene, id));
    const positions = new Map();
    for (const id of lneEntityIds) {
      const e = scene.getEntityByID(id);
      const p = isObj(e) && !isDead(e) ? pointOf(e.position) : null;
      if (p !== null) positions.set(id, p);
    }
    const scan = scanMax > 0 ? npcsOf(vendor, scene, scanMax) : { npcs: [], truncated: false };
    const lockScope = isObj(opts) && opts.defendPlayers === true ? new Set(sentryItemIds) : null;
    return { ok: true, loaded: true, sentries, players: playersOf(scene, lockScope), positions, npcs: scan.npcs,
      npcScanTruncated: scan.truncated };
  } catch (err) {
    return refuse("SEAM_ERROR", detailOf(err));
  }
}

function setVendorField(target, name, value) {
  try {
    if (isObj(target) && Object.isExtensible(target)) target[name] = value;
  } catch (_err) {
  }
}

function engageFrom(vendor, systemId, sentryItemId, targetEntityId) {
  if (!isId(systemId) || !isId(sentryItemId) || !isId(targetEntityId)) return refuse("INVALID_INPUT");
  const check = checkCombatFrom(vendor);
  if (!check.ok) return check;
  let targetStage = false;
  try {
    const got = loadedScene(vendor, systemId, SCENE_ENGAGE);
    if (!got.ok) return got;
    const scene = got.scene;
    const D = vendor.defense;
    const item = vendor.itemStore.findItemById(sentryItemId);
    if (!isObj(item)) return refuse("NOT_FOUND");
    const entity = scene.getEntityByID(sentryItemId);
    if (!isObj(entity) || isDead(entity)) return refuse("STARBASE_BATTERY_NOT_IN_SCENE");
    const op = D.validateBatteryOperation(sentryItemId);
    if (!isObj(op) || op.success !== true) return refuse(String((op && op.errorMsg) || "MODULE_NOT_ONLINE"));
    if (D.isBatteryManuallyControlled(entity) === true) return refuse("STARBASE_BATTERY_CONTROLLED");
    const profile = D.getBatteryProfile(item);
    if (!isObj(profile) || profile.passive || !profile.effectName) return refuse("STARBASE_BATTERY_NOT_FOUND");
    targetStage = true;
    const target = scene.getEntityByID(targetEntityId);
    if (!isObj(target) || isDead(target)) return refuseTarget("TARGET_NOT_IN_SCENE");
    D.hydrateBatteryActor(entity, item);
    const session = D.getBatterySession(scene, entity);
    const valid = scene.validateTargetLockRequest(session, entity, target, { ignoreCapacity: true });
    if (!isObj(valid) || valid.success !== true) {
      return refuseTarget(String((valid && valid.errorMsg) || "TARGET_INVALID"));
    }
    const effects = entity.activeModuleEffects instanceof Map ? entity.activeModuleEffects : null;
    const existing = effects ? effects.get(sentryItemId) : null;
    if (isObj(existing)) {
      if (Math.trunc(num(existing.targetID)) === targetEntityId) return { ok: true, pending: false, alreadyActive: true };
      D.stopBattery(scene, sentryItemId, { reason: "targetChanged" });
    }
    const lock = scene.addTarget(session, targetEntityId);
    if (!isObj(lock) || lock.success !== true) {
      return refuseTarget(String((lock && lock.errorMsg) || "TARGET_LOCK_FAILED"));
    }
    setVendorField(entity, "starbaseAutomaticTargetID", targetEntityId);
    if (isObj(lock.data) && lock.data.pending === true) return { ok: true, pending: true, alreadyActive: false };
    const activation = scene.activateGenericModule(session, D.getBatteryModuleView(sentryItemId), profile.effectName,
      { targetID: targetEntityId, repeat: ACTIVATION_REPEAT });
    if (!isObj(activation) || activation.success !== true) {
      return refuseTarget(String((activation && activation.errorMsg) || "ACTIVATION_FAILED"));
    }
    if (isObj(activation.data)) setVendorField(activation.data.effectState, "starbaseAutomatic", true);
    return { ok: true, pending: false, alreadyActive: false };
  } catch (err) {
    return targetStage ? refuseTarget("SEAM_ERROR", detailOf(err)) : refuse("SEAM_ERROR", detailOf(err));
  }
}

function releaseFrom(vendor, systemId, sentryItemId, reason) {
  if (!isId(systemId) || !isId(sentryItemId)) return refuse("INVALID_INPUT");
  const check = checkCombatFrom(vendor);
  if (!check.ok) return check;
  try {
    const got = loadedScene(vendor, systemId, SCENE_READ);
    if (!got.ok) return got.reason === SCENE_NOT_LOADED ? { ok: true, stopped: false } : got;
    const r = vendor.defense.stopBattery(got.scene, sentryItemId, { reason: String(reason || "sentryRelease") });
    if (!isObj(r) || r.success !== true) return refuse(String((r && r.errorMsg) || "STOP_FAILED"));
    return { ok: true, stopped: isObj(r.data) && r.data.stopped === true };
  } catch (err) {
    return refuse("SEAM_ERROR", detailOf(err));
  }
}

function offSceneDamage(vendor, item, max, plan, atMs) {
  if (typeof vendor.itemStore.updateInventoryItem !== "function") return refuse(SCENE_NOT_LOADED);
  const itemId = Math.trunc(num(item.itemID));
  let updater;
  if (plan.layer === "kill") {
    updater = (cur) => {
      const state = isObj(cur.spaceState) ? cur.spaceState : {};
      const module = isObj(state.starbaseModuleState) ? state.starbaseModuleState : {};
      return { ...cur,
        conditionState: { ...(isObj(cur.conditionState) ? cur.conditionState : {}), damage: 1, armorDamage: 1,
          shieldCharge: 0, incapacitated: true },
        spaceState: { ...state, onlineState: "offline", online: 0, onlineStartedAtMs: null, onlineCompletesAtMs: null,
          anchorStartedAtMs: null, anchorCompletesAtMs: null, incapacitated: 1,
          starbaseModuleState: { ...module, destruction: { version: 1, startedAtMs: atMs, dependentIDs: [],
            fieldIDs: [] } } } };
    };
  } else {
    updater = (cur) => {
      const c = isObj(cur.conditionState) ? cur.conditionState : {};
      const now = { shield: max.shield * clamp01(num(c.shieldCharge, 1)),
        armor: max.armor * (1 - clamp01(num(c.armorDamage, 0))), hull: max.hull * (1 - clamp01(num(c.damage, 0))) };
      const after = { ...now };
      const cut = (v) => Math.max(0, v - Math.min(v, plan.amount));
      if (plan.layer === "shield") after.shield = cut(now.shield);
      else if (plan.layer === "armor") Object.assign(after, { shield: 0, armor: cut(now.armor) });
      else Object.assign(after, { shield: 0, armor: 0, hull: cut(now.hull) });
      return { ...cur, conditionState: { ...c,
        shieldCharge: max.shield > 0 ? after.shield / max.shield : 0,
        armorDamage: max.armor > 0 ? 1 - after.armor / max.armor : 1,
        damage: max.hull > 0 ? 1 - after.hull / max.hull : 1 } };
    };
  }
  const r = vendor.itemStore.updateInventoryItem(itemId, updater);
  if (!isObj(r) || r.success !== true) return refuse(String((r && r.errorMsg) || "ITEM_UPDATE_FAILED"));
  return { ok: true, destroyed: plan.layer === "kill", layer: plan.layer, offScene: true };
}

function layerAttributesOf(vendor, itemOrType) {
  const profile = typeof vendor.defense.getBatteryProfile === "function"
    ? vendor.defense.getBatteryProfile(itemOrType) : null;
  if (isObj(profile) && isObj(profile.attributes)) return profile.attributes;
  const type = sentryTypeOf(isObj(itemOrType) ? itemOrType.typeID : itemOrType);
  return type !== null && type.passive === true && isObj(type.attributes) ? type.attributes : null;
}

function hpLeftOf(vendor, item) {
  const attrs = layerAttributesOf(vendor, item);
  if (attrs === null) return null;
  const max = { shield: Math.max(0, num(attrs[ATTR.shield])), armor: Math.max(0, num(attrs[ATTR.armor])),
    hull: Math.max(0, num(attrs[ATTR.hull])) };
  const c = isObj(item.conditionState) ? item.conditionState : {};
  const left = max.shield * clamp01(num(c.shieldCharge, 1)) + max.armor * (1 - clamp01(num(c.armorDamage, 0)))
    + max.hull * (1 - clamp01(num(c.damage, 0)));
  return { left: Math.max(0, Math.ceil(left)), max: Math.floor(max.shield + max.armor + max.hull) };
}

function applySentryDamageFrom(vendor, itemId, hp, opts) {
  if (!isId(itemId) || !Number.isSafeInteger(hp) || hp <= 0) return refuse("INVALID_INPUT");
  const check = checkCombatFrom(vendor);
  if (!check.ok) return check;
  try {
    const item = vendor.itemStore.findItemById(itemId);
    if (!isObj(item)) return refuse("NOT_FOUND");
    const state = isObj(item.spaceState) ? item.spaceState : {};
    const systemId = Math.trunc(num(state.systemID, num(item.locationID)));
    if (!isId(systemId)) return refuse(SCENE_NOT_LOADED);
    const loaded = vendor.runtime.isSolarSystemSceneLoaded(systemId) === true;
    const offScene = !loaded && isObj(opts) && opts.offScene === true;
    if (!loaded && !offScene) return refuse(SCENE_NOT_LOADED);
    const attrs = layerAttributesOf(vendor, item);
    if (attrs === null) return refuse("STARBASE_BATTERY_NOT_FOUND");
    const max = { shield: num(attrs[ATTR.shield]), armor: num(attrs[ATTR.armor]), hull: num(attrs[ATTR.hull]) };
    const plan = damagePlan(max, item.conditionState, hp);
    if (offScene) {
      return offSceneDamage(vendor, item, max, plan, Number.isSafeInteger(opts.atMs) && opts.atMs >= 0 ? opts.atMs : 0);
    }
    const r = plan.layer === "kill" ? vendor.gm.applyPosDamage(itemId, "kill")
      : vendor.gm.applyPosDamage(itemId, plan.layer, plan.amount);
    if (!isObj(r) || r.success !== true) return refuse(String((r && r.errorMsg) || "POS_DAMAGE_FAILED"));
    const destroyed = plan.layer === "kill" || (isObj(r.data) && r.data.destroyed === true);
    return { ok: true, destroyed, layer: plan.layer };
  } catch (err) {
    return refuse("SEAM_ERROR", detailOf(err));
  }
}

function sentryCombatOf(attributes, family, damage) {
  if (!isObj(attributes) || !(num(damage) > 0)) return null;
  const missile = family === "missile";
  const multiplier = num(attributes[missile ? COMBAT_ATTR.missileMultiplier : COMBAT_ATTR.multiplier]);
  const rateMs = num(attributes[missile ? COMBAT_ATTR.missileRateMs : COMBAT_ATTR.rateMs]);
  const signature = num(attributes[COMBAT_ATTR.signature]);
  if (!(multiplier > 0) || !(rateMs > 0) || !(signature > 0)) return null;
  const design = num(attributes[COMBAT_ATTR.designSig]);
  return { dps: (multiplier * num(damage)) / (rateMs / MS_PER_S), signature, designSig: design > 0 ? design : null };
}

function readSentryCombatFrom(vendor, typeId) {
  if (!isId(typeId)) return refuse("INVALID_INPUT", "typeId");
  const type = SENTRY_TYPES.find((t) => t.typeId === typeId);
  if (!type) return refuse("NO_PROFILE");
  try {
    const defense = isObj(vendor) ? vendor.defense : null;
    if (!isObj(defense) || typeof defense.getBatteryProfile !== "function") {
      return refuse(UNAVAILABLE, "defense.getBatteryProfile");
    }
    if (type.passive === true) {
      const attrs = layerAttributesOf(vendor, typeId);
      const signature = attrs !== null && num(attrs[COMBAT_ATTR.signature]) > 0 ? num(attrs[COMBAT_ATTR.signature]) : 1;
      return { ok: true, dps: 0, signature, designSig: null, passive: true };
    }
    const profile = defense.getBatteryProfile(typeId);
    const damage = isObj(type.ammo) ? type.ammo.damage : DEFAULT_AMMO[type.family].damage;
    const combat = isObj(profile) ? sentryCombatOf(profile.attributes, type.family, damage) : null;
    return combat === null ? refuse("NO_PROFILE") : { ok: true, ...combat };
  } catch (err) {
    return refuse("SEAM_ERROR", detailOf(err));
  }
}

module.exports = {
  COMBAT_REQUIRED,
  SCENE_NOT_LOADED,
  sentryCombatOf,
  readSentryCombatFrom,
  damagePlan,
  hpLeftOf,
  sentryViewOf,
  checkCombatFrom,
  readSentrySceneFrom,
  limitedEngagementFrom,
  engageFrom,
  releaseFrom,
  applySentryDamageFrom,
};
