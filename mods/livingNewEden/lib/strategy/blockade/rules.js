"use strict";

const { deriveSeed, createRng } = require("../../util/rng");
const { hasWormholeEdges } = require("../../fleets/travel");
const { crossingOf } = require("../../fleets/crossing");
const { preparedCatchOf, GATE } = require("../../fleets/grid/transit");

const BLOCKADE_OPERATION_TYPE = "blockade";
const OPEN_STATES = Object.freeze(["PLANNED", "ACTIVE"]);
const SEED_KIND = "blockade-intercept";
const PERMILLE = 1000;
const STALE_REASONS = Object.freeze(["OP_NOT_OPEN", "POST_AWAY", "TARGET_GONE", "LEG_MOVED", "LEG_HAS_WORMHOLES",
  "NOT_CROSSING", "NOT_HOSTILE", "TYPE_EXCLUDED", "ON_COOLDOWN"]);
const GATE_STALE_REASONS = Object.freeze(["GATE_AWAY"]);

const cmpText = (a, b) => (a < b ? -1 : (a > b ? 1 : 0));

function crossingsOfLeg(leg, blockadesAt, isHostile, o) {
  const out = [];
  if (!leg || !Array.isArray(leg.systems) || leg.systems.length < 3) return { crossings: out, truncated: false };
  const inner = leg.systems.length - 2;
  const last = Math.min(inner, o.maxSystems);
  for (let i = 1; i <= last; i += 1) {
    const from = leg.departAt + i * leg.jumpMs;
    for (const b of blockadesAt(leg.systems[i]) || []) {
      if (!b || !Number.isSafeInteger(b.dueAt) || !(b.dueAt > from)) continue;
      if (isHostile(b.factionId, o.factionId) !== true) continue;
      out.push({ operationId: b.operationId, systemIndex: i, at: from });
    }
  }
  out.sort((a, b) => (a.at - b.at) || cmpText(a.operationId, b.operationId));
  return { crossings: out.slice(0, Math.max(0, o.maxCrossings)), truncated: inner > o.maxSystems };
}

function decideIntercept(facts, params) {
  const { p, operation: op, target } = facts;
  const stale = (reason) => ({ action: "STALE", reason });
  if (!op || op.operationType !== BLOCKADE_OPERATION_TYPE || !OPEN_STATES.includes(op.state)
    || !Number.isSafeInteger(op.dueAt) || !(p.at < op.dueAt)) return stale("OP_NOT_OPEN");
  const posted = (facts.postFleets || []).some((f) => f && f.state === "STAGED"
    && f.currentSystemId === op.targetSystemId && f.operationId === op.operationId);
  if (!posted) return stale("POST_AWAY");
  if (!target || target.state === "DESTROYED") return stale("TARGET_GONE");
  if (target.state !== "TRAVELLING" || target.legSeq !== p.legSeq) return stale("LEG_MOVED");
  if (target.route && hasWormholeEdges(target.route)) return stale("LEG_HAS_WORMHOLES");
  const x = crossingOf(target, op.targetSystemId);
  if (!x || x.i !== p.systemIndex || p.at < x.from || p.at >= x.from + x.jumpMs) return stale("NOT_CROSSING");
  if (facts.hostile !== true) return stale("NOT_HOSTILE");
  if (!(params.interceptOperationTypes || []).includes(facts.targetOperationType)) return stale("TYPE_EXCLUDED");
  if (Number.isFinite(facts.cooldownUntil) && facts.cooldownUntil > p.at) return stale("ON_COOLDOWN");
  let g = null;
  if (facts.gate && typeof facts.gate === "object") {
    const c = preparedCatchOf({ ...facts.gate, at: p.at, onlyOut: p.gate === GATE.OUT });
    if (c.ok) g = c;
    else if (c.reason !== "NO_GATE") return stale("GATE_AWAY");
    if (g && g.gate === GATE.OUT && p.gate !== GATE.OUT) return { action: "DEFER", catchAt: g.catchAt, anchor: g.anchor };
  }
  const roll = createRng(deriveSeed(facts.worldSeed, SEED_KIND, `${p.operationId}:${p.fleetId}:${p.legSeq}`))
    .nextFloat();
  const action = roll * PERMILLE >= params.interceptChancePermille ? "ESCAPED" : "INTERCEPT";
  return g ? { action, roll, gate: g.gate, anchor: g.anchor } : { action, roll };
}

