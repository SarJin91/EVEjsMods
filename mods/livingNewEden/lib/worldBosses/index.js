"use strict";

const { isModuleEnabled } = require("../../config");
const { createPoller } = require("../presence/poller");
const { GROUPS: STRENGTH_GROUPS } = require("../battle/data/strengthCatalog");
const { expandStrengthGroups } = require("../battle/strength");
const { capitalPowerOverlayOf } = require("../battle/data/capitalStrengthRows");
const { buildPowerTable } = require("../strategy/ai/strength");
const S = require("./schema");
const { CATALOG_V1, validateCatalog } = require("./catalog");
const { createWorldBossRepository } = require("./repository");
const { createWorldBossService, COUNTER_NAMES, MODE } = require("./service");
const VIEW = require("./view");
const { bossStepKind } = require("./gmStep");

const WORLD_BOSSES_METHODS = Object.freeze(["getStatus", "spawnInTx", "getByOriginInTx", "listOpenInTx",
  "addEndListener", "bossTargetsOf", "battleConsequence", "runPass", "stop"]);

const BATTLE_CONSEQUENCE_STUB = Object.freeze({ name: "worldBosses",
  apply: () => ({ ok: true, skipped: "NOT_READY" }) });

const messageOf = (err) => String((err && err.message) || err);

function call(fn) {
  try {
    fn();
  } catch (_err) {
  }
}

function createUnavailableWorldBosses(reason, detail) {
  const why = String(reason || "WORLD_BOSSES_UNAVAILABLE");
  const status = Object.freeze({ state: "unavailable", reason: why, ...(detail ? { detail: String(detail) } : {}) });
  const refusal = Object.freeze({ ok: false, reason: why === "WORLD_BOSSES_UNAVAILABLE" ? why
    : "WORLD_BOSSES_DISABLED" });
  return Object.freeze({ getStatus: () => status, spawnInTx: () => refusal, getByOriginInTx: () => refusal,
    listOpenInTx: () => refusal, addEndListener: () => refusal, bossTargetsOf: () => refusal,
    battleConsequence: BATTLE_CONSEQUENCE_STUB, runPass: () => refusal, stop() {} });
}

function registerViews(deps, service, repo, P, logger) {
  const views = deps.views;
  if (!views || typeof views.registerView !== "function") return [];
  const getGraph = typeof deps.getGraph === "function" ? deps.getGraph : () => null;
  const systemNameOf = (id) => {
    const g = getGraph();
    const sys = g && typeof g.getSystem === "function" ? g.getSystem(id) : null;
    return sys && typeof sys.name === "string" ? sys.name : null;
  };
  const base = { store: deps.persistence.store, repo, viewOf: (row) => service.viewOf(row), clock: deps.clock,
    getGovernor: deps.getGovernor, settings: { passIntervalMs: P.passIntervalMs } };
  const defs = [[VIEW.VIEW_ID, () => VIEW.buildWorldBossesPanel({ ...base, getStatus: () => service.getStatus(),
    systemNameOf })]];
  if (deps.config.observer && deps.config.observer.galaxyEnabled === true) {
    defs.push([VIEW.LAYER_ID, () => VIEW.buildWorldBossesLayer(base)]);
  }
  const out = [];
  for (const [id, build] of defs) {
    try {
      const r = views.registerView(id, build());
      if (r && r.ok === true && typeof r.unregister === "function") out.push(() => r.unregister());
      else logger.log(`worldBosses: view ${id} not registered - ${(r && r.reason) || "no result"}`);
    } catch (err) {
      logger.log(`worldBosses: view ${id} not registered - ${messageOf(err)}`);
    }
  }
  return out;
}

