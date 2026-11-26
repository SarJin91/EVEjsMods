"use strict";

const { deriveSeed, createRng } = require("../../util/rng");
const { bfs } = require("../ai/bfs");
const D = require("./data/expeditionRules");
const { CAPITAL_TYPE_MASS_KG, CAPITAL_CLASS_MASS_KG, SUBCAP_CLASS_MASS_KG } = require("../../fleets/data/hullMasses");

const SEED_KIND = "wh-expedition";
const PERMILLE = 1000;
const FLYING = Object.freeze(["TRAVELLING", "RETREATING"]);
const BUSY = Object.freeze(["ENGAGED", "REFITTING"]);
const PARKED = Object.freeze(["STAGED", "IDLE"]);
const PENDING = "PLANNED";
const ACTIVATE_STATES = Object.freeze(["STAGED", "ENGAGED"]);

const byId = (a, b) => (a < b ? -1 : (a > b ? 1 : 0));
const massRuleOf = (params) => Boolean(params) && params.massRuleEnabled === true;
const subcapRuleOf = (params) => Boolean(params) && params.subcapMassRuleEnabled === true;

function classOf(input, id) {
  const s = input.getSystem(id);
  return s && typeof s.secClass === "string" ? s.secClass : null;
}

function isKSpace(input, id) {
  return D.KSPACE_CLASSES.includes(classOf(input, id));
}

function endsOf(input, edge) {
  const a = classOf(input, edge.fromSystemId);
  const b = classOf(input, edge.toSystemId);
  if (D.KSPACE_CLASSES.includes(a) && b === D.JSPACE_CLASS) return { entry: edge.fromSystemId, target: edge.toSystemId };
  if (D.KSPACE_CLASSES.includes(b) && a === D.JSPACE_CLASS) return { entry: edge.toSystemId, target: edge.fromSystemId };
  return null;
}

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const present = (c) => Boolean(c) && Number.isSafeInteger(c.count) && c.count > 0;
const compositionOf = (composition) => (Array.isArray(composition) ? composition : []);

function entryMassOf(c, capitals, subcaps) {
  const group = typeof c.hullGroup === "string" ? c.hullGroup : null;
  if (capitals) {
    if (Number.isSafeInteger(c.typeId) && hasOwn(CAPITAL_TYPE_MASS_KG, String(c.typeId))) {
      return CAPITAL_TYPE_MASS_KG[String(c.typeId)];
    }
    if (group !== null && hasOwn(CAPITAL_CLASS_MASS_KG, group)) return CAPITAL_CLASS_MASS_KG[group];
  }
  if (subcaps && group !== null && hasOwn(SUBCAP_CLASS_MASS_KG, group)) return SUBCAP_CLASS_MASS_KG[group];
  return 0;
}

function fleetMassOf(composition, opts) {
  const capitals = Boolean(opts) && opts.capitals === true;
  const subcaps = Boolean(opts) && opts.subcaps === true;
  let mass = 0;
  for (const c of compositionOf(composition)) {
    if (!present(c)) continue;
    const m = entryMassOf(c, capitals, subcaps);
    if (m > mass) mass = m;
  }
  return mass;
}

function capitalMassOf(composition) {
  return fleetMassOf(composition, { capitals: true, subcaps: false });
}

function capitalCountOf(composition) {
  let n = 0;
  for (const c of compositionOf(composition)) {
    if (present(c) && typeof c.hullGroup === "string" && hasOwn(CAPITAL_CLASS_MASS_KG, c.hullGroup)) n += c.count;
  }
  return n;
}

function isFleetCandidate(fleet, input, params) {
  if (!fleet || fleet.state !== "IDLE" || (fleet.operationId !== null && fleet.operationId !== undefined)) return false;
  if (fleet.refitPending === true || !D.EXPEDITION_ROLES.includes(fleet.fleetRole)) return false;
  if (!Number.isSafeInteger(fleet.jumpMs) || fleet.jumpMs < 1 || !isKSpace(input, fleet.systemId)) return false;
  const comp = Array.isArray(fleet.composition) ? fleet.composition : [];
  if (!massRuleOf(params)) return !comp.some((c) => c && D.EXCLUDED_HULL_GROUPS.includes(c.hullGroup) && c.count > 0);
  const excluded = Array.isArray(params.massRuleExcludedGroups) ? params.massRuleExcludedGroups : [];
  if (comp.some((c) => c && excluded.includes(c.hullGroup) && c.count > 0)) return false;
  return capitalCountOf(comp) <= params.maxCapitalHulls;
}

