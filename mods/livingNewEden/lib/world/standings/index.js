"use strict";

const { isStandingsEnabled } = require("../../../config");
const killObservation = require("../../adapter/killObservation");
const { createStandingsService } = require("./standingsService");
const { validateData } = require("./standingsRules");
const { STANDINGS_DATA_V1 } = require("./data/standingsData");
const { createStandingsPrune } = require("./standingsPrune");
const { EVENT_TYPE, PRUNE_EVENT_TYPE, PRUNE_ROWS_FIXED } = require("./schema");

const STATE_UNAVAILABLE = "unavailable";

function startPrune(deps, persistence, scheduler, adapter, logger) {
  const { config } = deps;
  const s = config.standings;
  if (s.pruneEnabled !== true) return { ok: false, reason: "disabled_by_config" };
  const maxRows = config.persistence && config.persistence.maxRowsPerTransaction;
  const storeRows = persistence.store.limits && persistence.store.limits.maxRowsPerTransaction;
  const rowsCap = Number.isSafeInteger(storeRows) ? Math.min(maxRows || storeRows, storeRows) : maxRows;
  if (!Number.isSafeInteger(rowsCap) || 2 * s.pruneMaxGrantsPerPass + PRUNE_ROWS_FIXED > rowsCap) {
    return { ok: false, reason: "STANDINGS_PRUNE_EXCEEDS_MAX_ROWS",
      detail: `2*${s.pruneMaxGrantsPerPass}+${PRUNE_ROWS_FIXED} > ${rowsCap}` };
  }
  if (typeof adapter.checkReceiptPrune !== "function" || typeof adapter.listStandingReceiptKeys !== "function"
    || typeof adapter.pruneStandingReceipts !== "function") {
    return { ok: false, reason: "RECEIPT_SEAM_UNAVAILABLE", detail: "adapter" };
  }
  const seam = adapter.checkReceiptPrune();
  if (!seam || !seam.ok) return { ok: false, reason: "RECEIPT_SEAM_UNAVAILABLE", detail: seam && seam.reason };
  if (typeof scheduler.purgeDone !== "function" || typeof persistence.journal.scanKeyRange !== "function"
    || typeof persistence.journal.purgeTerminal !== "function") {
    return { ok: false, reason: "PRUNE_DEPENDENCY_UNAVAILABLE" };
  }
  const prune = createStandingsPrune({ store: persistence.store, journal: persistence.journal, scheduler, adapter,
    clock: deps.clock, config, maxScanRows: rowsCap, telemetry: deps.telemetry || null, logger, nowMs: deps.nowMs });
  let registration;
  try {
    registration = scheduler.registerHandler(PRUNE_EVENT_TYPE, prune.handler, { maxPerPass: 1 });
  } catch (err) {
    registration = { ok: false, reason: messageOf(err) };
  }
  if (!registration || !registration.ok) {
    prune.stop();
    return { ok: false, reason: "STANDINGS_PRUNE_START_FAILED",
      detail: `handler ${PRUNE_EVENT_TYPE}: ${(registration && registration.reason) || "no result"}` };
  }
  const boot = prune.bootstrap();
  if (!boot.ok) {
    swallow(() => logger.log(`standings: prune chain not started (${boot.reason}); the next start retries`));
  }
  return { ok: true, prune, registration };
}

function messageOf(err) {
  return String((err && err.message) || err);
}

function swallow(fn) {
  try {
    fn();
  } catch (_err) {
  }
}

function createUnavailableStandings(reason, detail) {
  const refusal = Object.freeze({ ok: false, reason: String(reason), ...(detail ? { detail: String(detail) } : {}) });
  const status = Object.freeze({ state: STATE_UNAVAILABLE, reason: refusal.reason });
  const refuse = () => refusal;
  return Object.freeze({ onNpcKill: refuse, onNavyPenalty: refuse, onConvoyPenalty: refuse, getStatus: () => status,
    stop() {} });
}

