"use strict";

const S = require("./schema");

let changeCount = 0;
function incChange() { changeCount += 1; }

function countOpen(tx, { factionId } = {}) {
  let sql = "SELECT COUNT(*) AS c FROM world_invasions WHERE open = 1";
  const params = [];
  if (factionId !== undefined) {
    sql += " AND faction_id = ?";
    params.push(factionId);
  }
  try {
    const row = tx.prepare(sql).get(...params);
    return { ok: true, count: Number(row.c) };
  } catch (err) {
    return { ok: false, reason: `TX_FAILED: ${String(err)}` };
  }
}

function countOpenConduit(tx, { factionId } = {}) {
  let sql = "SELECT COUNT(*) AS c FROM world_invasions WHERE open = 1 AND invasion_id LIKE 'inv-c-%'";
  const params = [];
  if (factionId !== undefined) {
    sql += " AND faction_id = ?";
    params.push(factionId);
  }
  try {
    const row = tx.prepare(sql).get(...params);
    return { ok: true, count: Number(row.c) };
  } catch (err) {
    return { ok: false, reason: `TX_FAILED: ${String(err)}` };
  }
}

function countConduitSince(tx, { factionId, since }) {
  try {
    const row = tx.prepare(`SELECT COUNT(*) AS c FROM world_invasions WHERE faction_id = ? AND started_at >= ?
      AND idempotency_key LIKE 'invasion:inv-c-%'`).get(factionId, since);
    return { ok: true, count: Number(row.c) };
  } catch (err) {
    return { ok: false, reason: `TX_FAILED: ${String(err)}` };
  }
}

function listOpen(tx, { factionId, limit } = {}) {
  let sql = "SELECT * FROM world_invasions WHERE open = 1";
  const params = [];
  if (factionId !== undefined) {
    sql += " AND faction_id = ?";
    params.push(factionId);
  }
  sql += " ORDER BY invasion_id";
  if (Number.isSafeInteger(limit) && limit > 0) {
    sql += " LIMIT ?";
    params.push(limit);
  }
  try {
    const rows = tx.prepare(sql).all(...params);
    return { ok: true, invasions: rows };
  } catch (err) {
    return { ok: false, reason: `TX_FAILED: ${String(err)}` };
  }
}

function getInvasion(tx, invasionId) {
  try {
    const row = tx.prepare("SELECT * FROM world_invasions WHERE invasion_id = ?").get(invasionId);
    return { ok: true, invasion: row || null };
  } catch (err) {
    return { ok: false, reason: `TX_FAILED: ${String(err)}` };
  }
}

function insertInvasionInTx(tx, spec) {
  const { invasionId, idempotencyKey, rollRound, factionId, profileId, beachheadSystemId, captureRangeJumps,
    fleetIds, plan, startedAt, withdrawAt } = spec;
  if (!invasionId || typeof invasionId !== "string" || invasionId.length > S.MAX_INVASION_ID_LENGTH) {
    return { ok: false, reason: "INVASION_INVALID_INPUT" };
  }
  try {
    const existing = tx.prepare("SELECT 1 FROM world_invasions WHERE beachhead_system_id = ? AND open = 1").get(beachheadSystemId);
    if (existing) return { ok: false, reason: "BEACHHEAD_OPEN" };
    const existingRound = tx.prepare("SELECT 1 FROM world_invasions WHERE roll_round = ?").get(rollRound);
    if (existingRound) return { ok: false, reason: "INVASION_EXISTS" };
    const fleetIdsJson = JSON.stringify(fleetIds);
    const planJson = JSON.stringify(plan);
    const now = startedAt;
    tx.prepare(`INSERT INTO world_invasions (
      invasion_id, idempotency_key, roll_round, faction_id, profile_id, beachhead_system_id,
      capture_range_jumps, state, open, step_seq, withdraw_round, fleet_ids_json, plan_json,
      started_at, withdraw_at, ended_at, end_reason, created_at, updated_at, version
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, ?, ?, ?, ?, NULL, NULL, ?, ?, 1)`).run(
      invasionId, idempotencyKey, rollRound, factionId, profileId, beachheadSystemId,
      captureRangeJumps, S.STATE_ACTIVE, fleetIdsJson, planJson, startedAt, withdrawAt, now, now
    );
    const row = tx.prepare("SELECT * FROM world_invasions WHERE invasion_id = ?").get(invasionId);
    incChange();
    return { ok: true, invasion: row };
  } catch (err) {
    return { ok: false, reason: `TX_FAILED: ${String(err)}` };
  }
}

