"use strict";

const { usableKinds } = require("./targeting");
const { pickDefenders } = require("./relief");

const NO_SYSTEMS = new Set();
const DEFENSE_KIND = "defense";
const READY = "ready";
const OPEN_OPERATION_STATES = Object.freeze(["PLANNED", "ACTIVE"]);
const ATTACK_WINDOW_MS_KEY = "attackWindowMs";
const CLAIM_STATES = Object.freeze(["CONTESTED", "INVASION"]);
const INTRUDER_HOLD_STATES = Object.freeze(["IDLE", "STAGED"]);

function intrudersOf(snapshot, D) {
  const P = D.intruders;
  if (!P || !(P.maxPerReview > 0)) return null;
  const I = snapshot.intruders;
  if (!I || I.mode !== READY || !Array.isArray(I.items)) return null;
  return I;
}

function launchOf(snapshot, params, kind, T, chosen) {
  return {
    type: "LAUNCH",
    kind: kind.kind,
    target: { kind: "system", systemId: T, ref: null },
    originSystemId: chosen[0].systemId,
    fleets: chosen.map((f) => ({ fleetId: f.fleetId, expectedVersion: f.version })),
    mobilize: [],
    dueAt: snapshot.at + params[ATTACK_WINDOW_MS_KEY]
  };
}

function planDefense(snapshot, supply, params, opts) {
  const out = { intents: [], notes: [], fleetIds: [], targets: [] };
  const D = params.defense;
  if (!D || D.enabled !== true) return out;
  const claimsOn = D.maxPerReview > 0 && Boolean(snapshot.threats) && snapshot.threats.mode === READY;
  const intruders = intrudersOf(snapshot, D);
  if (!claimsOn && !intruders) return out;

  if (snapshot.operationsTruncated === true) {
    out.notes.push("DEFENSE_OPERATIONS_TRUNCATED");
    return out;
  }
  if (claimsOn && snapshot.threats.truncated === true) {
    out.notes.push("DEFENSE_TRUNCATED");
  }

  const kind = usableKinds(snapshot, params).find((k) => k.kind === DEFENSE_KIND);
  if (!kind) {
    if ((claimsOn && snapshot.threats.items && snapshot.threats.items.length > 0)
      || (intruders && intruders.items.length > 0)) {
      out.notes.push("DEFENSE_NO_KIND");
    }
    return out;
  }

  const covered = new Set(snapshot.operations.filter((op) => OPEN_OPERATION_STATES.includes(op.state)
    && op.operationType === kind.operationType).map((op) => op.targetSystemId));

  const reliefTargets = (opts && opts.targets) || new Set();
  const holders = (opts && opts.holders) || null;
  for (const t of reliefTargets) covered.add(t);

  const items = [...(claimsOn ? snapshot.threats.items || [] : [])].sort((a, b) => {
    const aIsInv = a.state === "INVASION";
    const bIsInv = b.state === "INVASION";
    if (aIsInv !== bIsInv) return aIsInv ? -1 : 1;
    const aDue = a.phaseDueAt ?? Number.MAX_SAFE_INTEGER;
    const bDue = b.phaseDueAt ?? Number.MAX_SAFE_INTEGER;
    if (aDue !== bDue) return aDue - bDue;
    return a.systemId - b.systemId;
  });

  let launched = 0;
  const used = new Set();
  for (const threat of items) {
    if (launched >= D.maxPerReview) break;
    const T = threat.systemId;
    if (covered.has(T)) continue;
    covered.add(T);

    const required = Math.max(1, Math.ceil((threat.occupierStrength || 0) * params.attackStrengthRatio));
    let sum = snapshot.fleets.filter((f) => f.state === "DEFENDING" && f.systemId === T)
      .reduce((n, f) => n + (f.strength || 0), 0);
    if (sum >= required) {
      out.notes.push(`DEFENSE_HELD:${T}`);
      out.targets.push(T);
      launched += 1;
      continue;
    }

    const { chosen, sum: added } = pickDefenders(snapshot, params, kind, T, required - sum, used, NO_SYSTEMS, holders);
    sum += added;

    if (sum < required || chosen.length === 0) {
      out.notes.push(`DEFENSE_INSUFFICIENT:${T}`);
      continue;
    }

    for (const f of chosen) used.add(f.fleetId);

    out.intents.push(launchOf(snapshot, params, kind, T, chosen));
    out.notes.push(`DEFENSE_LAUNCH:${T}`);
    out.targets.push(T);
    for (const f of chosen) out.fleetIds.push(f.fleetId);
    launched += 1;
  }

  if (intruders) planIntruders(snapshot, params, kind, intruders, { covered, used, holders, out });
  return out;
}

function planIntruders(snapshot, params, kind, intruders, ctx) {
  const { covered, used, holders, out } = ctx;
  const max = params.defense.intruders.maxPerReview;
  if (intruders.truncated === true) out.notes.push("DEFENSE_INTRUDER_TRUNCATED");
  const items = [...intruders.items].sort((a, b) => (b.hostileStrength || 0) - (a.hostileStrength || 0)
    || a.systemId - b.systemId);
  let launched = 0;
  for (const item of items) {
    if (launched >= max) break;
    const T = item.systemId;
    if (covered.has(T)) continue;
    covered.add(T);
    const required = Math.max(1, Math.ceil((item.hostileStrength || 0) * params.attackStrengthRatio));
    const inT = snapshot.fleets.filter((f) => INTRUDER_HOLD_STATES.includes(f.state) && f.systemId === T
      && kind.fleetRoles.includes(f.fleetRole));
    let sum = inT.reduce((n, f) => n + (f.strength || 0), 0);
    if (sum >= required) {
      for (const f of inT) used.add(f.fleetId);
      out.notes.push(`DEFENSE_INTRUDER_HELD:${T}`);
      out.targets.push(T);
      continue;
    }
    const { chosen, sum: added } = pickDefenders(snapshot, params, kind, T, required - sum, used, NO_SYSTEMS, holders);
    sum += added;
    if (sum < required || chosen.length === 0) {
      out.notes.push(`DEFENSE_INTRUDER_INSUFFICIENT:${T}`);
      continue;
    }
    for (const f of chosen) used.add(f.fleetId);
    out.intents.push(launchOf(snapshot, params, kind, T, chosen));
    out.notes.push(`DEFENSE_INTRUDER_LAUNCH:${T}`);
    out.targets.push(T);
    for (const f of chosen) out.fleetIds.push(f.fleetId);
    launched += 1;
  }
}

module.exports = { planDefense };
