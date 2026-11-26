"use strict";

const { createPresenceIndex } = require("./presenceIndex");
const { createRadiusIndex } = require("./radius");
const { createPoller } = require("./poller");
const { LAYER_ID, buildPlayersLayerView } = require("./playersLayer");

const REASON = Object.freeze({
  UNAVAILABLE: "PRESENCE_UNAVAILABLE",
  DISABLED: "PRESENCE_DISABLED",
  CONFIG_INVALID: "PRESENCE_CONFIG_INVALID",
  SESSIONS_UNAVAILABLE: "SESSIONS_UNAVAILABLE",
  GRAPH_NOT_READY: "GRAPH_NOT_READY",
  LISTENER_INVALID: "LISTENER_INVALID",
});
const STRUCTURAL_READ_REFUSALS = Object.freeze(["server_src_unknown", "not_in_game_modules", "file_not_found"]);
const INT_KEYS = Object.freeze(["pollMs", "neighborRadius", "maxRadius", "maxCharacters"]);

function noop() {}

function messageOf(err) {
  return String((err && err.message) || err);
}

function round1(ms) {
  return Math.round(ms * 10) / 10;
}

function defaultNow() {
  return globalThis.performance.now();
}

function createUnavailablePresence(reason, detail) {
  const refusal = () => ({ ok: false, reason: REASON.UNAVAILABLE });
  return Object.freeze({
    isObserved: () => false,
    observedSystems: () => [],
    getSystemPresence: () => null,
    listPresence: () => [],
    onSystemObserved: refusal,
    onSystemUnobserved: refusal,
    distanceToObserved: refusal,
    observedWithin: refusal,
    getVersion: () => 0,
    refreshNow: refusal,
    getStatus: () => Object.freeze({ available: false, reason: String(reason || REASON.UNAVAILABLE),
      ...(detail ? { detail: String(detail) } : {}) }),
    stop: noop,
  });
}

function settingsOf(config) {
  const p = (config && config.presence) || null;
  if (!p || typeof p.hookEnabled !== "boolean" || !INT_KEYS.every((k) => Number.isSafeInteger(p[k]))) return null;
  return p;
}

