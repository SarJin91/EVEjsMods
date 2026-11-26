"use strict";

const { CAUSE } = require("./data/eventCatalog");
const { CLAIM_STATES, HELD_STATES, BUSY_STATES, STABLE } = require("../world/occupation/schema");

function campaignsBySystem(campaigns) {
  const map = new Map();
  for (const campaign of campaigns) {
    for (const systemId of campaign.systemIds) {
      let list = map.get(systemId);
      if (!list) {
        list = [];
        map.set(systemId, list);
      }
      list.push({ campaignId: campaign.campaignId, ownerFactionId: campaign.ownerFactionId });
    }
  }
  for (const list of map.values()) {
    list.sort((a, b) => a.campaignId.localeCompare(b.campaignId));
  }
  return map;
}

function opponentsOf(causeFactionId, ids) {
  const out = [];
  for (const id of ids) {
    if (Number.isSafeInteger(id) && id > 0 && id !== causeFactionId && !out.includes(id)) out.push(id);
  }
  return Object.freeze(out);
}

function aftermathCauses(system, aftermath) {
  const sums = new Map();
  const losses = aftermath && Array.isArray(aftermath.losses) ? aftermath.losses : [];
  const factions = aftermath && aftermath.factions;
  const sinceMs = aftermath && Number.isFinite(aftermath.sinceMs) ? aftermath.sinceMs : 0;
  for (const l of losses) {
    if (!l || !Number.isSafeInteger(l.factionId) || !Number.isSafeInteger(l.count) || l.count <= 0) continue;
    if (!(l.settledAt > sinceMs) || !factions || !factions.has(l.factionId)) continue;
    sums.set(l.factionId, (sums.get(l.factionId) || 0) + l.count);
  }
  const out = [];
  for (const factionId of [...sums.keys()].sort((a, b) => a - b)) {
    if (sums.get(factionId) < aftermath.minLosses) continue;
    out.push({ cause: CAUSE.BATTLE_AFTERMATH, factionId, campaignId: null, occupationState: system.occupationState,
      opponents: Object.freeze([]) });
  }
  return Object.freeze(out);
}

function liberatedCauses(system, L) {
  if (!L || !Number.isFinite(L.sinceMs) || !system) return Object.freeze([]);
  const prev = system.previousControllerFactionId;
  const controller = system.controllerFactionId;
  if (system.occupationState !== STABLE || (controller !== null && controller !== undefined)
    || !Number.isSafeInteger(prev) || prev <= 0 || !Number.isSafeInteger(system.lastStateChangeAt)
    || !(system.lastStateChangeAt > L.sinceMs)) {
    return Object.freeze([]);
  }
  return Object.freeze([{ cause: CAUSE.LIBERATED, factionId: prev, campaignId: null, occupationState: STABLE,
    opponents: Object.freeze([]) }]);
}

function frontCauses(system) {
  if (!system || !BUSY_STATES.includes(system.occupationState)) return Object.freeze([]);
  const occupier = system.occupierFactionId;
  if (!Number.isSafeInteger(occupier) || occupier <= 0) return Object.freeze([]);
  return Object.freeze([{ cause: CAUSE.FRONT_LINE, factionId: occupier, campaignId: null,
    occupationState: system.occupationState, opponents: Object.freeze([]) }]);
}

function developedCauses(system, D) {
  if (!D || !system || system.occupationState !== STABLE || !D.levels) return Object.freeze([]);
  const lv = D.levels.get(system.systemId);
  if (!lv) return Object.freeze([]);
  const out = [];
  const isId = (v) => Number.isSafeInteger(v) && v > 0;
  if (Number.isSafeInteger(lv.ind) && lv.ind >= D.minLevel) {
    const owner = isId(system.controllerFactionId) ? system.controllerFactionId
      : isId(system.sdeFactionId) ? system.sdeFactionId : null;
    if (owner !== null) {
      out.push({ cause: CAUSE.DEVELOPED_INDUSTRY, factionId: owner, campaignId: null, occupationState: STABLE,
        opponents: Object.freeze([]) });
    }
  }
  const rat = D.ratFactions ? D.ratFactions.get(system.systemId) : null;
  if (Number.isSafeInteger(lv.mil) && lv.mil >= D.minLevel && isId(rat)) {
    out.push({ cause: CAUSE.DEVELOPED_MILITARY, factionId: rat, campaignId: null, occupationState: STABLE,
      opponents: Object.freeze([]) });
  }
  return Object.freeze(out);
}

function causesOfSystem(system, theatreCampaigns, aftermath = null, liberated = null, front = null, developed = null) {
  const causes = [];
  const { occupationState, occupierFactionId, controllerFactionId } = system;
  const sde = system.sdeFactionId;

  if (CLAIM_STATES.includes(occupationState) && occupierFactionId && occupierFactionId > 0) {
    causes.push({
      cause: CAUSE.OCCUPATION_CLAIM,
      factionId: occupierFactionId,
      campaignId: null,
      occupationState,
      opponents: opponentsOf(occupierFactionId, [controllerFactionId, sde]),
    });
  }

  if (HELD_STATES.includes(occupationState) && occupierFactionId && occupierFactionId > 0) {
    causes.push({
      cause: CAUSE.OCCUPATION_HELD,
      factionId: occupierFactionId,
      campaignId: null,
      occupationState,
      opponents: opponentsOf(occupierFactionId, [system.previousControllerFactionId, sde]),
    });
  }

  if (occupationState === STABLE && controllerFactionId && controllerFactionId > 0) {
    for (const campaign of theatreCampaigns) {
      if (campaign.ownerFactionId === controllerFactionId) {
        causes.push({
          cause: CAUSE.CAMPAIGN_THEATRE,
          factionId: controllerFactionId,
          campaignId: campaign.campaignId,
          occupationState,
          opponents: opponentsOf(controllerFactionId, [sde]),
        });
      }
    }
  }

  if (aftermath !== null && aftermath !== undefined) causes.push(...aftermathCauses(system, aftermath));
  if (liberated !== null && liberated !== undefined) causes.push(...liberatedCauses(system, liberated));
  if (front !== null && front !== undefined) causes.push(...frontCauses(system));
  if (developed !== null && developed !== undefined) causes.push(...developedCauses(system, developed));

  causes.sort((a, b) => {
    if (a.cause !== b.cause) return a.cause.localeCompare(b.cause);
    if (a.factionId !== b.factionId) return a.factionId - b.factionId;
    if (a.campaignId === b.campaignId) return 0;
    if (a.campaignId === null) return 1;
    if (b.campaignId === null) return -1;
    return a.campaignId.localeCompare(b.campaignId);
  });

  return Object.freeze(causes);
}

module.exports = {
  campaignsBySystem,
  causesOfSystem,
  aftermathCauses,
  liberatedCauses,
  frontCauses,
  developedCauses,
};