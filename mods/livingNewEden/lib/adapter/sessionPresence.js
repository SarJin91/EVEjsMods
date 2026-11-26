"use strict";

const MAX_NAME_CHARS = 64;
const UNKNOWN_NAME = "Unknown";
const REASON = "SESSIONS_UNAVAILABLE";

function toInt(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : 0;
}

function messageOf(err) {
  return String((err && err.message) || err);
}

function recordOf(session) {
  if (session === null || typeof session !== "object") return null;
  const characterId = toInt(session.characterID || session.charid);
  if (characterId <= 0) return null;
  const docked = Boolean(session.stationid || session.stationID || session.structureid || session.structureID);
  const space = session._space && typeof session._space === "object" ? session._space : null;
  const state = docked ? "docked" : (space ? "space" : "transit");
  const systemId = docked
    ? toInt(session.solarsystemid2 || session.solarsystemid)
    : toInt((space && space.systemID) || session.solarsystemid2 || session.solarsystemid);
  if (systemId <= 0) return null;
  const name = String(session.characterName || "").trim().slice(0, MAX_NAME_CHARS) || UNKNOWN_NAME;
  return { characterId, name, systemId, state };
}

function compareRecords(a, b) {
  if (a.systemId !== b.systemId) return a.systemId - b.systemId;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.characterId - b.characterId;
}

function readPresenceFrom(registryExports, opts = {}) {
  if (!registryExports || typeof registryExports.getSessions !== "function") {
    return { ok: false, reason: REASON, detail: "getSessions missing" };
  }
  let sessions;
  try {
    sessions = registryExports.getSessions();
  } catch (err) {
    return { ok: false, reason: REASON, detail: `getSessions threw: ${messageOf(err)}` };
  }
  if (!sessions || typeof sessions[Symbol.iterator] !== "function") {
    return { ok: false, reason: REASON, detail: "getSessions returned no list" };
  }
  const seen = new Set();
  const records = [];
  try {
    for (const session of sessions) {
      const r = recordOf(session);
      if (r === null || seen.has(r.characterId)) continue;
      seen.add(r.characterId);
      records.push(r);
    }
  } catch (err) {
    return { ok: false, reason: REASON, detail: `session read threw: ${messageOf(err)}` };
  }
  records.sort(compareRecords);
  const max = Number.isSafeInteger(opts.maxCharacters) && opts.maxCharacters > 0 ? opts.maxCharacters : records.length;
  if (records.length <= max) return { ok: true, characters: records, truncated: false, overflowSystems: [] };
  const characters = records.slice(0, max);
  const kept = new Set(characters.map((r) => r.systemId));
  const overflow = new Set();
  for (let i = max; i < records.length; i += 1) {
    if (!kept.has(records[i].systemId)) overflow.add(records[i].systemId);
  }
  return { ok: true, characters, truncated: true, overflowSystems: [...overflow].sort((a, b) => a - b) };
}

module.exports = { MAX_NAME_CHARS, readPresenceFrom, recordOf };
