"use strict";

const xmppTap = require("./localPilotsXmpp");

const INSTALLED = Symbol.for("lne.localPilots.installed");
const EVENT_NAME = "local-membership-list";
const CHAT_RUNTIME = "_secondary/chat/chatRuntime";
const CHANNEL_RULES = "services/chat/channelRules";
const CHARACTER_STATE = "services/character/characterState";
const MAX_DETAIL = 120;

const rosters = new Map();
const counters = { appended: 0, skippedDuplicates: 0, augmentErrors: 0 };
let installed = false;
let occupantLineObserver = null;
const observerCounters = { notified: 0, observerErrors: 0 };

function setOccupantLineObserver(fn) {
  if (typeof fn !== "function") return { ok: false, reason: "BAD_INPUT" };
  if (occupantLineObserver !== null) return { ok: false, reason: "HOOK_ALREADY_INSTALLED" };
  occupantLineObserver = fn;
  return { ok: true };
}

function clearOccupantLineObserver(fn) {
  if (occupantLineObserver === fn) occupantLineObserver = null;
  return { ok: true };
}

function notifyOccupantLine(spec) {
  const observer = occupantLineObserver;
  if (observer === null) return;
  try {
    observerCounters.notified += 1;
    observer({ systemId: spec.systemId, characterId: spec.characterId, text: spec.text });
  } catch (_err) {
    observerCounters.observerErrors += 1;
  }
}

function isPositiveInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function memberIdOf(member) {
  return member && member.character ? member.character.sequential : undefined;
}

function augmentMembershipEvent(event) {
  try {
    if (!event || typeof event !== "object" || !Array.isArray(event.members)) {
      counters.augmentErrors += 1;
      return;
    }
    if (rosters.size === 0) return;
    const roster = rosters.get(Number(event.solarSystemID));
    if (!roster || roster.length === 0) return;
    const members = event.members;
    const present = new Set();
    for (const m of members) present.add(memberIdOf(m));
    for (const entry of roster) {
      const id = memberIdOf(entry);
      if (present.has(id)) {
        counters.skippedDuplicates += 1;
        continue;
      }
      present.add(id);
      members.push(entry);
      counters.appended += 1;
    }
  } catch (_err) {
    counters.augmentErrors += 1;
  }
}

function install(chatRuntimeExports) {
  if (!chatRuntimeExports || typeof chatRuntimeExports !== "object" || typeof chatRuntimeExports.on !== "function") {
    return { ok: false, reason: "NO_ON" };
  }
  if (chatRuntimeExports[INSTALLED] === true) {
    installed = true;
    return { ok: true, alreadyInstalled: true };
  }
  chatRuntimeExports.on(EVENT_NAME, augmentMembershipEvent);
  chatRuntimeExports[INSTALLED] = true;
  installed = true;
  return { ok: true, alreadyInstalled: false };
}

function freezeMember(member) {
  for (const key of ["character", "corporation", "alliance", "faction"]) {
    if (member[key] && typeof member[key] === "object") Object.freeze(member[key]);
  }
  return Object.freeze(member);
}

