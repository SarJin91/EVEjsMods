"use strict";

const { isBeltNavyVictim } = require("./empireBelts");
const { isAmbientVictim } = require("./ambientRats");
const { isHeavyEventVictim } = require("./heavyEventScene");
const { isTrafficVictim } = require("./highsecTrafficScene");
const { convoyOwnerOf } = require("./convoyVictims");
const { bountyShipOf } = require("./bountyVictims");
const { situationShipOf } = require("./situationShips");
const { SITUATION_OPERATOR_KIND } = require("./data/liveProfiles");

let heavyEventVictimSkipped = 0;
let trafficVictimSkipped = 0;
let convoyVictimSeen = 0;
let bountyVictimSeen = 0;
let situationVictimSeen = 0;

function killObservationCounters() {
  return { heavyEventVictimSkipped, trafficVictimSkipped, convoyVictimSeen, bountyVictimSeen, situationVictimSeen };
}

function isSituationShip(entity) {
  return Boolean(entity) && typeof entity === "object"
    && String(entity.operatorKind || "").trim() === SITUATION_OPERATOR_KIND;
}

const WRAPPED = Symbol.for("livingNewEden.killObservationWrapped");
const MAX_DETAIL = 120;
const LIBERATION = "liberation";

let liberation = null;
let standings = null;
let playerActivity = null;
let frontJobs = null;
let navyKillsLiberateOn = false;
let shipAiKills = null;
let killWrapMountedOn = false;
let bounty = null;
let situations = null;
let seasons = null;

const listenerOf = (l) => (l && typeof l.onNpcKill === "function" ? l : null);

function setLiberation(l) {
  liberation = listenerOf(l);
}

function getLiberation() {
  return liberation;
}

function setStandings(s) {
  standings = listenerOf(s);
}

function getStandings() {
  return standings;
}

function setPlayerActivity(p) {
  playerActivity = listenerOf(p);
}

function getPlayerActivity() {
  return playerActivity;
}

function setFrontJobs(f) {
  frontJobs = listenerOf(f);
}

function getFrontJobs() {
  return frontJobs;
}

function setBounty(b) {
  bounty = listenerOf(b);
}

function getBounty() {
  return bounty;
}

function setSituations(s) {
  situations = listenerOf(s);
}

function getSituations() {
  return situations;
}

function setSeasons(s) {
  seasons = listenerOf(s);
}

function getSeasons() {
  return seasons;
}

function setNavyKillsLiberate(on) {
  navyKillsLiberateOn = on === true;
}

function navyKillsLiberate() {
  return navyKillsLiberateOn;
}

function setShipAiKills(l) {
  shipAiKills = listenerOf(l);
}

function getShipAiKills() {
  return shipAiKills;
}

function setKillWrapMounted(on) {
  killWrapMountedOn = on === true;
}

function killWrapMounted() {
  return killWrapMountedOn;
}

const toPositiveInt = (v) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
};

function lookup(get) {
  try {
    return typeof get === "function" ? listenerOf(get()) : null;
  } catch (_err) {
    return null;
  }
}

function observeBountyKill(ship, victimEntity, killerCharacterID, options, deps) {
  bountyVictimSeen += 1;
  const listener = lookup(deps.getBounty);
  if (!listener) return { skipped: "NO_HANDLER" };
  const characterId = toPositiveInt(killerCharacterID);
  if (!characterId) return { skipped: "NO_KILLER" };
  const opts = options && typeof options === "object" ? options : {};
  const systemId = toPositiveInt(opts.systemID) || toPositiveInt(victimEntity && victimEntity.systemID);
  if (!systemId) return { skipped: "NO_SYSTEM" };
  const atMs = Number.isFinite(Number(opts.nowMs)) ? Math.trunc(Number(opts.nowMs)) : null;
  if (atMs === null || atMs < 0) return { skipped: "NO_TIME" };
  const victimId = toPositiveInt(victimEntity && victimEntity.itemID);
  try {
    return listener.onNpcKill({ characterId, victimId, wantedId: ship.wantedId, version: ship.version,
      role: ship.role, systemId, atMs });
  } catch (err) {
    return { ok: false, reason: "LISTENER_THREW", detail: String((err && err.message) || err).slice(0, MAX_DETAIL) };
  }
}

function observeSituationKill(ship, victimEntity, killerCharacterID, options, deps) {
  situationVictimSeen += 1;
  const listener = lookup(deps.getSituations);
  if (!listener) return { skipped: "NO_HANDLER" };
  const characterId = toPositiveInt(killerCharacterID);
  if (!characterId) return { skipped: "NO_KILLER" };
  const opts = options && typeof options === "object" ? options : {};
  const systemId = toPositiveInt(opts.systemID) || toPositiveInt(victimEntity && victimEntity.systemID);
  if (!systemId) return { skipped: "NO_SYSTEM" };
  const atMs = Number.isFinite(Number(opts.nowMs)) ? Math.trunc(Number(opts.nowMs)) : null;
  if (atMs === null || atMs < 0) return { skipped: "NO_TIME" };
  const entityId = toPositiveInt(victimEntity && victimEntity.itemID);
  try {
    return listener.onNpcKill({ characterId, entityId, role: ship.role, situationId: ship.situationId, systemId,
      atMs });
  } catch (err) {
    return { ok: false, reason: "LISTENER_THREW", detail: String((err && err.message) || err).slice(0, MAX_DETAIL) };
  }
}

