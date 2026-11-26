"use strict";

const SEND = "sendChannelMessage";
const MAX_DETAIL = 120;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const detailOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);

function roomNameOf(a, b) {
  const x = Number(a);
  const y = Number(b);
  return x <= y ? `private_${x}_${y}` : `private_${y}_${x}`;
}

function charIdOf(session) {
  if (!session || typeof session !== "object") return 0;
  const n = Number(session.characterID || session.charid || session.userid || 0);
  return isId(n) ? n : 0;
}

function createShipAiChannel(deps) {
  const d = deps || {};
  const chat = d.chatRuntimeExports;
  const xmpp = d.xmppExports;
  const now = typeof d.now === "function" ? d.now : () => Date.now();
  const defer = typeof d.defer === "function" ? d.defer : (fn) => setImmediate(fn);
  const logger = d.logger && typeof d.logger.log === "function" ? d.logger : null;
  let installed = false;
  let active = false;
  let original = null;
  let wrapper = null;

  const log = (line) => {
    if (!logger) return;
    try {
      logger.log(line);
    } catch (_err) {
    }
  };

  const aiLineOf = (session, roomName, message) => {
    try {
      const text = typeof message === "string" ? message.trim() : String(message ?? "").trim();
      if (text === "") return null;
      const senderId = charIdOf(session);
      if (!isId(senderId) || typeof roomName !== "string") return null;
      return d.isAiRoom(roomName, senderId) === true ? { senderId, text } : null;
    } catch (err) {
      log(`shipAi channel: room check failed - ${detailOf(err)}`);
      return null;
    }
  };

  function install() {
    if (installed) return { ok: false, reason: "HOOK_ALREADY_INSTALLED" };
    if (!chat || typeof chat[SEND] !== "function" || typeof d.isAiRoom !== "function"
      || typeof d.onRoomMessage !== "function") {
      return { ok: false, reason: "HOOK_SEAM_UNAVAILABLE" };
    }
    original = chat[SEND];
    const base = original;
    wrapper = function lneShipAiChannel(session, roomName, message) {
      const hit = active ? aiLineOf(session, roomName, message) : null;
      if (!hit) return base.apply(this, arguments);
      const createdAtMs = now();
      const text = hit.text;
      const playerId = hit.senderId;
      defer(() => {
        try {
          d.onRoomMessage(playerId, text);
        } catch (err) {
          log(`shipAi channel: room message handler failed - ${detailOf(err)}`);
        }
      });
      return { record: { roomName }, entry: { roomName, characterID: playerId, message: "", createdAtMs } };
    };
    chat[SEND] = wrapper;
    if (chat[SEND] !== wrapper) return { ok: false, reason: "HOOK_SEAM_UNAVAILABLE" };
    installed = true;
    active = true;
    return { ok: true };
  }

  function uninstall() {
    active = false;
    if (installed && chat && chat[SEND] === wrapper) chat[SEND] = original;
    installed = false;
  }

  function ensureRoom(playerId, aiId) {
    if (!isId(playerId) || !isId(aiId) || playerId === aiId) {
      return { ok: false, reason: "ROOM_FAILED", detail: "pair" };
    }
    if (!chat || typeof chat.ensurePrivateChannelForCharacters !== "function") {
      return { ok: false, reason: "ROOM_FAILED", detail: "ensurePrivateChannelForCharacters" };
    }
    try {
      const record = chat.ensurePrivateChannelForCharacters(playerId, aiId, { persistBacklog: false });
      if (!record || typeof record !== "object") return { ok: false, reason: "ROOM_FAILED", detail: "no record" };
      if (record.roomName !== roomNameOf(playerId, aiId)) {
        return { ok: false, reason: "ROOM_FAILED", detail: `room ${String(record.roomName).slice(0, 60)}` };
      }
      return { ok: true, record };
    } catch (err) {
      return { ok: false, reason: "ROOM_FAILED", detail: detailOf(err) };
    }
  }

  function invite(playerId, aiId, reason) {
    if (!isId(playerId) || !isId(aiId)) return { ok: false, reason: "INVITE_FAILED", detail: "pair" };
    if (!xmpp || typeof xmpp.inviteCharacterToRoom !== "function") {
      return { ok: false, reason: "INVITE_FAILED", detail: "inviteCharacterToRoom" };
    }
    try {
      const sent = xmpp.inviteCharacterToRoom(roomNameOf(playerId, aiId), aiId, playerId, String(reason ?? ""));
      return sent === true ? { ok: true } : { ok: false, reason: "NO_CLIENT" };
    } catch (err) {
      return { ok: false, reason: "INVITE_FAILED", detail: detailOf(err) };
    }
  }

  return Object.freeze({ install, uninstall, ensureRoom, invite, isActive: () => active });
}

module.exports = { createShipAiChannel, roomNameOf, charIdOf };
