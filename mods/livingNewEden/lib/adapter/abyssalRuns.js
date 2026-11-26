"use strict";

const HOST_ID_MIN = 32000001;
const HOST_ID_COUNT = 200;
const HOST_ID_MAX = HOST_ID_MIN + HOST_ID_COUNT - 1;
const MAX_PARTICIPANTS = 3;
const MAX_TEXT = 64;
const MAX_DETAIL = 120;
const OUTCOME_EXITED = "exited";
const PROFILE_REFERENCE_KEY = "abyssalContentProfileReferenceSchemaVersion";

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && Number.isSafeInteger(Math.trunc(n)) ? Math.trunc(n) : 0;
}

function objOf(v) {
  return v !== null && typeof v === "object" ? v : null;
}

function textOf(v) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t === "" ? null : t.slice(0, MAX_TEXT);
}

function isHostIdFallback(locationId) {
  const n = toInt(locationId);
  return n >= HOST_ID_MIN && n <= HOST_ID_MAX;
}

function isAbyssalHostWith(hostExports, locationId) {
  try {
    if (!hostExports || typeof hostExports.isAbyssalHostLocationID !== "function") return null;
    return hostExports.isAbyssalHostLocationID(locationId) === true;
  } catch (_err) {
    return null;
  }
}

function tierOf(run, resolvePersisted) {
  const profile = objOf(run.contentProfile);
  let value = run.tier !== undefined && run.tier !== null ? run.tier : (profile ? profile.tier : undefined);
  if (profile && Object.prototype.hasOwnProperty.call(profile, PROFILE_REFERENCE_KEY)) {
    let resolved = null;
    try {
      resolved = typeof resolvePersisted === "function" ? resolvePersisted(profile) : null;
    } catch (_err) {
      return -1;
    }
    const definition = resolved && resolved.success === true ? objOf(resolved.definition) : null;
    if (!definition) return -1;
    if (value !== undefined && (typeof value !== "number" || value !== definition.tier)) return -1;
    value = definition.tier;
  }
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 6 ? value : -1;
}

function projectRunWith(pocketState, resolvePersisted = null) {
  const ps = objOf(pocketState);
  if (!ps) return null;
  const instanceId = toInt(ps.instanceID);
  const ownerCharacterId = toInt(ps.characterID);
  if (instanceId <= 0 || ownerCharacterId <= 0) return null;
  const tracking = objOf(ps.dungeonTrackingState) || {};
  const timer = objOf(ps.timerState) || {};
  const roster = Array.isArray(ps.participantRoster) ? ps.participantRoster : [];
  const participants = [];
  for (const entry of roster) {
    if (participants.length >= MAX_PARTICIPANTS) break;
    const e = objOf(entry);
    if (!e) continue;
    const characterId = toInt(e.characterID);
    if (characterId <= 0) continue;
    participants.push(Object.freeze({ characterId, shipTypeId: Math.max(0, toInt(e.shipTypeID)),
      status: textOf(e.status) || "" }));
  }
  const location = toInt(ps.abyssalLocationID);
  const system = toInt(ps.solarSystemID);
  const hostLocationId = location > 0 ? location : (isHostIdFallback(system) ? system : 0);
  const source = toInt(ps.sourceSolarSystemID);
  const weather = textOf(tracking.weatherType);
  return Object.freeze({
    instanceId,
    activatedAtMs: Math.max(0, toInt(ps.activatedAtMs)),
    ownerCharacterId,
    sourceSystemId: source > 0 && !isHostIdFallback(source) ? source : 0,
    hostLocationId,
    tier: tierOf(ps, resolvePersisted),
    weather: weather === null ? null : weather.toLowerCase(),
    shipClass: textOf(ps.shipClass),
    participants: Object.freeze(participants),
    roomIndex: Math.max(0, toInt(tracking.roomIndex)),
    pocketsCompleted: Math.max(0, toInt(tracking.pocketsCompleted)),
    expiresAtMs: Math.max(0, toInt(timer.expiresAtMs)),
    vendorOutcome: textOf(ps.runOutcome),
  });
}

function readActiveRunWith(facadeExports, characterId, project) {
  if (!Number.isSafeInteger(characterId) || characterId <= 0) return { ok: true, run: null };
  try {
    const fn = facadeExports ? facadeExports.getActiveAbyssalRunForCharacterID : undefined;
    if (typeof fn !== "function") {
      return { ok: false, reason: "ABYSSAL_UNAVAILABLE", detail: "getActiveAbyssalRunForCharacterID" };
    }
    const pocketState = fn(characterId);
    return { ok: true, run: pocketState ? project(pocketState) : null };
  } catch (err) {
    return { ok: false, reason: "READ_THREW", detail: messageOf(err) };
  }
}

function createCompletionHook(deps) {
  const target = deps && deps.trackingExports;
  const onExited = deps && deps.onExited;
  const project = deps && deps.project;
  const logger = deps && deps.logger && typeof deps.logger.log === "function" ? deps.logger : null;
  const counts = { calls: 0, exited: 0, consumerErrors: 0 };
  let installed = false;
  let active = false;
  let original = null;
  let wrapper = null;
  let loggedError = false;

  function emit(pocketState) {
    try {
      if (!pocketState || pocketState.runOutcome !== OUTCOME_EXITED) return;
      const snapshot = project(pocketState);
      if (snapshot === null) return;
      counts.exited += 1;
      onExited(snapshot);
    } catch (err) {
      counts.consumerErrors += 1;
      if (!loggedError && logger) {
        loggedError = true;
        try {
          logger.log(`abyssal completion hook: consumer failed - ${messageOf(err)}`);
        } catch (_err) {
        }
      }
    }
  }

  function install() {
    if (installed) return { ok: false, reason: "ALREADY_INSTALLED" };
    if (!target || typeof target.recordAbyssalRunCompletion !== "function" || typeof onExited !== "function"
      || typeof project !== "function") {
      return { ok: false, reason: "SEAM_MISSING" };
    }
    original = target.recordAbyssalRunCompletion;
    const base = original;
    wrapper = function lneAbyssalRunCompletion(pocketState) {
      const out = base.apply(this, arguments);
      if (active) {
        counts.calls += 1;
        emit(pocketState);
      }
      return out;
    };
    target.recordAbyssalRunCompletion = wrapper;
    installed = true;
    active = true;
    return { ok: true };
  }

  function uninstall() {
    active = false;
    if (installed && target && target.recordAbyssalRunCompletion === wrapper) {
      target.recordAbyssalRunCompletion = original;
    }
    installed = false;
  }

  return Object.freeze({ install, uninstall, stats: () => ({ installed, ...counts }) });
}

module.exports = { HOST_ID_MIN, HOST_ID_COUNT, HOST_ID_MAX, MAX_PARTICIPANTS, OUTCOME_EXITED, isHostIdFallback,
  isAbyssalHostWith, tierOf, projectRunWith, readActiveRunWith, createCompletionHook };