function observeKill(result, victimEntity, killerCharacterID, options, deps) {
  if (result && result.suppressed === true) return { skipped: "SUPPRESSED" };
  const bountyShip = typeof deps.bountyShipOf === "function" ? deps.bountyShipOf(victimEntity) : null;
  if (bountyShip) return { skipped: "BOUNTY", bounty: observeBountyKill(bountyShip, victimEntity, killerCharacterID,
    options, deps) };
  const situationShip = typeof deps.situationShipOf === "function" ? deps.situationShipOf(victimEntity) : null;
  if (situationShip) {
    return { skipped: "SITUATION", situation: observeSituationKill(situationShip, victimEntity, killerCharacterID,
      options, deps) };
  }
  if (typeof deps.isSituationShip === "function" && deps.isSituationShip(victimEntity) === true) {
    return { skipped: "SITUATION" };
  }
  if (typeof deps.isAmbientVictim === "function" && deps.isAmbientVictim(victimEntity) === true) {
    return { skipped: "AMBIENT" };
  }
  if (typeof deps.isHeavyEventVictim === "function" && deps.isHeavyEventVictim(victimEntity) === true) {
    heavyEventVictimSkipped += 1;
    return { skipped: "HEAVY_EVENT" };
  }
  if (typeof deps.isTrafficVictim === "function" && deps.isTrafficVictim(victimEntity) === true) {
    trafficVictimSkipped += 1;
    return { skipped: "TRAFFIC" };
  }
  const listeners = [[LIBERATION, lookup(deps.getLiberation)], ["standings", lookup(deps.getStandings)],
    ["playerActivity", lookup(deps.getPlayerActivity)], ["frontJobs", lookup(deps.getFrontJobs)],
    ["seasons", lookup(deps.getSeasons)]]
    .filter(([, l]) => l !== null);
  if (listeners.length === 0) return { skipped: "NO_HANDLER" };
  const characterId = toPositiveInt(killerCharacterID);
  if (!characterId) return { skipped: "NO_KILLER" };
  const opts = options && typeof options === "object" ? options : {};
  const systemId = toPositiveInt(opts.systemID) || toPositiveInt(victimEntity && victimEntity.systemID);
  if (!systemId) return { skipped: "NO_SYSTEM" };
  const atMs = Number.isFinite(Number(opts.nowMs)) ? Math.trunc(Number(opts.nowMs)) : null;
  if (atMs === null || atMs < 0) return { skipped: "NO_TIME" };
  const resolve = deps.resolveVictimFactionID;
  const resolvedFactionId = typeof resolve === "function" ? toPositiveInt(resolve(victimEntity)) : 0;
  const owner = typeof deps.convoyOwnerOf === "function" ? toPositiveInt(deps.convoyOwnerOf(victimEntity)) : 0;
  const victimFactionId = owner || resolvedFactionId;
  if (!victimFactionId) return { skipped: "NO_FACTION" };
  const victimId = toPositiveInt(victimEntity && victimEntity.itemID);
  const kill = victimId ? { characterId, victimFactionId, systemId, atMs, victimId }
    : { characterId, victimFactionId, systemId, atMs };
  kill.rewardable = true;
  const navy = typeof deps.isNavyVictim === "function" && deps.isNavyVictim(victimEntity) === true;
  if (navy) kill.navy = true;
  if (owner) {
    kill.convoyOwnerFactionId = owner;
    convoyVictimSeen += 1;
  }
  const skipLiberation = owner > 0
    || (navy && !(typeof deps.navyKillsLiberate === "function" && deps.navyKillsLiberate() === true));
  const results = {};
  for (const [name, listener] of listeners) {
    if (name === LIBERATION && skipLiberation) continue;
    try {
      results[name] = listener.onNpcKill({ ...kill });
    } catch (err) {
      results[name] = { ok: false, reason: "LISTENER_THREW",
        detail: String((err && err.message) || err).slice(0, MAX_DETAIL) };
    }
  }
  return { results };
}

