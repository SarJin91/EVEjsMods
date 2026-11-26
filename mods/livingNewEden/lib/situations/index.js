"use strict";

const { isModuleEnabled } = require("../../config");
const { createPoller } = require("../presence/poller");
const killObservation = require("../adapter/killObservation");
const { situationsSettingsOf, COUNTER_NAMES } = require("./schema");
const { createSituationService } = require("./service");
const R = require("./repository");
const VIEW = require("./view");

const SITUATIONS_METHODS = Object.freeze(["getStatus", "runPass", "onKill", "listOpen", "listBoardRows", "stop"]);

const messageOf = (err) => String((err && err.message) || err);

function call(fn) {
  try {
    fn();
  } catch (_err) {
  }
}

function createUnavailableSituations(reason, detail, opts) {
  const why = String(reason || "SITUATIONS_UNAVAILABLE");
  const status = Object.freeze({ state: "unavailable", reason: why, ...(detail ? { detail: String(detail) } : {}) });
  const refusal = Object.freeze({ ok: false, reason: why === "SITUATIONS_DISABLED" ? "SITUATIONS_DISABLED"
    : "NOT_READY" });
  const boardRefusal = opts && opts.boardEnabled === true ? refusal
    : Object.freeze({ ok: false, reason: "SITUATIONS_DISABLED" });
  return Object.freeze({ getStatus: () => status, runPass: () => refusal, onKill: () => refusal,
    listOpen: () => Object.freeze([]), listBoardRows: () => boardRefusal, stop() {} });
}

function registerViews(deps, service, P, logger) {
  const views = deps.views;
  if (!views || typeof views.registerView !== "function") return [];
  const getGraph = typeof deps.getGraph === "function" ? deps.getGraph : () => null;
  const systemNameOf = (id) => {
    const g = getGraph();
    const sys = g && typeof g.getSystem === "function" ? g.getSystem(id) : null;
    return sys && typeof sys.name === "string" ? sys.name : null;
  };
  const base = { store: deps.persistence.store, repo: { listEndedSinceInTx: R.listEndedSinceInTx },
    listOpen: () => service.listOpen(), clock: deps.clock, getGovernor: deps.getGovernor,
    settings: { layerRecentMs: P.layerRecentMs, layerMaxRows: P.layerMaxRows, pollMs: P.pollMs } };
  const defs = [[VIEW.VIEW_ID, () => VIEW.buildSituationsPanel({ ...base, getStatus: () => service.getStatus(),
    systemNameOf })]];
  if (deps.config.observer && deps.config.observer.galaxyEnabled === true) {
    defs.push([VIEW.LAYER_ID, () => VIEW.buildSituationsLayer(base)]);
  }
  const out = [];
  for (const [id, build] of defs) {
    try {
      const r = views.registerView(id, build());
      if (r && r.ok === true && typeof r.unregister === "function") out.push(() => r.unregister());
      else logger.log(`situations: view ${id} not registered - ${(r && r.reason) || "no result"}`);
    } catch (err) {
      logger.log(`situations: view ${id} not registered - ${messageOf(err)}`);
    }
  }
  return out;
}

