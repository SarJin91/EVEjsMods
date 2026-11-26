"use strict";

const EVENT_TYPE = "STANDING_GRANT";
const DAY_MS = 86400000;
const KEY_PREFIX = "lne:std:";
const RANGE_END_CHAR = ";";
const KILL_SLOT_MARK = "k";
const ATTACK_SLOT_MARK = "a";
const CONVOY_KILL_SLOT_MARK = "ck";
const CONVOY_ATTACK_SLOT_MARK = "ca";
const PIRATE_KILL_SLOT_MARK = "pk";

const STANDINGS_ROWS = 3;

const BASIS = Object.freeze({ PIRATE_HELD: "PIRATE_HELD", CONTESTED: "CONTESTED", PIRATE_SIDE: "PIRATE_SIDE" });
const SOURCE = Object.freeze({ FIGHTER: "FIGHTER", REGION: "REGION", SDE_SYSTEM: "SDE_SYSTEM", RIVAL: "RIVAL" });
const REASON = "PIRATE_SUPPRESSION";
const REASON_NAVY = "NAVY_AGGRESSION";
const REASON_PIRATE_SIDE = "PIRATE_ALLEGIANCE";
const REASON_CONVOY = "CONVOY_AGGRESSION";
const REASON_PIRATE_KILL = "PIRATE_KILL";

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;

const dayOf = (atMs) => Math.floor(atMs / DAY_MS);
const windowOf = (atMs, windowMs) => (windowMs > 0 ? Math.floor(atMs / windowMs) : null);
const dayPrefix = (characterId, day) => `${KEY_PREFIX}${characterId}:${day}:`;
const dayRangeEnd = (prefix) => `${prefix.slice(0, -1)}${RANGE_END_CHAR}`;

const windowOff = (g) => g.window === null || g.window === undefined;

function grantKey(g) {
  const victim = isId(g.victimId) ? `.${g.victimId}` : "";
  const slot = windowOff(g) ? `${KILL_SLOT_MARK}${g.atMs}${victim}` : String(g.window);
  return `${dayPrefix(g.characterId, g.day)}${g.factionId}:${g.systemId}:${slot}`;
}

function navyAttackKey(g) {
  return `${dayPrefix(g.characterId, g.day)}${g.factionId}:${g.systemId}:${ATTACK_SLOT_MARK}${g.window}`;
}

function convoyKillKey(g) {
  const victim = isId(g.victimId) ? `.${g.victimId}` : "";
  return `${dayPrefix(g.characterId, g.day)}${g.factionId}:${g.systemId}:${CONVOY_KILL_SLOT_MARK}${g.atMs}${victim}`;
}

function convoyAttackKey(g) {
  return `${dayPrefix(g.characterId, g.day)}${g.factionId}:${g.systemId}:${CONVOY_ATTACK_SLOT_MARK}${g.window}`;
}

function pirateKillKey(g) {
  const victim = isId(g.victimId) ? `.${g.victimId}` : "";
  return `${dayPrefix(g.characterId, g.day)}${g.factionId}:${g.systemId}:${PIRATE_KILL_SLOT_MARK}${g.atMs}${victim}`;
}

const isPirateKillSlot = (slot) => typeof slot === "string" && slot.startsWith(PIRATE_KILL_SLOT_MARK);

const isConvoySlot = (slot) => typeof slot === "string"
  && (slot.startsWith(CONVOY_KILL_SLOT_MARK) || slot.startsWith(CONVOY_ATTACK_SLOT_MARK));

function legacyGrantKey(g) {
  if (!windowOff(g) || !isId(g.victimId)) return null;
  return grantKey({ ...g, victimId: undefined });
}

const STALE_KILL_MS = DAY_MS;
const PRUNE_EVENT_TYPE = "STANDINGS_PRUNE";
const PRUNE_KEY_PREFIX = "lne:stdprune:";
const PRUNE_KEY_RANGE_END = "lne:stdprune;";
const KEY_RANGE_END = `${KEY_PREFIX.slice(0, -1)}${RANGE_END_CHAR}`;
const PRUNE_CHAIN_PURGE = 2;
const PRUNE_ROWS_FIXED = 4;

const GRANT_KEY_RE = /^lne:std:(\d+):(\d+):(\d+):(\d+):(k\d+(?:\.\d+)?|a\d+|ck\d+(?:\.\d+)?|ca\d+|pk\d+(?:\.\d+)?|\d+)$/;

const pruneKey = (intervalMs, bucket) => `${PRUNE_KEY_PREFIX}${intervalMs}:${bucket}`;
const dayEndMs = (day) => (day + 1) * DAY_MS;
const charRange = (characterId) => ({ from: `${KEY_PREFIX}${characterId}:`,
  to: `${KEY_PREFIX}${characterId}${RANGE_END_CHAR}` });

function parseGrantKey(key) {
  if (typeof key !== "string") return null;
  const m = GRANT_KEY_RE.exec(key);
  if (!m) return null;
  const [characterId, day, factionId, systemId] = [m[1], m[2], m[3], m[4]].map(Number);
  if (!isId(characterId) || !isTime(day) || !isId(factionId) || !isId(systemId)) return null;
  return { characterId, day, factionId, systemId, slot: m[5] };
}

function characterOfKey(key) {
  if (typeof key !== "string" || !key.startsWith(KEY_PREFIX)) return null;
  const end = key.indexOf(":", KEY_PREFIX.length);
  const id = Number(end < 0 ? NaN : key.slice(KEY_PREFIX.length, end));
  return isId(id) && String(id) === key.slice(KEY_PREFIX.length, end) ? id : null;
}

const PAYLOAD_KEYS = "characterId,factionId,journalId,rawChange,systemId";

function parsePayload(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return null;
  if (Object.keys(p).sort().join() !== PAYLOAD_KEYS) return null;
  if (!isId(p.characterId) || !isId(p.factionId) || !isId(p.journalId) || !isId(p.systemId)) return null;
  if (typeof p.rawChange !== "number" || !Number.isFinite(p.rawChange) || p.rawChange === 0) return null;
  return { characterId: p.characterId, factionId: p.factionId, journalId: p.journalId, rawChange: p.rawChange,
    systemId: p.systemId };
}

module.exports = { EVENT_TYPE, DAY_MS, KEY_PREFIX, STANDINGS_ROWS, BASIS, SOURCE, REASON, REASON_NAVY,
  REASON_PIRATE_SIDE, REASON_CONVOY, CONVOY_KILL_SLOT_MARK, CONVOY_ATTACK_SLOT_MARK, isId, isTime,
  dayOf, windowOf, dayPrefix, dayRangeEnd, grantKey, legacyGrantKey, navyAttackKey, convoyKillKey, convoyAttackKey,
  isConvoySlot, parsePayload, PAYLOAD_KEYS,
  STALE_KILL_MS, PRUNE_EVENT_TYPE, PRUNE_KEY_PREFIX, PRUNE_KEY_RANGE_END, KEY_RANGE_END, PRUNE_CHAIN_PURGE,
  PRUNE_ROWS_FIXED, pruneKey, dayEndMs, charRange, parseGrantKey, characterOfKey,
  REASON_PIRATE_KILL, PIRATE_KILL_SLOT_MARK, pirateKillKey, isPirateKillSlot };
