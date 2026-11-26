"use strict";

const { defineTable, updateWithVersion, toBind } = require("../../persistence/repository");
const { TABLE_NAME, STATE, VISIBLE_STATES } = require("./schema");

const SITES_TABLE = defineTable({
  name: TABLE_NAME,
  idColumn: "site_key",
  columns: ["state", "fail_reason", "instance_id", "site_id", "pos_x", "pos_y", "pos_z", "expires_at",
    "vendor_expires_at", "attempts", "recreate_count", "next_attempt_at", "updated_at"],
});

const INSERT_COLUMNS = Object.freeze(["site_key", "event_id", "slot", "system_id", "template_id", "label",
  "faction_id", "request_hash", "state", "expires_at", "next_attempt_at", "created_at", "updated_at", "site_kind"]);

const DUE_ORDER_SQL = `CASE
    WHEN state = 'CLEANING' THEN 0
    WHEN state = 'ACTIVE' AND (vendor_expires_at IS NULL OR vendor_expires_at <> expires_at + ?) THEN 1
    WHEN state = 'CREATING' THEN 2
    WHEN state = 'LOST' THEN 3
    WHEN state = 'ACTIVE' THEN 4
    WHEN state = 'COMPLETED' THEN 5
    ELSE 6 END`;

const VISIBLE_SQL = VISIBLE_STATES.map((s) => `'${s}'`).join(", ");

const cache = new WeakMap();

function stmts(tx) {
  let s = cache.get(tx);
  if (s) return s;
  s = {
    insert: tx.prepare(`INSERT INTO ${TABLE_NAME} (${INSERT_COLUMNS.join(", ")})
      VALUES (${INSERT_COLUMNS.map(() => "?").join(", ")})`),
    byEventSlot: tx.prepare(`SELECT * FROM ${TABLE_NAME} WHERE event_id = ? AND slot = ?`),
    byKey: tx.prepare(`SELECT * FROM ${TABLE_NAME} WHERE site_key = ?`),
    byEvent: tx.prepare(`SELECT * FROM ${TABLE_NAME} WHERE event_id = ? ORDER BY slot`),
    countLive: tx.prepare(`SELECT COUNT(*) AS n FROM ${TABLE_NAME} WHERE state NOT IN ('PURGED', 'FAILED')`),
    countWindow: tx.prepare(`SELECT COUNT(*) AS n FROM ${TABLE_NAME} WHERE system_id = ? AND created_at > ?`),
    countVisible: tx.prepare(`SELECT COUNT(*) AS n FROM ${TABLE_NAME}
      WHERE system_id = ? AND state IN (${VISIBLE_SQL})`),
    listVisible: tx.prepare(`SELECT * FROM ${TABLE_NAME}
      WHERE system_id = ? AND state IN (${VISIBLE_SQL}) ORDER BY created_at DESC, site_key LIMIT ?`),
    due: tx.prepare(`SELECT * FROM ${TABLE_NAME}
      WHERE state NOT IN ('PURGED', 'FAILED') AND next_attempt_at <= ?
      ORDER BY ${DUE_ORDER_SQL}, next_attempt_at, site_key LIMIT ?`),
    extend: tx.prepare(`UPDATE ${TABLE_NAME} SET expires_at = ?,
        next_attempt_at = CASE WHEN state = 'ACTIVE' THEN ? WHEN state = 'COMPLETED' THEN ? ELSE next_attempt_at END,
        updated_at = ?, version = version + 1
      WHERE event_id = ? AND state IN (${VISIBLE_SQL})`),
    cleanup: tx.prepare(`UPDATE ${TABLE_NAME} SET state = 'CLEANING', next_attempt_at = ?,
        fail_reason = COALESCE(?, fail_reason), updated_at = ?, version = version + 1
      WHERE event_id = ? AND state IN (${VISIBLE_SQL})`),
    releaseSlot: tx.prepare(`UPDATE ${TABLE_NAME} SET state = 'CLEANING', next_attempt_at = ?,
        fail_reason = COALESCE(?, fail_reason), updated_at = ?, version = version + 1
      WHERE event_id = ? AND slot = ? AND state IN (${VISIBLE_SQL})`),
    retain: tx.prepare(`DELETE FROM ${TABLE_NAME} WHERE site_key IN (SELECT site_key FROM ${TABLE_NAME}
      WHERE state IN ('PURGED', 'FAILED') AND updated_at < ? ORDER BY updated_at LIMIT ?)`),
  };
  cache.set(tx, s);
  return s;
}

