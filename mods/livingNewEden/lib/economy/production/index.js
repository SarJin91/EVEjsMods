"use strict";

const { isModuleEnabled } = require("../../../config");
const { HULL_GROUPS } = require("../../fleets/schema");
const { createJobRepository } = require("./jobRepository");
const { createProductionService } = require("./productionService");
const { createRecipeTable, recipeParamsOf } = require("./recipes");
const { VIEW_ID, buildProductionView } = require("./productionView");
const { PRODUCTION_EVENT_TYPE } = require("../schema");
const { createCommodityCatalog } = require("../extraction/catalog");

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

function createUnavailableProduction(reason, detail) {
  const refusal = Object.freeze({ ok: false, reason: "PRODUCTION_UNAVAILABLE", detail: String(reason)
    + (detail ? `: ${detail}` : "") });
  const status = Object.freeze({ state: "unavailable", reason: String(reason) });
  const refuse = () => refusal;
  const off = Object.freeze({ ok: false, reason: "PRODUCTION_OFF" });
  return Object.freeze({ getMode: () => "off", getRecipes: () => null, readStationState: refuse,
    startJobInTx: refuse, count() {}, noteRefusal() {}, getStatus: () => status, reconcile: refuse, stop() {},
    activeGroupsByStation: () => off, getAdvanced: () => null });
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

function startProduction(deps) {
  try {
    const { config, persistence, clock, ids, scheduler } = deps || {};
    if (!isModuleEnabled(config, "strategy") || !config.production || config.production.enabled !== true) {
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
    if (!clock || typeof clock.now !== "function" || !ids || typeof ids.next !== "function") {
      return { ok: false, reason: "PRODUCTION_START_FAILED", detail: "clock/ids" };
    }
    const P = config.production;
    let recipes;
    try {
      recipes = createRecipeTable(deps.recipesData || require("../data/hullRecipes"), recipeParamsOf(P),
        deps.industryCatalog || undefined);
    } catch (err) {
      return { ok: false, reason: "PRODUCTION_START_FAILED", detail: `recipes: ${messageOf(err)}` };
    }
    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    const store = persistence.store;
    const jobs = createJobRepository({ journal: persistence.journal, clock, hullGroups: HULL_GROUPS });
    let commodities = null;
    if (P.advancedInputsEnabled === true) {
      const made = createCommodityCatalog(require("../data/commodities"));
      if (made.ok) commodities = made.catalog;
      else logger.log(`production: advanced inputs off - commodity catalog ${made.detail}`);
    }
    const service = createProductionService({ store, jobs, scheduler, getStations: deps.getStations, recipes, clock,
      ids, config, telemetry: deps.telemetry || null, logger, nowMs: deps.nowMs, getExtraction: deps.getExtraction,
      commodities });

    let registration;
    try {
      registration = scheduler.registerHandler(PRODUCTION_EVENT_TYPE, service.handler,
        { maxPerPass: P.maxCompletionsPerPass });
    } catch (err) {
      registration = { ok: false, reason: messageOf(err) };
    }
    if (!registration || !registration.ok) {
      return { ok: false, reason: "PRODUCTION_START_FAILED",
        detail: `handler ${PRODUCTION_EVENT_TYPE}: ${(registration && registration.reason) || "no result"}` };
    }

    const rec = service.reconcile();
    if (!rec.ok) logger.log(`production: reconcile failed ${rec.reason}; the next start retries`);
    else if (rec.enqueued > 0) logger.log(`production: reconcile open=${rec.open} enqueued=${rec.enqueued}`);

    let viewHandle = null;
    const views = deps.views;
    if (views && typeof views.registerView === "function") {
      const registry = deps.strategy && deps.strategy.registry;
      const r = views.registerView(VIEW_ID, buildProductionView({ store, jobs, clock, config,
        getStatus: service.getStatus, getGovernor: deps.getGovernor, factionNames: readFactionNames(deps.adapter),
        getStations: deps.getStations, linesOf: service.linesOf, registry: registry || null,
        getRecipes: service.getRecipes, getGraph: deps.getGraph }));
      if (r && r.ok) viewHandle = r;
      else logger.log(`production: view ${VIEW_ID} not registered - ${(r && r.reason) || "no result"}`);
    }

    const facade = {
      getMode: service.getMode,
      getRecipes: service.getRecipes,
      readStationState: service.readStationState,
      activeGroupsByStation: service.activeGroupsByStation,
      getAdvanced: service.getAdvanced,
      startJobInTx: service.startJobInTx,
      count: service.count,
      noteRefusal: service.noteRefusal,
      reconcile: service.reconcile,
      jobs,
      getStatus: () => Object.freeze({ ...service.getStatus(), view: viewHandle !== null }),
      stop() {
        if (service.isStopped()) return;
        service.stop();
        swallow(() => registration.unregister());
        if (viewHandle) {
          const handle = viewHandle;
          viewHandle = null;
          swallow(() => handle.unregister());
        }
      },
    };
    return { ok: true, production: Object.freeze(facade) };
  } catch (err) {
    return { ok: false, reason: "PRODUCTION_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startProduction, createUnavailableProduction };
