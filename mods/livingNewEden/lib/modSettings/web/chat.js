"use strict";

const { createRateLimiter } = require("../../frontChat/rateLimit");
const { resolveObserverUrl } = require("../../inGameMap/format");
const { parseValueText } = require("../providers/rowKit");
const { HELP, MAX_FIND_KEYS, parseSettingsCommand, formatGetReply, formatFindReply, formatWriteReply,
  formatCommandRefusal } = require("./chatCommands");

const COMMAND = "!settings";
const COMMAND_RE = /^!\s*settings(?:\s[\s\S]*)?$/i;
const FAIL_REPLY = "LNE settings unavailable (HANDLER_FAILED)";
const PAGE = "settings.html";
const MS_PER_MINUTE = 60000;
const MS_PER_SECOND = 1000;
const MAX_DETAIL = 120;
const TRANSPORT_PRIVATE = "xmpp";
const CHANNEL = "chat";

function matchSettingsCommand(text) {
  return COMMAND_RE.test(String(text));
}

function allowedIdsOf(csv) {
  const ids = new Set();
  for (const part of String(csv || "").split(",")) {
    const n = Number(part.trim());
    if (part.trim() !== "" && Number.isSafeInteger(n) && n > 0) ids.add(n);
  }
  return ids;
}

function formatSettingsReply(input) {
  const href = `${String(input.url)}${PAGE}#t=${String(input.token)}`;
  const minutes = Math.max(1, Math.round(Number(input.ttlMs) / MS_PER_MINUTE));
  return `LNE settings: <a href="${href}">Mod settings</a>${input.lineBreak}(${href} - opens in your browser, `
    + `one use, valid ${minutes} min)`;
}

function formatSettingsRefusal(reason, opts = {}) {
  switch (reason) {
    case "NOT_ALLOWED":
      return "LNE settings: not allowed";
    case "NOT_PRIVATE":
      return "LNE settings: no link on this chat path, type !settings in the Local window";
    case "RATE_LIMITED":
      return `LNE settings: wait ${Math.max(1, Math.ceil((Number(opts.waitMs) || 0) / MS_PER_SECOND))} s before the `
        + `next ${COMMAND}`;
    case "OBSERVER_OFF":
      return "LNE settings: the observer is off (observer.enabled)";
    default:
      return `LNE settings unavailable (${String(opts.detail || reason)})`;
  }
}

function createSettingsChat(deps) {
  const { settings, sessions, clock, isRunning, bump, log } = deps;
  const fc = deps.frontChatSettings || {};
  const allowed = allowedIdsOf(settings.allowedCharacterIds);
  const limiter = createRateLimiter({ cooldownMs: settings.cooldownMs, maxPerMinute: fc.maxRepliesPerMinute,
    maxTracked: fc.maxTrackedCharacters });
  const lineBreak = fc.lineBreak === "\\n" ? "\n" : String(fc.lineBreak ?? "\n");
  const replyOpts = Object.freeze({ maxReplyChars: settings.maxReplyChars, lineBreak });

  function runCommand(command, rec) {
    const ms = typeof deps.getModSettings === "function" ? deps.getModSettings() : null;
    if (!ms) return formatSettingsRefusal("UNAVAILABLE", { detail: "STOPPED" });
    const refused = (page) => formatCommandRefusal(command, (page && page.reason) || "DESCRIBE_FAILED", replyOpts);
    if (command.cmd === "find") {
      const page = ms.describe(command.mod, { q: command.key, limit: MAX_FIND_KEYS });
      return page && page.ok === true ? formatFindReply(page, command.key, replyOpts) : refused(page);
    }
    const page = ms.describe(command.mod, { key: command.key, limit: 1 });
    if (!page || page.ok !== true) return refused(page);
    const row = page.rows.find((r) => r.key === command.key) || null;
    if (command.cmd === "get") {
      return row ? formatGetReply(row, replyOpts) : formatCommandRefusal(command, "UNKNOWN_KEY", replyOpts);
    }
    const actor = { characterId: rec.characterId, characterName: typeof rec.name === "string" ? rec.name : null,
      channel: CHANNEL };
    const expectedRevision = page.overrideFile ? page.overrideFile.revision : null;
    if (command.cmd === "reset") {
      return formatWriteReply(command.key, ms.reset({ modId: command.mod, key: command.key, expectedRevision, actor }),
        replyOpts);
    }
    const parsed = parseValueText(row ? row.type : "string", command.value);
    const value = parsed.ok ? parsed.value : command.value;
    return formatWriteReply(command.key, ms.set({ modId: command.mod, key: command.key, value, expectedRevision,
      actor }), replyOpts);
  }

  function handle(rec, text, ctx) {
    try {
      if (!isRunning()) return formatSettingsRefusal("UNAVAILABLE", { detail: "STOPPED" });
      if (!rec || !Number.isSafeInteger(rec.characterId) || rec.characterId <= 0) {
        return formatSettingsRefusal("UNAVAILABLE", { detail: "NO_CHARACTER" });
      }
      if (!allowed.has(rec.characterId)) {
        bump("denied");
        log(`!settings denied for character ${rec.characterId}`);
        return formatSettingsRefusal("NOT_ALLOWED");
      }
      const command = parseSettingsCommand(text);
      if (command.cmd === "help") return HELP;
      if (command.cmd !== "link") {
        const taken = limiter.take(rec.characterId, clock.now());
        if (!taken.ok) return formatSettingsRefusal("RATE_LIMITED", { waitMs: taken.waitMs });
        return runCommand(command, rec);
      }
      if (!ctx || ctx.transport !== TRANSPORT_PRIVATE) {
        log(`!settings refused for character ${rec.characterId} - transport ${String((ctx && ctx.transport)
          || "none").slice(0, MAX_DETAIL)} is not private`);
        return formatSettingsRefusal("NOT_PRIVATE");
      }
      const taken = limiter.take(rec.characterId, clock.now());
      if (!taken.ok) return formatSettingsRefusal("RATE_LIMITED", { waitMs: taken.waitMs });
      const url = resolveObserverUrl(deps.inGameMapSettings, deps.observerSettings);
      if (!url.ok) return formatSettingsRefusal(url.reason);
      const issued = sessions.issueToken({ characterId: rec.characterId,
        characterName: typeof rec.name === "string" ? rec.name : null });
      bump("links");
      return formatSettingsReply({ url: url.url, token: issued.token, ttlMs: settings.linkTtlMs, lineBreak });
    } catch (err) {
      log(`chat reply failed - ${String((err && err.message) || err).slice(0, MAX_DETAIL)}`);
      return FAIL_REPLY;
    }
  }

  return Object.freeze({ handle });
}

module.exports = { COMMAND, COMMAND_RE, FAIL_REPLY, PAGE, matchSettingsCommand, allowedIdsOf, formatSettingsReply,
  formatSettingsRefusal, createSettingsChat };
