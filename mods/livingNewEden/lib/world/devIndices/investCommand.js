"use strict";

const R = require("./rules");
const S = require("./schema");

const COMMAND_NAME = "invest";
const COMMAND_RE = /^!\s*invest(?:\s+([\s\S]*))?$/i;
const REQUEST_RE = /^(mil|ind|trade)\s+(\S+)$/i;
const MAX_LINES = 3;
const CONFIRM_PRUNE_SIZE = 256;
const TEXT = Object.freeze({
  usage: "Invest: !invest <mil|ind|trade> <amount> (e.g. 50m, 1.5b), then !invest yes. ISK is spent, no refund.",
  unsafe: "Invest: only from the Local chat of the game client (UNSAFE_TRANSPORT)",
  unavailable: "Invest: unavailable", noSystem: "Invest: no system",
  noRequest: "Invest: no pending request - type !invest <mil|ind|trade> <amount> first",
  moved: "Invest: you left the system of the request - type the request again",
  secClass: "Invest: no development index in this system",
});

function matchInvestCommand(text) {
  return COMMAND_RE.test(String(text).trim());
}

function cut(text, max) {
  return text.length <= max ? text : text.slice(0, Math.max(0, max));
}

function createInvestChat(deps) {
  const { invest, settings: P, clock, ids, isRunning, bump } = deps;
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const max = Number.isSafeInteger(P.maxReplyChars) ? P.maxReplyChars : 1000;
  const confirms = new Map();

  function safe(fn, fallback) {
    try {
      return fn();
    } catch (_err) {
      return fallback;
    }
  }

  const nameOf = (systemId) => {
    const n = safe(() => (typeof deps.systemNameOf === "function" ? deps.systemNameOf(systemId) : null), null);
    return typeof n === "string" && /^[\x20-\x7e]+$/.test(n) ? n : String(systemId);
  };
  const controllerOf = (systemId) => {
    const n = safe(() => (typeof deps.controllerNameOf === "function" ? deps.controllerNameOf(systemId) : null), null);
    return typeof n === "string" && /^[\x20-\x7e]+$/.test(n) ? n : "unknown";
  };
  const secClassOf = (systemId) => safe(() => (typeof deps.secClassOf === "function" ? deps.secClassOf(systemId)
    : null), null);
  const levelsOf = (systemId) => {
    const lv = safe(() => (typeof deps.levelsOf === "function" ? deps.levelsOf(systemId) : null), null);
    return lv && typeof lv === "object" ? lv : null;
  };

  function prune(now) {
    if (confirms.size < CONFIRM_PRUNE_SIZE) return;
    for (const [id, c] of confirms) if (now > c.expiresAt) confirms.delete(id);
  }

  function ask(rec, kind, amountText, now) {
    const asked = R.parseInvestAmount(amountText);
    if (asked === null) return TEXT.usage;
    if (!P.secClasses.includes(secClassOf(rec.systemId))) return TEXT.secClass;
    let amount = asked;
    let points = R.investPoints(amount, P);
    if (amount < P.investMinIsk || points < 1) {
      bump("invest.limit");
      return `Invest: at least ${invest.iskText(Math.max(P.investMinIsk, P.investIskPerPoint))} ISK`;
    }
    if (amount > P.investMaxIskPerCommand) {
      bump("invest.limit");
      return `Invest: at most ${invest.iskText(P.investMaxIskPerCommand)} ISK per command`;
    }
    let capped = false;
    const lv = levelsOf(rec.systemId);
    if (lv) {
      const have = lv[`${kind}Points`];
      const headroom = P.maxPoints - (Number.isSafeInteger(have) ? have : 0);
      if (headroom < 1) {
        bump("invest.atMax");
        return `Invest: ${kind.toUpperCase()} in ${nameOf(rec.systemId)} is at maximum`;
      }
      if (points > headroom) {
        amount = headroom * P.investIskPerPoint;
        points = headroom;
        if (amount < P.investMinIsk) {
          bump("invest.atMax");
          return `Invest: ${kind.toUpperCase()} in ${nameOf(rec.systemId)} is at maximum`;
        }
        capped = true;
        bump("invest.capped");
      }
    }
    prune(now);
    confirms.set(rec.characterId, Object.freeze({ systemId: rec.systemId, kind, amount, points,
      nonce: ids.next(S.INVEST_ID_PREFIX), expiresAt: now + P.investConfirmMs }));
    bump("invest.requested");
    return `Invest ${invest.iskText(amount)} ISK in ${nameOf(rec.systemId)} (controller ${controllerOf(rec.systemId)}) `
      + `for ${kind.toUpperCase()} +${points} points${capped ? " (capped at index maximum)" : ""}? `
      + `Type !invest yes within ${Math.ceil(P.investConfirmMs / 1000)}s. ISK is spent, no refund.`;
  }

  function confirm(rec, now) {
    const c = confirms.get(rec.characterId);
    if (!c || now > c.expiresAt) {
      if (c) confirms.delete(rec.characterId);
      return TEXT.noRequest;
    }
    if (c.systemId !== rec.systemId) return TEXT.moved;
    const r = invest.request({ characterId: rec.characterId, systemId: c.systemId, kind: c.kind, amount: c.amount,
      nonce: c.nonce, now });
    if (!r.ok) return `Invest refused (${r.reason})`;
    invest.runSaga(r.investId, now).catch((err) => log(`invest saga rejected - ${String((err && err.message) || err)}`));
    return `Invest: ${invest.iskText(c.amount)} ISK for ${c.kind.toUpperCase()} in ${nameOf(c.systemId)} - processing`;
  }

  function reply(rec, text, ctx) {
    const m = COMMAND_RE.exec(String(text === undefined ? "!invest" : text).trim());
    const arg = m && m[1] ? m[1].trim() : "";
    if (arg === "" || /^help$/i.test(arg)) return TEXT.usage;
    if (!ctx || ctx.transport !== "xmpp") {
      bump("invest.unsafeTransport");
      return TEXT.unsafe;
    }
    if (!isRunning()) return TEXT.unavailable;
    if (!rec || !Number.isSafeInteger(rec.systemId) || rec.systemId <= 0 || !Number.isSafeInteger(rec.characterId)
      || rec.characterId <= 0) {
      return TEXT.noSystem;
    }
    const now = clock.now();
    if (/^yes$/i.test(arg)) return confirm(rec, now);
    const q = REQUEST_RE.exec(arg);
    if (!q) return TEXT.usage;
    return ask(rec, q[1].toLowerCase(), q[2], now);
  }

  function handle(rec, text, ctx) {
    try {
      return cut(String(reply(rec, text, ctx)).split("\n").slice(0, MAX_LINES).join("\n"), max);
    } catch (err) {
      log(`!invest failed - ${String((err && err.message) || err).slice(0, 120)}`);
      return TEXT.unavailable;
    }
  }

  return Object.freeze({ handle, failReply: TEXT.unavailable, pendingCount: () => confirms.size });
}

function installInvestCommand(adapter, chat) {
  if (!adapter || typeof adapter.installChatCommand !== "function") return { ok: false, reason: "NO_CHAT_SEAM" };
  let r;
  try {
    r = adapter.installChatCommand({ name: COMMAND_NAME, match: matchInvestCommand, handle: chat.handle,
      failReply: chat.failReply });
  } catch (err) {
    return { ok: false, reason: "INSTALL_THREW", detail: String((err && err.message) || err) };
  }
  if (!r || !r.ok) return { ok: false, reason: String((r && r.reason) || "NO_RESULT") };
  return { ok: true, uninstall: () => {
    if (typeof adapter.uninstallChatCommand === "function") adapter.uninstallChatCommand(COMMAND_NAME);
  } };
}

module.exports = { COMMAND_NAME, COMMAND_RE, TEXT, matchInvestCommand, createInvestChat, installInvestCommand };
