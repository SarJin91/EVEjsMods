"use strict";

const ROLES = Object.freeze(["victim", "pirate"]);
const MAX_SITUATION_ID = 40;

const ships = new Map();
let marked = 0;
let forgotten = 0;
let evicted = 0;

const isPositiveInt = (v) => Number.isSafeInteger(v) && v > 0;

const toPositiveInt = (v) => {
  const n = Math.trunc(Number(v));
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};

function markSituationShips(entityIds, o) {
  if (!Array.isArray(entityIds) || !o || typeof o !== "object") return { ok: false, reason: "INVALID_INPUT" };
  if (typeof o.situationId !== "string" || o.situationId.length === 0 || o.situationId.length > MAX_SITUATION_ID
    || !ROLES.includes(o.role) || !isPositiveInt(o.cap) || !entityIds.every(isPositiveInt)) {
    return { ok: false, reason: "INVALID_INPUT" };
  }
  let markedNow = 0;
  let evictedNow = 0;
  for (const id of entityIds) {
    ships.delete(id);
    ships.set(id, Object.freeze({ situationId: o.situationId, role: o.role }));
    markedNow += 1;
    while (ships.size > o.cap) {
      ships.delete(ships.keys().next().value);
      evictedNow += 1;
    }
  }
  marked += markedNow;
  evicted += evictedNow;
  return { ok: true, marked: markedNow, evicted: evictedNow };
}

function forgetSituationShips(entityIds) {
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

function situationShipOf(entityOrId) {
  const id = typeof entityOrId === "number" ? toPositiveInt(entityOrId)
    : entityOrId && typeof entityOrId === "object" ? toPositiveInt(entityOrId.itemID) : 0;
  return id ? ships.get(id) || null : null;
}

function situationShipsStatus() {
  return { size: ships.size, marked, forgotten, evicted };
}

function resetSituationShipsForTests() {
  ships.clear();
  marked = 0;
  forgotten = 0;
  evicted = 0;
}

module.exports = { markSituationShips, forgetSituationShips, situationShipOf, situationShipsStatus,
  resetSituationShipsForTests, ROLES };
