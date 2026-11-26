"use strict";

const S = require("./schema");

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isText = (v, max) => typeof v === "string" && v.length >= 1 && v.length <= max;
const invalid = (detail) => ({ ok: false, reason: "INVALID_INPUT", detail });

const T = S.REVENGE_TABLE;
const MAX_REASON_LENGTH = 32;
const MAX_NEMESIS_ID_LENGTH = 48;

function toRevenge(row) {
  const n = (v) => (v === null || v === undefined ? null : Number(v));
  return Object.freeze({
    revengeId: row.revenge_id,
    wantedId: row.wanted_id,
    characterId: Number(row.character_id),
    factionId: Number(row.faction_id),
    gangId: Number(row.gang_id),
    bossCharacterId: Number(row.boss_character_id),
    targetLevel: Number(row.target_level),
    hunterLevel: Number(row.hunter_level),
    killSystemId: Number(row.kill_system_id),
    state: row.state,
    systemId: n(row.system_id),
    commanderId: n(row.commander_id),
    attempts: Number(row.attempts),
    dueAt: Number(row.due_at),
    expiresAt: Number(row.expires_at),
    endReason: row.end_reason === null || row.end_reason === undefined ? null : String(row.end_reason),
    seed: Number(row.seed),
    killedAt: Number(row.killed_at),
    liveAt: n(row.live_at),
    endedAt: n(row.ended_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    version: Number(row.version),
    nemesisId: row.nemesis_id === null || row.nemesis_id === undefined ? null : String(row.nemesis_id),
  });
}

const readOne = (tx, revengeId) => {
  const row = tx.prepare(`SELECT * FROM ${T} WHERE revenge_id = ?`).get(revengeId);
  return row ? toRevenge(row) : null;
};

function createRevengeInTx(tx, spec, now) {
  if (!spec || !isText(spec.wantedId, S.MAX_WANTED_ID_LENGTH)) return invalid("wantedId");
  if (!isId(spec.characterId)) return invalid("characterId");
  if (!isId(spec.factionId)) return invalid("factionId");
  if (!isId(spec.gangId)) return invalid("gangId");
  if (!isId(spec.bossCharacterId)) return invalid("bossCharacterId");
  if (!Number.isSafeInteger(spec.targetLevel) || spec.targetLevel <= S.MIN_LEVEL || spec.targetLevel > S.MAX_LEVEL) {
    return invalid("targetLevel");
  }
  if (!isId(spec.killSystemId)) return invalid("killSystemId");
  if (!isTime(spec.killedAt)) return invalid("killedAt");
  if (!Number.isSafeInteger(spec.seed)) return invalid("seed");
  if (!isTime(spec.delayMs)) return invalid("delayMs");
  if (!isTime(spec.windowMs)) return invalid("windowMs");
  if (!isTime(now)) return invalid("now");
  const nemesisId = spec.nemesisId === null || spec.nemesisId === undefined ? null : spec.nemesisId;
  if (nemesisId !== null && !isText(nemesisId, MAX_NEMESIS_ID_LENGTH)) return invalid("nemesisId");
  const dueAt = spec.killedAt + spec.delayMs;
  const expiresAt = spec.killedAt + spec.windowMs;
  if (!isTime(dueAt) || !isTime(expiresAt)) return invalid("dueAt");
  const revengeId = S.revengeIdOf(spec.wantedId);
  if (!isText(revengeId, S.MAX_REVENGE_ID_LENGTH)) return invalid("revengeId");
  if (tx.prepare(`SELECT 1 AS x FROM ${T} WHERE revenge_id = ? OR wanted_id = ?`).get(revengeId, spec.wantedId)) {
    return { ok: true, created: false, reason: "DUPLICATE" };
  }
  const open = tx.prepare(`SELECT 1 AS x FROM ${T} WHERE character_id = ? AND state IN ('WAITING', 'LIVE')
    AND (state = 'LIVE' OR expires_at > ?) LIMIT 1`).get(spec.characterId, now);
  if (open) return { ok: true, created: false, reason: "OPEN_EXISTS" };
  const info = tx.prepare(`INSERT INTO ${T} (revenge_id, wanted_id, character_id, faction_id, gang_id,
    boss_character_id, target_level, hunter_level, kill_system_id, state, attempts, due_at, expires_at, seed,
    killed_at, created_at, updated_at, version, nemesis_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, 1, ?) ON CONFLICT(revenge_id) DO NOTHING`)
    .run(revengeId, spec.wantedId, spec.characterId, spec.factionId, spec.gangId, spec.bossCharacterId,
      spec.targetLevel, spec.targetLevel - 1, spec.killSystemId, S.REVENGE_STATES.WAITING, dueAt, expiresAt,
      spec.seed, spec.killedAt, now, now, nemesisId);
  if (Number(info.changes) !== 1) return { ok: true, created: false, reason: "DUPLICATE" };
  return { ok: true, created: true, revenge: readOne(tx, revengeId) };
}

function listOpenRevengeInTx(tx, limit) {
  if (!isId(limit)) return invalid("limit");
  const rows = tx.prepare(`SELECT * FROM ${T} WHERE state IN ('WAITING', 'LIVE') ORDER BY revenge_id LIMIT ?`)
    .all(limit);
  return { ok: true, rows: rows.map(toRevenge) };
}

function expireRevengeInTx(tx, revenge, reason, now) {
  if (!revenge || !isText(revenge.revengeId, S.MAX_REVENGE_ID_LENGTH) || !isId(revenge.version)) {
    return invalid("revenge");
  }
  if (!isText(reason, MAX_REASON_LENGTH)) return invalid("reason");
  if (!isTime(now)) return invalid("now");
  const info = tx.prepare(`UPDATE ${T} SET state = 'EXPIRED', end_reason = ?, ended_at = ?, updated_at = ?,
    version = version + 1 WHERE revenge_id = ? AND version = ? AND state = 'WAITING'`)
    .run(reason, now, now, revenge.revengeId, revenge.version);
  if (Number(info.changes) !== 1) return { ok: false, reason: "CAS_LOST" };
  return { ok: true, revenge: readOne(tx, revenge.revengeId) };
}

const casOf = (revenge) => revenge && isText(revenge.revengeId, S.MAX_REVENGE_ID_LENGTH) && isId(revenge.version);

function markRevengeLiveInTx(tx, revenge, live, now) {
  if (!casOf(revenge)) return invalid("revenge");
  if (!live || !isId(live.systemId)) return invalid("systemId");
  const commanderId = live.commanderId === null || live.commanderId === undefined ? null : live.commanderId;
  if (commanderId !== null && !isId(commanderId)) return invalid("commanderId");
  if (!isTime(now)) return invalid("now");
  const info = tx.prepare(`UPDATE ${T} SET state = 'LIVE', system_id = ?, commander_id = ?, live_at = ?,
    updated_at = ?, version = version + 1 WHERE revenge_id = ? AND version = ? AND state = 'WAITING'`)
    .run(live.systemId, commanderId, now, now, revenge.revengeId, revenge.version);
  if (Number(info.changes) !== 1) return { ok: false, reason: "CAS_LOST" };
  return { ok: true, revenge: readOne(tx, revenge.revengeId) };
}

function endRevengeInTx(tx, revenge, end, now) {
  if (!casOf(revenge)) return invalid("revenge");
  if (!end || (end.state !== S.REVENGE_STATES.DONE && end.state !== S.REVENGE_STATES.EXPIRED)) return invalid("state");
  if (!isText(end.reason, MAX_REASON_LENGTH)) return invalid("reason");
  if (!isTime(now)) return invalid("now");
  const info = tx.prepare(`UPDATE ${T} SET state = ?, end_reason = ?, ended_at = ?, updated_at = ?,
    version = version + 1 WHERE revenge_id = ? AND version = ? AND state = 'LIVE'`)
    .run(end.state, end.reason, now, now, revenge.revengeId, revenge.version);
  if (Number(info.changes) !== 1) return { ok: false, reason: "CAS_LOST" };
  return { ok: true, revenge: readOne(tx, revenge.revengeId) };
}

function retryRevengeInTx(tx, revenge, retry, now) {
  if (!casOf(revenge)) return invalid("revenge");
  if (!retry || !isTime(retry.dueAt)) return invalid("dueAt");
  if (typeof retry.countAttempt !== "boolean") return invalid("countAttempt");
  if (!isText(retry.reason, MAX_REASON_LENGTH)) return invalid("reason");
  if (!isTime(now)) return invalid("now");
  const info = tx.prepare(`UPDATE ${T} SET state = 'WAITING', attempts = attempts + ?, due_at = ?, end_reason = ?,
    updated_at = ?, version = version + 1 WHERE revenge_id = ? AND version = ? AND state = 'LIVE'`)
    .run(retry.countAttempt ? 1 : 0, retry.dueAt, retry.reason, now, revenge.revengeId, revenge.version);
  if (Number(info.changes) !== 1) return { ok: false, reason: "CAS_LOST" };
  return { ok: true, revenge: readOne(tx, revenge.revengeId) };
}

function recoverRevengeLiveInTx(tx, now) {
  if (!isTime(now)) return invalid("now");
  const info = tx.prepare(`UPDATE ${T} SET state = 'WAITING', due_at = MAX(due_at, ?), updated_at = ?,
    version = version + 1 WHERE state = 'LIVE'`).run(now, now);
  return { ok: true, recovered: Number(info.changes) };
}

function pruneRevengeInTx(tx, before, limit) {
  if (!isTime(before)) return invalid("before");
  if (!isId(limit)) return invalid("limit");
  const info = tx.prepare(`DELETE FROM ${T} WHERE revenge_id IN (SELECT revenge_id FROM ${T}
    WHERE state IN ('DONE', 'EXPIRED') AND ended_at IS NOT NULL AND ended_at < ?
    ORDER BY ended_at, revenge_id LIMIT ?)`).run(before, limit);
  return { ok: true, pruned: Number(info.changes) };
}

module.exports = { createRevengeInTx, listOpenRevengeInTx, expireRevengeInTx, recoverRevengeLiveInTx,
  pruneRevengeInTx, markRevengeLiveInTx, endRevengeInTx, retryRevengeInTx, toRevenge };
