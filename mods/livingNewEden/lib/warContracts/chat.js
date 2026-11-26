"use strict";

const { createRateLimiter } = require("../frontChat/rateLimit");
const { COMMAND_RE, matchWarCommand, formatWarReply, formatWarRefusal } = require("./format");

const COMMAND_NAME = "war";
const FAIL_REPLY = "LNE: war contracts unavailable (HANDLER_FAILED)";
const MAX_DETAIL = 120;
const MS_DECIMALS = 10;

function createWarChat(deps) {
  const { settings, listForChat, regionOf, names, clock, nowMs, isRunning, bump, observe, log } = deps;
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
      if (!isRunning()) return formatWarRefusal("UNAVAILABLE", { detail: "STOPPED" });
      if (!rec || !Number.isSafeInteger(rec.characterId) || rec.characterId <= 0) {
        return formatWarRefusal("UNAVAILABLE", { detail: "NO_CHARACTER" });
      }
      const taken = limiter.take(rec.characterId, clock.now());
      if (!taken.ok) {
        bump("chatRateLimited");
        return formatWarRefusal("RATE_LIMITED", { waitMs: taken.waitMs });
      }
      if (!governorAdmits()) return formatWarRefusal("BUSY");
      const t0 = nowMs();
      const read = listForChat();
      if (!read || read.ok !== true) {
        bump("chatErrors");
        log(`chat read ${(read && read.reason) || "no result"}${read && read.detail ? ` - ${read.detail}` : ""}`);
        return formatWarRefusal("UNAVAILABLE", { detail: (read && read.reason) || "NO_RESULT" });
      }
      const fronts = read.fronts instanceof Map ? read.fronts : new Map();
      const playerRegionId = Number.isSafeInteger(rec.systemId) && rec.systemId > 0 ? regionOf(rec.systemId) : null;
      const text = formatWarReply({ rows: read.rows, playerRegionId, regionOf, names,
        frontOf: (factionId) => (fronts.has(factionId) ? fronts.get(factionId) : null), now: clock.now(),
        maxLines: settings.chatMaxLines, maxChars: settings.chatMaxChars, lineBreak });
      bump("chatReplies");
      observe("chatReplyMs", Math.round((nowMs() - t0) * MS_DECIMALS) / MS_DECIMALS);
      return text;
    } catch (err) {
      bump("chatErrors");
      log(`chat reply failed - ${String((err && err.message) || err).slice(0, MAX_DETAIL)}`);
      return formatWarRefusal("UNAVAILABLE", { detail: "HANDLER_FAILED" });
    }
  }

  return Object.freeze({ handle });
}

module.exports = { COMMAND_RE, COMMAND_NAME, FAIL_REPLY, matchWarCommand, createWarChat };
