"use strict";

const { toBind } = require("../../persistence/repository");

const TABLE_NAME = "world_player_sov_clock";
const PHASES = Object.freeze(["SIEGED", "REINFORCED"]);
const MAX_ID_LENGTH = 64;
const CODES = Object.freeze({ VERSION_CONFLICT: "VERSION_CONFLICT", SQL_FAILED: "PLAYER_SOV_CLOCK_SQL_FAILED" });

const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isText = (v) => typeof v === "string" && v.length >= 1 && v.length <= MAX_ID_LENGTH;
const txMissing = (db) => !db || db.inTransaction !== true;
const invalid = (detail) => ({ ok: false, reason: "INVALID_INPUT", detail });
const failed = (err) => ({ ok: false, reason: CODES.SQL_FAILED, detail: String((err && err.message) || err).slice(0, 120) });

function upPlayerSovClock(db) {
  db.exec(`CREATE TABLE world_player_sov_clock (
    claim_id       TEXT    PRIMARY KEY CHECK (length(claim_id) BETWEEN 1 AND 64),
    phase          TEXT    NOT NULL CHECK (phase IN ('SIEGED','REINFORCED')),
    phase_key      INTEGER NOT NULL CHECK (phase_key > 0),
    credited_ms    INTEGER NOT NULL CHECK (credited_ms >= 0),
    last_sample_at INTEGER NOT NULL,
    version        INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    updated_at     INTEGER NOT NULL
  ) STRICT;`);
}

function toClock(row) {
  return Object.freeze({ claimId: row.claim_id, phase: row.phase, phaseKey: Number(row.phase_key),
    creditedMs: Number(row.credited_ms), lastSampleAt: Number(row.last_sample_at), version: Number(row.version),
    updatedAt: Number(row.updated_at) });
}

function createPlayerSovClockRepository() {
  const cache = new WeakMap();

  function stmts(db) {
    let s = cache.get(db);
    if (s) return s;
    const T = TABLE_NAME;
    s = {
      byId: db.prepare(`SELECT * FROM ${T} WHERE claim_id = ?`),
      upsert: db.prepare(`INSERT INTO ${T} (claim_id, phase, phase_key, credited_ms, last_sample_at, version, updated_at)
        VALUES (?, ?, ?, ?, ?, 1, ?)
        ON CONFLICT(claim_id) DO UPDATE SET phase = excluded.phase, phase_key = excluded.phase_key,
          credited_ms = excluded.credited_ms, last_sample_at = excluded.last_sample_at,
          version = ${T}.version + 1, updated_at = excluded.updated_at
        WHERE ${T}.phase_key <> excluded.phase_key OR ${T}.phase <> excluded.phase`),
      update: db.prepare(`UPDATE ${T} SET credited_ms = ?, last_sample_at = ?, version = version + 1, updated_at = ?
        WHERE claim_id = ? AND version = ? AND phase = ? AND phase_key = ?`),
      remove: db.prepare(`DELETE FROM ${T} WHERE claim_id = ?`),
      prune: db.prepare(`DELETE FROM ${T} WHERE claim_id IN (SELECT c.claim_id FROM ${T} c
        LEFT JOIN world_player_sov p ON p.claim_id = c.claim_id
        WHERE p.claim_id IS NULL OR p.state NOT IN ('SIEGED','REINFORCED') LIMIT ?)`),
    };
    cache.set(db, s);
    return s;
  }

  function get(db, claimId) {
    if (txMissing(db)) return TX_REQUIRED;
    if (!isText(claimId)) return invalid("claimId");
    try {
      const row = stmts(db).byId.get(claimId);
      return { ok: true, clock: row ? toClock(row) : null };
    } catch (err) {
      return failed(err);
    }
  }

  function put(db, spec) {
    if (txMissing(db)) return TX_REQUIRED;
    const p = spec || {};
    if (!isText(p.claimId) || !PHASES.includes(p.phase) || !isId(p.phaseKey) || !isTime(p.creditedMs)
      || !isTime(p.sampledAt) || !(p.expectVersion === null || isId(p.expectVersion))) return invalid("spec");
    try {
      const s = stmts(db);
      const r = p.expectVersion === null
        ? s.upsert.run(p.claimId, p.phase, toBind(p.phaseKey), toBind(p.creditedMs), toBind(p.sampledAt),
          toBind(p.sampledAt))
        : s.update.run(toBind(p.creditedMs), toBind(p.sampledAt), toBind(p.sampledAt), p.claimId,
          toBind(p.expectVersion), p.phase, toBind(p.phaseKey));
      if (Number(r.changes) !== 1) return { ok: false, reason: CODES.VERSION_CONFLICT, claimId: p.claimId };
      return { ok: true, clock: toClock(s.byId.get(p.claimId)) };
    } catch (err) {
      return failed(err);
    }
  }

  function remove(db, claimId) {
    if (txMissing(db)) return TX_REQUIRED;
    if (!isText(claimId)) return invalid("claimId");
    try {
      return { ok: true, removed: Number(stmts(db).remove.run(claimId).changes) };
    } catch (err) {
      return failed(err);
    }
  }

  function pruneOrphans(db, limit) {
    if (txMissing(db)) return TX_REQUIRED;
    if (!isId(limit)) return invalid("limit");
    try {
      return { ok: true, pruned: Number(stmts(db).prune.run(toBind(limit)).changes) };
    } catch (err) {
      return failed(err);
    }
  }

  return Object.freeze({ get, put, remove, pruneOrphans });
}

module.exports = { TABLE_NAME, PHASES, CODES, upPlayerSovClock, createPlayerSovClockRepository };
