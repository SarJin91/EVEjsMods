"use strict";

const { isModuleEnabled } = require("../../../config");
const { createTripRepository } = require("./tripRepository");
const { createMiningService } = require("./miningService");
const { VIEW_ID, buildMiningView } = require("./miningView");
const { EVENT_TYPE } = require("../schema");
const { createIndustryCatalog } = require("../industry/catalog");

const SCHEDULER_READY = "ready";

function messageOf(err) {
  return String((err && err.message) || err);
}

function swallow(fn) {
  try {
    fn();
  } catch (_err) {
  }
}

function createUnavailableMining(reason, detail) {
  const refusal = Object.freeze({ ok: false, reason: "MINING_UNAVAILABLE", detail: String(reason)
    + (detail ? `: ${detail}` : "") });
  const status = Object.freeze({ state: "unavailable", reason: String(reason) });
  const refuse = () => refusal;
  return Object.freeze({ getMode: () => "off", richnessOf: refuse, dispatchInTx: refuse,
    releaseOrphanInTx: refuse, readSiteState: refuse, readOwnSpaceSites: refuse, readMinerTargets: refuse,
    readBeltCooldowns: refuse, count() {}, noteRefusal() {}, getStatus: () => status, reconcile: refuse, stop() {} });
}

function readFactionNames(adapter) {
  if (!adapter || typeof adapter.readFactionNames !== "function") return new Map();
  try {
    const r = adapter.readFactionNames();
    return r && r.ok && r.names instanceof Map ? r.names : new Map();
  } catch (_err) {
    return new Map();
  }
}

function startMining(deps) {
  try {
    const { config, persistence, clock, ids, scheduler } = deps || {};
    if (!isModuleEnabled(config, "strategy") || !config.mining || config.mining.enabled !== true) {
      return { ok: false, reason: "disabled_by_config" };
    }
    if (!persistence || persistence.ok !== true || !persistence.store || !persistence.journal) {
      return { ok: false, reason: "dependency_disabled:persistence" };
    }
    let schedulerState = null;
    try {
      schedulerState = scheduler && typeof scheduler.getStatus === "function" ? scheduler.getStatus().state : null;
    } catch (_err) {
      schedulerState = null;
    }
    if (!scheduler || typeof scheduler.registerHandler !== "function" || schedulerState !== SCHEDULER_READY) {
      return { ok: false, reason: "SCHEDULER_UNAVAILABLE" };
    }
    const fleets = deps.fleets;
    if (!fleets || !fleets.repository || !fleets.travel || typeof fleets.travel.planInTx !== "function"
      || typeof fleets.travel.addArrivalListener !== "function") {
      return { ok: false, reason: "FLEETS_UNAVAILABLE" };
    }
    const world = deps.world;
    if (!world || !world.repository || typeof world.repository.getSystem !== "function") {
      return { ok: false, reason: "WORLD_UNAVAILABLE" };
    }
    if (!clock || typeof clock.now !== "function" || !ids || typeof ids.next !== "function") {
      return { ok: false, reason: "MINING_START_FAILED", detail: "clock/ids" };
    }
    const made = deps.industryCatalog !== undefined ? { ok: true, catalog: deps.industryCatalog }
      : createIndustryCatalog();
    if (!made.ok) {
      return { ok: false, reason: "MINING_START_FAILED", detail: `industry catalog: ${made.reason}: ${made.detail}` };
    }
    if (!made.catalog || typeof made.catalog.oreBand !== "function") {
      return { ok: false, reason: "MINING_START_FAILED", detail: "industry catalog: invalid seam" };
    }
    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    const store = persistence.store;
    const trips = createTripRepository({ journal: persistence.journal, clock });
    const service = createMiningService({ store, journal: persistence.journal, trips, fleets, scheduler, world,
      getStations: deps.getStations, graph: deps.graph || null, adapter: deps.adapter || null, clock, ids, config,
      telemetry: deps.telemetry || null, logger, nowMs: deps.nowMs, industryCatalog: made.catalog,
      registry: (deps.strategy && deps.strategy.registry) || null });

    let registration;
    try {
      registration = scheduler.registerHandler(EVENT_TYPE, service.handler,
        { maxPerPass: config.mining.maxStepsPerPass });
    } catch (err) {
      registration = { ok: false, reason: messageOf(err) };
    }
    if (!registration || !registration.ok) {
      return { ok: false, reason: "MINING_START_FAILED",
        detail: `handler ${EVENT_TYPE}: ${(registration && registration.reason) || "no result"}` };
    }
    const listener = fleets.travel.addArrivalListener(service.onArrival);
    if (!listener || !listener.ok) {
      swallow(() => registration.unregister());
      return { ok: false, reason: "MINING_START_FAILED", detail: "arrival listener" };
    }

    const rec = service.reconcile();
    if (!rec.ok) logger.log(`mining: reconcile failed ${rec.reason}; the next start retries`);
    else if (rec.enqueued > 0) logger.log(`mining: reconcile open=${rec.open} enqueued=${rec.enqueued}`);

    let viewHandle = null;
    const views = deps.views;
    if (views && typeof views.registerView === "function") {
      const registry = deps.strategy && deps.strategy.registry;
      const r = views.registerView(VIEW_ID, buildMiningView({ store, trips, clock, getStatus: service.getStatus,
        getGovernor: deps.getGovernor, graph: deps.graph || null, factionNames: readFactionNames(deps.adapter),
        getStations: deps.getStations,
        factionIds: () => (registry && typeof registry.listActiveFactions === "function"
          ? registry.listActiveFactions().map((f) => f.factionId) : []) }));
      if (r && r.ok) viewHandle = r;
      else logger.log(`mining: view ${VIEW_ID} not registered - ${(r && r.reason) || "no result"}`);
    }

    const graph = deps.graph;
    if (!graph || typeof graph.whenReady !== "function") service.warmUp();
    else {
      Promise.resolve(graph.whenReady()).then(() => {
        try {
          service.warmUp();
        } catch (err) {
          logger.log(`mining: warm-up failed - ${messageOf(err)}`);
        }
      }, () => {});
    }

    const facade = {
      getMode: service.getMode,
      richnessOf: service.richnessOf,
      dispatchInTx: service.dispatchInTx,
      releaseOrphanInTx: service.releaseOrphanInTx,
      readSiteState: service.readSiteState,
      readOwnSpaceSites: service.readOwnSpaceSites,
      readMinerTargets: service.readMinerTargets,
      readBeltCooldowns: service.readBeltCooldowns,
      count: service.count,
      noteRefusal: service.noteRefusal,
      reconcile: service.reconcile,
      trips,
      getStatus: () => Object.freeze({ ...service.getStatus(), view: viewHandle !== null }),
      stop() {
        if (service.isStopped()) return;
        service.stop();
        swallow(() => registration.unregister());
        swallow(() => listener.remove());
        if (viewHandle) {
          const handle = viewHandle;
          viewHandle = null;
          swallow(() => handle.unregister());
        }
      },
    };
    return { ok: true, mining: Object.freeze(facade) };
  } catch (err) {
    return { ok: false, reason: "MINING_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startMining, createUnavailableMining };
