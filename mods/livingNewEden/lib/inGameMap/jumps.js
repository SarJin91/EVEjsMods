"use strict";

const { validateLegShape } = require("../fleets/travel");

const VENDOR_MAX_WINDOW_MS = 24 * 3600000;
const MAX_LEGS_PER_FLEET = 2;

function createLegState() {
  return { legs: new Map(), size: 0 };
}

function countJumps(legs, nowMs, windowMs) {
  const out = new Map();
  const cutoff = nowMs - windowMs;
  for (const leg of legs) {
    const last = leg.systems.length - 1;
    const from = Math.max(1, Math.ceil((cutoff - leg.departAt) / leg.jumpMs));
    let to = Math.min(last, Math.floor((nowMs - leg.departAt) / leg.jumpMs));
    if (leg.cutAt !== null) to = Math.min(to, Math.ceil((leg.cutAt - leg.departAt) / leg.jumpMs) - 1);
    for (let i = from; i <= to; i += 1) {
      const id = leg.systems[i];
      out.set(id, (out.get(id) || 0) + leg.weight);
    }
  }
  return out;
}

function mergeLeg(state, fleet, limits, seenAtMs) {
  if (!fleet || typeof fleet.fleetId !== "string" || !Number.isSafeInteger(fleet.legSeq)) return "invalid";
  const route = fleet.route;
  if (!validateLegShape(route).ok) return "invalid";
  const seenAt = Number.isFinite(seenAtMs) ? seenAtMs : null;
  const list = state.legs.get(fleet.fleetId) || [];
  if (list.some((leg) => leg.legSeq >= fleet.legSeq)) {
    const last = list[list.length - 1];
    if (last.legSeq === fleet.legSeq && seenAt !== null) {
      last.seenAt = last.seenAt === null ? seenAt : Math.max(last.seenAt, seenAt);
      if (last.staleCut) {
        last.cutAt = null;
        last.staleCut = false;
      }
    }
    return "known";
  }
  const ships = Number.isSafeInteger(fleet.shipCount) ? fleet.shipCount : 1;
  const leg = { fleetId: fleet.fleetId, legSeq: fleet.legSeq, systems: [...route.systems], departAt: route.departAt,
    jumpMs: route.jumpMs, arriveAt: route.arriveAt, weight: limits.perShip ? Math.max(1, ships) : 1, cutAt: null,
    seenAt, staleCut: false };
  let kept = list;
  if (list.length > 0) {
    const previous = list[list.length - 1];
    previous.cutAt = previous.cutAt === null ? leg.departAt : Math.min(previous.cutAt, leg.departAt);
    kept = list.slice(list.length - (MAX_LEGS_PER_FLEET - 1));
  }
  state.size += 1 - (list.length - kept.length);
  state.legs.set(fleet.fleetId, [...kept, leg]);
  return "added";
}

function pruneLegs(state, nowMs, limits) {
  const cutoff = nowMs - VENDOR_MAX_WINDOW_MS;
  let pruned = 0;
  for (const [fleetId, list] of state.legs) {
    const kept = list.filter((leg) => leg.arriveAt >= cutoff);
    pruned += list.length - kept.length;
    if (kept.length === 0) state.legs.delete(fleetId);
    else if (kept.length !== list.length) state.legs.set(fleetId, kept);
  }
  state.size -= pruned;
  let evicted = 0;
  const excess = state.size - limits.maxTrackedLegs;
  if (excess > 0) {
    const all = [];
    for (const list of state.legs.values()) all.push(...list);
    all.sort((a, b) => a.arriveAt - b.arriveAt || (a.fleetId < b.fleetId ? -1 : a.fleetId > b.fleetId ? 1 : 0));
    const drop = new Set(all.slice(0, excess));
    for (const [fleetId, list] of state.legs) {
      const kept = list.filter((leg) => !drop.has(leg));
      if (kept.length === 0) state.legs.delete(fleetId);
      else if (kept.length !== list.length) state.legs.set(fleetId, kept);
    }
    evicted = drop.size;
    state.size -= evicted;
  }
  return { pruned, evicted };
}

function cutStaleLegs(state, seen, nowMs) {
  let cut = 0;
  for (const [fleetId, list] of state.legs) {
    const last = list[list.length - 1];
    if (seen.get(fleetId) === last.legSeq || last.arriveAt <= nowMs || last.seenAt === null) continue;
    const at = last.seenAt + 1;
    if (last.cutAt !== null && last.cutAt <= at) continue;
    last.cutAt = at;
    last.staleCut = true;
    cut += 1;
  }
  return cut;
}

function* allLegs(state) {
  for (const list of state.legs.values()) yield* list;
}

module.exports = { VENDOR_MAX_WINDOW_MS, MAX_LEGS_PER_FLEET, createLegState, countJumps, mergeLeg, pruneLegs,
  cutStaleLegs, allLegs };