function transition(tx, { invasionId, expectedVersion, from, to, patch, key, at }) {
  const { stepSeq, withdrawRound, endedAt, endReason } = patch || {};
  if (!Number.isSafeInteger(at) || at < 0) return { ok: false, reason: "INVASION_INVALID_INPUT" };
  const eventType = S.transitionEventType(to);
  if (!eventType) return { ok: false, reason: "INVASION_BAD_EDGE" };
  if (!S.OPEN_STATES.includes(from) && from !== S.STATE_WITHDRAWING) {
    return { ok: false, reason: "STATE_MISMATCH" };
  }
  if (from === S.STATE_ACTIVE && to !== S.STATE_ENDED && to !== S.STATE_WITHDRAWING) {
    return { ok: false, reason: "INVASION_BAD_EDGE" };
  }
  if (from === S.STATE_WITHDRAWING && to !== S.STATE_WITHDRAWING && to !== S.STATE_ENDED) {
    return { ok: false, reason: "INVASION_BAD_EDGE" };
  }
  try {
    const applied = tx.prepare("SELECT 1 FROM world_event_journal WHERE idempotency_key = ? AND state = 'APPLIED'").get(key);
    if (applied) return { ok: true, duplicate: true, invasion: null };
    const row = tx.prepare("SELECT * FROM world_invasions WHERE invasion_id = ?").get(invasionId);
    if (!row) return { ok: false, reason: "VERSION_CONFLICT" };
    if (row.version !== expectedVersion) return { ok: false, reason: "VERSION_CONFLICT" };
    if (row.state !== from) return { ok: false, reason: "STATE_MISMATCH" };
    const nextOpen = S.OPEN_STATES.includes(to) ? 1 : 0;
    const nextVersion = row.version + 1;
    const updates = [];
    const params = [];
    if (stepSeq !== undefined) { updates.push("step_seq = ?"); params.push(stepSeq); }
    if (withdrawRound !== undefined) { updates.push("withdraw_round = ?"); params.push(withdrawRound); }
    if (endedAt !== undefined) { updates.push("ended_at = ?"); params.push(endedAt); }
    if (endReason !== undefined) { updates.push("end_reason = ?"); params.push(endReason); }
    updates.push("state = ?", "open = ?", "version = ?", "updated_at = ?");
    params.push(to, nextOpen, nextVersion, at);
    if (updates.length === 0) return { ok: false, reason: "INVASION_INVALID_INPUT" };
    params.push(invasionId);
    const sql = `UPDATE world_invasions SET ${updates.join(", ")} WHERE invasion_id = ?`;
    const info = tx.prepare(sql).run(...params);
    if (info.changes !== 1) return { ok: false, reason: "VERSION_CONFLICT" };
    const updated = tx.prepare("SELECT * FROM world_invasions WHERE invasion_id = ?").get(invasionId);
    tx.prepare(`INSERT INTO world_event_journal (idempotency_key, kind, aggregate_type, aggregate_id, event_type, payload, payload_hash, state, created_at, applied_at)
      VALUES (?, 'APPLY', 'invasion', ?, ?, '{}', ?, 'APPLIED', ?, ?)`).run(
      key, invasionId, eventType, "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", at, at
    );
    incChange();
    return { ok: true, duplicate: false, invasion: updated };
  } catch (err) {
    return { ok: false, reason: `TX_FAILED: ${String(err)}` };
  }
}

