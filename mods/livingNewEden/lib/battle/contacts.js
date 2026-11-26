"use strict";

const { settlementRowBound } = require("./settlementPlan");
const { EVASIVE_ROLES } = require("./data/contactRules");

const NONE = (reason) => ({ ok: true, contact: null, reason });

const byId = (a, b) => (a.fleetId < b.fleetId ? -1 : a.fleetId > b.fleetId ? 1 : 0);
const pairKeyOf = (a, b) => (a < b ? `${a}:${b}` : `${b}:${a}`);

function strongest(ids, groups) {
  let best = null;
  for (const id of ids) {
    const g = groups.get(id);
    if (best === null || g.strength > best.strength || (g.strength === best.strength && id < best.factionId)) best = g;
  }
  return best;
}

const shipsOf = (f) => (Number.isSafeInteger(f.shipCount) ? f.shipCount
  : (f.composition || []).reduce((n, e) => n + e.count, 0));

function planContact(spec) {
  const { fleets, isHostile, at, limits } = spec;
  const cooldowns = spec.cooldowns instanceof Map ? spec.cooldowns : new Map();
  const trigger = typeof spec.triggerFleetId === "string" ? spec.triggerFleetId : null;
  const evasiveOf = typeof spec.evasiveOf === "function" ? spec.evasiveOf : (f) => EVASIVE_ROLES.includes(f.fleetRole);
  const groups = new Map();
  for (const f of fleets || []) {
    let g = groups.get(f.factionId);
    if (!g) {
      g = { factionId: f.factionId, strength: 0, fleets: [], allEvasive: true };
      groups.set(f.factionId, g);
    }
    g.strength += shipsOf(f);
    g.fleets.push(f);
    if (!evasiveOf(f)) g.allEvasive = false;
  }
  const factions = [...groups.keys()].sort((a, b) => a - b);
  const partners = new Map();
  let hostilePairs = 0;
  for (let i = 0; i < factions.length; i += 1) {
    for (let j = i + 1; j < factions.length; j += 1) {
      const a = factions[i];
      const b = factions[j];
      if (!isHostile(a, b)) continue;
      const aEvasive = groups.get(a).allEvasive;
      const bEvasive = groups.get(b).allEvasive;
      if (aEvasive || bEvasive) continue;
      hostilePairs += 1;
      const until = cooldowns.get(pairKeyOf(a, b));
      if (until !== undefined && until > at) continue;
      if (!partners.has(a)) partners.set(a, []);
      if (!partners.has(b)) partners.set(b, []);
      partners.get(a).push(b);
      partners.get(b).push(a);
    }
  }
  if (hostilePairs === 0) return NONE("NO_HOSTILES");
  if (partners.size === 0) return NONE("ON_COOLDOWN");

  const triggerFleet = trigger === null ? null : (fleets || []).find((f) => f.fleetId === trigger) || null;
  const triggerGroup = triggerFleet ? groups.get(triggerFleet.factionId) : null;
  const triggerOnA = triggerGroup && !triggerGroup.allEvasive && partners.has(triggerFleet.factionId) ? trigger : null;
  const aGroup = triggerOnA ? groups.get(triggerFleet.factionId)
    : strongest([...partners.keys()].filter((fid) => !groups.get(fid).allEvasive), groups);
  const bGroup = strongest(partners.get(aGroup.factionId), groups);

  const ordered = (g, first) => {
    const list = [...g.fleets].sort(byId);
    if (first === null) return list;
    const i = list.findIndex((f) => f.fleetId === first);
    if (i > 0) list.unshift(...list.splice(i, 1));
    return list;
  };
  const allA = ordered(aGroup, triggerOnA);
  const allB = ordered(bGroup, null);
  const A = allA.slice(0, limits.maxFleetsPerSide);
  const B = allB.slice(0, limits.maxFleetsPerSide);
  const boundOf = () => settlementRowBound({ sideA: { fleets: A }, sideB: { fleets: B } });
  let rowBound = boundOf();
  while (rowBound > limits.maxSettlementRows) {
    if (A.length <= 1 && B.length <= 1) return NONE("TOO_LARGE");
    if (A.length > B.length) A.pop();
    else B.pop();
    rowBound = boundOf();
  }
  let objectiveFleetId = null;
  if (triggerOnA !== null && A.some((f) => f.fleetId === triggerOnA)) objectiveFleetId = triggerOnA;
  else {
    const withOp = A.find((f) => f.operationId !== null && f.operationId !== undefined);
    objectiveFleetId = withOp ? withOp.fleetId : null;
  }
  const side = (g, list) => ({ factionId: g.factionId,
    fleets: list.map((f) => ({ fleetId: f.fleetId, expectedVersion: f.version })) });
  return { ok: true, contact: { sideA: side(aGroup, A), sideB: side(bGroup, B), objectiveFleetId, rowBound,
    truncated: (allA.length - A.length) + (allB.length - B.length) } };
}

module.exports = { planContact, pairKeyOf };
