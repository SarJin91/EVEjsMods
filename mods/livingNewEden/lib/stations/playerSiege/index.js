"use strict";

const { isModuleEnabled } = require("../../../config");
const { GROUPS: STRENGTH_GROUPS } = require("../../battle/data/strengthCatalog");
const { expandStrengthGroups } = require("../../battle/strength");
const { capitalPowerOverlayOf } = require("../../battle/data/capitalStrengthRows");
const { createHostility } = require("../../battle/data/hostility");
const { createPlayerSiegeRepository } = require("./repository");
const { createPlayerSiegeService } = require("./service");
const { GRID_MOVE_ROWS, GRID_STEP_ROWS } = require("../siege/gridScope");
const S = require("./schema");

const SCHEDULER_READY = "ready";
const UNAVAILABLE = "PLAYER_SIEGE_UNAVAILABLE";
const START_FAILED = "PLAYER_SIEGE_START_FAILED";
const COUNT_KEYS = Object.freeze(["ownerOnlineWindowMs", "maxMembersRead", "assaultMinMs", "assaultMaxMs",
  "hitMarginMs", "timerExitDelayMs", "lagRecheckMs", "maxLagRounds", "recheckMs", "maxWaitRounds", "maxOpen",
  "maxOpenPerFaction", "maxOpenPerOwner", "structureCooldownMs", "retentionMs", "pruneBatch", "scanIntervalMs",
  "maxSystemsPerScan", "indexTtlMs", "maxIndexStructures", "maxStructuresPerCheck", "maxStandingReadsPerCheck",
  "maxFleetsReadPerCheck", "maxChecksPerPass", "maxStepsPerPass", "reconcileMaxSieges", "stepLostBufferMs"]);
const FACADE_METHODS = Object.freeze(["getMode", "getStatus", "whenReady", "reconcile", "readForFaction",
  "readForFactions", "readTargetsForFaction", "listOpen", "stop"]);

function messageOf(err) {
  return String((err && err.message) || err);
}

function swallow(fn) {
  try {
    fn();
  } catch (_err) {
  }
}

function createUnavailablePlayerSiege(reason, detail) {
  const refusal = Object.freeze({ ok: false, reason: UNAVAILABLE, detail: String(reason)
    + (detail ? `: ${detail}` : "") });
  const status = Object.freeze({ state: "unavailable", reason: String(reason) });
  const refuse = () => refusal;
  return Object.freeze({ getMode: () => "off", getStatus: () => status, whenReady: () => Promise.resolve(status),
    reconcile: refuse, readForFaction: refuse, readForFactions: refuse, readTargetsForFaction: refuse, listOpen: refuse,
    stop() {} });
}

function seamOf(adapter) {
  if (!adapter || typeof adapter.playerStructureSeams !== "function") return { ok: false, detail: "adapter" };
  let check;
  try {
    check = adapter.playerStructureSeams();
  } catch (err) {
    return { ok: false, detail: messageOf(err) };
  }
  if (!check || check.ok !== true) return { ok: false, detail: String((check && (check.detail || check.reason)) || "?") };
  let seam = null;
  try {
    seam = adapter.playerStructures;
  } catch (err) {
    return { ok: false, detail: messageOf(err) };
  }
  return seam && typeof seam === "object" ? { ok: true, seam } : { ok: false, detail: "playerStructures" };
}

