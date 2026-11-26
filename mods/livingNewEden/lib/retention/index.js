"use strict";

const { CLASSES } = require("./classes");
const { EVENT_TYPE } = require("./schema");
const { createRetention } = require("./retentionService");

const STATE_UNAVAILABLE = "unavailable";
const FIXED_ROWS = 2;
const SCHEDULER_METHODS = Object.freeze(["registerHandler", "enqueue", "scanKeys", "purgeDone", "statesOf"]);
const JOURNAL_METHODS = Object.freeze(["scanKeyRange", "purgeTerminal"]);

function messageOf(err) {
  return String((err && err.message) || err);
}

function swallow(fn) {
  try {
    fn();
  } catch (_err) {
  }
}

function disabledIdsOf(text) {
  if (typeof text !== "string") return new Set();
  return new Set(text.split(",").map((s) => s.trim()).filter((s) => s !== ""));
}

function createUnavailableRetention(reason, detail) {
  const status = Object.freeze({ state: STATE_UNAVAILABLE, reason: String(reason),
    ...(detail ? { detail: String(detail) } : {}) });
  return Object.freeze({ getStatus: () => status, stop() {} });
}

function startRetention(deps) {
  try {
    const { config, persistence, scheduler, clock } = deps || {};
    const rc = config && config.retention;
    if (!rc || rc.enabled !== true) return { ok: false, reason: "disabled_by_config" };
    if (!persistence || persistence.ok !== true || !persistence.store
      || typeof persistence.store.transaction !== "function") {
      return { ok: false, reason: "RETENTION_DEPENDENCY_UNAVAILABLE", detail: "persistence" };
    }
    const missing = SCHEDULER_METHODS.filter((m) => !scheduler || typeof scheduler[m] !== "function");
    if (missing.length > 0) {
      return { ok: false, reason: "RETENTION_DEPENDENCY_UNAVAILABLE", detail: `scheduler.${missing.join(",")}` };
    }
    const journal = persistence.journal;
    const missingJ = JOURNAL_METHODS.filter((m) => !journal || typeof journal[m] !== "function");
    if (missingJ.length > 0) {
      return { ok: false, reason: "RETENTION_DEPENDENCY_UNAVAILABLE", detail: `journal.${missingJ.join(",")}` };
    }
    if (!clock || typeof clock.now !== "function") {
      return { ok: false, reason: "RETENTION_DEPENDENCY_UNAVAILABLE", detail: "clock" };
    }
    const maxRows = config.persistence && config.persistence.maxRowsPerTransaction;
    const storeRows = persistence.store.limits && persistence.store.limits.maxRowsPerTransaction;
    const rowsCap = Number.isSafeInteger(storeRows) ? Math.min(maxRows || storeRows, storeRows) : maxRows;
    if (!Number.isSafeInteger(rowsCap) || rowsCap < FIXED_ROWS + 1) {
      return { ok: false, reason: "RETENTION_EXCEEDS_MAX_ROWS", detail: `${String(rowsCap)} < ${FIXED_ROWS + 1}` };
    }
    const disabled = disabledIdsOf(rc.disabledClasses);
    const classes = CLASSES.filter((c) => !disabled.has(c.id));
    const params = { dryRun: rc.dryRun === true, intervalMs: rc.intervalMs, minAgeMs: rc.minAgeMs,
      maxScanRowsPerPass: Math.min(rc.maxScanRowsPerPass, rowsCap),
      maxDeleteRowsPerPass: Math.min(rc.maxDeleteRowsPerPass, rowsCap - FIXED_ROWS), maxScanRows: rowsCap,
      classes: classes.map((c) => c.id),
      classMinAgeMs: Object.fromEntries(classes.filter((c) => typeof c.minAgeOf === "function")
        .map((c) => [c.id, c.minAgeOf(config)]).filter(([, ms]) => Number.isSafeInteger(ms) && ms > 0)) };
    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    const telemetry = deps.telemetry || null;
    const service = createRetention({ store: persistence.store, scheduler, journal, clock, classes, params, telemetry,
      logger, nowMs: deps.nowMs });
    let registration;
    try {
      registration = scheduler.registerHandler(EVENT_TYPE, service.handler, { maxPerPass: 1 });
    } catch (err) {
      registration = { ok: false, reason: messageOf(err) };
    }
    if (!registration || !registration.ok) {
      service.stop();
      return { ok: false, reason: "RETENTION_START_FAILED",
        detail: `handler ${EVENT_TYPE}: ${(registration && registration.reason) || "no result"}` };
    }
    if (telemetry && typeof telemetry.gauge === "function") {
      swallow(() => telemetry.gauge("persistence.retention.dryRun", params.dryRun ? 1 : 0));
    }
    const boot = service.bootstrap();
    if (!boot.ok) swallow(() => logger.log(`retention: chain not started (${boot.reason}); the next start retries`));
    const retention = Object.freeze({
      getStatus: service.getStatus,
      stop() {
        service.stop();
        swallow(() => registration.unregister());
      },
    });
    return { ok: true, retention };
  } catch (err) {
    return { ok: false, reason: "RETENTION_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startRetention, createUnavailableRetention };
