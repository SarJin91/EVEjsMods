"use strict";

const {
  defineTable,
  updateWithVersion,
  toBind,
} = require("../persistence/repository");
const { WRECK_TABLE_NAME, WRECK_ACTIVE } = require("./wreckSchema");
const S = require("./salvageSchema");

const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const txMissing = (tx) => !tx || tx.inTransaction !== true;
const isText = (v, max) =>
  typeof v === "string" && v.length >= 1 && v.length <= max;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isPositiveInt = (v) => Number.isSafeInteger(v) && v > 0;
const isUnits = (v) => Number.isSafeInteger(v) && v >= 0 && v <= S.MAX_UNITS;
const invalid = (detail) => ({
  ok: false,
  reason: "SALVAGE_INVALID_INPUT",
  detail,
});
const unwrap = (r) =>
  r && r.reason === "APPLY_REFUSED" && r.refusal ? r.refusal : r;

const JOB_TABLE = defineTable({
  name: S.SALVAGE_JOB_TABLE_NAME,
  idColumn: "job_id",
  columns: [
    "state",
    "end_reason",
    "phase_seq",
    "next_at",
    "recovering_at",
    "returning_at",
    "delivery_at",
    "completed_at",
    "salvage_units",
    "loot_units",
    "updated_at",
  ],
});

const COLUMNS =
  "job_id, field_id, faction_id, system_id, home_station_id, home_system_id, jumps, fleet_id, state, " +
  "end_reason, phase_seq, travel_ms, recovery_ms, next_at, outbound_at, recovering_at, returning_at, delivery_at, " +
  "completed_at, salvage_units, loot_units, created_at, updated_at, version";
const ACTIVE_IN = S.SALVAGE_ACTIVE_STATES.map(() => "?").join(", ");
const ENTER_COLUMN = Object.freeze({
  [S.SALVAGE_JOB_RECOVERING]: "recovering_at",
  [S.SALVAGE_JOB_RETURNING]: "returning_at",
  [S.SALVAGE_JOB_DELIVERY_PENDING]: "delivery_at",
});

function toJob(row) {
  if (!row) return null;
  return Object.freeze({
    jobId: row.job_id,
    fieldId: row.field_id,
    factionId: row.faction_id,
    systemId: row.system_id,
    homeStationId: row.home_station_id,
    homeSystemId: row.home_system_id,
    jumps: row.jumps,
    fleetId: row.fleet_id,
    state: row.state,
    endReason: row.end_reason,
    phaseSeq: row.phase_seq,
    travelMs: row.travel_ms,
    recoveryMs: row.recovery_ms,
    nextAt: row.next_at,
    outboundAt: row.outbound_at,
    recoveringAt: row.recovering_at,
    returningAt: row.returning_at,
    deliveryAt: row.delivery_at,
    completedAt: row.completed_at,
    salvageUnits: row.salvage_units,
    lootUnits: row.loot_units,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
  });
}

function checkJob(j) {
  if (!j || typeof j !== "object") return "job";
  if (!isText(j.fieldId, S.MAX_FIELD_ID_LENGTH)) return "fieldId";
  if (!isPositiveInt(j.factionId)) return "factionId";
  if (!isPositiveInt(j.systemId)) return "systemId";
  if (![S.SALVAGE_JOB_OUTBOUND, S.SALVAGE_JOB_FAILED].includes(j.state))
    return "state";
  if (j.state === S.SALVAGE_JOB_OUTBOUND) {
    if (!isText(j.homeStationId, S.MAX_STATION_ID_LENGTH))
      return "homeStationId";
    if (!isPositiveInt(j.homeSystemId)) return "homeSystemId";
    if (j.endReason !== null) return "endReason";
    if (!isTime(j.nextAt) || j.nextAt < j.at) return "nextAt";
  } else {
    if (j.homeStationId !== null || j.homeSystemId !== null) return "home";
    if (!S.SALVAGE_END_REASONS.includes(j.endReason)) return "endReason";
    if (j.nextAt !== null) return "nextAt";
  }
  if (!Number.isSafeInteger(j.jumps) || j.jumps < 0) return "jumps";
  if (!isTime(j.travelMs)) return "travelMs";
  if (!isTime(j.recoveryMs)) return "recoveryMs";
  if (!isTime(j.at)) return "at";
  return null;
}

