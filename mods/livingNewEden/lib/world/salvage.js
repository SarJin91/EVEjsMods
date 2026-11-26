"use strict";

const { isModuleEnabled } = require("../../config");
const { createSalvageRepository } = require("./salvageRepository");
const { createSalvageService, pulseRowBound, PULSE_EVENT, ADVANCE_EVENT, DELIVERY_EVENT } =
  require("../economy/salvageScheduler");

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

function createUnavailableSalvage(reason, detail) {
  const status = Object.freeze({ state: "unavailable", reason: String(reason),
    ...(detail ? { detail: String(detail) } : {}) });
  const refusal = Object.freeze({ ok: false, reason: "SALVAGE_UNAVAILABLE", detail: String(reason) });
  return Object.freeze({ repository: null, reconcile: () => refusal, getStatus: () => status, stop() {} });
}

function startSalvage(deps) {
  try {
    const { config, persistence, clock, scheduler, wrecks } = deps || {};
    if (!isModuleEnabled(config, "world") || !config.salvage || config.salvage.enabled !== true) {
      return { ok: false, reason: "disabled_by_config" };
    }
    if (!persistence || persistence.ok !== true || !persistence.store || !persistence.journal) {
      return { ok: false, reason: "dependency_disabled:persistence" };
    }
    if (!wrecks || !wrecks.repository || typeof wrecks.repository.recordSalvageInTx !== "function") {
      return { ok: false, reason: "dependency_disabled:wrecks" };
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
    if (!clock || typeof clock.now !== "function") return { ok: false, reason: "SALVAGE_START_FAILED", detail: "clock" };
    const P = config.salvage;
    const store = persistence.store;
    const maxRows = store.limits && store.limits.maxRowsPerTransaction;
    if (Number.isSafeInteger(maxRows) && pulseRowBound(P.maxNewJobsPerPulse) > maxRows) {
      return { ok: false, reason: "SALVAGE_EXCEEDS_MAX_ROWS",
        detail: `salvage.maxNewJobsPerPulse=${P.maxNewJobsPerPulse} -> ${pulseRowBound(P.maxNewJobsPerPulse)} rows > ${maxRows}` };
    }
    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    const repository = createSalvageRepository({ journal: persistence.journal });
    const graph = deps.graph || null;
    const service = createSalvageService({ store, salvage: repository, wrecks: wrecks.repository, scheduler, clock,
      config, getStations: deps.getStations, telemetry: deps.telemetry || null, logger,
      getGraph: () => {
        if (!graph || typeof graph.getGraph !== "function") return null;
        const r = graph.getGraph();
        return r && r.ok ? r.graph : null;
      } });

    const registrations = [];
    const unregisterAll = () => registrations.forEach((r) => swallow(() => r.unregister()));
    for (const [type, fn, opts] of [[PULSE_EVENT, service.pulseHandler, { maxPerPass: 1 }],
      [ADVANCE_EVENT, service.advanceHandler, undefined], [DELIVERY_EVENT, service.deliveryHandler, undefined]]) {
      let r;
      try {
        r = scheduler.registerHandler(type, fn, opts);
      } catch (err) {
        r = { ok: false, reason: messageOf(err) };
      }
      if (!r || !r.ok) {
        unregisterAll();
        return { ok: false, reason: "SALVAGE_START_FAILED", detail: `handler ${type}: ${(r && r.reason) || "no result"}` };
      }
      registrations.push(r);
    }

    const chain = service.bootstrap();
    if (!chain.ok) logger.log(`salvage: pulse chain not started ${chain.reason}; the next start retries`);
    const rec = service.reconcile();
    if (!rec.ok) logger.log(`salvage: reconcile failed ${rec.reason}; the next start retries`);
    else if (rec.enqueued > 0) logger.log(`salvage: reconcile open=${rec.open} enqueued=${rec.enqueued}`);

    const facade = {
      repository,
      reconcile: service.reconcile,
      getStatus: () => Object.freeze({ ...service.getStatus(), pulseChain: chain.ok }),
      stop() {
        if (service.isStopped()) return;
        service.stop();
        unregisterAll();
      },
    };
    return { ok: true, salvage: Object.freeze(facade) };
  } catch (err) {
    return { ok: false, reason: "SALVAGE_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startSalvage, createUnavailableSalvage };
