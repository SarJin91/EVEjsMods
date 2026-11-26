// Port of EveJS 261108.1 space/npc/npcBehaviorLoop.js resolveEffectiveBehaviorProfile (:1799-1804), resolveAutoAggroTargetClasses (:1631-1668), resolveProximityAggroTargetClasses (:1670-1684), the autoAggro === false branch of the target pick (:3184-3200), the read keys of normalizeBehaviorOverrides (:1694-1797) and

"use strict";

const PLAYER = "player";
const NPC = "npc";
const CONCORD = "concord";
const DRONE = "drone";
const ALLOWED_CLASSES = new Set([PLAYER, NPC, CONCORD, DRONE]);
const DEFAULT_TARGET_PREFERENCE = "preferredTargetThenNearestPlayer";

const TARGET_PREFERENCE_CLASSES = Object.freeze({
  none: Object.freeze([]),
  preferredtargetonly: Object.freeze([]),
  nearestnpc: Object.freeze([NPC]),
  preferredtargetthennearestnpc: Object.freeze([NPC]),
  preferredtargetthennearestrat: Object.freeze([NPC]),
  preferredtargetthennearestnonconcord: Object.freeze([PLAYER, NPC]),
  nearesteligible: Object.freeze([PLAYER, NPC, CONCORD]),
  preferredtargetthennearesteligible: Object.freeze([PLAYER, NPC, CONCORD]),
  nearestplayer: Object.freeze([PLAYER]),
  preferredtargetthennearestplayer: Object.freeze([PLAYER]),
});

const isObj = (v) => v !== null && typeof v === "object";
const has = (o, k) => isObj(o) && Object.prototype.hasOwnProperty.call(o, k);

function normalizeTargetClassList(value) {
  const source = Array.isArray(value) ? value : (typeof value === "string" ? value.split(/[,\s|]+/g) : []);
  return [...new Set(source.map((e) => String(e || "").trim().toLowerCase()).filter((e) => ALLOWED_CLASSES.has(e)))];
}

function readOverrides(overrides) {
  const out = {};
  if (!isObj(overrides)) return out;
  if (overrides.autoAggro !== undefined) out.autoAggro = overrides.autoAggro === true;
  if (overrides.proximityAggroRangeMeters !== undefined) {
    const n = Number(overrides.proximityAggroRangeMeters);
    out.proximityAggroRangeMeters = Math.max(0, Number.isFinite(n) ? n : 0);
  }
  if (overrides.targetPreference !== undefined) {
    out.targetPreference = String(overrides.targetPreference || "").trim() || DEFAULT_TARGET_PREFERENCE;
  }
  if (overrides.autoAggroTargetClasses !== undefined) {
    out.autoAggroTargetClasses = normalizeTargetClassList(overrides.autoAggroTargetClasses);
  }
  if (overrides.proximityAggroTargetClasses !== undefined) {
    out.proximityAggroTargetClasses = normalizeTargetClassList(overrides.proximityAggroTargetClasses);
  }
  return out;
}

function autoAggroClasses(profile) {
  const explicit = normalizeTargetClassList(profile.autoAggroTargetClasses);
  if (explicit.length > 0 || has(profile, "autoAggroTargetClasses")) return explicit;
  const pref = String(profile.targetPreference || DEFAULT_TARGET_PREFERENCE).trim().toLowerCase();
  return has(TARGET_PREFERENCE_CLASSES, pref) ? TARGET_PREFERENCE_CLASSES[pref] : [PLAYER];
}

function proximityClasses(profile) {
  const explicit = normalizeTargetClassList(profile.proximityAggroTargetClasses);
  if (explicit.length > 0 || has(profile, "proximityAggroTargetClasses")) return explicit;
  return autoAggroClasses(profile);
}

function aggroesPlayers(controller) {
  try {
    if (!isObj(controller)) return false;
    const profile = { ...(isObj(controller.behaviorProfile) ? controller.behaviorProfile : {}),
      ...readOverrides(controller.behaviorOverrides) };
    if (profile.autoAggro !== false) return autoAggroClasses(profile).includes(PLAYER);
    const range = Number(profile.proximityAggroRangeMeters);
    return Number.isFinite(range) && range > 0 && proximityClasses(profile).includes(PLAYER);
  } catch (_err) {
    return false;
  }
}

module.exports = { aggroesPlayers, TARGET_PREFERENCE_CLASSES, normalizeTargetClassList };
