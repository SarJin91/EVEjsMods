"use strict";

const { createPoller } = require("../../presence/poller");
const { createEventRewardService } = require("./rewardService");

function messageOf(err) {
  return String((err && err.message) || err);
}

function unavailableEventRewards(reason, detail) {
  const refusal = Object.freeze({ ok: false, reason: String(reason), ...(detail ? { detail: String(detail) } : {}) });
  const status = Object.freeze({ state: "unavailable", lastPassAt: null, placedTotal: 0, lastRefusal: String(reason),
    reason: String(reason), ...(detail ? { detail: String(detail) } : {}) });
  return Object.freeze({
    runPass: () => refusal,
    getStatus: () => status,
    stop() {},
  });
}

function startEventRewards(deps) {
  try {
    const { config, persistence, clock } = deps || {};
    if (!config || !config.eventRewards || config.eventRewards.enabled !== true) {
      return { ok: false, reason: "disabled_by_config" };
    }
    if (!persistence || persistence.ok !== true || !persistence.store || !persistence.journal) {
      return { ok: false, reason: "dependency_disabled:persistence" };
    }
    if (!clock || typeof clock.now !== "function") {
      return { ok: false, reason: "EVENT_REWARDS_START_FAILED", detail: "clock" };
    }
    const P = config.eventRewards;
    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    const getAdapter = typeof deps.getAdapter === "function" ? deps.getAdapter : () => null;
    const service = createEventRewardService({ config, store: persistence.store, journal: persistence.journal,
      telemetry: deps.telemetry || null, logger, getEvents: deps.getEvents, getSites: deps.getSites,
      getGovernor: deps.getGovernor, nowMs: deps.nowMs,
      getWrecks: () => {
        const adapter = getAdapter();
        return adapter && typeof adapter.getNativeWrecks === "function" ? adapter.getNativeWrecks() : null;
      } });
    const poller = createPoller({
      runPass: () => service.runPass(clock.now()),
      intervalMs: P.pumpIntervalMs,
      now: () => clock.now(),
      setTimer: deps.setTimer,
      onError: (err) => logger.log(`eventRewards: pump pass threw - ${messageOf(err)}`),
    });
    const started = poller.start();
    if (!started || !started.ok) {
      service.stop();
      return { ok: false, reason: "EVENT_REWARDS_START_FAILED", detail: `poller ${(started && started.reason)
        || "no result"}` };
    }
    logger.log(`eventRewards: running interval=${P.pumpIntervalMs} maxCachesPerDay=${P.maxCachesPerDay}`
      + ` maxCachesPerSystemPerDay=${P.maxCachesPerSystemPerDay}`);
    let stopped = false;
    const facade = {
      runPass: service.runPass,
      getStatus: () => Object.freeze({ ...service.getStatus(), state: stopped ? "stopped" : "running" }),
      stop() {
        if (stopped) return;
        stopped = true;
        poller.stop();
        service.stop();
      },
    };
    return { ok: true, eventRewards: Object.freeze(facade) };
  } catch (err) {
    return { ok: false, reason: "EVENT_REWARDS_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startEventRewards, unavailableEventRewards };
