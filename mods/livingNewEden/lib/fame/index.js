"use strict";

const { createPoller } = require("../presence/poller");
const S = require("./schema");
const { createFameService } = require("./service");

const FAME_METHODS = Object.freeze(["tierOf", "localPolicy", "dockVerdict", "reviewNow", "getStatus", "stop"]);
const NONE_RESULT = Object.freeze({ tier: S.TIER.NONE, standing: null });
const ALLOW = Object.freeze({ deny: false });

const messageOf = (err) => String((err && err.message) || err);

function createUnavailableFame(reason, detail) {
  const r = String(reason || "unavailable");
  const state = r === "disabled_by_config" ? "off" : r === "stopped" ? "stopped" : "unavailable";
  const status = Object.freeze({ state, reason: r, ...(detail ? { detail: String(detail) } : {}) });
  const refusal = Object.freeze({ ok: false, reason: state === "stopped" ? "STOPPED" : "FAME_UNAVAILABLE" });
  return Object.freeze({ tierOf: () => NONE_RESULT, localPolicy: () => null, dockVerdict: () => ALLOW,
    reviewNow: () => refusal, getStatus: () => status, stop() {} });
}

function startFame(deps) {
  try {
    const { config, clock, persistence } = deps || {};
    const F = config && config.fame;
    if (!F || F.enabled !== true) return { ok: false, reason: "disabled_by_config" };
    const set = S.fameSettingsOf(config);
    if (!set.ok) return { ok: false, reason: "INVALID_SETTINGS", detail: set.detail };
    if (!persistence || persistence.ok !== true || !persistence.store || !persistence.journal) {
      return { ok: false, reason: "dependency_disabled:persistence" };
    }
    if (!clock || typeof clock.now !== "function") return { ok: false, reason: "FAME_START_FAILED", detail: "clock" };
    if (typeof deps.readStanding !== "function") {
      return { ok: false, reason: "FAME_START_FAILED", detail: "readStanding" };
    }
    const P = set.settings;
    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    const service = createFameService({ settings: P, store: persistence.store, journal: persistence.journal, clock,
      telemetry: deps.telemetry || null, logger, readStanding: deps.readStanding,
      readFactionNames: deps.readFactionNames, getPresence: deps.getPresence, getRegistry: deps.getRegistry,
      getGovernor: deps.getGovernor, getNotices: deps.getNotices, getMarketStatus: deps.getMarketStatus,
      getBounty: deps.getBounty, getGraph: deps.getGraph });
    const poller = createPoller({
      runPass: () => service.reviewNow(clock.now()),
      intervalMs: P.reviewEveryMs,
      now: () => clock.now(),
      setTimer: deps.setTimer,
      onError: (err) => logger.log(`fame: review threw - ${messageOf(err)}`),
    });
    const started = poller.start();
    if (!started.ok) {
      service.stop();
      return { ok: false, reason: "FAME_START_FAILED", detail: `poller ${started.reason}` };
    }
    const marketOn = P.marketTaxEnabled === true || P.marketBrokerEnabled === true;
    const setSlot = (fn) => {
      try {
        if (typeof deps.setMarketSlot === "function") deps.setMarketSlot(fn);
      } catch (err) {
        logger.log(`fame: market slot not set - ${messageOf(err)}`);
      }
    };
    if (marketOn) setSlot((context) => service.marketSlot(context));
    let hookState = "unknown";
    if (marketOn) {
      try {
        const hook = typeof deps.getMarketStatus === "function" ? deps.getMarketStatus() : null;
        if (hook && typeof hook.state === "string" && hook.state !== "") hookState = hook.state;
      } catch (_err) {
        hookState = "unknown";
      }
    }
    logger.log(`fame: running legend>=${P.legendMin} enemy<=${P.enemyMax} everyMs=${P.reviewEveryMs}`
      + ` local=${P.localEnabled ? "on" : "off"} notices=${P.noticesEnabled ? "on" : "off"}`
      + ` dock=${P.dockDenyEnabled ? "on" : "off"} market=${marketOn ? `on(hook=${hookState})` : "off"}`);
    const facade = {
      tierOf: (characterId, factionId) => service.tierOf(characterId, factionId),
      localPolicy: () => service.localPolicy(),
      dockVerdict: (q) => service.dockVerdict(q),
      reviewNow: (now) => service.reviewNow(now),
      getStatus: () => service.getStatus(),
      stop() {
        if (service.isStopped()) return;
        if (marketOn) setSlot(null);
        poller.stop();
        service.stop();
      },
    };
    return { ok: true, fame: Object.freeze(facade) };
  } catch (err) {
    return { ok: false, reason: "FAME_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startFame, createUnavailableFame, FAME_METHODS };
