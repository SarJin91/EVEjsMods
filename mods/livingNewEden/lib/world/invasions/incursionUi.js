"use strict";

const LNE_TALE_ID_BASE = 9000000000000;
const TALE_ID_OFFSET = LNE_TALE_ID_BASE + 1;
const STATE_ESTABLISHED = 2;
const STATE_WITHDRAWING = 0;
const SCENE_STAGING = 4;
const SEVERITY_STAGING = 4;
const TEMPLATE_CLASS_ID = 2;
const INFLUENCE_STEPS = 100;
const WORK_CLASS = "MAINTENANCE";
const TX_NAME = "invasions.incursionUi";

const METRIC_PUBLISHED = "world.incursionUi.published";
const METRIC_UNCHANGED = "world.incursionUi.unchanged";
const METRIC_DEFERRED = "world.incursionUi.deferred";
const METRIC_READ_FAILED = "world.incursionUi.readFailed";
const METRIC_PUBLISH_FAILED = "world.incursionUi.publishFailed";
const METRIC_ENTRIES = "world.incursionUi.entries";
const METRIC_SUPPRESSED = "world.incursionUi.suppressed";
const METRIC_EXTRA_FAILED = "world.incursionUi.extraFailed";

const isPositiveInt = (v) => Number.isSafeInteger(v) && v > 0;
const toNumber = (v) => (typeof v === "bigint" ? Number(v) : v);

function influenceOf(row, now, withdrawAtOf) {
  if (row.state === "WITHDRAWING") return 0;
  const w = withdrawAtOf(row);
  const started = Number(row.started_at);
  if (typeof w !== "number" || !Number.isFinite(w) || !Number.isFinite(started) || !(w > started)) return 1;
  const x = Math.min(1, Math.max(0, (w - now) / (w - started)));
  return Math.round(x * INFLUENCE_STEPS) / INFLUENCE_STEPS;
}

function entryOf(row, now, templateNameID, withdrawAtOf) {
  const round = toNumber(row.roll_round);
  const systemId = toNumber(row.beachhead_system_id);
  const factionId = toNumber(row.faction_id);
  if (!Number.isSafeInteger(round) || round < 0 || !isPositiveInt(systemId) || !isPositiveInt(factionId)) return null;
  const withdrawing = row.state === "WITHDRAWING";
  return {
    taleID: round + TALE_ID_OFFSET,
    severity: SEVERITY_STAGING,
    stagingSolarSystemID: systemId,
    state: withdrawing ? STATE_WITHDRAWING : STATE_ESTABLISHED,
    templateNameID,
    templateClassID: TEMPLATE_CLASS_ID,
    aggressorFactionID: factionId,
    influence: influenceOf(row, now, withdrawAtOf),
    systems: [{ solarSystemID: systemId, sceneType: SCENE_STAGING, templateNameID }],
    effects: [],
    incursedSystems: [],
    rewardGroupID: 0,
    hasChat: false,
    hasFinalEncounter: false,
    chatAnnouncementMessageId: 0,
    musicState: null,
  };
}

function buildIncursionUiPayload(rows, opts) {
  const o = opts || {};
  const maxEntries = Number.isSafeInteger(o.maxEntries) && o.maxEntries > 0 ? o.maxEntries : 0;
  if (!Array.isArray(rows) || maxEntries === 0) return [];
  const templateNameID = Number.isSafeInteger(o.templateNameID) && o.templateNameID >= 0 ? o.templateNameID : 0;
  const withdrawAtOf = typeof o.withdrawAtOf === "function" ? o.withdrawAtOf : (row) => row.withdraw_at;
  const now = Number(o.now);
  const out = [];
  for (const row of rows) {
    if (out.length >= maxEntries) break;
    try {
      const entry = row ? entryOf(row, now, templateNameID, withdrawAtOf) : null;
      if (entry !== null) out.push(entry);
    } catch (_err) {
    }
  }
  return out;
}

function entrySystems(entry) {
  const out = [];
  if (!entry || typeof entry !== "object") return out;
  if (isPositiveInt(entry.stagingSolarSystemID)) out.push(entry.stagingSolarSystemID);
  for (const s of Array.isArray(entry.systems) ? entry.systems : []) {
    if (s && isPositiveInt(s.solarSystemID)) out.push(s.solarSystemID);
  }
  for (const id of Array.isArray(entry.incursedSystems) ? entry.incursedSystems : []) {
    if (isPositiveInt(id)) out.push(id);
  }
  return out;
}

function mergeEntries(invasionEntries, extraEntries, maxEntries) {
  const max = Number.isSafeInteger(maxEntries) && maxEntries > 0 ? maxEntries : 0;
  const invasions = Array.isArray(invasionEntries) ? invasionEntries : [];
  const extra = (Array.isArray(extraEntries) ? extraEntries : []).slice(0, max);
  if (extra.length === 0) return invasions.slice(0, max);
  const taken = new Set();
  for (const e of extra) for (const id of entrySystems(e)) taken.add(id);
  const kept = invasions.filter((e) => !(e && taken.has(e.stagingSolarSystemID)));
  return [...kept.slice(0, max - extra.length), ...extra];
}

