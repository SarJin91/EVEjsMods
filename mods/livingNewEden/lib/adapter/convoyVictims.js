"use strict";

const ships = new Map();
let marked = 0;
let forgotten = 0;
let evicted = 0;

const isPositiveInt = (v) => Number.isSafeInteger(v) && v > 0;

const toPositiveInt = (v) => {
  const n = Math.trunc(Number(v));
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};

function markConvoyShips(entityIds, o) {
  if (!Array.isArray(entityIds) || !o || typeof o !== "object") return { ok: false, reason: "INVALID_INPUT" };
  const ownerFactionId = o.ownerFactionId;
  const cap = o.cap;
  if (!isPositiveInt(ownerFactionId) || !isPositiveInt(cap)) return { ok: false, reason: "INVALID_INPUT" };
  if (typeof o.fleetId !== "string" || o.fleetId.length === 0) return { ok: false, reason: "INVALID_INPUT" };
  if (!entityIds.every(isPositiveInt)) return { ok: false, reason: "INVALID_INPUT" };
  let markedNow = 0;
  let evictedNow = 0;
  for (const id of entityIds) {
    ships.delete(id);
    ships.set(id, { ownerFactionId, fleetId: o.fleetId });
    markedNow += 1;
    while (ships.size > cap) {
      const oldest = ships.keys().next().value;
      ships.delete(oldest);
      evictedNow += 1;
    }
  }
  marked += markedNow;
  evicted += evictedNow;
  return { ok: true, marked: markedNow, evicted: evictedNow };
}

function forgetConvoyShips(entityIds) {
  let n = 0;
  if (Array.isArray(entityIds)) {
    for (const raw of entityIds) {
      const id = toPositiveInt(raw);
      if (id && ships.delete(id)) n += 1;
    }
  }
  forgotten += n;
  return { ok: true, forgotten: n };
}

function convoyOwnerOf(entity) {
  if (!entity || typeof entity !== "object") return null;
  const id = toPositiveInt(entity.itemID);
  if (!id) return null;
  const entry = ships.get(id);
  return entry ? entry.ownerFactionId : null;
}

function convoyVictimsStatus() {
  return { size: ships.size, marked, forgotten, evicted };
}

function resetConvoyVictimsForTests() {
  ships.clear();
  marked = 0;
  forgotten = 0;
  evicted = 0;
}

module.exports = { markConvoyShips, forgetConvoyShips, convoyOwnerOf, convoyVictimsStatus,
  resetConvoyVictimsForTests };
