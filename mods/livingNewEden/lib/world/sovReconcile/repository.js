"use strict";

const { toBind } = require("../../persistence/repository");
const { TABLE_NAME: RECONCILE_TABLE, STATE } = require("./schema");
const { TABLE_NAME: PROJECTION_LOG_TABLE } = require("../sovProjection/schema");

const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const EPISODE_KEY_PREFIX = "sov:episode:";

function invalid(detail) {
  return { ok: false, reason: "REPO_INVALID_INPUT", detail };
}

function txMissing(tx) {
  return !tx || tx.inTransaction !== true;
}

function isPositiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeId(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function numOrNull(value) {
  return value === null || value === undefined ? null : Number(value);
}

function foreignAllianceOf(metaJson) {
  if (typeof metaJson !== "string" || metaJson === "") return null;
  try {
    const meta = JSON.parse(metaJson);
    return meta && isPositiveId(meta.foreignAllianceId) ? meta.foreignAllianceId : null;
  } catch (_err) {
    return null;
  }
}

function readPage(tx, opts) {
  if (txMissing(tx)) return TX_REQUIRED;
  if (!opts || typeof opts !== "object") return invalid("opts");
  const afterSystemId = opts.afterSystemId === undefined ? 0 : Math.trunc(Number(opts.afterSystemId));
  if (!Number.isSafeInteger(afterSystemId) || afterSystemId < 0) return invalid("opts.afterSystemId");
  if (!Number.isSafeInteger(opts.limit) || opts.limit < 1) return invalid("opts.limit");
  const limit = opts.limit;

  const rows = tx.prepare(`
    SELECT
      l.system_id, l.last_controller, l.last_alliance, l.last_corp, l.last_action, l.last_seq,
      l.updated_at AS log_updated_at, l.version AS log_version,
      r.id AS ep_id, r.version AS ep_version, r.controller_faction_id AS ep_faction_id, r.alliance_id AS ep_alliance_id,
      r.bound_seq AS ep_bound_seq, r.at_ms AS ep_bound_at, r.foreign_at AS ep_foreign_at, r.meta_json AS ep_meta_json,
      s.system_id AS world_system_id, s.controller_faction_id AS world_controller, s.occupation_state, s.phase_seq
    FROM "${PROJECTION_LOG_TABLE}" l
    LEFT JOIN "${RECONCILE_TABLE}" r
      ON r.id = (SELECT MIN(r2.id) FROM "${RECONCILE_TABLE}" r2 WHERE r2.system_id = l.system_id)
    LEFT JOIN "world_system_state" s ON s.system_id = l.system_id
    WHERE l.system_id > ?
    ORDER BY l.system_id
    LIMIT ?
  `).all(toBind(afterSystemId), toBind(limit));

  const value = rows.map((row) => ({
    systemId: Number(row.system_id),
    log: {
      lastController: numOrNull(row.last_controller),
      lastAlliance: numOrNull(row.last_alliance),
      lastCorp: numOrNull(row.last_corp),
      lastAction: row.last_action,
      lastSeq: Number(row.last_seq),
      updatedAt: Number(row.log_updated_at),
      version: Number(row.log_version),
    },
    episode: row.ep_id === null
      ? null
      : {
          id: Number(row.ep_id),
          version: Number(row.ep_version),
          factionId: numOrNull(row.ep_faction_id),
          allianceId: Number(row.ep_alliance_id),
          boundSeq: Number(row.ep_bound_seq),
          boundAt: Number(row.ep_bound_at),
          foreignAt: Number(row.ep_foreign_at),
          foreignAllianceId: foreignAllianceOf(row.ep_meta_json),
        },
    world: row.world_system_id === null
      ? null
      : {
          controllerFactionId: numOrNull(row.world_controller),
          occupationState: row.occupation_state,
          phaseSeq: Number(row.phase_seq),
        },
  }));

  const nextAfterSystemId = rows.length === limit ? Number(rows[rows.length - 1].system_id) : null;
  return { ok: true, rows: Object.freeze(value), nextAfterSystemId };
}

function countForeign(tx) {
  if (txMissing(tx)) return TX_REQUIRED;
  const count = Number(tx.prepare(`SELECT COUNT(*) AS n FROM "${RECONCILE_TABLE}" WHERE action = ?`)
    .get(STATE.FOREIGN).n);
  return { ok: true, count };
}

function markForeignInTx(tx, row) {
  if (txMissing(tx)) return TX_REQUIRED;
  if (!row || typeof row !== "object") return invalid("row");
  if (!isPositiveId(row.systemId)) return invalid("systemId");
  if (!isPositiveId(row.factionId)) return invalid("factionId");
  if (!isPositiveId(row.allianceId)) return invalid("allianceId");
  if (!isNonNegativeId(row.boundSeq)) return invalid("boundSeq");
  if (!isPositiveId(row.boundAt)) return invalid("boundAt");
  if (!isPositiveId(row.foreignAt)) return invalid("foreignAt");
  const foreignAllianceId = row.foreignAllianceId === null || row.foreignAllianceId === undefined
    ? null : row.foreignAllianceId;
  if (foreignAllianceId !== null && !isPositiveId(foreignAllianceId)) return invalid("foreignAllianceId");

  const exists = tx.prepare(`SELECT 1 FROM "${RECONCILE_TABLE}" WHERE system_id = ?`).get(toBind(row.systemId));
  if (exists) return { ok: false, reason: "EPISODE_EXISTS" };

  const key = `${EPISODE_KEY_PREFIX}${row.systemId}:${row.boundSeq}:${row.foreignAt}`;
  try {
    const info = tx.prepare(`
      INSERT INTO "${RECONCILE_TABLE}" (
        fact_key, kind, system_id, bound_seq, foreign_at, alliance_id,
        controller_faction_id, world_row_id, action, points, at_ms, until_ms, meta_json, version
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, ?, NULL, ?, 1)
    `).run(key, STATE.FOREIGN, toBind(row.systemId), toBind(row.boundSeq), toBind(row.foreignAt),
      toBind(row.allianceId), toBind(row.factionId), STATE.FOREIGN, toBind(row.boundAt),
      JSON.stringify({ foreignAllianceId }));
    return { ok: true, id: Number(info.lastInsertRowid), version: 1 };
  } catch (err) {
    return { ok: false, reason: "INSERT_FAILED", detail: String(err && err.message ? err.message : err) };
  }
}

function deleteEpisodeInTx(tx, systemId, expectedVersion) {
  if (txMissing(tx)) return TX_REQUIRED;
  if (!isPositiveId(systemId)) return invalid("systemId");
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) return invalid("expectedVersion");

  const info = tx.prepare(`DELETE FROM "${RECONCILE_TABLE}" WHERE system_id = ? AND version = ?`)
    .run(toBind(systemId), toBind(expectedVersion));
  if (info.changes === 0) {
    const row = tx.prepare(`SELECT version FROM "${RECONCILE_TABLE}" WHERE system_id = ? ORDER BY id LIMIT 1`)
      .get(toBind(systemId));
    if (!row) return { ok: false, reason: "ROW_NOT_FOUND" };
    return { ok: false, reason: "VERSION_CONFLICT", expectedVersion, actualVersion: Number(row.version) };
  }
  return { ok: true };
}

module.exports = {
  readPage,
  countForeign,
  markForeignInTx,
  deleteEpisodeInTx,
  TX_REQUIRED,
  EPISODE_KEY_PREFIX,
};
