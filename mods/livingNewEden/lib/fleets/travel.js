// The warp model is ported 1:1 from X-Eve estimateWarpDurationMs (livingUniverseRuntime.js; CREDITS.md), the constants live in data/travelProfiles.js.

"use strict";

const { HULL_GROUPS } = require("./schema");
const {
  ONE_AU_M, CROSSING_AU, GATE_TRANSIT_MS, WARP_DROPOUT_SPEED_MAX_MS, MIN_WARP_MS, HULL_TRAVEL,
} = require("./data/travelProfiles");

const LEG_VERSION = 1;
const LEG_VERSION_WH = 2;
const LEG_WH_KEYS = Object.freeze(["constraints", "wormholeEdges"]);
const MIN_PAIR_KEY_LENGTH = 3;
const MAX_PAIR_KEY_LENGTH = 64;
const LEG_MODES = Object.freeze(["travel", "retreat"]);
const IN_FLIGHT = Object.freeze(["TRAVELLING", "RETREATING"]);
const MS_PER_SECOND = 1000;
const MIN_WARP_SPEED_AU = 0.1;
const MIN_VELOCITY_MS = 1;
const MIN_K_SUM = 0.001;
const DECEL_DIVISOR = 3;
const MAX_DECEL = 2;
const LEG_KEYS = Object.freeze(["v", "mode", "systems", "departAt", "jumpMs", "arriveAt", "graphVersion",
  "observed"]);

function invalid(detail) {
  return { ok: false, reason: "FLEET_INVALID_INPUT", detail };
}

function isPositiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isTime(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function finiteOr(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// Port of X-Eve estimateWarpDurationMs: acceleration / cruise / deceleration of the live warp profile.
function estimateWarpDurationMs(distanceMeters, movement) {
  const totalDistance = Math.max(0, finiteOr(distanceMeters, 0));
  const warpSpeedAU = Math.max(MIN_WARP_SPEED_AU, finiteOr(movement && movement.warpSpeedAu, MIN_WARP_SPEED_AU));
  const maxVelocity = Math.max(MIN_VELOCITY_MS, finiteOr(movement && movement.maxVelocityMs, MIN_VELOCITY_MS));
  const dropoutSpeedMs = Math.max(Math.min(maxVelocity / 2, WARP_DROPOUT_SPEED_MAX_MS), 1);
  const kAccel = warpSpeedAU;
  const kDecel = Math.min(warpSpeedAU / DECEL_DIVISOR, MAX_DECEL);
  let maxWarpSpeedMs = warpSpeedAU * ONE_AU_M;
  let accelDistance = maxWarpSpeedMs / kAccel;
  let decelDistance = maxWarpSpeedMs / kDecel;
  const minimumDistance = accelDistance + decelDistance;
  let cruiseTimeSeconds = 0;
  if (minimumDistance > totalDistance) {
    maxWarpSpeedMs = (totalDistance * kAccel * kDecel) / Math.max(kAccel + kDecel, MIN_K_SUM);
    accelDistance = maxWarpSpeedMs / kAccel;
    decelDistance = maxWarpSpeedMs / kDecel;
  } else {
    cruiseTimeSeconds = Math.max(0, totalDistance - accelDistance - decelDistance) / maxWarpSpeedMs;
  }
  const accelTimeSeconds = Math.log(Math.max(maxWarpSpeedMs / kAccel, 1)) / kAccel;
  const decelTimeSeconds = Math.log(Math.max(maxWarpSpeedMs / dropoutSpeedMs, 1)) / kDecel;
  return Math.max(MIN_WARP_MS, Math.ceil((accelTimeSeconds + cruiseTimeSeconds + decelTimeSeconds) * MS_PER_SECOND));
}

function groupJumpMs(profile) {
  return profile.alignSeconds * MS_PER_SECOND + estimateWarpDurationMs(CROSSING_AU * ONE_AU_M, profile)
    + GATE_TRANSIT_MS;
}

function jumpMsForComposition(composition, opts) {
  const factor = opts && opts.timeFactor;
  if (typeof factor !== "number" || !Number.isFinite(factor) || factor <= 0) return invalid("timeFactor");
  if (!Array.isArray(composition) || composition.length === 0) return { ok: false, reason: "EMPTY_COMPOSITION" };
  let slowest = null;
  let slowestMs = -1;
  for (const entry of composition) {
    const group = entry && entry.hullGroup;
    if (!HULL_GROUPS.includes(group) || !Object.prototype.hasOwnProperty.call(HULL_TRAVEL, group)) {
      return { ok: false, reason: "UNKNOWN_HULL_GROUP", hullGroup: String(group) };
    }
    const ms = groupJumpMs(HULL_TRAVEL[group]);
    if (ms > slowestMs) {
      slowestMs = ms;
      slowest = group;
    }
  }
  return { ok: true, baseJumpMs: Math.max(1, Math.round(factor * slowestMs)), hullGroup: slowest };
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function validWormholeEdges(edges, jumps) {
  if (!Array.isArray(edges)) return false;
  let last = -1;
  for (const e of edges) {
    if (!isPlainObject(e) || Object.keys(e).length !== 3) return false;
    if (!Number.isSafeInteger(e.i) || e.i <= last || e.i >= jumps) return false;
    if (typeof e.pairKey !== "string" || e.pairKey.length < MIN_PAIR_KEY_LENGTH
      || e.pairKey.length > MAX_PAIR_KEY_LENGTH) return false;
    if (!isTime(e.expiresAt)) return false;
    last = e.i;
  }
  return true;
}

function validateLegShape(leg) {
  if (!leg || typeof leg !== "object" || Array.isArray(leg)) return invalid("leg");
  const v2 = leg.v === LEG_VERSION_WH;
  for (const key of Object.keys(leg)) {
    if (!LEG_KEYS.includes(key) && !(v2 && LEG_WH_KEYS.includes(key))) return invalid(`leg.${key}`);
  }
  if (leg.v !== LEG_VERSION && !v2) return invalid("leg.v");
  if (v2) {
    if (!isPlainObject(leg.constraints)) return invalid("leg.constraints");
    const jumps = Array.isArray(leg.systems) ? leg.systems.length - 1 : 0;
    if (!validWormholeEdges(leg.wormholeEdges, jumps)) return invalid("leg.wormholeEdges");
  }
  if (!LEG_MODES.includes(leg.mode)) return invalid("leg.mode");
  if (!Array.isArray(leg.systems) || leg.systems.length < 2 || !leg.systems.every(isPositiveId)) {
    return invalid("leg.systems");
  }
  if (!isTime(leg.departAt)) return invalid("leg.departAt");
  if (!Number.isSafeInteger(leg.jumpMs) || leg.jumpMs < 1) return invalid("leg.jumpMs");
  if (leg.arriveAt !== leg.departAt + (leg.systems.length - 1) * leg.jumpMs) return invalid("leg.arriveAt");
  if (!isPositiveId(leg.graphVersion)) return invalid("leg.graphVersion");
  if (typeof leg.observed !== "boolean") return invalid("leg.observed");
  return { ok: true };
}

function buildLeg(p) {
  if (!p || typeof p !== "object") return invalid("leg input");
  const systems = Array.isArray(p.systems) ? [...p.systems] : null;
  if (systems === null) return invalid("leg.systems");
  const jumps = systems.length - 1;
  const departAt = p.departAt;
  const jumpMs = p.jumpMs;
  const arriveAt = Number.isSafeInteger(departAt) && Number.isSafeInteger(jumpMs) ? departAt + jumps * jumpMs : NaN;
  const wh = p.constraints !== undefined || p.wormholeEdges !== undefined;
  const leg = { v: wh ? LEG_VERSION_WH : LEG_VERSION, mode: p.mode, systems, departAt, jumpMs, arriveAt,
    graphVersion: p.graphVersion, observed: p.observed };
  if (wh) {
    leg.constraints = p.constraints;
    leg.wormholeEdges = Array.isArray(p.wormholeEdges)
      ? p.wormholeEdges.map((e) => ({ i: e && e.i, pairKey: e && e.pairKey, expiresAt: e && e.expiresAt }))
      : p.wormholeEdges;
  }
  const shape = validateLegShape(leg);
  if (!shape.ok) return shape;
  if (!Number.isSafeInteger(arriveAt)) return invalid("leg.arriveAt");
  return { ok: true, leg };
}

function positionAt(fleet, at) {
  const current = fleet && fleet.currentSystemId !== undefined ? fleet.currentSystemId : null;
  if (!fleet || !IN_FLIGHT.includes(fleet.state)) return { inFlight: false, systemId: current };
  const leg = fleet.route;
  if (!validateLegShape(leg).ok) return { inFlight: false, systemId: current, invalidRoute: true };
  const jumps = leg.systems.length - 1;
  const t = typeof at === "number" && Number.isFinite(at) ? at : leg.departAt;
  const k = Math.min(jumps, Math.max(0, Math.floor((t - leg.departAt) / leg.jumpMs)));
  const span = leg.arriveAt - leg.departAt;
  const progress = Math.min(1, Math.max(0, (t - leg.departAt) / span));
  return { inFlight: true, systemId: leg.systems[k], index: k, nextSystemId: k < jumps ? leg.systems[k + 1] : null,
    progress, arrived: t >= leg.arriveAt, departAt: leg.departAt, arriveAt: leg.arriveAt, legSeq: fleet.legSeq };
}

function hasWormholeEdges(leg) {
  return Boolean(leg && leg.v === LEG_VERSION_WH && Array.isArray(leg.wormholeEdges) && leg.wormholeEdges.length > 0);
}

function crossAt(leg, i) {
  return leg.departAt + (i + 1) * leg.jumpMs;
}

function gateSegments(leg) {
  const cuts = hasWormholeEdges(leg) ? leg.wormholeEdges.map((e) => e.i) : [];
  const out = [];
  let start = 0;
  for (const i of cuts) {
    out.push({ offset: start, systems: leg.systems.slice(start, i + 1) });
    start = i + 1;
  }
  out.push({ offset: start, systems: leg.systems.slice(start) });
  return out;
}

function wormholeCut(leg, transits) {
  if (!hasWormholeEdges(leg)) return { cut: false };
  const closedOf = new Map();
  for (const t of transits || []) {
    if (t && Number.isSafeInteger(t.edgeIndex) && Number.isSafeInteger(t.closedAt)) closedOf.set(t.edgeIndex, t.closedAt);
  }
  for (const e of leg.wormholeEdges) {
    const closed = closedOf.has(e.i) ? closedOf.get(e.i) : Infinity;
    const closeAt = Math.min(closed, e.expiresAt > 0 ? e.expiresAt : Infinity);
    if (!(closeAt < crossAt(leg, e.i))) continue;
    const at = Math.max(leg.departAt, closeAt);
    const systemIndex = Math.min(e.i, Math.floor((at - leg.departAt) / leg.jumpMs));
    return { cut: true, edgeIndex: e.i, pairKey: e.pairKey, at, systemIndex, systemId: leg.systems[systemIndex] };
  }
  return { cut: false };
}

module.exports = { LEG_VERSION, LEG_VERSION_WH, LEG_MODES, IN_FLIGHT, estimateWarpDurationMs, jumpMsForComposition,
  validateLegShape, buildLeg, positionAt, hasWormholeEdges, crossAt, gateSegments, wormholeCut };
