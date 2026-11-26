"use strict";

const { isModuleEnabled } = require("../../../config");
const { createCampRepository } = require("./campRepository");
const { createCampService } = require("./campService");
const { PLAN_EVENT, STEP_EVENT, AMBUSH_EVENT } = require("./schema");

const STATE_READY = "ready";
const STRATEGY_DOWN = Object.freeze(["unavailable", "stopped"]);
const REQUIRED = Object.freeze(["fleets.repository.getFleet", "fleets.repository.getFleets",
  "fleets.repository.listFleetsByFaction", "fleets.repository.createOperation", "fleets.travel.planInTx",
  "fleets.travel.interceptInTx",
  "scheduler.registerHandler", "scheduler.enqueue", "scheduler.findByKey", "scheduler.getStatus",
  "persistence.store.transaction", "persistence.journal.applyOnce", "persistence.journal.findByKey",
  "strategy.registry.listActiveFactions", "clock.now", "clock.travelDurationMs", "ids.next",
  "logistics.listInTransitInTx", "logistics.convoys.getConvoy", "battle.readCooldownsInTx",
  "fleets.grid.isEnabled", "fleets.grid.movesEnabled", "fleets.grid.readSystemGrid", "fleets.grid.positionsOf",
  "fleets.grid.moveInTx", "fleets.grid.placeInTx"]);
const SOFT_ROOTS = Object.freeze(["logistics", "battle"]);
const COUNT_KEYS = Object.freeze([["planPeriodMs", 1], ["maxActiveCamps", 0], ["maxActiveCampsPerFaction", 0],
  ["maxCampsPerPlan", 1], ["campMinMs", 1], ["campMaxMs", 1], ["campMaxJumps", 1], ["campChoiceTopN", 1],
  ["fleetScanMax", 1], ["maxBfsSystems", 1], ["stepIntervalMs", 1], ["stepRecheckMs", 1], ["maxWatchRounds", 1],
  ["reconcileMaxCamps", 1], ["reconcileMaxAttempts", 1], ["endedRetentionMs", 0], ["pruneMaxRows", 1],
  ["scanMaxConvoys", 1], ["maxStrikesPerScan", 1], ["interceptChancePermille", 0]]);

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

function createUnavailableLowsec(reason, detail) {
  const status = Object.freeze({ state: "unavailable", reason: String(reason), ...(detail ? { detail: String(detail) }
    : {}) });
  return Object.freeze({ getMode: () => "off", getStatus: () => status, repository: null, stop() {} });
}

function startLowsec(deps) {
  const registrations = [];
  try {
    const { config, persistence, scheduler, fleets, strategy, clock, ids } = deps || {};
    if (!isModuleEnabled(config, "strategy") || !config.lowsec || config.lowsec.enabled !== true) {
      return { ok: false, reason: "disabled_by_config" };
    }
    if (!persistence || persistence.ok !== true || !persistence.store || !persistence.journal) {
      return { ok: false, reason: "dependency_disabled:persistence" };
    }
    if (!scheduler || stateOf(scheduler) !== STATE_READY) return { ok: false, reason: "SCHEDULER_UNAVAILABLE" };
    if (!fleets || !fleets.repository || !fleets.travel) return { ok: false, reason: "FLEETS_UNAVAILABLE" };
    if (!strategy || !strategy.registry || STRATEGY_DOWN.includes(stateOf(strategy))) {
      return { ok: false, reason: "STRATEGY_UNAVAILABLE", detail: String(stateOf(strategy)) };
    }
    const missing = missingPaths({ fleets, scheduler, persistence, strategy, clock, ids });
    if (missing.length > 0) return { ok: false, reason: "LOWSEC_FACADE_MISSING", detail: missing.join(",") };
    const C = config.lowsec;
    for (const [key, min] of COUNT_KEYS) {
      if (!Number.isSafeInteger(C[key]) || C[key] < min) {
        return { ok: false, reason: "INVALID_CONFIG", detail: `lowsec.${key}` };
      }
    }
    const tf = config.fleets && config.fleets.travelTimeFactor;
    if (!(typeof tf === "number" && Number.isFinite(tf) && tf > 0)) {
      return { ok: false, reason: "INVALID_CONFIG", detail: "fleets.travelTimeFactor" };
    }

    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    const store = persistence.store;
    const camps = createCampRepository();
    const graph = deps.graph || null;
    const service = createCampService({ store, journal: persistence.journal, camps, scheduler,
      fleetRepository: fleets.repository, travel: fleets.travel, getRegistry: () => strategy.registry || null,
      getGraph: () => (graph && typeof graph.getGraph === "function" ? graph.getGraph() : null), clock, ids,
      worldSeed: persistence.worldSeed, config, telemetry: deps.telemetry || null, logger, nowMs: deps.nowMs,
      getLogistics: deps.getLogistics, getBattle: deps.getBattle, getWorld: deps.getWorld,
      grid: fleets.grid || null });

    const removeAll = () => {
      for (const r of registrations.splice(0).reverse()) swallow(() => r());
    };
    for (const [type, fn] of [[PLAN_EVENT, service.onPlan], [STEP_EVENT, service.onStep],
      [AMBUSH_EVENT, service.onAmbush]]) {
      let r;
      try {
        r = scheduler.registerHandler(type, fn);
      } catch (err) {
        r = { ok: false, reason: messageOf(err) };
      }
      if (!r || !r.ok) {
        removeAll();
        return { ok: false, reason: "LOWSEC_START_FAILED",
          detail: `handler ${type}: ${(r && r.reason) || "no result"}` };
      }
      registrations.push(() => r.unregister());
    }

    const open = store.transaction("lowsec.countOpen", (db) => camps.countOpen(db, { liveAt: clock.now() }));
    const openCount = open.ok && open.value && open.value.ok ? open.value.count : null;
    if (openCount !== null) service.setOpen(openCount);
    const boot = service.bootstrap();
    if (!boot.ok) logger.log(`lowsec: bootstrap failed - ${boot.reason}`);
    const rec = service.reconcile();
    if (!rec.ok) logger.log(`lowsec: reconcile failed - ${rec.reason}`);
    else if (rec.lastError) logger.log(`lowsec: reconcile refused=${rec.refused} - ${rec.lastError}`);
    logger.log(`lowsec: running open=${openCount === null ? "?" : openCount} plan=${boot.ok ? boot.round : "?"} `
      + `reconciled=${rec.ok ? rec.enqueued : "?"} exhausted=${rec.ok ? rec.exhausted : "?"} `
      + `refused=${rec.ok ? rec.refused : "?"}`);

    const facade = {
      getMode: service.getMode,
      getStatus: service.getStatus,
      repository: camps,
      stop() {
        if (service.isStopped()) return;
        service.stop();
        removeAll();
      },
    };
    return { ok: true, lowsec: Object.freeze(facade) };
  } catch (err) {
    for (const r of registrations.splice(0).reverse()) swallow(() => r());
    return { ok: false, reason: "LOWSEC_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startLowsec, createUnavailableLowsec, REQUIRED, SOFT_ROOTS };
