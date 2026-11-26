"use strict";

const { isModuleEnabled } = require("../../config");
const { createPoller } = require("../presence/poller");
const { createPhysicalBudget } = require("./physicalBudget");
const { createMaterializationService } = require("./service");
const { createLossTracker } = require("./lossTracker");
const { VIEW_ID, buildMaterializationView } = require("./view");
const { GROUPS: STRENGTH_GROUPS } = require("../battle/data/strengthCatalog");
const { expandStrengthGroups } = require("../battle/strength");
const { capitalPowerOverlayOf } = require("../battle/data/capitalStrengthRows");
const { CARRIER_GROUPS } = require("../economy/data/cargoVolumes");

const MATERIALIZATION_METHODS = Object.freeze(["runPass", "getStatus", "stop", "liveLossesByFleet", "liveSideOf",
  "inboundFleets"]);
const NOT_LIVE = Object.freeze({ ok: false, reason: "NOT_LIVE" });
const INBOUND_UNAVAILABLE = Object.freeze({ ok: false, reason: "UNAVAILABLE" });
const INBOUND_STOPPED = Object.freeze({ ok: false, reason: "STOPPED" });

function messageOf(err) {
  return String((err && err.message) || err);
}

function safeCall(fn) {
  try {
    return typeof fn === "function" ? fn() : null;
  } catch (_err) {
    return null;
  }
}

function createUnavailableMaterialization(reason, detail) {
  const status = Object.freeze({ state: "unavailable", reason: String(reason),
    ...(detail ? { detail: String(detail) } : {}) });
  return Object.freeze({
    runPass: () => ({ passes: 0, materialized: [], exited: [], reverted: [], refused: { [String(reason)]: 1 } }),
    getStatus: () => status,
    stop() {},
    liveLossesByFleet: () => new Map(),
    liveSideOf: () => NOT_LIVE,
    inboundFleets: () => INBOUND_UNAVAILABLE,
  });
}

function ambushLookups(deps, adapter) {
  const secClassOf = (systemId) => {
    const g = safeCall(deps.getGraph);
    const r = g && typeof g.getGraph === "function" ? safeCall(() => g.getGraph()) : null;
    const graph = r && r.ok === true && r.graph && typeof r.graph.getSystem === "function" ? r.graph : null;
    const v = graph ? safeCall(() => graph.getSystem(systemId)) : null;
    return v && typeof v.secClass === "string" && v.secClass !== "" ? v.secClass : null;
  };
  const pirateFactionOf = (systemId) => {
    const world = safeCall(deps.getWorld);
    const read = world && typeof world.getControlState === "function"
      ? safeCall(() => world.getControlState(systemId)) : null;
    const controller = read && read.ok === true && read.system ? read.system.controllerFactionId : null;
    if (Number.isSafeInteger(controller) && controller > 0 && typeof deps.getFactionKind === "function"
      && safeCall(() => deps.getFactionKind(controller)) === "pirate") return controller;
    const sys = adapter && typeof adapter.resolveSystemFactions === "function"
      ? safeCall(() => adapter.resolveSystemFactions([systemId])) : null;
    const entry = sys && sys.ok === true && Array.isArray(sys.entries) ? sys.entries[0] : null;
    return entry && Number.isSafeInteger(entry.factionId) && entry.factionId > 0 ? entry.factionId : null;
  };
  return { secClassOf, pirateFactionOf };
}

function battleLiveOf(battle) {
  const live = battle && battle.live;
  if (!live || typeof live.claimLiveInTx !== "function" || typeof live.readLiveInTx !== "function") return null;
  const st = safeCall(() => battle.getStatus());
  return st && st.state === "ready" ? live : null;
}

