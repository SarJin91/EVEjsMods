"use strict";

const S = require("./schema");

const T = S.TABLE;
const P = S.PAYOUTS_TABLE;
const MAX_REASON = 120;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isText = (v, max) => typeof v === "string" && v.length >= 1 && v.length <= max;
const invalid = (detail) => ({ ok: false, reason: "INVALID_INPUT", detail });
const nOrNull = (v) => (v === null || v === undefined ? null : Number(v));

function toSituation(row) {
  let helpers = [];
  try {
    const parsed = JSON.parse(row.helpers_json);
    helpers = Array.isArray(parsed) ? parsed.map(Number) : [];
  } catch (_err) {
    helpers = [];
  }
  return Object.freeze({
    situationId: row.situation_id,
    kind: row.kind,
    systemId: Number(row.system_id),
    bucket: Number(row.bucket),
    state: row.state,
    anchorKind: row.anchor_kind,
    anchorId: Number(row.anchor_id),
    speakerId: nOrNull(row.speaker_id),
    pirateFactionId: nOrNull(row.pirate_faction_id),
    victims: Number(row.victims),
    victimsSaved: nOrNull(row.victims_saved),
    helpers: Object.freeze(helpers),
    bootAt: Number(row.boot_at),
    startedAt: Number(row.started_at),
    updatedAt: Number(row.updated_at),
    endedAt: nOrNull(row.ended_at),
    endReason: row.end_reason === null || row.end_reason === undefined ? null : String(row.end_reason),
    version: Number(row.version),
  });
}

function getInTx(tx, situationId) {
  const row = tx.prepare(`SELECT * FROM ${T} WHERE situation_id = ?`).get(situationId);
  return row ? toSituation(row) : null;
}

function listOpenInTx(tx, limit) {
  if (!isId(limit)) return invalid("limit");
  const rows = tx.prepare(`SELECT * FROM ${T} WHERE state = 'OPEN' ORDER BY started_at, situation_id LIMIT ?`)
    .all(limit);
  return { ok: true, rows: rows.map(toSituation) };
}

function listEndedSinceInTx(tx, since, limit) {
  if (!isTime(since)) return invalid("since");
  if (!isId(limit)) return invalid("limit");
  const rows = tx.prepare(`SELECT * FROM ${T} WHERE state <> 'OPEN' AND ended_at >= ?
    ORDER BY ended_at DESC, situation_id LIMIT ?`).all(since, limit + 1);
  return { ok: true, rows: rows.slice(0, limit).map(toSituation), truncated: rows.length > limit };
}

function journalRefusal(j) {
  if (j && j.ok === true && j.duplicate === true) return { ok: false, reason: "DUPLICATE" };
  if (j && j.reason === "IDEMPOTENCY_CONFLICT") return { ok: false, reason: "DUPLICATE", detail: "CONFLICT" };
  const why = j && j.refusal ? j.refusal.reason : null;
  return { ok: false, reason: String(why || (j && j.reason) || "NO_RESULT"),
    ...(j && j.refusal && j.refusal.detail ? { detail: String(j.refusal.detail) } : {}) };
}

