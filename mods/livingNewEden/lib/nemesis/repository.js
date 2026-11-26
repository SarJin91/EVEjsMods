"use strict";

const S = require("./schema");

const T = S.TABLE;
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isText = (v, max) => typeof v === "string" && v.length >= 1 && v.length <= max;
const invalid = (detail) => ({ ok: false, reason: "INVALID_INPUT", detail });
const MAX_REVENGE_ID_LENGTH = 72;

function parseJson(text, fallback) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" ? v : fallback;
  } catch (_err) {
    return fallback;
  }
}

function toNemesis(row) {
  const n = (v) => (v === null || v === undefined ? null : Number(v));
  const s = (v) => (v === null || v === undefined ? null : String(v));
  const history = parseJson(row.history_json, []);
  return Object.freeze({
    nemesisId: row.nemesis_id,
    characterId: Number(row.character_id),
    commanderId: Number(row.commander_id),
    factionId: Number(row.faction_id),
    gangId: Number(row.gang_id),
    name: s(row.name),
    rank: Number(row.rank),
    baseLevel: Number(row.base_level),
    state: row.state,
    openRevengeId: s(row.open_revenge_id),
    returns: Number(row.returns),
    encounters: Number(row.encounters),
    wins: Number(row.wins),
    escapes: Number(row.escapes),
    missed: Number(row.missed),
    nextReturnAt: Number(row.next_return_at),
    lastEncounterAt: Number(row.last_encounter_at),
    originRevengeId: row.origin_revenge_id,
    originSystemId: Number(row.origin_system_id),
    profile: Object.freeze(parseJson(row.profile_json, {})),
    history: Object.freeze(Array.isArray(history) ? history : []),
    letterSeq: Number(row.letter_seq),
    letterSentSeq: Number(row.letter_sent_seq),
    letterKind: s(row.letter_kind),
    seed: Number(row.seed),
    endReason: s(row.end_reason),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    endedAt: n(row.ended_at),
    version: Number(row.version),
  });
}

const OPEN_SQL = `state IN ('${S.STATES.ACTIVE}', '${S.STATES.HUNTING}')`;

function countsInTx(tx, characterId, commanderId) {
  if (!isId(characterId)) return invalid("characterId");
  if (!isId(commanderId)) return invalid("commanderId");
  const openForPlayer = Number(tx.prepare(`SELECT count(*) AS n FROM ${T} WHERE character_id = ? AND ${OPEN_SQL}`)
    .get(characterId).n);
  const openTotal = Number(tx.prepare(`SELECT count(*) AS n FROM ${T} WHERE ${OPEN_SQL}`).get().n);
  const commanderOpen = Boolean(tx.prepare(`SELECT 1 AS x FROM ${T} WHERE commander_id = ? AND ${OPEN_SQL} LIMIT 1`)
    .get(commanderId));
  const pairKnown = Boolean(tx.prepare(`SELECT 1 AS x FROM ${T} WHERE character_id = ? AND commander_id = ? LIMIT 1`)
    .get(characterId, commanderId));
  return { ok: true, openForPlayer, openTotal, commanderOpen, pairKnown };
}

const readOne = (tx, nemesisId) => {
  const row = tx.prepare(`SELECT * FROM ${T} WHERE nemesis_id = ?`).get(nemesisId);
  return row ? toNemesis(row) : null;
};

function conflictOf(tx, spec) {
  if (tx.prepare(`SELECT 1 AS x FROM ${T} WHERE nemesis_id = ? OR (character_id = ? AND commander_id = ?) LIMIT 1`)
    .get(spec.nemesisId, spec.characterId, spec.commanderId)) {
    return "KNOWN";
  }
  if (tx.prepare(`SELECT 1 AS x FROM ${T} WHERE commander_id = ? AND ${OPEN_SQL} LIMIT 1`).get(spec.commanderId)) {
    return "COMMANDER_OPEN";
  }
  return null;
}

