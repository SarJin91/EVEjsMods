"use strict";

const INSTALLED = Symbol.for("lne.localPilots.xmpp.installed");
const TAPPED = Symbol.for("lne.localPilots.xmpp.tapped");
const METHOD = "handleSocketForEdge";
const PRESENCE_HEAD = "<presence from='";
const STATUS_SELF = "<status code='110'/>";
const HEAD_RE = /^<presence from='([^']*)' to='([^']*)'/;
const ROOM_RE = /^(local|wormhole|triglavian|nullsec|nolocal)_(\d+)@/i;
const TRACKED_CATEGORY = "local";
const MUC_USER = "http://jabber.org/protocol/muc#user";
const DEFAULT_TYPE_ID = 1373;
const DEFAULT_MAX_BATCH_BYTES = 32 * 1024;

const rostersXmpp = new Map();
const entries = new Set();
const counters = { joins: 0, sent: 0, removed: 0, leftRooms: 0, reasserted: 0, noRecord: 0, errors: 0,
  attachSkipped: 0, twinsClosed: 0, chatSent: 0, chatRefused: 0 };
let installed = false;
let maxBatchBytes = DEFAULT_MAX_BATCH_BYTES;
let logDebug = null;
let stanzaSeq = 0;
let reassertCursor = 0;

function isPositiveInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function decodeXml(value) {
  return String(value ?? "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function nextId() {
  stanzaSeq += 1;
  return `lne-lp-${stanzaSeq}`;
}

function renderId(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? String(n) : "None";
}

function buildUserDataXml(characterId, record) {
  if (!isPositiveInt(characterId) || !record || typeof record !== "object") return null;
  const name = record.characterName;
  const corp = Number(record.corporationID);
  if (typeof name !== "string" || name === "" || !isPositiveInt(corp)) return null;
  const gender = record.gender ?? record.genderID ?? 0;
  const info = JSON.stringify([characterId, name, Number(record.typeID || DEFAULT_TYPE_ID),
    Boolean(Number(gender)), record.ownerNameID ?? null]);
  return [
    "<eve_user_data",
    ` info='${escapeXml(info)}'`,
    ` corpid='${escapeXml(corp)}'`,
    " role='0'",
    ` warfactionid='${renderId(record.warFactionID)}'`,
    ` allianceid='${renderId(record.allianceID)}'`,
    "/>",
  ].join("");
}

function buildOccupantPresenceXml(roomJid, recipientJid, domain, pilot, available) {
  const id = pilot.characterId;
  return [
    `<presence from='${escapeXml(roomJid)}/${escapeXml(id)}'`,
    ` to='${escapeXml(recipientJid)}'`,
    ` id='${escapeXml(nextId())}'`,
    available ? "" : " type='unavailable'",
    `>${pilot.userDataXml}<x xmlns='${MUC_USER}'><item affiliation='member' role='${available ? "participant" : "none"}'`,
    ` jid='${escapeXml(`${id}@${domain}`)}'/></x></presence>`,
  ].join("");
}

function buildAdminLeaveXml(roomJid, recipientJid, characterId) {
  return [
    `<message from='${escapeXml(roomJid)}/admin'`,
    ` to='${escapeXml(recipientJid)}'`,
    " type='groupchat'",
    ` id='${escapeXml(nextId())}'>`,
    `<body>${escapeXml(JSON.stringify({ cmd: "leave", charid: characterId }))}</body>`,
    "</message>",
  ].join("");
}

function buildOccupantMessageXml(roomJid, recipientJid, characterId, text) {
  return [
    `<message from='${escapeXml(roomJid)}/${escapeXml(characterId)}'`,
    ` to='${escapeXml(recipientJid)}'`,
    " type='groupchat'",
    ` id='${escapeXml(nextId())}'>`,
    `<body>${escapeXml(text)}</body>`,
    "</message>",
  ].join("");
}

function bytesOf(text) {
  return Buffer.byteLength(text, "utf8");
}

function dropEntry(entry) {
  if (!entry) return;
  entries.delete(entry);
  if (entry.slot && entry.slot.entry === entry) entry.slot.entry = null;
}

function inject(slot, stanzas) {
  const socket = slot.socket;
  if (socket.destroyed === true) {
    dropEntry(slot.entry);
    return 0;
  }
  if (stanzas.length === 0) return 0;
  let written = 0;
  let batch = [];
  let size = 0;
  const flush = () => {
    if (batch.length === 0) return true;
    if (socket.destroyed === true) {
      dropEntry(slot.entry);
      batch = [];
      return false;
    }
    slot.write.call(socket, batch.join(""));
    written += batch.length;
    counters.sent += batch.length;
    batch = [];
    size = 0;
    return true;
  };
  for (const stanza of stanzas) {
    const b = bytesOf(stanza);
    if (batch.length > 0 && size + b > maxBatchBytes && !flush()) return written;
    batch.push(stanza);
    size += b;
  }
  flush();
  return written;
}

function targetOf(systemId, nick) {
  const roster = rostersXmpp.get(systemId) || [];
  return roster.filter((p) => String(p.characterId) !== nick);
}

function leaveStanzas(entry, ids, withAdminLeave) {
  const out = [];
  for (const id of ids) {
    const userDataXml = entry.shown.get(id);
    if (userDataXml === undefined) continue;
    if (withAdminLeave) out.push(buildAdminLeaveXml(entry.roomJid, entry.recipientJid, id));
    out.push(buildOccupantPresenceXml(entry.roomJid, entry.recipientJid, entry.domain,
      { characterId: id, userDataXml }, false));
  }
  return out;
}

function syncEntry(entry, full) {
  const target = targetOf(entry.systemId, entry.nick);
  const wanted = new Map(target.map((p) => [p.characterId, p.userDataXml]));
  const removedIds = [...entry.shown.keys()].filter((id) => !wanted.has(id));
  const stanzas = leaveStanzas(entry, removedIds, true);
  let added = 0;
  for (const p of target) {
    const prev = entry.shown.get(p.characterId);
    if (prev === undefined) added += 1;
    if (full || prev !== p.userDataXml) {
      stanzas.push(buildOccupantPresenceXml(entry.roomJid, entry.recipientJid, entry.domain, p, true));
    }
  }
  inject(entry.slot, stanzas);
  if (!entries.has(entry)) return { added: 0, removed: 0 };
  for (const id of removedIds) entry.shown.delete(id);
  for (const p of target) entry.shown.set(p.characterId, p.userDataXml);
  counters.removed += removedIds.length;
  return { added, removed: removedIds.length };
}

function parseSelfPresence(data) {
  if (typeof data !== "string" || !data.startsWith(PRESENCE_HEAD) || !data.includes(STATUS_SELF)) return null;
  const m = HEAD_RE.exec(data);
  if (!m) return null;
  const from = decodeXml(m[1]);
  const to = decodeXml(m[2]);
  const slash = from.indexOf("/");
  const roomJid = slash === -1 ? from : from.slice(0, slash);
  const nick = slash === -1 ? "" : from.slice(slash + 1);
  const head = data.slice(0, data.indexOf(">") + 1);
  const unavailable = / type='unavailable'/.test(head);
  const room = ROOM_RE.exec(roomJid);
  const category = room ? room[1].toLowerCase() : null;
  const systemId = category === TRACKED_CATEGORY ? Number(room[2]) : 0;
  return { roomJid, nick, to, unavailable, category, systemId };
}

function closeEntry(entry) {
  inject(entry.slot, leaveStanzas(entry, [...entry.shown.keys()], true));
  dropEntry(entry);
  counters.leftRooms += 1;
}

function onSelfUnavailable(slot, p) {
  const entry = slot.entry;
  if (!entry || entry.roomJid !== p.roomJid) return;
  closeEntry(entry);
}

function onSelfAvailable(slot, p) {
  if (p.category === null) return;
  const old = slot.entry;
  if (old && old.roomJid !== p.roomJid) closeEntry(old);
  if (p.nick !== "") {
    for (const other of [...entries]) {
      if (other.slot === slot || other.nick !== p.nick || other.roomJid === p.roomJid) continue;
      try {
        closeEntry(other);
        counters.twinsClosed += 1;
      } catch (_err) {
        counters.errors += 1;
        dropEntry(other);
      }
    }
  }
  if (!isPositiveInt(p.systemId)) return;
  if (slot.socket.destroyed === true) return;
  const at = p.to.indexOf("@");
  const domain = at === -1 ? "" : p.to.slice(at + 1).split("/")[0];
  let entry = slot.entry;
  if (!entry) {
    entry = { slot, socket: slot.socket, write: slot.write, recipientJid: p.to, domain, roomJid: p.roomJid,
      systemId: p.systemId, nick: p.nick, shown: new Map() };
    slot.entry = entry;
  } else {
    Object.assign(entry, { recipientJid: p.to, domain, nick: p.nick });
  }
  entries.add(entry);
  counters.joins += 1;
  syncEntry(entry, true);
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
  const lneLocalTapWrite = function lneLocalTapWrite(data) {
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
  socket.write = lneLocalTapWrite;
  socket[TAPPED] = true;
  if (typeof socket.once === "function") {
    socket.once("close", () => untrack(slot));
    socket.once("error", () => untrack(slot));
  }
}

function noteError() {
  counters.errors += 1;
}

function install(xmppExports, opts) {
  if (!xmppExports || typeof xmppExports !== "object" || typeof xmppExports[METHOD] !== "function") {
    return { ok: false, reason: "NO_HANDLER" };
  }
  const o = opts || {};
  if (isPositiveInt(o.maxBatchBytes)) maxBatchBytes = o.maxBatchBytes;
  logDebug = typeof o.logDebug === "function" ? o.logDebug : null;
  const original = xmppExports[METHOD];
  if (xmppExports[INSTALLED] === true || original[INSTALLED] === true) {
    installed = true;
    return { ok: true, alreadyInstalled: true };
  }
  const wrapper = function livingNewEdenLocalPilotsXmpp(socket) {
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

function debugLine(line) {
  if (!logDebug) return;
  try {
    logDebug(line);
  } catch (_err) {
  }
}

function syncSystem(systemId, roster) {
  if (!isPositiveInt(systemId)) return { ok: false, reason: "BAD_SYSTEM" };
  if (!installed) return { ok: false, reason: "NOT_INSTALLED" };
  const list = [];
  const seen = new Set();
  for (const p of Array.isArray(roster) ? roster : []) {
    const id = p && p.characterId;
    if (!isPositiveInt(id) || seen.has(id)) {
      counters.errors += 1;
      continue;
    }
    if (p.userDataXml === null) {
      counters.noRecord += 1;
      continue;
    }
    if (typeof p.userDataXml !== "string") {
      counters.errors += 1;
      continue;
    }
    seen.add(id);
    list.push(Object.freeze({ characterId: id, userDataXml: p.userDataXml }));
  }
  if (list.length === 0) rostersXmpp.delete(systemId);
  else rostersXmpp.set(systemId, Object.freeze(list));
  let sockets = 0;
  let added = 0;
  let removed = 0;
  for (const entry of [...entries]) {
    if (entry.systemId !== systemId) continue;
    try {
      const r = syncEntry(entry, false);
      if (!entries.has(entry)) continue;
      sockets += 1;
      added += r.added;
      removed += r.removed;
    } catch (_err) {
      counters.errors += 1;
    }
  }
  if (added + removed > 0) debugLine(`localPilots xmpp: system=${systemId} sockets=${sockets} +${added} -${removed}`);
  return { ok: true, sockets, added, removed };
}

function clearAll() {
  let sockets = 0;
  let removed = 0;
  for (const entry of [...entries]) {
    try {
      const ids = [...entry.shown.keys()];
      if (ids.length > 0) {
        inject(entry.slot, leaveStanzas(entry, ids, true));
        sockets += 1;
        removed += ids.length;
      }
      entry.shown.clear();
    } catch (_err) {
      counters.errors += 1;
    }
  }
  counters.removed += removed;
  rostersXmpp.clear();
  return { ok: true, sockets, removed };
}

function reassert(maxStanzas) {
  const pairs = [];
  for (const entry of entries) {
    for (const [characterId, userDataXml] of entry.shown) pairs.push([entry, characterId, userDataXml]);
  }
  const budget = isPositiveInt(maxStanzas) ? Math.min(maxStanzas, pairs.length) : 0;
  if (budget === 0) return { ok: true, stanzas: 0, sockets: 0 };
  const start = reassertCursor % pairs.length;
  const byEntry = new Map();
  for (let i = 0; i < budget; i += 1) {
    const [entry, characterId, userDataXml] = pairs[(start + i) % pairs.length];
    const list = byEntry.get(entry) || [];
    list.push(buildOccupantPresenceXml(entry.roomJid, entry.recipientJid, entry.domain,
      { characterId, userDataXml }, true));
    byEntry.set(entry, list);
  }
  reassertCursor = (start + budget) % pairs.length;
  let stanzas = 0;
  let sockets = 0;
  for (const [entry, list] of byEntry) {
    try {
      const n = inject(entry.slot, list);
      if (n > 0) sockets += 1;
      stanzas += n;
    } catch (_err) {
      counters.errors += 1;
    }
  }
  counters.reasserted += stanzas;
  return { ok: true, stanzas, sockets };
}

function refuseChat(reason) {
  counters.chatRefused += 1;
  return { ok: false, reason };
}

function sendOccupantMessage(spec) {
  const s = spec && typeof spec === "object" ? spec : {};
  if (!isPositiveInt(s.systemId) || !isPositiveInt(s.characterId) || typeof s.text !== "string" || s.text === "") {
    return refuseChat("BAD_INPUT");
  }
  if (!installed) return refuseChat("NOT_INSTALLED");
  const roster = rostersXmpp.get(s.systemId) || [];
  if (!roster.some((p) => p.characterId === s.characterId)) return refuseChat("NOT_OCCUPANT");
  let sockets = 0;
  let tooLong = 0;
  for (const entry of [...entries]) {
    if (entry.systemId !== s.systemId || !entry.shown.has(s.characterId)) continue;
    try {
      const stanza = buildOccupantMessageXml(entry.roomJid, entry.recipientJid, s.characterId, s.text);
      if (bytesOf(stanza) > maxBatchBytes) {
        tooLong += 1;
        continue;
      }
      if (inject(entry.slot, [stanza]) > 0) sockets += 1;
    } catch (_err) {
      counters.errors += 1;
    }
  }
  if (sockets === 0) return refuseChat(tooLong > 0 ? "TOO_LONG" : "NO_SOCKET");
  counters.chatSent += sockets;
  return { ok: true, sockets };
}

function getState() {
  let shown = 0;
  const rooms = new Set();
  for (const entry of entries) {
    shown += entry.shown.size;
    rooms.add(entry.roomJid);
  }
  return { installed, sockets: entries.size, shown, rooms: rooms.size, ...counters };
}

function _resetForTest() {
  rostersXmpp.clear();
  entries.clear();
  for (const key of Object.keys(counters)) counters[key] = 0;
  installed = false;
  maxBatchBytes = DEFAULT_MAX_BATCH_BYTES;
  logDebug = null;
  stanzaSeq = 0;
  reassertCursor = 0;
}

module.exports = { install, isInstalled, syncSystem, clearAll, reassert, sendOccupantMessage, getState, noteError,
  buildOccupantPresenceXml, buildAdminLeaveXml, buildOccupantMessageXml, buildUserDataXml, _resetForTest, INSTALLED,
  METHOD, escapeXml, decodeXml };
