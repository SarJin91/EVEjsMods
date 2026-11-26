"use strict";

const DEFEND_KINDS = Object.freeze({ AGGRESSOR: "aggressor", LNE: "lne", RAT: "rat", PLAYER: "player" });

const isObj = (v) => v !== null && typeof v === "object";
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const byDist = (a, b) => a.dist - b.dist || a.entityId - b.entityId;

function distance(a, b) {
  return Math.sqrt((a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2);
}

function defendTargets(input) {
  const i = isObj(input) ? input : {};
  if (!isObj(i.sentryPos)) return [];
  const range = Number.isFinite(i.maxRangeM) ? i.maxRangeM : 0;
  const max = Number.isSafeInteger(i.maxCandidates) && i.maxCandidates > 0 ? i.maxCandidates : 0;
  if (max === 0) return [];
  const prot = i.protectedIds instanceof Set ? i.protectedIds : new Set();
  const lneAll = i.lneAll instanceof Set ? i.lneAll : new Set();
  const taken = new Set();
  const aggressors = [];
  const rest = [];
  const npcs = Array.isArray(i.npcs) ? i.npcs : [];
  const npcDist = new Map();
  for (const n of npcs) {
    if (!isObj(n) || !isId(n.entityId) || !isObj(n.position) || prot.has(n.entityId)) continue;
    const dist = distance(i.sentryPos, n.position);
    if (!(dist <= range)) continue;
    npcDist.set(n.entityId, { n, dist });
    if (isId(n.targetId) && prot.has(n.targetId) && !taken.has(n.entityId)) {
      taken.add(n.entityId);
      aggressors.push({ entityId: n.entityId, dist, kind: DEFEND_KINDS.AGGRESSOR });
    }
  }
  for (const p of Array.isArray(i.playerAggressors) ? i.playerAggressors : []) {
    if (!isObj(p) || !isId(p.entityId) || !isObj(p.position) || prot.has(p.entityId) || taken.has(p.entityId)) continue;
    const dist = distance(i.sentryPos, p.position);
    if (!(dist <= range)) continue;
    taken.add(p.entityId);
    aggressors.push({ entityId: p.entityId, dist, kind: DEFEND_KINDS.PLAYER });
  }
  for (const h of Array.isArray(i.lneHostiles) ? i.lneHostiles : []) {
    if (!isObj(h) || !isId(h.entityId) || !(h.dist <= range) || prot.has(h.entityId) || taken.has(h.entityId)) continue;
    taken.add(h.entityId);
    rest.push({ entityId: h.entityId, dist: h.dist, kind: DEFEND_KINDS.LNE });
  }
  for (const [entityId, { n, dist }] of npcDist) {
    if (n.aggroPlayers !== true || lneAll.has(entityId) || taken.has(entityId)) continue;
    taken.add(entityId);
    rest.push({ entityId, dist, kind: DEFEND_KINDS.RAT });
  }
  aggressors.sort(byDist);
  rest.sort(byDist);
  return [...aggressors, ...rest].slice(0, max);
}

module.exports = { defendTargets, DEFEND_KINDS };
