"use strict";

const { relationOf } = require("../playerHunt/policy");

const HOSTILE = "hostile";
const PLAYER = "player";
const FACTION = "faction";

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isObj = (v) => v !== null && typeof v === "object";

function safeCall(fn, fallback = null) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function createSentryHostility(deps) {
  const d = isObj(deps) ? deps : {};
  let reads = Number.isSafeInteger(d.maxReads) && d.maxReads > 0 ? d.maxReads : 0;
  const cache = new Map();
  const deferred = () => {
    if (typeof d.onDeferred === "function") safeCall(() => d.onDeferred());
  };

  function kindOf(factionId) {
    const kind = typeof d.getFactionKind === "function" ? safeCall(() => d.getFactionKind(factionId)) : null;
    return typeof kind === "string" && kind !== "" ? kind : null;
  }

  function standingHostile(characterId, factionId) {
    const key = `${characterId}:${factionId}`;
    if (cache.has(key)) return cache.get(key);
    let hostile = false;
    if (reads <= 0) {
      deferred();
    } else {
      reads -= 1;
      const r = typeof d.readStanding === "function" ? safeCall(() => d.readStanding(characterId, factionId)) : null;
      if (isObj(r) && r.ok === true && Number.isFinite(r.standing)) {
        hostile = relationOf(r.standing, kindOf(factionId), d.thresholds, d.neutralPolicy || {}) === HOSTILE;
      } else {
        deferred();
      }
    }
    cache.set(key, hostile);
    return hostile;
  }

  function isHostile(ref, factionId) {
    if (!isObj(ref)) return false;
    if (ref.ownerKind === FACTION) {
      return isId(ref.factionId) && typeof d.isFactionEnemy === "function"
        && safeCall(() => d.isFactionEnemy(ref.factionId, factionId), false) === true;
    }
    if (ref.ownerKind !== PLAYER || !isId(ref.characterId)) return false;
    return standingHostile(ref.characterId, factionId);
  }

  return Object.freeze({ isHostile, standingHostile });
}

module.exports = { createSentryHostility };