function startPresence(deps) {
  const adapter = deps.adapter;
  if (!adapter || typeof adapter.readPresence !== "function") return { ok: false, reason: "adapter_unavailable" };
  const settings = settingsOf(deps.config);
  if (!settings) return { ok: false, reason: REASON.CONFIG_INVALID };
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log: noop };
  const now = typeof deps.now === "function" ? deps.now : defaultNow;
  const telemetry = deps.telemetry || null;
  const graphFacade = deps.graph || null;
  const observer = (deps.config && deps.config.observer) || {};

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  }

  const index = createPresenceIndex({ onCallbackError: () => metric("count", "presence.callbackErrors", 1) });
  const radiusIndex = createRadiusIndex(index);
  let lastPollMs = null;
  let readErrors = 0;
  let nudges = 0;
  let stopped = false;
  let hook = null;
  let hookState = "off";
  let viewHandle = null;

  function pass() {
    const t0 = now();
    let read;
    try {
      read = adapter.readPresence({ maxCharacters: settings.maxCharacters });
    } catch (err) {
      read = { ok: false, reason: REASON.SESSIONS_UNAVAILABLE, detail: `readPresence threw: ${messageOf(err)}` };
    }
    let changed = false;
    if (!read || read.ok !== true) {
      readErrors += 1;
      const reason = String((read && read.reason) || "no result");
      index.markStale(read && read.detail ? `${reason}: ${read.detail}` : reason);
      metric("count", "presence.readErrors", 1);
    } else {
      changed = index.apply(read).changed;
      if (read.truncated) metric("count", "presence.truncated", 1);
      if (changed) metric("count", "presence.changes", 1);
    }
    lastPollMs = round1(now() - t0);
    const st = index.getState();
    metric("observe", "presence.passMs", lastPollMs);
    metric("gauge", "presence.characters", st.characters);
    metric("gauge", "presence.systems", st.systems);
    return { ok: Boolean(read && read.ok === true), changed, read };
  }

  const first = pass();
  if (!first.ok && STRUCTURAL_READ_REFUSALS.includes(first.read && first.read.reason)) {
    return { ok: false, reason: REASON.SESSIONS_UNAVAILABLE, detail: String(first.read.reason) };
  }

  const poller = createPoller({
    runPass: () => { pass(); },
    intervalMs: settings.pollMs,
    now,
    setTimer: deps.setTimer,
    onError: () => metric("count", "presence.readErrors", 1),
    pacing: false,
  });

  if (settings.hookEnabled) {
    let r;
    try {
      r = typeof adapter.subscribeSessionNudges === "function"
        ? adapter.subscribeSessionNudges(() => {
          nudges += 1;
          metric("count", "presence.nudges", 1);
          poller.arm(0);
        })
        : { ok: false, reason: "adapter_unavailable" };
    } catch (err) {
      r = { ok: false, reason: `threw: ${messageOf(err)}` };
    }
    if (r && r.ok) {
      hook = r;
      hookState = "on";
    } else {
      hookState = `refused:${(r && r.reason) || "no result"}`;
    }
  }
  poller.start();

  function clampRadius(radius) {
    let r = radius === undefined || radius === null ? settings.neighborRadius : Math.trunc(Number(radius));
    if (!Number.isFinite(r)) r = settings.neighborRadius;
    return Math.max(0, Math.min(settings.maxRadius, r));
  }

  function currentGraph() {
    if (!graphFacade || typeof graphFacade.getGraph !== "function") return null;
    try {
      const g = graphFacade.getGraph();
      return g && g.ok && g.graph && typeof g.graph.getNeighbors === "function" ? g.graph : null;
    } catch (_err) {
      return null;
    }
  }

  function distanceToObserved(systemId, radius) {
    if (stopped) return { ok: false, reason: REASON.UNAVAILABLE };
    const graph = currentGraph();
    if (!graph) return { ok: false, reason: REASON.GRAPH_NOT_READY };
    const d = radiusIndex.distances(graph, clampRadius(radius)).get(Number(systemId));
    return { ok: true, distance: d === undefined ? null : d };
  }

  function observedWithin(radius) {
    if (stopped) return { ok: false, reason: REASON.UNAVAILABLE };
    const graph = currentGraph();
    if (!graph) return { ok: false, reason: REASON.GRAPH_NOT_READY };
    const systems = [...radiusIndex.distances(graph, clampRadius(radius))]
      .sort((a, b) => a[0] - b[0])
      .map((e) => Object.freeze(e));
    return { ok: true, systems: Object.freeze(systems) };
  }

  function getStatus() {
    const st = index.getState();
    return Object.freeze({
      available: !stopped,
      reason: stopped ? REASON.UNAVAILABLE : null,
      stale: st.stale,
      staleReason: st.staleReason,
      version: st.version,
      characters: st.characters,
      systems: st.systems,
      hook: hookState,
      pollMs: settings.pollMs,
      lastPollMs,
      callbackErrors: st.callbackErrors,
      truncated: st.truncated,
      nudges,
      readErrors,
    });
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    poller.stop();
    if (hook) {
      try {
        hook.unwrap();
      } catch (_err) {
      }
      hook = null;
    }
    index.clearListeners();
    if (viewHandle) {
      viewHandle.unregister();
      viewHandle = null;
    }
  }

  const presence = Object.freeze({
    isObserved: (systemId) => index.isObserved(systemId),
    observedSystems: () => index.observedSystems(),
    getSystemPresence: (systemId) => index.getSystemPresence(systemId),
    listPresence: () => index.listPresence(),
    onSystemObserved: (cb) => (stopped ? { ok: false, reason: REASON.UNAVAILABLE } : index.onSystemObserved(cb)),
    onSystemUnobserved: (cb) => (stopped ? { ok: false, reason: REASON.UNAVAILABLE } : index.onSystemUnobserved(cb)),
    distanceToObserved,
    observedWithin,
    getVersion: () => index.getVersion(),
    refreshNow() {
      if (stopped) return { ok: false, reason: REASON.UNAVAILABLE };
      const r = pass();
      return { ok: r.ok, changed: r.changed };
    },
    getStatus,
    stop,
  });

  const views = deps.views;
  if (observer.galaxyEnabled === true && observer.galaxyPlayersEnabled === true
    && views && typeof views.registerView === "function") {
    const r = views.registerView(LAYER_ID, buildPlayersLayerView({ presence,
      maxNames: observer.galaxyPlayersMaxNames }));
    if (r && r.ok) viewHandle = r;
    else logger.log(`presence: view ${LAYER_ID} not registered - ${(r && r.reason) || "no result"}`);
  }

  const st = getStatus();
  logger.log(`presence: running characters=${st.characters} systems=${st.systems} hook=${st.hook}`
    + ` poll=${st.pollMs}ms${st.stale ? ` stale=${st.staleReason}` : ""}`);
  return { ok: true, presence };
}

module.exports = { REASON, startPresence, createUnavailablePresence };
