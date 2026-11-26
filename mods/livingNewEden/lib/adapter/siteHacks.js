"use strict";

const { SITE_ORIGIN, ACTIVE_STATES, TERMINAL_STATES, validateSiteKey, isOwnSummary } = require("./dungeonSites");
const { isExcludedSite } = require("./siteCompletion");

const MAX_WINS_PER_EMISSION = 8;
const MAX_OUTCOME_ID = 128;

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const lower = (v) => (typeof v === "string" ? v.trim().toLowerCase() : "");
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const positiveInt = (v) => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : null;
};

function containersOf(instance) {
  const ss = isObject(instance) ? instance.spawnState : null;
  return isObject(ss) && isObject(ss.hackingContainers) ? ss.hackingContainers : null;
}

function hackWinsOf(payload) {
  try {
    if (!isObject(payload) || payload.changeType !== "updated") return [];
    const after = payload.after;
    const containers = containersOf(after);
    if (!containers) return [];
    const before = payload.before;
    if (!isObject(before)) return [];
    const instanceId = positiveInt(after.instanceID);
    const systemId = positiveInt(after.solarSystemID);
    if (instanceId === null || systemId === null) return [];
    const previous = containersOf(before) || {};
    const found = [];
    for (const key of Object.keys(containers)) {
      const record = containers[key];
      if (!isObject(record) || !isObject(record.outcomes)) continue;
      const old = isObject(previous[key]) && isObject(previous[key].outcomes) ? previous[key].outcomes : {};
      for (const id of Object.keys(record.outcomes)) {
        const receipt = record.outcomes[id];
        if (!isObject(receipt) || receipt.outcome !== "won" || hasOwn(old, id)) continue;
        if (id === "" || id.length > MAX_OUTCOME_ID) continue;
        const characterId = positiveInt(receipt.characterID);
        if (characterId === null) continue;
        found.push({ contentKey: key, outcomeId: id, characterId, atMs: positiveInt(receipt.atMs) || 0 });
      }
    }
    if (found.length === 0) return [];
    found.sort((a, b) => a.atMs - b.atMs || (a.contentKey < b.contentKey ? -1 : a.contentKey > b.contentKey ? 1 : 0)
      || (a.outcomeId < b.outcomeId ? -1 : a.outcomeId > b.outcomeId ? 1 : 0));
    const siteOrigin = lower(after.siteOrigin);
    const own = siteOrigin === SITE_ORIGIN;
    const md = isObject(after.metadata) ? after.metadata : {};
    const lneEventId = own && typeof md.lneEventId === "string" ? md.lneEventId : null;
    const common = {
      instanceId,
      systemId,
      siteFamily: lower(after.siteFamily),
      siteKind: lower(after.siteKind),
      templateId: after.templateID === null || after.templateID === undefined ? "" : String(after.templateID),
      own,
      lneEventId,
      excluded: isExcludedSite(after),
    };
    return found.slice(0, MAX_WINS_PER_EMISSION).map((f) => ({ ...common, ...f }));
  } catch (_err) {
    return [];
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
    const wins = hackWinsOf(payload);
    for (const w of wins) {
      try {
        fn(w);
      } catch (err) {
        if (logged || !log) continue;
        logged = true;
        try {
          log(`[LivingNewEden] site hack listener threw: ${String((err && err.message) || err).slice(0, 200)}`);
        } catch (_logErr) {
        }
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

const MAX_WINS_PER_READ = 32;
const MAX_DETAIL = 120;

const byWinOrder = (a, b) => a.atMs - b.atMs
  || (a.contentKey < b.contentKey ? -1 : a.contentKey > b.contentKey ? 1 : 0)
  || (a.outcomeId < b.outcomeId ? -1 : a.outcomeId > b.outcomeId ? 1 : 0);

function winsOfInstance(instanceRef) {
  try {
    const containers = containersOf(instanceRef);
    if (!containers) return [];
    const found = [];
    for (const key of Object.keys(containers)) {
      const record = containers[key];
      if (!isObject(record) || !isObject(record.outcomes)) continue;
      for (const id of Object.keys(record.outcomes)) {
        const receipt = record.outcomes[id];
        if (!isObject(receipt) || receipt.outcome !== "won" || id === "" || id.length > MAX_OUTCOME_ID) continue;
        const characterId = positiveInt(receipt.characterID);
        if (characterId === null) continue;
        found.push({ contentKey: key, characterId, outcomeId: id, atMs: positiveInt(receipt.atMs) || 0 });
      }
    }
    return found.sort(byWinOrder).slice(0, MAX_WINS_PER_READ);
  } catch (_err) {
    return [];
  }
}

function readSiteHackWinsFrom(dungeonRuntime, siteKey) {
  try {
    if (!validateSiteKey(siteKey)) return { ok: false, reason: "SITE_KEY_INVALID", detail: "format" };
    if (!dungeonRuntime || typeof dungeonRuntime.findInstanceBySiteKey !== "function"
      || typeof dungeonRuntime.getInstanceRef !== "function") {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "dungeon_runtime_reads_missing" };
    }
    const summary = dungeonRuntime.findInstanceBySiteKey(siteKey);
    if (!summary) return { ok: true, state: "missing", wins: [] };
    if (!isOwnSummary(summary, siteKey)) return { ok: false, reason: "SITE_FOREIGN" };
    const lifecycle = lower(summary.lifecycleState);
    let state = "despawned";
    if (ACTIVE_STATES.has(lifecycle)) state = "active";
    else if (TERMINAL_STATES.has(lifecycle)) state = lifecycle;
    const ref = dungeonRuntime.getInstanceRef(summary.instanceID);
    return { ok: true, state, wins: ref ? winsOfInstance(ref) : [] };
  } catch (err) {
    return { ok: false, reason: "READ_FAILED", detail: String((err && err.message) || err).slice(0, MAX_DETAIL) };
  }
}

module.exports = { MAX_WINS_PER_EMISSION, MAX_WINS_PER_READ, hackWinsOf, subscribeFrom, winsOfInstance,
  readSiteHackWinsFrom };
