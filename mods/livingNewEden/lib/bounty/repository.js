"use strict";

const S = require("./schema");

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isText = (v, max) => typeof v === "string" && v.length >= 1 && v.length <= max;
const invalid = (detail) => ({ ok: false, reason: "INVALID_INPUT", detail });

const T = S.TABLE;
const ACTIVE_SQL = `state IN ('ROAMING', 'LIVE')`;
const ENDED_SQL = `state IN ('KILLED', 'EXPIRED')`;

function toTarget(row) {
  const n = (v) => (v === null || v === undefined ? null : Number(v));
  return Object.freeze({
    wantedId: row.wanted_id,
    gangSlot: Number(row.gang_slot),
    cycle: Number(row.cycle),
    factionId: Number(row.faction_id),
    characterId: Number(row.character_id),
    level: Number(row.level),
    archetype: row.archetype,
    smuggler: Number(row.smuggler),
    state: row.state,
    systemId: Number(row.system_id),
    stayIndex: Number(row.stay_index),
    nextMoveAt: Number(row.next_move_at),
    expiresAt: Number(row.expires_at),
    escortsLost: Number(row.escorts_lost),
    traceSystemId: n(row.trace_system_id),
    traceAt: n(row.trace_at),
    rewardIsk: Number(row.reward_isk),
    seed: Number(row.seed),
    payoutState: row.payout_state,
    endedAt: n(row.ended_at),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    version: Number(row.version),
  });
}

function lastOfSlotInTx(tx, slot) {
  const row = tx.prepare(`SELECT * FROM ${T} WHERE gang_slot = ? ORDER BY cycle DESC LIMIT 1`).get(slot);
  return row ? toTarget(row) : null;
}

function listSlotHeadsInTx(tx) {
  const rows = tx.prepare(`SELECT t.gang_slot AS slot, t.cycle AS cycle, t.state AS state, t.ended_at AS ended_at
    FROM ${T} AS t JOIN (SELECT gang_slot, MAX(cycle) AS c FROM ${T} GROUP BY gang_slot) AS m
    ON m.gang_slot = t.gang_slot AND m.c = t.cycle ORDER BY t.gang_slot`).all();
  return rows.map((r) => Object.freeze({ slot: Number(r.slot), cycle: Number(r.cycle), state: r.state,
    endedAt: r.ended_at === null || r.ended_at === undefined ? null : Number(r.ended_at) }));
}

function listActiveInTx(tx, limit) {
  const rows = tx.prepare(`SELECT * FROM ${T} WHERE ${ACTIVE_SQL} ORDER BY wanted_id LIMIT ?`).all(limit);
  return rows.map(toTarget);
}

function createInTx(tx, r, now) {
  if (!r || !isId(r.slot)) return invalid("slot");
  if (!isId(r.cycle)) return invalid("cycle");
  if (!isId(r.factionId)) return invalid("factionId");
  if (!isId(r.characterId)) return invalid("characterId");
  if (!Number.isSafeInteger(r.level) || r.level < S.MIN_LEVEL || r.level > S.MAX_LEVEL) return invalid("level");
  if (!Object.values(S.ARCHETYPES).includes(r.archetype)) return invalid("archetype");
  if (r.smuggler !== 0 && r.smuggler !== 1) return invalid("smuggler");
  if (!isId(r.systemId)) return invalid("systemId");
  if (!isTime(r.nextMoveAt)) return invalid("nextMoveAt");
  if (!isTime(r.expiresAt)) return invalid("expiresAt");
  if (!isTime(r.rewardIsk)) return invalid("rewardIsk");
  if (!Number.isSafeInteger(r.seed)) return invalid("seed");
  if (!isTime(now)) return invalid("now");
  const wantedId = S.wantedIdOf(r.slot, r.cycle);
  if (!isText(wantedId, S.MAX_WANTED_ID_LENGTH)) return invalid("wantedId");
  const seen = tx.prepare(`SELECT wanted_id FROM ${T} WHERE wanted_id = ? OR (gang_slot = ? AND cycle = ?)`)
    .get(wantedId, r.slot, r.cycle);
  if (seen) return { ok: false, reason: "DUPLICATE" };
  tx.prepare(`INSERT INTO ${T} (wanted_id, gang_slot, cycle, faction_id, character_id, level, archetype, smuggler,
    state, system_id, stay_index, next_move_at, expires_at, reward_isk, seed, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`)
    .run(wantedId, r.slot, r.cycle, r.factionId, r.characterId, r.level, r.archetype, r.smuggler, S.STATES.ROAMING,
      r.systemId, r.nextMoveAt, r.expiresAt, r.rewardIsk, r.seed, now, now);
  return { ok: true, target: toTarget(tx.prepare(`SELECT * FROM ${T} WHERE wanted_id = ?`).get(wantedId)) };
}

