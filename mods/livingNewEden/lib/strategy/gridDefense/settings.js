"use strict";

const { parseFleetRoleList } = require("../../fleets/schema");
const { GATE_TRANSIT_MS } = require("../../fleets/data/travelProfiles");

const INTEGER_KEYS = Object.freeze([
  ["maxPosts", 1, 16],
  ["seenReactionMs", 0, 600000],
  ["locateMs", 0, 3600000],
  ["reactionJitterMs", 0, 120000],
  ["strengthRatioPermille", 100, 10000],
  ["maxPursuersPerIntruder", 1, 16],
  ["minHoldAtCp", 0, 8],
  ["maxPursuitsPerSystem", 1, 32],
  ["maxPursuitAttempts", 1, 8],
  ["returnAfterMs", 10000, 86400000],
  ["returnMaxRounds", 1, 64],
  ["scanFleets", 1, 256],
  ["maxEventsPerPass", 1, 1024],
]);
const BOOLEAN_KEYS = Object.freeze(["enabled", "whLocateEnabled", "chaseNonCombat"]);
const CROSSING_INTEGER_KEYS = Object.freeze([
  ["lockMs", 0, 60000],
  ["exitExposureMs", 0, GATE_TRANSIT_MS],
  ["nullExitExposureMs", 0, GATE_TRANSIT_MS],
  ["catchChancePermille", 0, 1000],
  ["minStrengthPermille", 0, 10000],
  ["listenerMaxSystems", 1, 64],
  ["listenerScanFleets", 1, 64],
  ["maxChecksPerLeg", 1, 32],
  ["maxEventsPerPass", 1, 1024],
]);

function parseDefenseSettings(config) {
  const d = config && config.grid && config.grid.defense;
  if (!d || typeof d !== "object") return { ok: false, key: "grid.defense" };
  const out = {};
  for (const key of BOOLEAN_KEYS) {
    if (typeof d[key] !== "boolean") return { ok: false, key: `grid.defense.${key}` };
    out[key] = d[key];
  }
  for (const [key, min, max] of INTEGER_KEYS) {
    const v = d[key];
    if (!Number.isSafeInteger(v) || v < min || v > max) return { ok: false, key: `grid.defense.${key}` };
    out[key] = v;
  }
  const roles = parseFleetRoleList(d.roles);
  if (!roles || roles.length === 0) return { ok: false, key: "grid.defense.roles" };
  out.roles = roles;
  if (d.strikePursuitEnabled !== undefined && typeof d.strikePursuitEnabled !== "boolean") {
    return { ok: false, key: "grid.defense.strikePursuitEnabled" };
  }
  out.strikePursuitEnabled = d.strikePursuitEnabled === true;
  if (out.locateMs < out.seenReactionMs) return { ok: false, key: "grid.defense.locateMs" };
  const factor = config.fleets && config.fleets.travelTimeFactor;
  if (typeof factor !== "number" || !Number.isFinite(factor) || factor <= 0) {
    return { ok: false, key: "fleets.travelTimeFactor" };
  }
  out.timeFactor = factor;
  const maxPositions = config.grid.maxPositionsPerCall;
  if (!Number.isSafeInteger(maxPositions) || maxPositions < 1) return { ok: false, key: "grid.maxPositionsPerCall" };
  out.maxPositionsPerCall = maxPositions;
  const siege = config.siege && typeof config.siege === "object" ? config.siege : {};
  out.siegePosts = siege.gridEnabled === true;
  out.siegeReadLimit = Number.isSafeInteger(siege.maxOpenSieges) && siege.maxOpenSieges >= 0 ? siege.maxOpenSieges : 0;
  if (out.siegePosts) {
    if (!Number.isSafeInteger(siege.recheckMs) || siege.recheckMs <= 0) return { ok: false, key: "siege.recheckMs" };
    out.siegeRecheckMs = siege.recheckMs;
  }
  const cr = parseCrossings(config.grid.crossings, out);
  if (!cr.ok) return cr;
  out.crossings = cr.crossings;
  return { ok: true, settings: Object.freeze(out) };
}

function parseCrossings(c, defense) {
  if (c === undefined || c === null) {
    return { ok: true, crossings: Object.freeze({ enabled: false, present: false,
      maxEventsPerPass: defense.maxEventsPerPass }) };
  }
  if (typeof c !== "object") return { ok: false, key: "grid.crossings" };
  if (typeof c.enabled !== "boolean") return { ok: false, key: "grid.crossings.enabled" };
  const out = { enabled: c.enabled, present: true };
  for (const [key, min, max] of CROSSING_INTEGER_KEYS) {
    const v = c[key];
    if (!Number.isSafeInteger(v) || v < min || v > max) return { ok: false, key: `grid.crossings.${key}` };
    out[key] = v;
  }
  if (Math.max(out.exitExposureMs, out.nullExitExposureMs) > GATE_TRANSIT_MS) {
    return { ok: false, key: "grid.crossings.nullExitExposureMs" };
  }
  return { ok: true, crossings: Object.freeze(out) };
}

module.exports = { parseDefenseSettings, INTEGER_KEYS, BOOLEAN_KEYS, CROSSING_INTEGER_KEYS };
