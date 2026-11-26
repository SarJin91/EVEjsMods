"use strict";

const { deriveSeed, createRng } = require("../../util/rng");
const { bfs } = require("../ai/bfs");
const { hasWormholeEdges } = require("../../fleets/travel");
const { crossingOf, gateLegOf } = require("../../fleets/crossing");
const { preparedCatchOf, GATE } = require("../../fleets/grid/transit");

const AMBUSH_SEED_KIND = "lowsec-ambush";
const PERMILLE = 1000;
const LOWSEC = "lowsec";
const HIGHSEC = "highsec";
const SEED_KIND = "lowsec-camp";
const HOLD_IN_SYSTEM = Object.freeze(["STAGED", "ENGAGED"]);
const ON_THE_WAY = Object.freeze(["PLANNED", "TRAVELLING"]);

function gateLaneOf(id, input) {
  const list = input.neighbors(id);
  if (!Array.isArray(list)) return 0;
  return list.some((nb) => {
    const s = input.getSystem(nb);
    return Boolean(s && s.secClass === HIGHSEC);
  }) ? 1 : 0;
}

function candidatesOf(fleet, input, params, excluded, occupied) {
  const reach = bfs([fleet.systemId], input.neighbors, { maxJumps: params.campMaxJumps,
    maxSystems: params.maxBfsSystems });
  const weight = input.routeWeight instanceof Map ? input.routeWeight : null;
  const out = [];
  for (const [systemId, jumps] of reach) {
    if (jumps < 1 || occupied.has(systemId)) continue;
    const s = input.getSystem(systemId);
    if (!s || s.secClass !== LOWSEC || excluded.has(s.regionId)) continue;
    out.push({ systemId, jumps, gateLane: gateLaneOf(systemId, input),
      routeWeight: weight && Number.isFinite(weight.get(systemId)) ? weight.get(systemId) : 0 });
  }
  out.sort((a, b) => (b.routeWeight - a.routeWeight) || (b.gateLane - a.gateLane) || (a.jumps - b.jumps)
    || (a.systemId - b.systemId));
  return out;
}

function planCamps(input, params) {
  const camps = [];
  const skipped = [];
  const excluded = new Set(params.excludedRegionIds || []);
  const occupied = new Set(input.occupiedSystems || []);
  const campMax = Math.max(params.campMinMs, params.campMaxMs);
  const factions = [...(input.factions || [])].sort((a, b) => a.factionId - b.factionId);
  for (const f of factions) {
    if (input.openTotal + camps.length >= params.maxActiveCamps || camps.length >= params.maxCampsPerPlan) {
      skipped.push({ factionId: f.factionId, reason: "LIMIT" });
      continue;
    }
    if (f.open >= params.maxActiveCampsPerFaction) {
      skipped.push({ factionId: f.factionId, reason: "FACTION_LIMIT" });
      continue;
    }
    const fleets = ((input.fleetsByFaction && input.fleetsByFaction.get(f.factionId)) || [])
      .filter((fl) => params.campRoles.includes(fl.fleetRole) && fl.refitPending !== true)
      .sort((a, b) => (a.fleetId < b.fleetId ? -1 : (a.fleetId > b.fleetId ? 1 : 0)));
    if (fleets.length === 0) {
      skipped.push({ factionId: f.factionId, reason: "NO_FLEET" });
      continue;
    }
    let chosen = null;
    for (const fleet of fleets) {
      const list = candidatesOf(fleet, input, params, excluded, occupied);
      if (list.length === 0) continue;
      const seed = deriveSeed(input.worldSeed, SEED_KIND, `${f.factionId}:${input.round}`);
      const rng = createRng(seed);
      const rank = rng.nextUint32() % Math.min(Math.max(1, params.campChoiceTopN), list.length);
      const durationMs = params.campMinMs + Math.floor(rng.nextFloat() * (campMax - params.campMinMs + 1));
      const pick = list[rank];
      chosen = { factionId: f.factionId, fleetId: fleet.fleetId, expectedVersion: fleet.version,
        systemId: pick.systemId, jumps: pick.jumps, rank, seed, durationMs };
      break;
    }
    if (!chosen) {
      skipped.push({ factionId: f.factionId, reason: "NO_TARGET" });
      continue;
    }
    occupied.add(chosen.systemId);
    camps.push(chosen);
  }
  return { camps, skipped };
}