function casResult(tx, info, wantedId) {
  if (Number(info.changes) !== 1) return { ok: false, reason: "CAS_LOST" };
  return { ok: true, target: toTarget(tx.prepare(`SELECT * FROM ${T} WHERE wanted_id = ?`).get(wantedId)) };
}

function moveInTx(tx, target, systemId, nextMoveAt, now) {
  if (!target || !isText(target.wantedId, S.MAX_WANTED_ID_LENGTH) || !isId(target.version)) return invalid("target");
  if (!isId(systemId)) return invalid("systemId");
  if (!isTime(nextMoveAt)) return invalid("nextMoveAt");
  if (!isTime(now)) return invalid("now");
  const info = tx.prepare(`UPDATE ${T} SET system_id = ?, stay_index = stay_index + 1, next_move_at = ?,
    trace_system_id = system_id, trace_at = ?, escorts_lost = 0, updated_at = ?, version = version + 1
    WHERE wanted_id = ? AND version = ? AND state = 'ROAMING'`)
    .run(systemId, nextMoveAt, now, now, target.wantedId, target.version);
  return casResult(tx, info, target.wantedId);
}

function holdInTx(tx, target, nextMoveAt, now) {
  if (!target || !isText(target.wantedId, S.MAX_WANTED_ID_LENGTH) || !isId(target.version)) return invalid("target");
  if (!isTime(nextMoveAt)) return invalid("nextMoveAt");
  if (!isTime(now)) return invalid("now");
  const info = tx.prepare(`UPDATE ${T} SET next_move_at = ?, updated_at = ?, version = version + 1
    WHERE wanted_id = ? AND version = ? AND state = 'ROAMING'`).run(nextMoveAt, now, target.wantedId, target.version);
  return casResult(tx, info, target.wantedId);
}

function expireInTx(tx, target, now) {
  if (!target || !isText(target.wantedId, S.MAX_WANTED_ID_LENGTH) || !isId(target.version)) return invalid("target");
  if (!isTime(now)) return invalid("now");
  const info = tx.prepare(`UPDATE ${T} SET state = 'EXPIRED', ended_at = ?, updated_at = ?, version = version + 1
    WHERE wanted_id = ? AND version = ? AND state = 'ROAMING'`).run(now, now, target.wantedId, target.version);
  return casResult(tx, info, target.wantedId);
}

function recoverLiveInTx(tx, now, minStayMs) {
  if (!isTime(now)) return invalid("now");
  if (!isTime(minStayMs)) return invalid("minStayMs");
  const info = tx.prepare(`UPDATE ${T} SET state = 'ROAMING', next_move_at = MAX(next_move_at, ?), updated_at = ?,
    version = version + 1 WHERE state = 'LIVE'`).run(now + minStayMs, now);
  return { ok: true, recovered: Number(info.changes) };
}

function markLiveInTx(tx, target, now) {
  if (!target || !isText(target.wantedId, S.MAX_WANTED_ID_LENGTH) || !isId(target.version)) return invalid("target");
  if (!isTime(now)) return invalid("now");
  const info = tx.prepare(`UPDATE ${T} SET state = 'LIVE', updated_at = ?, version = version + 1
    WHERE wanted_id = ? AND version = ? AND state = 'ROAMING'`).run(now, target.wantedId, target.version);
  return casResult(tx, info, target.wantedId);
}

function endLiveInTx(tx, target, move, now) {
  if (!target || !isText(target.wantedId, S.MAX_WANTED_ID_LENGTH) || !isId(target.version)) return invalid("target");
  if (!isTime(now)) return invalid("now");
  if (move !== null && (!move || !isId(move.systemId) || !isTime(move.nextMoveAt))) return invalid("move");
  const info = move === null
    ? tx.prepare(`UPDATE ${T} SET state = 'ROAMING', updated_at = ?, version = version + 1
      WHERE wanted_id = ? AND version = ? AND state = 'LIVE'`).run(now, target.wantedId, target.version)
    : tx.prepare(`UPDATE ${T} SET state = 'ROAMING', system_id = ?, stay_index = stay_index + 1, next_move_at = ?,
      trace_system_id = system_id, trace_at = ?, escorts_lost = 0, updated_at = ?, version = version + 1
      WHERE wanted_id = ? AND version = ? AND state = 'LIVE'`)
      .run(move.systemId, move.nextMoveAt, now, now, target.wantedId, target.version);
  return casResult(tx, info, target.wantedId);
}

