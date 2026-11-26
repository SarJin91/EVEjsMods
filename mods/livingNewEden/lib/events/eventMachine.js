"use strict";

const { CAUSE } = require("./data/eventCatalog");
const { STABLE } = require("../world/occupation/schema");

const STATE = Object.freeze({
  PLANNED: "PLANNED",
  ACTIVE: "ACTIVE",
  COMPLETING: "COMPLETING",
  COMPLETED: "COMPLETED",
  CANCELLED: "CANCELLED",
  QUARANTINED: "QUARANTINED",
});

const OPEN_STATES = Object.freeze([STATE.PLANNED, STATE.ACTIVE, STATE.COMPLETING]);
const TERMINAL_STATES = Object.freeze([STATE.COMPLETED, STATE.CANCELLED, STATE.QUARANTINED]);

const RESULT = Object.freeze({
  EXPIRED: "EXPIRED",
  CLEARED: "CLEARED",
  CAUSE_GONE: "CAUSE_GONE",
  EXPIRED_UNSTARTED: "EXPIRED_UNSTARTED",
  CATALOG_MISSING: "CATALOG_MISSING",
  UNOBSERVED: "UNOBSERVED",
});

const TRANSITIONS = Object.freeze([
  [STATE.PLANNED, STATE.ACTIVE],
  [STATE.PLANNED, STATE.CANCELLED],
  [STATE.PLANNED, STATE.QUARANTINED],
  [STATE.ACTIVE, STATE.COMPLETING],
  [STATE.ACTIVE, STATE.COMPLETED],
  [STATE.ACTIVE, STATE.CANCELLED],
  [STATE.ACTIVE, STATE.QUARANTINED],
  [STATE.COMPLETING, STATE.COMPLETED],
]);

function isValidTransition(from, to) {
  return TRANSITIONS.some(([f, t]) => f === from && t === to);
}

function causeHolds(event, system, activeCampaignIds) {
  if (!system) return null;

  const { cause, factionId, campaignId } = event;
  const { occupationState, occupierFactionId, controllerFactionId } = system;

  if (cause === CAUSE.OCCUPATION_CLAIM || cause === CAUSE.OCCUPATION_HELD) {
    return occupierFactionId === factionId && occupationState !== STABLE;
  }

  if (cause === CAUSE.CAMPAIGN_THEATRE) {
    return activeCampaignIds.includes(campaignId) && controllerFactionId === factionId;
  }

  if (cause === CAUSE.BATTLE_AFTERMATH) return true;

  if (cause === CAUSE.LIBERATED) return true;

  if (cause === CAUSE.FRONT_LINE) return true;

  if (cause === CAUSE.DEVELOPED_INDUSTRY || cause === CAUSE.DEVELOPED_MILITARY) return true;

  return false;
}

function decideEventStep(event, facts) {
  const { state, dueAt, expiresAt, sitesCreated } = event;
  const { now, type, causeHolds: ch, siteStates } = facts;

  const ret = (action, to, result, cleanup, dueAtNew) =>
    Object.freeze({ action, to, result, cleanup, dueAt: dueAtNew });

  if (state === STATE.PLANNED) {
    if (type === null) {
      return ret("QUARANTINE", STATE.QUARANTINED, RESULT.CATALOG_MISSING, "EVENT_CANCELLED", null);
    }
    if (now >= expiresAt) {
      return ret("CANCEL", STATE.CANCELLED, RESULT.EXPIRED_UNSTARTED, null, null);
    }
    if (ch === false) {
      return ret("CANCEL", STATE.CANCELLED, RESULT.CAUSE_GONE, null, null);
    }
    const activation = facts.activation;
    if (activation === undefined || activation === null) {
      if (now >= dueAt) {
        return ret("ACTIVATE", STATE.ACTIVE, null, null, null);
      }
      return ret("NONE", null, null, null, null);
    }
    if (activation.observed === true && now >= dueAt) {
      return ret("ACTIVATE", STATE.ACTIVE, null, null, null);
    }
    if (activation.observed === false && now >= activation.waitUntil) {
      return ret("CANCEL", STATE.CANCELLED, RESULT.UNOBSERVED, null, null);
    }
    return ret("NONE", null, null, null, null);
  }

  if (state === STATE.ACTIVE) {
    if (type === null) {
      return ret("QUARANTINE", STATE.QUARANTINED, RESULT.CATALOG_MISSING, "EVENT_CANCELLED", null);
    }
    if (sitesCreated > 0 && siteStates !== null) {
      const allCompleted = siteStates.length === sitesCreated && siteStates.every((s) => s === "COMPLETED");
      if (allCompleted) {
        if (now >= expiresAt) {
          return ret("FINISH", STATE.COMPLETED, RESULT.CLEARED, "EVENT_END", null);
        } else {
          const newDueAt = now + type.aftermathMs;
          return ret("START_AFTERMATH", STATE.COMPLETING, null, null, newDueAt);
        }
      }
    }
    if (now >= expiresAt) {
      return ret("EXPIRE", STATE.COMPLETED, RESULT.EXPIRED, "EVENT_END", null);
    }
    if (ch === false && !(facts.causeSticky === true && sitesCreated > 0)) {
      return ret("CANCEL", STATE.CANCELLED, RESULT.CAUSE_GONE, "EVENT_CANCELLED", null);
    }
    return ret("NONE", null, null, null, null);
  }

  if (state === STATE.COMPLETING) {
    if (now >= dueAt) {
      return ret("FINISH", STATE.COMPLETED, RESULT.CLEARED, "EVENT_END", null);
    }
    return ret("NONE", null, null, null, null);
  }

  return ret("NONE", null, null, null, null);
}

module.exports = {
  STATE,
  OPEN_STATES,
  TERMINAL_STATES,
  RESULT,
  TRANSITIONS,
  decideEventStep,
  causeHolds,
  isValidTransition,
};