function createNemesisInTx(tx, spec, now) {
  if (!spec || !isText(spec.nemesisId, S.MAX_NEMESIS_ID_LENGTH)) return invalid("nemesisId");
  if (!isId(spec.characterId)) return invalid("characterId");
  if (!isId(spec.commanderId)) return invalid("commanderId");
  if (!isId(spec.factionId)) return invalid("factionId");
  if (!isId(spec.gangId)) return invalid("gangId");
  if (spec.name !== null && !isText(spec.name, S.MAX_NAME_LENGTH)) return invalid("name");
  if (!Number.isSafeInteger(spec.baseLevel) || spec.baseLevel < S.MIN_BASE_LEVEL || spec.baseLevel > S.MAX_BASE_LEVEL) {
    return invalid("baseLevel");
  }
  if (!isText(spec.originRevengeId, MAX_REVENGE_ID_LENGTH)) return invalid("originRevengeId");
  if (!isId(spec.originSystemId)) return invalid("originSystemId");
  if (!Number.isSafeInteger(spec.seed)) return invalid("seed");
  if (!spec.profile || typeof spec.profile !== "object" || Array.isArray(spec.profile)) return invalid("profile");
  if (!Array.isArray(spec.history)) return invalid("history");
  const letterKind = spec.letterKind === undefined ? null : spec.letterKind;
  if (letterKind !== null && letterKind !== S.LETTER_KINDS.CREATED) return invalid("letterKind");
  if (!isTime(now)) return invalid("now");
  const before = conflictOf(tx, spec);
  if (before) return { ok: true, created: false, reason: before };
  const info = tx.prepare(`INSERT INTO ${T} (nemesis_id, character_id, commander_id, faction_id, gang_id, name, rank,
    base_level, state, encounters, next_return_at, last_encounter_at, origin_revenge_id, origin_system_id,
    profile_json, history_json, letter_seq, letter_kind, seed, created_at, updated_at, version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1) ON CONFLICT DO NOTHING`)
    .run(spec.nemesisId, spec.characterId, spec.commanderId, spec.factionId, spec.gangId, spec.name, S.MIN_RANK,
      spec.baseLevel, S.STATES.ACTIVE, now, now, spec.originRevengeId, spec.originSystemId,
      JSON.stringify(spec.profile), JSON.stringify(spec.history), letterKind ? 1 : 0, letterKind, spec.seed, now, now);
  if (Number(info.changes) !== 1) return { ok: true, created: false, reason: conflictOf(tx, spec) || "KNOWN" };
  return { ok: true, created: true, nemesis: readOne(tx, spec.nemesisId) };
}

function listOpenNemesisInTx(tx, limit) {
  if (!isId(limit)) return invalid("limit");
  const rows = tx.prepare(`SELECT * FROM ${T} WHERE ${OPEN_SQL} ORDER BY nemesis_id LIMIT ?`).all(limit);
  return { ok: true, rows: rows.map(toNemesis) };
}

function pruneEndedNemesisInTx(tx, before, limit) {
  if (!isTime(before)) return invalid("before");
  if (!isId(limit)) return invalid("limit");
  const info = tx.prepare(`DELETE FROM ${T} WHERE rowid IN (SELECT rowid FROM ${T}
    WHERE state IN ('${S.STATES.DEFEATED}', '${S.STATES.RETIRED}') AND ended_at IS NOT NULL AND ended_at < ?
    ORDER BY ended_at, nemesis_id LIMIT ?)`).run(before, limit);
  return { ok: true, pruned: Number(info.changes) };
}

const casOf = (nem) => nem && isText(nem.nemesisId, S.MAX_NEMESIS_ID_LENGTH) && isId(nem.version);
const isList = (v) => Array.isArray(v);
const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const MAX_END_REASON_LENGTH = 32;

function readNemesisInTx(tx, nemesisId) {
  if (!isText(nemesisId, S.MAX_NEMESIS_ID_LENGTH)) return invalid("nemesisId");
  return { ok: true, nemesis: readOne(tx, nemesisId) };
}

function markHuntingInTx(tx, nem, hunt, now) {
  if (!casOf(nem)) return invalid("nemesis");
  if (!hunt || !isText(hunt.openRevengeId, MAX_REVENGE_ID_LENGTH)) return invalid("openRevengeId");
  if (!isList(hunt.history)) return invalid("history");
  if (!isTime(now)) return invalid("now");
  const info = tx.prepare(`UPDATE ${T} SET state = '${S.STATES.HUNTING}', open_revenge_id = ?, returns = returns + 1,
    history_json = ?, updated_at = ?, version = version + 1
    WHERE nemesis_id = ? AND version = ? AND state = '${S.STATES.ACTIVE}'`)
    .run(hunt.openRevengeId, JSON.stringify(hunt.history), now, nem.nemesisId, nem.version);
  if (Number(info.changes) !== 1) return { ok: false, reason: "CAS_LOST" };
  return { ok: true, nemesis: readOne(tx, nem.nemesisId) };
}

const ENCOUNTER_WRITES = Object.freeze({
  WON: Object.freeze([S.STATES.ACTIVE, "wins", true, false]),
  ESCAPED: Object.freeze([S.STATES.ACTIVE, "escapes", true, false]),
  DEFEATED: Object.freeze([S.STATES.DEFEATED, null, true, true]),
  MISSED: Object.freeze([S.STATES.ACTIVE, "missed", false, false]),
  RETIRED: Object.freeze([S.STATES.RETIRED, "missed", false, true]),
});

