"use strict";

const { createRateLimiter } = require("../frontChat/rateLimit");

const COMMAND_NAME = "board";
const COMMAND_RE = /^!\s*(board|tablica)(?:\s[\s\S]*)?$/i;
const AUTO_RE = /^!\s*(?:board|tablica)\s+auto(?:\s+(\S+))?\s*$/i;
const FAIL_REPLY = "LNE board: window unavailable (HANDLER_FAILED), use !jobs / !war";
const OPENING_REPLY = "LNE board: opening window";
const MS_PER_SECOND = 1000;
const MAX_DETAIL = 120;
const MAX_REASON = 40;

function matchBoardCommand(text) {
  return COMMAND_RE.test(String(text));
}

function unavailableReply(reason) {
  const code = String(reason || "UNAVAILABLE").replace(/[^\w:.-]/g, "_").slice(0, MAX_REASON);
  return `LNE board: window unavailable (${code}), use !jobs / !war`;
}

function switchFailedReply(reason) {
  const code = String(reason || "UNAVAILABLE").replace(/[^\w:.-]/g, "_").slice(0, MAX_REASON);
  return `LNE board: switch failed (${code})`;
}

function createBoardChat(deps) {
  const { settings, open, prefsOf, applySwitch, clock, isRunning, log } = deps;

  function auto(characterId, value) {
    const serverOff = settings.openAtLoginEnabled === true ? "" : " - off on this server";
    if (value !== undefined) {
      const r = typeof applySwitch === "function" ? applySwitch(characterId, "openAtLogin", value.toLowerCase())
        : { ok: false, reason: "JOB_BOARD_UNAVAILABLE" };
      return r && r.ok === true ? `LNE board: window at login ${r.value}${serverOff}` : switchFailedReply(r && r.reason);
    }
    const p = typeof prefsOf === "function" ? prefsOf(characterId) : { ok: false, reason: "JOB_BOARD_UNAVAILABLE" };
    return p && p.ok === true ? `LNE board: window at login ${p.openAtLogin ? "on" : "off"}${serverOff}`
      : switchFailedReply(p && p.reason);
  }
  const fc = deps.frontChatSettings || {};
  const limiter = createRateLimiter({ cooldownMs: settings.openMinIntervalMs, maxPerMinute: fc.maxRepliesPerMinute,
    maxTracked: fc.maxTrackedCharacters });

  function handle(rec, text) {
    try {
      if (!isRunning()) return unavailableReply("STOPPED");
      if (!rec || !Number.isSafeInteger(rec.characterId) || rec.characterId <= 0) {
        return unavailableReply("NO_CHARACTER");
      }
      const taken = limiter.take(rec.characterId, clock.now());
      if (!taken.ok) {
        return `LNE board: wait ${Math.max(1, Math.ceil((Number(taken.waitMs) || 0) / MS_PER_SECOND))} s before `
          + "the next !board";
      }
      const m = AUTO_RE.exec(String(text ?? "").trim());
      if (m) return auto(rec.characterId, m[1]);
      const r = open(rec.characterId);
      return r && r.ok === true ? OPENING_REPLY : unavailableReply(r && r.reason);
    } catch (err) {
      log(`chat reply failed - ${String((err && err.message) || err).slice(0, MAX_DETAIL)}`);
      return FAIL_REPLY;
    }
  }

  return Object.freeze({ handle });
}

module.exports = { COMMAND_NAME, COMMAND_RE, AUTO_RE, FAIL_REPLY, OPENING_REPLY, matchBoardCommand, unavailableReply,
  createBoardChat };