function advanceStepInTx(tx, input) {
  const { invasionId, expectedVersion, expectedSeq, at } = input || {};
  if (!invasionId || typeof invasionId !== "string" || !Number.isSafeInteger(expectedVersion)
    || !Number.isSafeInteger(expectedSeq) || !Number.isSafeInteger(at)) {
    return { ok: false, reason: "INVASION_INVALID_INPUT" };
  }
  try {
    const info = tx.prepare(`UPDATE world_invasions SET step_seq = step_seq + 1, version = version + 1, updated_at = ?
      WHERE invasion_id = ? AND version = ? AND step_seq = ? AND state = ?`).run(
      at, invasionId, expectedVersion, expectedSeq, S.STATE_ACTIVE);
    const row = tx.prepare("SELECT * FROM world_invasions WHERE invasion_id = ?").get(invasionId);
    if (info.changes === 1) return { ok: true, invasion: row };
    if (!row || row.version !== expectedVersion || row.step_seq !== expectedSeq) return { ok: false, reason: "VERSION_CONFLICT" };
    return { ok: false, reason: "STATE_MISMATCH" };
  } catch (err) {
    return { ok: false, reason: `TX_FAILED: ${String(err)}` };
  }
}

function bumpTotalsInTx(tx, factionId, { started = 0, collapsed = 0, withdrawn = 0 } = {}, at) {
  if (started === 0 && collapsed === 0 && withdrawn === 0) return { ok: true };
  try {
    const existing = tx.prepare("SELECT * FROM world_invasion_totals WHERE faction_id = ?").get(factionId);
    if (existing) {
      const nextVersion = existing.version + 1;
      tx.prepare(`UPDATE world_invasion_totals SET
        started = started + ?, collapsed = collapsed + ?, withdrawn = withdrawn + ?,
        updated_at = ?, version = ?
        WHERE faction_id = ?`).run(started, collapsed, withdrawn, at, nextVersion, factionId);
    } else {
      tx.prepare(`INSERT INTO world_invasion_totals (faction_id, started, collapsed, withdrawn, updated_at, version)
        VALUES (?, ?, ?, ?, ?, 1)`).run(factionId, started, collapsed, withdrawn, at);
    }
    incChange();
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: `TX_FAILED: ${String(err)}` };
  }
}

function pruneEndedInTx(tx, { endedBefore, limit }) {
  if (!Number.isSafeInteger(endedBefore) || endedBefore < 0) return { ok: false, reason: "INVASION_INVALID_INPUT" };
  const lim = Number.isSafeInteger(limit) && limit > 0 ? limit : 50;
  try {
    const info = tx.prepare(`DELETE FROM world_invasions WHERE ended_at IS NOT NULL AND ended_at < ? AND open = 0 LIMIT ?`).run(endedBefore, lim);
    if (info.changes > 0) incChange();
    return { ok: true, deleted: info.changes };
  } catch (err) {
    return { ok: false, reason: `TX_FAILED: ${String(err)}` };
  }
}

function getTotals(tx, factionId) {
  try {
    const row = tx.prepare("SELECT * FROM world_invasion_totals WHERE faction_id = ?").get(factionId);
    return { ok: true, totals: row || { faction_id: factionId, started: 0, collapsed: 0, withdrawn: 0, updated_at: 0, version: 0 } };
  } catch (err) {
    return { ok: false, reason: `TX_FAILED: ${String(err)}` };
  }
}

function listRecentEnded(tx, { limit } = {}) {
  const lim = Number.isSafeInteger(limit) && limit > 0 ? limit : 20;
  try {
    const rows = tx.prepare(`SELECT * FROM world_invasions
      WHERE open = 0 AND ended_at IS NOT NULL
      ORDER BY ended_at DESC, invasion_id DESC
      LIMIT ?`).all(lim);
    return { ok: true, invasions: rows };
  } catch (err) {
    return { ok: false, reason: `TX_FAILED: ${String(err)}` };
  }
}

function listTotals(tx) {
  try {
    const rows = tx.prepare("SELECT * FROM world_invasion_totals ORDER BY faction_id").all();
    return { ok: true, totals: rows };
  } catch (err) {
    return { ok: false, reason: `TX_FAILED: ${String(err)}` };
  }
}

function getChangeCount() {
  return changeCount;
}

module.exports = {
  countOpen,
  countOpenConduit,
  countConduitSince,
  listOpen,
  getInvasion,
  insertInvasionInTx,
  transition,
  advanceStepInTx,
  bumpTotalsInTx,
  pruneEndedInTx,
  getTotals,
  listRecentEnded,
  listTotals,
  getChangeCount,
};