function applyEncounterInTx(tx, nem, enc, now) {
  if (!casOf(nem)) return invalid("nemesis");
  const w = enc ? ENCOUNTER_WRITES[enc.action] : null;
  if (!w) return invalid("action");
  if (!isText(enc.revengeId, MAX_REVENGE_ID_LENGTH)) return invalid("revengeId");
  if (!Number.isSafeInteger(enc.rank) || enc.rank < S.MIN_RANK || enc.rank > S.MAX_RANK) return invalid("rank");
  if (!isTime(enc.nextReturnAt)) return invalid("nextReturnAt");
  if (!isObject(enc.profile)) return invalid("profile");
  if (!isList(enc.history)) return invalid("history");
  if (w[3] && !isText(enc.endReason, MAX_END_REASON_LENGTH)) return invalid("endReason");
  const letterKind = enc.letterKind === undefined ? null : enc.letterKind;
  if (letterKind !== null && letterKind !== S.LETTER_KINDS.WON && letterKind !== S.LETTER_KINDS.DEFEATED) {
    return invalid("letterKind");
  }
  if (!isTime(now)) return invalid("now");
  const [state, column, encounter, ends] = w;
  const info = tx.prepare(`UPDATE ${T} SET state = ?, open_revenge_id = NULL, rank = ?,
    ${column ? `${column} = ${column} + 1,` : ""} encounters = encounters + ?,
    last_encounter_at = CASE WHEN ? = 1 THEN ? ELSE last_encounter_at END, next_return_at = ?, profile_json = ?,
    history_json = ?, ended_at = ?, end_reason = ?, letter_seq = letter_seq + ?, letter_kind = COALESCE(?, letter_kind),
    updated_at = ?, version = version + 1
    WHERE nemesis_id = ? AND version = ? AND state = '${S.STATES.HUNTING}' AND open_revenge_id = ?`)
    .run(state, enc.rank, encounter ? 1 : 0, encounter ? 1 : 0, now, enc.nextReturnAt, JSON.stringify(enc.profile),
      JSON.stringify(enc.history), ends ? now : null, ends ? enc.endReason : null, letterKind ? 1 : 0, letterKind, now,
      nem.nemesisId, nem.version, enc.revengeId);
  if (Number(info.changes) !== 1) return { ok: false, reason: "CAS_LOST" };
  return { ok: true, nemesis: readOne(tx, nem.nemesisId) };
}

function retireInTx(tx, nem, end, now) {
  if (!casOf(nem)) return invalid("nemesis");
  if (!end || !isText(end.reason, MAX_END_REASON_LENGTH)) return invalid("reason");
  if (!isList(end.history)) return invalid("history");
  if (!isTime(now)) return invalid("now");
  const info = tx.prepare(`UPDATE ${T} SET state = '${S.STATES.RETIRED}', ended_at = ?, end_reason = ?,
    history_json = ?, updated_at = ?, version = version + 1
    WHERE nemesis_id = ? AND version = ? AND state = '${S.STATES.ACTIVE}'`)
    .run(now, end.reason, JSON.stringify(end.history), now, nem.nemesisId, nem.version);
  if (Number(info.changes) !== 1) return { ok: false, reason: "CAS_LOST" };
  return { ok: true, nemesis: readOne(tx, nem.nemesisId) };
}

function recoverHuntingInTx(tx, now, cooldownMs) {
  if (!isTime(now)) return invalid("now");
  if (!isTime(cooldownMs)) return invalid("cooldownMs");
  const info = tx.prepare(`UPDATE ${T} SET state = '${S.STATES.ACTIVE}', open_revenge_id = NULL, next_return_at = ?,
    updated_at = ?, version = version + 1 WHERE state = '${S.STATES.HUNTING}' AND NOT EXISTS (SELECT 1 AS x
    FROM world_bounty_revenge r WHERE r.revenge_id = ${T}.open_revenge_id AND r.state IN ('WAITING', 'LIVE'))`)
    .run(now + cooldownMs, now);
  return { ok: true, recovered: Number(info.changes) };
}

function listPendingLettersInTx(tx, limit) {
  if (!isId(limit)) return invalid("limit");
  const rows = tx.prepare(`SELECT * FROM ${T} WHERE letter_seq > letter_sent_seq ORDER BY nemesis_id LIMIT ?`)
    .all(limit);
  return { ok: true, rows: rows.map(toNemesis) };
}

function markLetterSentInTx(tx, nemesisId, seq) {
  if (!isText(nemesisId, S.MAX_NEMESIS_ID_LENGTH)) return invalid("nemesisId");
  if (!isId(seq)) return invalid("seq");
  const info = tx.prepare(`UPDATE ${T} SET letter_sent_seq = ?
    WHERE nemesis_id = ? AND letter_seq = ? AND letter_sent_seq < ?`).run(seq, nemesisId, seq, seq);
  return Number(info.changes) === 1 ? { ok: true } : { ok: false, reason: "CAS_LOST" };
}

module.exports = { countsInTx, createNemesisInTx, listOpenNemesisInTx, pruneEndedNemesisInTx, toNemesis,
  readNemesisInTx, markHuntingInTx, applyEncounterInTx, retireInTx, recoverHuntingInTx,
  listPendingLettersInTx, markLetterSentInTx };
