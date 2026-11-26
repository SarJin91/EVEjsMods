"use strict";

const { isModuleEnabled } = require("../../../config");
const { createCorpRepository } = require("./corpRepository");
const { createCapsuleerService, paramsOf } = require("./capsuleerService");
const { createTripRepository } = require("./tripRepository");
const { createRattingService } = require("./rattingService");
const { createContractRepository } = require("./contractRepository");
const { createContractService } = require("./contractService");
const { createClaimRepository } = require("./claimRepository");
const { buildCapsuleersView, VIEW_ID } = require("./view");
const { buildCapsuleersLayerView, LAYER_ID } = require("./capsuleersLayer");
const { REVIEW_EVENT, STEP_EVENT } = require("./schema");
const { CAPSULEER_FACTION_ID, MAX_SLOTS } = require("../data/capsuleers");
const { createHostility } = require("../../battle/data/hostility");

const STATE_READY = "ready";
const STRATEGY_DOWN = Object.freeze(["unavailable", "stopped"]);
const COUNT_KEYS = Object.freeze([["maxCorps", 0], ["membersPerCorp", 1], ["maxFleetsPerCorp", 0],
  ["reviewPeriodMs", 1], ["maxFoundingsPerReview", 0], ["maxFleetBuysPerReview", 0], ["baseMaxJumpsToPirate", 1],
  ["baseScanMaxSystems", 1], ["baseCandidatesTop", 1], ["pirateSystemsReadMax", 1], ["initialIsk", 0],
  ["stipendIskPerReview", 0], ["maxIskBalance", 1],
  ["maxDispatchesPerReview", 0], ["rattingMaxJumps", 1], ["rattingScanMaxSystems", 1], ["rattingTargetScanMax", 1],
  ["rattingTargetsTop", 1], ["rattingMaxFleetsPerSystem", 1], ["rattingStepMs", 1], ["rattingShiftMs", 1],
  ["rattingKillsPerStep", 0], ["rattingBountyIskPerKill", 0], ["hostileScanMaxFleets", 1], ["tripWatchGraceMs", 0],
  ["tripWatchRecheckMs", 1], ["tripMaxWatchRounds", 1], ["tripRetentionMs", 1], ["tripPruneBatch", 0],
  ["tripReconcileMaxTrips", 1], ["tripReconcileMaxAttempts", 1],
  ["maxHomeDispatchesPerReview", 0], ["orphanSweepsPerReview", 0],
  ["maxMercenaryFleetsPerCorp", 0], ["maxContractsPerCorp", 0], ["maxContractsPerEmpire", 0],
  ["maxContractsPerReview", 0], ["mercMaxContractsPerSystem", 1], ["mercMaxJumps", 1], ["mercScanMaxSystems", 1],
  ["mercTargetScanMax", 1], ["mercTargetsTop", 1], ["mercEnemyFleetsReadMax", 1], ["mercGuardMs", 1],
  ["mercStepMs", 1], ["mercFeeFactorPermille", 1], ["mercMinTreasuryMultiple", 1],
  ["maxSalvageDispatchesPerReview", 0], ["salvageMaxJumps", 1], ["salvageScanMaxSystems", 1],
  ["salvageFieldsPerSystem", 1], ["salvageIskPerUnit", 0],
  ["maxClaimsPerCorp", 0], ["maxClaimsPerReview", 0], ["claimMaxJumps", 1], ["claimScanMaxSystems", 1],
  ["claimBountyPermille", 0]]);
const VC_METHODS = Object.freeze(["ensureOwnerIdentity", "getOwnerIdentity"]);

const messageOf = (err) => String((err && err.message) || err);

function stateOf(facade) {
  try {
    return facade && typeof facade.getStatus === "function" ? facade.getStatus().state : null;
  } catch (_err) {
    return null;
  }
}

function createUnavailableCapsuleers(reason, detail) {
  const status = Object.freeze({ state: "unavailable", reason: String(reason), ...(detail ? { detail: String(detail) }
    : {}) });
  return Object.freeze({ getMode: () => "off", getStatus: () => status, listCorps: () => [], listTrips: () => [],
    listContracts: () => [], listClaims: () => [], bootstrap: () => ({ ok: false, reason: String(reason) }),
    stop() {} });
}

