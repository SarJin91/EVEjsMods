"use strict";

const { createRng, deriveSeed } = require("../util/rng");
const { TARGET_REASON } = require("./schema");

const PERMILLE = 1000;

function nonNegativeInt(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function hourPermilleAt(curve, atMs) {
  const time = Number.isFinite(atMs) ? atMs : 0;
  return nonNegativeInt(curve[new Date(time).getUTCHours()]);
}

function computeCivilianTarget(sys, atMs, seed, S) {
  if (!sys || !S || !S.bands.includes(sys.secClass)) return { wanted: 0, reason: TARGET_REASON.BAND_OFF };
  if (sys.normalLocal === false) return { wanted: 0, reason: TARGET_REASON.NOT_NORMAL_LOCAL };
  const stationCount = nonNegativeInt(sys.stationCount);
  const jumps = Number.isSafeInteger(sys.hubJumps) && sys.hubJumps > 0 && sys.hubJumps <= S.maxHubJumps
    ? sys.hubJumps : null;
  let anchor = 0;
  let reason;
  if (sys.isPrimeHub === true) {
    anchor = S.primeHubPilots;
    reason = TARGET_REASON.HUB;
  } else if (sys.isHub === true) {
    anchor = S.hubPilots;
    reason = TARGET_REASON.HUB;
  } else if (jumps !== null && nonNegativeInt(S.nearHubPilots[jumps - 1]) > 0) {
    anchor = S.nearHubPilots[jumps - 1];
    reason = TARGET_REASON.NEAR_HUB;
  } else {
    reason = stationCount > 0 ? TARGET_REASON.STATIONS : TARGET_REASON.BASE;
  }
  const raw = anchor + S.basePilots + Math.min(stationCount * S.perStationPilots, S.maxStationBonus);
  const time = Number.isFinite(atMs) ? atMs : 0;
  const curve = hourPermilleAt(S.hourCurvePermille, time);
  const bucket = Math.floor(time / S.bucketMs);
  const rng = createRng(deriveSeed(seed >>> 0, "hs-civ", sys.systemId, bucket));
  const jitter = S.jitterPermille > 0 ? rng.nextInt(-S.jitterPermille, S.jitterPermille) : 0;
  const value = Math.round((raw * curve / PERMILLE) * (PERMILLE + jitter) / PERMILLE);
  return { wanted: Math.max(0, Math.min(S.maxCiviliansPerSystem, value)), reason };
}

function buildHubDistance(graph, hubIds, maxHubJumps) {
  const dist = new Map();
  if (!graph || typeof graph.getNeighbors !== "function" || !Array.isArray(hubIds)) return dist;
  const limit = nonNegativeInt(maxHubJumps);
  let frontier = [];
  for (const id of hubIds) {
    if (dist.has(id) || graph.getNeighbors(id) === null) continue;
    dist.set(id, 0);
    frontier.push(id);
  }
  for (let depth = 1; depth <= limit && frontier.length > 0; depth += 1) {
    const next = [];
    for (const id of frontier) {
      for (const n of graph.getNeighbors(id) || []) {
        if (dist.has(n)) continue;
        dist.set(n, depth);
        next.push(n);
      }
    }
    frontier = next;
  }
  return dist;
}

module.exports = { computeCivilianTarget, buildHubDistance, hourPermilleAt };
