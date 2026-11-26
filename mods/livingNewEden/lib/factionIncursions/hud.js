"use strict";

const { createPoller } = require("../presence/poller");
const { buildHudIncursions } = require("./presentation");

const WORK_CLASS = "OPERATIONAL";
const FATAL = Object.freeze(["INCURSION_HUD_DRIFT", "SEAM_UNAVAILABLE"]);
const STATE = Object.freeze({ IDLE: "idle", RUNNING: "running", DRIFT: "drift", STOPPED: "stopped" });
const METRIC_DATA = "world.factionIncursions.hudData";
const METRIC_INFLUENCE = "world.factionIncursions.hudInfluence";
const METRIC_REMOVE = "world.factionIncursions.hudRemove";
const METRIC_ERRORS = "world.factionIncursions.hudErrors";
const METRIC_DRIFT = "world.factionIncursions.hudDrift";
const METRIC_SESSIONS = "world.factionIncursions.hudSessions";
const MAX_DETAIL = 160;

const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);

function createHudDriver(deps) {
  const P = deps.settings;
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  const counters = { hudData: 0, hudInfluence: 0, hudRemove: 0, hudErrors: 0, hudDrift: 0 };
  let state = STATE.IDLE;
  let lastSync = null;
  let lastRefusal = null;
  let poller = null;
  const unsubscribes = [];

  function safe(fn, fallback) {
    try {
      return fn();
    } catch (_err) {
      return fallback;
    }
  }

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    safe(() => telemetry[kind](name, value), null);
  }

  function bump(key, metricName, n) {
    if (!(n > 0)) return;
    counters[key] += n;
    metric("count", metricName, n);
  }

  function refuse(line) {
    if (line === lastRefusal) return;
    lastRefusal = line;
    logger.log(`factionIncursions: hud ${line}`);
  }

  function admits() {
    const g = typeof deps.getGovernor === "function" ? safe(() => deps.getGovernor(), null) : null;
    return !g || typeof g.admits !== "function" || safe(() => g.admits(WORK_CLASS), true) !== false;
  }

  function spec(incursions) {
    return { incursions, templateNameID: P.templateNameID, removeTemplateID: P.removeTemplateID,
      maxSessions: P.maxSessionsPerSync };
  }

  function runPass() {
    if (state !== STATE.RUNNING) return { ok: false, reason: `HUD_${state.toUpperCase()}` };
    try {
      if (!admits()) return { ok: true, skipped: "GOVERNOR" };
      const listed = deps.listActive({ limit: P.maxActive || 1 });
      if (!listed || listed.ok !== true) {
        const reason = (listed && listed.reason) || "LIST_FAILED";
        refuse(`read ${reason}`);
        return { ok: false, reason };
      }
      const adapter = safe(() => deps.getAdapter(), null);
      if (!adapter || typeof adapter.factionIncursionHudSync !== "function") {
        refuse("adapter unavailable");
        return { ok: false, reason: "ADAPTER_UNAVAILABLE" };
      }
      const r = adapter.factionIncursionHudSync(spec(buildHudIncursions(listed.incursions)));
      if (!r || r.ok !== true) {
        const reason = (r && r.reason) || "SYNC_FAILED";
        if (FATAL.includes(reason)) {
          bump("hudDrift", METRIC_DRIFT, 1);
          state = STATE.DRIFT;
          if (poller) poller.stop();
          logger.log(`factionIncursions: hud off - ${reason}${r && r.detail ? ` (${r.detail})` : ""}; `
            + "the window entries go on (restart to retry)");
          return { ok: false, reason };
        }
        refuse(`sync ${reason}${r && r.detail ? ` ${r.detail}` : ""}`);
        return { ok: false, reason };
      }
      bump("hudData", METRIC_DATA, r.data);
      bump("hudInfluence", METRIC_INFLUENCE, r.influence);
      bump("hudRemove", METRIC_REMOVE, r.removed);
      bump("hudErrors", METRIC_ERRORS, r.errors);
      metric("gauge", METRIC_SESSIONS, Number.isSafeInteger(r.sessions) ? r.sessions : 0);
      lastSync = deps.now();
      lastRefusal = null;
      return { ok: true };
    } catch (err) {
      refuse(`pass threw - ${messageOf(err)}`);
      return { ok: false, reason: "HUD_PASS_FAILED" };
    }
  }

  function arm(ms) {
    if (state === STATE.RUNNING && poller) poller.arm(Number.isFinite(ms) ? ms : 0);
  }

  function subscribe(presence, name) {
    if (!presence || typeof presence[name] !== "function") return;
    const r = safe(() => presence[name](() => arm(0)), null);
    if (r && r.ok === true && typeof r.unsubscribe === "function") unsubscribes.push(r.unsubscribe);
  }

  function start() {
    if (state !== STATE.IDLE) return { ok: false, reason: `HUD_${state.toUpperCase()}` };
    poller = createPoller({ runPass, intervalMs: P.refreshMs, now: deps.now, setTimer: deps.setTimer,
      onError: (err) => refuse(`pass threw - ${messageOf(err)}`), pacing: false });
    state = STATE.RUNNING;
    const started = poller.start();
    if (!started.ok) {
      state = STATE.STOPPED;
      return { ok: false, reason: `poller ${started.reason}` };
    }
    const presence = typeof deps.getPresence === "function" ? safe(() => deps.getPresence(), null) : null;
    subscribe(presence, "onSystemObserved");
    subscribe(presence, "onSystemUnobserved");
    arm(0);
    return { ok: true };
  }

  function stop() {
    if (state === STATE.STOPPED) return;
    const wasRunning = state === STATE.RUNNING;
    state = STATE.STOPPED;
    for (const off of unsubscribes.splice(0)) safe(() => off(), null);
    if (poller) poller.stop();
    if (!wasRunning) return;
    const adapter = safe(() => deps.getAdapter(), null);
    if (!adapter || typeof adapter.factionIncursionHudClear !== "function") return;
    const r = safe(() => adapter.factionIncursionHudClear(P.removeTemplateID), null);
    if (r && r.ok === true) bump("hudRemove", METRIC_REMOVE, r.removed);
  }

  function status() {
    return Object.freeze({ state, lastSync, counters: Object.freeze({ ...counters }) });
  }

  return Object.freeze({ start, stop, arm, runPass, status });
}

module.exports = { createHudDriver, HUD_STATE: STATE };
