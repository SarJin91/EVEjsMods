"use strict";

const { isModuleEnabled } = require("../../../config");
const { GROUPS: STRENGTH_GROUPS } = require("../../battle/data/strengthCatalog");
const { expandStrengthGroups } = require("../../battle/strength");
const { capitalPowerOverlayOf } = require("../../battle/data/capitalStrengthRows");
const { createHostility } = require("../../battle/data/hostility");
const { buildPowerTable } = require("../../strategy/ai/strength");
const { createOccupationService } = require("./occupationService");
const { createOccupationConsequence } = require("./consequence");
const { VIEW_ID, buildOccupationView } = require("./occupationView");
const { buildFrontLayerView } = require("./frontLayer");
const { LAYER_ID: PROGRESS_LAYER_ID, buildProgressLayerView } = require("./progressLayer");
const { EVENT_TYPE } = require("./schema");
const { getCoreIndex, bastionOwnerOf } = require("../core");

const STATE_READY = "ready";
const STATE_UNAVAILABLE = "unavailable";

function messageOf(err) {
  return String((err && err.message) || err);
}

function swallow(fn) {
  try {
    fn();
  } catch (_err) {
  }
}

function createUnavailableOccupation(reason, detail) {
  const refusal = Object.freeze({ ok: false, reason: String(reason), ...(detail ? { detail: String(detail) } : {}) });
  const status = Object.freeze({ state: STATE_UNAVAILABLE, reason: refusal.reason });
  const refuse = () => refusal;
  const structureRefusal = Object.freeze({ ok: false, reason: "OCCUPATION_UNAVAILABLE", detail: refusal.reason });
  return Object.freeze({ consequence: null, signalInTx: refuse, markDetachedInTx: refuse, abandonInTx: refuse,
    readProgressInTx: refuse, applyStructureOutcomeInTx: () => structureRefusal,
    claimOfInTx: () => structureRefusal, applyPlayerRepelInTx: () => structureRefusal,
    sovClaimOfInTx: () => structureRefusal, nudgeForSovInTx: () => structureRefusal,
    returnBastionStationsInTx: () => structureRefusal,
    territoryUpkeepFactor: () => 1, count() {}, noteRefusal() {}, getStatus: () => status, stop() {} });
}

function readFactionNames(adapter) {
  if (!adapter || typeof adapter.readFactionNames !== "function") return new Map();
  try {
    const r = adapter.readFactionNames();
    return r && r.ok && r.names instanceof Map ? r.names : new Map();
  } catch (_err) {
    return new Map();
  }
}

