"use strict";

const { isModuleEnabled } = require("../../../config");
const { GROUPS: STRENGTH_GROUPS } = require("../../battle/data/strengthCatalog");
const { expandStrengthGroups } = require("../../battle/strength");
const { capitalPowerOverlayOf } = require("../../battle/data/capitalStrengthRows");
const { createHostility } = require("../../battle/data/hostility");
const { rowsBound: occupationRowsBound } = require("../../world/occupation/schema");
const { createSiegeRepository } = require("./siegeRepository");
const { createSiegeService } = require("./siegeService");
const { GRID_MOVE_ROWS, GRID_STEP_ROWS } = require("./gridScope");
const S = require("./schema");

const SCHEDULER_READY = "ready";
const NATIVE_OFF = Object.freeze({ ok: true, outcome: "SIEGE_OFF" });
const COUNT_KEYS = Object.freeze(["assaultMinMs", "assaultMaxMs", "recheckMs", "maxWaitRounds", "maxOpenSieges",
  "maxOpenSiegesPerFaction", "maxFleetsReadPerCheck", "maxChecksPerPass", "maxStepsPerPass", "retentionMs",
  "pruneBatch", "reconcileMaxSieges", "gridMaxMovers"]);

function messageOf(err) {
  return String((err && err.message) || err);
}

