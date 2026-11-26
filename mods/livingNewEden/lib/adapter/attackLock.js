"use strict";

const { ATTACK_LOCK_ORDER } = require("./data/liveProfiles");

const ATTACK_LOCK_KEYS = Object.freeze({ scene: "attackLockEnabled", live: "liveBattleAttackLockEnabled" });

function attackLockOf(config, group) {
  const key = Object.prototype.hasOwnProperty.call(ATTACK_LOCK_KEYS, group) ? ATTACK_LOCK_KEYS[group] : null;
  const m = config && typeof config === "object" ? config.materialization : null;
  return key !== null && m && typeof m === "object" && m[key] === true ? ATTACK_LOCK_ORDER : null;
}

function attackLockFields(attackLock) {
  if (typeof attackLock !== "function") return {};
  try {
    const extra = attackLock();
    return extra && typeof extra === "object" ? { ...extra } : {};
  } catch (_err) {
    return {};
  }
}

module.exports = { ATTACK_LOCK_KEYS, attackLockOf, attackLockFields };
