"use strict";

const { isModuleEnabled } = require("../../config");
const { createPoller } = require("../presence/poller");
const { rowBoundsOfConfig, rowBoundOverflow } = require("../strategy/reviewBound");
const { createSightingRepository } = require("./repository");
const { createListeningPostService } = require("./service");
const { effectRowsOf } = require("./rules");
const { LAYER_ID, buildListeningPostsLayer } = require("./view");
const S = require("./schema");

const FACADE_METHODS = Object.freeze(["getMode", "getStatus", "markersFor", "stop"]);
const INT_KEYS = Object.freeze([["rangeJumps", 0, 1], ["maxChecksPerLeg", 1, 16], ["maxEnqueuesPerTransaction", 1, 8],
  ["maxSightingsPerPass", 1, 256], ["smallMaxShips", 1, 64], ["largeMinShips", 2, 2000],
  ["sightingRetentionMs", 3600000, 604800000], ["pruneBatch", 1, 500], ["watchRefreshMs", 5000, 600000],
  ["mailMaxRecipients", 1, 50], ["maxCorpsPerSighting", 1, 16], ["mapMaxMarkers", 1, 500],
  ["mapWindowMs", 60000, 86400000]]);
const REQUIRED = Object.freeze(["persistence.store.transaction", "persistence.store.getTxSeq",
  "scheduler.registerHandler", "scheduler.enqueue", "scheduler.getStatus", "fleets.repository.getFleet",
  "fleets.travel.addDepartureListener"]);
const STATE_READY = "ready";
const MAX_DETAIL = 120;

const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);

function swallow(fn) {
  try {
    fn();
  } catch (_err) {
  }
}

function stateOf(facade) {
  try {
    return facade && typeof facade.getStatus === "function" ? facade.getStatus().state : null;
  } catch (_err) {
    return null;
  }
}

function missingPaths(roots) {
  const out = [];
  for (const path of REQUIRED) {
    const parts = path.split(".");
    let v = roots[parts[0]];
    for (let i = 1; i < parts.length && v; i += 1) v = v[parts[i]];
    if (typeof v !== "function") out.push(path);
  }
  return out;
}

function settingsOf(config) {
  const s = config && config.listeningPost;
  if (!s) return { ok: false, key: "listeningPost" };
  for (const [key, min, max] of INT_KEYS) {
    if (!Number.isSafeInteger(s[key]) || s[key] < min || s[key] > max) return { ok: false, key: `listeningPost.${key}` };
  }
  if (typeof s.mailEnabled !== "boolean") return { ok: false, key: "listeningPost.mailEnabled" };
  return { ok: true, settings: Object.freeze({ ...Object.fromEntries(INT_KEYS.map(([k]) => [k, s[k]])),
    mailEnabled: s.mailEnabled }) };
}

function createUnavailableListeningPosts(reason, detail) {
  const status = Object.freeze({ state: "unavailable", mode: "off", reason: String(reason),
    ...(detail ? { detail: String(detail) } : {}), counters: Object.freeze({}), lastRefusal: null });
  return Object.freeze({ getMode: () => "off", getStatus: () => status,
    markersFor: () => ({ ok: false, reason: "LISTENING_POST_OFF" }), stop() {} });
}