function startStandings(deps) {
  try {
    const { config, persistence, clock, scheduler } = deps || {};
    if (!isStandingsEnabled(config)) return { ok: false, reason: "disabled_by_config" };
    if (!persistence || persistence.ok !== true || !persistence.store || !persistence.journal) {
      return { ok: false, reason: "dependency_disabled:persistence" };
    }
    const world = deps.world;
    if (!world || !world.repository) return { ok: false, reason: "WORLD_UNAVAILABLE" };
    if (!scheduler || typeof scheduler.registerHandler !== "function" || typeof scheduler.enqueue !== "function") {
      return { ok: false, reason: "SCHEDULER_UNAVAILABLE" };
    }
    const cap = config.standings.maxGrantsPerCharacterDay;
    const maxRows = config.persistence && config.persistence.maxRowsPerTransaction;
    if (cap > 0 && Number.isSafeInteger(maxRows) && cap > maxRows) {
      return { ok: false, reason: "STANDINGS_CAP_EXCEEDS_MAX_ROWS", detail: `${cap} > ${maxRows}` };
    }
    const adapter = deps.adapter;
    if (!adapter || typeof adapter.applyStandingGrant !== "function" || typeof adapter.checkStandingWrite !== "function"
      || typeof adapter.readPirateFactionIds !== "function") {
      return { ok: false, reason: "STANDING_SEAM_UNAVAILABLE", detail: "adapter" };
    }
    const seam = adapter.checkStandingWrite();
    if (!seam || !seam.ok) return { ok: false, reason: "STANDING_SEAM_UNAVAILABLE", detail: seam && seam.reason };
    const pirates = adapter.readPirateFactionIds();
    if (!pirates || !pirates.ok) {
      return { ok: false, reason: "PIRATE_SET_UNAVAILABLE", detail: pirates && (pirates.detail || pirates.reason) };
    }
    const data = deps.data || STANDINGS_DATA_V1;
    const valid = validateData(data, pirates.ids);
    if (!valid.ok) return valid;
    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    const pirateSideEnabled = config.standings && config.standings.pirateSideEnabled === true;
    logger.log(`standings: pirateSideEnabled=${pirateSideEnabled}`);
    let service;
    try {
      service = createStandingsService({ store: persistence.store, journal: persistence.journal,
        repository: world.repository, scheduler, adapter, graph: deps.graph || null, clock, config,
        pirateIds: pirates.ids, data, telemetry: deps.telemetry || null, logger, nowMs: deps.nowMs });
    } catch (err) {
      return { ok: false, reason: "STANDINGS_START_FAILED", detail: messageOf(err) };
    }

    let registration;
    try {
      registration = scheduler.registerHandler(EVENT_TYPE, service.handler,
        { maxPerPass: config.standings.maxGrantsPerPass });
    } catch (err) {
      registration = { ok: false, reason: messageOf(err) };
    }
    if (!registration || !registration.ok) {
      return { ok: false, reason: "STANDINGS_START_FAILED",
        detail: `handler ${EVENT_TYPE}: ${(registration && registration.reason) || "no result"}` };
    }
    killObservation.setStandings(service);

    let pruned;
    try {
      pruned = startPrune(deps, persistence, scheduler, adapter, logger);
    } catch (err) {
      pruned = { ok: false, reason: "STANDINGS_PRUNE_START_FAILED", detail: messageOf(err) };
    }
    const pruneOff = pruned.ok ? null : Object.freeze({ state: "off", reason: pruned.reason,
      ...(pruned.detail ? { detail: String(pruned.detail) } : {}) });
    const pruneStatus = () => (pruned.ok ? pruned.prune.getStatus() : pruneOff);

    const facade = Object.freeze({
      onNpcKill: service.onNpcKill,
      onNavyPenalty: service.onNavyPenalty,
      onConvoyPenalty: service.onConvoyPenalty,
      params: service.params,
      getStatus: () => Object.freeze({ ...service.getStatus(), prune: pruneStatus() }),
      stop() {
        if (service.isStopped()) return;
        service.stop();
        swallow(() => killObservation.setStandings(null));
        swallow(() => registration.unregister());
        if (pruned.ok) {
          swallow(() => pruned.prune.stop());
          swallow(() => pruned.registration.unregister());
        }
      },
    });
    return { ok: true, standings: facade };
  } catch (err) {
    return { ok: false, reason: "STANDINGS_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startStandings, createUnavailableStandings };
