"use strict";

const { isModuleEnabled } = require("../../../config");
const { createPoller } = require("../../presence/poller");
const { createSiteService } = require("./siteService");

function messageOf(err) {
  return String((err && err.message) || err);
}

function unavailableSites(reason, detail) {
  const refusal = Object.freeze({ ok: false, reason: String(reason), ...(detail ? { detail: String(detail) } : {}) });
  const refuse = () => refusal;
  const status = Object.freeze({ state: "unavailable", reason: String(reason),
    ...(detail ? { detail: String(detail) } : {}) });
  return Object.freeze({
    createSiteInTx: refuse,
    extendSitesInTx: refuse,
    cleanupSitesInTx: refuse,
    releaseSlotInTx: refuse,
    listSitesByEvent: refuse,
    countLiveSitesBySystem: refuse,
    addSiteStateListener: () => () => {},
    registerContentProvider: () => Object.freeze({ ok: false, reason: "SITES_UNAVAILABLE" }),
    nudge() {},
    runPass: refuse,
    getStatus: () => status,
    stop() {},
  });
}

function startSites(deps) {
  try {
    const { config, persistence, clock, adapter } = deps || {};
    if (!isModuleEnabled(config, "sites")) return { ok: false, reason: "disabled_by_config" };
    if (!persistence || persistence.ok !== true || !persistence.store) {
      return { ok: false, reason: "dependency_disabled:persistence" };
    }
    if (!clock || typeof clock.now !== "function") return { ok: false, reason: "SITES_START_FAILED", detail: "clock" };
    if (!config.sites || !config.limits) return { ok: false, reason: "SITES_START_FAILED", detail: "config" };
    let check;
    try {
      check = adapter && typeof adapter.checkDungeonSites === "function" ? adapter.checkDungeonSites()
        : { ok: false, detail: "no checkDungeonSites" };
    } catch (err) {
      check = { ok: false, detail: messageOf(err) };
    }
    if (!check || check.ok !== true) {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: (check && (check.detail || check.reason)) || "no result" };
    }
    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    const service = createSiteService({ store: persistence.store, adapter, clock, config,
      telemetry: deps.telemetry || null, logger, getGovernor: deps.getGovernor, repository: deps.repository });
    const poller = createPoller({
      runPass: () => service.runPass(clock.now()),
      intervalMs: config.sites.pumpIntervalMs,
      now: () => clock.now(),
      setTimer: deps.setTimer,
      onError: (err) => logger.log(`sites: pump pass threw - ${messageOf(err)}`),
    });
    const started = poller.start();
    if (!started.ok) return { ok: false, reason: "SITES_START_FAILED", detail: `poller ${started.reason}` };
    const live = service.countLive();
    logger.log(`sites: running live=${live.ok ? live.count : "?"} limit=${config.sites.maxActiveSites}`);
    let scannerHide = false;
    if (config.sites.hideEndedFromScanner === true && adapter && typeof adapter.installSiteScannerHide === "function") {
      let hid;
      try {
        hid = adapter.installSiteScannerHide({ maxHidden: config.sites.maxHiddenScannerSites });
      } catch (err) {
        hid = { ok: false, reason: messageOf(err) };
      }
      if (hid && hid.ok === true) scannerHide = true;
      else {
        logger.log(`sites: scanner hide off - ${(hid && hid.reason) || "no result"}`
          + `${hid && hid.detail ? ` (${hid.detail})` : ""}`);
      }
    }
    let stopped = false;
    const facade = {
      createSiteInTx: service.createSiteInTx,
      extendSitesInTx: service.extendSitesInTx,
      cleanupSitesInTx: service.cleanupSitesInTx,
      releaseSlotInTx: service.releaseSlotInTx,
      listSitesByEvent: service.listSitesByEvent,
      countLiveSitesBySystem: service.countLiveSitesBySystem,
      addSiteStateListener: service.addSiteStateListener,
      registerContentProvider: service.registerContentProvider,
      nudge() {
        if (!stopped) poller.arm(0);
      },
      runPass: service.runPass,
      getStatus: () => Object.freeze({ state: stopped ? "stopped" : "running", passes: poller.getPasses() }),
      stop() {
        if (stopped) return;
        stopped = true;
        poller.stop();
        if (scannerHide) {
          scannerHide = false;
          try {
            adapter.uninstallSiteScannerHide();
          } catch (_err) {
          }
        }
      },
    };
    return { ok: true, sites: Object.freeze(facade) };
  } catch (err) {
    return { ok: false, reason: "SITES_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startSites, unavailableSites };
