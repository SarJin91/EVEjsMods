"use strict";

const { isModuleEnabled } = require("../../config");
const { createPoller } = require("../presence/poller");
const killObservation = require("../adapter/killObservation");
const { seasonsSettingsOf, EVENT_STEP, EVENT_SCORE } = require("./schema");
const { createCrisisRegistry, registerBuiltin } = require("./registry");
const { createSeasonService } = require("./service");
const { createSeasonRepository } = require("./repository");
const { createSeasonRewardPump, REWARD_METHODS } = require("./rewards");
const { createInvasionSurge } = require("./crises/invasionSurge");
const { createPirateSurge } = require("./crises/pirateSurge");
const { createSeasonChat, installSeasonCommand } = require("./command");
const { buildSeasonLayer, buildSeasonPanel, VIEW_ID, LAYER_ID } = require("./view");
const { hintOf } = require("./hint");

const SEASONS_METHODS = Object.freeze(["current", "currentSeasonKey", "getStatus", "onNpcKill", "scoreOf", "stop"]);
const SCHEDULER_READY = "ready";
const CLOSE_TX_FIXED_ROWS = 16;

const messageOf = (err) => String((err && err.message) || err);

function call(fn) {
  try {
    fn();
  } catch (_err) {
  }
}

function createUnavailableSeasons(reason, detail) {
  const why = String(reason || "SEASONS_UNAVAILABLE");
  const status = Object.freeze({ state: "unavailable", reason: why, ...(detail ? { detail: String(detail) } : {}) });
  const refusal = Object.freeze({ ok: false, reason: why });
  return Object.freeze({ current: () => refusal, currentSeasonKey: () => null, getStatus: () => status,
    onNpcKill: () => Object.freeze({ ok: false, reason: "NO_SEASON" }),
    scoreOf: () => Object.freeze({ ok: false, reason: why === "SEASONS_DISABLED" ? "SEASONS_DISABLED" : "READ_FAILED" }),
    stop() {} });
}

function namesOf(adapter, getGraph) {
  let factions = null;
  return Object.freeze({
    factionName: (id) => {
      if (factions === null) {
        factions = new Map();
        try {
          const r = adapter && typeof adapter.readFactionNames === "function" ? adapter.readFactionNames() : null;
          if (r && r.ok === true && r.names instanceof Map) factions = r.names;
        } catch (_err) {
        }
      }
      return factions.get(id) || null;
    },
    regionName: (id) => {
      try {
        const g = typeof getGraph === "function" ? getGraph() : null;
        return g && typeof g.getRegionName === "function" ? g.getRegionName(id) : null;
      } catch (_err) {
        return null;
      }
    },
  });
}

function mountPlayerParts(deps, S, service, logger) {
  const undo = [];
  const parts = [];
  const log = (line) => logger.log(`seasons: ${line}`);
  const config = deps.config;
  const names = namesOf(deps.adapter || null, deps.getGraph);
  const current = () => service.current();
  if (S.commandEnabled) {
    const fc = config.frontChat || {};
    const chat = createSeasonChat({ seasons: { current, scoreOf: (id) => service.scoreOf(id) }, clock: deps.clock,
      settings: { language: config.chatterAi && config.chatterAi.language, maxReplyChars: fc.maxReplyChars,
        lineBreak: fc.lineBreak }, names, isRunning: () => !service.isStopped(), bump: service.bump, log });
    const installed = installSeasonCommand(deps.adapter || null, chat);
    if (installed.ok) undo.push(installed.uninstall);
    else log(`!season not installed - ${installed.reason}${installed.detail ? `:${installed.detail}` : ""}`);
    parts.push(`command=${installed.ok ? "on" : "off"}`);
  }
  const views = deps.views;
  if (S.viewEnabled && views && typeof views.registerView === "function") {
    const common = { seasons: { current }, clock: deps.clock, getGovernor: deps.getGovernor, names,
      settings: { bucketMs: S.scoreIntervalMs } };
    const adapter = deps.adapter || null;
    const defs = [[VIEW_ID, () => buildSeasonPanel({ ...common, store: deps.persistence.store,
      repo: createSeasonRepository(), getStatus: () => service.getStatus(),
      characterNames: (ids) => {
        const r = adapter && typeof adapter.readCharacterNames === "function" ? adapter.readCharacterNames(ids) : null;
        return r && r.ok === true ? r.names : null;
      } })]];
    if (config.observer && config.observer.galaxyEnabled === true) {
      defs.push([LAYER_ID, () => buildSeasonLayer({ ...common, getGraph: deps.getGraph })]);
    }
    let registered = 0;
    for (const [id, build] of defs) {
      try {
        const r = views.registerView(id, build());
        if (r && r.ok === true && typeof r.unregister === "function") {
          undo.push(() => r.unregister());
          registered += 1;
        } else log(`view ${id} not registered - ${(r && r.reason) || "no result"}`);
      } catch (err) {
        log(`view ${id} not registered - ${messageOf(err)}`);
      }
    }
    parts.push(`views=${registered}`);
  }
  const gm = deps.hintRegistry;
  if (S.hintEnabled && gm && typeof gm.registerHintSource === "function") {
    let reg = null;
    try {
      reg = gm.registerHintSource({ key: "seasons", read: () => hintOf(service.current().season, names,
        deps.clock.now()) });
    } catch (err) {
      reg = { ok: false, reason: messageOf(err) };
    }
    if (reg && reg.ok === true && typeof reg.unregister === "function") undo.push(() => reg.unregister());
    else service.bump("hintRefused");
    parts.push(`hint=${reg && reg.ok === true ? "on" : `refused:${(reg && reg.reason) || "no result"}`}`);
  }
  return { undo, parts: parts.join(" ") };
}