function startCapsuleers(deps) {
  const cleanups = [];
  const cleanup = () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      try {
        fn();
      } catch (_err) {
      }
    }
  };
  try {
    const { config, persistence, scheduler, fleets, strategy, virtualCorps, clock } = deps || {};
    if (!isModuleEnabled(config, "strategy") || !config.capsuleers || config.capsuleers.enabled !== true) {
      return { ok: false, reason: "disabled_by_config" };
    }
    if (!persistence || persistence.ok !== true || !persistence.store || !persistence.journal) {
      return { ok: false, reason: "dependency_disabled:persistence" };
    }
    if (!scheduler || stateOf(scheduler) !== STATE_READY) return { ok: false, reason: "SCHEDULER_UNAVAILABLE" };
    if (!fleets || !fleets.repository || typeof fleets.repository.createFleet !== "function") {
      return { ok: false, reason: "FLEETS_UNAVAILABLE" };
    }
    if (!strategy || !strategy.registry || STRATEGY_DOWN.includes(stateOf(strategy))) {
      return { ok: false, reason: "STRATEGY_UNAVAILABLE", detail: String(stateOf(strategy)) };
    }
    const missingVc = VC_METHODS.filter((m) => !virtualCorps || typeof virtualCorps[m] !== "function");
    if (missingVc.length > 0) return { ok: false, reason: "VIRTUAL_CORPS_UNAVAILABLE", detail: missingVc.join(",") };
    if (typeof strategy.registry.isActive === "function" && strategy.registry.isActive(CAPSULEER_FACTION_ID)) {
      return { ok: false, reason: "CAPSULEER_FACTION_ACTIVE", detail: String(CAPSULEER_FACTION_ID) };
    }
    const C = config.capsuleers;
    for (const [key, min] of COUNT_KEYS) {
      if (!Number.isSafeInteger(C[key]) || C[key] < min) {
        return { ok: false, reason: "INVALID_CONFIG", detail: `capsuleers.${key}` };
      }
    }
    if (paramsOf(C).baseSecClasses === null) {
      return { ok: false, reason: "INVALID_CONFIG", detail: "capsuleers.baseSecClasses" };
    }
    if (C.rattingShiftMs < C.rattingStepMs) {
      return { ok: false, reason: "INVALID_CONFIG", detail: "capsuleers.rattingShiftMs < capsuleers.rattingStepMs" };
    }
    if (paramsOf(C).mercTargetSecClasses === null) {
      return { ok: false, reason: "INVALID_CONFIG", detail: "capsuleers.mercTargetSecClasses" };
    }
    if (C.mercStepMs > C.mercGuardMs) {
      return { ok: false, reason: "INVALID_CONFIG", detail: "capsuleers.mercStepMs > capsuleers.mercGuardMs" };
    }

    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    const store = persistence.store;
    const corps = createCorpRepository();
    const graph = deps.graph || null;
    const adapter = deps.adapter || null;
    const isHostile = createHostility();
    const travel = fleets.travel;
    const ratOk = Boolean(travel && typeof travel.planInTx === "function"
      && typeof travel.addArrivalListener === "function" && deps.ids && typeof deps.ids.next === "function");
    const trips = ratOk ? createTripRepository({ journal: persistence.journal, clock }) : null;
    const getTreasury = () => (typeof deps.getTreasury === "function" ? deps.getTreasury() : null);
    const getWrecks = () => (typeof deps.getWrecks === "function" ? deps.getWrecks() : null);
    const getSalvage = () => (typeof deps.getSalvage === "function" ? deps.getSalvage() : null);
    const contracts = ratOk ? createContractRepository({ journal: persistence.journal, clock }) : null;
    const claims = createClaimRepository();
    const contractService = ratOk ? createContractService({ journal: persistence.journal, contracts, corps,
      ids: deps.ids, config, getTreasury, telemetry: deps.telemetry || null, logger }) : null;
    const ratting = ratOk ? createRattingService({ store, journal: persistence.journal, trips, corps,
      fleets: { repository: fleets.repository, travel }, scheduler, getWorld: () => deps.world || null,
      getRegistry: () => strategy.registry || null,
      getLiberation: () => (typeof deps.getLiberation === "function" ? deps.getLiberation() : null),
      clock, ids: deps.ids, config, isHostile, telemetry: deps.telemetry || null, logger, nowMs: deps.nowMs,
      contracts: contractService, getWrecks, claims }) : null;
    const service = createCapsuleerService({ store, journal: persistence.journal, corps, scheduler,
      fleetRepository: fleets.repository, getRegistry: () => strategy.registry || null,
      getGraph: () => (graph && typeof graph.getGraph === "function" ? graph.getGraph() : null),
      getWorld: () => deps.world || null, getVirtualCorps: () => virtualCorps,
      listStations: (systemId) => (adapter && typeof adapter.listNpcStationsInSystem === "function"
        ? adapter.listNpcStationsInSystem(systemId) : { ok: false, reason: "ADAPTER_UNAVAILABLE" }),
      clock, worldSeed: persistence.worldSeed, config, telemetry: deps.telemetry || null, logger,
      nowMs: deps.nowMs, trips, getRatting: () => ratting, isHostile, contracts, contractService, getTreasury,
      getWrecks, getSalvage, claims });

    const register = (type, fn) => {
      let reg;
      try {
        reg = scheduler.registerHandler(type, fn);
      } catch (err) {
        reg = { ok: false, reason: messageOf(err) };
      }
      if (reg && reg.ok) cleanups.push(() => reg.unregister());
      return reg;
    };
    const r = register(REVIEW_EVENT, service.onReview);
    if (!r || !r.ok) {
      cleanup();
      return { ok: false, reason: "CAPSULEERS_START_FAILED",
        detail: `handler ${REVIEW_EVENT}: ${(r && r.reason) || "no result"}` };
    }
    if (ratting) {
      const rs = register(STEP_EVENT, ratting.handler);
      if (!rs || !rs.ok) {
        cleanup();
        return { ok: false, reason: "CAPSULEERS_START_FAILED",
          detail: `handler ${STEP_EVENT}: ${(rs && rs.reason) || "no result"}` };
      }
      const listener = travel.addArrivalListener(ratting.onArrival);
      if (!listener || !listener.ok) {
        cleanup();
        return { ok: false, reason: "CAPSULEERS_START_FAILED", detail: "arrival listener" };
      }
      cleanups.push(() => listener.remove());
    } else logger.log("capsuleers: ratting off - fleets.travel or ids missing");

    const list = store.transaction("capsuleers.list", (db) => corps.listCorps(db, { limit: MAX_SLOTS }));
    if (list.ok && list.value && list.value.ok) service.setCorps(list.value.corps);
    const boot = service.bootstrap();
    if (!boot.ok) logger.log(`capsuleers: bootstrap failed - ${boot.reason}`);
    if (ratting) {
      const rec = ratting.reconcile();
      if (!rec.ok) logger.log(`capsuleers: trip reconcile failed ${rec.reason}; the next start retries`);
      else if (rec.enqueued > 0) logger.log(`capsuleers: trip reconcile open=${rec.open} enqueued=${rec.enqueued}`);
    }
    const listTrips = () => (ratting ? ratting.listTrips() : []);
    const listContracts = () => (contractService ? contractService.listContracts() : []);
    const getStatus = () => {
      const st = service.getStatus();
      const rt = ratting ? ratting.getStatus() : null;
      const ct = contractService ? contractService.getStatus() : null;
      return Object.freeze({ ...st, counters: Object.freeze({ ...st.counters, ...(rt ? rt.counters : {}),
        ...(ct ? ct.counters : {}) }), trips: rt ? rt.tripsOpen : 0, contracts: ct ? ct.contractsOpen : 0,
      ratting: ratting ? "on" : "off",
      lastRefusal: st.lastRefusal || (rt ? rt.lastRefusal : null) || (ct ? ct.lastRefusal : null) });
    };
    const views = deps.views;
    if (views && typeof views.registerView === "function") {
      const v = views.registerView(VIEW_ID, buildCapsuleersView({ listCorps: service.listCorps, listTrips,
        getTripsVersion: () => (ratting ? ratting.getMemoryVersion() : 0), getStatus,
        getVirtualCorps: () => virtualCorps, listContracts,
        getContractsVersion: () => (contractService ? contractService.getMemoryVersion() : 0),
        listClaims: service.listClaims, getClaimsVersion: service.getClaimsVersion }));
      if (v && v.ok) cleanups.push(() => v.unregister());
      else logger.log(`capsuleers: view ${VIEW_ID} not registered - ${(v && v.reason) || "no result"}`);
      const O = config.observer || {};
      const FC = config.freeCorps || {};
      if (O.galaxyEnabled === true && O.galaxyCapsuleersEnabled === true) {
        const lv = views.registerView(LAYER_ID, buildCapsuleersLayerView({ store, repository: fleets.repository,
          clock, getGovernor: deps.getGovernor, listCorps: service.listCorps, listTrips, listContracts,
          getCrewSummary: deps.getCrewSummary, telemetry: deps.telemetry || null, nowMs: deps.nowMs,
          maxFleets: O.galaxyCapsuleersMaxFleets, maxLines: O.galaxyCapsuleersMaxLines,
          refreshMs: O.galaxyCapsuleersRefreshMs,
          ...(O.galaxyCapsuleersCiviliansEnabled === true ? { getHighsecLife: deps.getHighsecLife } : {}),
          civilianNames: O.galaxyCapsuleersCivilianNames,
          ...(FC.enabled === true && FC.map && FC.map.enabled === true ? { getFreeCorps: deps.getFreeCorps } : {}) }));
        if (lv && lv.ok) cleanups.push(() => lv.unregister());
        else logger.log(`capsuleers: view ${LAYER_ID} not registered - ${(lv && lv.reason) || "no result"}`);
      }
    }
    logger.log(`capsuleers: running corps=${service.listCorps().length} review=${boot.ok ? boot.round : "?"}`
      + ` ratting=${ratting ? "on" : "off"}`);

    const facade = {
      getMode: service.getMode,
      getStatus,
      listCorps: service.listCorps,
      listTrips,
      listContracts,
      listClaims: service.listClaims,
      bootstrap: service.bootstrap,
      stop() {
        if (service.isStopped()) return;
        service.stop();
        if (ratting) ratting.stop();
        cleanup();
      },
    };
    return { ok: true, capsuleers: Object.freeze(facade) };
  } catch (err) {
    cleanup();
    return { ok: false, reason: "CAPSULEERS_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startCapsuleers, createUnavailableCapsuleers };
