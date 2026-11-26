"use strict";

const { SCENE_OF_ROLE, ROW_STATE } = require("./schema");

const FATAL = Object.freeze(["INCURSION_EFFECTS_DRIFT", "SEAM_UNAVAILABLE"]);
const STATE = Object.freeze({ RUNNING: "running", DRIFT: "drift", STOPPED: "stopped" });
const PHASE_OVER = "OVER";
const MILLI = 1000;
const METRIC_SYSTEMS = "world.factionIncursions.effectsSystems";
const WRAPPER_KEYS = Object.freeze(["hits", "vendorWins", "errors"]);
const MAX_DETAIL = 160;

const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);
const isId = (v) => Number.isSafeInteger(v) && v > 0;

function entriesOf(incursions) {
  const out = [];
  for (const inc of Array.isArray(incursions) ? incursions : []) {
    if (!inc || inc.state !== ROW_STATE.ACTIVE || inc.phase === PHASE_OVER || !isId(inc.incursionId)
      || !Number.isSafeInteger(inc.influenceMilli) || !Array.isArray(inc.systems)) {
      continue;
    }
    const milli = Math.min(MILLI, Math.max(0, inc.influenceMilli));
    for (const s of inc.systems) {
      if (!s || !isId(s.systemId) || !Object.prototype.hasOwnProperty.call(SCENE_OF_ROLE, s.role)) continue;
      out.push({ systemId: s.systemId, incursionId: inc.incursionId, sceneType: SCENE_OF_ROLE[s.role],
        opposition: (MILLI - milli) / MILLI });
    }
  }
  return out;
}

function createEffectsDriver(deps) {
  const P = deps.settings;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  const telemetry = deps.telemetry || null;
  let state = STATE.RUNNING;
  let systems = 0;
  let pending = 0;
  let lastRefusal = null;
  let prevWrapper = { hits: 0, vendorWins: 0, errors: 0 };
  let wrapper = { hits: 0, vendorWins: 0, errors: 0 };

  function safe(fn, fallback) {
    try {
      return fn();
    } catch (_err) {
      return fallback;
    }
  }

  function bump(name, n) {
    if (Number.isSafeInteger(n) && n > 0) safe(() => deps.bump(name, n), null);
  }

  function gauge(value) {
    if (telemetry && typeof telemetry.gauge === "function") safe(() => telemetry.gauge(METRIC_SYSTEMS, value), null);
  }

  function refuse(line) {
    if (line === lastRefusal) return;
    lastRefusal = line;
    logger.log(`factionIncursions: effects ${line}`);
  }

  const adapterOf = () => {
    const a = safe(() => deps.getAdapter(), null);
    return a && typeof a.factionIncursionEffectsSet === "function"
      && typeof a.factionIncursionEffectsRefresh === "function" ? a : null;
  };

  function refreshWith(adapter) {
    const r = safe(() => adapter.factionIncursionEffectsRefresh(P.maxRefreshPerPass), null);
    if (!r || r.ok !== true) return r;
    bump("effectsRefreshed", r.refreshed);
    pending = Number.isSafeInteger(r.pending) ? r.pending : 0;
    return r;
  }

  function readWrapper(adapter) {
    const st = typeof adapter.factionIncursionEffectsStats === "function"
      ? safe(() => adapter.factionIncursionEffectsStats(), null) : null;
    if (!st || typeof st !== "object") return;
    const next = {};
    const delta = {};
    for (const k of WRAPPER_KEYS) {
      next[k] = Number.isSafeInteger(st[k]) ? st[k] : 0;
      delta[k] = next[k] > prevWrapper[k] ? next[k] - prevWrapper[k] : 0;
    }
    prevWrapper = next;
    wrapper = delta;
  }

  function publish() {
    if (state !== STATE.RUNNING) return { ok: false, reason: `EFFECTS_${state.toUpperCase()}` };
    try {
      const listed = deps.listActive({ limit: P.maxActive || 1 });
      if (!listed || listed.ok !== true) {
        const reason = (listed && listed.reason) || "LIST_FAILED";
        refuse(`read ${reason}`);
        return { ok: false, reason };
      }
      const adapter = adapterOf();
      if (!adapter) {
        refuse("adapter unavailable");
        return { ok: false, reason: "ADAPTER_UNAVAILABLE" };
      }
      const entries = entriesOf(listed.incursions);
      const r = safe(() => adapter.factionIncursionEffectsSet(entries.length > 0 ? entries : null,
        P.refreshDeltaMilli / MILLI), null);
      if (!r || r.ok !== true) {
        const reason = (r && r.reason) || "SET_FAILED";
        if (FATAL.includes(reason)) {
          bump("effectsDrift", 1);
          state = STATE.DRIFT;
          logger.log(`factionIncursions: effects off - ${reason}${r && r.detail ? ` (${r.detail})` : ""}; `
            + "the incursions go on (restart to retry)");
          return { ok: false, reason };
        }
        refuse(`set ${reason}${r && r.detail ? ` ${r.detail}` : ""}`);
        return { ok: false, reason };
      }
      bump("effectsPublished", r.changed);
      systems = new Set(entries.map((e) => e.systemId)).size;
      gauge(systems);
      const rf = refreshWith(adapter);
      if (rf && rf.ok !== true) refuse(`refresh ${rf.reason}${rf.detail ? ` ${rf.detail}` : ""}`);
      else lastRefusal = null;
      readWrapper(adapter);
      return { ok: true, systems };
    } catch (err) {
      refuse(`publish threw - ${messageOf(err)}`);
      return { ok: false, reason: "EFFECTS_PUBLISH_FAILED" };
    }
  }

  function stop() {
    if (state === STATE.STOPPED) return;
    const wasRunning = state === STATE.RUNNING;
    state = STATE.STOPPED;
    if (!wasRunning) return;
    const adapter = adapterOf();
    if (!adapter) return;
    const r = safe(() => adapter.factionIncursionEffectsSet(null, P.refreshDeltaMilli / MILLI), null);
    if (!r || r.ok !== true) return;
    systems = 0;
    gauge(0);
    if (r.installed === true) refreshWith(adapter);
  }

  function status() {
    return Object.freeze({ state, systems, pending, lastRefusal, wrapper: Object.freeze({ ...wrapper }) });
  }

  return Object.freeze({ publish, stop, status });
}

module.exports = { createEffectsDriver, entriesOf, EFFECTS_STATE: STATE };