function observeShipAiKill(result, victimEntity, killerCharacterID, options, deps) {
  if (result && result.suppressed === true) return { skipped: "SUPPRESSED" };
  const listener = lookup(deps && deps.getShipAiKills);
  if (!listener) return { skipped: "NO_HANDLER" };
  const characterId = toPositiveInt(killerCharacterID);
  if (!characterId) return { skipped: "NO_KILLER" };
  const victimId = toPositiveInt(victimEntity && victimEntity.itemID);
  if (!victimId) return { skipped: "NO_VICTIM" };
  const victimTypeId = toPositiveInt(victimEntity && victimEntity.typeID);
  if (!victimTypeId) return { skipped: "NO_TYPE" };
  const opts = options && typeof options === "object" ? options : {};
  const systemId = toPositiveInt(opts.systemID) || toPositiveInt(victimEntity && victimEntity.systemID);
  if (!systemId) return { skipped: "NO_SYSTEM" };
  const atMs = Number.isFinite(Number(opts.nowMs)) ? Math.trunc(Number(opts.nowMs)) : null;
  if (atMs === null || atMs < 0) return { skipped: "NO_TIME" };
  let victimFactionId = null;
  try {
    const resolve = deps.resolveVictimFactionID;
    victimFactionId = typeof resolve === "function" ? toPositiveInt(resolve(victimEntity)) || null : null;
  } catch (_err) {
    victimFactionId = null;
  }
  let navy = false;
  try {
    navy = typeof deps.isNavyVictim === "function" && deps.isNavyVictim(victimEntity) === true;
  } catch (_err) {
    navy = false;
  }
  try {
    listener.onNpcKill({ characterId, victimId, victimTypeId, victimFactionId, systemId, atMs, navy });
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: "LISTENER_THREW", detail: String((err && err.message) || err).slice(0, MAX_DETAIL) };
  }
}

function wrapNpcKillStandingLoss(originalFn, opts = {}) {
  if (typeof originalFn !== "function") return { ok: false, reason: "NOT_A_FUNCTION" };
  if (originalFn[WRAPPED] === true) return { ok: true, wrapped: originalFn, noop: true };
  const resolve = typeof opts.resolveVictimFactionID === "function" ? opts.resolveVictimFactionID : null;
  const deps = {
    resolveVictimFactionID: resolve,
    getLiberation: typeof opts.getLiberation === "function" ? opts.getLiberation : getLiberation,
    getStandings: typeof opts.getStandings === "function" ? opts.getStandings : getStandings,
    getPlayerActivity: typeof opts.getPlayerActivity === "function" ? opts.getPlayerActivity : getPlayerActivity,
    getFrontJobs: typeof opts.getFrontJobs === "function" ? opts.getFrontJobs : getFrontJobs,
    isNavyVictim: typeof opts.isNavyVictim === "function" ? opts.isNavyVictim : isBeltNavyVictim,
    isAmbientVictim: typeof opts.isAmbientVictim === "function" ? opts.isAmbientVictim : isAmbientVictim,
    isHeavyEventVictim: typeof opts.isHeavyEventVictim === "function" ? opts.isHeavyEventVictim : isHeavyEventVictim,
    isTrafficVictim: typeof opts.isTrafficVictim === "function" ? opts.isTrafficVictim : isTrafficVictim,
    navyKillsLiberate: typeof opts.navyKillsLiberate === "function" ? opts.navyKillsLiberate : navyKillsLiberate,
    getShipAiKills: typeof opts.getShipAiKills === "function" ? opts.getShipAiKills : getShipAiKills,
    convoyOwnerOf: typeof opts.convoyOwnerOf === "function" ? opts.convoyOwnerOf : convoyOwnerOf,
    bountyShipOf: typeof opts.bountyShipOf === "function" ? opts.bountyShipOf : bountyShipOf,
    getBounty: typeof opts.getBounty === "function" ? opts.getBounty : getBounty,
    situationShipOf: typeof opts.situationShipOf === "function" ? opts.situationShipOf : situationShipOf,
    isSituationShip: typeof opts.isSituationShip === "function" ? opts.isSituationShip : isSituationShip,
    getSituations: typeof opts.getSituations === "function" ? opts.getSituations : getSituations,
    getSeasons: typeof opts.getSeasons === "function" ? opts.getSeasons : getSeasons,
  };
  const wrapped = function livingNewEdenObservedNpcKill(victimEntity, killerCharacterID, options) {
    const result = originalFn.apply(this, arguments);
    try {
      observeKill(result, victimEntity, killerCharacterID, options, deps);
    } catch (_err) {
    }
    try {
      observeShipAiKill(result, victimEntity, killerCharacterID, options, deps);
    } catch (_err) {
    }
    return result;
  };
  wrapped[WRAPPED] = true;
  return { ok: true, wrapped };
}

module.exports = { wrapNpcKillStandingLoss, observeKill, setLiberation, getLiberation, setStandings, getStandings,
  setPlayerActivity, getPlayerActivity, setFrontJobs, getFrontJobs, setNavyKillsLiberate, navyKillsLiberate, WRAPPED,
  killObservationCounters, observeShipAiKill, setShipAiKills, getShipAiKills, setKillWrapMounted, killWrapMounted,
  setBounty, getBounty, setSituations, getSituations, isSituationShip, setSeasons, getSeasons };