function startInTx(tx, journal, r, now) {
  if (!journal || typeof journal.applyOnce !== "function") return { ok: false, reason: "NO_JOURNAL" };
  if (!r || !isText(r.situationId, S.MAX_SITUATION_ID_LENGTH)) return invalid("situationId");
  if (!Object.values(S.KINDS).includes(r.kind)) return invalid("kind");
  if (!isId(r.systemId)) return invalid("systemId");
  if (!isTime(r.bucket)) return invalid("bucket");
  if (!Object.values(S.ANCHOR_KINDS).includes(r.anchorKind)) return invalid("anchorKind");
  if (!isTime(r.anchorId)) return invalid("anchorId");
  if (r.speakerId !== null && !isId(r.speakerId)) return invalid("speakerId");
  if (r.pirateFactionId !== null && !isId(r.pirateFactionId)) return invalid("pirateFactionId");
  if (!isTime(r.victims)) return invalid("victims");
  if (!isTime(r.bootAt)) return invalid("bootAt");
  if (!isTime(now)) return invalid("now");
  const seen = tx.prepare(`SELECT situation_id FROM ${T} WHERE situation_id = ? OR (system_id = ? AND bucket = ?)`)
    .get(r.situationId, r.systemId, r.bucket);
  if (seen) return { ok: false, reason: "DUPLICATE" };
  const j = journal.applyOnce(tx, { key: S.startKeyOf(r.systemId, r.bucket),
    aggregate: { type: S.AGGREGATE, id: r.situationId }, eventType: S.EVENT_STARTED,
    payload: { kind: r.kind, systemId: r.systemId, bucket: r.bucket } },
  (db) => {
    db.prepare(`INSERT INTO ${T} (situation_id, kind, system_id, bucket, state, anchor_kind, anchor_id, speaker_id,
      pirate_faction_id, victims, helpers_json, boot_at, started_at, updated_at)
      VALUES (?, ?, ?, ?, 'OPEN', ?, ?, ?, ?, ?, '[]', ?, ?, ?)`)
      .run(r.situationId, r.kind, r.systemId, r.bucket, r.anchorKind, r.anchorId, r.speakerId, r.pirateFactionId,
        r.victims, r.bootAt, now, now);
    return { ok: true, situation: getInTx(db, r.situationId) };
  });
  if (j && j.ok === true && j.duplicate !== true && j.value && j.value.situation) return j.value;
  return journalRefusal(j);
}

function countRewardsSinceInTx(tx, characterId, since) {
  if (!isId(characterId)) return invalid("characterId");
  if (!isTime(since)) return invalid("since");
  const r = tx.prepare(`SELECT COUNT(*) AS n FROM ${P} WHERE character_id = ? AND created_at >= ?`)
    .get(characterId, since);
  return { ok: true, count: Number(r.n) };
}

function settleInTx(tx, journal, sit, outcome, spec, now) {
  if (!journal || typeof journal.applyOnce !== "function") return { ok: false, reason: "NO_JOURNAL" };
  if (!sit || !isText(sit.situationId, S.MAX_SITUATION_ID_LENGTH) || !isId(sit.version)) return invalid("situation");
  if (!Object.values(S.KINDS).includes(sit.kind) || !isId(sit.systemId) || !isTime(sit.victims)) {
    return invalid("situation");
  }
  if (!S.OUTCOMES.includes(outcome)) return invalid("outcome");
  if (!spec || !isText(spec.endReason, S.MAX_END_REASON_LENGTH)) return invalid("endReason");
  if (!isTime(spec.saved)) return invalid("saved");
  if (!Array.isArray(spec.helpers) || !spec.helpers.every(isId)) return invalid("helpers");
  if (!isTime(now)) return invalid("now");
  const reward = outcome === S.STATES.RESCUED && spec.reward ? spec.reward : null;
  if (reward && (!isTime(reward.iskPerSaved) || !isTime(reward.standingMicro) || !isTime(reward.maxPerDay)
    || (reward.standingMicro > 0 && !isId(reward.standingFactionId)))) return invalid("reward");
  const helpers = [...new Set(spec.helpers)].sort((a, b) => a - b);
  const payload = { kind: sit.kind, systemId: sit.systemId, outcome, victims: sit.victims, saved: spec.saved };
  const j = journal.applyOnce(tx, { key: S.settleKeyOf(sit.situationId),
    aggregate: { type: S.AGGREGATE, id: sit.situationId }, eventType: S.EVENT_RESOLVED, payload },
  (db) => {
    const info = db.prepare(`UPDATE ${T} SET state = ?, victims_saved = ?, helpers_json = ?, ended_at = ?,
      end_reason = ?, updated_at = ?, version = version + 1
      WHERE situation_id = ? AND version = ? AND state = 'OPEN'`)
      .run(outcome, spec.saved, JSON.stringify(helpers), now, spec.endReason, now, sit.situationId, sit.version);
    if (Number(info.changes) !== 1) return { ok: false, reason: "CAS_LOST" };
    let planned = 0;
    let capped = 0;
    const payoutKeys = [];
    const amount = reward ? reward.iskPerSaved * spec.saved : 0;
    const std = reward ? reward.standingMicro : 0;
    if (reward && (amount > 0 || std > 0) && Number.isSafeInteger(amount)) {
      const insert = db.prepare(`INSERT INTO ${P} (payout_key, situation_id, character_id, system_id, amount_isk,
        standing_faction_id, standing_micro, isk_state, std_state, state, attempts, next_attempt_at, last_reason,
        created_at, updated_at, settled_at, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', 0, 0, NULL, ?, ?, NULL, 1) ON CONFLICT(payout_key) DO NOTHING`);
      for (const characterId of helpers) {
        const c = countRewardsSinceInTx(db, characterId, Math.max(0, now - S.DAY_MS));
        if (!c.ok || c.count >= reward.maxPerDay) {
          capped += 1;
          continue;
        }
        const key = S.payoutKeyOf(sit.situationId, characterId);
        const added = insert.run(key, sit.situationId, characterId, sit.systemId, amount,
          std > 0 ? reward.standingFactionId : null, std, amount > 0 ? S.LEG_STATES.PENDING : S.LEG_STATES.SKIPPED,
          std > 0 ? S.LEG_STATES.PENDING : S.LEG_STATES.SKIPPED, now, now);
        if (Number(added.changes) === 1) {
          planned += 1;
          payoutKeys.push(key);
        }
      }
    }
    return { ok: true, situation: getInTx(db, sit.situationId), planned, capped, payoutKeys };
  });
  if (j && j.ok === true && j.duplicate !== true && j.value && j.value.situation) return j.value;
  return journalRefusal(j);
}

