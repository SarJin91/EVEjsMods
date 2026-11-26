"use strict";

const { defineTable, updateWithVersion, toBind } = require("../../persistence/repository");
const { TABLE_NAME, MAX_ACTION_LENGTH, MAX_LOG_IDS } = require("./schema");

const SOV_PROJECTION_LOG_TABLE = defineTable({
  name: TABLE_NAME,
  idColumn: "system_id",
  columns: ["last_controller", "last_alliance", "last_corp", "last_action", "last_seq", "updated_at"],
});

function upsertLog(tx, spec) {
  if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
  if (!spec || typeof spec !== "object") {
    return { ok: false, reason: "REPO_INVALID_INPUT", detail: "spec must be an object" };
  }
  const { systemId, controller = null, alliance = null, corp = null, action, seq, expectedVersion, now } = spec;
  const id = Math.trunc(Number(systemId));
  if (!Number.isSafeInteger(id) || id <= 0) {
    return { ok: false, reason: "REPO_INVALID_INPUT", detail: "systemId must be a positive safe integer" };
  }

  const c = controller === null ? null : Math.trunc(Number(controller));
  if (c !== null && (!Number.isSafeInteger(c) || c <= 0)) {
    return { ok: false, reason: "REPO_INVALID_INPUT", detail: "controller must be null or positive safe integer" };
  }

  const a = alliance === null ? null : Math.trunc(Number(alliance));
  if (a !== null && (!Number.isSafeInteger(a) || a <= 0)) {
    return { ok: false, reason: "REPO_INVALID_INPUT", detail: "alliance must be null or positive safe integer" };
  }

  const corpId = corp === null ? null : Math.trunc(Number(corp));
  if (corpId !== null && (!Number.isSafeInteger(corpId) || corpId <= 0)) {
    return { ok: false, reason: "REPO_INVALID_INPUT", detail: "corp must be null or positive safe integer" };
  }

  if (typeof action !== "string" || action.length === 0 || action.length > MAX_ACTION_LENGTH) {
    return { ok: false, reason: "REPO_INVALID_INPUT", detail: `action must be 1..${MAX_ACTION_LENGTH} chars` };
  }

  const s = Math.trunc(Number(seq));
  if (!Number.isSafeInteger(s) || s < 0) {
    return { ok: false, reason: "REPO_INVALID_INPUT", detail: "seq must be a non-negative safe integer" };
  }

  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
    return { ok: false, reason: "REPO_INVALID_INPUT", detail: "expectedVersion must be a non-negative safe integer" };
  }
  if (!Number.isSafeInteger(now) || now < 0) {
    return { ok: false, reason: "REPO_INVALID_INPUT", detail: "now must be a non-negative safe integer" };
  }

  const row = tx.prepare(`SELECT last_controller, last_alliance, last_seq, updated_at, version FROM "${TABLE_NAME}"
    WHERE system_id = ?`).get(toBind(id));

  if (expectedVersion === 0) {
    if (row) return { ok: false, reason: "VERSION_CONFLICT", expectedVersion, actualVersion: Number(row.version) };
    tx.prepare(
      `INSERT INTO "${TABLE_NAME}" (system_id, last_controller, last_alliance, last_corp, last_action, last_seq, updated_at, version)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)`
    ).run(toBind(id), toBind(c), toBind(a), toBind(corpId), toBind(action), toBind(s), toBind(now));
    return { ok: true, version: 1 };
  }

  if (!row) return { ok: false, reason: "ROW_NOT_FOUND" };
  const actualVersion = Number(row.version);
  if (actualVersion !== expectedVersion) return { ok: false, reason: "VERSION_CONFLICT", expectedVersion, actualVersion };
  if (s < Number(row.last_seq)) return { ok: false, reason: "STALE_SEQ", seq: s, lastSeq: Number(row.last_seq) };

  const toNumberOrNull = (v) => (v === null ? null : Number(v));
  const samePair = toNumberOrNull(row.last_controller) === c && toNumberOrNull(row.last_alliance) === a;
  return updateWithVersion(tx, SOV_PROJECTION_LOG_TABLE, id, expectedVersion, {
    last_controller: c,
    last_alliance: a,
    last_corp: corpId,
    last_action: action,
    last_seq: s,
    updated_at: samePair ? Number(row.updated_at) : now,
  });
}

