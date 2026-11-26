"use strict";

const { validateLegShape, hasWormholeEdges } = require("../fleets/travel");
const { deriveSeed, createRng } = require("../util/rng");
const { membersOf } = require("../playerHunt/huntRepository");

const BELT_SEED_KIND = "fleet-exposure-belt";
const EXIT_LAND_METERS = 10000;
const TRAVELLING = "TRAVELLING";
const TRANSIT_KINDS = Object.freeze(["CONVOY", "PRESENCE"]);

const ACTION = Object.freeze({ CLAIM: "CLAIM", DESPAWN: "DESPAWN", KEEP: "KEEP", END: "END", EXIT: "EXIT",
  HOLD: "HOLD" });
const DESPAWN_REASONS = Object.freeze(["TRANSIT_DONE", "FLEET_MOVED", "TARGET_GONE", "SCENE_GONE"]);

function pickCrossing(fleet, observed, now, p) {
  if (!fleet || fleet.state !== TRAVELLING || !(observed instanceof Set) || !Number.isSafeInteger(now)) return null;
  const leg = fleet.route;
  if (!validateLegShape(leg).ok || hasWormholeEdges(leg)) return null;
  if (!(leg.jumpMs > 0) || now < leg.departAt) return null;
  const i = Math.floor((now - leg.departAt) / leg.jumpMs);
  if (i <= 0 || i >= leg.systems.length - 1) return null;
  const systemId = leg.systems[i];
  if (!observed.has(systemId)) return null;
  const windowStart = leg.departAt + i * leg.jumpMs;
  const windowEnd = windowStart + leg.jumpMs;
  const despawnAt = Math.max(windowEnd - p.transitEndMarginMs, now + p.transitMinRemainingMs);
  return { systemId, systemIndex: i, legSeq: fleet.legSeq, fromSystemId: leg.systems[i - 1],
    toSystemId: leg.systems[i + 1], windowStart, windowEnd, despawnAt };
}

function exposableMembers(fleet, hullGroups, maxShips) {
  if (!fleet || !Array.isArray(fleet.composition) || !Array.isArray(hullGroups)) return { ok: false, reason: "NONE" };
  const all = membersOf(fleet.fleetId, fleet.composition).filter((m) => hullGroups.includes(m.hullGroup))
    .map((m, i) => ({ m, i, rank: hullGroups.indexOf(m.hullGroup) }));
  if (all.length === 0 || !(maxShips >= 1)) return { ok: false, reason: "NONE" };
  all.sort((a, b) => (a.rank - b.rank) || (a.i - b.i));
  const members = all.slice(0, maxShips)
    .map(({ m }) => ({ memberKey: m.memberKey, hullGroup: m.hullGroup, typeId: m.typeId }));
  return { ok: true, members, total: all.length, trimmed: all.length > members.length };
}

function pickMinerAnchor(belts, worldSeed, fleetId) {
  return pickSeeded(belts, worldSeed, BELT_SEED_KIND, fleetId);
}

function pickSeeded(objects, worldSeed, seedKind, fleetId) {
  if (!Array.isArray(objects) || objects.length === 0 || !Number.isInteger(worldSeed)) return null;
  const sorted = [...objects].sort((a, b) => a.itemId - b.itemId);
  const rng = createRng(deriveSeed(worldSeed, seedKind, String(fleetId)));
  return sorted[rng.nextUint32() % sorted.length];
}

const SURFACE_ANCHOR_KINDS = Object.freeze(["planet", "sun", "station"]);

function spawnDistanceOf(anchor, baseMeters, surfaceMarginMeters, stationDefaultRadiusMeters) {
  if (!anchor || !SURFACE_ANCHOR_KINDS.includes(anchor.kind)) return baseMeters;
  const stationRadius = Number.isFinite(stationDefaultRadiusMeters) && stationDefaultRadiusMeters > 0
    ? stationDefaultRadiusMeters : 0;
  const radius = Number.isFinite(anchor.radius) && anchor.radius > 0 ? anchor.radius
    : (anchor.kind === "station" ? stationRadius : 0);
  return Math.max(baseMeters, Math.ceil(radius + surfaceMarginMeters));
}

function decideVisible(facts, p) {
  if (facts.pendingKill === true || facts.playerAggression === true) return { action: ACTION.CLAIM };
  if (TRANSIT_KINDS.includes(facts.kind) && Number.isSafeInteger(facts.despawnAt) && facts.now >= facts.despawnAt) {
    return { action: ACTION.DESPAWN, reason: "TRANSIT_DONE" };
  }
  if (facts.fleetExposable === false) return { action: ACTION.DESPAWN, reason: "FLEET_MOVED" };
  if (facts.now - facts.lastPlayerSeenAt > p.exitGraceMs) return { action: ACTION.DESPAWN, reason: "TARGET_GONE" };
  if (facts.sceneLoaded !== true) return { action: ACTION.DESPAWN, reason: "SCENE_GONE" };
  return { action: ACTION.KEEP };
}

function distanceSq(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return (dx * dx) + (dy * dy) + (dz * dz);
}

function landed(alive, exitPoint) {
  if (!exitPoint || !Array.isArray(alive) || alive.length === 0) return false;
  const max = EXIT_LAND_METERS * EXIT_LAND_METERS;
  return alive.every((s) => s && s.inWarp !== true && s.position && distanceSq(s.position, exitPoint) <= max);
}

function decideHeld(facts, p) {
  if (facts.allDestroyed === true) return { action: ACTION.END, reason: "WIPED" };
  if (facts.sceneLoaded !== true || !Array.isArray(facts.alive) || facts.alive.length === 0) {
    return { action: ACTION.END, reason: "SCENE_GONE" };
  }
  if (facts.phase === "EXITING") {
    if (facts.newAggression === true) return { action: ACTION.HOLD };
    if (landed(facts.alive, facts.exitPoint)
      || (Number.isSafeInteger(facts.exitAt) && facts.now - facts.exitAt >= p.exitWarpMaxMs)) {
      return { action: ACTION.END, reason: "QUIET" };
    }
  }
  if (facts.now - facts.lastPlayerSeenAt > p.exitGraceMs) return { action: ACTION.END, reason: "TARGET_GONE" };
  if (facts.now - facts.claimedAt >= p.maxHeldMs) return { action: ACTION.END, reason: "TIMEOUT" };
  if (facts.phase === "HELD" && facts.now - facts.lastAggressionAt >= p.holdQuietMs) return { action: ACTION.EXIT };
  return { action: ACTION.HOLD };
}

module.exports = { pickCrossing, exposableMembers, pickMinerAnchor, pickSeeded, spawnDistanceOf, decideVisible,
  decideHeld, landed, ACTION, DESPAWN_REASONS, EXIT_LAND_METERS, BELT_SEED_KIND, SURFACE_ANCHOR_KINDS };