function killInTx(tx, wantedId, version, killedBy, now) {
  if (!isText(wantedId, S.MAX_WANTED_ID_LENGTH) || !isId(version)) return invalid("target");
  if (!isId(killedBy)) return invalid("killedBy");
  if (!isTime(now)) return invalid("now");
  const info = tx.prepare(`UPDATE ${T} SET state = 'KILLED', killed_by = ?, killed_at = ?, ended_at = ?,
    payout_state = CASE WHEN reward_isk = 0 THEN 'PAID' ELSE 'PENDING' END, updated_at = ?, version = version + 1
    WHERE wanted_id = ? AND version = ? AND state = 'LIVE'`).run(killedBy, now, now, now, wantedId, version);
  const r = casResult(tx, info, wantedId);
  if (!r.ok) return r;
  const t = r.target;
  const payoutKey = S.payoutKeyOf(wantedId, t.createdAt);
  const zero = t.rewardIsk === 0;
  const planned = tx.prepare(`INSERT INTO ${S.PAYOUTS_TABLE} (payout_key, wanted_id, character_id, system_id,
    amount_isk, state, attempts, last_reason, created_at, updated_at, settled_at, version)
    VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?, 1) ON CONFLICT(payout_key) DO NOTHING`)
    .run(payoutKey, wantedId, killedBy, t.systemId, t.rewardIsk, zero ? S.PAYOUT_ROW_STATES.PAID
      : S.PAYOUT_ROW_STATES.PENDING, now, now, zero ? now : null);
  return { ok: true, target: t, payout: { payoutKey, planned: Number(planned.changes) === 1 && !zero } };
}

function toPayout(row) {
  return Object.freeze({ payoutKey: row.payout_key, wantedId: row.wanted_id, characterId: Number(row.character_id),
    systemId: Number(row.system_id), amountIsk: Number(row.amount_isk), state: row.state,
    attempts: Number(row.attempts), lastReason: row.last_reason === null ? null : String(row.last_reason),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
    settledAt: row.settled_at === null || row.settled_at === undefined ? null : Number(row.settled_at),
    nextAttemptAt: row.next_attempt_at === null || row.next_attempt_at === undefined ? 0 : Number(row.next_attempt_at),
    version: Number(row.version) });
}

function listPendingPayoutsInTx(tx, limit, now) {
  if (!isId(limit)) return invalid("limit");
  if (!isTime(now)) return invalid("now");
  const rows = tx.prepare(`SELECT * FROM ${S.PAYOUTS_TABLE} WHERE state = 'PENDING' AND next_attempt_at <= ?
    ORDER BY next_attempt_at, payout_key LIMIT ?`).all(now, limit);
  if (rows.length >= limit) return { ok: true, payouts: rows.map(toPayout), waiting: null, nextDueAt: null };
  const w = tx.prepare(`SELECT COUNT(*) AS n, MIN(next_attempt_at) AS m FROM ${S.PAYOUTS_TABLE}
    WHERE state = 'PENDING' AND next_attempt_at > ?`).get(now);
  return { ok: true, payouts: rows.map(toPayout), waiting: Number(w.n),
    nextDueAt: w.m === null || w.m === undefined ? null : Number(w.m) };
}

function countPendingPayoutsInTx(tx) {
  const r = tx.prepare(`SELECT COUNT(*) AS n FROM ${S.PAYOUTS_TABLE} WHERE state = 'PENDING'`).get();
  return { ok: true, pending: Number(r.n) };
}

function getPayoutInTx(tx, payoutKey) {
  const row = tx.prepare(`SELECT * FROM ${S.PAYOUTS_TABLE} WHERE payout_key = ?`).get(payoutKey);
  return row ? toPayout(row) : null;
}

