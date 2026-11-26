"use strict";

const { isModuleEnabled } = require("../../../config");
const { createConvoyRepository } = require("./convoyRepository");
const { createLogisticsService } = require("./logisticsService");
const { VIEW_ID, buildLogisticsView } = require("./logisticsView");
const { CONVOY_EVENT_TYPE } = require("../schema");
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

function createUnavailableLogistics(reason, detail) {
  const refusal = Object.freeze({ ok: false, reason: "LOGISTICS_UNAVAILABLE", detail: String(reason)
    + (detail ? `: ${detail}` : "") });
  const status = Object.freeze({ state: "unavailable", reason: String(reason) });
  const refuse = () => refusal;
  return Object.freeze({ getMode: () => "off", dispatchInTx: refuse, readOpen: refuse, listInTransitInTx: refuse,
    listLostInTx: refuse,
    count() {}, noteRefusal() {},
    getStatus: () => status, reconcile: refuse, findLastEndedOfFaction: refuse, stop() {} });
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

function startLogistics(deps) {
  try {
    const { config, persistence, clock, ids, scheduler } = deps || {};
    if (!isModuleEnabled(config, "strategy") || !config.logistics || config.logistics.enabled !== true) {
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
    if (!clock || typeof clock.now !== "function" || !ids || typeof ids.next !== "function") {
      return { ok: false, reason: "LOGISTICS_START_FAILED", detail: "clock/ids" };
    }
    const made = deps.industryCatalog !== undefined ? { ok: true, catalog: deps.industryCatalog }
      : createIndustryCatalog();
    if (!made.ok) {
      return { ok: false, reason: "LOGISTICS_START_FAILED", detail: `industry catalog: ${made.reason}: ${made.detail}` };
    }
    if (!made.catalog || typeof made.catalog.hull !== "function") {
      return { ok: false, reason: "LOGISTICS_START_FAILED", detail: "industry catalog: invalid seam" };
    }
    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    const store = persistence.store;
    const convoys = createConvoyRepository({ journal: persistence.journal, clock });
    const tributeRegistry = deps.strategy && deps.strategy.registry;
    const service = createLogisticsService({ store, journal: persistence.journal, convoys, fleets, scheduler,
      getStations: deps.getStations, getConstruction: deps.getConstruction, clock, ids, config,
      telemetry: deps.telemetry || null, logger, nowMs: deps.nowMs, industryCatalog: made.catalog,
      tributeRecipientOf: (f) => (tributeRegistry && typeof tributeRegistry.tributeRecipientOf === "function"
        ? tributeRegistry.tributeRecipientOf(f) : null) });

    let registration;
    try {
      registration = scheduler.registerHandler(CONVOY_EVENT_TYPE, service.handler,
        { maxPerPass: config.logistics.maxStepsPerPass });
    } catch (err) {
      registration = { ok: false, reason: messageOf(err) };
    }
    if (!registration || !registration.ok) {
      return { ok: false, reason: "LOGISTICS_START_FAILED",
        detail: `handler ${CONVOY_EVENT_TYPE}: ${(registration && registration.reason) || "no result"}` };
    }
    const listener = fleets.travel.addArrivalListener(service.onArrival);
    if (!listener || !listener.ok) {
      swallow(() => registration.unregister());
      return { ok: false, reason: "LOGISTICS_START_FAILED", detail: "arrival listener" };
    }

    const rec = service.reconcile();
    if (!rec.ok) logger.log(`logistics: reconcile failed ${rec.reason}; the next start retries`);
    else if (rec.enqueued > 0) logger.log(`logistics: reconcile open=${rec.open} enqueued=${rec.enqueued}`);

    let viewHandle = null;
    const views = deps.views;
    if (views && typeof views.registerView === "function") {
      const registry = deps.strategy && deps.strategy.registry;
      const r = views.registerView(VIEW_ID, buildLogisticsView({ store, convoys, clock, getStatus: service.getStatus,
        getGovernor: deps.getGovernor, factionNames: readFactionNames(deps.adapter),
        factionIds: () => (registry && typeof registry.listActiveFactions === "function"
          ? registry.listActiveFactions().map((f) => f.factionId) : []),
        maxOpenRows: config.logistics.maxOpenConvoysPerFaction }));
      if (r && r.ok) viewHandle = r;
      else logger.log(`logistics: view ${VIEW_ID} not registered - ${(r && r.reason) || "no result"}`);
    }

    const facade = {
      getMode: service.getMode,
      dispatchInTx: service.dispatchInTx,
      readOpen: service.readOpen,
      listInTransitInTx: service.listInTransitInTx,
      listLostInTx: service.listLostInTx,
      count: service.count,
      noteRefusal: service.noteRefusal,
      reconcile: service.reconcile,
      findLastEndedOfFaction: (tx, factionId, purpose) => convoys.findLastEndedOfFaction(tx, factionId, purpose),
      convoys,
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
    return { ok: true, logistics: Object.freeze(facade) };
  } catch (err) {
    return { ok: false, reason: "LOGISTICS_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startLogistics, createUnavailableLogistics };
