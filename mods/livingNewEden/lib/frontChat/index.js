"use strict";

const { performance } = require("node:perf_hooks");
const { buildSystemCardView } = require("../observer/views/systemCard");
const { readFactionNames } = require("../world/sovProjection");
const { readFrontSnapshot } = require("./snapshot");
const { formatFrontReply, formatRefusal } = require("./format");
const { createLiveRateLimiter } = require("./rateLimit");

const COMMAND_RE = /^!\s*front(?:\s[\s\S]*)?$/i;
const FAIL_REPLY = "LNE: front unavailable (HANDLER_FAILED)";
const MS_DECIMALS = 10;
const COUNTER_NAMES = Object.freeze(["replies", "rateLimited", "deferrals", "errors"]);
const STATE = Object.freeze({ STARTING: "starting", RUNNING: "running", STOPPED: "stopped" });

function messageOf(err) {
  return String((err && err.message) || err);
}

function persistenceStore(ctx) {
  const p = ctx && ctx.persistence;
  return p && p.ok === true && p.store ? p.store : null;
}

function matchFrontCommand(text) {
  return COMMAND_RE.test(String(text));
}

function startFrontChat(deps) {
  const config = deps && deps.config;
  const settings = config && config.frontChat;
  if (!settings || settings.enabled !== true) return { ok: false, reason: "disabled_by_config" };
  const ctx = deps.ctx || {};
  const adapter = deps.adapter || null;
  const clock = deps.clock && typeof deps.clock.now === "function" ? deps.clock : { now: () => Date.now() };
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const readSnapshot = typeof deps.readSnapshot === "function" ? deps.readSnapshot : readFrontSnapshot;
  if (!adapter || typeof adapter.installChatCommand !== "function") return { ok: false, reason: "adapter_unavailable" };

  let state = STATE.STARTING;
  let card = null;
  const counters = Object.fromEntries(COUNTER_NAMES.map((name) => [name, 0]));
  const liveConfig = deps.liveConfig && typeof deps.liveConfig.get === "function" ? deps.liveConfig : null;
  const live = () => {
    const c = liveConfig ? liveConfig.get() : null;
    return c && c.frontChat ? c.frontChat : settings;
  };
  const limiter = createLiveRateLimiter(() => ({ cooldownMs: live().cooldownMs,
    maxPerMinute: settings.maxRepliesPerMinute, maxTracked: settings.maxTrackedCharacters }),
  () => (liveConfig ? liveConfig.version : 0));
  const factionNames = readFactionNames(adapter, logger);
  const observerSettings = (config.observer) || {};
  const lineBreak = settings.lineBreak === "\\n" ? "\n" : String(settings.lineBreak);

  function log(line) {
    if (!logger) return;
    try {
      logger.log(`frontChat: ${line}`);
    } catch (_err) {
    }
  }

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  }

  function bump(name) {
    counters[name] += 1;
    metric("count", `frontChat.${name}`, 1);
  }

  function cardView() {
    if (card) return card;
    card = buildSystemCardView({ ctx, store: persistenceStore(ctx), clock, getGovernor: () => ctx.governor || null,
      telemetry, nowMs, factionNames, settings: { refreshMs: observerSettings.systemCardRefreshMs,
        maxRows: settings.maxRows, maxFleets: settings.maxFleets, recentBattles: settings.recentBattles } });
    return card;
  }

  function graphOf() {
    const g = ctx.graph;
    if (!g || typeof g.getGraph !== "function") return null;
    const r = g.getGraph();
    return r && r.ok ? r.graph : null;
  }

  function governorAdmits() {
    try {
      const governor = ctx.governor;
      return !governor || typeof governor.admits !== "function" || governor.admits("MAINTENANCE") !== false;
    } catch (_err) {
      return true;
    }
  }

  function handle(rec) {
    try {
      if (state !== STATE.RUNNING) return formatRefusal("UNAVAILABLE", { detail: "STOPPED" });
      if (!rec || !Number.isSafeInteger(rec.systemId) || rec.systemId <= 0) return formatRefusal("NO_SYSTEM");
      const taken = limiter.take(rec.characterId, clock.now());
      if (!taken.ok) {
        bump("rateLimited");
        return formatRefusal("RATE_LIMITED", { waitMs: taken.waitMs });
      }
      if (!governorAdmits()) {
        bump("deferrals");
        return formatRefusal("BUSY");
      }
      const t0 = nowMs();
      const snap = readSnapshot({ card: cardView(), store: persistenceStore(ctx), ctx, graph: graphOf(),
        settings, now: clock.now(), names: factionNames }, rec.systemId);
      if (!snap.ok) {
        if (snap.reason === "GOVERNOR_HOLD") {
          bump("deferrals");
          return formatRefusal("BUSY");
        }
        bump("errors");
        if (snap.detail) log(`snapshot ${snap.reason} - ${snap.detail}`);
        return formatRefusal("UNAVAILABLE", { detail: snap.reason });
      }
      const lines = formatFrontReply(snap.snapshot, { maxLines: settings.maxLines,
        maxReplyChars: live().maxReplyChars, lineBreak });
      bump("replies");
      metric("observe", "frontChat.replyMs", Math.round((nowMs() - t0) * MS_DECIMALS) / MS_DECIMALS);
      return lines.join(lineBreak);
    } catch (err) {
      bump("errors");
      log(`reply failed - ${messageOf(err)}`);
      return formatRefusal("UNAVAILABLE", { detail: "HANDLER_FAILED" });
    }
  }

  const installed = adapter.installChatCommand({ match: matchFrontCommand, handle, failReply: FAIL_REPLY });
  if (!installed || !installed.ok) {
    return { ok: false, reason: "FRONT_CHAT_SEAM_UNAVAILABLE",
      detail: installed ? `${installed.reason}${installed.detail ? `:${installed.detail}` : ""}` : "no_result" };
  }
  state = STATE.RUNNING;

  function stop(reason) {
    if (state === STATE.STOPPED) return;
    state = STATE.STOPPED;
    try {
      if (typeof adapter.uninstallChatCommand === "function") adapter.uninstallChatCommand();
    } catch (err) {
      log(`uninstall failed (${reason || "stop"}) - ${messageOf(err)}`);
    }
  }

  return { ok: true, frontChat: Object.freeze({
    getStatus: () => ({ state, ...counters, tracked: limiter.size() }),
    stop,
    handle,
  }) };
}

module.exports = { COMMAND_RE, matchFrontCommand, startFrontChat };
