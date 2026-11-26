"use strict";

const { createMapChat, matchMapCommand, FAIL_REPLY } = require("./chat");
const { createTrafficTracker } = require("./trafficTracker");
const { createLossesCache } = require("./losses");
const { createMapWindow } = require("./window/service");

const COMMAND_NAME = "map";
const MAX_DETAIL = 120;
const COUNTER_NAMES = Object.freeze(["replies", "rateLimited", "refused", "errors"]);
const STATE = Object.freeze({ STARTING: "starting", RUNNING: "running", STOPPED: "stopped" });

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function startInGameMap(deps) {
  const config = deps && deps.config;
  const settings = config && config.inGameMap;
  if (!settings || settings.enabled !== true) return { ok: false, reason: "disabled_by_config" };
  const chatWanted = settings.chatEnabled === true;
  const adapter = deps.adapter || null;
  if (chatWanted && (!adapter || typeof adapter.installChatCommand !== "function")) {
    return { ok: false, reason: "adapter_unavailable" };
  }
  const ctx = deps.ctx || {};
  const clock = deps.clock && typeof deps.clock.now === "function" ? deps.clock : { now: () => Date.now() };
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : null;
  let state = STATE.STARTING;
  let registered = false;
  const counters = Object.fromEntries(COUNTER_NAMES.map((name) => [name, 0]));

  function log(line) {
    if (!logger) return;
    try {
      logger.log(`inGameMap: ${line}`);
    } catch (_err) {
    }
  }

  function bump(name) {
    if (!COUNTER_NAMES.includes(name)) return;
    counters[name] += 1;
    if (!telemetry || typeof telemetry.count !== "function") return;
    try {
      telemetry.count(`inGameMap.chat.${name}`, 1);
    } catch (_err) {
    }
  }

  function graphOf() {
    const g = ctx.graph;
    if (!g || typeof g.getGraph !== "function") return null;
    const r = g.getGraph();
    return r && r.ok ? r.graph : null;
  }

  let mapWindow = null;
  let windowOff = { state: "off" };
  if (settings.clientProbeEnabled === true || settings.windowEnabled === true) {
    let w;
    try {
      w = createMapWindow({ config, ctx, adapter, world: deps.world || null, clock, telemetry, log, nowMs: deps.nowMs });
    } catch (err) {
      w = { ok: false, reason: "THREW", detail: messageOf(err) };
    }
    if (w && w.ok === true) mapWindow = w.window;
    else windowOff = { state: `refused:${(w && w.reason) || "no_result"}` };
  }

  const liveConfig = deps.liveConfig && typeof deps.liveConfig.get === "function" ? deps.liveConfig : null;
  const chat = createMapChat({ settings, frontChatSettings: config.frontChat || {}, observerSettings: config.observer,
    graphOf, clock, isRunning: () => state === STATE.RUNNING, bump, log,
    liveSettings: () => {
      const c = liveConfig ? liveConfig.get() : null;
      return c && c.inGameMap ? c.inGameMap : settings;
    },
    liveVersion: () => (liveConfig ? liveConfig.version : 0),
    ...(mapWindow && settings.clientProbeEnabled === true
      ? { probe: (characterId, spec) => mapWindow.openProbe(characterId, spec) } : {}),
    ...(mapWindow && settings.windowEnabled === true ? { open: (characterId) => mapWindow.open(characterId) } : {}) });

  if (chatWanted) {
    let installed;
    try {
      installed = adapter.installChatCommand({ name: COMMAND_NAME, match: matchMapCommand, handle: chat.handle,
        failReply: FAIL_REPLY });
    } catch (err) {
      installed = { ok: false, reason: "THREW", detail: messageOf(err) };
    }
    if (!installed || installed.ok !== true) {
      if (mapWindow) mapWindow.stop("chat_refused");
      return { ok: false, reason: "IN_GAME_MAP_SEAM_UNAVAILABLE",
        detail: installed ? `${installed.reason}${installed.detail ? `:${installed.detail}` : ""}` : "no_result" };
    }
    registered = true;
  }

  const starmap = { jumps: "off", reason: null };
  let tracker = null;
  if (settings.starmapJumpsEnabled === true) {
    if (!adapter || typeof adapter.installStarmapJumps !== "function") {
      Object.assign(starmap, { jumps: "refused", reason: "adapter_unavailable" });
    } else {
      const fleetsSettings = config.fleets || {};
      tracker = createTrafficTracker({
        fleets: { get repository() { return ctx.fleets ? ctx.fleets.repository || null : null; } },
        get store() { return ctx.persistence && ctx.persistence.ok ? ctx.persistence.store : null; },
        clock, getGovernor: () => ctx.governor || null, settings, maxListLimit: fleetsSettings.maxListLimit,
        telemetry, log, setTimer: deps.setTimer, nowMs: deps.nowMs });
      tracker.start();
      let installed;
      try {
        installed = adapter.installStarmapJumps({ jumpCounts: (windowMs) => tracker.jumpCounts(windowMs),
          onEvent: (name) => {
            if (telemetry && typeof telemetry.count === "function") telemetry.count(`inGameMap.starmap.${name}`, 1);
          } });
      } catch (err) {
        installed = { ok: false, reason: "THREW", detail: messageOf(err) };
      }
      if (installed && installed.ok === true) {
        starmap.jumps = "active";
      } else {
        tracker.stop();
        tracker = null;
        const why = installed ? `${installed.reason}${installed.detail ? `:${installed.detail}` : ""}` : "no_result";
        Object.assign(starmap, { jumps: "refused", reason: why });
        log(`star map Jumps overlay refused - ${why}`);
      }
    }
  }
  const kills = { state: "off", reason: null };
  let losses = null;
  if (settings.starmapKillsEnabled === true) {
    if (!adapter || typeof adapter.installStarmapKills !== "function") {
      Object.assign(kills, { state: "refused", reason: "adapter_unavailable" });
    } else {
      losses = createLossesCache({
        battle: { get repository() { return ctx.battle ? ctx.battle.repository || null : null; } },
        get store() { return ctx.persistence && ctx.persistence.ok ? ctx.persistence.store : null; },
        clock, wallNow: deps.wallNow, getGovernor: () => ctx.governor || null, settings, telemetry, log,
        setTimer: deps.setTimer, nowMs: deps.nowMs });
      losses.start();
      let installed;
      try {
        installed = adapter.installStarmapKills({ snapshot: () => losses.snapshot(), onEvent: (name, value) => {
          if (!telemetry) return;
          if (name === "syntheticKills") {
            if (typeof telemetry.gauge === "function") telemetry.gauge("inGameMap.starmap.syntheticKills", value);
          } else if (typeof telemetry.count === "function") {
            telemetry.count(`inGameMap.starmap.${name}`, 1);
          }
        } });
      } catch (err) {
        installed = { ok: false, reason: "THREW", detail: messageOf(err) };
      }
      if (installed && installed.ok === true) {
        kills.state = "active";
      } else {
        losses.stop();
        losses = null;
        const why = installed ? `${installed.reason}${installed.detail ? `:${installed.detail}` : ""}` : "no_result";
        Object.assign(kills, { state: "refused", reason: why });
        log(`star map Kills overlay refused - ${why}`);
      }
    }
  }
  state = STATE.RUNNING;

  function stop(reason) {
    if (state === STATE.STOPPED) return;
    state = STATE.STOPPED;
    if (kills.state === "active") {
      kills.state = "stopped";
      try {
        adapter.uninstallStarmapKills();
      } catch (err) {
        log(`star map Kills uninstall failed (${reason || "stop"}) - ${messageOf(err)}`);
      }
    }
    if (losses) losses.stop();
    if (starmap.jumps === "active") {
      starmap.jumps = "stopped";
      try {
        adapter.uninstallStarmapJumps();
      } catch (err) {
        log(`star map uninstall failed (${reason || "stop"}) - ${messageOf(err)}`);
      }
    }
    if (tracker) tracker.stop();
    if (mapWindow) mapWindow.stop(reason);
    if (!registered) return;
    registered = false;
    try {
      if (typeof adapter.uninstallChatCommand === "function") adapter.uninstallChatCommand(COMMAND_NAME);
    } catch (err) {
      log(`uninstall failed (${reason || "stop"}) - ${messageOf(err)}`);
    }
  }

  return { ok: true, inGameMap: Object.freeze({
    getStatus: () => ({ state, chat: { registered }, counters: { ...counters },
      starmap: { jumps: starmap.jumps, reason: starmap.reason, tracker: tracker ? tracker.status() : null },
      starmapKills: { state: kills.state, reason: kills.reason, losses: losses ? losses.status() : null },
      window: mapWindow ? mapWindow.status() : { ...windowOff } }),
    stop,
    handle: chat.handle,
  }) };
}

module.exports = { COMMAND_NAME, startInGameMap };
