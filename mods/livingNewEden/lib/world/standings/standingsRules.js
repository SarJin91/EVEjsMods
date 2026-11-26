"use strict";

const S = require("./schema");
const { CLAIM_STATES } = require("../occupation/schema");

const isId = S.isId;
const NAVY_ATTACK = "ATTACK";
const NAVY_KILL = "KILL";

function classifySystem(sys, pirateIds) {
  const controller = sys ? sys.controllerFactionId : null;
  const occupier = sys ? sys.occupierFactionId : null;
  if (isId(controller) && pirateIds.has(controller)) return { ok: true, basis: S.BASIS.PIRATE_HELD };
  if (sys && CLAIM_STATES.includes(sys.occupationState)
    && ((isId(controller) && pirateIds.has(controller)) || (isId(occupier) && pirateIds.has(occupier)))) {
    return { ok: true, basis: S.BASIS.CONTESTED };
  }
  return { ok: false, reason: "NOT_PIRATE_SYSTEM" };
}

function eligible(factionId, pirateIds, data) {
  return isId(factionId) && !pirateIds.has(factionId) && data.eligibleBeneficiaries.includes(factionId);
}

function resolveBeneficiary(kill, sys, vertex, pirateIds, data) {
  if (sys && CLAIM_STATES.includes(sys.occupationState)) {
    for (const party of [sys.controllerFactionId, sys.occupierFactionId]) {
      if (eligible(party, pirateIds, data)) return { ok: true, factionId: party, source: S.SOURCE.FIGHTER };
    }
  }
  if (vertex && isId(vertex.regionId)) {
    const override = data.beneficiaryByRegion[vertex.regionId];
    if (eligible(override, pirateIds, data)) return { ok: true, factionId: override, source: S.SOURCE.REGION };
  }
  if (vertex && eligible(vertex.factionId, pirateIds, data)) {
    return { ok: true, factionId: vertex.factionId, source: S.SOURCE.SDE_SYSTEM };
  }
  const rival = data.rivalByPirate[kill.victimFactionId];
  if (eligible(rival, pirateIds, data)) return { ok: true, factionId: rival, source: S.SOURCE.RIVAL };
  return { ok: false, reason: "NO_BENEFICIARY" };
}

function planGrant(kill, sys, vertex, ctx) {
  if (!kill || !isId(kill.characterId) || !isId(kill.victimFactionId) || !isId(kill.systemId)
    || !S.isTime(kill.atMs)) {
    return { ok: false, reason: "KILL_INVALID_INPUT" };
  }
  if (!ctx.pirateIds.has(kill.victimFactionId)) return { ok: false, reason: "NOT_PIRATE" };
  if (!sys) return { ok: false, reason: "NO_ROW" };
  const cls = classifySystem(sys, ctx.pirateIds);
  if (!cls.ok) return cls;
  const who = resolveBeneficiary(kill, sys, vertex, ctx.pirateIds, ctx.data);
  if (!who.ok) return who;
  const day = S.dayOf(kill.atMs);
  const window = S.windowOf(kill.atMs, ctx.params.debounceWindowMs);
  const g = { characterId: kill.characterId, day, factionId: who.factionId, systemId: kill.systemId, window,
    atMs: kill.atMs, victimId: kill.victimId };
  return { ok: true, factionId: who.factionId, basis: cls.basis, source: who.source, day, window, key: S.grantKey(g),
    legacyKey: S.legacyGrantKey(g), rawChange: ctx.params.rawChangePerGrant };
}

function planPirateGrant(kill, sys, vertex, ctx) {
  if (!kill || !isId(kill.characterId) || !isId(kill.victimFactionId) || !isId(kill.systemId)
    || !S.isTime(kill.atMs)) {
    return { ok: false, reason: "KILL_INVALID_INPUT" };
  }
  const pirates = ctx.pirateIds;
  if (pirates.has(kill.victimFactionId)) return { ok: false, reason: "VICTIM_PIRATE" };
  if (!ctx.data.eligibleBeneficiaries.includes(kill.victimFactionId)) return { ok: false, reason: "NOT_ANTI_PIRATE" };
  if (!sys) return { ok: false, reason: "NO_ROW" };
  const isPirate = (f) => isId(f) && pirates.has(f);
  let factionId = null;
  let source = null;
  if (isPirate(sys.controllerFactionId)) {
    factionId = sys.controllerFactionId;
    source = S.SOURCE.FIGHTER;
  } else if (CLAIM_STATES.includes(sys.occupationState) && isPirate(sys.occupierFactionId)) {
    factionId = sys.occupierFactionId;
    source = S.SOURCE.FIGHTER;
  } else if (vertex && isPirate(vertex.factionId)) {
    factionId = vertex.factionId;
    source = S.SOURCE.SDE_SYSTEM;
  } else {
    return { ok: false, reason: "NO_PIRATE_BENEFICIARY" };
  }
  const day = S.dayOf(kill.atMs);
  const window = S.windowOf(kill.atMs, ctx.params.debounceWindowMs);
  const key = S.grantKey({ characterId: kill.characterId, day, factionId, systemId: kill.systemId, window,
    atMs: kill.atMs, victimId: kill.victimId });
  return { ok: true, factionId, basis: S.BASIS.PIRATE_SIDE, source, day, window, key, legacyKey: null,
    rawChange: ctx.params.pirateSideRawChangePerGrant };
}

