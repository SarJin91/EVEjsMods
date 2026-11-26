"use strict";

const { isModuleEnabled } = require("../../../config");
const { createBuildRepository } = require("./buildRepository");
const { createConstructionService } = require("./constructionService");
const { BUILD_EVENT_TYPE, constructionDeliverRows } = require("./schema");
const { VIEW_ID, buildConstructionView } = require("./constructionView");

const SCHEDULER_READY = "ready";
const SETTING_KEYS = Object.freeze(["maxOpenBuildsPerFaction", "supplyTimeoutMs", "recheckMs", "anchoringMs",
  "maxLostConvoys", "maxStepsPerPass", "reconcileMaxBuilds", "reconcileMaxAttempts"]);

function messageOf(err) {
  return String((err && err.message) || err);
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

function swallow(fn) {
  try {
    fn();
  } catch (_err) {
  }
}

function createUnavailableConstruction(reason, detail) {
  const refusal = Object.freeze({ ok: false, reason: "CONSTRUCTION_UNAVAILABLE", detail: String(reason)
    + (detail ? `: ${detail}` : "") });
  const status = Object.freeze({ state: "unavailable", reason: String(reason) });
  const refuse = () => refusal;
  return Object.freeze({ getMode: () => "off", getKit: () => null, planInTx: refuse, siteOfInTx: refuse,
    receiveInTx: refuse, onConvoyLostInTx: refuse, failBuildInTx: refuse, readOpen: refuse, noteCommitted() {},
    noteRefusal() {}, getStatus: () => status, whenReady: () => Promise.resolve(status), reconcile: refuse,
    stop() {} });
}

function startConstruction(deps) {
  try {
    const { config, persistence, clock, ids, scheduler } = deps || {};
    if (!isModuleEnabled(config, "strategy") || !config.stations || config.stations.enabled !== true
      || !config.construction || config.construction.enabled !== true) {
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
    const worldRepository = deps.world && deps.world.repository;
    if (!worldRepository || typeof worldRepository.getSystems !== "function") {
      return { ok: false, reason: "WORLD_UNAVAILABLE" };
    }
    const registry = deps.strategy && deps.strategy.registry;
    if (!registry || typeof registry.isActive !== "function" || typeof registry.getFaction !== "function") {
      return { ok: false, reason: "dependency_disabled:strategy" };
    }
    if (!clock || typeof clock.now !== "function" || !ids || typeof ids.next !== "function") {
      return { ok: false, reason: "CONSTRUCTION_START_FAILED", detail: "clock/ids" };
    }
    const C = config.construction;
    for (const key of SETTING_KEYS) {
      if (!Number.isSafeInteger(C[key]) || C[key] < 0) {
        return { ok: false, reason: "CONSTRUCTION_START_FAILED", detail: `construction.${key}` };
      }
    }
    let kits = deps.kitsData || null;
    if (!kits) {
      const made = require("../../economy/industry/catalog").createIndustryCatalog();
      if (!made.ok) return { ok: false, reason: "CONSTRUCTION_START_FAILED", detail: `kits: ${made.detail}` };
      const P = config.production || {};
      const table = require("../data/buildKits").buildKitTable(made.catalog, {
        componentWeightPermille: P.componentWeightPermille, componentFactorMaxPermille: P.componentFactorMaxPermille,
        kitComponentFactorPermille: C.kitComponentFactorPermille });
      if (!table.ok) return { ok: false, reason: "CONSTRUCTION_START_FAILED", detail: `kits: ${table.detail}` };
      kits = table.kits;
    }
    const kit = kits && Object.prototype.hasOwnProperty.call(kits, C.kitId) ? kits[C.kitId] : null;
    if (!kit || !kit.items || Object.keys(kit.items).length === 0) {
      return { ok: false, reason: "CONSTRUCTION_START_FAILED", detail: `construction.kitId ${C.kitId}` };
    }
    const kitKeys = Object.keys(kit.items).length;
    const maxRows = config.persistence && config.persistence.maxRowsPerTransaction;
    if (Number.isSafeInteger(maxRows) && constructionDeliverRows(kitKeys) > maxRows) {
      return { ok: false, reason: "CONSTRUCTION_START_FAILED",
        detail: `deliver rows ${constructionDeliverRows(kitKeys)} > persistence.maxRowsPerTransaction ${maxRows}` };
    }
    const maxDeltas = config.stations.maxDeltasPerChange;
    if (Number.isSafeInteger(maxDeltas) && kitKeys > maxDeltas) {
      return { ok: false, reason: "CONSTRUCTION_START_FAILED", detail: `kit items ${kitKeys} > stations.`
        + `maxDeltasPerChange ${maxDeltas}` };
    }
    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    const store = persistence.store;
    const builds = createBuildRepository({ journal: persistence.journal });
    const service = createConstructionService({ store, journal: persistence.journal, builds, scheduler,
      getStations: deps.getStations, worldRepository, registry, kits, clock, ids, config,
      telemetry: deps.telemetry || null, logger, nowMs: deps.nowMs });

    let registration;
    try {
      registration = scheduler.registerHandler(BUILD_EVENT_TYPE, service.handler,
        { maxPerPass: C.maxStepsPerPass });
    } catch (err) {
      registration = { ok: false, reason: messageOf(err) };
    }
    if (!registration || !registration.ok) {
      return { ok: false, reason: "CONSTRUCTION_START_FAILED",
        detail: `handler ${BUILD_EVENT_TYPE}: ${(registration && registration.reason) || "no result"}` };
    }

    const rec = service.reconcile();
    if (!rec.ok) logger.log(`construction: reconcile failed ${rec.reason}; the next start retries`);
    else if (rec.enqueued > 0) logger.log(`construction: reconcile open=${rec.open} enqueued=${rec.enqueued}`);

    let viewHandle = null;
    const views = deps.views;
    const panelRows = config.observer && config.observer.constructionPanelMaxRows;
    if (views && typeof views.registerView === "function" && Number.isSafeInteger(panelRows) && panelRows > 0) {
      const r = views.registerView(VIEW_ID, buildConstructionView({ store, builds, getStatus: service.getStatus,
        getGovernor: deps.getGovernor, graph: deps.graph || null, factionNames: readFactionNames(deps.adapter),
        maxRows: panelRows }));
      if (r && r.ok) viewHandle = r;
      else logger.log(`construction: view ${VIEW_ID} not registered - ${(r && r.reason) || "no result"}`);
    }

    const facade = {
      getMode: service.getMode,
      getKit: service.getKit,
      planInTx: service.planInTx,
      siteOfInTx: service.siteOfInTx,
      receiveInTx: service.receiveInTx,
      onConvoyLostInTx: service.onConvoyLostInTx,
      failBuildInTx: service.failBuildInTx,
      readOpen: service.readOpen,
      noteCommitted: service.noteCommitted,
      noteRefusal: service.noteRefusal,
      reconcile: service.reconcile,
      builds,
      getStatus: service.getStatus,
      whenReady() {
        let wait = null;
        try {
          const st = typeof deps.getStations === "function" ? deps.getStations() : null;
          wait = st && typeof st.whenReady === "function" ? st.whenReady() : null;
        } catch (_err) {
          wait = null;
        }
        return Promise.resolve(wait).then(() => service.getStatus(), () => service.getStatus());
      },
      stop() {
        if (service.isStopped()) return;
        service.stop();
        swallow(() => registration.unregister());
        if (viewHandle) swallow(() => viewHandle.unregister());
      },
    };
    return { ok: true, construction: Object.freeze(facade) };
  } catch (err) {
    return { ok: false, reason: "CONSTRUCTION_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startConstruction, createUnavailableConstruction };