function rewardAdapterOf(adapter) {
  if (!adapter || typeof adapter !== "object") return null;
  const out = {};
  for (const name of REWARD_METHODS) {
    if (typeof adapter[name] !== "function") return null;
    out[name] = (...args) => adapter[name](...args);
  }
  return Object.freeze(out);
}

function startSeasons(deps) {
  try {
    const { config, persistence, clock, scheduler } = deps || {};
    const logger = deps && deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    const C = config && config.seasons;
    if (!C || C.enabled !== true || !isModuleEnabled(config, "world")) return { ok: false, reason: "disabled_by_config" };
    if (!persistence || persistence.ok !== true || !persistence.store || !persistence.journal) {
      return { ok: false, reason: "dependency_disabled:persistence" };
    }
    let schedulerState = null;
    try {
      schedulerState = scheduler && typeof scheduler.getStatus === "function" ? scheduler.getStatus().state : null;
    } catch (_err) {
      schedulerState = null;
    }
    if (!scheduler || typeof scheduler.registerHandler !== "function" || typeof scheduler.enqueue !== "function"
      || schedulerState !== SCHEDULER_READY) {
      return { ok: false, reason: "SCHEDULER_UNAVAILABLE" };
    }
    if (!clock || typeof clock.now !== "function") return { ok: false, reason: "INIT_FAILED", detail: "clock" };
    const parsed = seasonsSettingsOf(config);
    if (!parsed.ok) return { ok: false, reason: "INIT_FAILED", detail: `${parsed.reason}:${parsed.detail}` };
    const S = parsed.settings;
    const maxRows = persistence.store.limits && persistence.store.limits.maxRowsPerTransaction;
    const closeRows = S.maxRankedPlayers + S.flushMaxRows + S.payoutBatch + CLOSE_TX_FIXED_ROWS;
    if (Number.isSafeInteger(maxRows) && closeRows > maxRows) {
      return { ok: false, reason: "TX_BUDGET", detail: `seasons.maxRankedPlayers + flushMaxRows + payoutBatch + `
        + `${CLOSE_TX_FIXED_ROWS} = ${closeRows} > persistence.maxRowsPerTransaction=${maxRows}` };
    }
    const worldSeed = Number.isSafeInteger(persistence.worldSeed) ? persistence.worldSeed
      : (typeof persistence.store.getWorldSeed === "function" ? persistence.store.getWorldSeed() : undefined);
    if (!Number.isSafeInteger(worldSeed)) return { ok: false, reason: "INIT_FAILED", detail: "worldSeed" };
    const registry = deps.registry && typeof deps.registry.get === "function" ? deps.registry
      : createCrisisRegistry();
    const points = { invasionSpawnPoints: S.invasionSpawnPoints, invasionRepelPoints: S.invasionRepelPoints,
      battlePoints: S.battlePoints };
    const regionOf = typeof deps.regionOf === "function" ? deps.regionOf : () => null;
    const builtins = [
      createInvasionSurge({ points, invaderFactionIds: Array.isArray(deps.invaderFactionIds) ? deps.invaderFactionIds
        : [] }),
      createPirateSurge({ points, maxCrisisRegions: S.maxCrisisRegions,
        factionKindOf: typeof deps.factionKindOf === "function" ? deps.factionKindOf : null, regionOf }),
    ];
    const unregisters = [];
    for (const kind of builtins) {
      const r = registerBuiltin(registry, kind);
      if (!r.ok) {
        for (const u of unregisters) call(u);
        return { ok: false, reason: "INIT_FAILED", detail: `builtin ${kind.kind} ${r.reason}` };
      }
      unregisters.push(() => r.unregister());
    }
    let pump = null;
    const service = createSeasonService({ store: persistence.store, journal: persistence.journal, scheduler,
      worldSeed, settings: S, registry, regionOf, telemetry: deps.telemetry || null, clock, nowMs: deps.nowMs,
      onRewardsPlanned: (n) => {
        if (pump) pump.notePlanned(n);
      } });
    const rewardAdapter = rewardAdapterOf(deps.adapter);
    if (rewardAdapter) {
      pump = createSeasonRewardPump({ store: persistence.store, repo: createSeasonRepository(), settings: S,
        adapter: rewardAdapter, bump: service.bump, log: (line) => logger.log(`seasons: ${line}`),
        isStopped: service.isStopped });
    }
    const handles = [];
    let payPoller = null;
    let killListener = null;
    const stopAll = () => {
      if (killListener && killObservation.getSeasons() === killListener) killObservation.setSeasons(null);
      if (payPoller) payPoller.stop();
      for (const h of handles.splice(0)) call(() => h.unregister());
      for (const u of unregisters.splice(0)) call(u);
      service.stop();
    };
    for (const [type, fn] of [[EVENT_STEP, service.onStep], [EVENT_SCORE, service.onScore]]) {
      let reg;
      try {
        reg = scheduler.registerHandler(type, fn, { maxPerPass: 1 });
      } catch (err) {
        reg = { ok: false, reason: messageOf(err) };
      }
      if (!reg || reg.ok !== true) {
        stopAll();
        return { ok: false, reason: "INIT_FAILED", detail: `handler ${type}: ${(reg && reg.reason) || "no result"}` };
      }
      handles.push(reg);
    }
    const boot = service.bootstrap();
    if (!boot.ok) logger.log(`seasons: bootstrap failed ${boot.reason}; the next start retries`);
    if (pump) {
      const counted = pump.boot();
      if (!counted.ok) logger.log(`seasons: reward count failed ${counted.reason}; the first reward pass recounts`);
      let payInFlight = false;
      payPoller = createPoller({
        runPass: () => {
          if (payInFlight) return;
          payInFlight = true;
          pump.runPass(clock.now()).then(() => { payInFlight = false; }, (err) => {
            payInFlight = false;
            logger.log(`seasons: reward pass threw - ${messageOf(err)}`);
          });
        },
        intervalMs: S.payoutPassMs, now: () => clock.now(), setTimer: deps.setTimer,
        onError: (err) => logger.log(`seasons: reward pass threw - ${messageOf(err)}`),
      });
      const started = payPoller.start();
      if (!started.ok) {
        payPoller = null;
        stopAll();
        return { ok: false, reason: "INIT_FAILED", detail: `reward poller ${started.reason}` };
      }
    }
    const kills = killObservation.killWrapMounted() === true ? "on" : "no_wrap";
    killListener = kills === "on" ? Object.freeze({ onNpcKill: (k) => service.onNpcKill(k) }) : null;
    if (killListener) killObservation.setSeasons(killListener);
    const player = mountPlayerParts(deps, S, service, logger);
    unregisters.push(...player.undo);
    const season = service.current().season;
    logger.log(`seasons: running kinds=${registry.list().map((k) => k.kind).join(",")} resetMode=${S.resetMode}`
      + ` season=${season ? `${season.seasonNo}:${season.state}` : "none"} kills=${kills}`
      + ` rewards=${pump ? `on pending=${pump.status().pending}` : "no_adapter"}${player.parts ? ` ${player.parts}` : ""}`);
    let stopped = false;
    const facade = {
      current: () => service.current(),
      currentSeasonKey: () => service.currentSeasonKey(),
      getStatus: () => {
        const p = pump ? pump.status() : null;
        return Object.freeze({ ...service.getStatus(), kills, pendingKills: service.pendingKills(),
          rewardsPending: p ? p.pending : null, rewardsLastRefusal: p ? p.lastRefusal : null });
      },
      onNpcKill: (k) => service.onNpcKill(k),
      scoreOf: (characterId) => service.scoreOf(characterId),
      stop() {
        if (stopped) return;
        stopped = true;
        stopAll();
      },
    };
    return { ok: true, seasons: Object.freeze(facade) };
  } catch (err) {
    return { ok: false, reason: "INIT_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startSeasons, createUnavailableSeasons, SEASONS_METHODS };
