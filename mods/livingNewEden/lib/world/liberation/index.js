"use strict";

const { isModuleEnabled } = require("../../../config");
const killObservation = require("../../adapter/killObservation");
const { createLiberationService } = require("./liberationService");
const { VIEW_ID, buildLiberationView } = require("./liberationView");
const { EVENT_TYPE } = require("./schema");
const { createRewardRepository } = require("./rewardRepository");
const { createPayoutPump } = require("./payoutPump");
const { createPoller } = require("../../presence/poller");

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

function readFactionNames(adapter) {
  if (!adapter || typeof adapter.readFactionNames !== "function") return new Map();
  try {
    const r = adapter.readFactionNames();
    return r && r.ok && r.names instanceof Map ? r.names : new Map();
  } catch (_err) {
    return new Map();
  }
}

function createUnavailableLiberation(reason, detail) {
  const refusal = Object.freeze({ ok: false, reason: String(reason), ...(detail ? { detail: String(detail) } : {}) });
  const status = Object.freeze({ state: STATE_UNAVAILABLE, reason: refusal.reason });
  const refuse = () => refusal;
  return Object.freeze({ onNpcKill: refuse, count() {}, getStatus: () => status, stop() {} });
}

function startLiberation(deps) {
  try {
    const { config, persistence, clock, scheduler } = deps || {};
    if (!isModuleEnabled(config, "world") || !config.occupation || config.occupation.enabled !== true
      || !config.liberation || config.liberation.enabled !== true) {
      return { ok: false, reason: "disabled_by_config" };
    }
    if (!persistence || persistence.ok !== true || !persistence.store) {
      return { ok: false, reason: "dependency_disabled:persistence" };
    }
    const world = deps.world;
    if (!world || !world.repository) return { ok: false, reason: "WORLD_UNAVAILABLE" };
    if (!scheduler || typeof scheduler.registerHandler !== "function") {
      return { ok: false, reason: "SCHEDULER_UNAVAILABLE" };
    }
    const occupation = deps.occupation;
    if (!occupation || typeof occupation.abandonInTx !== "function"
      || typeof occupation.dropInfluenceInTx !== "function" || typeof occupation.effectiveScoreOf !== "function") {
      return { ok: false, reason: "OCCUPATION_UNAVAILABLE" };
    }
    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    if (config.liberation.rewardsEnabled === true && !persistence.journal) {
      logger.log("liberation: rewards off - no journal (contribution and payout plan need journal.applyOnce)");
    }
    let service;
    try {
      service = createLiberationService({ store: persistence.store, repository: world.repository, scheduler,
        occupation, clock, config, telemetry: deps.telemetry || null, logger, nowMs: deps.nowMs,
        journal: persistence.journal || null, graph: deps.graph || null });
    } catch (err) {
      return { ok: false, reason: "LIBERATION_START_FAILED", detail: messageOf(err) };
    }

    let registration;
    try {
      registration = scheduler.registerHandler(EVENT_TYPE, service.handler,
        { maxPerPass: config.liberation.maxChecksPerPass });
    } catch (err) {
      registration = { ok: false, reason: messageOf(err) };
    }
    if (!registration || !registration.ok) {
      return { ok: false, reason: "LIBERATION_START_FAILED",
        detail: `handler ${EVENT_TYPE}: ${(registration && registration.reason) || "no result"}` };
    }
    killObservation.setLiberation(service);

    let viewHandle = null;
    const views = deps.views;
    if (views && typeof views.registerView === "function") {
      const r = views.registerView(VIEW_ID, buildLiberationView({ store: persistence.store,
        repository: world.repository, getStatus: service.getStatus, graph: deps.graph || null,
        maxRows: config.observer.occupationPanelMaxRows, getGovernor: deps.getGovernor,
        factionNames: readFactionNames(deps.adapter) }));
      if (r && r.ok) viewHandle = r;
      else logger.log(`liberation: view ${VIEW_ID} not registered - ${(r && r.reason) || "no result"}`);
    }

    const lb = config.liberation;
    let pump = null;
    let poller = null;
    let inFlight = null;
    let pumpState = "idle";
    if (lb.rewardsEnabled === true) {
      try {
        pump = createPayoutPump({ store: persistence.store, repo: createRewardRepository(), adapter: deps.adapter || null,
          params: { payoutEnabled: lb.payoutEnabled === true, payoutMaxPerPass: lb.payoutMaxPerPass,
            payoutMaxAttempts: lb.payoutMaxAttempts, payoutRetryBaseMs: lb.payoutRetryBaseMs,
            payoutRetryMaxMs: lb.payoutRetryMaxMs, payoutRetentionMs: lb.payoutRetentionMs,
            rewardPrunePerPass: lb.rewardPrunePerPass, rewardContributionWindowMs: lb.rewardContributionWindowMs },
          getGovernor: deps.getGovernor, count: service.count, log: (l) => logger.log(l),
          isStopped: service.isStopped });
        const tick = () => {
          if (inFlight !== null) return;
          inFlight = pump.runPass(clock.now()).catch(() => null).then(() => {
            inFlight = null;
          });
        };
        poller = createPoller({ runPass: tick, intervalMs: lb.payoutPollMs, now: () => clock.now(),
          setTimer: deps.setTimer, onError: (err) => logger.log(`liberation: payout pass failed - ${messageOf(err)}`) });
        const armed = poller.start();
        if (!armed.ok) logger.log(`liberation: payout timer not started - ${armed.reason}`);
        else pumpState = "running";
        if (lb.payoutEnabled === true) {
          const seams = deps.adapter && typeof deps.adapter.rewardSeams === "function" ? deps.adapter.rewardSeams()
            : { ok: false, missing: ["adapter.rewardSeams"] };
          if (seams && seams.ok === true) logger.log("liberation: payout on (ISK + LP)");
          else logger.log(`liberation: payout seams missing - ${((seams && seams.missing) || []).join(", ")}`
            + " (rows wait PENDING)");
        }
      } catch (err) {
        logger.log(`liberation: payout pump not started - ${messageOf(err)}`);
      }
    }
    const pumpStatus = () => {
      if (!pump) return { pump: pumpState };
      const st = pump.getStatus();
      const state = pumpState === "running" && lb.payoutEnabled === true && st.seamsMissing ? "seams_missing"
        : pumpState;
      return { pump: state, payoutEnabled: lb.payoutEnabled === true, pumpPasses: st.passes,
        pumpLastRefusal: st.lastRefusal };
    };

    const facade = Object.freeze({
      onNpcKill: service.onNpcKill,
      count: service.count,
      params: service.params,
      getStatus: () => Object.freeze({ ...service.getStatus(), view: viewHandle !== null, ...pumpStatus() }),
      runPayoutPass: (now) => (pump ? pump.runPass(Number.isSafeInteger(now) ? now : clock.now())
        : Promise.resolve({ outcome: "OFF" })),
      stop() {
        if (service.isStopped()) return;
        service.stop();
        if (poller) {
          swallow(() => poller.stop());
          pumpState = "stopped";
        }
        swallow(() => killObservation.setLiberation(null));
        swallow(() => registration.unregister());
        if (viewHandle) {
          const handle = viewHandle;
          viewHandle = null;
          swallow(() => handle.unregister());
        }
      },
    });
    return { ok: true, liberation: facade };
  } catch (err) {
    return { ok: false, reason: "LIBERATION_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startLiberation, createUnavailableLiberation };