function swallow(fn) {
  try {
    fn();
  } catch (_err) {
  }
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

function createUnavailableSiege(reason, detail) {
  const refusal = Object.freeze({ ok: false, reason: "SIEGE_UNAVAILABLE", detail: String(reason)
    + (detail ? `: ${detail}` : "") });
  const status = Object.freeze({ state: "unavailable", reason: String(reason) });
  const refuse = () => refusal;
  return Object.freeze({ getMode: () => "off", getStatus: () => status, whenReady: () => Promise.resolve(status),
    repository: null, requestCheckInTx: refuse, reconcile: refuse, consequence: null, readForFaction: refuse,
    readForFactions: refuse,
    applyNativeDestruction: () => NATIVE_OFF, stop() {} });
}

function startSiege(deps) {
  try {
    const { config, persistence, clock, ids, scheduler } = deps || {};
    if (!isModuleEnabled(config, "strategy") || !config.stations || config.stations.enabled !== true
      || !config.siege || config.siege.enabled !== true) {
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
    if (!scheduler || typeof scheduler.registerHandler !== "function" || typeof scheduler.enqueueMany !== "function"
      || schedulerState !== SCHEDULER_READY) {
      return { ok: false, reason: "SCHEDULER_UNAVAILABLE" };
    }
    const fleets = deps.fleets;
    if (!fleets || !fleets.repository || typeof fleets.repository.listFleetsInSystem !== "function"
      || !fleets.travel || typeof fleets.travel.addArrivalListener !== "function") {
      return { ok: false, reason: "FLEETS_UNAVAILABLE" };
    }
    const registry = deps.strategy && deps.strategy.registry;
    if (!registry || typeof registry.isActive !== "function" || typeof registry.getFaction !== "function") {
      return { ok: false, reason: "dependency_disabled:strategy" };
    }
    if (!clock || typeof clock.now !== "function" || !ids || typeof ids.next !== "function") {
      return { ok: false, reason: "SIEGE_START_FAILED", detail: "clock/ids" };
    }
    const C = config.siege;
    for (const key of COUNT_KEYS) {
      if (!Number.isSafeInteger(C[key]) || C[key] < 0) {
        return { ok: false, reason: "SIEGE_START_FAILED", detail: `siege.${key}` };
      }
    }
    if (!(typeof C.timerScale === "number" && C.timerScale > 0)) {
      return { ok: false, reason: "SIEGE_START_FAILED", detail: "siege.timerScale" };
    }
    if (C.assaultMaxMs < C.assaultMinMs) {
      return { ok: false, reason: "SIEGE_START_FAILED", detail: `siege.assaultMaxMs ${C.assaultMaxMs} < `
        + `siege.assaultMinMs ${C.assaultMinMs}` };
    }
    const maxRows = config.persistence && config.persistence.maxRowsPerTransaction;
    const maxFactions = config.world && config.world.maxFactionsPerSystem;
    const endRows = S.siegeEndRows(occupationRowsBound(Number.isSafeInteger(maxFactions) ? maxFactions : 0),
      config.stations.maxStockItemsPerStation);
    if (Number.isSafeInteger(maxRows) && endRows > maxRows) {
      return { ok: false, reason: "SIEGE_START_FAILED", detail: `siege end rows ${endRows} > `
        + `persistence.maxRowsPerTransaction ${maxRows} - lower stations.maxStockItemsPerStation` };
    }
    if (Number.isSafeInteger(maxRows) && S.SIEGE_START_ROWS + C.pruneBatch > maxRows) {
      return { ok: false, reason: "SIEGE_START_FAILED", detail: `siege start rows ${S.SIEGE_START_ROWS
        + C.pruneBatch} > persistence.maxRowsPerTransaction ${maxRows} - lower siege.pruneBatch` };
    }
    if (typeof C.gridEnabled !== "boolean") {
      return { ok: false, reason: "SIEGE_START_FAILED", detail: "siege.gridEnabled" };
    }
    const moveRows = GRID_MOVE_ROWS * C.gridMaxMovers;
    if (C.gridEnabled && Number.isSafeInteger(maxRows) && (S.SIEGE_START_ROWS + C.pruneBatch + moveRows > maxRows
      || GRID_STEP_ROWS + moveRows > maxRows)) {
      return { ok: false, reason: "SIEGE_START_FAILED", detail: `siege grid rows (start ${S.SIEGE_START_ROWS
        + C.pruneBatch + moveRows}, step ${GRID_STEP_ROWS + moveRows}) > persistence.maxRowsPerTransaction `
        + `${maxRows} - lower siege.gridMaxMovers` };
    }
    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    const store = persistence.store;
    const repository = createSiegeRepository({ journal: persistence.journal, ids });
    const graph = deps.graph || null;
    const service = createSiegeService({ store, sieges: repository, scheduler, fleetRepository: fleets.repository,
      grid: fleets.grid || null, registry, getStations: deps.getStations, getOccupation: deps.getOccupation,
      getConstruction: deps.getConstruction, getWrecks: deps.getWrecks, journal: persistence.journal,
      getGraph: () => (graph && typeof graph.getGraph === "function" ? graph.getGraph() : null),
      hostility: createHostility(),
      groups: expandStrengthGroups(STRENGTH_GROUPS, null, capitalPowerOverlayOf(config.strategy)), config,
      coreIndex: deps.coreIndex,
      telemetry: deps.telemetry || null, logger });

    const registrations = [];
    const unregisterAll = () => {
      for (const r of registrations.splice(0)) swallow(() => r.unregister());
    };
    for (const [type, fn, maxPerPass] of [[S.CHECK_EVENT_TYPE, service.onCheck, C.maxChecksPerPass],
      [S.STEP_EVENT_TYPE, service.onStep, C.maxStepsPerPass]]) {
      let registration;
      try {
        registration = scheduler.registerHandler(type, fn, { maxPerPass });
      } catch (err) {
        registration = { ok: false, reason: messageOf(err) };
      }
      if (!registration || !registration.ok) {
        unregisterAll();
        return { ok: false, reason: "SIEGE_START_FAILED",
          detail: `handler ${type}: ${(registration && registration.reason) || "no result"}` };
      }
      registrations.push(registration);
    }
    const listener = fleets.travel.addArrivalListener(service.onArrival);
    if (!listener || !listener.ok) {
      unregisterAll();
      return { ok: false, reason: "SIEGE_START_FAILED", detail: `arrival listener: ${(listener && listener.reason)
        || "no result"}` };
    }

    const rec = service.reconcile();
    if (!rec.ok) logger.log(`siege: reconcile failed ${rec.reason}; the next start retries`);
    else if (rec.enqueued > 0) logger.log(`siege: reconcile open=${rec.open} enqueued=${rec.enqueued}`);
    logger.log(`siege: running open=${rec.ok ? rec.open : "?"} scale=${C.timerScale} captureUpwell=`
      + `${C.captureUpwell === true}`);

    let layerHandle = null;
    let panelHandle = null;
    const observer = config.observer || {};
    const views = deps.views;
    if (observer.galaxyEnabled === true && observer.galaxySiegesEnabled === true && views
      && typeof views.registerView === "function") {
      const { LAYER_ID, buildSiegesLayerView } = require("./siegesLayer");
      const r = views.registerView(LAYER_ID, buildSiegesLayerView({ store, repository, clock,
        getGovernor: deps.getGovernor, telemetry: deps.telemetry || null, nowMs: deps.nowMs,
        getPlayerSiege: deps.getPlayerSiege, getHarvestRaid: deps.getHarvestRaid,
        maxSieges: config.siege.maxOpenSieges, maxSystems: observer.galaxySiegesMaxSystems,
        maxLines: 6, refreshMs: observer.galaxySiegesRefreshMs }));
      if (r && r.ok) layerHandle = r;
      else if (deps.logger && typeof deps.logger.log === "function") {
        deps.logger.log(`siege: view ${LAYER_ID} not registered - ${(r && r.reason) || "no result"}`);
      }
    }
    if (observer.galaxyEnabled === true && views && typeof views.registerView === "function") {
      const { VIEW_ID, buildSiegesView } = require("./siegesView");
      const r = views.registerView(VIEW_ID, buildSiegesView({ store, repository, getStatus: service.getStatus, clock,
        getGovernor: deps.getGovernor, graph: deps.graph, getPlayerSiege: deps.getPlayerSiege,
        factionNames: deps.factionNames instanceof Map ? deps.factionNames : readFactionNames(deps.adapter),
        maxRows: observer.siegesPanelMaxRows }));
      if (r && r.ok) panelHandle = r;
      else if (deps.logger && typeof deps.logger.log === "function") {
        deps.logger.log(`siege: view ${VIEW_ID} not registered - ${(r && r.reason) || "no result"}`);
      }
    }

    const facade = {
      getMode: service.getMode,
      getStatus: service.getStatus,
      repository,
      requestCheckInTx: service.requestCheckInTx,
      reconcile: service.reconcile,
      consequence: Object.freeze({ name: "siege", apply(tx, settled, ck) {
        try {
          return service.applyConsequence(tx, settled, ck);
        } catch (err) {
          if (!tx || tx.inTransaction !== true) throw err;
          return { ok: false, reason: "SIEGE_CONSEQUENCE_FAILED", detail: messageOf(err) };
        }
      } }),
      readForFaction: service.readForFaction,
      readForFactions: service.readForFactions,
      applyNativeDestruction: service.applyNativeDestruction,
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
        unregisterAll();
        swallow(() => listener.remove());
        if (layerHandle) {
          const h = layerHandle;
          layerHandle = null;
          swallow(() => h.unregister());
        }
        if (panelHandle) {
          const h = panelHandle;
          panelHandle = null;
          swallow(() => h.unregister());
        }
      },
    };
    return { ok: true, siege: Object.freeze(facade) };
  } catch (err) {
    return { ok: false, reason: "SIEGE_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startSiege, createUnavailableSiege };
