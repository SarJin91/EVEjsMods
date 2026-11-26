"use strict";

const { EXIT_OBJECT_KINDS } = require("./schema");

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isPoint = (p) => Boolean(p) && isNum(p.x) && isNum(p.y) && isNum(p.z);
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;

function distanceSq(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return (dx * dx) + (dy * dy) + (dz * dz);
}

function decideRetreat(input, params) {
  const p = params || {};
  const i = input || {};
  if (p.retreatEnabled !== true) return { retreat: false };
  const members = isCount(i.members) ? i.members : 0;
  const alive = isCount(i.alive) ? i.alive : 0;
  const hostiles = isCount(i.hostiles) ? i.hostiles : 0;
  const lost = isCount(i.lost) ? i.lost : members - alive;
  if (lost >= 1 && Number.isSafeInteger(p.retreatLossPermille) && lost * 1000 >= members * p.retreatLossPermille) {
    return { retreat: true, why: "LOSSES" };
  }
  if (Number.isSafeInteger(p.retreatOutnumberPermille) && p.retreatOutnumberPermille > 0 && alive > 0
    && hostiles * 1000 >= alive * p.retreatOutnumberPermille) {
    return { retreat: true, why: "OUTNUMBERED" };
  }
  return { retreat: false };
}

function byKindThenId(a, b) {
  const k = EXIT_OBJECT_KINDS.indexOf(a.kind) - EXIT_OBJECT_KINDS.indexOf(b.kind);
  return k !== 0 ? k : a.itemId - b.itemId;
}

function pickExitObject(objects, opts) {
  const o = opts || {};
  const list = (Array.isArray(objects) ? objects : []).filter((x) => x && EXIT_OBJECT_KINDS.includes(x.kind)
    && Number.isSafeInteger(x.itemId) && isPoint(x.position));
  if (list.length === 0) return null;
  const out = (x) => ({ kind: x.kind, itemId: x.itemId, position: { x: x.position.x, y: x.position.y,
    z: x.position.z } });
  if (Number.isSafeInteger(o.preferToSystemId) && o.preferToSystemId > 0) {
    const gates = list.filter((x) => x.kind === "stargate" && x.toSystemId === o.preferToSystemId)
      .sort((a, b) => a.itemId - b.itemId);
    if (gates.length > 0) return out(gates[0]);
  }
  if (!isPoint(o.awayFrom)) return out([...list].sort(byKindThenId)[0]);
  let best = null;
  let bestD = -1;
  for (const x of list) {
    const d = distanceSq(x.position, o.awayFrom);
    if (d > bestD || (d === bestD && x.itemId < best.itemId)) {
      best = x;
      bestD = d;
    }
  }
  return out(best);
}

function watchedBy(own, players, gridRadiusMeters) {
  if (!Array.isArray(own) || !Array.isArray(players) || !isNum(gridRadiusMeters) || gridRadiusMeters < 0) return false;
  const gridSq = gridRadiusMeters * gridRadiusMeters;
  const ships = own.filter((s) => s && s.inWarp !== true && isPoint(s.position));
  if (ships.length === 0) return false;
  return players.some((p) => p && p.inWarp !== true && isPoint(p.position)
    && ships.some((s) => distanceSq(s.position, p.position) <= gridSq));
}

function pickCampStation(objects, lastQuarryPos, maxMeters) {
  if (!Array.isArray(objects) || !isPoint(lastQuarryPos) || !isNum(maxMeters) || maxMeters < 0) return null;
  const maxSq = maxMeters * maxMeters;
  let best = null;
  let bestD = Infinity;
  for (const x of objects) {
    if (!x || x.kind !== "station" || !Number.isSafeInteger(x.itemId) || !isPoint(x.position)) continue;
    const d = distanceSq(x.position, lastQuarryPos);
    if (d > maxSq) continue;
    if (d < bestD || (d === bestD && x.itemId < best.itemId)) {
      best = x;
      bestD = d;
    }
  }
  return best ? { itemId: best.itemId, position: { x: best.position.x, y: best.position.y, z: best.position.z } }
    : null;
}

module.exports = { decideRetreat, pickExitObject, watchedBy, pickCampStation };