function createSalvageRepository(deps) {
  if (!deps || typeof deps !== "object")
    throw new TypeError("createSalvageRepository: deps missing");
  const { journal, onCount } = deps;
  if (!journal || typeof journal.applyOnce !== "function") {
    throw new TypeError(
      "createSalvageRepository: journal with applyOnce required",
    );
  }
  if (onCount !== undefined && typeof onCount !== "function") {
    throw new TypeError("createSalvageRepository: onCount must be a function");
  }
  const count = (name) => {
    if (!onCount) return;
    try {
      onCount(name, 1);
    } catch (_err) {
    }
  };

  const perDb = new WeakMap();
  function stmts(db) {
    let s = perDb.get(db);
    if (s) return s;
    const T = S.SALVAGE_JOB_TABLE_NAME;
    s = {
      byId: db.prepare(`SELECT ${COLUMNS} FROM ${T} WHERE job_id = ?`),
      byField: db.prepare(`SELECT job_id FROM ${T} WHERE field_id = ?`),
      insert:
        db.prepare(`INSERT INTO ${T} (job_id, field_id, faction_id, system_id, home_station_id, home_system_id,
        jumps, fleet_id, state, end_reason, phase_seq, travel_ms, recovery_ms, next_at, outbound_at, completed_at,
        created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`),
      countActive: db.prepare(
        `SELECT count(*) AS n FROM ${T} WHERE state IN (${ACTIVE_IN})`,
      ),
      listOpen:
        db.prepare(`SELECT ${COLUMNS} FROM ${T} WHERE state IN (${ACTIVE_IN})
        ORDER BY next_at, job_id LIMIT ?`),
      candidates:
        db.prepare(`SELECT f.field_id, f.system_id, f.winner_faction_id, f.ships_lost, f.created_at,
        f.expires_at FROM ${WRECK_TABLE_NAME} f WHERE f.state = ? AND f.expires_at > ?
        AND f.winner_faction_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM ${T} j WHERE j.field_id = f.field_id)
        ORDER BY f.created_at, f.field_id LIMIT ?`),
    };
    perDb.set(db, s);
    return s;
  }

  function insertJobInTx(tx, job, idempotencyKey) {
    if (txMissing(tx)) return TX_REQUIRED;
    const bad = checkJob(job);
    if (bad) return invalid(bad);
    const jobId = S.jobIdOf(job.fieldId);
    const terminal = job.state !== S.SALVAGE_JOB_OUTBOUND;
    const payload = {
      jobId,
      fieldId: job.fieldId,
      factionId: job.factionId,
      systemId: job.systemId,
      homeStationId: job.homeStationId,
      jumps: job.jumps,
      state: job.state,
      endReason: job.endReason,
      at: job.at,
    };
    const result = journal.applyOnce(
      tx,
      {
        key: idempotencyKey,
        aggregate: { type: S.SALVAGE_JOB_AGGREGATE, id: jobId },
        eventType: "SALVAGE_JOB_CREATED",
        payload,
      },
      (db) => {
        const s = stmts(db);
        if (s.byId.get(jobId) || s.byField.get(job.fieldId))
          return { ok: false, reason: "JOB_EXISTS", jobId };
        s.insert.run(
          jobId,
          job.fieldId,
          toBind(job.factionId),
          toBind(job.systemId),
          job.homeStationId,
          toBind(job.homeSystemId),
          toBind(job.jumps),
          job.state,
          job.endReason,
          toBind(terminal ? 0 : 1),
          toBind(job.travelMs),
          toBind(job.recoveryMs),
          toBind(job.nextAt),
          toBind(job.at),
          toBind(terminal ? job.at : null),
          toBind(job.at),
          toBind(job.at),
        );
        return { ok: true };
      },
    );
    if (!result.ok) return unwrap(result);
    if (result.duplicate)
      return { ok: true, duplicate: true, journalId: result.journalId };
    count("salvage.jobInserted");
    return { ok: true, duplicate: false, jobId, journalId: result.journalId };
  }

  function transitionInTx(tx, change, idempotencyKey) {
    if (txMissing(tx)) return TX_REQUIRED;
    const c = change || {};
    if (!isText(c.jobId, S.MAX_JOB_ID_LENGTH)) return invalid("jobId");
    if (!Number.isSafeInteger(c.expectedVersion) || c.expectedVersion < 1)
      return invalid("expectedVersion");
    const edges = S.SALVAGE_TRANSITIONS[c.from];
    if (!edges || !edges.includes(c.to)) return invalid("from/to");
    if (!isTime(c.at)) return invalid("at");
    const terminal = S.SALVAGE_TERMINAL_STATES.includes(c.to);
    if (
      terminal ? c.nextAt !== undefined && c.nextAt !== null : !isTime(c.nextAt)
    )
      return invalid("nextAt");
    if (
      terminal
        ? !S.SALVAGE_END_REASONS.includes(c.endReason)
        : c.endReason !== undefined && c.endReason !== null
    )
      return invalid("endReason");
    for (const k of ["salvageUnits", "lootUnits"])
      if (c[k] !== undefined && !isUnits(c[k])) return invalid(k);
    const payload = {
      jobId: c.jobId,
      from: c.from,
      to: c.to,
      at: c.at,
      nextAt: terminal ? null : c.nextAt,
      endReason: terminal ? c.endReason : null,
      ...(c.salvageUnits !== undefined ? { salvageUnits: c.salvageUnits } : {}),
      ...(c.lootUnits !== undefined ? { lootUnits: c.lootUnits } : {}),
    };
    let phaseSeq = null;
    const result = journal.applyOnce(
      tx,
      {
        key: idempotencyKey,
        aggregate: { type: S.SALVAGE_JOB_AGGREGATE, id: c.jobId },
        eventType: "SALVAGE_JOB_TRANSITION",
        payload,
      },
      (db) => {
        const row = stmts(db).byId.get(c.jobId);
        if (!row) return { ok: false, reason: "NOT_FOUND", jobId: c.jobId };
        if (row.state !== c.from)
          return {
            ok: false,
            reason: "WRONG_STATE",
            expected: c.from,
            actual: row.state,
          };
        if (row.version !== c.expectedVersion) {
          return {
            ok: false,
            reason: "VERSION_CONFLICT",
            expectedVersion: c.expectedVersion,
            actualVersion: row.version,
          };
        }
        phaseSeq = row.phase_seq + 1;
        const patch = {
          state: c.to,
          phase_seq: phaseSeq,
          next_at: payload.nextAt,
          end_reason: payload.endReason,
          updated_at: c.at,
        };
        if (ENTER_COLUMN[c.to]) patch[ENTER_COLUMN[c.to]] = c.at;
        if (terminal) patch.completed_at = c.at;
        if (c.salvageUnits !== undefined) patch.salvage_units = c.salvageUnits;
        if (c.lootUnits !== undefined) patch.loot_units = c.lootUnits;
        const written = updateWithVersion(
          db,
          JOB_TABLE,
          c.jobId,
          c.expectedVersion,
          patch,
        );
        if (!written.ok) return written;
        return { ok: true, version: written.version };
      },
    );
    if (!result.ok) return unwrap(result);
    if (result.duplicate)
      return { ok: true, duplicate: true, journalId: result.journalId };
    count("salvage.transition");
    return {
      ok: true,
      duplicate: false,
      version: result.value.version,
      phaseSeq,
      journalId: result.journalId,
    };
  }

  function getJob(tx, jobId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isText(jobId, S.MAX_JOB_ID_LENGTH)) return invalid("jobId");
    return { ok: true, job: toJob(stmts(tx).byId.get(jobId)) };
  }

  function countActive(tx) {
    if (txMissing(tx)) return TX_REQUIRED;
    return {
      ok: true,
      count: stmts(tx).countActive.get(...S.SALVAGE_ACTIVE_STATES).n,
    };
  }

  function listCandidates(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    const at = opts && opts.at;
    const limit = opts && opts.limit;
    if (!isTime(at)) return invalid("at");
    if (!isPositiveInt(limit)) return invalid("limit");
    const rows = stmts(tx).candidates.all(
      WRECK_ACTIVE,
      toBind(at),
      toBind(limit),
    );
    return {
      ok: true,
      fields: rows.map((r) =>
        Object.freeze({
          fieldId: r.field_id,
          systemId: r.system_id,
          winnerFactionId: r.winner_faction_id,
          shipsLost: r.ships_lost,
          createdAt: r.created_at,
          expiresAt: r.expires_at,
        }),
      ),
    };
  }

  function listOpen(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    const limit = opts && opts.limit;
    if (!isPositiveInt(limit)) return invalid("limit");
    const rows = stmts(tx).listOpen.all(
      ...S.SALVAGE_ACTIVE_STATES,
      toBind(limit + 1),
    );
    return {
      ok: true,
      jobs: rows.slice(0, limit).map(toJob),
      truncated: rows.length > limit,
    };
  }

  return Object.freeze({
    insertJobInTx,
    transitionInTx,
    getJob,
    countActive,
    listCandidates,
    listOpen,
  });
}

module.exports = { createSalvageRepository, JOB_TABLE };