function registerGm(deps, service, repo, P) {
  const reg = deps.gmSteps;
  const undo = [];
  if (!reg || typeof reg.register !== "function") {
    service.count("gmAbsent");
    return { undo, line: "absent" };
  }
  let step = null;
  try {
    step = reg.register(bossStepKind({ repo, settings: P, getGraph: deps.getGraph, isRunning: () => service.isFull() }));
  } catch (err) {
    step = { ok: false, reason: messageOf(err) };
  }
  if (step && step.ok === true && typeof step.unregister === "function") {
    undo.push(() => step.unregister());
    service.count("gmRegistered");
  } else service.count("gmRefused");
  let hint = null;
  if (typeof reg.registerHintSource === "function") {
    try {
      hint = reg.registerHintSource({ key: S.HINT_KEY, read: () => service.hintRead() });
    } catch (err) {
      hint = { ok: false, reason: messageOf(err) };
    }
  }
  if (hint && hint.ok === true && typeof hint.unregister === "function") undo.push(() => hint.unregister());
  else service.count("hintRefused");
  const stepLine = step && step.ok === true ? "on" : `refused:${(step && step.reason) || "no result"}`;
  const hintLine = hint && hint.ok === true ? "on" : `refused:${(hint && hint.reason) || "no result"}`;
  return { undo, line: `${stepLine} hint=${hintLine}` };
}

