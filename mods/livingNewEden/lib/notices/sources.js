"use strict";

const OCC = require("../world/occupation/schema");
const SIEGE = require("../stations/siege/schema");
const PSIEGE = require("../stations/playerSiege/schema");
const HEV = require("../heavyEvents/schema");
const HRAID = require("../stations/harvestRaid/schema");

const WORLD_AGGREGATE = "world_system";
const KIND = Object.freeze({
  ATTACK_STARTED: "ATTACK_STARTED",
  SYSTEM_CAPTURED: "SYSTEM_CAPTURED",
  SYSTEM_RELEASED: "SYSTEM_RELEASED",
  ATTACK_REPELLED: "ATTACK_REPELLED",
  SIEGE_STARTED: "SIEGE_STARTED",
  SIEGE_ENDED: "SIEGE_ENDED",
  PLAYER_IMPACT: "PLAYER_IMPACT",
  STRUCTURE_SIEGE_STARTED: "STRUCTURE_SIEGE_STARTED",
  STRUCTURE_SIEGE_ENDED: "STRUCTURE_SIEGE_ENDED",
  PLAYER_SOV_SIEGE: "PLAYER_SOV_SIEGE",
  PLAYER_SOV_REINFORCED: "PLAYER_SOV_REINFORCED",
  PLAYER_SOV_LOST: "PLAYER_SOV_LOST",
  HEAVY_EVENT_STARTED: "HEAVY_EVENT_STARTED",
  HARVEST_RAID_WARNED: "HARVEST_RAID_WARNED",
  HARVEST_RAID_ENDED: "HARVEST_RAID_ENDED",
  NATIVE_INCURSION_STARTED: "NATIVE_INCURSION_STARTED",
  NATIVE_INCURSION_ENDED: "NATIVE_INCURSION_ENDED",
});
const KINDS = Object.freeze(Object.values(KIND));
const PLAYER_SOV_AGGREGATE = "player_sov";
const PLAYER_SOV_EVENT_KIND = Object.freeze({ PLAYER_SOV_SIEGED: KIND.PLAYER_SOV_SIEGE,
  PLAYER_SOV_REINFORCED: KIND.PLAYER_SOV_REINFORCED, PLAYER_SOV_LOST: KIND.PLAYER_SOV_LOST });
const AGGREGATE_TYPES = Object.freeze([WORLD_AGGREGATE, SIEGE.SIEGE_AGGREGATE, PSIEGE.AGGREGATE,
  PLAYER_SOV_AGGREGATE, HEV.AGGREGATE, HRAID.AGGREGATE]);
const NATIVE_AGGREGATE = "native_incursion";
const NATIVE_EVENT_BIND = "NATIVE_INCURSION_BIND";
const NATIVE_EVENT_SETTLE = "NATIVE_INCURSION_SETTLE";
const NATIVE_FACTION_ID = 500019;
const NATIVE_END_OUTCOMES = Object.freeze(["defeated", "expired"]);
const nativeNoticeKeyOf = (taleId, state) => `nincursion:notice:${taleId}:${state}`;
const LIBERATION_KILL = "LIBERATION_KILL";
const LIBKILL_RE = /^libkill:(\d+):(\d+):/;
const MS_PER_HOUR = 3600000;
const REPEL_FROM = Object.freeze([OCC.CONTESTED, OCC.INVASION]);

function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined;
}

function idOrNull(v) {
  return Number.isSafeInteger(v) && v > 0 ? v : null;
}

const rowKeyOf = (journalId, kind) => `j:${journalId}:${kind}`;
const impactKeyOf = (systemId, characterId, at) => `imp:${systemId}:${characterId}:${Math.floor(at / MS_PER_HOUR)}`;

