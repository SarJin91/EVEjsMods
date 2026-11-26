"use strict";

const { isModuleEnabled } = require("../../config");
const { createPoller } = require("../presence/poller");
const S = require("./schema");
const repo = require("./repository");
const { createArchaeologyService, drainInTx } = require("./service");
const { createArchiveContentProvider } = require("./content");
const { createRelicChat, installRelicCommand } = require("./command");
const { buildArchaeologyPanel, VIEW_ORDER } = require("./view");

const ARCHAEOLOGY_METHODS = Object.freeze(["startChainInTx", "readChainOf", "runPass", "getStatus", "stop"]);
const DEFAULT_MAX_READ_IDS = 1000;

const messageOf = (err) => String((err && err.message) || err);

function safeCall(fn) {
  try {
    return typeof fn === "function" ? fn() : null;
  } catch (_err) {
    return null;
  }
}

function running(svc) {
  if (!svc || typeof svc.getStatus !== "function") return null;
  const st = safeCall(() => svc.getStatus());
  return st && st.state === "running" ? svc : null;
}

function createUnavailableArchaeology(reason, detail) {
  const refusal = Object.freeze({ ok: false, reason: String(reason), ...(detail ? { detail: String(detail) } : {}) });
  const status = Object.freeze({ state: "unavailable", reason: String(reason),
    ...(detail ? { detail: String(detail) } : {}) });
  return Object.freeze({ startChainInTx: () => refusal, readChainOf: () => refusal, runPass: () => refusal,
    getStatus: () => status, stop() {} });
}

function drain(deps, P) {
  const store = deps.persistence && deps.persistence.store;
  if (!P || !store || typeof store.transaction !== "function" || !deps.clock || typeof deps.clock.now !== "function") {
    return;
  }
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  try {
    const now = deps.clock.now();
    const sites = running(safeCall(deps.getSites));
    const r = store.transaction("archaeology.drain", (tx) => drainInTx(tx, now, P.maxRowsPerPass, repo, sites));
    const v = r && r.ok === true ? r.value : null;
    if (!v || v.ok !== true) {
      logger.log(`archaeology: drain failed - ${(r && (r.reason || (v && v.reason))) || "no result"}`);
      return;
    }
    if (v.cancelled > 0) {
      const t = deps.telemetry;
      if (t && typeof t.count === "function") safeCall(() => t.count("archaeology.chains.ended.CANCELLED", v.cancelled));
      logger.log(`archaeology: drain cancelled=${v.cancelled}${v.more ? " (more left for the next start)" : ""}`);
    }
  } catch (err) {
    logger.log(`archaeology: drain threw - ${messageOf(err)}`);
  }
}

function registerPanel(deps, service, P, logger) {
  const views = deps.views;
  if (!views || typeof views.registerView !== "function") return null;
  try {
    const r = views.registerView(S.VIEW_ID, buildArchaeologyPanel({ store: deps.persistence.store, repo,
      clock: deps.clock, getGovernor: deps.getGovernor, getStatus: () => service.getStatus(),
      settings: { pollMs: P.passIntervalMs } }));
    if (r && r.ok === true && typeof r.unregister === "function") return () => r.unregister();
    logger.log(`archaeology: view ${S.VIEW_ID} not registered - ${(r && r.reason) || "no result"}`);
  } catch (err) {
    logger.log(`archaeology: view ${S.VIEW_ID} not registered - ${messageOf(err)}`);
  }
  return null;
}

