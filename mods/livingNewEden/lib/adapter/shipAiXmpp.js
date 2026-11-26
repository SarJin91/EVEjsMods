"use strict";

const LP = require("./localPilotsXmpp");

const INSTALLED = Symbol.for("lne.shipAi.xmpp.installed");
const TAPPED = Symbol.for("lne.shipAi.xmpp.tapped");
const METHOD = "handleSocketForEdge";
const PRESENCE_HEAD = "<presence from='";
const STATUS_SELF = "<status code='110'/>";
const HEAD_RE = /^<presence from='([^']*)' to='([^']*)'/;
const ROOM_RE = /^(private_(\d+)_(\d+))@/i;
const DEFAULT_MAX_BATCH_BYTES = 32 * 1024;

const pairs = new Map();
const entries = new Set();
const counters = { joins: 0, presences: 0, sent: 0, refused: 0, errors: 0, attachSkipped: 0 };
let installed = false;
let maxBatchBytes = DEFAULT_MAX_BATCH_BYTES;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const bytesOf = (text) => Buffer.byteLength(text, "utf8");

function roomNameOf(a, b) {
  return a <= b ? `private_${a}_${b}` : `private_${b}_${a}`;
}

function dropEntry(entry) {
  if (!entry) return;
  entries.delete(entry);
  if (entry.slot && entry.slot.entry === entry) entry.slot.entry = null;
}

function writeTo(entry, stanza) {
  const socket = entry.slot.socket;
  if (socket.destroyed === true) {
    dropEntry(entry);
    return false;
  }
  entry.slot.write.call(socket, stanza);
  return true;
}

function parseSelfPresence(data) {
  if (typeof data !== "string" || !data.startsWith(PRESENCE_HEAD) || !data.includes(STATUS_SELF)) return null;
  const m = HEAD_RE.exec(data);
  if (!m) return null;
  const from = LP.decodeXml(m[1]);
  const slash = from.indexOf("/");
  const roomJid = slash === -1 ? from : from.slice(0, slash);
  const room = ROOM_RE.exec(roomJid);
  if (!room) return null;
  const head = data.slice(0, data.indexOf(">") + 1);
  return { roomJid, roomName: room[1].toLowerCase(), nick: slash === -1 ? "" : from.slice(slash + 1),
    to: LP.decodeXml(m[2]), unavailable: / type='unavailable'/.test(head) };
}

function onSelfUnavailable(slot, p) {
  if (slot.entry && slot.entry.roomJid === p.roomJid) dropEntry(slot.entry);
}

function onSelfAvailable(slot, p) {
  const playerId = Number(p.nick);
  const pair = isId(playerId) ? pairs.get(playerId) : undefined;
  if (!pair || pair.roomName !== p.roomName || slot.socket.destroyed === true) return;
  const at = p.to.indexOf("@");
  const domain = at === -1 ? "" : p.to.slice(at + 1).split("/")[0];
  let entry = slot.entry;
  if (entry && entry.roomJid !== p.roomJid) dropEntry(entry);
  entry = slot.entry;
  if (!entry) {
    entry = { slot, roomJid: p.roomJid, recipientJid: p.to, domain, playerId, aiId: pair.aiId, shown: false };
    slot.entry = entry;
    entries.add(entry);
    counters.joins += 1;
  }
  if (entry.shown && entry.aiId === pair.aiId) return;
  const stanza = LP.buildOccupantPresenceXml(entry.roomJid, entry.recipientJid, entry.domain,
    { characterId: pair.aiId, userDataXml: pair.userDataXml }, true);
  if (writeTo(entry, stanza)) {
    entry.shown = true;
    entry.aiId = pair.aiId;
    counters.presences += 1;
  }
}

function untrack(slot) {
  dropEntry(slot.entry);
}

function attach(socket) {
  if (!socket || (typeof socket !== "object" && typeof socket !== "function") || typeof socket.write !== "function") {
    counters.attachSkipped += 1;
    return;
  }
  if (socket[TAPPED] === true) return;
  const slot = { socket, write: socket.write, entry: null };
  const lneShipAiTapWrite = function lneShipAiTapWrite(data) {
    let p = null;
    try {
      p = parseSelfPresence(data);
    } catch (_err) {
      counters.errors += 1;
      p = null;
    }
    if (!p) return slot.write.apply(socket, arguments);
    if (p.unavailable) {
      try {
        onSelfUnavailable(slot, p);
      } catch (_err) {
        counters.errors += 1;
      }
      return slot.write.apply(socket, arguments);
    }
    const result = slot.write.apply(socket, arguments);
    try {
      onSelfAvailable(slot, p);
    } catch (_err) {
      counters.errors += 1;
    }
    return result;
  };
  socket.write = lneShipAiTapWrite;
  socket[TAPPED] = true;
  if (typeof socket.once === "function") {
    socket.once("close", () => untrack(slot));
    socket.once("error", () => untrack(slot));
  }
}

function install(xmppExports, opts) {
  if (!xmppExports || typeof xmppExports !== "object" || typeof xmppExports[METHOD] !== "function") {
    return { ok: false, reason: "NO_HANDLER" };
  }
  const o = opts || {};
  if (isId(o.maxBatchBytes)) maxBatchBytes = o.maxBatchBytes;
  const original = xmppExports[METHOD];
  if (xmppExports[INSTALLED] === true || original[INSTALLED] === true) {
    installed = true;
    return { ok: true, alreadyInstalled: true };
  }
  const wrapper = function livingNewEdenShipAiXmpp(socket) {
    try {
      attach(socket);
    } catch (_err) {
      counters.errors += 1;
    }
    return original.apply(this, arguments);
  };
  wrapper[INSTALLED] = true;
  xmppExports[METHOD] = wrapper;
  if (xmppExports[METHOD] !== wrapper) return { ok: false, reason: "NO_HANDLER" };
  xmppExports[INSTALLED] = true;
  installed = true;
  return { ok: true, alreadyInstalled: false };
}

function isInstalled() {
  return installed;
}

function registerPair(spec) {
  const s = spec && typeof spec === "object" ? spec : {};
  if (!isId(s.playerId) || !isId(s.aiId) || s.playerId === s.aiId || typeof s.userDataXml !== "string"
    || s.userDataXml === "") {
    return { ok: false, reason: "BAD_INPUT" };
  }
  pairs.set(s.playerId, Object.freeze({ aiId: s.aiId, roomName: roomNameOf(s.playerId, s.aiId),
    userDataXml: s.userDataXml }));
  return { ok: true };
}

function clearPairs() {
  pairs.clear();
  for (const entry of entries) entry.shown = false;
}

function refuse(reason) {
  counters.refused += 1;
  return { ok: false, reason };
}

function sendAiMessage(spec) {
  const s = spec && typeof spec === "object" ? spec : {};
  if (!isId(s.playerId) || !isId(s.aiId) || typeof s.text !== "string" || s.text === "") return refuse("BAD_INPUT");
  if (!installed) return refuse("NOT_INSTALLED");
  const pair = pairs.get(s.playerId);
  if (!pair || pair.aiId !== s.aiId) return refuse("NO_ROOM");
  let sockets = 0;
  let tooLong = 0;
  for (const entry of [...entries]) {
    if (entry.playerId !== s.playerId || entry.aiId !== s.aiId) continue;
    try {
      const stanza = LP.buildOccupantMessageXml(entry.roomJid, entry.recipientJid, s.aiId, s.text);
      if (bytesOf(stanza) > maxBatchBytes) {
        tooLong += 1;
        continue;
      }
      if (writeTo(entry, stanza)) sockets += 1;
    } catch (_err) {
      counters.errors += 1;
    }
  }
  if (sockets === 0) return refuse(tooLong > 0 ? "TOO_LONG" : "NO_ROOM");
  counters.sent += sockets;
  return { ok: true, sockets };
}

function hasOpenRoom(playerId) {
  for (const entry of entries) {
    if (entry.playerId === playerId) return true;
  }
  return false;
}

function getState() {
  const rooms = new Set();
  for (const entry of entries) rooms.add(entry.roomJid);
  return { installed, sockets: entries.size, pairs: pairs.size, rooms: rooms.size, ...counters };
}

function _resetForTest() {
  pairs.clear();
  entries.clear();
  for (const key of Object.keys(counters)) counters[key] = 0;
  installed = false;
  maxBatchBytes = DEFAULT_MAX_BATCH_BYTES;
}

module.exports = { install, isInstalled, registerPair, clearPairs, sendAiMessage, hasOpenRoom, getState,
  _resetForTest, INSTALLED, TAPPED, METHOD };
