"use strict";

const WRAPPED = Symbol.for("shipWing.chat");
const MAX_DETAIL = 120;
const FAIL_REPLY = "Ship Wing: the command failed (see the server log).";

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function createChatHook(deps) {
  const target = deps && deps.chatRuntimeExports;
  const match = deps && deps.match;
  const handle = deps && deps.handle;
  const logger = deps && deps.logger && typeof deps.logger.log === "function" ? deps.logger : null;
  let installed = false;
  let active = false;
  let original = null;
  let wrapper = null;

  function log(line) {
    if (!logger) return;
    try {
      logger.log(line);
    } catch (_err) {
    }
  }

  function matches(message) {
    try {
      return match(String(message === undefined || message === null ? "" : message)) === true;
    } catch (err) {
      log(`chat: match failed - ${messageOf(err)}`);
      return false;
    }
  }

  function install() {
    if (installed) return { ok: false, reason: "HOOK_ALREADY_INSTALLED" };
    if (!target || typeof target.broadcastLocalMessage !== "function"
      || typeof match !== "function" || typeof handle !== "function") {
      return { ok: false, reason: "HOOK_SEAM_UNAVAILABLE" };
    }
    if (target.broadcastLocalMessage[WRAPPED] === true) return { ok: false, reason: "HOOK_ALREADY_INSTALLED" };
    original = target.broadcastLocalMessage;
    const base = original;
    wrapper = function shipWingChat(session, message) {
      if (!active || !matches(message)) return base.apply(this, arguments);
      let reply = FAIL_REPLY;
      try {
        const out = handle(session, String(message));
        if (typeof out === "string" && out.length > 0) reply = out;
      } catch (err) {
        log(`chat: handler failed - ${messageOf(err)}`);
      }
      throw new Error(reply);
    };
    for (const symbol of Object.getOwnPropertySymbols(base)) {
      if (symbol !== WRAPPED) wrapper[symbol] = base[symbol];
    }
    wrapper[WRAPPED] = true;
    target.broadcastLocalMessage = wrapper;
    installed = true;
    active = true;
    return { ok: true };
  }

  function uninstall() {
    active = false;
    if (installed && target && target.broadcastLocalMessage === wrapper) target.broadcastLocalMessage = original;
    installed = false;
  }

  return Object.freeze({ install, uninstall, isActive: () => active });
}

function installChatFromGame(adapter, deps) {
  if (!adapter || typeof adapter.isConsumerAvailable !== "function" || !adapter.isConsumerAvailable("chat")) {
    return { ok: false, reason: "probe_chat_unavailable" };
  }
  const loaded = adapter.requireGame("_secondary/chat/chatRuntime");
  if (!loaded || !loaded.ok) return { ok: false, reason: `require_failed:${loaded && loaded.reason}` };
  const hook = createChatHook({ ...deps, chatRuntimeExports: loaded.exports });
  const installed = hook.install();
  return installed.ok ? { ok: true, hook } : { ok: false, reason: installed.reason };
}

module.exports = { WRAPPED, FAIL_REPLY, createChatHook, installChatFromGame };