const MODE = Object.freeze({ CROSSING: "x", POST: "p" });
const ARRIVING_STATES = Object.freeze(["PLANNED", "TRAVELLING"]);
const KIND_ANCHOR = "anchor";
const PURPOSE_POST = "POST";
const POSITION_STALE_REASONS = Object.freeze(["OP_NOT_OPEN", "LEG_MOVED", "NO_GATE", "POST_AWAY", "CLAIMED",
  "ROUNDS"]);

function claimOf(f) {
  let best = null;
  for (const x of f.posted) {
    const v = x.visit;
    if (!v || v.purpose !== PURPOSE_POST || typeof v.targetFleetId !== "string") continue;
    if (f.p.mode === MODE.CROSSING && v.targetFleetId === f.p.fleetId) continue;
    const c = f.claims instanceof Map ? f.claims.get(v.targetFleetId) : null;
    if (!c || !(c.until > f.p.at)) continue;
    if (!best || c.from < best.from || (c.from === best.from && v.targetFleetId < best.fleetId)) {
      best = { fleetId: v.targetFleetId, from: c.from, until: c.until };
    }
  }
  return best;
}

function decidePosition(f, params) {
  const { p, operation: op } = f;
  const stale = (reason) => ({ action: "STALE", reason });
  const recheck = (why, at) => (p.round + 1 >= params.maxRounds ? stale("ROUNDS") : { action: "RECHECK", why, at });
  if (!op || op.operationType !== BLOCKADE_OPERATION_TYPE || !OPEN_STATES.includes(op.state)
    || !Number.isSafeInteger(op.dueAt) || !(p.at < op.dueAt)) return stale("OP_NOT_OPEN");
  const crossing = p.mode === MODE.CROSSING ? f.crossing : null;
  if (p.mode === MODE.CROSSING && (!crossing || p.at >= crossing.until)) return stale("LEG_MOVED");
  if (!f.target) return stale("NO_GATE");
  const posted = Array.isArray(f.posted) ? f.posted : [];
  if (posted.length === 0) {
    const next = f.nextArrivalAt;
    if (Number.isSafeInteger(next) && (p.mode === MODE.POST || next < crossing.from)) {
      return recheck("WAIT", Math.max(p.at, next) + 1);
    }
    return stale("POST_AWAY");
  }
  const inTarget = (x) => x.position && x.position.kind === KIND_ANCHOR && x.position.gridKey === f.target.gridKey;
  if (posted.every(inTarget)) return { action: "IN_PLACE" };
  const claim = claimOf({ ...f, posted });
  let preempted = false;
  if (claim) {
    if (p.mode === MODE.POST) return stale("CLAIMED");
    if (claim.from < crossing.from) {
      return claim.until < crossing.until ? recheck("HELD", claim.until) : stale("CLAIMED");
    }
    preempted = true;
  }
  const warping = posted.filter((x) => !x.position || x.position.kind !== KIND_ANCHOR);
  if (warping.length > 0) {
    const arrive = warping.map((x) => (x.visit && Number.isSafeInteger(x.visit.arriveAt) ? x.visit.arriveAt : p.at));
    return recheck("IN_WARP", Math.max(p.at, ...arrive) + 1);
  }
  const members = [...posted].sort((a, b) => cmpText(a.fleetId, b.fleetId)).map((x) => ({ fleetId: x.fleetId,
    legSeq: x.legSeq, expectedMoveSeq: x.visit ? x.visit.moveSeq : 0 }));
  return { action: "MOVE", members, preempted };
}

function nextArrivalOf(members, systemId) {
  let best = null;
  for (const m of members || []) {
    if (!m || !ARRIVING_STATES.includes(m.state) || m.targetSystemId !== systemId) continue;
    if (Number.isSafeInteger(m.nextActionAt) && (best === null || m.nextActionAt < best)) best = m.nextActionAt;
  }
  return best;
}

module.exports = { crossingsOfLeg, decideIntercept, decidePosition, nextArrivalOf, BLOCKADE_OPERATION_TYPE,
  STALE_REASONS, GATE_STALE_REASONS, POSITION_STALE_REASONS, MODE };
