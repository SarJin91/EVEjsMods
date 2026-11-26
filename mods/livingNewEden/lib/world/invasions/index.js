"use strict";

const { isModuleEnabled } = require("../../../config");
const { createInvasionService, createUnavailableInvasions } = require("./invasionService");
const { listFootholdsInTx, listBeachheadsInTx } = require("./footholds");
const { buildInvasionsLayerView } = require("./invasionsLayer");
const { buildInvasionsView } = require("./invasionsView");
const { createIncursionUiPublisher } = require("./incursionUi");
const R = require("./invasionRepository");

function readFactionNames(adapter) {
  if (!adapter || typeof adapter.readFactionNames !== "function") return new Map();
  try {
    const r = adapter.readFactionNames();
    return r && r.ok && r.names instanceof Map ? r.names : new Map();
  } catch (_err) {
    return new Map();
  }
}

function factionIncursionEntriesOf(config, getFactionIncursions, incursionCfg) {
  const ui = config && config.factionIncursions && config.factionIncursions.ui;
  if (!ui || ui.enabled !== true || typeof getFactionIncursions !== "function") return null;
  const opts = { templateNameID: incursionCfg.templateNameID, maxEntries: incursionCfg.maxEntries };
  return () => {
    const fi = getFactionIncursions();
    if (!fi || typeof fi.listUiEntries !== "function") return [];
    const r = fi.listUiEntries(opts);
    if (r && r.ok === true) return r.entries;
    const status = typeof fi.getStatus === "function" ? fi.getStatus() : null;
    if (status && status.state === "unavailable") return [];
    throw new Error(`factionIncursions.listUiEntries ${(r && r.reason) || "?"}`);
  };
}