function startArchaeology(deps) {
  try {
    const { config, persistence, clock, adapter } = deps || {};
    const P = S.archaeologySettingsOf(config);
    if (!P || P.enabled !== true || !isModuleEnabled(config, "sites")) {
      if (isModuleEnabled(config, "sites")) drain(deps || {}, P);
      return { ok: false, reason: "disabled_by_config" };
    }
    if (!persistence || persistence.ok !== true || !persistence.store) {
      return { ok: false, reason: "dependency_disabled:persistence" };
    }
    const sites = running(safeCall(deps.getSites));
    if (!sites || typeof sites.registerContentProvider !== "function") {
      return { ok: false, reason: "dependency_disabled:sites" };
    }
    if (!clock || typeof clock.now !== "function") {
      return { ok: false, reason: "ARCHAEOLOGY_START_FAILED", detail: "clock" };
    }
    const worldSeed = Number.isSafeInteger(persistence.worldSeed) ? persistence.worldSeed
      : safeCall(() => persistence.store.getWorldSeed());
    if (!Number.isSafeInteger(worldSeed)) return { ok: false, reason: "ARCHAEOLOGY_START_FAILED", detail: "worldSeed" };
    if (!S.isSeasonKey(P.seasonKey)) return { ok: false, reason: "ARCHAEOLOGY_START_FAILED", detail: "seasonKey" };
    if (!adapter || typeof adapter.onSiteContainerHacked !== "function") {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "no onSiteContainerHacked" };
    }
    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    const maxRows = config.persistence && Number.isSafeInteger(config.persistence.maxRowsPerTransaction)
      ? config.persistence.maxRowsPerTransaction : P.retentionDeletesPerPass;
    const retentionLimit = Math.max(1, Math.min(P.retentionDeletesPerPass,
      Math.floor(maxRows / (1 + S.MAX_STAGE_COUNT))));
    const maxReadIds = config.world && Number.isSafeInteger(config.world.maxBatchReadIds)
      ? config.world.maxBatchReadIds : DEFAULT_MAX_READ_IDS;

    let poller = null;
    const service = createArchaeologyService({ store: persistence.store, worldSeed, settings: P,
      excludedRegionIds: deps.excludedRegionIds, maxReadIds, retentionLimit, getGovernor: deps.getGovernor,
      getNotices: deps.getNotices, getGraph: deps.getGraph, getWorld: deps.getWorld, getSeasons: deps.getSeasons,
      getSites: deps.getSites, getPresence: deps.getPresence,
      getChatterAi: deps.getChatterAi, clock,
      adapter, telemetry: deps.telemetry || null, logger, nowMs: deps.nowMs,
      onQueued: () => (poller ? poller.arm(0) : undefined) });
    poller = createPoller({
      runPass: () => service.runPass(clock.now()),
      intervalMs: P.passIntervalMs,
      now: () => clock.now(),
      setTimer: deps.setTimer,
      onError: (err) => logger.log(`archaeology: pass threw - ${messageOf(err)}`),
    });
    const sub = safeCall(() => adapter.onSiteContainerHacked(service.onHackWin));
    if (!sub || sub.ok !== true || typeof sub.unsubscribe !== "function") {
      service.stop();
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: String((sub && (sub.detail || sub.reason)) || "no result") };
    }
    const provider = safeCall(() => sites.registerContentProvider(createArchiveContentProvider({
      store: persistence.store, settings: P })));
    if (!provider || provider.ok !== true || typeof provider.unregister !== "function") {
      safeCall(sub.unsubscribe);
      service.stop();
      return { ok: false, reason: "dependency_disabled:sites",
        detail: `provider ${(provider && provider.reason) || "no result"}` };
    }
    const started = poller.start();
    if (!started.ok) {
      safeCall(provider.unregister);
      safeCall(sub.unsubscribe);
      service.stop();
      return { ok: false, reason: "ARCHAEOLOGY_START_FAILED", detail: `poller ${started.reason}` };
    }
    let command = "off";
    let uninstall = null;
    if (P.commandEnabled === true) {
      const chat = createRelicChat({ readChainOf: (id) => service.readChainOf(id), settings: P,
        chat: config.frontChat || null, getGraph: deps.getGraph, isRunning: () => !service.isStopped(),
        bump: (name) => service.bump(name), log: (line) => logger.log(`archaeology: ${line}`) });
      const inst = installRelicCommand(adapter, chat);
      if (inst.ok) {
        command = "installed";
        uninstall = inst.uninstall;
      } else command = `refused:${inst.reason}`;
    }
    const unregisterPanel = registerPanel(deps, service, P, logger);
    logger.log(`archaeology: running chance=${P.startChancePermille}permille jumps=${P.minJumps}-${P.maxJumps}`
      + ` stages=${P.stageCountMin}-${P.stageCountMax} command=${command} panel=${unregisterPanel ? VIEW_ORDER : "off"}`);
    let unsubscribe = sub.unsubscribe;
    const facade = {
      startChainInTx: (tx, o) => service.startChainInTx(tx, o),
      readChainOf: (characterId) => service.readChainOf(characterId),
      runPass: (now) => service.runPass(now),
      getStatus: () => Object.freeze({ ...service.getStatus(), listening: unsubscribe !== null, command }),
      stop() {
        if (service.isStopped()) return;
        if (unsubscribe) {
          safeCall(unsubscribe);
          unsubscribe = null;
        }
        if (uninstall) safeCall(uninstall);
        if (unregisterPanel) safeCall(unregisterPanel);
        safeCall(provider.unregister);
        poller.stop();
        service.stop();
      },
    };
    return { ok: true, archaeology: Object.freeze(facade) };
  } catch (err) {
    return { ok: false, reason: "ARCHAEOLOGY_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startArchaeology, createUnavailableArchaeology, ARCHAEOLOGY_METHODS };
