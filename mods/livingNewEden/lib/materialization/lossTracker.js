"use strict";

function createLossTracker(limits) {
  const maxPending = limits && Number.isSafeInteger(limits.maxPending) && limits.maxPending >= 0
    ? limits.maxPending : 0;
  const byEntity = new Map();
  const pending = new Map();
  let dropped = 0;

  function track(battleId, spawned) {
    for (const s of Array.isArray(spawned) ? spawned : []) {
      if (!s || !Number.isSafeInteger(s.entityId) || s.entityId <= 0 || typeof s.memberKey !== "string") continue;
      byEntity.set(s.entityId, { battleId, memberKey: s.memberKey });
    }
  }

  function untrack(battleId) {
    for (const [id, e] of byEntity) if (e.battleId === battleId) byEntity.delete(id);
    for (const [id, e] of pending) if (e.battleId === battleId) pending.delete(id);
  }

  function forgetEntities(entityIds) {
    for (const id of Array.isArray(entityIds) ? entityIds : []) {
      byEntity.delete(id);
      pending.delete(id);
    }
  }

  function note(targetEntity, destroyResult, killer) {
    if (!destroyResult || destroyResult.success !== true) return;
    const id = targetEntity ? targetEntity.itemID : undefined;
    if (!Number.isSafeInteger(id)) return;
    const e = byEntity.get(id);
    if (!e) return;
    if (pending.size >= maxPending) {
      dropped += 1;
      return;
    }
    byEntity.delete(id);
    const k = killer && Number.isSafeInteger(killer.killerCharacterId) && killer.killerCharacterId > 0
      ? killer.killerCharacterId : null;
    pending.set(id, { battleId: e.battleId, memberKey: e.memberKey, entityId: id, killerCharacterId: k });
  }

  function drain() {
    const out = [...pending.values()];
    pending.clear();
    return out;
  }

  function sizes() {
    return { tracked: byEntity.size, pending: pending.size, dropped };
  }

  return Object.freeze({ track, untrack, forgetEntities, note, drain, sizes });
}

module.exports = { createLossTracker };
