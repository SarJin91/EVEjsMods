"use strict";

const { isModuleEnabled } = require("../../../config");
const { createHostility } = require("../../battle/data/hostility");
const { createBlockadeService, paramsOf, gateSettingsOf, INTERCEPT_EVENT, POSITION_EVENT } = require("./blockadeService");
const { rowBoundsOfConfig, rowBoundOverflow } = require("../reviewBound");

const STATE_READY = "ready";
const REQUIRED = Object.freeze(["fleets.repository.getFleet", "fleets.repository.getFleets",
  "fleets.repository.getOperation", "fleets.repository.listOperationsByTarget", "fleets.repository.listFleetsByState",
  "fleets.repository.listFleetsOfOperation", "fleets.travel.interceptInTx", "fleets.travel.addDepartureListener",
  "scheduler.registerHandler", "scheduler.enqueue", "scheduler.getStatus", "persistence.store.transaction",
  "persistence.journal.applyOnce", "persistence.journal.findByKey", "battle.readCooldownsInTx",
  "fleets.grid.isEnabled", "fleets.grid.movesEnabled", "fleets.grid.readSystemGrid", "fleets.grid.positionsOf",
  "fleets.grid.moveGroupInTx", "fleets.grid.placeInTx"]);
const SOFT_ROOTS = Object.freeze(["battle"]);
const COUNT_KEYS = Object.freeze([["blockadeInterceptChancePermille", 0, 1000], ["blockadeListenerMaxSystems", 1, 128],
  ["blockadeOpsPerSystemRead", 1, 64], ["blockadeMaxCrossingsPerLeg", 1, 8],
  ["blockadeActivationScanMaxFleets", 1, 1000]]);

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

function createUnavailableBlockade(reason, detail) {
  const status = Object.freeze({ state: "unavailable", reason: String(reason), ...(detail ? { detail: String(detail) }
    : {}) });
  return Object.freeze({ getMode: () => "off", getStatus: () => status,
    registerBlockadeInTx: () => ({ ok: false, reason: "BLOCKADE_UNAVAILABLE" }), countScan() {}, stop() {} });
}

function startBlockade(deps) {
  const registrations = [];
  const removeAll = () => {
    for (const r of registrations.splice(0).reverse()) swallow(() => r());
  };
  try {
    const { config, persistence, scheduler, fleets } = deps || {};
    if (!isModuleEnabled(config, "strategy") || !config.strategy || config.strategy.blockadeEnabled !== true) {
      return { ok: false, reason: "disabled_by_config" };
    }
    const over = rowBoundOverflow(rowBoundsOfConfig(config),
      config.persistence ? config.persistence.maxRowsPerTransaction : undefined);
    if (over) return { ok: false, reason: "BLOCKADE_ROW_BOUND", detail: over };
    if (!persistence || persistence.ok !== true || !persistence.store || !persistence.journal) {
      return { ok: false, reason: "dependency_disabled:persistence" };
    }
    if (!scheduler || stateOf(scheduler) !== STATE_READY) return { ok: false, reason: "SCHEDULER_UNAVAILABLE" };
    if (!fleets || !fleets.repository || !fleets.travel) return { ok: false, reason: "FLEETS_UNAVAILABLE" };
    const missing = missingPaths({ fleets, scheduler, persistence });
    if (missing.length > 0) return { ok: false, reason: "BLOCKADE_FACADE_MISSING", detail: missing.join(",") };
    const st = config.strategy;
    for (const [key, min, max] of COUNT_KEYS) {
      if (!Number.isSafeInteger(st[key]) || st[key] < min || st[key] > max) {
        return { ok: false, reason: "INVALID_CONFIG", detail: `strategy.${key}` };
      }
    }
    const params = paramsOf(st);
    if (!params) return { ok: false, reason: "INVALID_CONFIG", detail: "strategy.blockadeInterceptOperationTypes" };

    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    const service = createBlockadeService({ store: persistence.store, journal: persistence.journal, scheduler,
      fleetRepository: fleets.repository, travel: fleets.travel, params, worldSeed: persistence.worldSeed,
      isHostile: typeof deps.isHostile === "function" ? deps.isHostile : createHostility(),
      getBattle: deps.getBattle, telemetry: deps.telemetry || null, logger, grid: fleets.grid || null,
      gate: gateSettingsOf(config), clock: deps.clock || null, getWorld: deps.getWorld });

    for (const [type, fn] of [[INTERCEPT_EVENT, service.onIntercept], [POSITION_EVENT, service.onPosition]]) {
      let handler;
      try {
        handler = scheduler.registerHandler(type, fn);
      } catch (err) {
        handler = { ok: false, reason: messageOf(err) };
      }
      if (!handler || !handler.ok) {
        removeAll();
        return { ok: false, reason: "BLOCKADE_START_FAILED",
          detail: `handler ${type}: ${(handler && handler.reason) || "no result"}` };
      }
      registrations.push(() => handler.unregister());
    }
    const listener = fleets.travel.addDepartureListener(service.onDeparture);
    if (!listener || listener.ok !== true) {
      removeAll();
      return { ok: false, reason: "BLOCKADE_START_FAILED",
        detail: `departure listener: ${(listener && listener.reason) || "no result"}` };
    }
    registrations.push(() => listener.remove());
    logger.log(`blockade: running chance=${params.interceptChancePermille} `
      + `types=${params.interceptOperationTypes.join(",") || "none"}`
      + `${service.getStatus().gate ? " gate=on" : ""}`);

    const facade = {
      getMode: service.getMode,
      getStatus: service.getStatus,
      registerBlockadeInTx: service.registerBlockadeInTx,
      countScan: service.countScan,
      stop() {
        if (service.isStopped()) return;
        service.stop();
        removeAll();
      },
    };
    return { ok: true, blockade: Object.freeze(facade) };
  } catch (err) {
    removeAll();
    return { ok: false, reason: "BLOCKADE_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startBlockade, createUnavailableBlockade, REQUIRED, SOFT_ROOTS };