function startPlayerSiege(deps) {
  try {
    const { config, persistence, clock, ids, scheduler } = deps || {};
    if (!isModuleEnabled(config, "strategy") || !config.playerSiege || config.playerSiege.enabled !== true) {
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
    if (!scheduler || typeof scheduler.registerHandler !== "function" || typeof scheduler.enqueueMany !== "function"
      || typeof scheduler.enqueue !== "function" || schedulerState !== SCHEDULER_READY) {
      return { ok: false, reason: "SCHEDULER_UNAVAILABLE" };
    }
    const fleets = deps.fleets;
    if (!fleets || !fleets.repository || typeof fleets.repository.listFleetsInSystem !== "function"
      || !fleets.travel || typeof fleets.travel.addArrivalListener !== "function") {
      return { ok: false, reason: "FLEETS_UNAVAILABLE" };
    }
    const registry = deps.strategy && deps.strategy.registry;
    if (!registry || typeof registry.isActive !== "function" || typeof registry.getFaction !== "function") {
      return { ok: false, reason: "dependency_disabled:strategy" };
    }
    if (!clock || typeof clock.now !== "function" || !ids || typeof ids.next !== "function") {
      return { ok: false, reason: START_FAILED, detail: "clock/ids" };
    }
    const C = config.playerSiege;
    for (const key of COUNT_KEYS) {
      if (!Number.isSafeInteger(C[key]) || C[key] < 0) return { ok: false, reason: START_FAILED, detail: `playerSiege.${key}` };
    }
    if (C.assaultMaxMs < C.assaultMinMs) {
      return { ok: false, reason: START_FAILED, detail: `playerSiege.assaultMaxMs ${C.assaultMaxMs} < `
        + `playerSiege.assaultMinMs ${C.assaultMinMs}` };
    }
    if (C.retentionMs < C.structureCooldownMs) {
      return { ok: false, reason: START_FAILED, detail: `playerSiege.retentionMs ${C.retentionMs} < `
        + `playerSiege.structureCooldownMs ${C.structureCooldownMs}` };
    }
    const maxRows = config.persistence && config.persistence.maxRowsPerTransaction;
    if (Number.isSafeInteger(maxRows) && (S.START_ROWS + C.pruneBatch > maxRows || S.END_ROWS > maxRows)) {
      return { ok: false, reason: START_FAILED, detail: `player siege start rows ${S.START_ROWS + C.pruneBatch} / end `
        + `rows ${S.END_ROWS} > persistence.maxRowsPerTransaction ${maxRows} - lower playerSiege.pruneBatch` };
    }
    const SG = config.siege || {};
    if (SG.gridEnabled === true) {
      const movers = SG.gridMaxMovers;
      if (!Number.isSafeInteger(movers) || movers < 0) {
        return { ok: false, reason: START_FAILED, detail: "siege.gridMaxMovers" };
      }
      const moveRows = GRID_MOVE_ROWS * movers;
      if (Number.isSafeInteger(maxRows) && (S.START_ROWS + C.pruneBatch + moveRows > maxRows
        || GRID_STEP_ROWS + moveRows > maxRows)) {
        return { ok: false, reason: START_FAILED, detail: `player siege grid rows (start ${S.START_ROWS + C.pruneBatch
          + moveRows}, step ${GRID_STEP_ROWS + moveRows}) > persistence.maxRowsPerTransaction ${maxRows} - lower `
          + "siege.gridMaxMovers" };
      }
    }
    const seam = seamOf(deps.adapter);
    if (!seam.ok) return { ok: false, reason: "PLAYER_STRUCTURES_SEAM_UNAVAILABLE", detail: seam.detail };
    const adapter = deps.adapter;
    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    const store = persistence.store;
    const repository = createPlayerSiegeRepository({ journal: persistence.journal, ids });
    const graph = deps.graph || null;
    const service = createPlayerSiegeService({ store, sieges: repository, scheduler, fleetRepository: fleets.repository,
      grid: fleets.grid || null, registry, seam: seam.seam, config, clock, hostility: createHostility(),
      readStanding: typeof adapter.readCharacterStanding === "function"
        ? (characterId, ownerId) => adapter.readCharacterStanding(characterId, ownerId) : null,
      getVirtualCorps: typeof deps.getVirtualCorps === "function" ? deps.getVirtualCorps : () => null,
      getGraph: () => (graph && typeof graph.getGraph === "function" ? graph.getGraph() : null),
      groups: expandStrengthGroups(STRENGTH_GROUPS, null, capitalPowerOverlayOf(config.strategy)),
      telemetry: deps.telemetry || null, logger });

    const registrations = [];
    const unregisterAll = () => {
      for (const r of registrations.splice(0)) swallow(() => r.unregister());
    };
    for (const [type, fn, maxPerPass] of [[S.CHECK_EVENT_TYPE, service.onCheck, C.maxChecksPerPass],
      [S.STEP_EVENT_TYPE, service.onStep, C.maxStepsPerPass], [S.SCAN_EVENT_TYPE, service.onScan, 1]]) {
      let registration;
      try {
        registration = scheduler.registerHandler(type, fn, { maxPerPass });
      } catch (err) {
        registration = { ok: false, reason: messageOf(err) };
      }
      if (!registration || !registration.ok) {
        unregisterAll();
        return { ok: false, reason: START_FAILED,
          detail: `handler ${type}: ${(registration && registration.reason) || "no result"}` };
      }
      registrations.push(registration);
    }
    const listener = fleets.travel.addArrivalListener(service.onArrival);
    if (!listener || !listener.ok) {
      unregisterAll();
      return { ok: false, reason: START_FAILED, detail: `arrival listener: ${(listener && listener.reason)
        || "no result"}` };
    }

    const boot = service.bootstrap();
    if (!boot.ok) logger.log(`playerSiege: scan bootstrap failed ${boot.reason}; the next start retries`);
    const rec = service.reconcile();
    if (!rec.ok) logger.log(`playerSiege: reconcile failed ${rec.reason}; the next start retries`);
    else if (rec.enqueued > 0 || rec.lost > 0) {
      logger.log(`playerSiege: reconcile open=${rec.open} enqueued=${rec.enqueued} lost=${rec.lost}`);
    }
    logger.log(`playerSiege: running open=${rec.ok ? rec.open : "?"} families=${C.targetFamilies} destroy=`
      + `${C.destroyEnabled === true}`);

    const facade = {
      getMode: service.getMode,
      getStatus: service.getStatus,
      whenReady: () => Promise.resolve(service.getStatus()),
      reconcile: service.reconcile,
      readForFaction: service.readForFaction,
      readForFactions: service.readForFactions,
      readTargetsForFaction: service.readTargetsForFaction,
      listOpen: service.listOpen,
      stop() {
        if (service.isStopped()) return;
        service.stop();
        unregisterAll();
        swallow(() => listener.remove());
      },
    };
    return { ok: true, playerSiege: Object.freeze(facade), service };
  } catch (err) {
    return { ok: false, reason: START_FAILED, detail: messageOf(err) };
  }
}

module.exports = { startPlayerSiege, createUnavailablePlayerSiege, FACADE_METHODS };