function cancelStaleInTx(tx, bootAt, now, limit) {
  if (!isTime(bootAt)) return invalid("bootAt");
  if (!isTime(now)) return invalid("now");
  if (!isId(limit)) return invalid("limit");
  const info = tx.prepare(`UPDATE ${T} SET state = 'CANCELLED', ended_at = ?, end_reason = 'RESTART', updated_at = ?,
    version = version + 1 WHERE situation_id IN (SELECT situation_id FROM ${T} WHERE state = 'OPEN' AND boot_at <> ?
    ORDER BY started_at, situation_id LIMIT ?)`).run(now, now, bootAt, limit);
  return { ok: true, cancelled: Number(info.changes) };
}

function pruneEndedInTx(tx, before, limit) {
  if (!isTime(before)) return invalid("before");
  if (!isId(limit)) return invalid("limit");
  const info = tx.prepare(`DELETE FROM ${T} WHERE situation_id IN (SELECT situation_id FROM ${T}
    WHERE state <> 'OPEN' AND ended_at IS NOT NULL AND ended_at < ? ORDER BY ended_at, situation_id LIMIT ?)`)
    .run(before, limit);
  return { ok: true, deleted: Number(info.changes) };
}

function toPayout(row) {
  return Object.freeze({ payoutKey: row.payout_key, situationId: row.situation_id,
    characterId: Number(row.character_id), systemId: Number(row.system_id), amountIsk: Number(row.amount_isk),
    standingFactionId: nOrNull(row.standing_faction_id), standingMicro: Number(row.standing_micro),
    iskState: row.isk_state, stdState: row.std_state, state: row.state, attempts: Number(row.attempts),
    nextAttemptAt: Number(row.next_attempt_at), lastReason: row.last_reason === null ? null : String(row.last_reason),
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), settledAt: nOrNull(row.settled_at),
    version: Number(row.version) });
}

function getPayoutInTx(tx, payoutKey) {
  const row = tx.prepare(`SELECT * FROM ${P} WHERE payout_key = ?`).get(payoutKey);
  return row ? toPayout(row) : null;
}