function num(v) {
  return v === null || v === undefined ? null : Number(v);
}

function rowOf(r) {
  if (!r) return null;
  return Object.freeze({
    siteKey: r.site_key, eventId: r.event_id, slot: Number(r.slot), systemId: Number(r.system_id),
    templateId: r.template_id, label: r.label, factionId: num(r.faction_id), requestHash: r.request_hash,
    state: r.state, failReason: r.fail_reason, instanceId: num(r.instance_id), siteId: num(r.site_id),
    position: r.pos_x === null ? null : Object.freeze({ x: r.pos_x, y: r.pos_y, z: r.pos_z }),
    expiresAt: Number(r.expires_at), vendorExpiresAt: num(r.vendor_expires_at), attempts: Number(r.attempts),
    recreateCount: Number(r.recreate_count), nextAttemptAt: Number(r.next_attempt_at),
    createdAt: Number(r.created_at), updatedAt: Number(r.updated_at), version: Number(r.version),
    siteKind: r.site_kind === undefined ? null : r.site_kind,
  });
}

function insertInTx(tx, rec) {
  stmts(tx).insert.run(rec.siteKey, rec.eventId, toBind(rec.slot), toBind(rec.systemId), rec.templateId, rec.label,
    toBind(rec.factionId), rec.requestHash, STATE.CREATING, toBind(rec.expiresAt), toBind(rec.now), toBind(rec.now),
    toBind(rec.now), rec.siteKind === undefined ? null : rec.siteKind);
  return { ok: true };
}

function getByEventSlotInTx(tx, eventId, slot) {
  return rowOf(stmts(tx).byEventSlot.get(eventId, toBind(slot)));
}

function getByKeyInTx(tx, siteKey) {
  return rowOf(stmts(tx).byKey.get(siteKey));
}

function listByEventInTx(tx, eventId) {
  return stmts(tx).byEvent.all(eventId).map(rowOf);
}

function countLiveInTx(tx) {
  return Number(stmts(tx).countLive.get().n);
}

function countSystemWindowInTx(tx, systemId, sinceExclusive) {
  return Number(stmts(tx).countWindow.get(toBind(systemId), toBind(sinceExclusive)).n);
}

function countVisibleBySystemInTx(tx, systemId) {
  return Number(stmts(tx).countVisible.get(toBind(systemId)).n);
}

function listVisibleBySystemInTx(tx, systemId, limit) {
  return stmts(tx).listVisible.all(toBind(systemId), toBind(limit)).map(rowOf);
}

function listDueInTx(tx, now, limit, graceMs) {
  return stmts(tx).due.all(toBind(now), toBind(graceMs), toBind(limit)).map(rowOf);
}

function extendInTx(tx, eventId, expiresAt, now) {
  return stmts(tx).extend.run(toBind(expiresAt), toBind(now), toBind(expiresAt), toBind(now), eventId).changes;
}

function cleanupInTx(tx, eventId, failReason, now) {
  return stmts(tx).cleanup.run(toBind(now), failReason, toBind(now), eventId).changes;
}

function releaseSlotInTx(tx, eventId, slot, failReason, now) {
  return stmts(tx).releaseSlot.run(toBind(now), failReason, toBind(now), eventId, toBind(slot)).changes;
}

function purgeRetainedInTx(tx, cutoff, limit) {
  return stmts(tx).retain.run(toBind(cutoff), toBind(limit)).changes;
}

function transitionInTx(tx, row, patch) {
  return updateWithVersion(tx, SITES_TABLE, row.siteKey, row.version, patch);
}

module.exports = {
  SITES_TABLE,
  rowOf,
  insertInTx,
  getByEventSlotInTx,
  getByKeyInTx,
  listByEventInTx,
  countLiveInTx,
  countSystemWindowInTx,
  countVisibleBySystemInTx,
  listVisibleBySystemInTx,
  listDueInTx,
  extendInTx,
  cleanupInTx,
  releaseSlotInTx,
  purgeRetainedInTx,
  transitionInTx,
};