function decideCampStep(camp, fleet, facts, params) {
  if (!camp || (camp.state !== "PLANNED" && camp.state !== "ACTIVE")) return { action: "STALE" };
  const at = facts.at;
  const gone = !fleet || fleet.state === "DESTROYED";
  const nextKeep = Math.min(at + params.stepIntervalMs, camp.untilAt);
  const inSystem = Boolean(fleet && fleet.currentSystemId === camp.systemId);
  if (camp.state === "PLANNED") {
    if (at >= camp.untilAt) return { action: "CANCEL", reason: "TIMEOUT" };
    if (gone) return { action: "CANCEL", reason: "FLEET_LOST" };
    if (fleet.operationId !== camp.operationId) return { action: "CANCEL", reason: "DIVERTED" };
    if (HOLD_IN_SYSTEM.includes(fleet.state) && inSystem) return { action: "ACTIVATE", nextAt: nextKeep };
    if (ON_THE_WAY.includes(fleet.state)) {
      if (camp.watchRound + 1 > params.maxWatchRounds) return { action: "CANCEL", reason: "TIMEOUT" };
      const due = Number.isSafeInteger(fleet.nextActionAt) ? fleet.nextActionAt : 0;
      return { action: "WAIT", nextAt: Math.max(at + params.stepRecheckMs, due) };
    }
    return { action: "CANCEL", reason: "DIVERTED" };
  }
  if (at >= camp.untilAt) return { action: "EXPIRE", reason: "EXPIRED" };
  if (gone) return { action: "BREAK", reason: "DESTROYED" };
  if (inSystem && (fleet.state === "ENGAGED" || (fleet.state === "STAGED" && fleet.operationId === camp.operationId))) {
    return { action: "KEEP", nextAt: nextKeep };
  }
  return { action: "BREAK", reason: "LEFT" };
}

function crossingsOf(camp, convoys, fleets, window) {
  const out = [];
  if (!camp || !(fleets instanceof Map) || !window || !(window.end > window.start)) return out;
  const gate = Number.isSafeInteger(window.gateToSystemId) ? window.gateToSystemId : null;
  for (const c of convoys || []) {
    const fleet = fleets.get(c.fleetId);
    const x = crossingOf(fleet, camp.systemId);
    if (!x || !(x.from < window.end && x.from + x.jumpMs > window.start)) continue;
    if (gate !== null && x.leg.systems[x.i - 1] !== gate && x.leg.systems[x.i + 1] !== gate) continue;
    out.push({ convoyId: c.convoyId, fleetId: c.fleetId, legSeq: fleet.legSeq, systemIndex: x.i,
      at: Math.max(x.from, window.start) });
  }
  out.sort((a, b) => (a.at - b.at) || (a.convoyId < b.convoyId ? -1 : (a.convoyId > b.convoyId ? 1 : 0)));
  return out;
}

function routeWeightOf(convoys, fleets, at) {
  const weight = new Map();
  for (const c of convoys || []) {
    const leg = gateLegOf(fleets instanceof Map ? fleets.get(c.fleetId) : null);
    if (!leg) continue;
    for (let i = 1; i < leg.systems.length - 1; i += 1) {
      if (leg.departAt + (i + 1) * leg.jumpMs <= at) continue;
      weight.set(leg.systems[i], (weight.get(leg.systems[i]) || 0) + 1);
    }
  }
  return weight;
}