function startMaterialization(deps) {
  let unbindSink = () => {};
  try {
    const { config, persistence, clock, adapter } = deps || {};
    if (!isModuleEnabled(config, "materialization")) return { ok: false, reason: "disabled_by_config" };
    if (!persistence || persistence.ok !== true || !persistence.store) {
      return { ok: false, reason: "dependency_disabled:persistence" };
    }
    if (!clock || typeof clock.now !== "function") {
      return { ok: false, reason: "MATERIALIZATION_START_FAILED", detail: "clock" };
    }
    const M = config.materialization;
    const limits = config.limits;
    if (!M || typeof M !== "object" || !limits) {
      return { ok: false, reason: "MATERIALIZATION_START_FAILED", detail: "config.materialization" };
    }
    const getBattle = typeof deps.getBattle === "function" ? deps.getBattle : () => null;
    const battle = safeCall(getBattle);
    const battleLive = battleLiveOf(battle);
    if (!battleLive) return { ok: false, reason: "dependency_disabled:battle" };
    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };

    const checked = adapter && typeof adapter.checkNpcSpawn === "function"
      ? safeCall(() => adapter.checkNpcSpawn()) : null;
    if (!checked || checked.ok !== true) {
      const missing = checked && Array.isArray(checked.missing) ? checked.missing.join(", ") : "";
      const detail = missing || (checked && (checked.detail || checked.reason)) || "no checkNpcSpawn";
      logger.log(`materialization: NPC spawn seam unavailable - ${detail}`);
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail };
    }
    const npcSpawn = typeof adapter.getNpcSpawn === "function" ? safeCall(() => adapter.getNpcSpawn()) : null;
    if (!npcSpawn || typeof npcSpawn.spawnShip !== "function" || typeof npcSpawn.orderAttack !== "function") {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "getNpcSpawn" };
    }

    const telemetry = deps.telemetry || null;
    const budget = createPhysicalBudget({ limits: { perSystem: limits.maxLiveMaterializationsPerSystem,
      global: limits.maxLiveMaterializationsGlobal }, clock, telemetry });
    const getPresence = typeof deps.getPresence === "function" ? deps.getPresence : () => null;
    const getBattleStatus = () => {
      const b = safeCall(getBattle);
      return b && typeof b.getStatus === "function" ? safeCall(() => b.getStatus()) : null;
    };
    const slc = config.battle && config.battle.structureLiveCombat ? config.battle.structureLiveCombat : null;
    const slcOn = Boolean(slc && slc.enabled === true && typeof adapter.getStructureSeam === "function");
    const lossTracker = createLossTracker({ maxPending: limits.maxLiveMaterializationsGlobal });
    const huntLossTracker = createLossTracker({ maxPending: limits.maxLiveMaterializationsGlobal });
    const exposureLossTracker = createLossTracker({ maxPending: limits.maxLiveMaterializationsGlobal });
    const patrolLossTracker = createLossTracker({ maxPending: limits.maxLiveMaterializationsGlobal });
    const holdLossTracker = createLossTracker({ maxPending: limits.maxLiveMaterializationsGlobal });
    const presenceLossTracker = createLossTracker({ maxPending: limits.maxLiveMaterializationsGlobal });
    let lossImportOn = false;
    const B = config.battle || {};
    if (B.liveLossImport && B.liveLossImport.enabled === true) {
      const bound = typeof adapter.bindLiveLossSink === "function"
        ? safeCall(() => adapter.bindLiveLossSink((e, r, k) => {
          lossTracker.note(e, r);
          huntLossTracker.note(e, r);
          exposureLossTracker.note(e, r, k);
          patrolLossTracker.note(e, r);
          holdLossTracker.note(e, r);
          presenceLossTracker.note(e, r);
        })) : null;
      if (bound && bound.ok === true && typeof bound.unbind === "function") {
        unbindSink = bound.unbind;
        lossImportOn = true;
      } else {
        logger.log(`materialization: live loss import off - ${(bound && bound.reason) || "no bindLiveLossSink"}`);
      }
    }
    const endCfg = B.liveEndMonitor || {};
    let huntSeam;
    const getHuntScene = () => {
      if (huntSeam !== undefined) return huntSeam;
      const checked = typeof adapter.checkHuntScene === "function" ? safeCall(() => adapter.checkHuntScene()) : null;
      huntSeam = checked && checked.ok === true && typeof adapter.getHuntScene === "function"
        ? safeCall(() => adapter.getHuntScene()) : null;
      if (!huntSeam) {
        const missing = checked && Array.isArray(checked.missing) ? checked.missing.join(", ") : "";
        logger.log(`materialization: hunt scene seam unavailable - ${missing || (checked && checked.reason)
          || "no checkHuntScene"}`);
      }
      return huntSeam;
    };
    const hunt = config.playerHunt && typeof config.playerHunt === "object" ? {
      settings: config.playerHunt, lossTracker: huntLossTracker, getHuntScene,
      getPlayerHunt: deps.getPlayerHunt, getFactionKind: deps.getFactionKind, getFleets: deps.getFleets,
      getGraph: deps.getGraph,
      getOccupation: deps.getOccupation,
      getNotices: deps.getNotices,
      getOfficerSpawns: deps.getOfficerSpawns,
      isFactionEnemy: typeof deps.isFactionEnemy === "function" ? deps.isFactionEnemy : null,
      readStanding: typeof adapter.readCharacterStanding === "function"
        ? (characterId, factionId) => adapter.readCharacterStanding(characterId, factionId) : null,
      excludedFactionIds: deps.huntExcludedFactionIds } : null;
    let groupSeam;
    const getBeltNavyScene = () => {
      if (groupSeam !== undefined) return groupSeam;
      const ok = typeof adapter.checkBeltNavyScene === "function" ? safeCall(() => adapter.checkBeltNavyScene()) : null;
      groupSeam = ok && ok.ok === true && typeof adapter.getBeltNavyScene === "function"
        ? safeCall(() => adapter.getBeltNavyScene()) : null;
      if (!groupSeam) logger.log("materialization: belt navy scene seam unavailable (fleet exposures)");
      return groupSeam;
    };
    const exposure = config.fleetExposure && typeof config.fleetExposure === "object" ? {
      settings: config.fleetExposure, lossTracker: exposureLossTracker, getHuntScene, getBeltNavyScene,
      getFleetExposure: deps.getFleetExposure, getLogistics: deps.getLogistics, getFleets: deps.getFleets,
      getStandings: deps.getStandings,
      getFrontJobs: deps.getFrontJobs,
      escortEnabled: Boolean(config.frontJobs && config.frontJobs.enabled === true
        && config.frontJobs.escortEnabled === true),
      ...(config.fleetExposure && config.fleetExposure.ambushEnabled === true ? ambushLookups(deps, adapter) : {}),
      cargoCarrierGroups: CARRIER_GROUPS,
      worldSeed: persistence.worldSeed } : null;
    const FX = config.fleetExposure;
    const presence = FX && typeof FX === "object" && FX.presence && typeof FX.presence === "object" ? {
      settings: FX.presence, heldSettings: FX, lossTracker: presenceLossTracker, getHuntScene, getBeltNavyScene,
      getFleetExposure: deps.getFleetExposure, getFleets: deps.getFleets, worldSeed: persistence.worldSeed,
      maxFleetReads: config.fleets && config.fleets.maxListLimit,
      readStanding: typeof adapter.readCharacterStanding === "function"
        ? (characterId, factionId) => adapter.readCharacterStanding(characterId, factionId) : null,
      getFactionKind: deps.getFactionKind, huntSettings: config.playerHunt || {},
      excludedFactionIds: deps.huntExcludedFactionIds, getGraph: deps.getGraph } : null;
    const patrol = config.garrisonPatrol && typeof config.garrisonPatrol === "object" ? {
      settings: config.garrisonPatrol, huntSettings: config.playerHunt || {}, lossTracker: patrolLossTracker,
      getHuntScene, getPlayerHunt: deps.getPlayerHunt, getFactionKind: deps.getFactionKind, getFleets: deps.getFleets,
      getGraph: deps.getGraph, getCrews: deps.getCrews,
      getWorld: deps.getWorld,
      isFactionEnemy: typeof deps.isFactionEnemy === "function" ? deps.isFactionEnemy : null,
      readStanding: typeof adapter.readCharacterStanding === "function"
        ? (characterId, factionId) => adapter.readCharacterStanding(characterId, factionId) : null,
      excludedFactionIds: deps.huntExcludedFactionIds, worldSeed: persistence.worldSeed } : null;
    const relationColors = M.relationColorsEnabled === true ? {
      getHuntScene, getFactionKind: deps.getFactionKind, huntSettings: config.playerHunt || {},
      readStanding: typeof adapter.readCharacterStanding === "function"
        ? (characterId, factionId) => adapter.readCharacterStanding(characterId, factionId) : null,
      maxStandingReadsPerPass: M.relationColorsMaxStandingReadsPerPass,
      maxRepaintsPerPass: M.relationColorsMaxRepaintsPerPass } : null;
    const SE = config.sentries;
    let sentrySeam = null;
    const sentrySeamFailures = new Set();
    const getSentrySeam = () => {
      if (sentrySeam !== null) return sentrySeam;
      const r = typeof adapter.sentrySeams === "function" ? safeCall(() => adapter.sentrySeams()) : null;
      const seam = r && r.ok === true && r.seam ? r.seam : null;
      const combat = seam && typeof seam.checkCombat === "function" ? safeCall(() => seam.checkCombat()) : null;
      if (combat && combat.ok === true) {
        sentrySeam = seam;
        return sentrySeam;
      }
      const why = String((combat && (combat.detail || combat.reason)) || (r && (r.detail || r.reason))
        || "no sentrySeams");
      if (!sentrySeamFailures.has(why)) {
        sentrySeamFailures.add(why);
        logger.log(`materialization: sentry combat seam unavailable - ${why}`);
      }
      return null;
    };
    const strengthGroups = SE && SE.enabled === true
      ? expandStrengthGroups(STRENGTH_GROUPS, null, capitalPowerOverlayOf(config.strategy)) : null;
    const sentries = SE && SE.enabled === true && SE.live && typeof SE.live === "object" ? {
      settings: SE.live, getSentries: typeof deps.getSentries === "function" ? deps.getSentries : () => null,
      getSeam: getSentrySeam, getFactionKind: deps.getFactionKind, huntSettings: config.playerHunt || {},
      isFactionEnemy: typeof deps.isFactionEnemy === "function" ? deps.isFactionEnemy : null,
      readStanding: typeof adapter.readCharacterStanding === "function"
        ? (characterId, factionId) => adapter.readCharacterStanding(characterId, factionId) : null,
      strengthGroups } : null;
    const sentryHold = sentries && SE.liveHold && typeof SE.liveHold === "object" ? {
      settings: SE.liveHold, lossTracker: holdLossTracker, getHuntScene, getSentrySeam,
      getFleetExposure: deps.getFleetExposure, getFleets: deps.getFleets, getSentries: sentries.getSentries,
      getFactionKind: deps.getFactionKind, huntSettings: config.playerHunt || {},
      isFactionEnemy: sentries.isFactionEnemy, readStanding: sentries.readStanding,
      maxStandingReads: SE.live.maxStandingReadsPerPass, strengthGroups,
      retreatLossPermille: SE.battle && Number.isSafeInteger(SE.battle.attackerRetreatLossPermille)
        ? SE.battle.attackerRetreatLossPermille : null,
      gridEnabled: Boolean(SE.battle && SE.battle.gridEnabled === true) } : null;
    const service = createMaterializationService({ store: persistence.store, battleLive, npcSpawn, budget,
      getPresence, getGovernor: deps.getGovernor, getBattleStatus, clock,
      settings: { ...M, maxLiveMaterializationsPerSystem: limits.maxLiveMaterializationsPerSystem,
        garrisonLive: config.battle && config.battle.garrisonLive ? config.battle.garrisonLive : null },
      telemetry, logger, hooks: deps.hooks, nowMs: deps.nowMs,
      getFleets: deps.getFleets, ownerFactionIds: deps.ownerFactionIds,
      lossTracker, lossImportOn, liveEnd: { enabled: endCfg.enabled === true, timeoutMs: endCfg.timeoutMs }, hunt,
      exposure, patrol, relationColors, sentries, sentryHold, presence,
      readDormancyGuardStats: typeof adapter.readDormancyGuardStats === "function"
        ? () => adapter.readDormancyGuardStats() : null,
      ...(slcOn ? { structureSeam: safeCall(() => adapter.getStructureSeam()) } : {}) });

    let unsubscribe = [];
    let poller = null;
    const subscribe = () => {
      if (unsubscribe.length > 0 || poller === null) return;
      const presence = safeCall(getPresence);
      if (!presence || typeof presence.onSystemObserved !== "function"
        || typeof presence.onSystemUnobserved !== "function") return;
      for (const name of ["onSystemObserved", "onSystemUnobserved"]) {
        const r = safeCall(() => presence[name](() => poller.arm(0)));
        if (r && r.ok === true && typeof r.unsubscribe === "function") unsubscribe.push(r.unsubscribe);
      }
    };
    poller = createPoller({
      runPass: () => {
        subscribe();
        service.runPass(clock.now());
      },
      intervalMs: M.pumpMs,
      now: () => clock.now(),
      setTimer: deps.setTimer,
      onError: (err) => service.notePassError(err),
      pacing: false,
    });
    const started = poller.start();
    if (!started.ok) {
      safeCall(unbindSink);
      return { ok: false, reason: "MATERIALIZATION_START_FAILED", detail: `poller ${started.reason}` };
    }
    subscribe();

    let viewHandle = null;
    const views = deps.views;
    if (views && typeof views.registerView === "function") {
      const r = safeCall(() => views.registerView(VIEW_ID, buildMaterializationView({
        getStatus: (opts) => service.getStatus(opts), getBattleStatus, clock, getGraph: deps.getGraph,
        readFactionNames: () => {
          const names = typeof adapter.readFactionNames === "function" ? adapter.readFactionNames() : null;
          return names && names.ok === true && names.names instanceof Map ? names.names : null;
        } })));
      if (r && r.ok) viewHandle = r;
      else logger.log(`materialization: view ${VIEW_ID} not registered - ${(r && r.reason) || "no result"}`);
    }
    logger.log(`materialization: running pump=${M.pumpMs}ms targetMode=${M.targetMode} aggroPlayers=`
      + `${M.aggroPlayers === true} invaderProfiles=${M.invaderProfilesEnabled === true} `
      + `industryProfiles=${M.industryProfilesEnabled === true} budget=${limits.maxLiveMaterializationsPerSystem}/system `
      + `${limits.maxLiveMaterializationsGlobal}/global maxShipsPerBattle=${M.maxShipsPerBattle}`
      + ` fleetExposure=${Boolean(config.fleetExposure && config.fleetExposure.enabled === true)}`
      + ` loyaltySpare=${Boolean(config.playerHunt && config.playerHunt.loyaltySpareEnabled === true)}`
      + ` waves=${M.wavesEnabled === true} profileFallback=${M.profileFallbackEnabled === true}`);

    let stopped = false;
    const facade = {
      runPass: (now) => service.runPass(now),
      getStatus: () => Object.freeze({ ...service.getStatus(), listening: unsubscribe.length,
        pumpPasses: poller.getPasses() }),
      stop(reason) {
        if (stopped) return;
        stopped = true;
        poller.stop();
        safeCall(unbindSink);
        for (const fn of unsubscribe.splice(0)) safeCall(fn);
        unsubscribe = [];
        if (viewHandle) {
          const handle = viewHandle;
          viewHandle = null;
          safeCall(() => handle.unregister());
        }
        service.stop(reason);
      },
      liveLossesByFleet: () => (stopped ? new Map() : service.liveLossesByFleet()),
      liveSideOf: (entityId) => (stopped ? NOT_LIVE : service.liveSideOf(entityId)),
      inboundFleets: (systemId, nowMs, max) => (stopped ? INBOUND_STOPPED
        : service.inboundFleets(systemId, nowMs, max)),
    };
    return { ok: true, materialization: Object.freeze(facade) };
  } catch (err) {
    safeCall(unbindSink);
    return { ok: false, reason: "MATERIALIZATION_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startMaterialization, createUnavailableMaterialization, MATERIALIZATION_METHODS };
