"use strict";

const { createPoller } = require("../presence/poller");
const { settingsOf } = require("./schema");
const { createPopulationService } = require("./service");

const VIEW = require("./view");

const POPULATION_METHODS = Object.freeze(["getStatus", "countIn", "listIn", "pilot", "runPass", "whenReady", "stop",
  "tierOf", "arrivalsInto", "onTierChange", "localIdsIn", "liveCandidatesIn", "claimLive", "releaseLive",
  "liveGroupOf", "releaseGroupMember"]);

const messageOf = (err) => String((err && err.message) || err);
const EMPTY = Object.freeze([]);

function createUnavailablePopulation(reason, detail) {
  const status = Object.freeze({ state: String(reason) === "disabled_by_config" ? "disabled_by_config" : "unavailable",
    reason: String(reason), ...(detail ? { detail: String(detail) } : {}) });
  const refusal = Object.freeze({ ok: false, reason: String(reason) });
  return Object.freeze({ getStatus: () => status, countIn: () => 0, listIn: () => EMPTY, pilot: () => null,
    runPass: () => refusal, whenReady: () => Promise.resolve(status.state),
    stop: () => Object.freeze({ ok: true, flushed: 0 }), tierOf: () => "FAR", arrivalsInto: () => EMPTY,
    onTierChange: () => refusal, localIdsIn: () => EMPTY,
    liveCandidatesIn: () => EMPTY, claimLive: () => refusal,
    releaseLive: () => Object.freeze({ ok: true, applied: false }),
    liveGroupOf: () => refusal, releaseGroupMember: () => Object.freeze({ ok: true, applied: false }) });
}

function registerViews(deps, service, S, log) {
  const views = deps.views;
  if (!views || typeof views.registerView !== "function") return [];
  const defs = [];
  if (S.observer.panelEnabled === true) {
    defs.push([VIEW.VIEW_ID, () => VIEW.buildPopulationPanel({ service, settings: S, clock: deps.clock })]);
  }
  const observer = (deps.config && deps.config.observer) || {};
  if (observer.galaxyEnabled === true && S.observer.layerEnabled === true) {
    defs.push([VIEW.LAYER_ID, () => VIEW.buildPopulationLayer({ service, settings: S, clock: deps.clock })]);
  }
  const out = [];
  for (const [id, build] of defs) {
    try {
      const r = views.registerView(id, build());
      if (r && r.ok === true && typeof r.unregister === "function") out.push(() => r.unregister());
      else log(`population: view ${id} not registered - ${(r && r.reason) || "no result"}`);
    } catch (err) {
      log(`population: view ${id} not registered - ${messageOf(err)}`);
    }
  }
  return out;
}

function startPopulation(deps) {
  try {
    const { config, persistence, clock } = deps || {};
    const S = settingsOf(config);
    if (!S || S.enabled !== true) return { ok: false, reason: "disabled_by_config" };
    if (!persistence || persistence.ok !== true || !persistence.store) {
      return { ok: false, reason: "dependency_disabled:persistence" };
    }
    if (!clock || typeof clock.now !== "function") {
      return { ok: false, reason: "POPULATION_START_FAILED", detail: "clock" };
    }
    const worldSeed = Number.isSafeInteger(deps.worldSeed) ? deps.worldSeed
      : Number.isSafeInteger(persistence.worldSeed) ? persistence.worldSeed : null;
    if (worldSeed === null) return { ok: false, reason: "POPULATION_START_FAILED", detail: "worldSeed" };
    for (const k of ["getGraph", "listStations", "buildHubDistance"]) {
      if (typeof deps[k] !== "function") return { ok: false, reason: "POPULATION_START_FAILED", detail: k };
    }
    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    const T = config.telemetry || {};
    const service = createPopulationService({ store: persistence.store, worldSeed, settings: S, clock,
      telemetry: deps.telemetry || null, logger, getGraph: deps.getGraph, getGovernor: deps.getGovernor,
      listStations: deps.listStations, buildHubDistance: deps.buildHubDistance, yieldTurn: deps.yieldTurn,
      nowMs: deps.nowMs, slowOpMs: T.slowOpMs, slowOpLogPerMin: T.slowOpLogPerMin, getPresence: deps.getPresence,
      liveMaxOwned: deps.liveMaxOwned, contextSources: deps.contextSources, standingFactions: deps.standingFactions,
      generateName: deps.generateName });
    const unregisterViews = registerViews(deps, service, S, (line) => logger.log(line));
    const poller = createPoller({
      runPass: () => service.runPass(clock.now()),
      intervalMs: S.passIntervalMs,
      now: () => clock.now(),
      setTimer: deps.setTimer,
      onError: (err) => logger.log(`population: pass threw - ${messageOf(err)}`),
    });
    service.boot().then((st) => {
      if (st !== "running" || service.isStopped()) return;
      const started = poller.start();
      if (!started.ok) logger.log(`population: poller not started - ${started.reason}`);
    }, (err) => logger.log(`population: boot rejected - ${messageOf(err)}`));
    const facade = {
      getStatus: () => service.getStatus(),
      countIn: (systemId) => service.countIn(systemId),
      listIn: (systemId, limit) => service.listIn(systemId, limit),
      localIdsIn: (systemId, limit) => service.localIdsIn(systemId, limit),
      pilot: (pilotId) => service.pilot(pilotId),
      runPass: (now) => service.runPass(now),
      whenReady: () => service.whenReady(),
      tierOf: (systemId) => service.tierOf(systemId),
      arrivalsInto: (systemId, sinceMs, limit) => service.arrivalsInto(systemId, sinceMs, limit),
      onTierChange: (cb) => service.onTierChange(cb),
      liveCandidatesIn: (systemId, sinceMs, limit, acceptHull) => service.liveCandidatesIn(systemId, sinceMs, limit,
        acceptHull),
      claimLive: (pilotId, systemId, now) => service.claimLive(pilotId, systemId, now),
      releaseLive: (pilotId, token, outcome, now) => service.releaseLive(pilotId, token, outcome, now),
      liveGroupOf: (leaderId, systemId, now) => service.liveGroupOf(leaderId, systemId, now),
      releaseGroupMember: (memberId, leaderId, token, now) => service.releaseGroupMember(memberId, leaderId, token, now),
      stop() {
        poller.stop();
        for (const unregister of unregisterViews) {
          try {
            unregister();
          } catch (_err) {
          }
        }
        return service.stop();
      },
    };
    return { ok: true, population: Object.freeze(facade) };
  } catch (err) {
    return { ok: false, reason: "POPULATION_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startPopulation, createUnavailablePopulation, POPULATION_METHODS };
