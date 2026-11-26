"use strict";

const { recordOf } = require("./sessionPresence");

const MAX_DETAIL = 120;
const DEFAULT_FAIL_REPLY = "LNE: command unavailable (HANDLER_FAILED)";
const TRANSPORT_STACK_DEPTH = 16;
const TRANSPORT_FILES = Object.freeze([
  Object.freeze({ re: /[\\/]xmppStubServer\.js:\d/, transport: "xmpp" }),
  Object.freeze({ re: /[\\/]localChatGatewayService\.js:\d/, transport: "gateway" }),
  Object.freeze({ re: /[\\/](?:lscService|chatHub)\.js:\d/, transport: "lsc" }),
]);
const TRANSPORT_UNKNOWN = "unknown";
const ROLE_GML = 18014398509481984n;
const ROLE_WORLDMOD = 4096n;
const GM_ROLES = ROLE_GML | ROLE_WORLDMOD;

function roleOf(value) {
  try {
    if (typeof value === "bigint") return value;
    if (typeof value === "number" && Number.isFinite(value)) return BigInt(Math.trunc(value));
    if (typeof value === "string" && value.trim() !== "") return BigInt(value.trim());
    if (value && typeof value === "object" && (value.type === "long" || value.type === "int")) return roleOf(value.value);
  } catch (_err) {
    return 0n;
  }
  return 0n;
}

function isGmSession(session) {
  if (!session || typeof session !== "object") return false;
  const raw = session.accountRole !== undefined && session.accountRole !== null ? session.accountRole : session.role;
  return (roleOf(raw) & GM_ROLES) !== 0n;
}

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function transportOfStack(stack) {
  for (const line of String(stack || "").split("\n")) {
    for (const entry of TRANSPORT_FILES) {
      if (entry.re.test(line)) return entry.transport;
    }
  }
  return TRANSPORT_UNKNOWN;
}

function transportOfCall(fn) {
  const previous = Error.stackTraceLimit;
  try {
    const holder = {};
    Error.stackTraceLimit = TRANSPORT_STACK_DEPTH;
    Error.captureStackTrace(holder, fn);
    return transportOfStack(holder.stack);
  } catch (_err) {
    return TRANSPORT_UNKNOWN;
  } finally {
    Error.stackTraceLimit = previous;
  }
}

function createChatCommandHook(deps) {
  const target = deps && deps.chatRuntimeExports;
  const match = deps && deps.match;
  const handle = deps && deps.handle;
  const failReply = deps && typeof deps.failReply === "string" && deps.failReply ? deps.failReply : DEFAULT_FAIL_REPLY;
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
      return match(String(message ?? "").trim()) === true;
    } catch (err) {
      log(`chat command: match failed - ${messageOf(err)}`);
      return false;
    }
  }

  function install() {
    if (installed) return { ok: false, reason: "HOOK_ALREADY_INSTALLED" };
    if (!target || typeof target.broadcastLocalMessage !== "function"
      || typeof match !== "function" || typeof handle !== "function") {
      return { ok: false, reason: "HOOK_SEAM_UNAVAILABLE" };
    }
    original = target.broadcastLocalMessage;
    const base = original;
    wrapper = function lneFrontChat(session, message) {
      if (!active || !matches(message)) return base.apply(this, arguments);
      let reply = failReply;
      try {
        const ctx = Object.freeze({ transport: transportOfCall(wrapper), gm: isGmSession(session) });
        const out = handle(recordOf(session), String(message ?? "").trim(), ctx);
        if (typeof out === "string" && out.length > 0) reply = out;
      } catch (err) {
        log(`chat command: handler failed - ${messageOf(err)}`);
      }
      throw new Error(reply);
    };
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

module.exports = { createChatCommandHook, transportOfStack, isGmSession };
