"use strict";

const { createPlayerSovRepository } = require("./repository");
const { createPlayerSovService } = require("./service");
const { VIEW_ID, buildPlayerSovView, buildDisabledPlayerSovView } = require("./view");
const { createDeployGate } = require("./deployGate");
const { createSovStructureRepository } = require("../sovStructures/repository");
const { createPlayerSovClockRepository } = require("./clock");

const UNAVAILABLE = "PLAYER_SOV_UNAVAILABLE";
const START_FAILED = "PLAYER_SOV_START_FAILED";
const TX_RESERVED_ROWS = 2;
const COUNT_KEYS = Object.freeze(["reconcileMs", "maxRowsPerPass", "scanBudgetMs", "retentionMs", "panelMaxRows",
  "maxRetakesPerPass"]);
const FACADE_METHODS = Object.freeze(["readClaimInTx", "listLive", "getStatus", "getRepository", "getConfig", "stop",
  "checkDeploy", "registerDeploy"]);

const messageOf = (err) => String((err && err.message) || err);

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function factionNamesOf(adapter) {
  if (!adapter || typeof adapter.readFactionNames !== "function") return new Map();
  const r = call(() => adapter.readFactionNames(), null);
  return r && r.ok === true && r.names instanceof Map ? r.names : new Map();
}

function chunkRowsOf(config, store) {
  const maxRows = config.persistence && config.persistence.maxRowsPerTransaction;
  const storeRows = store.limits && store.limits.maxRowsPerTransaction;
  const rowsCap = Number.isSafeInteger(storeRows) ? Math.min(maxRows || storeRows, storeRows) : maxRows;
  const budget = Number.isSafeInteger(rowsCap) ? rowsCap - TX_RESERVED_ROWS : 0;
  if (budget < 1) return { ok: false, detail: `persistence.maxRowsPerTransaction ${String(rowsCap)} < 3` };
  return { ok: true, rowsCap, chunkRows: Math.min(config.playerSov.maxRowsPerPass, budget) };
}

function createUnavailablePlayerSov(reason, detail) {
  const status = Object.freeze({ state: "unavailable", enabled: false, reason: String(reason),
    ...(detail ? { detail: String(detail).slice(0, 160) } : {}) });
  const refusal = Object.freeze({ ok: false, reason: UNAVAILABLE, detail: String(reason) });
  return Object.freeze({ readClaimInTx: () => refusal, listLive: () => refusal, getStatus: () => status,
    getRepository: () => null, getConfig: () => null, stop() {},
    checkDeploy: () => refusal, registerDeploy: () => refusal });
}

function registerDisabledView(views, reason, logger) {
  if (!views || typeof views.registerView !== "function") return null;
  const r = call(() => views.registerView(VIEW_ID, buildDisabledPlayerSovView(reason)), null);
  if (!r || !r.ok) logger.log(`playerSov: view ${VIEW_ID} not registered - ${(r && r.reason) || "no result"}`);
  return r && r.ok ? r : null;
}

