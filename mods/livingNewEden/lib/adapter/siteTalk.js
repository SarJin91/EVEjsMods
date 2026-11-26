"use strict";

const { recordOf } = require("./sessionPresence");

const MAX_DETAIL = 120;
const MAX_NAME_CHARS = 64;
const ENTRY_ROOM = "room:entry";
const MAX_LINE_CHARS = 1000;

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function toInt(v) {
  const n = Number(v);
  return Number.isSafeInteger(n) ? n : 0;
}

function textOf(v) {
  return typeof v === "string" ? v.trim().toLowerCase() : null;
}

function entryEventOf(scene, session, instance, roomKey, atMs) {
  const characterId = toInt(session && session.characterID);
  if (characterId <= 0 || !instance || typeof instance !== "object") return null;
  const rawInstance = instance.instanceID;
  const instanceId = Number.isSafeInteger(rawInstance) ? rawInstance
    : (typeof rawInstance === "string" && rawInstance !== "" ? rawInstance : null);
  if (instanceId === null) return null;
  const systemId = toInt(scene && scene.systemID) || toInt(instance.solarSystemID);
  const meta = instance.metadata && typeof instance.metadata === "object" ? instance.metadata : null;
  const factionId = toInt(instance.factionID || (meta && meta.factionID));
  const room = String(roomKey == null ? "" : roomKey).trim() || ENTRY_ROOM;
  const name = typeof session.characterName === "string" ? session.characterName.trim().slice(0, MAX_NAME_CHARS) : "";
  return Object.freeze({ characterId, systemId, instanceId, roomKey: room, siteKind: textOf(instance.siteKind),
    siteFamily: textOf(instance.siteFamily), factionId: factionId > 0 ? factionId : null, pilotName: name || null,
    atMs });
}

function createSiteEntryHook(deps) {
  const target = deps && deps.trackingExports;
  const onEnter = deps && deps.onEnter;
  const now = deps && typeof deps.now === "function" ? deps.now : null;
  const logger = deps && deps.logger && typeof deps.logger.log === "function" ? deps.logger : null;
  const counts = { events: 0, consumerErrors: 0 };
  let installed = false;
  let active = false;
  let original = null;
  let wrapper = null;
  let loggedError = false;

  function log(line) {
    if (!logger) return;
    try {
      logger.log(line);
    } catch (_err) {
    }
  }

  function emit(scene, session, instance, roomKey) {
    try {
      const ev = entryEventOf(scene, session, instance, roomKey, now());
      if (ev === null) return;
      counts.events += 1;
      onEnter(ev);
    } catch (err) {
      counts.consumerErrors += 1;
      if (!loggedError) {
        loggedError = true;
        log(`site entry hook: consumer failed - ${messageOf(err)}`);
      }
    }
  }

  function install() {
    if (installed) return { ok: false, reason: "HOOK_ALREADY_INSTALLED" };
    if (!target || typeof target.enterDungeonRoomForSession !== "function" || typeof onEnter !== "function"
      || now === null) {
      return { ok: false, reason: "HOOK_SEAM_UNAVAILABLE" };
    }
    original = target.enterDungeonRoomForSession;
    const base = original;
    wrapper = function lneSiteEntry(scene, session, instance, roomKey) {
      const out = base.apply(this, arguments);
      if (active && out === true) emit(scene, session, instance, roomKey);
      return out;
    };
    target.enterDungeonRoomForSession = wrapper;
    installed = true;
    active = true;
    return { ok: true };
  }

  function uninstall() {
    active = false;
    if (installed && target && target.enterDungeonRoomForSession === wrapper) {
      target.enterDungeonRoomForSession = original;
    }
    installed = false;
  }

  return Object.freeze({ install, uninstall, stats: () => ({ ...counts }) });
}

function sendCharacterSystemLineWith(registryExports, chatHubExports, spec) {
  const characterId = spec && spec.characterId;
  const systemId = spec && spec.systemId;
  const text = spec && spec.text;
  if (!Number.isSafeInteger(characterId) || characterId <= 0 || !Number.isSafeInteger(systemId) || systemId <= 0
    || typeof text !== "string" || text.trim() === "" || text.length > MAX_LINE_CHARS) {
    return { ok: false, reason: "BAD_INPUT" };
  }
  if (!registryExports || typeof registryExports.getSessions !== "function"
    || !chatHubExports || typeof chatHubExports.sendSystemMessage !== "function") {
    return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "getSessions_or_sendSystemMessage" };
  }
  let session = null;
  let rec = null;
  try {
    const sessions = registryExports.getSessions();
    if (!sessions || typeof sessions[Symbol.iterator] !== "function") {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "getSessions_no_list" };
    }
    for (const s of sessions) {
      const r = recordOf(s);
      if (r === null || r.characterId !== characterId) continue;
      session = s;
      rec = r;
      break;
    }
  } catch (err) {
    return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `getSessions_threw:${messageOf(err)}` };
  }
  if (session === null) return { ok: false, reason: "NO_SESSION" };
  if (rec.systemId !== systemId) return { ok: false, reason: "LEFT_SYSTEM" };
  try {
    chatHubExports.sendSystemMessage(session, text);
  } catch (err) {
    return { ok: false, reason: "SEND_THREW", detail: messageOf(err) };
  }
  return { ok: true };
}

module.exports = { createSiteEntryHook, sendCharacterSystemLineWith, entryEventOf };
