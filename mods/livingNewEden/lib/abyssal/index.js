"use strict";

const { createAbyssalRunRepository } = require("./runRepository");
const { createAbyssalObserver } = require("./observer");
const { registerAbyssalRunsView } = require("./view");
const { createPressureMemo, pressureStub, PRESSURE_DISABLED } = require("./pressure");
const { createPoller } = require("../presence/poller");

const INT_KEYS = Object.freeze(["pollMs", "maxReadsPerPoll", "lostGraceMs", "maxPendingExits", "maxRows",
  "pruneBatch", "viewLimit"]);
const PRESSURE_POSITIVE_KEYS = Object.freeze(["pressureRefreshMs", "pressureWindowMs", "pressureMaxRuns",
  "pressureHalfLifeMs"]);
const PRESSURE_WEIGHT_KEYS = Object.freeze(["pressureExitedMilli", "pressureFailedMilli", "pressureLostMilli"]);
const UNAVAILABLE = "ABYSSAL_UNAVAILABLE";

function noop() {}

function publicRun(run) {
  const { hostLocationId: _host, ...rest } = run;
  return Object.freeze(rest);
}

function publicRuns(r) {
  return r && r.ok === true && Array.isArray(r.runs) ? { ok: true, runs: Object.freeze(r.runs.map(publicRun)) } : r;
}

function settingsOf(config) {
  const a = config && config.abyssal;
  if (!a || typeof a.enabled !== "boolean" || typeof a.completionHookEnabled !== "boolean"
    || !INT_KEYS.every((k) => Number.isSafeInteger(a[k]) && a[k] > 0)) {
    return null;
  }
  return a;
}

function pressureOn(a) {
  return a.pressureEnabled === true
    && PRESSURE_POSITIVE_KEYS.every((k) => Number.isSafeInteger(a[k]) && a[k] > 0)
    && PRESSURE_WEIGHT_KEYS.every((k) => Number.isSafeInteger(a[k]) && a[k] >= 0);
}

function createUnavailableAbyssal(reason) {
  const refusal = () => ({ ok: false, reason: UNAVAILABLE });
  const pressure = pressureStub(UNAVAILABLE);
  return Object.freeze({
    getStatus: () => Object.freeze({ available: false, reason: String(reason || UNAVAILABLE) }),
    listActive: refusal,
    listFinished: refusal,
    getRun: refusal,
    pressureOf: pressure.pressureOf,
    topRegions: pressure.topRegions,
    stop: noop,
  });
}

function startAbyssal(deps) {
  const a = deps && deps.config && deps.config.abyssal;
  if (!a || a.enabled !== true) return { ok: false, reason: "disabled_by_config" };
  const settings = settingsOf(deps.config);
  if (!settings) return { ok: false, reason: "INVALID_SETTINGS" };
  const ctx = deps.ctx || {};
  const store = ctx.persistence && ctx.persistence.store;
  if (!store || typeof store.transaction !== "function") return { ok: false, reason: "NO_PERSISTENCE_STORE" };
  const adapter = deps.adapter;
  const seams = adapter && typeof adapter.abyssalSeams === "function" ? adapter.abyssalSeams() : null;
  if (!seams || seams.ok !== true) {
    return { ok: false, reason: "SEAM_UNAVAILABLE", detail: String((seams && (seams.detail || seams.reason)) || "none") };
  }
  const seam = seams.seam;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log: noop };
  const clock = deps.clock && typeof deps.clock.now === "function" ? deps.clock : { now: () => Date.now() };
  const now = () => clock.now();
  const getPresence = () => ctx.presence || null;
  const repository = createAbyssalRunRepository({ store, maxListRows: settings.maxRows });
  const observer = createAbyssalObserver({ settings, seam, store, repository, getPresence, now,
    telemetry: deps.telemetry || null, setTimer: deps.setTimer });
  const started = observer.start();
  if (!started.ok) return { ok: false, reason: String(started.reason || "START_FAILED") };

  let hook = null;
  let hookState = "off";
  if (settings.completionHookEnabled) {
    const r = seam.installCompletionHook((snapshot) => observer.onExited(snapshot));
    if (r && r.ok) {
      hook = r;
      hookState = "on";
    } else {
      hookState = `refused:${(r && r.reason) || "no result"}`;
      logger.log(`abyssal: completion hook refused - ${(r && (r.detail || r.reason)) || "no result"} (poll only)`);
    }
  }
  let memo = null;
  let pressurePoller = null;
  if (pressureOn(settings)) {
    const getRegionOf = () => {
      const res = ctx.graph && typeof ctx.graph.getGraph === "function" ? ctx.graph.getGraph() : null;
      const graph = res && res.ok === true && res.graph ? res.graph : null;
      if (!graph) return null;
      return (id) => {
        const v = graph.getSystem(id);
        return v && Number.isSafeInteger(v.regionId) ? v.regionId : null;
      };
    };
    memo = createPressureMemo({ listFinished: (q) => repository.listFinished(q), getRegionOf, now, settings,
      telemetry: deps.telemetry || null });
    pressurePoller = createPoller({ runPass: () => { memo.refresh(now()); }, intervalMs: settings.pressureRefreshMs,
      now, setTimer: deps.setTimer, onError: noop });
    const ps = pressurePoller.start();
    if (ps.ok) pressurePoller.arm(0);
  }
  const view = registerAbyssalRunsView({ views: ctx.views || null, repository, viewLimit: settings.viewLimit, now,
    getPresence, graph: ctx.graph || null, getGovernor: () => ctx.governor || null, log: (l) => logger.log(l),
    getPressure: () => memo });
  let stopped = false;

  function pressureRead(fn) {
    if (stopped) return { ok: false, reason: UNAVAILABLE };
    if (memo === null) return { ok: false, reason: PRESSURE_DISABLED };
    try {
      return fn(memo);
    } catch (_err) {
      return { ok: false, reason: UNAVAILABLE };
    }
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (pressurePoller) pressurePoller.stop();
    observer.stop();
    if (hook) {
      try {
        hook.uninstall();
      } catch (_err) {
      }
      hook = null;
    }
    if (view) view.unregister();
  }

  function getStatus() {
    return Object.freeze({ available: !stopped, reason: stopped ? UNAVAILABLE : null, hook: hookState,
      seam: seam.stats(), observer: observer.getStatus(),
      ...(memo !== null ? { pressure: memo.getStatus() } : {}) });
  }

  const abyssal = Object.freeze({
    getStatus,
    listActive: () => (stopped ? { ok: false, reason: UNAVAILABLE } : publicRuns(repository.listActive())),
    listFinished: (q) => (stopped ? { ok: false, reason: UNAVAILABLE } : publicRuns(repository.listFinished(q))),
    getRun: (instanceId) => {
      if (stopped) return { ok: false, reason: UNAVAILABLE };
      const r = repository.getRun(instanceId);
      return r && r.ok === true ? { ok: true, run: r.run ? publicRun(r.run) : null } : r;
    },
    pressureOf: (regionId) => pressureRead((m) => m.pressureOf(regionId)),
    topRegions: (limit) => pressureRead((m) => m.topRegions(limit)),
    stop,
  });
  logger.log(`abyssal: running hook=${hookState} open=${started.open} poll=${settings.pollMs}ms`);
  return { ok: true, abyssal };
}

module.exports = { startAbyssal, createUnavailableAbyssal, settingsOf };
