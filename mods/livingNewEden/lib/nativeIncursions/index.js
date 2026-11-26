"use strict";

const { isModuleEnabled } = require("../../config");
const { createPoller } = require("../presence/poller");
const { createNativeIncursionRepository } = require("./repository");
const { createNativeIncursionService, COUNTER_NAMES } = require("./service");
const { parseClaimStates, STEER_MODES, MAX_TALE_SYSTEMS, VIEW_ID, LAYER_ID, rewardRowsBound } = require("./schema");
const { MAX_REWARD_LIST } = require("./repository");
const MAX_REWARD_PARTICIPANTS = 256;
const MAX_RECEIPTS = 512;
const { settleRowsBound } = require("./consequence");
const VIEW = require("./view");

const NATIVE_INCURSIONS_METHODS = Object.freeze(["getStatus", "runPass", "stop"]);
const ADAPTER_METHODS = Object.freeze(["nativeIncursionsSetTargets", "nativeIncursionsListTales",
  "nativeIncursionsBossParticipants", "nativeIncursionsVendorBands", "nativeIncursionsStats"]);
const REWARD_ADAPTER_METHOD = "nativeIncursionsParticipants";

const messageOf = (err) => String((err && err.message) || err);

function quiet(fn) {
  try {
    fn();
  } catch (_err) {
  }
}

function registerViews(deps, service, repo, S, logger) {
  const views = deps.views;
  if (S.observerEnabled !== true || !views || typeof views.registerView !== "function") return [];
  const getGraph = typeof deps.getGraph === "function" ? deps.getGraph : () => null;
  const systemNameOf = (id) => {
    const g = getGraph();
    const sys = g && typeof g.getSystem === "function" ? g.getSystem(id) : null;
    return sys && typeof sys.name === "string" ? sys.name : null;
  };
  const base = { store: deps.persistence.store, repo, clock: deps.clock, getGovernor: deps.getGovernor,
    settings: { passIntervalMs: S.passIntervalMs, settledRows: S.observerSettledRows } };
  const defs = [[VIEW_ID, () => VIEW.buildNativeIncursionsPanel({ ...base, getStatus: () => service.getStatus(),
    systemNameOf })]];
  if (deps.config.observer && deps.config.observer.galaxyEnabled === true) {
    defs.push([LAYER_ID, () => VIEW.buildNativeIncursionsLayer(base)]);
  }
  const out = [];
  for (const [id, build] of defs) {
    try {
      const r = views.registerView(id, build());
      if (r && r.ok === true && typeof r.unregister === "function") out.push(() => r.unregister());
      else logger.log(`nativeIncursions: view ${id} not registered - ${(r && r.reason) || "no result"}`);
    } catch (err) {
      logger.log(`nativeIncursions: view ${id} not registered - ${messageOf(err)}`);
    }
  }
  return out;
}

function createUnavailableNativeIncursions(reason, detail) {
  const refusal = Object.freeze({ ok: false, reason: String(reason), ...(detail ? { detail: String(detail) } : {}) });
  const status = Object.freeze({ state: "unavailable", reason: String(reason),
    ...(detail ? { detail: String(detail) } : {}) });
  return Object.freeze({ getStatus: () => status, runPass: () => refusal, stop() {} });
}

function settingsOf(P) {
  if (!P || typeof P !== "object" || !P.steer || !P.settle) return { ok: false, key: "nativeIncursions" };
  const claimStates = parseClaimStates(P.claimStates);
  if (claimStates === null) return { ok: false, key: "claimStates" };
  if (!STEER_MODES.includes(P.steer.mode)) return { ok: false, key: "steer.mode" };
  const ints = { "steer.maxTargets": P.steer.maxTargets, "steer.logSize": P.steer.logSize,
    maxActiveBindings: P.maxActiveBindings, passIntervalMs: P.passIntervalMs, maxTalesPerPass: P.maxTalesPerPass,
    maxSettlementsPerPass: P.maxSettlementsPerPass, settleMaxAttempts: P.settleMaxAttempts,
    vanishGraceMs: P.vanishGraceMs, lookbackMs: P.lookbackMs,
    observerSettledRows: P.observerSettledRows };
  for (const [key, v] of Object.entries(ints)) if (!Number.isSafeInteger(v) || v < 0) return { ok: false, key };
  for (const key of ["defeatInfluencePoints", "expireInfluencePoints"]) {
    if (!Number.isFinite(P[key]) || P[key] < 0) return { ok: false, key };
  }
  const R = P.rewards && typeof P.rewards === "object" ? P.rewards : { enabled: false };
  if (R.enabled === true) {
    const bounds = { "rewards.loyaltyPoints": [R.loyaltyPoints, 0, 1000000],
      "rewards.maxRewardedParticipants": [R.maxRewardedParticipants, 1, MAX_REWARD_PARTICIPANTS],
      "rewards.maxReceipts": [R.maxReceipts, 1, MAX_RECEIPTS],
      "rewards.maxPerPass": [R.maxPerPass, 1, MAX_REWARD_LIST] };
    for (const [key, [v, min, max]] of Object.entries(bounds)) {
      if (!Number.isSafeInteger(v) || v < min || v > max) return { ok: false, key };
    }
  }
  return { ok: true, settings: Object.freeze({ ...P, claimStates, newsEnabled: P.newsEnabled === true,
    observerEnabled: P.observerEnabled === true, noticesEnabled: P.noticesEnabled === true,
    steer: Object.freeze({ ...P.steer, enabled: P.steer.enabled === true }),
    settle: Object.freeze({ ...P.settle, enabled: P.settle.enabled === true }),
    rewards: Object.freeze({ ...R, enabled: R.enabled === true }) }) };
}

