"use strict";

const S = require("./schema");

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isInt = (v) => Number.isSafeInteger(v);
const isText = (v, max) => typeof v === "string" && v.length >= 1 && v.length <= max;
const invalid = (detail) => ({ ok: false, reason: "INVALID_INPUT", detail });

function placeholders(n) {
  return new Array(n).fill("?").join(",");
}

function toEscalation(row) {
  return Object.freeze({
    escalationId: row.escalation_id,
    sourceInstanceId: Number(row.source_instance_id),
    sourceSystemId: Number(row.source_system_id),
    sourceTemplateId: row.source_template_id,
    sourceFactionId: row.source_faction_id === null ? null : Number(row.source_faction_id),
    targetSystemId: Number(row.target_system_id),
    jumps: Number(row.jumps),
    templateId: row.template_id,
    dedRating: Number(row.ded_rating),
    siteKey: row.site_key,
    seed: Number(row.seed),
    createdAt: Number(row.created_at),
    expiresAt: Number(row.expires_at),
  });
}

function getByIdInTx(tx, escalationId) {
  const row = tx.prepare(`SELECT * FROM ${S.TABLE} WHERE escalation_id = ?`).get(String(escalationId));
  return row ? toEscalation(row) : null;
}

function countCreatedSinceInTx(tx, since) {
  return Number(tx.prepare(`SELECT COUNT(*) AS n FROM ${S.TABLE} WHERE created_at >= ?`).get(since).n);
}

function countActiveInTx(tx, now) {
  return Number(tx.prepare(`SELECT COUNT(*) AS n FROM ${S.TABLE} WHERE expires_at > ?`).get(now).n);
}

function countForCharacterSinceInTx(tx, characterId, since) {
  return Number(tx.prepare(`SELECT COUNT(*) AS n FROM ${S.RECIPIENTS_TABLE} WHERE character_id = ? AND created_at >= ?`)
    .get(characterId, since).n);
}

function insertInTx(tx, row, characterIds) {
  const r = row || {};
  if (!isText(r.escalationId, S.MAX_ESCALATION_ID)) return invalid("escalationId");
  if (!isId(r.sourceInstanceId)) return invalid("sourceInstanceId");
  if (!isId(r.sourceSystemId)) return invalid("sourceSystemId");
  if (!isText(r.sourceTemplateId, S.MAX_TEMPLATE_ID)) return invalid("sourceTemplateId");
  if (r.sourceFactionId !== null && !isId(r.sourceFactionId)) return invalid("sourceFactionId");
  if (!isId(r.targetSystemId)) return invalid("targetSystemId");
  if (!Number.isSafeInteger(r.jumps) || r.jumps < 0) return invalid("jumps");
  if (!isText(r.templateId, S.MAX_TEMPLATE_ID)) return invalid("templateId");
  if (!Number.isSafeInteger(r.dedRating) || r.dedRating < 0) return invalid("dedRating");
  if (!isText(r.siteKey, S.MAX_TEMPLATE_ID)) return invalid("siteKey");
  if (!isInt(r.seed)) return invalid("seed");
  if (!isTime(r.createdAt)) return invalid("createdAt");
  if (!isTime(r.expiresAt) || r.expiresAt <= r.createdAt) return invalid("expiresAt");
  if (!Array.isArray(characterIds) || characterIds.length === 0 || !characterIds.every(isId)
    || new Set(characterIds).size !== characterIds.length) return invalid("characterIds");
  tx.prepare(`INSERT INTO ${S.TABLE} (escalation_id, source_instance_id, source_system_id, source_template_id,
    source_faction_id, target_system_id, jumps, template_id, ded_rating, site_key, seed, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(r.escalationId, r.sourceInstanceId, r.sourceSystemId, r.sourceTemplateId, r.sourceFactionId,
      r.targetSystemId, r.jumps, r.templateId, r.dedRating, r.siteKey, r.seed, r.createdAt, r.expiresAt);
  const insert = tx.prepare(`INSERT INTO ${S.RECIPIENTS_TABLE} (escalation_id, character_id, created_at)
    VALUES (?, ?, ?)`);
  for (const c of characterIds) insert.run(r.escalationId, c, r.createdAt);
  return { ok: true };
}

function deleteExpiredInTx(tx, before, limit) {
  if (!isTime(before)) return invalid("before");
  if (!isId(limit)) return invalid("limit");
  const ids = tx.prepare(`SELECT escalation_id AS id FROM ${S.TABLE} WHERE expires_at < ?
    ORDER BY expires_at, escalation_id LIMIT ?`).all(before, limit).map((x) => x.id);
  if (ids.length === 0) return { ok: true, deleted: 0 };
  const marks = placeholders(ids.length);
  tx.prepare(`DELETE FROM ${S.RECIPIENTS_TABLE} WHERE escalation_id IN (${marks})`).run(...ids);
  const rows = tx.prepare(`DELETE FROM ${S.TABLE} WHERE escalation_id IN (${marks})`).run(...ids);
  return { ok: true, deleted: Number(rows.changes) };
}

module.exports = { getByIdInTx, countCreatedSinceInTx, countActiveInTx, countForCharacterSinceInTx, insertInTx,
  deleteExpiredInTx, toEscalation };
