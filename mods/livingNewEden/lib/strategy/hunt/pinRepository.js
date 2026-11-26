"use strict";

const { toBind } = require("../../persistence/repository");
const { TABLE_NAME, PIN_OUTCOMES } = require("./schema");

const MAX_DETAIL_BYTES = 1024;
const T = TABLE_NAME;
const CREATE_KEYS = Object.freeze(["pinId", "idempotencyKey", "factionId", "hunterFleetId", "systemId",
  "targetFleetId", "targetFactionId", "strikeOperationId", "strikeFleetId", "pinnedAt", "untilAt", "detail"]);

const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const txMissing = (tx) => !tx || tx.inTransaction !== true;
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isText = (v) => typeof v === "string" && v.length >= 1 && v.length <= 200;
const invalid = (detail) => ({ ok: false, reason: "HUNT_PIN_INVALID_INPUT", detail });

function parseDetail(text) {
  if (typeof text !== "string" || text === "") return null;
  try {
    return JSON.parse(text);
  } catch (_err) {
    return null;
  }
}

function toPin(row) {
  return Object.freeze({
    pinId: row.pin_id,
    idempotencyKey: row.idempotency_key,
    factionId: row.faction_id,
    hunterFleetId: row.hunter_fleet_id,
    systemId: row.system_id,
    targetKind: row.target_kind,
    targetFleetId: row.target_fleet_id,
    targetFactionId: row.target_faction_id,
    strikeOperationId: row.strike_operation_id,
    strikeFleetId: row.strike_fleet_id,
    pinnedAt: row.pinned_at,
    untilAt: row.until_at,
    pinMs: row.pin_ms,
    state: row.state,
    outcome: row.outcome,
    closedAt: row.closed_at,
    detail: Object.freeze(parseDetail(row.detail_json) || {}),
    updatedAt: row.updated_at,
    version: row.version,
  });
}

function uniqueRefusal(err) {
  const text = String((err && err.message) || "");
  if (text.includes("idempotency_key") || text.includes("pin_id")) return { ok: false, reason: "DUPLICATE_PIN_KEY" };
  if (text.includes("hunter_fleet_id")) return { ok: false, reason: "HUNTER_PINNED" };
  return { ok: false, reason: "TARGET_PINNED" };
}