function planNavyPenalty(p, params) {
  if (!p || !isId(p.characterId) || !isId(p.factionId) || !isId(p.systemId) || !S.isTime(p.atMs)) {
    return { ok: false, reason: "PENALTY_INVALID_INPUT" };
  }
  const day = S.dayOf(p.atMs);
  const g = { characterId: p.characterId, day, factionId: p.factionId, systemId: p.systemId };
  if (p.kind === NAVY_ATTACK) {
    const window = Math.floor(p.atMs / params.navyAttackWindowMs);
    return { ok: true, key: S.navyAttackKey({ ...g, window }), day, window, rawChange: -params.navyAttackRaw };
  }
  if (p.kind !== NAVY_KILL) return { ok: false, reason: "PENALTY_INVALID_INPUT" };
  return { ok: true, key: S.grantKey({ ...g, window: null, atMs: p.atMs, victimId: p.victimId }), day, window: null,
    rawChange: -params.navyKillRaw };
}

function planConvoyPenalty(p, params) {
  if (!p || !isId(p.characterId) || !isId(p.factionId) || !isId(p.systemId) || !S.isTime(p.atMs)) {
    return { ok: false, reason: "PENALTY_INVALID_INPUT" };
  }
  const day = S.dayOf(p.atMs);
  const g = { characterId: p.characterId, day, factionId: p.factionId, systemId: p.systemId };
  if (p.kind === NAVY_ATTACK) {
    const window = Math.floor(p.atMs / params.navyAttackWindowMs);
    return { ok: true, key: S.convoyAttackKey({ ...g, window }), day, window, rawChange: -params.convoyAttackRaw };
  }
  if (p.kind !== NAVY_KILL) return { ok: false, reason: "PENALTY_INVALID_INPUT" };
  return { ok: true, key: S.convoyKillKey({ ...g, atMs: p.atMs, victimId: p.victimId }), day, window: null,
    rawChange: -params.convoyKillRaw };
}

function planPirateKillCharge(kill, params) {
  if (!kill || !isId(kill.characterId) || !isId(kill.victimFactionId) || !isId(kill.systemId) || !S.isTime(kill.atMs)
    || !(params.pirateKillChargeRaw > 0)) {
    return { ok: false, reason: "PENALTY_INVALID_INPUT" };
  }
  const day = S.dayOf(kill.atMs);
  return { ok: true, key: S.pirateKillKey({ characterId: kill.characterId, day, factionId: kill.victimFactionId,
    systemId: kill.systemId, atMs: kill.atMs, victimId: kill.victimId }), day, window: null,
  rawChange: -params.pirateKillChargeRaw };
}

function validateData(data, pirateIds) {
  const bad = (detail) => ({ ok: false, reason: "STANDINGS_DATA_INVALID", detail });
  if (!data || typeof data !== "object") return bad("data");
  if (!Array.isArray(data.eligibleBeneficiaries) || data.eligibleBeneficiaries.length === 0) return bad("eligible");
  for (const f of data.eligibleBeneficiaries) {
    if (!isId(f)) return bad(`eligible ${f}`);
    if (pirateIds.has(f)) return bad(`eligible ${f} is a pirate`);
  }
  for (const [name, table] of [["beneficiaryByRegion", data.beneficiaryByRegion], ["rivalByPirate",
    data.rivalByPirate]]) {
    if (!table || typeof table !== "object") return bad(name);
    for (const [k, v] of Object.entries(table)) {
      if (!isId(Number(k))) return bad(`${name} key ${k}`);
      if (!data.eligibleBeneficiaries.includes(v)) return bad(`${name} ${k} -> ${v} not eligible`);
    }
  }
  if (!isId(data.eventTypeId)) return bad("eventTypeId");
  if (!isId(data.navyEventTypeId)) return bad("navyEventTypeId");
  for (const reason of [S.REASON, S.REASON_NAVY, S.REASON_PIRATE_SIDE, S.REASON_CONVOY, S.REASON_PIRATE_KILL]) {
    const msg = data.msgByReason && data.msgByReason[reason];
    if (typeof msg !== "string" || msg === "") return bad(`msgByReason ${reason}`);
  }
  return { ok: true };
}

module.exports = { classifySystem, resolveBeneficiary, planGrant, planPirateGrant, planNavyPenalty,
  planConvoyPenalty, planPirateKillCharge, validateData, NAVY_ATTACK, NAVY_KILL };
