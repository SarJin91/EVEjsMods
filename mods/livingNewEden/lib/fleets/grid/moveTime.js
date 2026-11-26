"use strict";

const { estimateWarpDurationMs } = require("../travel");
const { HULL_GROUPS } = require("../schema");
const { HULL_TRAVEL, ONE_AU_M, CROSSING_AU } = require("../data/travelProfiles");

const MS_PER_SECOND = 1000;

const isVec = (p) => p !== null && typeof p === "object" && Number.isFinite(p.x) && Number.isFinite(p.y)
  && Number.isFinite(p.z);

function distanceOf(from, to) {
  const a = from && from.position;
  const b = to && to.position;
  if (!isVec(a) || !isVec(b)) return { distanceM: CROSSING_AU * ONE_AU_M, fallbackDistance: true };
  return { distanceM: Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z), fallbackDistance: false };
}

function inSystemMoveMs(composition, from, to, opts) {
  const factor = opts && opts.timeFactor;
  if (typeof factor !== "number" || !Number.isFinite(factor) || factor <= 0) {
    return { ok: false, reason: "FLEET_INVALID_INPUT", detail: "timeFactor" };
  }
  if (!Array.isArray(composition) || composition.length === 0) return { ok: false, reason: "EMPTY_COMPOSITION" };
  const { distanceM, fallbackDistance } = distanceOf(from, to);
  let slowest = null;
  let slowestMs = -1;
  for (const entry of composition) {
    const group = entry && entry.hullGroup;
    if (!HULL_GROUPS.includes(group) || !Object.prototype.hasOwnProperty.call(HULL_TRAVEL, group)) {
      return { ok: false, reason: "UNKNOWN_HULL_GROUP", hullGroup: String(group) };
    }
    const profile = HULL_TRAVEL[group];
    const ms = profile.alignSeconds * MS_PER_SECOND + estimateWarpDurationMs(distanceM, profile);
    if (ms > slowestMs) {
      slowestMs = ms;
      slowest = group;
    }
  }
  return { ok: true, baseMs: Math.max(1, Math.round(factor * slowestMs)), hullGroup: slowest, distanceM,
    fallbackDistance };
}

module.exports = { inSystemMoveMs };
