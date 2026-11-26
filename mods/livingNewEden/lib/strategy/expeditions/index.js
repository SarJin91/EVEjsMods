"use strict";

const { isModuleEnabled } = require("../../../config");
const { createExpeditionRepository } = require("./expeditionRepository");
const { createExpeditionService } = require("./expeditionService");
const { VIEW_ID, buildExpeditionsView } = require("./expeditionsView");
const { PLAN_EVENT, STEP_EVENT } = require("./schema");

const STATE_READY = "ready";
const STRATEGY_DOWN = Object.freeze(["unavailable", "stopped"]);
const REQUIRED = Object.freeze(["fleets.repository.getFleet", "fleets.repository.getFleets",
  "fleets.repository.listFleetsByFaction", "fleets.repository.createOperation", "fleets.travel.planInTx",
  "fleets.repository.transition", "fleets.repository.disband", "fleets.repository.getOperation",
  "fleets.repository.transitionOperation",
  "scheduler.registerHandler", "scheduler.enqueue", "scheduler.findByKey", "scheduler.getStatus",
  "persistence.store.transaction", "persistence.journal.applyOnce", "persistence.journal.findByKey",
  "strategy.registry.listActiveFactions", "graph.getGraph", "clock.now", "clock.travelDurationMs", "ids.next",
  "wormholes.isSynced", "wormholes.getStatus"]);
const SOFT_ROOTS = Object.freeze(["wormholes"]);
const GRAPH_METHODS = Object.freeze(["findRoute", "listWormholeEdges", "getSystem", "getNeighbors"]);
const COUNT_KEYS = Object.freeze([["planPeriodMs", 1], ["maxActiveExpeditions", 0],
  ["maxActiveExpeditionsPerFaction", 0], ["maxExpeditionsPerPlan", 1], ["entryMaxJumps", 0], ["expeditionMinMs", 1],
  ["expeditionMaxMs", 1], ["returnMarginMs", 0], ["stepIntervalMs", 1], ["stepRecheckMs", 1], ["maxWatchRounds", 1],
  ["presenceGainPermille", 0], ["cutOffRecheckMs", 1], ["cutOffDecisionMs", 1], ["syncWaitMs", 1],
  ["fleetScanMax", 1], ["maxBfsSystems", 1], ["candidateTopN", 1], ["reconcileMaxExpeditions", 1],
  ["reconcileMaxAttempts", 1], ["endedRetentionMs", 0], ["pruneMaxRows", 1]]);

const messageOf = (err) => String((err && err.message) || err);

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
    if (SOFT_ROOTS.includes(parts[0])) continue;
    let v = roots[parts[0]];
    for (let i = 1; i < parts.length && v; i += 1) v = v[parts[i]];
    if (typeof v !== "function") out.push(path);
  }
  return out;
}

function createUnavailableExpeditions(reason, detail) {
  const status = Object.freeze({ state: "unavailable", reason: String(reason), ...(detail ? { detail: String(detail) }
    : {}) });
  const refusal = Object.freeze({ ok: false, reason: String(reason) });
  return Object.freeze({ getMode: () => "off", getStatus: () => status, listOpen: () => refusal,
    readPanel: () => refusal, repository: null, stop() {} });
}