function targetsOf(fleet, input, params, taken) {
  const reach = bfs([fleet.systemId], input.neighbors, { maxJumps: params.entryMaxJumps,
    maxSystems: params.maxBfsSystems });
  const best = new Map();
  let tooSoon = false;
  const need = fleetMassOf(fleet.composition, { capitals: massRuleOf(params), subcaps: subcapRuleOf(params) });
  let tooMassive = false;
  for (const edge of input.edges || []) {
    const ends = endsOf(input, edge);
    if (!ends || taken.has(ends.target)) continue;
    const dist = reach.get(ends.entry);
    if (dist === undefined) continue;
    const jumps = dist + 1;
    const etaMs = jumps * fleet.jumpMs;
    const expiresAt = Number.isSafeInteger(edge.expiresAt) ? edge.expiresAt : 0;
    const life = expiresAt === 0 ? Infinity : expiresAt - params.returnMarginMs - (input.at + etaMs);
    if (life < params.expeditionMinMs) {
      tooSoon = true;
      continue;
    }
    if (need > 0 && !(edge.maxJumpMass >= need)) {
      tooMassive = true;
      continue;
    }
    const c = { systemId: ends.target, entryPairKey: edge.pairKey, jumps, etaMs, life, expiresAt };
    const prev = best.get(c.systemId);
    if (!prev || c.jumps < prev.jumps || (c.jumps === prev.jumps && (c.life > prev.life
      || (c.life === prev.life && c.entryPairKey < prev.entryPairKey)))) best.set(c.systemId, c);
  }
  const list = [...best.values()].sort((a, b) => (a.jumps - b.jumps) || (a.life === b.life ? 0
    : (b.life > a.life ? 1 : -1)) || (a.systemId - b.systemId));
  return { list, tooSoon, tooMassive, need };
}

function planExpeditions(input, params) {
  const plans = [];
  const skips = {};
  const skip = (reason) => {
    skips[reason] = (skips[reason] || 0) + 1;
  };
  const taken = new Set(input.occupiedSystems || []);
  const maxMs = Math.max(params.expeditionMinMs, params.expeditionMaxMs);
  const factions = [...(input.factions || [])].sort((a, b) => a.factionId - b.factionId);
  for (const f of factions) {
    if (input.openTotal + plans.length >= params.maxActiveExpeditions || plans.length >= params.maxExpeditionsPerPlan) {
      skip("LIMIT");
      continue;
    }
    if (f.openCount >= params.maxActiveExpeditionsPerFaction) {
      skip("FACTION_LIMIT");
      continue;
    }
    const fleets = (f.fleets || []).filter((fl) => isFleetCandidate(fl, input, params))
      .sort((a, b) => byId(a.fleetId, b.fleetId));
    if (fleets.length === 0) {
      skip("NO_FLEET");
      continue;
    }
    let chosen = null;
    let tooSoon = false;
    let tooMassive = false;
    for (const fleet of fleets) {
      const t = targetsOf(fleet, input, params, taken);
      tooSoon = tooSoon || t.tooSoon;
      tooMassive = tooMassive || t.tooMassive;
      if (t.list.length === 0) continue;
      const seed = deriveSeed(input.worldSeed, SEED_KIND, `${f.factionId}:${input.round}`);
      const rng = createRng(seed);
      const pick = t.list[rng.nextUint32() % Math.min(Math.max(1, params.candidateTopN), t.list.length)];
      const durationMs = params.expeditionMinMs + Math.floor(rng.nextFloat() * (maxMs - params.expeditionMinMs + 1));
      const arrive = input.at + pick.etaMs;
      const cap = pick.expiresAt === 0 ? Infinity : pick.expiresAt - params.returnMarginMs;
      chosen = { factionId: f.factionId, fleetId: fleet.fleetId, fleetVersion: fleet.version,
        originSystemId: fleet.systemId, systemId: pick.systemId, entryPairKey: pick.entryPairKey, jumps: pick.jumps,
        seed, durationMs, evacuateAt: Math.min(arrive + durationMs, cap), etaMs: pick.etaMs, minJumpMass: t.need };
      break;
    }
    if (!chosen) {
      skip(tooSoon ? "EXPIRES_TOO_SOON" : (tooMassive ? "TOO_MASSIVE" : "NO_TARGET"));
      continue;
    }
    taken.add(chosen.systemId);
    plans.push(chosen);
  }
  return { plans, skips };
}

const end = (outcome, reason) => ({ action: "END", outcome, reason });

function cutOffTimesOf(exp, at, params) {
  const fresh = at + params.cutOffDecisionMs;
  const kept = exp && Number.isSafeInteger(exp.decisionAt);
  return { cutOffAt: kept && Number.isSafeInteger(exp.cutOffAt) ? Math.min(exp.cutOffAt, at) : at,
    decisionAt: kept ? Math.min(exp.decisionAt, fresh) : fresh };
}