function createIncursionUiPublisher(deps) {
  const { store, repository, adapter, clock } = deps;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const getExtraEntries = typeof deps.getExtraEntries === "function" ? deps.getExtraEntries : null;
  const telemetry = deps.telemetry || null;
  const logger = deps.logger || null;
  const timers = deps.timers || globalThis;
  const withdrawAtOf = typeof deps.withdrawAtOf === "function" ? deps.withdrawAtOf : (row) => row.withdraw_at;
  const cfg = deps.config || {};
  const maxEntries = Number.isSafeInteger(cfg.maxEntries) && cfg.maxEntries > 0 ? cfg.maxEntries : 0;
  const templateNameID = Number.isSafeInteger(cfg.templateNameID) && cfg.templateNameID >= 0 ? cfg.templateNameID : 0;
  const refreshMs = Number.isSafeInteger(cfg.refreshMs) && cfg.refreshMs > 0 ? cfg.refreshMs : 60000;

  let lastSig = null;
  let stopped = false;
  let handle = null;
  const loggedReasons = new Set();

  function count(name) {
    try {
      if (telemetry && typeof telemetry.count === "function") telemetry.count(name, 1);
    } catch (_err) {
    }
  }

  function gauge(name, value) {
    try {
      if (telemetry && typeof telemetry.gauge === "function") telemetry.gauge(name, value);
    } catch (_err) {
    }
  }

  function log(line) {
    try {
      if (logger && typeof logger.log === "function") logger.log(line);
    } catch (_err) {
    }
  }

  function publish(list) {
    if (!adapter || typeof adapter.publishIncursions !== "function") {
      return { ok: false, reason: "INCURSION_RUNTIME_UNAVAILABLE", detail: "adapter.publishIncursions missing" };
    }
    try {
      const r = adapter.publishIncursions(list);
      return r && typeof r === "object" ? r : { ok: false, reason: "INCURSION_PUBLISH_FAILED", detail: "no result" };
    } catch (err) {
      return { ok: false, reason: "INCURSION_PUBLISH_FAILED", detail: String((err && err.message) || err) };
    }
  }

  function suppressedGauge() {
    try {
      if (!adapter || typeof adapter.incursionUiStats !== "function") return;
      const s = adapter.incursionUiStats();
      if (s && Number.isSafeInteger(s.lastSuppressed)) gauge(METRIC_SUPPRESSED, s.lastSuppressed);
    } catch (_err) {
    }
  }

  function admitted() {
    try {
      const governor = getGovernor();
      return !governor || typeof governor.admits !== "function" || governor.admits(WORK_CLASS) !== false;
    } catch (_err) {
      return true;
    }
  }

  function readRows() {
    if (maxEntries === 0) return { ok: true, invasions: [] };
    const tx = store.transaction(TX_NAME, (db) => repository.listOpen(db, { limit: maxEntries }));
    const read = tx && tx.ok ? tx.value : tx;
    if (!tx || !tx.ok || !read || read.ok !== true || !Array.isArray(read.invasions)) {
      return { ok: false, reason: String((read && read.reason) || "TX_FAILED") };
    }
    return read;
  }

  function extraEntries() {
    try {
      const list = getExtraEntries();
      if (Array.isArray(list)) return list;
    } catch (_err) {
    }
    count(METRIC_EXTRA_FAILED);
    return [];
  }

  function runOnce() {
    try {
      if (stopped) return;
      if (!store || typeof store.isOpen !== "function" || store.isOpen() !== true) return;
      if (!admitted()) {
        count(METRIC_DEFERRED);
        return;
      }
      const read = readRows();
      if (!read.ok) {
        count(METRIC_READ_FAILED);
        return;
      }
      const invasionPayload = buildIncursionUiPayload(read.invasions,
        { now: clock.now(), templateNameID, maxEntries, withdrawAtOf });
      const payload = getExtraEntries === null ? invasionPayload
        : mergeEntries(invasionPayload, extraEntries(), maxEntries);
      const sig = JSON.stringify(payload);
      if (sig === lastSig) {
        count(METRIC_UNCHANGED);
        return;
      }
      const r = publish(payload);
      if (r.ok === true) {
        lastSig = sig;
        count(METRIC_PUBLISHED);
        gauge(METRIC_ENTRIES, payload.length);
        suppressedGauge();
        return;
      }
      count(METRIC_PUBLISH_FAILED);
      const reason = String(r.reason || "UNKNOWN");
      if (!loggedReasons.has(reason)) {
        loggedReasons.add(reason);
        log(`invasions: incursion UI publish refused ${reason}${r.detail ? ` (${r.detail})` : ""}; retrying each cycle`);
      }
    } catch (err) {
      count(METRIC_READ_FAILED);
      if (!loggedReasons.has("EXCEPTION")) {
        loggedReasons.add("EXCEPTION");
        log(`invasions: incursion UI cycle failed: ${String((err && err.message) || err)}`);
      }
    }
  }

  function start() {
    try {
      if (stopped || handle !== null) return;
      runOnce();
      handle = timers.setInterval(runOnce, refreshMs);
      if (handle && typeof handle.unref === "function") handle.unref();
    } catch (err) {
      log(`invasions: incursion UI publisher start failed: ${String((err && err.message) || err)}`);
    }
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    try {
      if (handle !== null) timers.clearInterval(handle);
    } catch (_err) {
    }
    handle = null;
    publish([]);
    lastSig = null;
  }

  return Object.freeze({ start, stop, runOnce });
}

module.exports = { LNE_TALE_ID_BASE, TALE_ID_OFFSET, buildIncursionUiPayload, mergeEntries,
  createIncursionUiPublisher };