function startOccupation(deps) {
  try {
    const { config, persistence, clock, scheduler, footholdsOf } = deps || {};
    if (!isModuleEnabled(config, "world") || !config.occupation || config.occupation.enabled !== true) {
      return { ok: false, reason: "disabled_by_config" };
    }
    if (!persistence || persistence.ok !== true || !persistence.store || !persistence.journal) {
      return { ok: false, reason: "dependency_disabled:persistence" };
    }
    const world = deps.world;
    if (!world || !world.repository || typeof world.repository.listActiveOccupations !== "function") {
      return { ok: false, reason: "WORLD_UNAVAILABLE" };
    }
    const fleets = deps.fleets;
    if (!fleets || !fleets.repository || typeof fleets.repository.reassignRole !== "function") {
      return { ok: false, reason: "FLEETS_UNAVAILABLE" };
    }
    let schedulerState = null;
    try {
      schedulerState = scheduler && typeof scheduler.getStatus === "function" ? scheduler.getStatus().state : null;
    } catch (_err) {
      schedulerState = null;
    }
    if (!scheduler || typeof scheduler.registerHandler !== "function" || typeof scheduler.enqueue !== "function"
      || schedulerState !== STATE_READY) {
      return { ok: false, reason: "SCHEDULER_UNAVAILABLE" };
    }
    if (!clock || typeof clock.now !== "function") {
      return { ok: false, reason: "OCCUPATION_START_FAILED", detail: "clock" };
    }
    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    const store = persistence.store;
    const coreIndex = deps.coreIndex || getCoreIndex(config);
    const nonOccupierFactionIds = new Set((Array.isArray(deps.nonOccupierFactionIds) ? deps.nonOccupierFactionIds : [])
      .filter((v) => Number.isSafeInteger(v) && v > 0));
    const service = createOccupationService({ nonOccupierFactionIds, store, journal: persistence.journal, repository: world.repository,
      fleets, scheduler, graph: deps.graph || null, getStations: deps.getStations,
      getCaptureBelt: deps.getCaptureBelt, footholdsOf: deps.footholdsOf,
      consolidatesOf: deps.consolidatesOf,
      canOccupyOf: deps.canOccupyOf,
      drawsGarrisonOf: deps.drawsGarrisonOf,
      captureSlowFactorOf: deps.captureSlowFactorOf,
      getSovStructures: deps.getSovStructures, needsSovStructureOf: deps.needsSovStructureOf,
      getPlayerSovSiege: deps.getPlayerSovSiege,
      hostility: createHostility(),
      powerTable: buildPowerTable(expandStrengthGroups(STRENGTH_GROUPS, null, capitalPowerOverlayOf(config.strategy))),
      clock, config, telemetry: deps.telemetry || null, logger,
      nowMs: deps.nowMs, coreIndex });
    let inner;
    try {
      inner = createOccupationConsequence({ service, repository: world.repository,
        settings: { battleWinPoints: config.occupation.battleWinPoints,
          battleLossPoints: config.occupation.battleLossPoints,
          maxFactionsPerSystem: config.world.maxFactionsPerSystem, nonOccupierFactionIds,
          bastionBattleInfluenceFrozen: config.occupation.bastionBattleInfluenceFrozen === true,
          bastionOwnerOf: (systemId) => bastionOwnerOf(coreIndex, systemId),
          drift: { stableBaselineScore: config.occupation.stableBaselineScore,
            stableRecoverPointsPerHour: config.occupation.stableRecoverPointsPerHour,
            stableForeignDecayPointsPerHour: config.occupation.stableForeignDecayPointsPerHour,
            stableForeignFloorScore: config.occupation.stableForeignFloorScore } },
        onCount: (name) => service.count(name) });
    } catch (err) {
      return { ok: false, reason: "OCCUPATION_START_FAILED", detail: messageOf(err) };
    }
    const consequence = Object.freeze({ name: inner.name, apply(tx, settled, ck) {
      if (service.isStopped()) return { ok: false, reason: "OCCUPATION_STOPPED" };
      return inner.apply(tx, settled, ck);
    } });

    let registration;
    try {
      registration = scheduler.registerHandler(EVENT_TYPE, service.handler,
        { maxPerPass: config.occupation.maxEvalsPerPass });
    } catch (err) {
      registration = { ok: false, reason: messageOf(err) };
    }
    if (!registration || !registration.ok) {
      return { ok: false, reason: "OCCUPATION_START_FAILED",
        detail: `handler ${EVENT_TYPE}: ${(registration && registration.reason) || "no result"}` };
    }

    let viewHandle = null;
    let frontLayerHandle = null;
    let progressLayerHandle = null;
    const views = deps.views;
    if (views && typeof views.registerView === "function") {
      const r = views.registerView(VIEW_ID, buildOccupationView({ store, repository: world.repository,
        getStatus: service.getStatus, graph: deps.graph || null, maxRows: config.observer.occupationPanelMaxRows,
        getGovernor: deps.getGovernor, factionNames: readFactionNames(deps.adapter) }));
      if (r && r.ok) viewHandle = r;
      else logger.log(`occupation: view ${VIEW_ID} not registered - ${(r && r.reason) || "no result"}`);

      const observer = config.observer || {};
      const galaxyEnabled = observer.galaxyEnabled === true;
      const frontEnabled = galaxyEnabled && observer.galaxyFrontEnabled === true;
      if (frontEnabled) {
        const r2 = views.registerView("layer-front", buildFrontLayerView({
          store,
          repository: world.repository,
          clock,
          getGovernor: deps.getGovernor,
          telemetry: deps.telemetry || null,
          nowMs: deps.nowMs,
          maxSystems: observer.galaxyFrontMaxSystems || 512,
          maxLines: observer.galaxyFrontMaxLines || 4,
          refreshMs: observer.galaxyFrontRefreshMs || 60000,
          getStatus: service.getStatus,
        }));
        if (r2 && r2.ok) frontLayerHandle = r2;
        else logger.log(`occupation: layer-front not registered - ${(r2 && r2.reason) || "no result"}`);
      }

      if (galaxyEnabled && observer.galaxyProgressEnabled === true) {
        const r3 = views.registerView(PROGRESS_LAYER_ID, buildProgressLayerView({
          store,
          repository: world.repository,
          readProgressInTx: service.readProgressInTx,
          clock,
          getGovernor: deps.getGovernor,
          telemetry: deps.telemetry || null,
          nowMs: deps.nowMs,
          maxSystems: observer.galaxyProgressMaxSystems,
          maxDrawn: observer.galaxyProgressMaxDrawn,
          refreshMs: observer.galaxyProgressRefreshMs,
          getStatus: service.getStatus,
        }));
        if (r3 && r3.ok) progressLayerHandle = r3;
        else logger.log(`occupation: ${PROGRESS_LAYER_ID} not registered - ${(r3 && r3.reason) || "no result"}`);
      }
    }

    const boot = service.bootstrap();
    if (!boot.ok) logger.log(`occupation: bootstrap failed ${boot.reason}; the next start retries`);
    else if (boot.enqueued + boot.duplicates > 0) {
      logger.log(`occupation: bootstrap enqueued=${boot.enqueued} duplicates=${boot.duplicates}`);
    }

    function applyStructureOutcomeInTx(tx, spec, key) {
      if (service.isStopped()) return { ok: false, reason: "OCCUPATION_UNAVAILABLE", detail: "stopped" };
      if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
      const s = spec || {};
      const isId = (v) => Number.isSafeInteger(v) && v > 0;
      if (!isId(s.systemId) || typeof s.siegeId !== "string" || s.siegeId === "" || !isId(s.winnerFactionId)
        || !isId(s.loserFactionId) || s.winnerFactionId === s.loserFactionId || !Number.isSafeInteger(s.at)
        || s.at < 0 || typeof key !== "string" || key === "") {
        return { ok: false, reason: "OCCUPATION_INPUT_INVALID" };
      }
      const settled = Object.freeze({ systemId: s.systemId, battleId: s.siegeId, at: s.at, winnerSide: "A",
        winnerFactionId: s.winnerFactionId, sides: Object.freeze({ A: Object.freeze({ factionId: s.winnerFactionId }),
          B: Object.freeze({ factionId: s.loserFactionId }) }) });
      const r = persistence.journal.applyOnce(tx, { key, aggregate: { type: "world_system", id: String(s.systemId) },
        eventType: "OCCUPATION_STRUCTURE_OUTCOME", payload: { systemId: s.systemId, siegeId: s.siegeId,
          winnerFactionId: s.winnerFactionId, loserFactionId: s.loserFactionId } }, (db) => {
        const out = inner.apply(db, settled, key);
        return out && typeof out === "object" ? out : { ok: false, reason: "OCCUPATION_INVALID_RESULT" };
      });
      if (!r.ok) return r.reason === "APPLY_REFUSED" ? r.refusal : r;
      if (r.duplicate) return { ok: true, outcome: "DUPLICATE" };
      return { ok: true, outcome: r.value.outcome };
    }

    const facade = {
      consequence,
      applyStructureOutcomeInTx,
      signalInTx: service.signalInTx,
      markDetachedInTx: service.markDetachedInTx,
      abandonInTx: service.abandonInTx,
      restoreBastionInTx: service.restoreBastionInTx,
      returnBastionStationsInTx: service.returnBastionStationsInTx,
      territoryUpkeepFactor: service.territoryUpkeepFactor,
      dropInfluenceInTx: service.dropInfluenceInTx,
      claimOfInTx: service.claimOfInTx,
      applyPlayerRepelInTx: service.applyPlayerRepelInTx,
      sovClaimOfInTx: service.sovClaimOfInTx,
      nudgeForSovInTx: service.nudgeForSovInTx,
      effectiveScoreOf: service.effectiveScoreOf,
      readProgressInTx: service.readProgressInTx,
      count: service.count,
      noteRefusal: service.noteRefusal,
      params: service.params,
      bootstrap: service.bootstrap,
      registerOnControllerChanged: service.registerOnControllerChanged,
      auditCoresInTx: service.auditCoresInTx,
      getStatus: () => Object.freeze({ ...service.getStatus(), view: viewHandle !== null }),
      stop() {
        if (service.isStopped()) return;
        service.stop();
        swallow(() => registration.unregister());
        if (viewHandle) {
          const handle = viewHandle;
          viewHandle = null;
          swallow(() => handle.unregister());
        }
        if (frontLayerHandle) {
          const handle = frontLayerHandle;
          frontLayerHandle = null;
          swallow(() => handle.unregister());
        }
        if (progressLayerHandle) {
          const handle = progressLayerHandle;
          progressLayerHandle = null;
          swallow(() => handle.unregister());
        }
      },
    };
    return { ok: true, occupation: Object.freeze(facade) };
  } catch (err) {
    return { ok: false, reason: "OCCUPATION_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startOccupation, createUnavailableOccupation };