function startSituations(deps) {
  try {
    const { config, persistence, clock } = deps || {};
    const C = config && config.situations;
    if (!C || C.enabled !== true || !isModuleEnabled(config, "world")) {
      return { ok: false, reason: "disabled_by_config" };
    }
    if (!persistence || persistence.ok !== true || !persistence.store) {
      return { ok: false, reason: "dependency_disabled:persistence" };
    }
    if (!clock || typeof clock.now !== "function") {
      return { ok: false, reason: "SITUATIONS_START_FAILED", detail: "clock" };
    }
    const parsed = situationsSettingsOf(config);
    if (!parsed.ok) {
      return { ok: false, reason: "SITUATIONS_START_FAILED", detail: `${parsed.reason}:${parsed.detail}` };
    }
    const P = parsed.settings;
    const worldSeed = Number.isSafeInteger(persistence.worldSeed) ? persistence.worldSeed
      : (typeof persistence.store.getWorldSeed === "function" ? persistence.store.getWorldSeed() : undefined);
    if (!Number.isSafeInteger(worldSeed)) return { ok: false, reason: "SITUATIONS_START_FAILED", detail: "worldSeed" };
    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    const bootAt = clock.now();
    const made = createSituationService({ store: persistence.store, journal: persistence.journal || null, worldSeed,
      settings: P, bootAt, clock, getScene: deps.getScene, getPresence: deps.getPresence, getGraph: deps.getGraph,
      getGovernor: deps.getGovernor, speakersOf: deps.speakersOf, readCharacterNames: deps.readCharacterNames,
      trafficShipsIn: deps.trafficShipsIn, resolveSystemFactions: deps.resolveSystemFactions,
      resolveProfiles: deps.resolveProfiles, sendOccupantMessage: deps.sendOccupantMessage,
      admitScene: deps.admitScene,
      victimProfiles: deps.victimProfiles, haulerProfiles: deps.haulerProfiles, podProfileId: deps.podProfileId,
      leave: deps.leave, rewardCreditIsk: deps.rewardCreditIsk,
      applyStandingGrant: deps.applyStandingGrant, onRumour: deps.onRumour, telemetry: deps.telemetry || null, logger,
      nowMs: deps.nowMs });
    if (!made.ok) return { ok: false, reason: "SITUATIONS_START_FAILED", detail: `${made.reason}:${made.detail}` };
    const service = made.service;
    const booted = service.boot(clock.now());
    if (!booted.ok) {
      service.stop();
      return { ok: false, reason: "SITUATIONS_START_FAILED", detail: `${booted.reason}:${booted.detail || ""}` };
    }
    const poller = createPoller({ runPass: () => service.runPass(clock.now()), intervalMs: P.pollMs,
      now: () => clock.now(), setTimer: deps.setTimer,
      onError: (err) => logger.log(`situations: pass threw - ${messageOf(err)}`),
      pacing: false });
    const started = poller.start();
    if (!started.ok) {
      service.stop();
      return { ok: false, reason: "SITUATIONS_START_FAILED", detail: `poller ${started.reason}` };
    }
    let payInFlight = false;
    const payPoller = P.rewardsEnabled === true ? createPoller({
      runPass: () => {
        if (payInFlight) return;
        payInFlight = true;
        service.runPayoutPass(clock.now()).then(() => { payInFlight = false; }, (err) => {
          payInFlight = false;
          logger.log(`situations: payout pass threw - ${messageOf(err)}`);
        });
      },
      intervalMs: P.payoutPassMs, now: () => clock.now(), setTimer: deps.setTimer,
      onError: (err) => logger.log(`situations: payout pass threw - ${messageOf(err)}`),
    }) : null;
    const payStarted = payPoller ? payPoller.start() : { ok: true };
    if (!payStarted.ok) {
      poller.stop();
      service.stop();
      return { ok: false, reason: "SITUATIONS_START_FAILED", detail: `payout poller ${payStarted.reason}` };
    }
    const kills = killObservation.killWrapMounted() === true ? "on" : "no_wrap";
    const killListener = kills === "on" ? Object.freeze({ onNpcKill: (obs) => service.onKill(obs) }) : null;
    if (killListener) killObservation.setSituations(killListener);
    const unregisterViews = registerViews(deps, service, P, logger);
    const st = service.getStatus();
    logger.log(`situations: running bands=${P.bands.join(",")} maxActive=${P.maxActive}`
      + ` recovered=${st.counters.recovered} kills=${kills}`
      + (P.rewardsEnabled === true ? ` rewards=on pending=${st.payouts.pending}` : ""));
    if (kills === "no_wrap") {
      logger.log("situations: no RESCUED - the NPC kill wrap (factionKillStandingRuntime) is not mounted");
    }
    const facade = {
      getStatus: () => Object.freeze({ ...service.getStatus(), kills }),
      runPass: () => service.runPass(clock.now()),
      onKill: (e) => service.onKill(e),
      listOpen: () => service.listOpen(),
      listBoardRows: (opts) => {
        try {
          return service.listBoardRows(opts);
        } catch (_err) {
          return { ok: false, reason: "BOARD_FAILED" };
        }
      },
      stop() {
        if (service.isStopped()) return;
        for (const unregister of unregisterViews) call(unregister);
        if (killListener && killObservation.getSituations() === killListener) killObservation.setSituations(null);
        poller.stop();
        if (payPoller) payPoller.stop();
        service.stop();
      },
    };
    return { ok: true, situations: Object.freeze(facade) };
  } catch (err) {
    return { ok: false, reason: "SITUATIONS_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startSituations, createUnavailableSituations, SITUATIONS_METHODS, COUNTER_NAMES };
