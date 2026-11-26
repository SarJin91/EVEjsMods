"use strict";

const { SITE_ORIGIN } = require("./dungeonSites");

const MAX_COMPLETION_CHARACTERS = 64;

const OWN_SITE_ORIGIN = SITE_ORIGIN;

const ELECTION_TEMPLATE_PREFIX = "evejs-election:";

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const lower = (v) => (typeof v === "string" ? v.trim().toLowerCase() : "");
const positiveInt = (v) => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : null;
};

function characterIdsOf(spawnState) {
  const raw = isObject(spawnState) ? spawnState.achievementCompletionCharacterIDs : null;
  if (!Array.isArray(raw)) return [];
  const ids = new Set();
  for (const v of raw) {
    const id = positiveInt(v);
    if (id !== null) ids.add(id);
  }
  return [...ids].sort((a, b) => a - b).slice(0, MAX_COMPLETION_CHARACTERS);
}

function isExcludedSite(after) {
  const md = isObject(after.metadata) ? after.metadata : {};
  const flags = isObject(after.runtimeFlags) ? after.runtimeFlags : {};
  const ownership = isObject(after.ownership) ? after.ownership : {};
  if (after.instanceScope === "private" || ownership.visibilityScope === "private") return true;
  if (flags.missionRuntime === true || md.missionRuntime === true || md.privateOperation === true) return true;
  if (md.eventID || md.eventKey || md.campaignID || md.timeLimited === true) return true;
  if (flags.timeLimited === true || flags.seasonalEvent === true) return true;
  return String(after.templateID || "").startsWith(ELECTION_TEMPLATE_PREFIX);
}

function completionOf(payload) {
  try {
    if (!isObject(payload) || payload.changeType !== "updated") return null;
    const before = payload.before;
    const after = payload.after;
    if (!isObject(before) || !isObject(after)) return null;
    if (lower(before.lifecycleState) !== "active" || lower(after.lifecycleState) !== "completed") return null;
    if (after.lifecycleReason !== "encounters_cleared") return null;
    if (lower(after.siteFamily) !== "combat" || lower(after.siteKind) !== "anomaly") return null;
    if (isExcludedSite(after)) return null;
    const instanceId = positiveInt(after.instanceID);
    const systemId = positiveInt(after.solarSystemID);
    if (instanceId === null || systemId === null) return null;
    const templateId = after.templateID === null || after.templateID === undefined ? "" : String(after.templateID);
    if (templateId === "") return null;
    const timers = isObject(after.timers) ? after.timers : {};
    const completedAtMs = positiveInt(timers.completedAtMs);
    if (completedAtMs === null) return null;
    const siteOrigin = lower(after.siteOrigin);
    return {
      instanceId,
      systemId,
      templateId,
      factionId: positiveInt(after.factionID),
      siteOrigin,
      own: siteOrigin === OWN_SITE_ORIGIN,
      completedAtMs,
      characterIds: characterIdsOf(after.spawnState),
    };
  } catch (_err) {
    return null;
  }
}

function subscribeFrom(dungeonRuntime, fn, opts = {}) {
  if (typeof fn !== "function") return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "listener_not_a_function" };
  if (!dungeonRuntime || typeof dungeonRuntime.registerInstanceChangeListener !== "function"
    || typeof dungeonRuntime.unregisterInstanceChangeListener !== "function") {
    return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "instance_change_listener_missing" };
  }
  const log = opts && typeof opts.log === "function" ? opts.log : null;
  let logged = false;
  let active = true;
  const listener = (payload) => {
    if (!active) return;
    const c = completionOf(payload);
    if (!c) return;
    try {
      fn(c);
    } catch (err) {
      if (logged || !log) return;
      logged = true;
      try {
        log(`[LivingNewEden] site completion listener threw: ${String((err && err.message) || err).slice(0, 200)}`);
      } catch (_logErr) {
      }
    }
  };
  let registered;
  try {
    registered = dungeonRuntime.registerInstanceChangeListener(listener);
  } catch (err) {
    active = false;
    return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `register_threw: ${String((err && err.message) || err)}` };
  }
  if (registered === false) {
    active = false;
    return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "register_refused" };
  }
  const unsubscribe = () => {
    if (!active) return;
    active = false;
    try {
      dungeonRuntime.unregisterInstanceChangeListener(listener);
    } catch (_err) {
    }
  };
  return { ok: true, unsubscribe };
}

module.exports = {
  MAX_COMPLETION_CHARACTERS,
  OWN_SITE_ORIGIN,
  ELECTION_TEMPLATE_PREFIX,
  isExcludedSite,
  completionOf,
  subscribeFrom,
};