function settlePayoutInTx(tx, p, m, now) {
  if (!p || !isText(p.payoutKey, S.MAX_PAYOUT_KEY_LENGTH) || !isId(p.version)) return invalid("payout");
  if (!m || !Object.values(S.PAYOUT_ROW_STATES).includes(m.state)) return invalid("state");
  if (!isTime(m.attempts)) return invalid("attempts");
  if (m.lastReason !== null && typeof m.lastReason !== "string") return invalid("lastReason");
  if (m.nextAttemptAt !== undefined && m.nextAttemptAt !== null && !isTime(m.nextAttemptAt)) {
    return invalid("nextAttemptAt");
  }
  if (!isTime(now)) return invalid("now");
  const settled = m.state === S.PAYOUT_ROW_STATES.PENDING ? null : now;
  const nextAt = m.nextAttemptAt === undefined || m.nextAttemptAt === null ? null : m.nextAttemptAt;
  const info = tx.prepare(`UPDATE ${S.PAYOUTS_TABLE} SET state = ?, attempts = ?, last_reason = ?, updated_at = ?,
    settled_at = ?, next_attempt_at = COALESCE(?, next_attempt_at), version = version + 1
    WHERE payout_key = ? AND version = ? AND state = 'PENDING'`)
    .run(m.state, m.attempts, m.lastReason === null ? null : m.lastReason.slice(0, 120), now, settled, nextAt,
      p.payoutKey, p.version);
  if (Number(info.changes) !== 1) return { ok: false, reason: "CAS_LOST" };
  if (isText(p.wantedId, S.MAX_WANTED_ID_LENGTH) && isTime(p.createdAt)) {
    tx.prepare(`UPDATE ${T} SET payout_state = ?, payout_attempts = ?
      WHERE wanted_id = ? AND killed_at = ? AND state = 'KILLED'`).run(m.state, m.attempts, p.wantedId, p.createdAt);
  }
  return { ok: true, payout: getPayoutInTx(tx, p.payoutKey) };
}

function prunePayoutsInTx(tx, before, limit) {
  if (!isTime(before)) return invalid("before");
  if (!isId(limit)) return invalid("limit");
  const info = tx.prepare(`DELETE FROM ${S.PAYOUTS_TABLE} WHERE payout_key IN (SELECT payout_key FROM
    ${S.PAYOUTS_TABLE} WHERE state <> 'PENDING' AND settled_at IS NOT NULL AND settled_at < ?
    ORDER BY settled_at, payout_key LIMIT ?)`).run(before, limit);
  return { ok: true, deleted: Number(info.changes) };
}

function escortLostInTx(tx, wantedId, version, now) {
  if (!isText(wantedId, S.MAX_WANTED_ID_LENGTH) || !isId(version)) return invalid("target");
  if (!isTime(now)) return invalid("now");
  const info = tx.prepare(`UPDATE ${T} SET escorts_lost = escorts_lost + 1, updated_at = ?
    WHERE wanted_id = ? AND version = ? AND state = 'LIVE'`).run(now, wantedId, version);
  return casResult(tx, info, wantedId);
}

function pruneEndedInTx(tx, before, limit) {
  if (!isTime(before)) return invalid("before");
  if (!isId(limit)) return invalid("limit");
  const ids = tx.prepare(`SELECT wanted_id AS id FROM ${T} AS t WHERE ${ENDED_SQL} AND payout_state <> 'PENDING'
    AND ended_at IS NOT NULL AND ended_at < ?
    AND cycle < (SELECT MAX(m.cycle) FROM ${T} AS m WHERE m.gang_slot = t.gang_slot)
    ORDER BY ended_at, wanted_id LIMIT ?`).all(before, limit).map((x) => x.id);
  if (ids.length === 0) return { ok: true, deleted: 0 };
  const del = tx.prepare(`DELETE FROM ${T} WHERE wanted_id = ?`);
  let deleted = 0;
  for (const id of ids) deleted += Number(del.run(id).changes);
  return { ok: true, deleted };
}

module.exports = { lastOfSlotInTx, listSlotHeadsInTx, listActiveInTx,
  createInTx, moveInTx, holdInTx, expireInTx, recoverLiveInTx,
  markLiveInTx, endLiveInTx, killInTx, escortLostInTx,
  pruneEndedInTx, toTarget,
  listPendingPayoutsInTx, countPendingPayoutsInTx, getPayoutInTx, settlePayoutInTx, prunePayoutsInTx };