function createLocalPilotsSeam(deps) {
  const requireGame = deps && typeof deps.requireGame === "function"
    ? deps.requireGame : () => ({ ok: false, reason: "no_require_game" });

  function load(rel, names) {
    const loaded = requireGame(rel);
    if (!loaded || !loaded.ok) {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `${rel}: ${(loaded && loaded.reason) || "unknown"}` };
    }
    const exp = loaded.exports;
    for (const name of names) {
      if (!exp || typeof exp[name] !== "function") {
        return { ok: false, reason: "SEAM_UNAVAILABLE", detail: `${rel}.${name}` };
      }
    }
    return { ok: true, exports: exp };
  }

  function setRoster(systemId, members) {
    if (!isPositiveInt(systemId)) return { ok: false, reason: "BAD_SYSTEM" };
    if (!installed) return { ok: false, reason: "NOT_INSTALLED" };
    if (!Array.isArray(members)) return { ok: false, reason: "BAD_MEMBERS" };
    let copy;
    try {
      copy = members.slice();
      if (!copy.every((m) => isPositiveInt(memberIdOf(m)))) return { ok: false, reason: "BAD_MEMBERS" };
    } catch (_err) {
      return { ok: false, reason: "BAD_MEMBERS" };
    }
    if (copy.length === 0) rosters.delete(systemId);
    else rosters.set(systemId, Object.freeze(copy));
    syncXmpp(systemId, copy);
    return { ok: true, size: copy.length };
  }

  function syncXmpp(systemId, copy) {
    if (!xmppTap.isInstalled()) return;
    try {
      const state = copy.length > 0 ? load(CHARACTER_STATE, ["peekCharacterRecord"]) : { ok: true, exports: null };
      const list = copy.map((m) => {
        const characterId = memberIdOf(m);
        if (!state.ok) return { characterId, userDataXml: undefined };
        try {
          return { characterId,
            userDataXml: xmppTap.buildUserDataXml(characterId, state.exports.peekCharacterRecord(characterId)) };
        } catch (_err) {
          return { characterId, userDataXml: undefined };
        }
      });
      xmppTap.syncSystem(systemId, list);
    } catch (_err) {
      try {
        xmppTap.noteError();
      } catch (_e) {
      }
    }
  }

  function clearRosters() {
    const systems = [...rosters.keys()].sort((a, b) => a - b);
    rosters.clear();
    try {
      if (xmppTap.isInstalled()) xmppTap.clearAll();
    } catch (_err) {
    }
    return { ok: true, systems };
  }

  function reassertXmpp(maxStanzas) {
    if (!xmppTap.isInstalled()) return { ok: false, reason: "NOT_INSTALLED" };
    try {
      return xmppTap.reassert(maxStanzas);
    } catch (_err) {
      return { ok: false, reason: "REASSERT_FAILED" };
    }
  }

  function repushSystem(systemId) {
    if (!isPositiveInt(systemId)) return { ok: false, reason: "BAD_SYSTEM" };
    const chat = load(CHAT_RUNTIME, ["getLocalSessionsForRoom", "publishLocalMembershipListForSession"]);
    if (!chat.ok) return chat;
    const rules = load(CHANNEL_RULES, ["getLocalChatRoomNameForSolarSystemID"]);
    if (!rules.ok) return rules;
    let sessions;
    try {
      const roomName = rules.exports.getLocalChatRoomNameForSolarSystemID(systemId);
      const found = chat.exports.getLocalSessionsForRoom(roomName);
      sessions = Array.isArray(found) ? found : [];
    } catch (err) {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: messageOf(err) };
    }
    let failed = 0;
    for (const session of sessions) {
      try {
        chat.exports.publishLocalMembershipListForSession(session);
      } catch (_err) {
        failed += 1;
      }
    }
    return { ok: true, sessions: sessions.length, failed };
  }

  function isNormalLocal(systemId) {
    if (!isPositiveInt(systemId)) return { ok: false, reason: "BAD_SYSTEM" };
    const rules = load(CHANNEL_RULES, ["getLocalChatRoomNameForSolarSystemID", "isDelayedLocalChatRoomName"]);
    if (!rules.ok) return rules;
    try {
      const roomName = rules.exports.getLocalChatRoomNameForSolarSystemID(systemId);
      return { ok: true, normal: rules.exports.isDelayedLocalChatRoomName(roomName) !== true };
    } catch (err) {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: messageOf(err) };
    }
  }

  function describeCharacter(characterId) {
    if (!isPositiveInt(characterId)) return { ok: false, reason: "BAD_ID" };
    const state = load(CHARACTER_STATE, ["peekCharacterRecord"]);
    if (!state.ok) return state;
    const chat = load(CHAT_RUNTIME, ["buildLocalGatewayMember"]);
    if (!chat.ok) return chat;
    try {
      const record = state.exports.peekCharacterRecord(characterId);
      if (!record || typeof record !== "object") return { ok: false, reason: "NO_RECORD" };
      const corporationId = Number(record.corporationID);
      if (!isPositiveInt(corporationId)) return { ok: false, reason: "NO_CORPORATION" };
      const alliance = Number(record.allianceID);
      const allianceId = isPositiveInt(alliance) ? alliance : 0;
      const member = chat.exports.buildLocalGatewayMember({ characterID: characterId, corporationID: corporationId,
        allianceID: allianceId, warFactionID: 0, role: 0 });
      if (!member || typeof member !== "object" || memberIdOf(member) !== characterId) {
        return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "buildLocalGatewayMember shape" };
      }
      return { ok: true, characterId, corporationId, allianceId, member: freezeMember(member) };
    } catch (err) {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: messageOf(err) };
    }
  }

  function sendOccupantMessage(spec) {
    if (!xmppTap.isInstalled()) return { ok: false, reason: "NOT_INSTALLED" };
    let result;
    try {
      result = xmppTap.sendOccupantMessage(spec);
    } catch (_err) {
      return { ok: false, reason: "SEND_FAILED" };
    }
    if (result && result.ok === true) notifyOccupantLine(spec);
    return result;
  }

  function getState() {
    let pilots = 0;
    for (const list of rosters.values()) pilots += list.length;
    return { installed, systems: rosters.size, pilots, ...counters, xmpp: xmppTap.getState() };
  }

  function rosterSize(systemId) {
    if (!isPositiveInt(systemId)) return { ok: false, reason: "BAD_SYSTEM" };
    if (!installed) return { ok: false, reason: "NOT_INSTALLED" };
    const list = rosters.get(systemId);
    return { ok: true, pilots: list ? list.length : 0 };
  }

  return { setRoster, clearRosters, repushSystem, isNormalLocal, describeCharacter, reassertXmpp, sendOccupantMessage,
    getState, rosterSize };
}

function _resetForTest() {
  rosters.clear();
  counters.appended = 0;
  counters.skippedDuplicates = 0;
  counters.augmentErrors = 0;
  installed = false;
  occupantLineObserver = null;
  observerCounters.notified = 0;
  observerCounters.observerErrors = 0;
}

function occupantLineObserverState() {
  return { observed: occupantLineObserver !== null, ...observerCounters };
}

module.exports = { install, augmentMembershipEvent, createLocalPilotsSeam, _resetForTest, INSTALLED, EVENT_NAME,
  setOccupantLineObserver, clearOccupantLineObserver, occupantLineObserverState };
