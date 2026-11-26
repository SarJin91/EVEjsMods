"use strict";

const S = require("./schema");

const MAX_PROFILE_ENTRIES = 16;
const CAPSULE_CLASS = "capsule";
const WIN_REASON = "TARGET_DOWN";
const WIPED_REASON = "WIPED";
const DONE = "DONE";

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const none = (reason) => ({ action: "NONE", reason });

function decideNemesisOnEnd(nem, o, c, params) {
  if (nem || (o && o.nemesisId !== null && o.nemesisId !== undefined)) return none("NEMESIS_ROW");
  if (!o || o.state !== DONE) return none("NOT_DONE");
  if (o.engaged !== true) return none("NOT_ENGAGED");
  if (o.bossKilled === true || o.reason === WIPED_REASON) return none("BOSS_KILLED");
  if (!isId(o.commanderId)) return none("NO_COMMANDER");
  if (typeof o.commanderName !== "string" || o.commanderName === "") return none("NO_NAME");
  if (params.createOn === S.CREATE_ON.WIN ? o.reason !== WIN_REASON : params.createOn !== S.CREATE_ON.WIN_OR_SURVIVE) {
    return none("CREATE_ON");
  }
  if (!c || !(c.openForPlayer < params.maxActivePerPlayer)) return none("LIMIT_PLAYER");
  if (!(c.openTotal < params.maxActiveTotal)) return none("LIMIT_TOTAL");
  if (c.pairKnown === true) return none("KNOWN");
  if (c.commanderOpen === true) return none("COMMANDER_OPEN");
  return { action: "CREATE", reason: "OK" };
}

function profileOf(prev, hullClass, maxEntries = MAX_PROFILE_ENTRIES) {
  const out = {};
  if (prev && typeof prev === "object" && !Array.isArray(prev)) {
    for (const [k, v] of Object.entries(prev)) if (Number.isSafeInteger(v) && v > 0) out[k] = v;
  }
  if (typeof hullClass !== "string" || hullClass === "" || hullClass === CAPSULE_CLASS) return out;
  const max = Number.isSafeInteger(maxEntries) && maxEntries > 0 ? Math.min(maxEntries, MAX_PROFILE_ENTRIES)
    : MAX_PROFILE_ENTRIES;
  if (!Object.hasOwn(out, hullClass)) {
    const keys = Object.keys(out).sort((a, b) => out[a] - out[b] || (a < b ? 1 : a > b ? -1 : 0));
    for (let i = 0; keys.length - i >= max; i += 1) delete out[keys[i]];
  }
  out[hullClass] = (out[hullClass] || 0) + 1;
  return out;
}

function historyPush(list, entry, max) {
  const all = [...(Array.isArray(list) ? list : []), entry];
  return Number.isSafeInteger(max) && max > 0 ? all.slice(-max) : all;
}

const RETURN_SEC_CLASSES = Object.freeze(["lowsec", "nullsec"]);
const RETURN_REASONS = Object.freeze(["NOT_DUE", "PLAYER_GAP", "OPEN_REVENGE", "NOT_LOCATED", "NOT_IN_SPACE",
  "SEC_CLASS", "EXCLUDED_REGION", "COMMANDER_BUSY", "MEMBER_GONE", "IDLE"]);
const EXPIRED = "EXPIRED";

const wait = (reason) => ({ ready: false, reason });

function returnDueAt(nem, params) {
  return Math.max(nem.nextReturnAt, nem.createdAt + params.returnCooldownMs);
}

function decideNemesisReturn(nem, f, params) {
  const now = f.now;
  if (now - nem.lastEncounterAt >= params.idleRetireMs) return wait("IDLE");
  if (f.member === false) return wait("MEMBER_GONE");
  if (now < returnDueAt(nem, params)) return wait("NOT_DUE");
  if (Number.isSafeInteger(f.lastReturnAt) && now - f.lastReturnAt < params.playerGapMs) return wait("PLAYER_GAP");
  if (f.openRevenge === true) return wait("OPEN_REVENGE");
  if (f.commanderBusy === true || f.member !== true) return wait("COMMANDER_BUSY");
  const located = f.located;
  if (!located || !isId(located.systemId)) return wait("NOT_LOCATED");
  if (located.state !== "space") return wait("NOT_IN_SPACE");
  if (!f.system) return wait("NOT_LOCATED");
  if (!RETURN_SEC_CLASSES.includes(f.system.secClass)) return wait("SEC_CLASS");
  if (params.excludedRegions && params.excludedRegions.has(f.system.regionId)) return wait("EXCLUDED_REGION");
  return { ready: true, systemId: located.systemId };
}

function squadSpecOf(nem, params) {
  const rank = Math.max(1, nem.rank);
  return { hunterLevel: Math.max(1, Math.min(params.maxHunterLevel, nem.baseLevel + rank - 1)),
    extraEscorts: Math.max(0, Math.min(params.maxExtraEscorts, rank - 1)) };
}

function decideNemesisOnEncounter(nem, o, params) {
  if (!nem) return none("NO_NEMESIS");
  if (!o || (o.state !== DONE && o.state !== EXPIRED)) return none("NOT_ENDED");
  if (o.state === DONE && (o.bossKilled === true || o.reason === WIPED_REASON)) {
    return { action: "DEFEATED", reason: o.bossKilled === true ? "BOSS_KILLED" : WIPED_REASON };
  }
  if (o.state === DONE && o.engaged === true) {
    return o.reason === WIN_REASON ? { action: "WON", reason: WIN_REASON } : { action: "ESCAPED", reason: o.reason };
  }
  if (nem.missed + 1 >= params.maxMissedReturns) return { action: "RETIRED", reason: "MISSED" };
  return { action: "MISSED", reason: o.state === EXPIRED ? EXPIRED : "NOT_ENGAGED" };
}

module.exports = { decideNemesisOnEnd, profileOf, historyPush, MAX_PROFILE_ENTRIES,
  decideNemesisReturn, squadSpecOf, decideNemesisOnEncounter, returnDueAt, RETURN_REASONS, RETURN_SEC_CLASSES };