function classifyEntries(entries, marks, ctx) {
  const delta = new Map();
  const events = [];
  const skipped = {};
  const skip = (reason) => {
    skipped[reason] = (skipped[reason] || 0) + 1;
  };
  const markOf = (id) => (delta.has(id) ? delta.get(id) : (marks.has(id) ? marks.get(id) : null));
  const kinds = ctx.kinds;
  const sieges = ctx.sieges || new Map();

  function emit(entry, event) {
    if (!kinds.has(event.kind)) {
      skip("KIND_OFF");
      return;
    }
    if (ctx.now - entry.createdAt > ctx.maxEventAgeMs) {
      skip("STALE");
      return;
    }
    events.push(Object.freeze({ at: entry.createdAt, journalId: entry.journalId, attacker: null, defender: null,
      ...event }));
  }

  function worldRow(entry) {
    const p = entry.payload;
    const systemId = p && idOrNull(p.systemId);
    if (systemId === null) {
      skip("BAD_PAYLOAD");
      return;
    }
    const state = p.state && typeof p.state === "object" ? p.state : {};
    const mark = markOf(systemId);
    const occupierTo = has(state, "occupierFactionId") ? state.occupierFactionId : (mark ? mark.occupier : null);
    if (p.create === true || mark === null) {
      delta.set(systemId, Object.freeze({ state: has(state, "occupationState") ? state.occupationState : null,
        controller: has(state, "controllerFactionId") ? state.controllerFactionId : null, occupier: occupierTo }));
      return;
    }
    const from = mark.state;
    const cFrom = mark.controller;
    const to = has(state, "occupationState") ? state.occupationState : from;
    const cTo = has(state, "controllerFactionId") ? state.controllerFactionId : cFrom;
    const key = (kind) => rowKeyOf(entry.journalId, kind);
    let event = null;
    if (to !== from && to === OCC.OCCUPIED) {
      const prev = has(state, "previousControllerFactionId") ? state.previousControllerFactionId : null;
      event = { eventKey: key(KIND.SYSTEM_CAPTURED), kind: KIND.SYSTEM_CAPTURED, systemId, attacker: cTo,
        defender: prev ?? cFrom };
    } else if (to !== from && to === OCC.INVASION) {
      event = { eventKey: key(KIND.ATTACK_STARTED), kind: KIND.ATTACK_STARTED, systemId,
        attacker: has(state, "occupierFactionId") ? state.occupierFactionId : (mark.occupier ?? null), defender: cFrom };
    } else if (cFrom !== null && cTo === null) {
      event = { eventKey: key(KIND.SYSTEM_RELEASED), kind: KIND.SYSTEM_RELEASED, systemId, defender: cFrom };
    } else if (REPEL_FROM.includes(from) && to === OCC.STABLE && cTo === cFrom) {
      event = { eventKey: key(KIND.ATTACK_REPELLED), kind: KIND.ATTACK_REPELLED, systemId, defender: cTo,
        attacker: mark.occupier ?? null };
    }
    delta.set(systemId, Object.freeze({ state: to, controller: cTo, occupier: occupierTo }));
    if (event) emit(entry, event);
    if (entry.eventType === LIBERATION_KILL && typeof entry.key === "string") {
      const m = LIBKILL_RE.exec(entry.key);
      const characterId = m ? idOrNull(Number(m[2])) : null;
      if (characterId === null || Number(m[1]) !== systemId) {
        skip("BAD_PAYLOAD");
        return;
      }
      emit(entry, { eventKey: impactKeyOf(systemId, characterId, entry.createdAt), kind: KIND.PLAYER_IMPACT, systemId,
        defender: cFrom, characterId });
    }
  }

  function siegeRow(entry) {
    const p = entry.payload || {};
    if (entry.eventType === SIEGE.EVENT_SIEGE_STARTED) {
      const systemId = idOrNull(p.systemId);
      if (systemId === null) {
        skip("BAD_PAYLOAD");
        return;
      }
      emit(entry, { eventKey: rowKeyOf(entry.journalId, KIND.SIEGE_STARTED), kind: KIND.SIEGE_STARTED, systemId,
        attacker: idOrNull(p.attackerFactionId), defender: idOrNull(p.ownerFactionId) });
      return;
    }
    if (entry.eventType !== SIEGE.EVENT_SIEGE_TRANSITION || !SIEGE.END_SIEGE_STATES.includes(p.to)) return;
    const siege = sieges.get(String(entry.aggregateId));
    if (!siege || idOrNull(siege.systemId) === null) {
      skip("SIEGE_MISSING");
      return;
    }
    const patch = p.patch && typeof p.patch === "object" ? p.patch : {};
    emit(entry, { eventKey: rowKeyOf(entry.journalId, KIND.SIEGE_ENDED), kind: KIND.SIEGE_ENDED,
      systemId: siege.systemId, attacker: idOrNull(siege.attackerFactionId), defender: idOrNull(siege.ownerFactionId),
      outcome: p.to, endReason: typeof patch.endReason === "string" ? patch.endReason : null });
  }

  function playerSiegeRow(entry) {
    const p = entry.payload || {};
    let kind;
    if (entry.eventType === PSIEGE.EVENT_STARTED) kind = KIND.STRUCTURE_SIEGE_STARTED;
    else if (entry.eventType === PSIEGE.EVENT_TRANSITION && PSIEGE.END_STATES.includes(p.to)) {
      kind = KIND.STRUCTURE_SIEGE_ENDED;
    } else return;
    const systemId = idOrNull(p.systemId);
    const ownerCorpId = idOrNull(p.ownerCorpId);
    if (systemId === null || ownerCorpId === null) {
      skip("BAD_PAYLOAD");
      return;
    }
    const ended = kind === KIND.STRUCTURE_SIEGE_ENDED;
    emit(entry, { eventKey: rowKeyOf(entry.journalId, kind), kind, systemId, ownerCorpId,
      structureTypeId: idOrNull(p.structureTypeId), attacker: idOrNull(p.attackerFactionId),
      outcome: ended ? p.to : null, endReason: ended && typeof p.endReason === "string" ? p.endReason : null });
  }

  function playerSovRow(entry) {
    const kind = Object.prototype.hasOwnProperty.call(PLAYER_SOV_EVENT_KIND, entry.eventType)
      ? PLAYER_SOV_EVENT_KIND[entry.eventType] : null;
    const p = entry.payload || {};
    if (kind === null || (kind === KIND.PLAYER_SOV_LOST && p.endReason !== "RETAKEN")) return;
    const systemId = idOrNull(p.systemId);
    const ownerCorpId = idOrNull(p.corpId);
    const allianceId = idOrNull(p.allianceId);
    if (systemId === null || ownerCorpId === null || allianceId === null) {
      skip("BAD_PAYLOAD");
      return;
    }
    const names = ctx.allianceNames;
    const name = names && typeof names.get === "function" ? names.get(allianceId) : null;
    emit(entry, { eventKey: rowKeyOf(entry.journalId, kind), kind, systemId, ownerCorpId, allianceId,
      allianceName: typeof name === "string" && name !== "" ? name : null, attacker: idOrNull(p.attackerFactionId),
      reinforcedUntil: Number.isSafeInteger(p.reinforcedUntil) ? p.reinforcedUntil : null,
      reinforceMs: Number.isSafeInteger(p.reinforceMs) ? p.reinforceMs : null });
  }

  function heavyEventRow(entry) {
    if (entry.eventType !== HEV.EVENT_PLANNED) return;
    const p = entry.payload || {};
    const systemId = idOrNull(p.systemId);
    const tier = Number.isSafeInteger(p.tier) && p.tier >= 1 && p.tier <= HEV.TIER_COUNT ? p.tier : null;
    if (systemId === null || !HEV.TYPES.includes(p.eventType) || tier === null || typeof p.eventId !== "string") {
      skip("BAD_PAYLOAD");
      return;
    }
    emit(entry, { eventKey: rowKeyOf(entry.journalId, KIND.HEAVY_EVENT_STARTED), kind: KIND.HEAVY_EVENT_STARTED,
      systemId, eventId: p.eventId, eventType: p.eventType, tier, attacker: idOrNull(p.factionId),
      defender: idOrNull(p.beneficiaryFactionId) });
  }

  function harvestRaidRow(entry) {
    const p = entry.payload || {};
    let kind;
    if (entry.eventType === HRAID.EVENT_WARNED) kind = KIND.HARVEST_RAID_WARNED;
    else if ((entry.eventType === HRAID.EVENT_TRANSITION || entry.eventType === HRAID.EVENT_SETTLED)
      && HRAID.END_STATES.includes(p.to)) kind = KIND.HARVEST_RAID_ENDED;
    else return;
    const systemId = idOrNull(p.systemId);
    const ownerCorpId = idOrNull(p.ownerCorpId);
    const settled = kind === KIND.HARVEST_RAID_ENDED && p.to === HRAID.SETTLED;
    if (systemId === null || ownerCorpId === null || !HRAID.TARGET_KINDS.includes(p.targetKind)
      || (settled && !Array.isArray(p.loss))) {
      skip("BAD_PAYLOAD");
      return;
    }
    const base = { eventKey: rowKeyOf(entry.journalId, kind), kind, systemId, ownerCorpId, targetKind: p.targetKind,
      attacker: idOrNull(p.attackerFactionId) };
    if (kind === KIND.HARVEST_RAID_WARNED) {
      emit(entry, { ...base, leadMs: Number.isSafeInteger(ctx.harvestLeadMs) && ctx.harvestLeadMs >= 0
        ? ctx.harvestLeadMs : null, wallDeadlineAt: Number.isSafeInteger(p.wallDeadlineAt) ? p.wallDeadlineAt : null });
      return;
    }
    const names = ctx.typeNames;
    const loss = [];
    for (const l of settled ? p.loss : []) {
      const typeId = l ? idOrNull(l.typeId) : null;
      const units = l ? idOrNull(l.units) : null;
      if (typeId === null || units === null) continue;
      const name = names && typeof names.get === "function" ? names.get(typeId) : null;
      loss.push(Object.freeze({ typeId, units, name: typeof name === "string" && name !== "" ? name : null }));
    }
    emit(entry, { ...base, outcome: p.to, endReason: typeof p.endReason === "string" ? p.endReason : null,
      loss: Object.freeze(loss) });
  }

  function nativeIncursionRow(entry) {
    const p = entry.payload || {};
    const taleId = idOrNull(p.taleId);
    if (entry.eventType === NATIVE_EVENT_BIND) {
      const targets = ctx.nativeTargets;
      const systemId = taleId !== null && targets && typeof targets.get === "function"
        ? idOrNull(targets.get(taleId)) : null;
      if (systemId === null) {
        skip("BAD_PAYLOAD");
        return;
      }
      emit(entry, { eventKey: nativeNoticeKeyOf(taleId, "bound"), kind: KIND.NATIVE_INCURSION_STARTED, systemId,
        taleId, attacker: NATIVE_FACTION_ID, defender: null });
      return;
    }
    if (entry.eventType !== NATIVE_EVENT_SETTLE || !NATIVE_END_OUTCOMES.includes(p.outcome)) return;
    const systemId = idOrNull(p.targetSystemId);
    if (taleId === null || systemId === null) {
      skip("BAD_PAYLOAD");
      return;
    }
    emit(entry, { eventKey: nativeNoticeKeyOf(taleId, p.outcome), kind: KIND.NATIVE_INCURSION_ENDED, systemId, taleId,
      outcome: p.outcome, attacker: NATIVE_FACTION_ID, defender: null });
  }

  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry) continue;
    if (entry.aggregateType === WORLD_AGGREGATE) worldRow(entry);
    else if (entry.aggregateType === SIEGE.SIEGE_AGGREGATE) siegeRow(entry);
    else if (entry.aggregateType === PSIEGE.AGGREGATE) playerSiegeRow(entry);
    else if (entry.aggregateType === PLAYER_SOV_AGGREGATE) playerSovRow(entry);
    else if (entry.aggregateType === HEV.AGGREGATE) heavyEventRow(entry);
    else if (entry.aggregateType === HRAID.AGGREGATE) harvestRaidRow(entry);
    else if (entry.aggregateType === NATIVE_AGGREGATE) nativeIncursionRow(entry);
  }
  return { events, marks: delta, skipped };
}