function startWorldBosses(deps) {
  try {
    const { config, persistence, clock } = deps || {};
    const W = config && config.worldBosses;
    if (!W || !isModuleEnabled(config, "world")) return { ok: false, reason: "disabled_by_config" };
    const full = W.enabled === true;
    const store = persistence && persistence.ok === true && persistence.store ? persistence.store : null;
    const journal = persistence && persistence.journal ? persistence.journal : null;
    if (!store || !journal) {
      return full ? { ok: false, reason: "WORLD_BOSSES_START_FAILED", detail: "persistence" }
        : { ok: false, reason: "disabled_by_config" };
    }
    const repo = createWorldBossRepository({ journal });
    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    const log = (line) => call(() => logger.log(`worldBosses: ${line}`));
    if (!full) {
      const c = store.transaction("worldBosses.count", (tx) => repo.countOpenInTx(tx));
      if (!c.ok || !c.value || c.value.ok !== true || c.value.count === 0) {
        return { ok: false, reason: "disabled_by_config" };
      }
      log(`drain mode - ${c.value.count} open bosses to cancel`);
    }
    if (!clock || typeof clock.now !== "function") {
      return { ok: false, reason: "WORLD_BOSSES_START_FAILED", detail: "clock" };
    }
    const parsed = S.settingsOf(config, { defaultExcludedRegionIds: deps.excludedRegionIds,
      routeMaxJumps: config.graph && config.graph.routeMaxJumps,
      battleMaxFleetsPerSide: config.battle && config.battle.maxFleetsPerSide });
    if (!parsed.ok) {
      return { ok: false, reason: "WORLD_BOSSES_START_FAILED", detail: `${parsed.reason}:${parsed.detail}` };
    }
    const P = parsed.settings;
    const worldSeed = Number.isSafeInteger(persistence.worldSeed) ? persistence.worldSeed
      : (typeof store.getWorldSeed === "function" ? store.getWorldSeed() : undefined);
    if (full && !Number.isSafeInteger(worldSeed)) {
      return { ok: false, reason: "WORLD_BOSSES_START_FAILED", detail: "worldSeed" };
    }
    const bootAt = Number.isSafeInteger(deps.bootAt) ? deps.bootAt : clock.now();
    const catalog = validateCatalog(CATALOG_V1);
    for (const d of catalog.disabled) {
      if (P.kinds.includes(d.kind)) log(`kind ${d.kind} off - ${d.reason}`);
    }
    const service = createWorldBossService({ store, journal, repo, worldSeed: Number.isSafeInteger(worldSeed)
      ? worldSeed : 0, settings: P, kinds: catalog.kinds, disabledKinds: catalog.disabled,
    mode: full ? MODE.FULL : MODE.DRAIN, getGraph: deps.getGraph, getPresence: deps.getPresence,
    getOccupation: deps.getOccupation, getSites: deps.getSites, getWorldRepository: deps.getWorldRepository,
    getGovernor: deps.getGovernor, telemetry: deps.telemetry || null, log, nowMs: deps.nowMs,
    getBattle: deps.getBattle, getFleetRepository: deps.getFleetRepository, isHostile: deps.isHostile,
    powerTable: P.clash.enabled ? buildPowerTable(expandStrengthGroups(STRENGTH_GROUPS, null,
      capitalPowerOverlayOf(config.strategy))) : null,
    getScene: deps.getScene, getNotices: deps.getNotices, bootAt,
    getWrecks: deps.getWrecks, rewardCreditIsk: deps.rewardCreditIsk });
    const poller = createPoller({ runPass: () => {
      service.runPass(clock.now());
      if (service.isStopped()) poller.stop();
    }, intervalMs: P.passIntervalMs,
      now: () => clock.now(), setTimer: deps.setTimer, onError: (err) => log(`pass threw - ${messageOf(err)}`) });
    const started = poller.start();
    if (!started.ok) {
      service.stop();
      return { ok: false, reason: "WORLD_BOSSES_START_FAILED", detail: `poller ${started.reason}` };
    }
    const recovered = full ? service.liveRecover(clock.now()) : 0;
    let livePoller = null;
    if (full && P.live.enabled) {
      livePoller = createPoller({ runPass: () => service.livePass(clock.now()), intervalMs: P.live.pumpIntervalMs,
        now: () => clock.now(), setTimer: deps.setTimer, onError: (err) => log(`live pass threw - ${messageOf(err)}`),
        pacing: false });
      const liveStarted = livePoller.start();
      if (!liveStarted.ok) {
        call(() => poller.stop());
        service.stop();
        return { ok: false, reason: "WORLD_BOSSES_START_FAILED", detail: `live poller ${liveStarted.reason}` };
      }
    }
    const unregisterViews = full ? registerViews(deps, service, repo, P, logger) : [];
    const gm = full && P.gm.enabled ? registerGm(deps, service, repo, P) : null;
    if (gm) unregisterViews.push(...gm.undo);
    if (full) {
      log(`running kinds=${service.getStatus().kinds.join(",") || "none"} maxActive=${P.maxActive}`
        + ` roll=${P.rollEnabled ? "on" : "off"} disabledKinds=${catalog.disabled.length}`
        + `${P.live.enabled ? ` live=on maxShips=${P.live.maxShipsPerPhase}` : ""}`
        + `${P.rewards.enabled ? " rewards=on" : ""}${gm ? ` gm=${gm.line}` : ""}`
        + `${recovered > 0 ? ` liveRecovered=${recovered}` : ""}`);
    }
    const facade = {
      getStatus: () => service.getStatus(),
      spawnInTx: (tx, spec, key) => service.spawnInTx(tx, spec, key),
      getByOriginInTx: (tx, originKind, originRef) => service.getByOriginInTx(tx, originKind, originRef),
      listOpenInTx: (tx) => service.listOpenInTx(tx),
      addEndListener: (fn) => service.addEndListener(fn),
      bossTargetsOf: (tx, reachSystemIds, max) => service.bossTargetsOf(tx, reachSystemIds, max),
      battleConsequence: service.consequence,
      runPass: (now) => service.runPass(Number.isSafeInteger(now) ? now : clock.now()),
      stop() {
        for (const unregister of unregisterViews) call(unregister);
        unregisterViews.length = 0;
        call(() => poller.stop());
        if (livePoller) call(() => livePoller.stop());
        service.stop();
      },
    };
    return { ok: true, worldBosses: Object.freeze(facade) };
  } catch (err) {
    return { ok: false, reason: "WORLD_BOSSES_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startWorldBosses, createUnavailableWorldBosses, WORLD_BOSSES_METHODS, COUNTER_NAMES };
