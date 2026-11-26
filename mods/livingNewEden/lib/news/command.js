"use strict";

const { runTx } = require("./tx");

const COMMAND_NAME = "news";
const COMMAND_RE = /^!\s*news(?:\s+([\s\S]*))?$/i;
const ELLIPSIS = "...";
const TEXT = Object.freeze({
  en: Object.freeze({ none: "Scope News: no edition yet.", off: "Scope News: you will get no more news mails.",
    on: "Scope News: you will get the news mails again.", usage: "Scope News: !news | !news off | !news on",
    failed: "Scope News unavailable." }),
  pl: Object.freeze({ none: "Scope News: brak wydań.", off: "Scope News: nie dostaniesz już maili z wiadomościami.",
    on: "Scope News: znów dostaniesz maile z wiadomościami.", usage: "Scope News: !news | !news off | !news on",
    failed: "Scope News niedostępne." }),
});

function matchNewsCommand(text) {
  return COMMAND_RE.test(String(text));
}

function headlineOf(e) {
  const title = e.title !== null ? e.title : e.fallbackTitle;
  const first = (e.paragraphs.length > 0 ? e.paragraphs : e.fallbackParagraphs)[0] || "";
  return { seq: e.seq, title, firstParagraph: first, publishedAt: e.publishedAt === null ? e.boundaryAt : e.publishedAt };
}

function cut(text, max) {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - ELLIPSIS.length))}${ELLIPSIS}`;
}

function createNewsChat(deps) {
  const { store, repo, readers, clock, isRunning, bump, log } = deps;
  const t = TEXT[deps.settings.language === "pl" ? "pl" : "en"];
  const max = deps.chat && Number.isSafeInteger(deps.chat.maxReplyChars) ? deps.chat.maxReplyChars : 1000;
  const br = deps.chat && typeof deps.chat.lineBreak === "string"
    ? (deps.chat.lineBreak === "\\n" ? "\n" : deps.chat.lineBreak) : "<br>";

  function latest() {
    const r = runTx(store, "news.read", (db) => repo.latestPublishedInTx(db));
    if (!r.ok) return null;
    const e = r.value.edition;
    if (!e) return t.none;
    const { title, firstParagraph: first } = headlineOf(e);
    const head = `Scope News #${e.seq}: ${title}`;
    return first ? `${cut(head, max)}${br}${cut(first, Math.max(0, max - Math.min(head.length, max) - br.length))}`
      : cut(head, max);
  }

  function handle(rec, text) {
    try {
      if (!isRunning()) return t.failed;
      const m = COMMAND_RE.exec(String(text === undefined ? "!news" : text).trim());
      const arg = m && m[1] ? m[1].trim().toLowerCase() : "";
      let reply;
      if (arg === "") reply = latest();
      else if (arg === "off" || arg === "on") {
        if (!rec || !Number.isSafeInteger(rec.characterId) || rec.characterId <= 0) reply = null;
        else {
          const r = readers.optOut(rec.characterId, arg === "off", clock.now());
          reply = r.ok ? t[arg] : null;
        }
      } else reply = t.usage;
      if (reply === null) {
        bump("chatErrors");
        return t.failed;
      }
      bump("chatReplies");
      return cut(reply, max);
    } catch (err) {
      bump("chatErrors");
      log(`chat failed - ${String((err && err.message) || err).slice(0, 120)}`);
      return t.failed;
    }
  }

  return Object.freeze({ handle, failReply: t.failed });
}

function installNewsCommand(adapter, chat) {
  if (!adapter || typeof adapter.installChatCommand !== "function") return { ok: false, reason: "NO_CHAT_SEAM" };
  let r;
  try {
    r = adapter.installChatCommand({ name: COMMAND_NAME, match: matchNewsCommand, handle: chat.handle,
      failReply: chat.failReply });
  } catch (err) {
    return { ok: false, reason: "INSTALL_THREW", detail: String((err && err.message) || err) };
  }
  if (!r || !r.ok) return { ok: false, reason: String((r && r.reason) || "NO_RESULT") };
  return { ok: true, uninstall: () => {
    if (typeof adapter.uninstallChatCommand === "function") adapter.uninstallChatCommand(COMMAND_NAME);
  } };
}

module.exports = { COMMAND_NAME, COMMAND_RE, matchNewsCommand, createNewsChat, installNewsCommand, headlineOf };
