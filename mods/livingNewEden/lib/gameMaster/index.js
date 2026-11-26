"use strict";

const { isModuleEnabled } = require("../../config");
const { createPoller } = require("../presence/poller");
const { gameMasterSettingsOf, VIEW_ID } = require("./schema");
const { createStepRegistry, registerBuiltin } = require("./registry");
const { createGameMasterService, drainGameMaster } = require("./service");
const { createGameMasterRepository } = require("./repository");
const { createWaitStep } = require("./steps/wait");
const { createNoticeSender, createNoticeStep } = require("./steps/notice");
const { createNewsStep } = require("./steps/news");
const { createSiteStep, runningSites } = require("./steps/site");
const { buildGameMasterPanel } = require("./view");
const { chatterAiSettingsOf } = require("../chatterAi/schema");

const GAME_MASTER_METHODS = Object.freeze(["getStatus", "runPass", "runActivity", "listBoardRows", "stop"]);
const SITE_EVENT_PREFIX = "gm:";
const DRAIN_LIMIT_DEFAULT = 8;

const messageOf = (err) => String((err && err.message) || err);

function call(fn) {
  try {
    fn();
  } catch (_err) {
  }
}

function createUnavailableGameMaster(reason, detail) {
  const why = String(reason || "GAME_MASTER_UNAVAILABLE");
  const status = Object.freeze({ state: "unavailable", reason: why, ...(detail ? { detail: String(detail) } : {}) });
  const refusal = Object.freeze({ ok: false, reason: why });
  return Object.freeze({ getStatus: () => status, runPass: () => refusal, runActivity: () => refusal,
    listBoardRows: () => refusal, stop() {} });
}

function builtinKindsOf(S, deps, sender) {
  return [createWaitStep(S), createNoticeStep({ sender }), createNewsStep({ journal: deps.persistence.journal })];
}

function drainIfNeeded(deps, logger) {
  const persistence = deps.persistence;
  const store = persistence && persistence.store;
  if (!store || typeof store.transaction !== "function" || !persistence.journal) return;
  const C = (deps.config && deps.config.gameMaster) || {};
  const limit = Number.isSafeInteger(C.maxStepsPerPass) && C.maxStepsPerPass > 0 ? C.maxStepsPerPass
    : DRAIN_LIMIT_DEFAULT;
  const local = createStepRegistry();
  const parsed = gameMasterSettingsOf(deps.config);
  if (parsed.ok) {
    const sender = createNoticeSender({ getNotices: () => null, getPresence: () => null, getGraph: () => null,
      S: parsed.settings });
    for (const kind of builtinKindsOf(parsed.settings, deps, sender)) registerBuiltin(local, kind);
    if (typeof deps.getSites === "function") {
      registerBuiltin(local, createSiteStep({ getSites: deps.getSites, S: parsed.settings }));
    }
  }
  const shared = deps.registry && typeof deps.registry.get === "function" ? deps.registry : null;
  const registry = { get: (type) => (shared && shared.get(type)) || local.get(type) };
  const now = deps.clock && typeof deps.clock.now === "function" ? deps.clock.now() : 0;
  const r = drainGameMaster({ store, journal: persistence.journal, registry, now, limit });
  if (!r.ok) logger.log(`gameMaster: drain failed - ${r.reason}${r.detail ? ` ${r.detail}` : ""}`);
  else if (r.drained > 0) {
    if (deps.telemetry && typeof deps.telemetry.count === "function") {
      call(() => deps.telemetry.count("gameMaster.drained", r.drained));
    }
    logger.log(`gameMaster: drained ${r.drained} thread(s) - CANCELLED${r.more ? " (more at the next start)" : ""}`);
  }
}

