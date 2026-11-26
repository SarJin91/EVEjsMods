"use strict";

const EVENT_NAME = "local-message";

function isPositiveInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function createLocalTalkTap(opts) {
  const chat = opts && opts.chatRuntimeExports;
  const observer = opts && opts.lineObserver;
  const now = opts && typeof opts.now === "function" ? opts.now : () => 0;
  const counters = { playerLines: 0, npcLines: 0, ignored: 0, consumerErrors: 0 };
  let consumer = null;
  let listener = null;
  let npcObserver = null;

  function deliver(line) {
    try {
      consumer(line);
    } catch (_err) {
      counters.consumerErrors += 1;
    }
  }

  function onLocalMessage(event) {
    try {
      if (consumer === null) return;
      const ev = event && typeof event === "object" ? event : {};
      const systemId = ev.solarSystemID;
      const characterId = ev.authorCharacterID;
      if (!isPositiveInt(systemId) || !isPositiveInt(characterId) || typeof ev.message !== "string") {
        counters.ignored += 1;
        return;
      }
      counters.playerLines += 1;
      deliver({ kind: "player", systemId, characterId, text: ev.message, atMs: now() });
    } catch (_err) {
      counters.consumerErrors += 1;
    }
  }

  function onNpcLine(spec) {
    if (consumer === null) return;
    if (!spec || !isPositiveInt(spec.systemId) || !isPositiveInt(spec.characterId) || typeof spec.text !== "string") {
      counters.ignored += 1;
      return;
    }
    counters.npcLines += 1;
    deliver({ kind: "npc", systemId: spec.systemId, characterId: spec.characterId, text: spec.text, atMs: now() });
  }

  function install(fn) {
    if (consumer !== null) return { ok: false, reason: "HOOK_ALREADY_INSTALLED" };
    if (typeof fn !== "function") return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "fn" };
    if (!chat || typeof chat.on !== "function" || typeof chat.off !== "function") {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "chatRuntime_on_off" };
    }
    if (!observer || typeof observer.set !== "function" || typeof observer.clear !== "function") {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "line_observer" };
    }
    const own = (spec) => onNpcLine(spec);
    const set = observer.set(own);
    if (!set || set.ok !== true) {
      return set && set.reason === "HOOK_ALREADY_INSTALLED" ? { ok: false, reason: "HOOK_ALREADY_INSTALLED" }
        : { ok: false, reason: "SEAM_UNAVAILABLE", detail: "line_observer" };
    }
    const handler = (event) => onLocalMessage(event);
    try {
      chat.on(EVENT_NAME, handler);
    } catch (_err) {
      observer.clear(own);
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "chatRuntime_on_threw" };
    }
    consumer = fn;
    listener = handler;
    npcObserver = own;
    return { ok: true };
  }

  function uninstall() {
    if (listener !== null) {
      try {
        chat.off(EVENT_NAME, listener);
      } catch (_err) {
      }
      listener = null;
    }
    if (npcObserver !== null) {
      observer.clear(npcObserver);
      npcObserver = null;
    }
    consumer = null;
    return { ok: true };
  }

  return Object.freeze({
    install,
    uninstall,
    isInstalled: () => consumer !== null,
    stats: () => ({ installed: consumer !== null, ...counters }),
  });
}

module.exports = { createLocalTalkTap, EVENT_NAME };