function startPlayerSov(deps) {
  const logger = deps && deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  try {
    const { config, persistence, adapter, virtualCorps, clock } = deps || {};
    const C = config && config.playerSov;
    if (!C || C.enabled !== true) {
      return { ok: false, reason: "disabled_by_config", viewHandle: registerDisabledView(deps.views, "disabled_by_config",
        logger) };
    }
    const role = adapter && typeof adapter.getProcessRole === "function" ? call(() => adapter.getProcessRole(), null)
      : null;
    if (role !== "world") return { ok: false, reason: "not_world_process" };
    if (!persistence || persistence.ok !== true || !persistence.store) {
      return { ok: false, reason: "dependency_disabled:persistence" };
    }
    if (!virtualCorps || typeof virtualCorps.isVirtualAlliance !== "function"
      || typeof virtualCorps.whenReady !== "function") {
      return { ok: false, reason: "dependency_disabled:virtualCorps" };
    }
    if (!clock || typeof clock.now !== "function") return { ok: false, reason: START_FAILED, detail: "clock" };
    for (const key of COUNT_KEYS) {
      if (!Number.isSafeInteger(C[key]) || C[key] < 1) return { ok: false, reason: START_FAILED, detail: `playerSov.${key}` };
    }
    if (!Number.isSafeInteger(C.autoCaptureMs) || C.autoCaptureMs < 0) {
      return { ok: false, reason: START_FAILED, detail: "playerSov.autoCaptureMs" };
    }
    for (const name of ["readPlayerSov", "capturePlayerSov", "readSovereigntyTableUpdatedAt", "playerSovSeams"]) {
      if (typeof adapter[name] !== "function") return { ok: false, reason: "dependency_disabled:adapter", detail: name };
    }
    const seams = call(() => adapter.playerSovSeams(), null);
    if (!seams || seams.ok !== true) {
      const detail = (seams && (seams.detail || seams.reason)) || "no result";
      logger.log(`playerSov: seams unavailable - ${detail}; player sovereignty mirror off`);
      return { ok: false, reason: "PLAYER_SOV_SEAM_UNAVAILABLE", detail,
        viewHandle: registerDisabledView(deps.views, "PLAYER_SOV_SEAM_UNAVAILABLE", logger) };
    }
    const rows = chunkRowsOf(config, persistence.store);
    if (!rows.ok) return { ok: false, reason: START_FAILED, detail: rows.detail };
    if (rows.chunkRows < C.maxRowsPerPass) {
      logger.log(`playerSov: mirror transactions bounded by persistence.maxRowsPerTransaction ${rows.rowsCap} `
        + `(maxRowsPerPass ${C.maxRowsPerPass} -> ${rows.chunkRows} rows per transaction)`);
    }

    const repository = createPlayerSovRepository();
    const service = createPlayerSovService({ store: persistence.store, repository, adapter, virtualCorps, config,
      clock, chunkRows: rows.chunkRows, telemetry: deps.telemetry || null, logger, getGovernor: deps.getGovernor,
      setTimer: deps.setTimer, journal: persistence.journal || null });
    const started = service.start();
    if (!started || !started.ok) {
      service.stop();
      return { ok: false, reason: START_FAILED, detail: (started && started.reason) || "service" };
    }

    let viewHandle = null;
    const views = deps.views;
    if (views && typeof views.registerView === "function") {
      const def = buildPlayerSovView({ store: persistence.store, repository, getGovernor: deps.getGovernor,
        graph: deps.graph || null, factionNames: factionNamesOf(adapter), maxRows: C.panelMaxRows,
        readOrgNames: typeof adapter.readPlayerOrgNames === "function" ? (spec) => adapter.readPlayerOrgNames(spec)
          : null,
        clockRepo: createPlayerSovClockRepository(), needMs: { SIEGED: C.siegeHoldMs, REINFORCED: C.reinforceMs } });
      const r = call(() => views.registerView(VIEW_ID, def), null);
      if (r && r.ok) viewHandle = r;
      else logger.log(`playerSov: view ${VIEW_ID} not registered - ${(r && r.reason) || "no result"}`);
    }

    const deployGate = createDeployGate({ store: persistence.store, repository,
      sovRepository: createSovStructureRepository(), clock, factionNames: factionNamesOf(adapter) });

    const facade = {
      checkDeploy: (input) => deployGate.checkDeploy(input),
      registerDeploy: (input) => deployGate.registerDeploy(input),
      readClaimInTx: (db, systemId) => repository.getLiveInSystem(db, systemId),
      listLive: (db) => repository.listLive(db),
      getStatus: () => service.getStatus(),
      getRepository: () => repository,
      getConfig: () => C,
      stop() {
        if (service.isStopped()) return;
        service.stop();
        if (viewHandle) call(() => viewHandle.unregister(), null);
      },
    };
    return { ok: true, playerSov: Object.freeze(facade) };
  } catch (err) {
    return { ok: false, reason: START_FAILED, detail: messageOf(err) };
  }
}

module.exports = { startPlayerSov, createUnavailablePlayerSov, chunkRowsOf, FACADE_METHODS };
