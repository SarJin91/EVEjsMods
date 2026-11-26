"use strict";

const { planGroup } = require("../world/beltNavy/aggroRules");
const { combineRelations } = require("../materialization/relationPaint");

const HOSTILE = "hostile";
const NEUTRAL = "neutral";

function distanceBetween(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function planAmbientGroup(group, scene, relationFor, settings, at) {
  const g = group && typeof group === "object" ? group : {};
  const safeGroup = {
    provoked: g.provoked instanceof Set ? g.provoked : new Set(),
    seenAggressedAt: g.seenAggressedAt instanceof Map ? g.seenAggressedAt : new Map(),
    spawnedAt: Number.isFinite(g.spawnedAt) ? g.spawnedAt : 0,
  };
  const sc = scene && typeof scene === "object" ? scene : {};
  const ships = (Array.isArray(sc.ships) ? sc.ships : []).filter((s) => s && s.position);
  const players = (Array.isArray(sc.players) ? sc.players : []).filter((p) => p && p.position);
  const s = settings && typeof settings === "object" ? settings : {};
  const passive = s.passive === true;

  const cache = new Map();
  const rel = (characterId) => {
    if (!cache.has(characterId)) {
      let value = null;
      try {
        value = typeof relationFor === "function" ? relationFor(characterId) : null;
      } catch {
        value = null;
      }
      if (value === undefined) value = null;
      if (passive && value === HOSTILE) value = NEUTRAL;
      cache.set(characterId, value);
    }
    return cache.get(characterId);
  };
  const standingOf = (characterId) => {
    const r = rel(characterId);
    if (r === HOSTILE) return -1;
    return r === null ? NaN : 1;
  };

  const plan = planGroup(safeGroup, { ships, players }, standingOf,
    { hostileBelowStanding: 0, aggroRangeMeters: s.aggroRangeMeters, groupTtlMs: s.groupTtlMs }, at);

  const angry = (characterId) => safeGroup.provoked.has(characterId) || plan.attacks.includes(characterId);
  const perPlayer = players.map((p) => ({ characterId: p.characterId,
    relation: angry(p.characterId) ? HOSTILE : rel(p.characterId) }));
  let primary = null;
  if (ships.length > 0) {
    const center = ships[0].position;
    const near = players.map((p) => ({ id: p.characterId, d: distanceBetween(center, p.position) }))
      .filter((row) => row.d <= s.aggroRangeMeters)
      .sort((a, b) => a.d - b.d || a.id - b.id);
    if (near.length > 0) primary = near[0].id;
  }
  return { ...plan, relation: combineRelations(perPlayer, primary),
    armed: passive ? null : armedOf(sc, players, angry, rel, s) };
}

function armedOf(sc, players, angry, rel, s) {
  if (s.vendorAggroEnabled !== true) return null;
  const pilots = new Set();
  for (const c of Array.isArray(sc.pilots) ? sc.pilots : []) if (Number.isSafeInteger(c) && c > 0) pilots.add(c);
  for (const p of players) if (Number.isSafeInteger(p.characterId) && p.characterId > 0) pilots.add(p.characterId);
  if (pilots.size === 0) return null;
  return [...pilots].sort((a, b) => a - b).every((c) => angry(c) || rel(c) === HOSTILE);
}

module.exports = { planAmbientGroup };