function startGameMaster(deps) {
  try {
    const { config, persistence, clock } = deps || {};
    const logger = deps && deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    const C = config && config.gameMaster;
    if (!C || C.enabled !== true || !isModuleEnabled(config, "world")) {
      try {
        drainIfNeeded(deps || {}, logger);
      } catch (err) {
        logger.log(`gameMaster: drain threw - ${messageOf(err)}`);
      }
      return { ok: false, reason: "disabled_by_config" };
    }
    if (!persistence || persistence.ok !== true || !persistence.store) {
      return { ok: false, reason: "dependency_disabled:persistence" };
    }
    if (!clock || typeof clock.now !== "function") return { ok: false, reason: "INIT_FAILED", detail: "clock" };
    if (!persistence.journal || typeof persistence.journal.applyOnce !== "function") {
      return { ok: false, reason: "INIT_FAILED", detail: "journal" };
    }
    const parsed = gameMasterSettingsOf(config);
    if (!parsed.ok) return { ok: false, reason: "INIT_FAILED", detail: `${parsed.reason}:${parsed.detail}` };
    const S = parsed.settings;
    const worldSeed = Number.isSafeInteger(persistence.worldSeed) ? persistence.worldSeed
      : (typeof persistence.store.getWorldSeed === "function" ? persistence.store.getWorldSeed() : undefined);
    if (!Number.isSafeInteger(worldSeed)) return { ok: false, reason: "INIT_FAILED", detail: "worldSeed" };
    const registry = deps.registry && typeof deps.registry.get === "function" ? deps.registry : createStepRegistry();
    const sender = createNoticeSender({ getNotices: deps.getNotices, getPresence: deps.getPresence,
      getGraph: deps.getGraph, S });
    const unregisters = [];
    for (const kind of builtinKindsOf(S, deps, sender)) {
      const r = registerBuiltin(registry, kind);
      if (!r.ok) {
        for (const u of unregisters) call(u);
        return { ok: false, reason: "INIT_FAILED", detail: `builtin ${kind.type} ${r.reason}` };
      }
      unregisters.push(() => r.unregister());
    }
    const chatterS = chatterAiSettingsOf(config);
    const service = createGameMasterService({ store: persistence.store, journal: persistence.journal, worldSeed,
      settings: S, registry, sender, getPresence: deps.getPresence, getGraph: deps.getGraph,
      getGovernor: deps.getGovernor, readFactionNames: deps.readFactionNames, telemetry: deps.telemetry || null,
      logger, nowMs: deps.nowMs, getChatterAi: deps.getChatterAi, getNews: deps.getNews,
      fieldSettings: chatterS.ok ? chatterS.settings : null, clockNow: () => clock.now() });
    const siteKind = createSiteStep({ getSites: deps.getSites, S });
    let siteReg = null;
    let siteRefusal = null;
    let siteFacade = null;
    let offSites = null;
    let wake = null;
    const onSiteState = (event) => {
      try {
        if (wake && event && typeof event.eventId === "string" && event.eventId.startsWith(SITE_EVENT_PREFIX)) wake();
      } catch (_err) {
      }
    };
    const syncSites = () => {
      try {
        const sites = runningSites(deps.getSites);
        if (sites && !siteReg) {
          const r = registerBuiltin(registry, siteKind);
          if (r.ok) {
            siteReg = r;
            siteRefusal = null;
          } else if (siteRefusal !== r.reason) {
            siteRefusal = r.reason;
            logger.log(`gameMaster: step SITE not registered - ${r.reason}`);
          }
        } else if (!sites && siteReg) {
          call(() => siteReg.unregister());
          siteReg = null;
        }
        if (sites !== siteFacade) {
          if (offSites) call(offSites);
          offSites = null;
          siteFacade = sites;
          const off = sites && typeof sites.addSiteStateListener === "function"
            ? sites.addSiteStateListener(onSiteState) : null;
          offSites = typeof off === "function" ? off : null;
        }
      } catch (err) {
        logger.log(`gameMaster: site sync threw - ${messageOf(err)}`);
      }
    };
    const stopAll = (pollers) => {
      for (const p of pollers) call(() => p.stop());
      for (const u of unregisters) call(u);
      if (offSites) call(offSites);
      if (siteReg) call(() => siteReg.unregister());
      offSites = null;
      siteReg = null;
      wake = null;
      service.stop();
    };
    const pass = () => {
      syncSites();
      return service.runPass(clock.now());
    };
    const poller = createPoller({ runPass: pass, intervalMs: S.passIntervalMs,
      now: () => clock.now(), setTimer: deps.setTimer,
      onError: (err) => logger.log(`gameMaster: pass threw - ${messageOf(err)}`) });
    const activityPoller = createPoller({ runPass: () => service.runActivity(clock.now()),
      intervalMs: S.activitySampleMs, now: () => clock.now(), setTimer: deps.setTimer,
      onError: (err) => logger.log(`gameMaster: activity threw - ${messageOf(err)}`) });
    wake = () => poller.arm(0);
    syncSites();
    for (const p of [poller, activityPoller]) {
      const started = p.start();
      if (!started.ok) {
        stopAll([poller, activityPoller]);
        return { ok: false, reason: "INIT_FAILED", detail: `poller ${started.reason}` };
      }
    }
    if (deps.views && typeof deps.views.registerView === "function") {
      try {
        const r = deps.views.registerView(VIEW_ID, buildGameMasterPanel({ store: persistence.store,
          repo: createGameMasterRepository(), clock, getStatus: () => service.getStatus(),
          getGovernor: deps.getGovernor, settings: { passIntervalMs: S.passIntervalMs } }));
        if (r && r.ok === true && typeof r.unregister === "function") unregisters.push(() => r.unregister());
        else logger.log(`gameMaster: view ${VIEW_ID} not registered - ${(r && r.reason) || "no result"}`);
      } catch (err) {
        logger.log(`gameMaster: view ${VIEW_ID} not registered - ${messageOf(err)}`);
      }
    }
    logger.log(`gameMaster: running arcs=${S.arcs.join(",")} cycleHours=${S.cycleHours}`
      + ` startHourUtc=${S.cycleStartHourUtc} ai=${S.aiEnabled === true ? "plot" : "off"}`
      + ` template=${S.templateFallback === true ? "on" : "off"} kinds=${registry.list().length}`);
    let stopped = false;
    const facade = {
      getStatus: () => service.getStatus(),
      runPass: pass,
      runActivity: () => service.runActivity(clock.now()),
      listBoardRows: (opts) => {
        try {
          return service.listBoardRows(opts);
        } catch (err) {
          return { ok: false, reason: "THREW", detail: messageOf(err).slice(0, 120) };
        }
      },
      stop() {
        if (stopped) return;
        stopped = true;
        stopAll([poller, activityPoller]);
      },
    };
    return { ok: true, gameMaster: Object.freeze(facade) };
  } catch (err) {
    return { ok: false, reason: "INIT_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startGameMaster, createUnavailableGameMaster, GAME_MASTER_METHODS };
