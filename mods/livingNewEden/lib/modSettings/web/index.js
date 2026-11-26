"use strict";

const { createSessions } = require("./sessions");
const { createSettingsRoutes } = require("./routes");
const { createSettingsChat, matchSettingsCommand, FAIL_REPLY } = require("./chat");

const COMMAND_NAME = "settings";
const MAX_DETAIL = 120;
const COUNTER_NAMES = Object.freeze(["links", "denied"]);

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function why(r) {
  return r ? `${r.reason}${r.detail ? `:${r.detail}` : ""}` : "no_result";
}

function startSettingsWeb(deps) {
  const config = deps.config;
  const settings = config.modSettings;
  const telemetry = deps.telemetry || null;
  const log = deps.log;
  const adapter = deps.adapter || null;
  const state = { routes: "off", chat: "off" };

  function bump(name) {
    if (!COUNTER_NAMES.includes(name) || !telemetry || typeof telemetry.count !== "function") return;
    try {
      telemetry.count(`modSettings.${name}`, 1);
    } catch (_err) {
    }
  }

  const sessions = createSessions({ linkTtlMs: settings.linkTtlMs, sessionTtlMs: settings.sessionTtlMs,
    maxSessions: settings.maxSessions, clock: deps.clock, randomBytes: deps.randomBytes });

  let route = null;
  const routes = createSettingsRoutes({ getModSettings: deps.getModSettings, sessions, telemetry, log });
  if (!deps.httpRoutes || typeof deps.httpRoutes.register !== "function") {
    state.routes = "refused:no_route_registry";
  } else {
    let r;
    try {
      r = deps.httpRoutes.register(routes);
    } catch (err) {
      r = { ok: false, reason: "THREW", detail: messageOf(err) };
    }
    if (r && r.ok === true) {
      route = r;
      state.routes = "active";
    } else {
      state.routes = `refused:${why(r)}`;
    }
  }

  const chat = createSettingsChat({ settings, frontChatSettings: config.frontChat || {},
    inGameMapSettings: config.inGameMap || {}, observerSettings: config.observer, sessions, clock: deps.clock,
    isRunning: deps.isRunning, bump, log, getModSettings: deps.getModSettings });
  let registered = false;
  if (!adapter || typeof adapter.installChatCommand !== "function") {
    state.chat = "refused:adapter_unavailable";
  } else {
    let r;
    try {
      r = adapter.installChatCommand({ name: COMMAND_NAME, match: matchSettingsCommand, handle: chat.handle,
        failReply: FAIL_REPLY });
    } catch (err) {
      r = { ok: false, reason: "THREW", detail: messageOf(err) };
    }
    if (r && r.ok === true) {
      registered = true;
      state.chat = "active";
    } else {
      state.chat = `refused:${why(r)}`;
    }
  }
  if (state.routes !== "active") log(`web panel routes refused - ${state.routes.slice("refused:".length)}`);
  if (state.chat !== "active") log(`!settings refused - ${state.chat.slice("refused:".length)}`);

  function stop() {
    if (route) {
      try {
        route.unregister();
      } catch (err) {
        log(`web panel unregister failed - ${messageOf(err)}`);
      }
      route = null;
      state.routes = "stopped";
    }
    if (registered) {
      registered = false;
      state.chat = "stopped";
      try {
        if (typeof adapter.uninstallChatCommand === "function") adapter.uninstallChatCommand(COMMAND_NAME);
      } catch (err) {
        log(`!settings uninstall failed - ${messageOf(err)}`);
      }
    }
    sessions.clear();
  }

  return Object.freeze({
    status: () => ({ routes: state.routes, chat: state.chat, ...sessions.status() }),
    handleChat: chat.handle,
    stop,
  });
}

module.exports = { COMMAND_NAME, COUNTER_NAMES, startSettingsWeb };