function startExpeditions(deps) {
  const registrations = [];
  try {
    const { config, persistence, scheduler, fleets, strategy, graph, clock, ids } = deps || {};
    if (!isModuleEnabled(config, "strategy") || !config.expeditions || config.expeditions.enabled !== true) {
      return { ok: false, reason: "disabled_by_config" };
    }
    if (!config.wormholes || config.wormholes.enabled !== true || !isModuleEnabled(config, "graph")) {
      return { ok: false, reason: "WORMHOLES_DISABLED" };
    }
    if (!persistence || persistence.ok !== true || !persistence.store || !persistence.journal) {
      return { ok: false, reason: "dependency_disabled:persistence" };
    }
    if (!scheduler || stateOf(scheduler) !== STATE_READY) return { ok: false, reason: "SCHEDULER_UNAVAILABLE" };
    if (!fleets || !fleets.repository || !fleets.travel) return { ok: false, reason: "FLEETS_UNAVAILABLE" };
    if (!strategy || !strategy.registry || STRATEGY_DOWN.includes(stateOf(strategy))) {
      return { ok: false, reason: "STRATEGY_UNAVAILABLE", detail: String(stateOf(strategy)) };
    }
    const missing = missingPaths({ fleets, scheduler, persistence, strategy, graph, clock, ids });
    if (missing.length > 0) return { ok: false, reason: "EXPEDITIONS_FACADE_MISSING", detail: missing.join(",") };
    const C = config.expeditions;
    for (const [key, min] of COUNT_KEYS) {
      if (!Number.isSafeInteger(C[key]) || C[key] < min) {
        return { ok: false, reason: "INVALID_CONFIG", detail: `expeditions.${key}` };
      }
    }
    const tf = config.fleets && config.fleets.travelTimeFactor;
    if (!(typeof tf === "number" && Number.isFinite(tf) && tf > 0)) {
      return { ok: false, reason: "INVALID_CONFIG", detail: "fleets.travelTimeFactor" };
    }

    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    const store = persistence.store;
    const expeditions = createExpeditionRepository();
    const service = createExpeditionService({ store, journal: persistence.journal, expeditions, scheduler,
      fleetRepository: fleets.repository, travel: fleets.travel, getRegistry: () => strategy.registry || null,
      getGraph: () => graph.getGraph(), getWormholes: deps.getWormholes, clock, ids,
      worldSeed: persistence.worldSeed, config, telemetry: deps.telemetry || null, logger, nowMs: deps.nowMs,
      getWorld: deps.getWorld });

    const removeAll = () => {
      for (const r of registrations.splice(0).reverse()) swallow(() => r());
    };
    for (const [type, fn] of [[PLAN_EVENT, service.onPlan], [STEP_EVENT, service.onStep]]) {
      let r;
      try {
        r = scheduler.registerHandler(type, fn);
      } catch (err) {
        r = { ok: false, reason: messageOf(err) };
      }
      if (!r || !r.ok) {
        removeAll();
        return { ok: false, reason: "EXPEDITIONS_START_FAILED",
          detail: `handler ${type}: ${(r && r.reason) || "no result"}` };
      }
      registrations.push(() => r.unregister());
    }

    const open = store.transaction("expeditions.countOpen", (db) => expeditions.countOpen(db, {}));
    const openCount = open.ok && open.value && open.value.ok ? open.value.count : null;
    if (openCount !== null) service.setOpen(openCount);
    const boot = service.bootstrap();
    if (!boot.ok) logger.log(`expeditions: bootstrap failed - ${boot.reason}`);
    const rec = service.reconcile();
    if (!rec.ok) logger.log(`expeditions: reconcile failed - ${rec.reason}`);
    else if (rec.lastError) logger.log(`expeditions: reconcile refused=${rec.refused} - ${rec.lastError}`);
    logger.log(`expeditions: running open=${openCount === null ? "?" : openCount} plan=${boot.ok ? boot.round : "?"} `
      + `reconciled=${rec.ok ? rec.enqueued : "?"} exhausted=${rec.ok ? rec.exhausted : "?"} `
      + `refused=${rec.ok ? rec.refused : "?"}`);

    const views = deps.views;
    if (views && typeof views.registerView === "function") {
      const v = views.registerView(VIEW_ID, buildExpeditionsView({ readPanel: service.readPanel,
        getStatus: service.getStatus, store, clock, getGovernor: deps.getGovernor,
        refreshMs: config.observer && config.observer.journalCacheMs }));
      if (v && v.ok) registrations.push(() => v.unregister());
      else logger.log(`expeditions: view ${VIEW_ID} not registered - ${(v && v.reason) || "no result"}`);
    }

    const facade = {
      getMode: service.getMode,
      getStatus: service.getStatus,
      listOpen: service.listOpen,
      readPanel: service.readPanel,
      countOpen: (tx, opts) => expeditions.countOpen(tx, opts),
      occupiedSystems: (tx, opts) => expeditions.occupiedSystems(tx, opts),
      createExpedition: (tx, spec, idempotencyKey) => expeditions.createExpedition(tx, spec, idempotencyKey),
      getExpedition: (tx, expeditionId) => expeditions.getExpedition(tx, expeditionId),
      listEnded: (tx, opts) => expeditions.listEnded(tx, opts),
      transitionExpedition: (tx, change) => expeditions.transitionExpedition(tx, change),
      watchExpedition: (tx, change) => expeditions.watchExpedition(tx, change),
      pruneEnded: (tx, opts) => expeditions.pruneEnded(tx, opts),
      repository: expeditions,
      stop() {
        if (service.isStopped()) return;
        service.stop();
        removeAll();
      },
    };
    return { ok: true, expeditions: Object.freeze(facade) };
  } catch (err) {
    for (const r of registrations.splice(0).reverse()) swallow(() => r());
    return { ok: false, reason: "EXPEDITIONS_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startExpeditions, createUnavailableExpeditions, REQUIRED, SOFT_ROOTS, GRAPH_METHODS };
