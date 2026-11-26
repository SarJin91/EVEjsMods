"use strict";

const { validateLegShape, hasWormholeEdges } = require("../fleets/travel");
const { pickCrossing, pickSeeded } = require("./rules");

const TRAVELLING = "TRAVELLING";
const RETREATING = "RETREATING";
const TRANSIT_STATES = Object.freeze([TRAVELLING, RETREATING]);
const TRANSIT_ANCHOR_SEED_KIND = "fleet-transit-anchor";

function legOf(fleet) {
  if (!fleet || !TRANSIT_STATES.includes(fleet.state)) return null;
  const leg = fleet.route;
  if (!leg || !validateLegShape(leg).ok || hasWormholeEdges(leg)) return null;
  if (!(leg.jumpMs > 0) || !Number.isSafeInteger(leg.departAt)) return null;
  return leg;
}

const firstWindowOf = (state) => (state === TRAVELLING ? 0 : 1);

function pickTransit(fleet, observed, now, p) {
  if (!(observed instanceof Set) || !Number.isSafeInteger(now) || !p) return null;
  const leg = legOf(fleet);
  if (leg === null || now < leg.departAt) return null;
  const i = Math.floor((now - leg.departAt) / leg.jumpMs);
  if (i < firstWindowOf(fleet.state) || i >= leg.systems.length - 1) return null;
  if (fleet.state === TRAVELLING && i > 0) return pickCrossing(fleet, observed, now, p);
  const systemId = leg.systems[i];
  if (!observed.has(systemId)) return null;
  const windowStart = leg.departAt + i * leg.jumpMs;
  const windowEnd = windowStart + leg.jumpMs;
  const despawnAt = Math.max(windowEnd - p.transitEndMarginMs, now + p.transitMinRemainingMs);
  return { systemId, systemIndex: i, legSeq: fleet.legSeq, fromSystemId: i > 0 ? leg.systems[i - 1] : null,
    toSystemId: leg.systems[i + 1], windowStart, windowEnd, despawnAt };
}

function legIndexKeys(fleet) {
  const leg = legOf(fleet);
  if (leg === null) return [];
  const out = [];
  for (let i = firstWindowOf(fleet.state); i < leg.systems.length - 1; i += 1) {
    if (!out.includes(leg.systems[i])) out.push(leg.systems[i]);
  }
  return out;
}

function transitAnchorsOf(objects, crossing, worldSeed, fleetId) {
  if (!crossing) return null;
  const list = Array.isArray(objects) ? objects.filter((o) => o && typeof o === "object") : [];
  const ofKind = (k) => list.filter((o) => o.kind === k);
  const gates = ofKind("stargate");
  const exit = gates.find((o) => o.toSystemId === crossing.toSystemId) || null;
  if (crossing.fromSystemId !== null && crossing.fromSystemId !== undefined) {
    const entry = gates.find((o) => o.toSystemId === crossing.fromSystemId) || null;
    if (entry) return { anchor: entry, exit, fallback: exit === null };
    const anchor = exit || gates[0] || ofKind("station")[0] || ofKind("sun")[0] || null;
    return anchor ? { anchor, exit, fallback: true } : null;
  }
  const station = pickSeeded(ofKind("station"), worldSeed, TRANSIT_ANCHOR_SEED_KIND, fleetId);
  if (station) return { anchor: station, exit, fallback: exit === null };
  const anchor = pickSeeded(ofKind("planet"), worldSeed, TRANSIT_ANCHOR_SEED_KIND, fleetId) || ofKind("sun")[0]
    || exit || null;
  return anchor ? { anchor, exit, fallback: true } : null;
}

function transitClaimable(fleetState, systemIndex, operationType, claimTypes) {
  return fleetState === TRAVELLING && Number.isSafeInteger(systemIndex) && systemIndex > 0
    && typeof operationType === "string" && Array.isArray(claimTypes) && claimTypes.includes(operationType);
}

function missedWindows(fleet, observedSince, now) {
  const leg = legOf(fleet);
  if (leg === null || !(observedSince instanceof Map) || !Number.isSafeInteger(now) || now < leg.departAt) return 0;
  const current = Math.min(Math.floor((now - leg.departAt) / leg.jumpMs), leg.systems.length - 1);
  let missed = 0;
  for (let k = firstWindowOf(fleet.state); k < current; k += 1) {
    const since = observedSince.get(leg.systems[k]);
    if (since !== undefined && since <= leg.departAt + (k + 1) * leg.jumpMs) missed += 1;
  }
  return missed;
}

module.exports = { TRANSIT_STATES, TRANSIT_ANCHOR_SEED_KIND, pickTransit, legIndexKeys, transitAnchorsOf,
  transitClaimable, missedWindows };