function startListeningPosts(deps) {
  const registrations = [];
  const removeAll = () => {
    for (const r of registrations.splice(0).reverse()) swallow(() => r());
  };
  try {
    const { config, persistence, scheduler, fleets } = deps || {};
    if (!isModuleEnabled(config, "strategy") || !config.listeningPost || config.listeningPost.enabled !== true) {
      return { ok: false, reason: "disabled_by_config" };
    }
    const parsed = settingsOf(config);
    if (!parsed.ok) return { ok: false, reason: "INVALID_CONFIG", detail: parsed.key };
    const C = parsed.settings;
    const maxRows = config.persistence ? config.persistence.maxRowsPerTransaction : undefined;
    const rows = effectRowsOf(C);
    if (!Number.isSafeInteger(maxRows) || rows > maxRows) {
      return { ok: false, reason: "LISTENING_POST_ROW_BOUND",
        detail: `sighting effect=${rows} > persistence.maxRowsPerTransaction=${maxRows}` };
    }
    const over = rowBoundOverflow(rowBoundsOfConfig(config), maxRows);
    if (over) return { ok: false, reason: "LISTENING_POST_ROW_BOUND", detail: over };
    if (!persistence || persistence.ok !== true || !persistence.store) {
      return { ok: false, reason: "dependency_disabled:persistence" };
    }
    if (!scheduler || stateOf(scheduler) !== STATE_READY) return { ok: false, reason: "SCHEDULER_UNAVAILABLE" };
    const missing = missingPaths({ persistence, scheduler, fleets });
    if (missing.length > 0) return { ok: false, reason: "LISTENING_POST_FACADE_MISSING", detail: missing.join(",") };
    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    const clock = deps.clock && typeof deps.clock.now === "function" ? deps.clock : { now: () => Date.now() };
    const repo = createSightingRepository();
    const service = createListeningPostService({ store: persistence.store, scheduler,
      fleetRepository: fleets.repository, repo, settings: C, getSentries: deps.getSentries,
      getGraph: deps.getGraph, clock, telemetry: deps.telemetry || null, logger,
      adapter: deps.adapter || null, getNotices: deps.getNotices });

    let handler;
    try {
      handler = scheduler.registerHandler(S.EVENT_TYPE, service.onSighting, { maxPerPass: C.maxSightingsPerPass });
    } catch (err) {
      handler = { ok: false, reason: messageOf(err) };
    }
    if (!handler || handler.ok !== true) {
      return { ok: false, reason: "LISTENING_POST_START_FAILED",
        detail: `handler ${S.EVENT_TYPE}: ${(handler && handler.reason) || "no result"}` };
    }
    registrations.push(() => handler.unregister());
    const listener = fleets.travel.addDepartureListener(service.onDeparture);
    if (!listener || listener.ok !== true) {
      removeAll();
      return { ok: false, reason: "LISTENING_POST_START_FAILED",
        detail: `departure listener: ${(listener && listener.reason) || "no result"}` };
    }
    registrations.push(() => listener.remove());
    service.refreshWatch();
    const poller = createPoller({ runPass: () => service.refreshWatch(), intervalMs: C.watchRefreshMs,
      now: typeof deps.nowMs === "function" ? deps.nowMs : () => clock.now(),
      ...(typeof deps.setTimer === "function" ? { setTimer: deps.setTimer } : {}) });
    const started = poller.start();
    if (!started || started.ok !== true) {
      removeAll();
      return { ok: false, reason: "LISTENING_POST_START_FAILED",
        detail: `watch timer: ${(started && started.reason) || "no result"}` };
    }
    registrations.push(() => poller.stop());
    const views = deps.views;
    const observer = config.observer || {};
    if (observer.galaxyEnabled === true && views && typeof views.registerView === "function") {
      try {
        const r = views.registerView(LAYER_ID, buildListeningPostsLayer({ store: persistence.store, repo,
          getPosts: service.postsSnapshot, clock, getGovernor: deps.getGovernor,
          settings: { mapWindowMs: C.mapWindowMs, maxSystems: observer.sentriesMaxRows, refreshMs: C.watchRefreshMs } }));
        if (r && r.ok === true) registrations.push(() => r.unregister());
        else logger.log(`listeningPost: view ${LAYER_ID} not registered - ${(r && r.reason) || "no result"}`);
      } catch (err) {
        logger.log(`listeningPost: view ${LAYER_ID} not registered - ${messageOf(err)}`);
      }
    }
    logger.log(`listeningPost: on range=${C.rangeJumps} checks/leg=${C.maxChecksPerLeg} `
      + `budget=${C.maxEnqueuesPerTransaction} refreshMs=${C.watchRefreshMs} watched=${service.watchedSystems().length}`);

    const facade = {
      getMode: service.getMode,
      getStatus: () => Object.freeze({ ...service.getStatus(), listeners: service.isStopped() ? 0 : 1 }),
      markersFor: service.markersFor,
      stop() {
        if (service.isStopped()) return;
        service.stop();
        removeAll();
      },
    };
    return { ok: true, listeningPosts: Object.freeze(facade) };
  } catch (err) {
    removeAll();
    return { ok: false, reason: "LISTENING_POST_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startListeningPosts, createUnavailableListeningPosts, settingsOf, FACADE_METHODS, REQUIRED };
