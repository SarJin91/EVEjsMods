"use strict";

function distanceBetween(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function isPoint(p) {
  return p !== null && typeof p === "object" && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
}

function pickAnchor(scene, settings, rng) {
  const sc = scene && typeof scene === "object" ? scene : {};
  const s = settings && typeof settings === "object" ? settings : {};
  const used = sc.usedAnchorIds instanceof Set ? sc.usedAnchorIds : new Set();
  const players = (Array.isArray(sc.players) ? sc.players : []).filter(isPoint);
  const blockers = (Array.isArray(sc.blockers) ? sc.blockers : []).filter(isPoint);
  const minPlayer = Number.isFinite(s.minPlayerDistanceMeters) ? s.minPlayerDistanceMeters : 0;
  const clear = Number.isFinite(s.anchorClearMeters) ? s.anchorClearMeters : 0;

  const free = (Array.isArray(sc.anchors) ? sc.anchors : [])
    .filter((a) => a && Number.isSafeInteger(a.itemId) && typeof a.kind === "string" && isPoint(a.position)
      && !used.has(a.itemId)
      && players.every((p) => distanceBetween(p, a.position) >= minPlayer)
      && blockers.every((b) => distanceBetween(b, a.position) >= clear))
    .sort((a, b) => a.itemId - b.itemId);
  if (free.length === 0) return { ok: false, reason: "NO_ANCHOR" };

  let roll = 0;
  try {
    roll = typeof rng === "function" ? Number(rng()) : 0;
  } catch {
    roll = 0;
  }
  const index = Number.isFinite(roll) && roll > 0 ? Math.min(free.length - 1, Math.floor(roll * free.length)) : 0;
  return { ok: true, anchor: { itemId: free[index].itemId, kind: free[index].kind } };
}

module.exports = { pickAnchor };
