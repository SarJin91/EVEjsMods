"use strict";

const MAX_DETAIL = 200;
const MAX_ATTACKERS = 10;
const EVENT_ID_RE = /^lne:fc:km:[\x21-\x7e]{1,80}$/;
const FILETIME_EPOCH_OFFSET_MS = 11644473600000n;
const FILETIME_TICKS_PER_MS = 10000n;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isAmount = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const invalid = (detail) => ({ ok: false, reason: "INVALID_INPUT", detail });
const detailOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);

function filetimeOf(atMs) {
  return String((BigInt(atMs) + FILETIME_EPOCH_OFFSET_MS) * FILETIME_TICKS_PER_MS);
}

function buildVendorKillmailRecord(spec) {
  if (!spec || typeof spec !== "object" || spec.v !== 1) return invalid("spec");
  if (typeof spec.skirmishId !== "string" || spec.skirmishId === "") return invalid("skirmishId");
  if (!Number.isSafeInteger(spec.at) || spec.at < 0) return invalid("at");
  if (!isId(spec.systemId)) return invalid("systemId");
  const v = spec.victim;
  if (!v || !isId(v.characterId) || !isId(v.corporationId) || !isId(v.shipTypeId) || !isAmount(v.damageTaken)) {
    return invalid("victim");
  }
  const list = spec.attackers;
  if (!Array.isArray(list) || list.length < 1 || list.length > MAX_ATTACKERS) return invalid("attackers");
  const attackers = [];
  for (const a of list) {
    if (!a || !isId(a.characterId) || !isId(a.corporationId) || !isId(a.shipTypeId) || !isAmount(a.damageDone)
      || typeof a.securityStatus !== "number" || !Number.isFinite(a.securityStatus)) {
      return invalid("attacker");
    }
    attackers.push({ characterID: a.characterId, corporationID: a.corporationId, shipTypeID: a.shipTypeId,
      damageDone: a.damageDone, securityStatus: a.securityStatus });
  }
  const final = attackers[0];
  return { ok: true, record: {
    killTime: filetimeOf(spec.at),
    solarSystemID: spec.systemId,
    victimCharacterID: v.characterId,
    victimCorporationID: v.corporationId,
    victimAllianceID: null,
    victimShipTypeID: v.shipTypeId,
    victimDamageTaken: v.damageTaken,
    finalCharacterID: null,
    finalCorporationID: final.corporationID,
    finalShipTypeID: final.shipTypeID,
    finalDamageDone: final.damageDone,
    finalSecurityStatus: final.securityStatus,
    attackers,
    items: [],
  } };
}

function writeVirtualKillmailWith(stateModule, spec, eventId) {
  if (typeof eventId !== "string" || !EVENT_ID_RE.test(eventId)) return invalid("eventId");
  if (!stateModule || typeof stateModule.createKillmailRecordIdempotent !== "function") {
    return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "createKillmailRecordIdempotent" };
  }
  const built = buildVendorKillmailRecord(spec);
  if (!built.ok) return built;
  let result;
  try {
    result = stateModule.createKillmailRecordIdempotent(built.record, eventId);
  } catch (err) {
    return { ok: false, reason: "VENDOR_THROW", detail: detailOf(err) };
  }
  const killId = result && typeof result === "object" ? Number(result.killID) : NaN;
  if (!isId(killId)) return { ok: false, reason: "NO_RECORD" };
  return { ok: true, killId };
}

module.exports = { buildVendorKillmailRecord, writeVirtualKillmailWith, filetimeOf, EVENT_ID_RE };