function getLog(tx, systemId) {
  const id = Math.trunc(Number(systemId));
  if (!Number.isSafeInteger(id) || id <= 0) {
    return { ok: false, reason: "REPO_INVALID_INPUT", detail: "systemId must be a positive safe integer" };
  }

  const stmt = tx.prepare(`SELECT * FROM "${TABLE_NAME}" WHERE system_id = ?`);
  const row = stmt.get(toBind(id));

  if (!row) {
    return { ok: false, reason: "ROW_NOT_FOUND" };
  }

  return {
    ok: true,
    value: {
      system_id: Number(row.system_id),
      last_controller: row.last_controller === null ? null : Number(row.last_controller),
      last_alliance: row.last_alliance === null ? null : Number(row.last_alliance),
      last_corp: row.last_corp === null ? null : Number(row.last_corp),
      last_action: row.last_action,
      last_seq: Number(row.last_seq),
      updated_at: Number(row.updated_at),
      version: Number(row.version),
    },
  };
}

function getLogsByIds(tx, ids) {
  if (!Array.isArray(ids) || ids.length > MAX_LOG_IDS) {
    return { ok: false, reason: "REPO_INVALID_INPUT", detail: `ids must be an array of at most ${MAX_LOG_IDS}` };
  }
  for (const id of ids) {
    if (!Number.isSafeInteger(id) || id <= 0) {
      return { ok: false, reason: "REPO_INVALID_INPUT", detail: "ids must be positive safe integers" };
    }
  }
  const value = new Map();
  if (ids.length === 0) return { ok: true, value };
  const rows = tx.prepare(`SELECT * FROM "${TABLE_NAME}" WHERE system_id IN (SELECT value FROM json_each(?))
    ORDER BY system_id`).all(JSON.stringify(ids));
  for (const row of rows) {
    const systemId = Number(row.system_id);
    value.set(systemId, {
      system_id: systemId,
      last_controller: row.last_controller === null ? null : Number(row.last_controller),
      last_alliance: row.last_alliance === null ? null : Number(row.last_alliance),
      last_corp: row.last_corp === null ? null : Number(row.last_corp),
      last_action: row.last_action,
      last_seq: Number(row.last_seq),
      updated_at: Number(row.updated_at),
      version: Number(row.version),
    });
  }
  return { ok: true, value };
}

function listLogs(tx, opts = {}) {
  const { lastController, lastAction, limit = 100, offset = 0 } = opts;

  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
    return { ok: false, reason: "REPO_INVALID_INPUT", detail: "limit must be 1..1000" };
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    return { ok: false, reason: "REPO_INVALID_INPUT", detail: "offset must be >= 0" };
  }

  let whereClause = "";
  const params = [];

  if (lastController !== undefined && lastController !== null) {
    whereClause = "WHERE last_controller = ?";
    params.push(toBind(Math.trunc(Number(lastController))));
  }

  if (lastAction !== undefined && lastAction !== null) {
    if (typeof lastAction !== "string" || lastAction.length === 0 || lastAction.length > MAX_ACTION_LENGTH) {
      return { ok: false, reason: "REPO_INVALID_INPUT", detail: `lastAction must be 1..${MAX_ACTION_LENGTH} chars` };
    }
    if (whereClause) {
      whereClause += " AND last_action = ?";
    } else {
      whereClause = "WHERE last_action = ?";
    }
    params.push(lastAction);
  }

  params.push(limit, offset);

  const sql = `SELECT * FROM "${TABLE_NAME}" ${whereClause} ORDER BY system_id LIMIT ? OFFSET ?`;
  const stmt = tx.prepare(sql);
  const rows = stmt.all(...params);

  const value = rows.map((row) => ({
    system_id: Number(row.system_id),
    last_controller: row.last_controller === null ? null : Number(row.last_controller),
    last_alliance: row.last_alliance === null ? null : Number(row.last_alliance),
    last_corp: row.last_corp === null ? null : Number(row.last_corp),
    last_action: row.last_action,
    last_seq: Number(row.last_seq),
    updated_at: Number(row.updated_at),
    version: Number(row.version),
  }));

  return { ok: true, value };
}

module.exports = {
  SOV_PROJECTION_LOG_TABLE,
  upsertLog,
  getLog,
  getLogsByIds,
  listLogs,
};