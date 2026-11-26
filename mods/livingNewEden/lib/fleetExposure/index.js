"use strict";

const { isModuleEnabled } = require("../../config");
const { createExposureRepository, END_ROWS } = require("./exposureRepository");
const { recoverStale } = require("./recovery");

const FLEET_EXPOSURE_METHODS = Object.freeze(["claimInTx", "markDestroyedInTx", "endInTx", "listOpenInTx", "getInTx",
  "isEnabled", "isKindEnabled", "getStatus", "stop"]);
const FLEET_METHODS = Object.freeze(["getFleet", "transition", "applyLosses"]);
const METRIC = Object.freeze({ recovered: "fleetExposure.recovered", recoverFailed: "fleetExposure.recoverFailed" });

const messageOf = (err) => String((err && err.message) || err);

function createUnavailableFleetExposure(reason, detail) {
  const status = Object.freeze({ state: "unavailable", reason: String(reason),
    ...(detail ? { detail: String(detail) } : {}) });
  const refusal = Object.freeze({ ok: false, reason: "FLEET_EXPOSURE_UNAVAILABLE", detail: String(reason) });
  return Object.freeze({
    claimInTx: () => refusal,
    markDestroyedInTx: () => refusal,
    endInTx: () => refusal,
    listOpenInTx: () => refusal,
    getInTx: () => refusal,
    isEnabled: () => false,
    isKindEnabled: () => false,
    getStatus: () => status,
    stop() {},
  });
}

function startFleetExposure(deps) {
  try {
    const { config, persistence, clock } = deps || {};
    if (!isModuleEnabled(config, "fleets")) return { ok: false, reason: "disabled_by_config" };
    if (!persistence || persistence.ok !== true || !persistence.store || !persistence.journal) {
      return { ok: false, reason: "dependency_disabled:persistence" };
    }
    if (!clock || typeof clock.now !== "function") {
      return { ok: false, reason: "FLEET_EXPOSURE_START_FAILED", detail: "clock" };
    }
    const fleetsOf = () => {
      try {
        return typeof deps.getFleets === "function" ? deps.getFleets() : null;
      } catch (_err) {
        return null;
      }
    };
    const fleets = fleetsOf();
    const fleetRepository = fleets && fleets.repository;
    const missing = FLEET_METHODS.filter((m) => !fleetRepository || typeof fleetRepository[m] !== "function");
    if (missing.length > 0) return { ok: false, reason: "FLEETS_UNAVAILABLE", detail: missing.join(",") };

    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    const telemetry = deps.telemetry || null;
    const count = (name, n) => {
      if (n <= 0 || !telemetry || typeof telemetry.count !== "function") return;
      try {
        telemetry.count(name, n);
      } catch (_err) {
      }
    };
    const enabled = () => Boolean(config.fleetExposure && config.fleetExposure.enabled === true);
    const sentryHoldOn = () => Boolean(config.sentries && config.sentries.enabled === true
      && config.sentries.liveHold && config.sentries.liveHold.enabled === true);
    const presenceOn = () => Boolean(config.fleetExposure && config.fleetExposure.presence
      && config.fleetExposure.presence.enabled === true);
    const kindEnabled = (kind) => {
      if (kind === "SENTRY") return sentryHoldOn();
      if (kind === "PRESENCE") return presenceOn();
      return enabled();
    };
    const store = persistence.store;
    const getTravel = () => {
      const f = fleetsOf();
      return f && f.travel ? f.travel : null;
    };
    const crewsOn = typeof deps.getCrews === "function" && Boolean(config.crews && config.crews.enabled === true)
      && Number.isSafeInteger(config.crews.maxSettleRows) && config.crews.maxSettleRows > 0;
    const crewRows = crewsOn ? config.crews.maxSettleRows + 1 : 0;
    const repo = createExposureRepository({ journal: persistence.journal, fleetRepository, getTravel,
      ...(typeof deps.releaseContact === "function" ? { releaseContact: deps.releaseContact } : {}),
      ...(crewsOn ? { getCrews: deps.getCrews, crewMaxRows: config.crews.maxSettleRows } : {}) });
    const maxRows = store.limits && Number.isSafeInteger(store.limits.maxRowsPerTransaction)
      ? store.limits.maxRowsPerTransaction : END_ROWS + crewRows;
    const pageLimit = Math.max(1, Math.floor(maxRows / (END_ROWS + crewRows)));
    const bootAt = clock.now();
    let stopped = false;
    const stats = { recovered: 0, recoverFailed: 0, lastError: null };

    const boot = recoverStale(store, repo, bootAt, pageLimit);
    stats.recovered += boot.ended;
    stats.recoverFailed += boot.failed;
    count(METRIC.recovered, boot.ended);
    count(METRIC.recoverFailed, boot.failed);
    if (!boot.ok) stats.lastError = `${boot.reason}${boot.detail ? ` (${boot.detail})` : ""}`;
    else if (boot.lastError) stats.lastError = boot.lastError;
    const travelReady = getTravel() !== null && typeof getTravel().interceptInTx === "function";
    logger.log(`fleetExposure: running enabled=${enabled()} travel=${travelReady ? "ready" : "unavailable"} `
      + `recovered=${boot.ended} failed=${boot.failed}${boot.ok ? "" : ` recover=${boot.reason}`}`
      + `${stats.lastError ? ` lastError=${stats.lastError}` : ""}`);

    const STOPPED = Object.freeze({ ok: false, reason: "FLEET_EXPOSURE_STOPPED" });
    const DISABLED = Object.freeze({ ok: false, reason: "FLEET_EXPOSURE_DISABLED" });
    const guard = (fn) => (...args) => (stopped ? STOPPED : fn(...args));
    const facade = {
      claimInTx: (tx, spec) => (stopped ? STOPPED
        : (kindEnabled(spec && typeof spec === "object" ? spec.kind : null) ? repo.claimInTx(tx, spec) : DISABLED)),
      markDestroyedInTx: guard(repo.markDestroyedInTx),
      endInTx: guard(repo.endInTx),
      listOpenInTx: guard(repo.listOpenInTx),
      getInTx: guard(repo.getInTx),
      isEnabled: () => !stopped && enabled(),
      isKindEnabled: (kind) => !stopped && kindEnabled(kind),
      getStatus: () => Object.freeze({ state: stopped ? "stopped" : "ready", enabled: enabled(),
        sentryHold: sentryHoldOn(), presence: presenceOn(), bootAt, pageLimit,
        recovered: stats.recovered, recoverFailed: stats.recoverFailed, lastError: stats.lastError }),
      stop() {
        stopped = true;
      },
    };
    return { ok: true, fleetExposure: Object.freeze(facade) };
  } catch (err) {
    return { ok: false, reason: "FLEET_EXPOSURE_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startFleetExposure, createUnavailableFleetExposure, FLEET_EXPOSURE_METHODS, METRIC };
