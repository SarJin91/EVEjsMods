"use strict";

const R = require("./rules");

const COMMAND_NAME = "dev";
const COMMAND_RE = /^!\s*dev(?:\s+([\s\S]*))?$/i;
const MAX_LINES = 3;
const LIMITER_PRUNE_SIZE = 256;
const TEXT = Object.freeze({ usage: "Dev: !dev = development indices of this system", warming: "Dev: indices warming up",
  noSystem: "Dev: no system", unavailable: "Dev: indices unavailable", busy: "Dev: server busy, try again later" });
const LABEL = Object.freeze({ mil: "MIL", ind: "IND", trade: "TRADE" });

const trendMark = (t) => (t > 0 ? "+" : t < 0 ? "-" : "");

function matchDevCommand(text) {
  return COMMAND_RE.test(String(text).trim());
}

function partOf(levels, kind) {
  const points = levels[`${kind}Points`];
  return `${LABEL[kind]} ${levels[kind]}${trendMark(levels.trend[kind])}${points > 0 ? ` (${points})` : ""}`;
}

function formatDevLine(name, levels) {
  return `Dev ${name}: ${["mil", "ind", "trade"].map((k) => partOf(levels, k)).join(" | ")}`;
}

const percentOf = (permille) => (permille % 10 === 0 ? `${permille / 10}%` : `${(permille / 10).toFixed(1)}%`);

function formatEffectsLine(levels, P) {
  const e = R.effectsOf(levels, P);
  const parts = [];
  if (P.garrisonEnabled === true) parts.push(`garrison +${e.garrisonPoints}`);
  if (P.tradeDiscountEnabled === true) parts.push(`market -${percentOf(e.wtsDiscountPermille)}`);
  if (e.sites) parts.push("sites");
  return parts.length > 0 ? `Effects: ${parts.join(", ")}` : null;
}

function cut(text, max) {
  return text.length <= max ? text : text.slice(0, Math.max(0, max));
}

function createDevChat(deps) {
  const { levelsOf, settings: P, clock, isRunning, bump } = deps;
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const max = Number.isSafeInteger(P.maxReplyChars) ? P.maxReplyChars : 1000;
  const lastAt = new Map();

  function admitted() {
    try {
      const g = typeof deps.getGovernor === "function" ? deps.getGovernor() : null;
      return !g || typeof g.admits !== "function" || g.admits("MAINTENANCE") !== false;
    } catch (_err) {
      return true;
    }
  }

  function take(characterId, now) {
    if (!Number.isSafeInteger(characterId) || characterId <= 0) return 0;
    const at = lastAt.get(characterId);
    if (at !== undefined && now - at < P.commandCooldownMs) return P.commandCooldownMs - (now - at);
    if (lastAt.size >= LIMITER_PRUNE_SIZE) {
      for (const [id, t] of lastAt) if (now - t >= P.commandCooldownMs) lastAt.delete(id);
    }
    lastAt.set(characterId, now);
    return 0;
  }

  function nameOf(systemId) {
    try {
      const n = typeof deps.systemNameOf === "function" ? deps.systemNameOf(systemId) : null;
      return typeof n === "string" && /^[\x20-\x7e]+$/.test(n) ? n : String(systemId);
    } catch (_err) {
      return String(systemId);
    }
  }

  function reply(rec, text) {
    const m = COMMAND_RE.exec(String(text === undefined ? "!dev" : text).trim());
    if (m && m[1] && m[1].trim() !== "") return TEXT.usage;
    if (!isRunning()) {
      bump("command.unavailable");
      return TEXT.unavailable;
    }
    if (!rec || !Number.isSafeInteger(rec.systemId) || rec.systemId <= 0) return TEXT.noSystem;
    const wait = take(rec.characterId, clock.now());
    if (wait > 0) {
      bump("command.rateLimited");
      return `Dev: wait ${Math.ceil(wait / 1000)}s before the next !dev`;
    }
    if (!admitted()) {
      bump("command.unavailable");
      return TEXT.busy;
    }
    const levels = levelsOf(rec.systemId);
    if (!levels) {
      bump("command.unavailable");
      return TEXT.warming;
    }
    bump("command.replies");
    const effects = formatEffectsLine(levels, P);
    return `${formatDevLine(nameOf(rec.systemId), levels)}${effects ? `\n${effects}` : ""}`;
  }

  function handle(rec, text) {
    try {
      return cut(String(reply(rec, text)).split("\n").slice(0, MAX_LINES).join("\n"), max);
    } catch (err) {
      log(`!dev failed - ${String((err && err.message) || err).slice(0, 120)}`);
      return TEXT.unavailable;
    }
  }

  return Object.freeze({ handle, failReply: TEXT.unavailable });
}

function installDevCommand(adapter, chat) {
  if (!adapter || typeof adapter.installChatCommand !== "function") return { ok: false, reason: "NO_CHAT_SEAM" };
  let r;
  try {
    r = adapter.installChatCommand({ name: COMMAND_NAME, match: matchDevCommand, handle: chat.handle,
      failReply: chat.failReply });
  } catch (err) {
    return { ok: false, reason: "INSTALL_THREW", detail: String((err && err.message) || err) };
  }
  if (!r || !r.ok) return { ok: false, reason: String((r && r.reason) || "NO_RESULT") };
  return { ok: true, uninstall: () => {
    if (typeof adapter.uninstallChatCommand === "function") adapter.uninstallChatCommand(COMMAND_NAME);
  } };
}

module.exports = { COMMAND_NAME, COMMAND_RE, TEXT, matchDevCommand, formatDevLine, formatEffectsLine, createDevChat,
  installDevCommand };
