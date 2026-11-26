"use strict";

const { relicReply, textsOf, cut } = require("./hints");

const COMMAND_NAME = "relic";
const COMMAND_RE = /^!\s*(relic|relikt)(?:\s+[\s\S]*)?$/i;
const TRANSPORT_PRIVATE = "xmpp";
const DEFAULT_MAX_REPLY = 1000;

function matchRelicCommand(text) {
  return COMMAND_RE.test(String(text));
}

function createRelicChat(deps) {
  const { readChainOf, isRunning, bump, log } = deps;
  const language = deps.settings && deps.settings.language === "pl" ? "pl" : "en";
  const t = textsOf(language);
  const max = deps.chat && Number.isSafeInteger(deps.chat.maxReplyChars) ? deps.chat.maxReplyChars : DEFAULT_MAX_REPLY;
  const getGraph = typeof deps.getGraph === "function" ? deps.getGraph : () => null;

  function namesOf(chain) {
    let graph = null;
    try {
      graph = getGraph();
    } catch (_err) {
      graph = null;
    }
    const sys = graph && typeof graph.getSystem === "function" ? graph.getSystem(chain.systemId) : null;
    const region = graph && typeof graph.getRegionName === "function" ? graph.getRegionName(chain.regionId) : null;
    return { systemName: sys && typeof sys.name === "string" ? sys.name : null,
      regionName: typeof region === "string" ? region : null };
  }

  function handle(rec, _text, ctx) {
    try {
      if (!isRunning() || !rec || !Number.isSafeInteger(rec.characterId) || rec.characterId <= 0) {
        bump("command.errors");
        return t.failed;
      }
      const r = readChainOf(rec.characterId);
      if (!r || r.ok !== true) {
        bump("command.errors");
        return t.failed;
      }
      bump("command.replies");
      if (!r.chain) return cut(t.none, max);
      const c = r.chain.stageKind === "WH" && r.chain.entrySystemId
        ? { ...r.chain, systemId: r.chain.entrySystemId } : r.chain;
      const full = Boolean(ctx && ctx.transport === TRANSPORT_PRIVATE);
      return relicReply({ language, full, max, theme: c.theme, stageNo: c.stageNo, stageCount: c.stageCount,
        systemId: c.systemId, regionId: c.regionId, stageKind: c.stageKind, stageState: c.stageState,
        deadlineAt: c.deadlineAt, ...(full ? namesOf(c) : { systemName: null, regionName: null }) });
    } catch (err) {
      bump("command.errors");
      log(`!relic failed - ${String((err && err.message) || err).slice(0, 120)}`);
      return t.failed;
    }
  }

  return Object.freeze({ handle, failReply: t.failed });
}

function installRelicCommand(adapter, chat) {
  if (!adapter || typeof adapter.installChatCommand !== "function") return { ok: false, reason: "NO_CHAT_SEAM" };
  let r;
  try {
    r = adapter.installChatCommand({ name: COMMAND_NAME, match: matchRelicCommand, handle: chat.handle,
      failReply: chat.failReply });
  } catch (err) {
    return { ok: false, reason: "INSTALL_THREW", detail: String((err && err.message) || err) };
  }
  if (!r || !r.ok) return { ok: false, reason: String((r && r.reason) || "NO_RESULT") };
  return { ok: true, uninstall: () => {
    if (typeof adapter.uninstallChatCommand === "function") adapter.uninstallChatCommand(COMMAND_NAME);
  } };
}

module.exports = { COMMAND_NAME, COMMAND_RE, TRANSPORT_PRIVATE, matchRelicCommand, createRelicChat,
  installRelicCommand };
