"use strict";

const { bfs } = require("./bfs");
const { usableKinds } = require("./targeting");

const IDLE = "IDLE";
const DEFENSE_KIND = "defense";
const READY = "ready";
const DEFENDING = "DEFENDING";
const OPEN_OPERATION_STATES = Object.freeze(["PLANNED", "ACTIVE"]);
const TIMER_STATES = Object.freeze(["ARMOR_TIMER", "HULL_TIMER"]);

const byStation = (a, b) => a.phaseEndsAt - b.phaseEndsAt
  || (a.stationId < b.stationId ? -1 : a.stationId > b.stationId ? 1 : 0);

function byCandidate(distT, holders) {
  const held = (f) => (holders && holders.has(f.fleetId) ? 1 : 0);
  return (a, b) => held(a) - held(b) || distT.get(a.systemId) - distT.get(b.systemId)
    || (a.fleetId < b.fleetId ? -1 : 1);
}

function heldStrength(snapshot, systemId) {
  return snapshot.fleets.filter((f) => f.state === DEFENDING && f.systemId === systemId)
    .reduce((n, f) => n + (f.strength || 0), 0);
}

function greedy(ordered, required, maxFleets) {
  const chosen = [];
  let sum = 0;
  for (const f of ordered) {
    if (sum >= required || chosen.length >= maxFleets) break;
    chosen.push(f);
    sum += f.strength || 0;
  }
  return { chosen, sum };
}

function pickDefenders(snapshot, params, kind, systemId, required, used, excludedSystems, holders) {
  const distT = bfs([systemId], snapshot.neighbors, { maxJumps: params.maxAssemblyJumps, maxSystems: params.maxBfsSystems });
  const avail = snapshot.fleets.filter((f) => f.state === IDLE && f.refitPending !== true && f.systemId !== systemId
    && !excludedSystems.has(f.systemId) && kind.fleetRoles.includes(f.fleetRole) && distT.has(f.systemId)
    && !used.has(f.fleetId));
  const first = greedy([...avail].sort(byCandidate(distT, holders)), required, params.maxFleetsPerOperation);
  if (first.sum >= required || !holders || !avail.some((f) => holders.has(f.fleetId))) return first;
  const second = greedy(avail.sort(byCandidate(distT, null)), required, params.maxFleetsPerOperation);
  return second.sum >= required ? second : first;
}

function planRelief(snapshot, supply, params, opts) {
  const holders = (opts && opts.holders) || null;
  const out = { intents: [], notes: [], fleetIds: [] };
  const P = params.siege;
  const siege = snapshot.siege;
  if (!P || P.reliefEnabled !== true || !(P.maxReliefPerReview > 0)) return out;
  if (!siege || siege.mode !== READY || !Array.isArray(siege.defending) || siege.defending.length === 0) return out;
  if (snapshot.operationsTruncated === true) {
    out.notes.push("RELIEF_OPERATIONS_TRUNCATED");
    return out;
  }
  const kind = usableKinds(snapshot, params).find((k) => k.kind === DEFENSE_KIND);
  if (!kind) {
    out.notes.push("RELIEF_NO_KIND");
    return out;
  }
  if (siege.truncated === true) out.notes.push("RELIEF_TRUNCATED");
  const covered = new Set(snapshot.operations.filter((op) => OPEN_OPERATION_STATES.includes(op.state)
    && op.operationType === kind.operationType).map((op) => op.targetSystemId));
  const defended = new Set(siege.defending.map((d) => d.systemId));
  const used = new Set();
  for (const d of [...siege.defending].sort(byStation)) {
    if (out.intents.length >= P.maxReliefPerReview) break;
    const T = d.systemId;
    if (covered.has(T)) continue;
    if (TIMER_STATES.includes(d.state) && d.phaseEndsAt - snapshot.at > P.reliefLeadMs) continue;
    covered.add(T);
    const required = Math.max(1, Math.ceil((d.attackerStrength || 0) * params.attackStrengthRatio));
    let sum = heldStrength(snapshot, T);
    if (sum >= required) continue;
    const { chosen, sum: added } = pickDefenders(snapshot, params, kind, T, required - sum, used, defended,
      holders);
    sum += added;
    if (sum < required || chosen.length === 0) {
      out.notes.push("RELIEF_INSUFFICIENT");
      continue;
    }
    for (const f of chosen) used.add(f.fleetId);
    out.intents.push({ type: "LAUNCH", kind: kind.kind, target: { kind: "system", systemId: T, ref: null },
      originSystemId: chosen[0].systemId,
      fleets: chosen.map((f) => ({ fleetId: f.fleetId, expectedVersion: f.version })), mobilize: [],
      dueAt: Math.max(snapshot.at + params.attackWindowMs, d.phaseEndsAt + P.reliefHoldMs) });
  }
  out.fleetIds = [...used];
  return out;
}

module.exports = { planRelief, DEFENDING, pickDefenders, heldStrength, byCandidate };