function startInvasions(deps) {
  try {
    const { config, persistence, clock, scheduler, fleets, world, graph, stations, presence, adapter,
      strategy, occupation, battle, telemetry, logger, nowMs, ids } = deps || {};

    if (!isModuleEnabled(config, "world") || !isModuleEnabled(config, "fleets")
      || !isModuleEnabled(config, "scheduler") || !isModuleEnabled(config, "strategy")
      || !(config.occupation && config.occupation.enabled === true)) {
      return { ok: false, reason: "dependency_disabled:world|fleets|scheduler|strategy|occupation" };
    }
    if (!config.invasions || config.invasions.enabled !== true) {
      return { ok: false, reason: "disabled_by_config" };
    }
    if (!persistence || persistence.ok !== true || !persistence.store || !persistence.journal) {
      return { ok: false, reason: "dependency_disabled:persistence" };
    }
    if (!world || !world.repository) return { ok: false, reason: "WORLD_UNAVAILABLE" };
    if (!fleets || !fleets.repository) return { ok: false, reason: "FLEETS_UNAVAILABLE" };
    if (!scheduler || typeof scheduler.registerHandler !== "function" || typeof scheduler.enqueue !== "function") {
      return { ok: false, reason: "SCHEDULER_UNAVAILABLE" };
    }
    if (!strategy || !strategy.registry) return { ok: false, reason: "STRATEGY_UNAVAILABLE" };
    if (!occupation) return { ok: false, reason: "OCCUPATION_UNAVAILABLE" };
    if (!battle) return { ok: false, reason: "BATTLE_UNAVAILABLE" };
    if (!clock || typeof clock.now !== "function") return { ok: false, reason: "INVASIONS_START_FAILED", detail: "clock" };

    const logFn = logger && typeof logger.log === "function" ? (msg) => logger.log(msg) : () => {};
    const store = persistence.store;

    const sovClaims = adapter && typeof adapter.getSovClaims === "function" ? adapter.getSovClaims() : null;
    const sovReaderOk = !!sovClaims && typeof sovClaims.claimOf === "function"
      && (typeof sovClaims.available !== "function" || sovClaims.available() === true);
    if (!sovReaderOk) {
      logFn("invasions: sovClaims unavailable, player sov check will return SOV_UNAVAILABLE");
    }

    const service = createInvasionService({ store, journal: persistence.journal, repository: world.repository,
      fleets, scheduler, graph, world, stations, presence, sovClaims: sovClaims && typeof sovClaims.claimOf === "function" ? sovClaims : { claimOf: () => ({ ok: false, reason: "SOV_UNAVAILABLE" }) },
      strategy, occupation, battle, config, clock, telemetry: telemetry || null, logger: { log: logFn }, nowMs, ids, worldSeed: persistence.worldSeed,
      getTreasury: typeof deps.getTreasury === "function" ? deps.getTreasury : () => null,
      readTrigDrifterSystemList: adapter && typeof adapter.readTrigDrifterSystemList === "function"
        ? (key) => adapter.readTrigDrifterSystemList(key) : null,
      getAbyssal: typeof deps.getAbyssal === "function" ? deps.getAbyssal : () => null,
      getSeasons: typeof deps.getSeasons === "function" ? deps.getSeasons : () => null });

    const startResult = service.start();
    if (!startResult.ok) return startResult;

    const boot = service.bootstrap();
    if (!boot.ok) logFn(`invasions: bootstrap failed ${boot.reason}; the next start retries`);
    else if (boot.enqueued + boot.duplicates > 0) {
      logFn(`invasions: bootstrap enqueued=${boot.enqueued} duplicates=${boot.duplicates}`);
    }

    const { views } = deps || {};
    const observer = config.observer || {};
    const galaxyEnabled = observer.galaxyEnabled === true;
    const invasionsLayerEnabled = galaxyEnabled && observer.galaxyInvasionsEnabled === true;
    const invasionsPanelEnabled = galaxyEnabled && observer.galaxyInvasionsEnabled === true;
    const viewHandles = [];

    if (invasionsLayerEnabled && views && typeof views.registerView === "function") {
      const r = views.registerView("layer-invasions", buildInvasionsLayerView({
        store,
        repository: R,
        clock,
        getGovernor: () => deps.getGovernor ? deps.getGovernor() : null,
        telemetry: telemetry || null,
        nowMs,
        maxSystems: observer.galaxyInvasionsMaxSystems,
        maxLines: observer.galaxyInvasionsMaxLines,
        refreshMs: observer.galaxyInvasionsRefreshMs || 60000,
        getStatus: service.getStatus,
        effectiveWithdrawAt: service.effectiveWithdrawAtOf,
      }));
      if (r.ok) viewHandles.push(r);
      else logFn(`invasions: layer-invasions registration failed: ${r.reason}`);
    }

    if (invasionsPanelEnabled && views && typeof views.registerView === "function") {
      const r = views.registerView("invasions", buildInvasionsView({
        store,
        repository: R,
        getStatus: service.getStatus,
        getGovernor: () => deps.getGovernor ? deps.getGovernor() : null,
        graph: deps.graph || null,
        factionNames: readFactionNames(deps.adapter),
        maxRows: observer.invasionsPanelMaxRows,
        effectiveWithdrawAt: service.effectiveWithdrawAtOf,
        rollIntervalMs: config.invasions.rollIntervalMs,
      }));
      if (r.ok) viewHandles.push(r);
      else logFn(`invasions: invasions panel registration failed: ${r.reason}`);
    }

    const incursionCfg = config.invasions.incursionUi || {};
    let incursionPublisher = null;
    if (incursionCfg.enabled === true) {
      incursionPublisher = createIncursionUiPublisher({
        store,
        repository: R,
        adapter,
        clock,
        getGovernor: () => deps.getGovernor ? deps.getGovernor() : null,
        config: incursionCfg,
        telemetry: telemetry || null,
        logger: { log: logFn },
        withdrawAtOf: service.effectiveWithdrawAtOf,
        timers: deps.timers,
        getExtraEntries: factionIncursionEntriesOf(config, deps.getFactionIncursions, incursionCfg),
      });
      incursionPublisher.start();
    }

    const stop = () => {
      if (incursionPublisher !== null) {
        try {
          incursionPublisher.stop();
        } catch (_err) {
        }
        incursionPublisher = null;
      }
      for (const handle of viewHandles.splice(0)) {
        try {
          handle.unregister();
        } catch (_err) {
        }
      }
      return service.stop();
    };

    return { ok: true, invasions: Object.freeze({
      getStatus: service.getStatus,
      stop,
      listFootholdsInTx,
      listBeachheadsInTx,
      effectiveWithdrawAtOf: service.effectiveWithdrawAtOf,
    }) };
  } catch (err) {
    return { ok: false, reason: "INVASIONS_START_FAILED", detail: String((err && err.message) || err) };
  }
}

module.exports = { startInvasions, createUnavailableInvasions };