const cutOffNextAt = (at, decisionAt, params) => Math.max(at, Math.min(at + params.cutOffRecheckMs, decisionAt));

function decideExpeditionStep(exp, fleet, facts, params) {
  if (!exp || exp.state === "ENDED" || !facts) return { action: "STALE" };
  if (facts.stepSeq !== undefined && facts.stepSeq !== exp.stepSeq) return { action: "STALE" };
  if (facts.round !== undefined && facts.round !== exp.watchRound) return { action: "STALE" };
  const at = facts.at;
  const gone = !fleet || fleet.state === "DESTROYED";
  if (gone) return end("LOST", "FLEET_LOST");
  const recheck = at + params.stepRecheckMs;
  const due = Number.isSafeInteger(fleet.nextActionAt) ? fleet.nextActionAt : 0;
  const waitFlying = { action: "WAIT", nextAt: Math.max(recheck, due) };
  const flying = FLYING.includes(fleet.state);
  if (flying) return waitFlying;
  const busy = BUSY.includes(fleet.state);
  const parked = PARKED.includes(fleet.state);
  const cutOff = (reason) => ({ action: "CUT_OFF", reason,
    nextAt: cutOffNextAt(at, cutOffTimesOf(exp, at, params).decisionAt, params), hold: parked });
  const pending = fleet.state === PENDING;
  const here = fleet.currentSystemId;
  const inJ = facts.isJSpace(here) === true;
  const route = facts.routeOut || null;
  const nextKeep = Math.min(at + params.stepIntervalMs, exp.evacuateAt);
  if (exp.state === "PLANNED") {
    if (pending) {
      if (fleet.operationId !== exp.operationId) return end("CANCELLED", "DIVERTED");
      if (exp.watchRound + 1 > params.maxWatchRounds) return end("CANCELLED", "TIMEOUT");
      return { action: "WAIT", nextAt: recheck };
    }
    if (inJ && here === exp.systemId && ACTIVATE_STATES.includes(fleet.state)) {
      return { action: "ACTIVATE", nextAt: nextKeep, presence: Math.min(PERMILLE, params.presenceGainPermille) };
    }
    if (inJ && parked) return route ? { action: "EVACUATE", reason: "HALTED" } : cutOff("HALTED");
    if (inJ && busy) return { action: "WAIT", nextAt: recheck };
    if (fleet.state === "STAGED" && fleet.operationId === exp.operationId) return end("CANCELLED", "CUT_BEFORE_ENTRY");
    return end("CANCELLED", "DIVERTED");
  }
  if (exp.state === "ACTIVE") {
    if (!inJ) return end("RETURNED", "LEFT");
    if (busy || pending) return { action: "WAIT", nextAt: recheck };
    if (!route) return cutOff("LINK_LOST");
    if (at >= exp.evacuateAt) return { action: "EVACUATE", reason: "DUE" };
    if (fleet.state === "IDLE" || here !== exp.systemId || fleet.operationId !== exp.operationId) {
      return { action: "EVACUATE", reason: "DISRUPTED" };
    }
    return { action: "KEEP", nextAt: nextKeep,
      presence: Math.min(PERMILLE, exp.presencePermille + params.presenceGainPermille) };
  }
  if (exp.state === "EVACUATING") {
    if (!inJ) return end("RETURNED", "RETURNED");
    if (parked) return route ? { action: "EVACUATE", reason: "HALTED" } : cutOff("HALTED");
    return { action: "WAIT", nextAt: recheck };
  }
  if (!inJ) return end("RETURNED", "RETURNED");
  const held = pending && typeof exp.holdOperationId === "string" && fleet.operationId === exp.holdOperationId;
  if ((parked || held) && route) return { action: "EVACUATE", reason: "RECOVERED", unhold: held };
  const decisionAt = Number.isSafeInteger(exp.decisionAt) ? exp.decisionAt : at;
  const decided = at >= decisionAt;
  const idleFree = fleet.state === "IDLE" && (fleet.operationId === null || fleet.operationId === undefined);
  if (decided && (held || idleFree)) {
    return { action: "WRITE_OFF", outcome: "LOST", reason: "WRITTEN_OFF", unhold: held };
  }
  if (parked && !held) return { action: "HOLD", nextAt: cutOffNextAt(at, decisionAt, params) };
  return { action: "WAIT", nextAt: decided ? at + params.cutOffRecheckMs : cutOffNextAt(at, decisionAt, params) };
}

module.exports = { planExpeditions, decideExpeditionStep, cutOffTimesOf, cutOffNextAt, capitalMassOf, capitalCountOf,
  fleetMassOf };
