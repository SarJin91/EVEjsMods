"use strict";

const { SHIP_STATE, SHIP_ROLE, landingPointOf } = require("./plan");

const FLEE_ROLES = Object.freeze([SHIP_ROLE.HAULER]);
const FLEE_STATES = Object.freeze([SHIP_STATE.SPAWNED, SHIP_STATE.RUNNING, SHIP_STATE.WARPING]);
const ALARM_STATES = Object.freeze([SHIP_STATE.SPAWNED, SHIP_STATE.RUNNING, SHIP_STATE.WARPING, SHIP_STATE.MINING,
  SHIP_STATE.IDLING, SHIP_STATE.DWELLING]);

const NONE = Object.freeze({ kind: "none" });
const HOLD = Object.freeze({ kind: "hold" });

function alarmOn(T) {
  return Boolean(T) && T.fleeAlarmEnabled === true;
}

function fleeStatesOf(T) {
  return alarmOn(T) ? ALARM_STATES : FLEE_STATES;
}

function canFlee(ship, T) {
  if (!ship) return false;
  if (alarmOn(T)) return typeof ship.role === "string" && ALARM_STATES.includes(ship.state);
  return FLEE_ROLES.includes(ship.role) && FLEE_STATES.includes(ship.state);
}

function isPoint(p) {
  return Boolean(p) && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function noteAggression(ship, seen, now, T) {
  if (!canFlee(ship, T)) return false;
  const at = Number(seen && seen.playerAggressedAt);
  if (!Number.isFinite(at) || at <= 0) return false;
  const prev = Number.isFinite(ship.aggressedSeenAt) ? ship.aggressedSeenAt : 0;
  if (!(at > prev)) return false;
  ship.aggressedSeenAt = at;
  ship.fleeUntil = now + T.fleeWindowMs;
  return true;
}

function fleeStepOf(ship, seen, now, T) {
  if (!canFlee(ship, T)) return NONE;
  if (!(Number.isFinite(ship.fleeUntil) && now < ship.fleeUntil)) return NONE;
  if (ship.fleeOrdered === true && ship.state === SHIP_STATE.WARPING) return NONE;
  if (!seen || seen.live !== true || !isPoint(seen.position)) return NONE;
  if (seen.inWarp === true) return HOLD;
  if (ship.state === SHIP_STATE.WARPING && isPoint(ship.targetPoint)
    && distance(seen.position, ship.targetPoint) <= T.arrivalMeters) return NONE;
  if (Number.isFinite(ship.fleeNextAt) && now < ship.fleeNextAt) return HOLD;
  const needTarget = !isPoint(ship.targetPoint) || distance(seen.position, ship.targetPoint) < T.fleeMinMeters;
  return { kind: "flee", needTarget };
}

function fleeTargetOf(from, nodes, current, T) {
  if (!isPoint(from)) return { ok: false, reason: "NO_TARGET" };
  const farEnough = (node) => Boolean(node) && isPoint(node.position)
    && distance(from, landingPointOf(from, node, T)) >= T.fleeMinMeters;
  const targetOf = (kind, node) => ({ kind, itemId: node.itemId, position: node.position, radius: node.radius });
  if (current && farEnough(current)) return { ok: true, target: targetOf(current.kind, current), keptRoute: true };
  const gates = nodes && Array.isArray(nodes.gates) ? nodes.gates : [];
  const stations = nodes && Array.isArray(nodes.stations) ? nodes.stations : [];
  const gate = gates.find(farEnough);
  if (gate) return { ok: true, target: targetOf("stargate", gate), keptRoute: false };
  const station = stations.find(farEnough);
  if (station) return { ok: true, target: targetOf("station", station), keptRoute: false };
  return { ok: false, reason: "NO_TARGET" };
}

function planAlarm(input) {
  const now = input && Number.isFinite(input.now) ? input.now : 0;
  const T = input && input.T;
  const budget = input && Number.isSafeInteger(input.budget) && input.budget > 0 ? input.budget : 0;
  const radius = T && Number.isFinite(T.fleeAlarmMeters) ? T.fleeAlarmMeters : 0;
  const victims = (input && Array.isArray(input.victims) ? input.victims : [])
    .filter((v) => v && isPoint(v.position));
  if (!alarmOn(T) || victims.length === 0) return { alarmed: [], cut: 0 };
  const victimIds = new Set(victims.map((v) => v.entityId));
  const near = [];
  for (const entry of input && Array.isArray(input.ships) ? input.ships : []) {
    const ship = entry && entry.ship;
    const seen = entry && entry.seen;
    if (!ship || victimIds.has(ship.entityId) || !canFlee(ship, T)) continue;
    if (!seen || seen.live !== true || !isPoint(seen.position)) continue;
    if (Number.isFinite(ship.fleeUntil) && ship.fleeUntil > now) continue;
    let best = Infinity;
    for (const v of victims) best = Math.min(best, distance(seen.position, v.position));
    if (best <= radius) near.push({ entityId: ship.entityId, d: best });
  }
  near.sort((a, b) => a.d - b.d || a.entityId - b.entityId);
  return { alarmed: near.slice(0, budget).map((n) => n.entityId).sort((a, b) => a - b),
    cut: Math.max(0, near.length - budget) };
}

module.exports = { FLEE_ROLES, FLEE_STATES, ALARM_STATES, canFlee, fleeStatesOf, noteAggression, fleeStepOf,
  fleeTargetOf, planAlarm };