function createPinRepository() {
  const perDb = new WeakMap();
  function stmts(db) {
    let s = perDb.get(db);
    if (s) return s;
    s = {
      insert: db.prepare(`INSERT INTO ${T} (pin_id, idempotency_key, faction_id, hunter_fleet_id, system_id,
        target_kind, target_fleet_id, target_character_id, target_faction_id, strike_operation_id, strike_fleet_id,
        pinned_at, until_at, pin_ms, state, outcome, closed_at, detail_json, updated_at, version)
        VALUES (?, ?, ?, ?, ?, 'fleet', ?, NULL, ?, ?, ?, ?, ?, ?, 'ACTIVE', NULL, NULL, ?, ?, 1)`),
      byId: db.prepare(`SELECT * FROM ${T} WHERE pin_id = ?`),
      activeHunter: db.prepare(`SELECT * FROM ${T} WHERE hunter_fleet_id = ? AND state = 'ACTIVE'`),
      activeTarget: db.prepare(`SELECT * FROM ${T} WHERE target_fleet_id = ? AND state = 'ACTIVE'`),
      activeTargets: db.prepare(`SELECT target_fleet_id FROM ${T} WHERE state = 'ACTIVE' AND until_at >= ?
        AND target_fleet_id IS NOT NULL AND target_fleet_id IN (SELECT value FROM json_each(?))`),
      blockingTarget: db.prepare(`SELECT * FROM ${T} WHERE target_fleet_id = ? AND state = 'ACTIVE'
        AND until_at > ? LIMIT 1`),
      blockingHunter: db.prepare(`SELECT * FROM ${T} WHERE hunter_fleet_id = ? AND state = 'ACTIVE'
        AND until_at > ? LIMIT 1`),
      activeStrike: db.prepare(`SELECT * FROM ${T} WHERE system_id = ? AND state = 'ACTIVE' AND strike_fleet_id = ?
        ORDER BY pinned_at DESC, pin_id LIMIT 1`),
      countAll: db.prepare(`SELECT count(*) AS n FROM ${T} WHERE state = 'ACTIVE' AND until_at >= ?`),
      countFaction: db.prepare(`SELECT count(*) AS n FROM ${T} WHERE faction_id = ? AND state = 'ACTIVE'
        AND until_at >= ?`),
      close: db.prepare(`UPDATE ${T} SET state = 'CLOSED', outcome = ?, closed_at = ?, updated_at = ?,
        version = version + 1 WHERE pin_id = ? AND version = ? AND state = 'ACTIVE'`),
    };
    perDb.set(db, s);
    return s;
  }

  function createPin(tx, spec) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!spec || typeof spec !== "object") return invalid("spec");
    const extra = Object.keys(spec).find((k) => !CREATE_KEYS.includes(k));
    if (extra !== undefined) return invalid(`spec.${extra}`);
    for (const k of ["pinId", "idempotencyKey", "hunterFleetId", "targetFleetId", "strikeOperationId", "strikeFleetId"]) {
      if (!isText(spec[k])) return invalid(k);
    }
    for (const k of ["factionId", "systemId", "targetFactionId"]) if (!isId(spec[k])) return invalid(k);
    if (!isTime(spec.pinnedAt) || !isTime(spec.untilAt) || spec.untilAt <= spec.pinnedAt) return invalid("untilAt");
    let detail;
    try {
      detail = JSON.stringify(spec.detail || {});
    } catch (_err) {
      return invalid("detail");
    }
    if (Buffer.byteLength(detail, "utf8") > MAX_DETAIL_BYTES) return invalid("detail: > 1 KiB");
    try {
      stmts(tx).insert.run(spec.pinId, spec.idempotencyKey, toBind(spec.factionId), spec.hunterFleetId,
        toBind(spec.systemId), spec.targetFleetId, toBind(spec.targetFactionId), spec.strikeOperationId,
        spec.strikeFleetId, toBind(spec.pinnedAt), toBind(spec.untilAt), toBind(spec.untilAt - spec.pinnedAt), detail,
        toBind(spec.pinnedAt));
    } catch (err) {
      if (err && (err.code === "SQLITE_CONSTRAINT_UNIQUE" || err.code === "SQLITE_CONSTRAINT_PRIMARYKEY")
        && tx.inTransaction === true) {
        return uniqueRefusal(err);
      }
      throw err;
    }
    return { ok: true, pinId: spec.pinId };
  }

  function getPinById(tx, pinId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isText(pinId)) return invalid("pinId");
    const row = stmts(tx).byId.get(pinId);
    return { ok: true, pin: row ? toPin(row) : null };
  }

  function liveFromOf(opts) {
    const v = opts && opts.liveFrom;
    if (v === undefined) return 0;
    return Number.isSafeInteger(v) ? Math.max(0, v) : null;
  }

  function getActivePinForHunter(tx, hunterFleetId, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isText(hunterFleetId)) return invalid("hunterFleetId");
    const from = liveFromOf(opts);
    if (from === null) return invalid("liveFrom");
    const row = stmts(tx).activeHunter.get(hunterFleetId);
    return { ok: true, pin: row && row.until_at >= from ? toPin(row) : null };
  }

  function getActivePinForTarget(tx, targetFleetId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isText(targetFleetId)) return invalid("targetFleetId");
    const row = stmts(tx).activeTarget.get(targetFleetId);
    return { ok: true, pin: row ? toPin(row) : null };
  }

  function getActivePinForStrike(tx, strikeFleetId, systemId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isText(strikeFleetId)) return invalid("strikeFleetId");
    if (!isId(systemId)) return invalid("systemId");
    const row = stmts(tx).activeStrike.get(toBind(systemId), strikeFleetId);
    return { ok: true, pin: row ? toPin(row) : null };
  }

  function activeTargetsAmong(tx, fleetIds, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!Array.isArray(fleetIds) || !fleetIds.every(isText)) return invalid("fleetIds");
    const from = liveFromOf(opts);
    if (from === null) return invalid("liveFrom");
    if (fleetIds.length === 0) return { ok: true, fleetIds: new Set() };
    const rows = stmts(tx).activeTargets.all(toBind(from), JSON.stringify(fleetIds));
    return { ok: true, fleetIds: new Set(rows.map((r) => r.target_fleet_id)) };
  }

  function countActive(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    const factionId = opts && opts.factionId;
    if (factionId !== undefined && !isId(factionId)) return invalid("factionId");
    const from = liveFromOf(opts);
    if (from === null) return invalid("liveFrom");
    const row = factionId === undefined ? stmts(tx).countAll.get(toBind(from))
      : stmts(tx).countFaction.get(toBind(factionId), toBind(from));
    return { ok: true, count: Number(row.n) };
  }

  function getBlockingPinForFleet(tx, fleetId, at) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isText(fleetId)) return invalid("fleetId");
    if (!isTime(at)) return invalid("at");
    const s = stmts(tx);
    const row = s.blockingTarget.get(fleetId, toBind(at)) || s.blockingHunter.get(fleetId, toBind(at));
    return { ok: true, pin: row ? toPin(row) : null };
  }

  function closePin(tx, change) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!change || typeof change !== "object") return invalid("change");
    if (!isText(change.pinId)) return invalid("pinId");
    if (!Number.isSafeInteger(change.expectedVersion) || change.expectedVersion < 1) return invalid("expectedVersion");
    if (!PIN_OUTCOMES.includes(change.outcome)) return invalid("outcome");
    if (!isTime(change.at)) return invalid("at");
    const info = stmts(tx).close.run(change.outcome, toBind(change.at), toBind(change.at), change.pinId,
      toBind(change.expectedVersion));
    if (info.changes !== 1) return { ok: false, reason: "STALE" };
    return { ok: true, version: change.expectedVersion + 1 };
  }

  return Object.freeze({ createPin, getPinById, getActivePinForHunter, getActivePinForTarget, getActivePinForStrike,
    activeTargetsAmong,
    countActive, getBlockingPinForFleet, closePin });
}

module.exports = { createPinRepository, toPin };