function playerSovAllianceIds(entries, max) {
  const ids = new Set();
  for (const e of Array.isArray(entries) ? entries : []) {
    if (ids.size >= max) break;
    const id = e && e.aggregateType === PLAYER_SOV_AGGREGATE && e.payload ? idOrNull(e.payload.allianceId) : null;
    if (id !== null) ids.add(id);
  }
  return [...ids];
}

function harvestRaidLossTypeIds(entries, max) {
  const ids = new Set();
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || e.aggregateType !== HRAID.AGGREGATE || e.eventType !== HRAID.EVENT_SETTLED || !e.payload
      || !Array.isArray(e.payload.loss)) continue;
    for (const l of e.payload.loss) {
      if (ids.size >= max) return [...ids];
      const id = l ? idOrNull(l.typeId) : null;
      if (id !== null) ids.add(id);
    }
  }
  return [...ids];
}

function nativeBindTaleIds(entries, max) {
  const ids = new Set();
  for (const e of Array.isArray(entries) ? entries : []) {
    if (ids.size >= max) break;
    const id = e && e.aggregateType === NATIVE_AGGREGATE && e.eventType === NATIVE_EVENT_BIND && e.payload
      ? idOrNull(e.payload.taleId) : null;
    if (id !== null) ids.add(id);
  }
  return [...ids];
}

function endedSiegeIds(entries) {
  const ids = [];
  for (const e of Array.isArray(entries) ? entries : []) {
    if (e && e.aggregateType === SIEGE.SIEGE_AGGREGATE && e.eventType === SIEGE.EVENT_SIEGE_TRANSITION
      && e.payload && SIEGE.END_SIEGE_STATES.includes(e.payload.to)) ids.push(String(e.aggregateId));
  }
  return ids;
}

module.exports = { classifyEntries, endedSiegeIds, playerSovAllianceIds, harvestRaidLossTypeIds, KIND, KINDS, AGGREGATE_TYPES, rowKeyOf,
  impactKeyOf, PLAYER_SOV_AGGREGATE, NATIVE_AGGREGATE, NATIVE_EVENT_BIND, NATIVE_EVENT_SETTLE, NATIVE_FACTION_ID,
  nativeBindTaleIds, nativeNoticeKeyOf };
