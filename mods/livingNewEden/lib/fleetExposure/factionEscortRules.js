"use strict";

const { parseHullGroupList } = require("../fleets/schema");

const WAKE = Object.freeze({ CLAIM: "CLAIM", AMBUSH: "AMBUSH", PLAYER: "PLAYER" });
const HELD_PHASES = Object.freeze(["HELD", "EXITING"]);

const isPoint = (p) => Boolean(p) && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
const isId = (v) => Number.isSafeInteger(v) && v > 0;

function distanceSq(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return (dx * dx) + (dy * dy) + (dz * dz);
}

function escortGroupsOf(S) {
  const list = parseHullGroupList(S && typeof S === "object" ? S.convoyEscortHullGroups : null);
  return Array.isArray(list) ? list : [];
}

function exposeGroupsOf(carrierGroups, escortGroups, on) {
  if (on !== true) return carrierGroups;
  const out = Array.isArray(carrierGroups) ? [...carrierGroups] : [];
  for (const g of Array.isArray(escortGroups) ? escortGroups : []) if (!out.includes(g)) out.push(g);
  return out;
}

function wakeReasonOf(facts) {
  const f = facts && typeof facts === "object" ? facts : {};
  if (HELD_PHASES.includes(f.phase)) return WAKE.CLAIM;
  if (f.ambushEngaged === true) return WAKE.AMBUSH;
  if (f.playerAggression === true) return WAKE.PLAYER;
  return null;
}

function escortTargetsOf(input) {
  const i = input && typeof input === "object" ? input : {};
  const ships = (Array.isArray(i.escortShips) ? i.escortShips : []).filter((s) => s && isPoint(s.position));
  const out = [];
  const seen = new Set();
  if (i.targetPlayers !== false && i.hostileShips instanceof Set && ships.length > 0) {
    const found = [];
    for (const p of Array.isArray(i.players) ? i.players : []) {
      if (!p || !isId(p.entityId) || !isPoint(p.position) || !i.hostileShips.has(p.entityId)) continue;
      if (p.inWarp === true || p.cloaked === true || p.jumpCloaked === true || p.capsule === true) continue;
      let best = Infinity;
      for (const s of ships) best = Math.min(best, distanceSq(s.position, p.position));
      found.push({ entityId: p.entityId, d: best });
    }
    found.sort((a, b) => (a.d - b.d) || (a.entityId - b.entityId));
    for (const f of found) {
      if (seen.has(f.entityId)) continue;
      seen.add(f.entityId);
      out.push({ entityId: f.entityId });
    }
  }
  for (const id of Array.isArray(i.pirates) ? i.pirates : []) {
    if (!isId(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ entityId: id });
  }
  return out;
}

module.exports = { escortGroupsOf, exposeGroupsOf, wakeReasonOf, escortTargetsOf, WAKE };
