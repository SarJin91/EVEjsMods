"use strict";

const FILETIME_EPOCH_OFFSET_MS = 11644473600000n;
const FILETIME_TICKS_PER_MS = 10000n;
const MAX_LIMIT = 500;
const MAX_LOOKAHEAD = 256;
const MAX_ATTACKERS = 50;
const MAX_ATTACKER_CHARACTERS = 256;
const MAX_DETAIL = 200;
const CURSOR_KINDS = Object.freeze(["R", "H", ""]);

const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const inRange = (v, min, max) => Number.isSafeInteger(v) && v >= min && v <= max;
const invalid = (detail) => ({ ok: false, reason: "INVALID_INPUT", detail });

function idOf(v) {
  let n = v;
  if (typeof v === "bigint") n = Number(v);
  else if (typeof v === "string" && /^[1-9][0-9]{0,15}$/.test(v)) n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function filetimeToMs(text) {
  let ticks;
  if (typeof text === "bigint") ticks = text;
  else if (typeof text === "string" && /^[0-9]{1,24}$/.test(text)) ticks = BigInt(text);
  else return null;
  const ms = ticks / FILETIME_TICKS_PER_MS - FILETIME_EPOCH_OFFSET_MS;
  if (ms < 0n) return null;
  const n = Number(ms);
  return Number.isSafeInteger(n) ? n : null;
}

function attackerOf(a) {
  const x = a && typeof a === "object" ? a : {};
  const dmg = typeof x.damageDone === "number" && Number.isFinite(x.damageDone) && x.damageDone >= 0
    ? Math.round(x.damageDone) : 0;
  return { characterId: idOf(x.characterID), corporationId: idOf(x.corporationID), allianceId: idOf(x.allianceID),
    factionId: idOf(x.factionID), shipTypeId: idOf(x.shipTypeID), damageDone: Number.isSafeInteger(dmg) ? dmg : 0 };
}

function factOf(rec, killId, killAtMs, maxAttackers) {
  const list = Array.isArray(rec.attackers) ? rec.attackers : [];
  const chars = new Set();
  const finalCharacterId = idOf(rec.finalCharacterID);
  if (finalCharacterId !== null) chars.add(finalCharacterId);
  for (const a of list) {
    if (chars.size >= MAX_ATTACKER_CHARACTERS) break;
    const id = idOf(a && a.characterID);
    if (id !== null) chars.add(id);
  }
  const isk = typeof rec.iskLost === "number" && Number.isFinite(rec.iskLost) && rec.iskLost >= 0 ? rec.iskLost : 0;
  return {
    killId,
    killAtMs,
    systemId: idOf(rec.solarSystemID),
    victim: { characterId: idOf(rec.victimCharacterID), corporationId: idOf(rec.victimCorporationID),
      allianceId: idOf(rec.victimAllianceID), factionId: idOf(rec.victimFactionID),
      shipTypeId: idOf(rec.victimShipTypeID) },
    iskLost: isk,
    finalCharacterId,
    finalCorporationId: idOf(rec.finalCorporationID),
    attackerCount: list.length,
    attackers: list.slice(0, maxAttackers).map(attackerOf),
    attackerCharacterIds: [...chars],
  };
}

function readVendorKillsFrom(killmailState, spec) {
  const s = spec && typeof spec === "object" ? spec : null;
  if (!s) return invalid("spec");
  if (!isCount(s.afterKillId)) return invalid("afterKillId");
  if (!inRange(s.limit, 1, MAX_LIMIT)) return invalid("limit");
  if (!inRange(s.holeLookahead, 1, MAX_LOOKAHEAD)) return invalid("holeLookahead");
  if (!isCount(s.minAgeMs)) return invalid("minAgeMs");
  if (!isCount(s.nowMs)) return invalid("nowMs");
  if (!inRange(s.maxAttackers, 1, MAX_ATTACKERS)) return invalid("maxAttackers");
  if (!CURSOR_KINDS.includes(s.cursorKind)) return invalid("cursorKind");
  if (s.pendingMaxAgeMs !== undefined && !isCount(s.pendingMaxAgeMs)) return invalid("pendingMaxAgeMs");
  const km = killmailState;
  if (!km || typeof km.getKillmailRecord !== "function" || typeof km.listPendingKillmailEvents !== "function") {
    return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "killmailState" };
  }
  try {
    const pending = new Map();
    const list = km.listPendingKillmailEvents();
    for (const e of Array.isArray(list) ? list : []) {
      const id = idOf(e && e.killID);
      if (id !== null) pending.set(id, filetimeToMs(e.reservedAt));
    }
    const recordOf = (k) => {
      const r = km.getKillmailRecord(k);
      return r && typeof r === "object" ? r : null;
    };
    const laterAfter = (k) => {
      for (let j = 1; j <= s.holeLookahead; j += 1) {
        if (pending.has(k + j) || recordOf(k + j) !== null) return true;
      }
      return false;
    };
    const out = { ok: true, kills: [], cursor: s.afterKillId, cursorKind: s.cursorKind, stop: "END", holes: 0, bad: 0,
      examined: 0, stalePending: 0, pendingAgeMs: null };
    if (s.afterKillId > 0 && s.cursorKind === "R" && recordOf(s.afterKillId) === null && !pending.has(s.afterKillId)) {
      out.stop = "REWOUND";
      return out;
    }
    let k = s.afterKillId + 1;
    for (;;) {
      if (out.examined >= s.limit) {
        out.stop = "LIMIT";
        break;
      }
      if (!Number.isSafeInteger(k)) {
        out.stop = "END";
        break;
      }
      out.examined += 1;
      const rec = recordOf(k);
      if (rec !== null) {
        const killAtMs = filetimeToMs(rec.killTime);
        if (killAtMs === null) {
          out.bad += 1;
        } else if (s.nowMs - killAtMs < s.minAgeMs) {
          out.stop = "YOUNG";
          break;
        } else {
          out.kills.push(factOf(rec, k, killAtMs, s.maxAttackers));
        }
        out.cursor = k;
        out.cursorKind = "R";
        k += 1;
        continue;
      }
      if (pending.has(k)) {
        const at = pending.get(k);
        const age = at === null ? null : Math.max(0, s.nowMs - at);
        if (s.pendingMaxAgeMs !== undefined && age !== null && age > s.pendingMaxAgeMs && laterAfter(k)) {
          out.stalePending += 1;
          out.cursor = k;
          out.cursorKind = "H";
          k += 1;
          continue;
        }
        out.stop = "PENDING";
        out.pendingAgeMs = age;
        break;
      }
      if (!laterAfter(k)) {
        out.stop = "END";
        break;
      }
      out.holes += 1;
      out.cursor = k;
      out.cursorKind = "H";
      k += 1;
    }
    return out;
  } catch (err) {
    return { ok: false, reason: "VENDOR_THROW", detail: String((err && err.message) || err).slice(0, MAX_DETAIL) };
  }
}

module.exports = { readVendorKillsFrom, filetimeToMs, MAX_LIMIT, MAX_LOOKAHEAD, MAX_ATTACKERS };
