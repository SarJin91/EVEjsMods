"use strict";

const { isModuleEnabled } = require("../../../config");
const DATA = require("../data/commodities");
const { createCommodityCatalog } = require("./catalog");
const { TIER_WEIGHTS } = require("./data/tierWeights");
const S = require("./schema");
const { createExtractionService } = require("./extractionService");
const { VIEW_ID, buildExtractionView } = require("./extractionView");

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

function createUnavailableExtraction(reason, detail) {
  const status = Object.freeze({ mode: "off", state: "unavailable", reason: String(reason),
    ...(detail ? { detail: String(detail) } : {}), counters: Object.freeze({}), lastCycleByFaction: [] });
  const refusal = Object.freeze({ ok: false, reason: "EXTRACTION_OFF" });
  return Object.freeze({ getMode: () => "off", yieldOf: () => refusal, fuelledOf: () => refusal,
    readNeeds: () => refusal, getStatus: () => status, stop() {} });
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

function startExtraction(deps) {
  try {
    const { config, persistence, clock, scheduler } = deps || {};
    if (!isModuleEnabled(config, "strategy") || !config.extraction || config.extraction.enabled !== true) {
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
    if (!scheduler || typeof scheduler.registerHandler !== "function" || typeof scheduler.enqueue !== "function"
      || schedulerState !== SCHEDULER_READY) {
      return { ok: false, reason: "SCHEDULER_UNAVAILABLE" };
    }
    const world = deps.world;
    if (!world || !world.repository || typeof world.repository.listControlledByFaction !== "function") {
      return { ok: false, reason: "WORLD_UNAVAILABLE" };
    }
    if (!clock || typeof clock.now !== "function") {
      return { ok: false, reason: "EXTRACTION_START_FAILED", detail: "clock" };
    }
    const made = createCommodityCatalog(DATA);
    if (!made.ok) return { ok: false, reason: "EXTRACTION_START_FAILED", detail: `catalog: ${made.detail}` };
    const X = config.extraction;
    const store = persistence.store;
    const storeRows = store.limits && store.limits.maxRowsPerTransaction;
    const limit = Number.isSafeInteger(storeRows) ? Math.min(X.maxRowsPerPulse, storeRows) : X.maxRowsPerPulse;
    const rowsCap = limit - S.PULSE_FIXED_ROWS;
    if (rowsCap < S.MARKER_ROWS) {
      return { ok: false, reason: "EXTRACTION_EXCEEDS_MAX_ROWS", detail: `${limit} rows < ${S.PULSE_FIXED_ROWS + 1}` };
    }
    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    if (limit < X.maxRowsPerPulse) {
      logger.log(`extraction: maxRowsPerPulse ${X.maxRowsPerPulse} capped to the transaction limit ${limit}`);
    }
    const graph = deps.graph || null;
    const strategy = deps.strategy || null;
    let demand = "ok";
    const P = config.production || {};
    const fuelWanted = X.fuelEnabled === true && made.catalog.fuelPerPeriod(X.fuelBlocksPerUpwellPerPeriod).length > 0;
    if (fuelWanted || P.advancedInputsEnabled === true) {
      const need = Math.max(made.catalog.maxSchematicDeltas,
        made.catalog.fuelPerPeriod(X.fuelBlocksPerUpwellPerPeriod).length);
      const have = config.stations && Number.isSafeInteger(config.stations.maxDeltasPerChange)
        ? config.stations.maxDeltasPerChange : 0;
      if (have < need) {
        demand = "DELTAS_LIMIT";
        logger.log(`extraction: demand step off - stations.maxDeltasPerChange ${have} < ${need} (DELTAS_LIMIT)`);
      }
    }
    const service = createExtractionService({ store, journal: persistence.journal, scheduler, clock, config,
      catalog: made.catalog, tierWeights: TIER_WEIGHTS, adapter: deps.adapter || null, rowsCap,
      telemetry: deps.telemetry || null, logger, nowMs: deps.nowMs,
      getProduction: deps.getProduction, demandDisabled: demand !== "ok",
      getRegistry: () => (strategy && strategy.registry) || null,
      getWorld: () => world.repository,
      getStations: deps.getStations,
      getGraph: () => {
        if (!graph || typeof graph.getGraph !== "function") return null;
        const r = graph.getGraph();
        return r && r.ok ? r.graph : null;
      } });

    let registration;
    try {
      registration = scheduler.registerHandler(S.PULSE_EVENT, service.pulseHandler, { maxPerPass: 1 });
    } catch (err) {
      registration = { ok: false, reason: messageOf(err) };
    }
    if (!registration || !registration.ok) {
      return { ok: false, reason: "EXTRACTION_START_FAILED",
        detail: `handler ${S.PULSE_EVENT}: ${(registration && registration.reason) || "no result"}` };
    }
    const chain = service.bootstrap();
    if (!chain.ok) logger.log(`extraction: pulse chain not started ${chain.reason}; the next start retries`);

    let viewHandle = null;
    const views = deps.views;
    if (views && typeof views.registerView === "function") {
      const r = views.registerView(VIEW_ID, buildExtractionView({ getStatus: service.getStatus,
        topSystems: service.topSystems, getGovernor: deps.getGovernor, graph,
        factionNames: readFactionNames(deps.adapter) }));
      if (r && r.ok) viewHandle = r;
      else logger.log(`extraction: view ${VIEW_ID} not registered - ${(r && r.reason) || "no result"}`);
    }

    const facade = {
      getMode: service.getMode,
      yieldOf: service.yieldOf,
      fuelledOf: service.fuelledOf,
      readNeeds: service.readNeeds,
      getStatus: () => Object.freeze({ ...service.getStatus(), pulseChain: chain.ok, view: viewHandle !== null,
        ...(demand !== "ok" ? { demand } : {}) }),
      stop(reason) {
        if (service.isStopped()) return;
        service.stop(reason);
        swallow(() => registration.unregister());
        if (viewHandle) {
          const handle = viewHandle;
          viewHandle = null;
          swallow(() => handle.unregister());
        }
      },
    };
    return { ok: true, extraction: Object.freeze(facade) };
  } catch (err) {
    return { ok: false, reason: "EXTRACTION_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startExtraction, createUnavailableExtraction };