function countPendingPayoutsInTx(tx) {
  const r = tx.prepare(`SELECT COUNT(*) AS n FROM ${P} WHERE state = 'PENDING'`).get();
  return { ok: true, pending: Number(r.n) };
}

function listDuePayoutsInTx(tx, limit, now) {
  if (!isId(limit)) return invalid("limit");
  if (!isTime(now)) return invalid("now");
  const rows = tx.prepare(`SELECT * FROM ${P} WHERE state = 'PENDING' AND next_attempt_at <= ?
    ORDER BY next_attempt_at, payout_key LIMIT ?`).all(now, limit);
  if (rows.length >= limit) return { ok: true, payouts: rows.map(toPayout), waiting: null, nextDueAt: null };
  const w = tx.prepare(`SELECT COUNT(*) AS n, MIN(next_attempt_at) AS m FROM ${P}
    WHERE state = 'PENDING' AND next_attempt_at > ?`).get(now);
  return { ok: true, payouts: rows.map(toPayout), waiting: Number(w.n), nextDueAt: nOrNull(w.m) };
}

function markPayoutInTx(tx, p, m, now) {
  if (!p || !isText(p.payoutKey, S.MAX_PAYOUT_KEY_LENGTH) || !isId(p.version)) return invalid("payout");
  const legs = Object.values(S.LEG_STATES);
  if (!m || !legs.includes(m.iskState) || !legs.includes(m.stdState)) return invalid("legs");
  if (!Object.values(S.PAYOUT_ROW_STATES).includes(m.state)) return invalid("state");
  if (!isTime(m.attempts)) return invalid("attempts");
  if (m.nextAttemptAt !== null && m.nextAttemptAt !== undefined && !isTime(m.nextAttemptAt)) {
    return invalid("nextAttemptAt");
  }
  if (m.lastReason !== null && m.lastReason !== undefined && typeof m.lastReason !== "string") {
    return invalid("lastReason");
  }
  if (!isTime(now)) return invalid("now");
  const settled = m.state === S.PAYOUT_ROW_STATES.PENDING ? null : now;
  const nextAt = m.nextAttemptAt === undefined || m.nextAttemptAt === null ? null : m.nextAttemptAt;
  const reason = m.lastReason === undefined || m.lastReason === null ? null : m.lastReason.slice(0, MAX_REASON);
  const info = tx.prepare(`UPDATE ${P} SET isk_state = ?, std_state = ?, state = ?, attempts = ?, last_reason = ?,
    updated_at = ?, settled_at = ?, next_attempt_at = COALESCE(?, next_attempt_at), version = version + 1
    WHERE payout_key = ? AND version = ? AND state = 'PENDING'`)
    .run(m.iskState, m.stdState, m.state, m.attempts, reason, now, settled, nextAt, p.payoutKey, p.version);
  if (Number(info.changes) !== 1) return { ok: false, reason: "CAS_LOST" };
  return { ok: true, payout: getPayoutInTx(tx, p.payoutKey) };
}

function prunePayoutsInTx(tx, before, limit) {
  if (!isTime(before)) return invalid("before");
  if (!isId(limit)) return invalid("limit");
  const info = tx.prepare(`DELETE FROM ${P} WHERE payout_key IN (SELECT payout_key FROM ${P}
    WHERE state <> 'PENDING' AND settled_at IS NOT NULL AND settled_at < ? ORDER BY settled_at, payout_key LIMIT ?)`)
    .run(before, limit);
  return { ok: true, deleted: Number(info.changes) };
}

module.exports = { toSituation, getInTx, listOpenInTx, listEndedSinceInTx, startInTx, settleInTx, countRewardsSinceInTx,
  cancelStaleInTx, pruneEndedInTx, getPayoutInTx, countPendingPayoutsInTx, listDuePayoutsInTx, markPayoutInTx,
  prunePayoutsInTx };