function rewardsModeOf(S, limits) {
  const R = S.rewards;
  if (!R.enabled || !(R.loyaltyPoints > 0) || !S.settle.enabled) return { mode: "off", bound: 0, maxRows: null };
  const bound = rewardRowsBound(R.maxRewardedParticipants);
  const maxRows = limits && Number.isSafeInteger(limits.maxRowsPerTransaction) ? limits.maxRowsPerTransaction : null;
  return { mode: maxRows !== null && bound > maxRows ? "ROW_BOUND" : "on", bound, maxRows };
}

function startNativeIncursions(deps) {
  try {
    const { config, persistence, clock, adapter } = deps || {};
    const P = config && config.nativeIncursions;
    if (!P || P.enabled !== true || !isModuleEnabled(config, "world")) return { ok: false, reason: "disabled_by_config" };
    if (!persistence || persistence.ok !== true || !persistence.store || !persistence.journal) {
      return { ok: false, reason: "dependency_disabled:persistence" };
    }
    if (!clock || typeof clock.now !== "function") {
      return { ok: false, reason: "NATIVE_INCURSIONS_START_FAILED", detail: "clock" };
    }
    const parsed = settingsOf(P);
    if (!parsed.ok) return { ok: false, reason: "NATIVE_INCURSIONS_START_FAILED", detail: `nativeIncursions.${parsed.key}` };
    const rewards = rewardsModeOf(parsed.settings, persistence.store.limits);
    const methods = rewards.mode === "on" ? [...ADAPTER_METHODS, REWARD_ADAPTER_METHOD] : ADAPTER_METHODS;
    const missing = methods.filter((m) => !adapter || typeof adapter[m] !== "function");
    if (missing.length > 0) return { ok: false, reason: "NATIVE_INCURSIONS_START_FAILED", detail: `adapter ${missing[0]}` };
    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    if (rewards.mode === "ROW_BOUND") {
      logger.log(`nativeIncursions: rewards off - ROW_BOUND ${rewards.bound} > persistence.maxRowsPerTransaction `
        + `${rewards.maxRows}`);
    }
    let consequences = "off";
    const p0 = parsed.settings;
    if (p0.settle.enabled && (p0.defeatInfluencePoints > 0 || p0.expireInfluencePoints > 0)) {
      const F = config.world && config.world.maxFactionsPerSystem;
      const bound = settleRowsBound(Number.isSafeInteger(F) && F > 0 ? F : 0, MAX_TALE_SYSTEMS);
      const limits = persistence.store.limits;
      const maxRows = limits && Number.isSafeInteger(limits.maxRowsPerTransaction) ? limits.maxRowsPerTransaction : null;
      consequences = maxRows !== null && bound > maxRows ? "ROW_BOUND" : "on";
      if (consequences === "ROW_BOUND") {
        logger.log(`nativeIncursions: consequences off - ROW_BOUND ${bound} > persistence.maxRowsPerTransaction ${maxRows}`);
      }
    }
    const S = Object.freeze({ ...p0, consequences, rewardsMode: rewards.mode });
    const repository = createNativeIncursionRepository();
    const service = createNativeIncursionService({ store: persistence.store, journal: persistence.journal,
      repository, adapter, settings: S, clock,
      getWorldRepository: typeof deps.getWorldRepository === "function" ? deps.getWorldRepository : () => null,
      getOccupation: typeof deps.getOccupation === "function" ? deps.getOccupation : () => null,
      getGovernor: deps.getGovernor, telemetry: deps.telemetry || null, logger, nowMs: deps.nowMs,
      getHeavyEvents: typeof deps.getHeavyEvents === "function" ? deps.getHeavyEvents : () => null });
    const poller = createPoller({
      runPass: () => service.runPass(clock.now()),
      intervalMs: S.passIntervalMs,
      now: () => clock.now(),
      setTimer: deps.setTimer,
      onError: (err) => logger.log(`nativeIncursions: pass threw - ${messageOf(err)}`),
    });
    const started = poller.start();
    if (!started.ok) {
      service.stop();
      return { ok: false, reason: "NATIVE_INCURSIONS_START_FAILED", detail: `poller ${started.reason}` };
    }
    logger.log(`nativeIncursions: running steer=${S.steer.enabled} mode=${S.steer.mode} settle=${S.settle.enabled}`
      + ` claimStates=${S.claimStates.join(",")} maxActiveBindings=${S.maxActiveBindings}`
      + ` consequences=${consequences}` + (rewards.mode === "off" ? "" : ` rewards=${rewards.mode}`));
    const unregisterViews = registerViews(deps, service, repository, S, logger);
    const facade = {
      getStatus: () => service.getStatus(),
      runPass: (now) => service.runPass(now),
      stop() {
        if (service.isStopped()) return;
        for (const unregister of unregisterViews) quiet(unregister);
        unregisterViews.length = 0;
        poller.stop();
        service.stop();
      },
    };
    return { ok: true, nativeIncursions: Object.freeze(facade) };
  } catch (err) {
    return { ok: false, reason: "NATIVE_INCURSIONS_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startNativeIncursions, createUnavailableNativeIncursions, settingsOf, rewardsModeOf, COUNTER_NAMES,
  NATIVE_INCURSIONS_METHODS };
