"use strict";

const { createRateLimiter } = require("../frontChat/rateLimit");
const { formatBoardReply, formatJobsRefusal } = require("./format");

const COMMAND_RE = /^!\s*(zlecenia|jobs)(?:\s[\s\S]*)?$/i;
const COMMAND_NAME = "jobs";
const FAIL_REPLY = "LNE: jobs unavailable (HANDLER_FAILED)";
const MAX_DETAIL = 120;
const MS_DECIMALS = 10;

function matchJobsCommand(text) {
  return COMMAND_RE.test(String(text));
}

function createJobsChat(deps) {
  const { settings, listBoard, clock, nowMs, isRunning, bump, observe, log } = deps;
  const fc = deps.frontChatSettings || {};
  const limiter = createRateLimiter({ cooldownMs: settings.chatMinIntervalMs, maxPerMinute: fc.maxRepliesPerMinute,
    maxTracked: fc.maxTrackedCharacters });
  const lineBreak = fc.lineBreak === "\\n" ? "\n" : String(fc.lineBreak ?? "\n");

  function governorAdmits() {
    try {
      const g = deps.getGovernor();
      return !g || typeof g.admits !== "function" || g.admits("MAINTENANCE") !== false;
    } catch (_err) {
      return true;
    }
  }

  function handle(rec) {
    try {
      if (!isRunning()) return formatJobsRefusal("UNAVAILABLE", { detail: "STOPPED" });
      if (!rec || !Number.isSafeInteger(rec.characterId) || rec.characterId <= 0) {
        return formatJobsRefusal("UNAVAILABLE", { detail: "NO_CHARACTER" });
      }
      const taken = limiter.take(rec.characterId, clock.now());
      if (!taken.ok) {
        bump("chatRateLimited");
        return formatJobsRefusal("RATE_LIMITED", { waitMs: taken.waitMs });
      }
      if (!governorAdmits()) return formatJobsRefusal("BUSY");
      const t0 = nowMs();
      const board = listBoard(null, rec.characterId);
      if (!board || board.ok !== true) {
        bump("chatErrors");
        log(`chat read ${(board && board.reason) || "no result"}${board && board.detail ? ` - ${board.detail}` : ""}`);
        return formatJobsRefusal("UNAVAILABLE", { detail: (board && board.reason) || "NO_RESULT" });
      }
      const text = formatBoardReply(board, { maxChars: settings.chatMaxChars, lineBreak,
        resetHourUtc: settings.resetHourUtc });
      bump("chatReplies");
      observe("chatReplyMs", Math.round((nowMs() - t0) * MS_DECIMALS) / MS_DECIMALS);
      return text;
    } catch (err) {
      bump("chatErrors");
      log(`chat reply failed - ${String((err && err.message) || err).slice(0, MAX_DETAIL)}`);
      return formatJobsRefusal("UNAVAILABLE", { detail: "HANDLER_FAILED" });
    }
  }

  return Object.freeze({ handle });
}

module.exports = { COMMAND_RE, COMMAND_NAME, FAIL_REPLY, matchJobsCommand, createJobsChat };