function crossingStartsOf(convoys, fleets, at) {
  const out = new Map();
  for (const c of convoys || []) {
    const leg = gateLegOf(fleets instanceof Map && c ? fleets.get(c.fleetId) : null);
    if (!leg) continue;
    for (let i = 1; i < leg.systems.length - 1; i += 1) {
      if (leg.departAt + (i + 1) * leg.jumpMs <= at) continue;
      const id = leg.systems[i];
      if (!out.has(id)) out.set(id, []);
      out.get(id).push(leg.departAt + i * leg.jumpMs);
    }
  }
  for (const list of out.values()) list.sort((a, b) => a - b);
  return out;
}

function decideAmbush(facts, params) {
  const { p, camp, convoy, convoyFleet, campFleet } = facts;
  const stale = (reason) => ({ action: "STALE", reason });
  if (!camp || camp.state !== "ACTIVE") return stale("CAMP_NOT_ACTIVE");
  if (p.at >= camp.untilAt || !(p.at >= camp.activeFrom)) return stale("CAMP_WINDOW");
  if (!convoy || convoy.state !== "IN_TRANSIT" || convoy.fleetId !== p.fleetId) return stale("CONVOY_GONE");
  if (!convoyFleet || convoyFleet.state !== "TRAVELLING" || convoyFleet.legSeq !== p.legSeq) return stale("LEG_MOVED");
  if (convoyFleet.route && hasWormholeEdges(convoyFleet.route)) return stale("LEG_HAS_WORMHOLES");
  const x = crossingOf(convoyFleet, camp.systemId);
  if (!x || x.i !== p.systemIndex || p.at < x.from || p.at >= x.from + x.jumpMs) return stale("NOT_CROSSING");
  if (!campFleet || campFleet.state !== "STAGED" || campFleet.currentSystemId !== camp.systemId
    || campFleet.operationId !== camp.operationId) return stale("CAMP_FLEET_AWAY");
  if (facts.hostile !== true) return stale("NOT_HOSTILE");
  if (Number.isFinite(facts.cooldownUntil) && facts.cooldownUntil > p.at) return stale("ON_COOLDOWN");
  let g = null;
  if (facts.gate && typeof facts.gate === "object") {
    const c = preparedCatchOf({ ...facts.gate, at: p.at, onlyOut: p.gate === GATE.OUT });
    if (c.ok) g = c;
    else if (c.reason !== "NO_GATE") return stale("GATE_AWAY");
    if (g && g.gate === GATE.OUT && p.gate !== GATE.OUT) return { action: "DEFER", catchAt: g.catchAt, anchor: g.anchor };
  }
  const roll = createRng(deriveSeed(facts.worldSeed, AMBUSH_SEED_KIND, `${p.campId}:${p.convoyId}`)).nextFloat();
  const action = roll * PERMILLE >= params.interceptChancePermille ? "ESCAPED" : "INTERCEPT";
  return g ? { action, roll, gate: g.gate, anchor: g.anchor } : { action, roll };
}

function campGateOf(systemId, convoys, fleets, at) {
  try {
    const traffic = new Map();
    const add = (id) => traffic.set(id, (traffic.get(id) || 0) + 1);
    for (const c of convoys || []) {
      const leg = gateLegOf(fleets instanceof Map && c ? fleets.get(c.fleetId) : null);
      if (!leg) continue;
      for (let i = 1; i < leg.systems.length - 1; i += 1) {
        if (leg.systems[i] !== systemId || leg.departAt + (i + 1) * leg.jumpMs <= at) continue;
        add(leg.systems[i - 1]);
        add(leg.systems[i + 1]);
      }
    }
    let best = null;
    for (const [toSystemId, n] of traffic) {
      if (!best || n > best.traffic || (n === best.traffic && toSystemId < best.toSystemId)) {
        best = { toSystemId, traffic: n };
      }
    }
    return best;
  } catch (_err) {
    return null;
  }
}

module.exports = { planCamps, decideCampStep, crossingsOf, decideAmbush, routeWeightOf, crossingStartsOf, campGateOf };
