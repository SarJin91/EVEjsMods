"use strict";

const { KIND_APPLY } = require("../../persistence/journal");
const { toBind } = require("../../persistence/repository");
const S = require("./schema");
const { canTransitionTrip } = require("./tripMachine");

const T = S.TRIP_TABLE;
const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const OPEN_JSON = JSON.stringify(S.OPEN_TRIP_STATES);
const START_STATES = Object.freeze([S.OUTBOUND, S.RETURNING]);
const SUM_CAP = 1e15;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isText = (v, max) => typeof v === "string" && v.length >= 1 && v.length <= max;
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const nullOr = (check) => (v) => v === null || check(v);
const isOpId = nullOr((v) => isText(v, S.MAX_ID_LENGTH));
const isReason = nullOr((v) => isText(v, S.MAX_REASON_LENGTH));
const PATCH = Object.freeze({
  phaseSeq: ["phase_seq", isCount],
  watchRound: ["watch_round", isCount],
  returnOperationId: ["return_operation_id", isOpId],
  abortReason: ["abort_reason", isReason],
  rattingStartedAt: ["ratting_started_at", nullOr(isTime)],
  rattingEndsAt: ["ratting_ends_at", nullOr(isTime)],
  endedAt: ["ended_at", nullOr(isTime)],
  endReason: ["end_reason", isReason],
  waitRound: ["wait_round", isCount],
  haulUnits: ["haul_units", (v) => isCount(v) && v <= S.MAX_HAUL_UNITS],
  iskEarned: ["isk_earned", (v) => isCount(v) && v <= SUM_CAP],
});

const invalid = (detail) => ({ ok: false, reason: "CAPSULEERS_INVALID_INPUT", detail });
const txMissing = (tx) => !tx || tx.inTransaction !== true;
const num = (v) => (v === null || v === undefined ? null : Number(v));

function toTrip(row) {
  return Object.freeze({
    tripId: row.trip_id, idempotencyKey: row.idempotency_key, kind: row.kind, corpSlot: num(row.corp_slot),
    fleetId: row.fleet_id, originSystemId: num(row.origin_system_id), baseSystemId: num(row.base_system_id),
    targetSystemId: num(row.target_system_id), outboundOperationId: row.outbound_operation_id,
    returnOperationId: row.return_operation_id, state: row.state, phaseSeq: num(row.phase_seq),
    watchRound: num(row.watch_round), abortReason: row.abort_reason, rattingStartedAt: num(row.ratting_started_at),
    rattingEndsAt: num(row.ratting_ends_at), kills: num(row.kills), iskEarned: num(row.isk_earned),
    dispatchedAt: num(row.dispatched_at), endedAt: num(row.ended_at), endReason: row.end_reason,
    createdAt: num(row.created_at), updatedAt: num(row.updated_at), version: num(row.version),
    waitRound: num(row.wait_round),
    contractId: row.contract_id === undefined ? null : row.contract_id,
    fieldId: row.field_id === undefined ? null : row.field_id,
    haulUnits: row.haul_units === undefined ? 0 : num(row.haul_units),
  });
}

function createTripRepository(deps) {
  const { journal, clock } = deps || {};
  if (!journal || typeof journal.applyOnce !== "function") throw new TypeError("capsuleer tripRepository: journal");
  if (!clock || typeof clock.now !== "function") throw new TypeError("capsuleer tripRepository: clock");
  const cache = new WeakMap();
  let changes = 0;

  function stmts(db) {
    let s = cache.get(db);
    if (s) return s;
    s = {
      updates: new Map(),
      byId: db.prepare(`SELECT * FROM ${T} WHERE trip_id = ?`),
      openByFleet: db.prepare(`SELECT * FROM ${T} WHERE fleet_id = ? AND state IN ${S.OPEN_TRIP_STATES_SQL}`),
      openByField: db.prepare(`SELECT trip_id FROM ${T} WHERE field_id = ? AND state IN ('${S.OUTBOUND}',
        '${S.RATTING}')`),
      listOpen: db.prepare(`SELECT * FROM ${T} WHERE state IN (SELECT value FROM json_each(?)) AND trip_id > ?
        ORDER BY trip_id LIMIT ?`),
      insert: db.prepare(`INSERT INTO ${T} (trip_id, idempotency_key, kind, corp_slot, fleet_id, origin_system_id,
        base_system_id, target_system_id, outbound_operation_id, return_operation_id, state, phase_seq, watch_round,
        abort_reason, ratting_started_at, ratting_ends_at, kills, isk_earned, dispatched_at, ended_at, end_reason,
        created_at, updated_at, version, contract_id, field_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, NULL, NULL, NULL, 0, 0, ?, NULL, NULL, ?, ?, 1, ?, ?)`),
      pruneIds: db.prepare(`SELECT trip_id FROM ${T} WHERE ended_at IS NOT NULL AND ended_at < ?
        ORDER BY ended_at, trip_id LIMIT ?`),
      watch: db.prepare(`UPDATE ${T} SET watch_round = ?, wait_round = ?, updated_at = ?, version = version + 1
        WHERE trip_id = ? AND version = ?`),
      step: db.prepare(`UPDATE ${T} SET watch_round = ?, kills = ?, isk_earned = ?, updated_at = ?,
        version = version + 1 WHERE trip_id = ? AND version = ?`),
      deleteTrip: db.prepare(`DELETE FROM ${T} WHERE trip_id = ?`),
    };
    cache.set(db, s);
    return s;
  }

  function readNow() {
    const now = clock.now();
    return isTime(now) ? now : undefined;
  }

  const unwrap = (result) => (result.reason === "APPLY_REFUSED" ? result.refusal : result);

  function casRow(s, tripId, expectedVersion, state) {
    const row = s.byId.get(tripId);
    if (!row) return { ok: false, reason: "ROW_NOT_FOUND", tripId };
    if (Number(row.version) !== expectedVersion) {
      return { ok: false, reason: "VERSION_CONFLICT", expectedVersion, actualVersion: Number(row.version) };
    }
    if (row.state !== state) return { ok: false, reason: "STATE_MISMATCH", expected: state, actual: row.state };
    return { ok: true, row };
  }

  function tripIdOfKey(tx, key) {
    if (txMissing(tx)) return TX_REQUIRED;
    const found = journal.findByKey(tx, key);
    if (!found.ok) return found;
    if (found.found && found.entry.kind === KIND_APPLY && found.entry.aggregateType === S.TRIP_AGGREGATE) {
      return { ok: true, tripId: found.entry.aggregateId, duplicate: true };
    }
    if (found.found) return { ok: false, reason: "IDEMPOTENCY_CONFLICT", detail: key };
    return { ok: true, tripId: null, duplicate: false };
  }

  function createTrip(tx, spec, key) {
    if (txMissing(tx)) return TX_REQUIRED;
    const p = spec || {};
    if (!isText(p.tripId, S.MAX_ID_LENGTH) || !isText(p.idempotencyKey, S.MAX_KEY_LENGTH)
      || !S.TRIP_KINDS.includes(p.kind) || !isId(p.slot) || !isText(p.fleetId, S.MAX_ID_LENGTH)
      || !isId(p.originSystemId) || !isId(p.baseSystemId) || !nullOr(isId)(p.targetSystemId)
      || !isOpId(p.outboundOperationId) || !isOpId(p.returnOperationId) || !START_STATES.includes(p.state)
      || !isTime(p.dispatchedAt) || typeof key !== "string" || key.length < 1) return invalid("spec");
    const merc = p.kind === S.MERC_TRIP_KIND;
    const salvage = p.kind === S.SALVAGE_TRIP_KIND;
    if ((p.kind === "rat" || merc || salvage)
      && (p.state !== S.OUTBOUND || p.targetSystemId === null || p.outboundOperationId === null)) {
      return invalid(`spec.kind ${p.kind}`);
    }
    if (p.kind === "home" && (p.state !== S.RETURNING || p.targetSystemId !== null)) return invalid("spec.kind home");
    if (merc ? !isText(p.contractId, S.MAX_ID_LENGTH) : (p.contractId !== undefined && p.contractId !== null)) {
      return invalid("spec.contractId");
    }
    if (salvage ? !isText(p.fieldId, S.MAX_FIELD_ID_LENGTH) : (p.fieldId !== undefined && p.fieldId !== null)) {
      return invalid("spec.fieldId");
    }
    const now = readNow();
    if (now === undefined) return invalid("clock.now");
    const payload = { tripId: p.tripId, kind: p.kind, slot: p.slot, fleetId: p.fleetId,
      originSystemId: p.originSystemId, baseSystemId: p.baseSystemId, targetSystemId: p.targetSystemId,
      outboundOperationId: p.outboundOperationId, returnOperationId: p.returnOperationId, state: p.state,
      ...(merc ? { contractId: p.contractId } : {}), ...(salvage ? { fieldId: p.fieldId } : {}) };
    const r = journal.applyOnce(tx, { key, aggregate: { type: S.TRIP_AGGREGATE, id: p.tripId },
      eventType: S.EVENT_TRIP_CREATED, payload }, (db) => {
      const s = stmts(db);
      if (s.byId.get(p.tripId)) return { ok: false, reason: "TRIP_EXISTS", tripId: p.tripId };
      const open = s.openByFleet.get(p.fleetId);
      if (open) return { ok: false, reason: "TRIP_OPEN", tripId: open.trip_id };
      if (salvage) {
        const taken = s.openByField.get(p.fieldId);
        if (taken) return { ok: false, reason: "FIELD_TAKEN", tripId: taken.trip_id };
      }
      s.insert.run(p.tripId, p.idempotencyKey, p.kind, toBind(p.slot), p.fleetId, toBind(p.originSystemId),
        toBind(p.baseSystemId), p.targetSystemId === null ? null : toBind(p.targetSystemId), p.outboundOperationId,
        p.returnOperationId, p.state, toBind(p.dispatchedAt), toBind(now), toBind(now), merc ? p.contractId : null,
        salvage ? p.fieldId : null);
      return { ok: true };
    });
    if (!r.ok) return unwrap(r);
    if (!r.duplicate) changes += 1;
    return { ok: true, duplicate: r.duplicate === true, tripId: p.tripId };
  }

  function transitionTrip(tx, change, key) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!change || !isText(change.tripId, S.MAX_ID_LENGTH)) return invalid("tripId");
    if (!Number.isSafeInteger(change.expectedVersion) || change.expectedVersion < 1) return invalid("expectedVersion");
    const edge = canTransitionTrip(change.from, change.to);
    if (!edge.ok) return edge;
    const patch = change.patch || {};
    const sets = [];
    const values = [];
    for (const k of Object.keys(patch).sort()) {
      const spec = PATCH[k];
      if (!spec || !spec[1](patch[k])) return invalid(`patch.${k}`);
      sets.push(`${spec[0]} = ?`);
      values.push(patch[k] === null ? null : toBind(patch[k]));
    }
    if (!Object.prototype.hasOwnProperty.call(patch, "waitRound")) sets.push("wait_round = 0");
    const now = readNow();
    if (now === undefined) return invalid("clock.now");
    const r = journal.applyOnce(tx, { key, aggregate: { type: S.TRIP_AGGREGATE, id: change.tripId },
      eventType: S.EVENT_TRIP_TRANSITION, payload: { tripId: change.tripId, from: change.from, to: change.to } },
    (db) => {
      const s = stmts(db);
      const c = casRow(s, change.tripId, change.expectedVersion, change.from);
      if (!c.ok) return c;
      const sql = `UPDATE ${T} SET ${[...sets, "state = ?", "updated_at = ?", "version = version + 1"].join(", ")}
        WHERE trip_id = ? AND version = ?`;
      if (!s.updates.has(sql)) s.updates.set(sql, db.prepare(sql));
      s.updates.get(sql).run(...values, change.to, toBind(now), change.tripId, toBind(change.expectedVersion));
      return { ok: true, trip: toTrip(s.byId.get(change.tripId)) };
    });
    if (!r.ok) return unwrap(r);
    if (r.duplicate) {
      const row = stmts(tx).byId.get(change.tripId);
      return { ok: true, duplicate: true, trip: row ? toTrip(row) : null };
    }
    changes += 1;
    return { ok: true, duplicate: false, trip: r.value.trip };
  }

  function stepTrip(tx, change, key) {
    if (txMissing(tx)) return TX_REQUIRED;
    const c = change || {};
    if (!isText(c.tripId, S.MAX_ID_LENGTH) || !Number.isSafeInteger(c.expectedVersion) || c.expectedVersion < 1
      || !isCount(c.watchRound) || !isCount(c.kills) || !isCount(c.iskEarned)) return invalid("step");
    const now = readNow();
    if (now === undefined) return invalid("clock.now");
    const r = journal.applyOnce(tx, { key, aggregate: { type: S.TRIP_AGGREGATE, id: c.tripId },
      eventType: S.EVENT_TRIP_STEP_DONE, payload: { tripId: c.tripId, watchRound: c.watchRound, kills: c.kills,
        iskEarned: c.iskEarned } }, (db) => {
      const s = stmts(db);
      const got = casRow(s, c.tripId, c.expectedVersion, S.RATTING);
      if (!got.ok) return got;
      s.step.run(toBind(c.watchRound), toBind(Math.min(SUM_CAP, Number(got.row.kills) + c.kills)),
        toBind(Math.min(SUM_CAP, Number(got.row.isk_earned) + c.iskEarned)), toBind(now), c.tripId,
        toBind(c.expectedVersion));
      return { ok: true, trip: toTrip(s.byId.get(c.tripId)) };
    });
    if (!r.ok) return unwrap(r);
    if (r.duplicate) {
      const row = stmts(tx).byId.get(c.tripId);
      return { ok: true, duplicate: true, trip: row ? toTrip(row) : null };
    }
    changes += 1;
    return { ok: true, duplicate: false, trip: r.value.trip };
  }

  function watchTrip(tx, change, key) {
    if (txMissing(tx)) return TX_REQUIRED;
    const c = change || {};
    if (!isText(c.tripId, S.MAX_ID_LENGTH) || !S.OPEN_TRIP_STATES.includes(c.state) || !isCount(c.watchRound)
      || !isCount(c.waitRound) || !Number.isSafeInteger(c.expectedVersion) || c.expectedVersion < 1) {
      return invalid("watch");
    }
    const now = readNow();
    if (now === undefined) return invalid("clock.now");
    const r = journal.applyOnce(tx, { key, aggregate: { type: S.TRIP_AGGREGATE, id: c.tripId },
      eventType: S.EVENT_TRIP_WAIT, payload: { tripId: c.tripId, state: c.state, watchRound: c.watchRound,
        waitRound: c.waitRound } },
    (db) => {
      const s = stmts(db);
      const got = casRow(s, c.tripId, c.expectedVersion, c.state);
      if (!got.ok) return got;
      s.watch.run(toBind(c.watchRound), toBind(c.waitRound), toBind(now), c.tripId, toBind(c.expectedVersion));
      return { ok: true };
    });
    if (!r.ok) return unwrap(r);
    if (!r.duplicate) changes += 1;
    return { ok: true, duplicate: r.duplicate === true };
  }

  function prune(tx, before, limit) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isTime(before) || !isCount(limit)) return invalid("prune");
    if (limit === 0) return { ok: true, pruned: 0 };
    const s = stmts(tx);
    const ids = s.pruneIds.all(toBind(before), toBind(limit)).map((r) => r.trip_id);
    for (const id of ids) s.deleteTrip.run(id);
    if (ids.length > 0) changes += 1;
    return { ok: true, pruned: ids.length };
  }

  const read = (tx, fn) => (txMissing(tx) ? TX_REQUIRED : fn(stmts(tx)));

  return Object.freeze({
    tripIdOfKey,
    createTrip,
    transitionTrip,
    stepTrip,
    watchTrip,
    prune,
    getTrip: (tx, tripId) => read(tx, (s) => {
      const row = s.byId.get(tripId);
      return { ok: true, trip: row ? toTrip(row) : null };
    }),
    findOpenByFleet: (tx, fleetId) => read(tx, (s) => {
      const row = s.openByFleet.get(fleetId);
      return { ok: true, trip: row ? toTrip(row) : null };
    }),
    listOpen: (tx, opts) => read(tx, (s) => {
      const o = opts || {};
      if (!isId(o.limit)) return invalid("limit");
      return { ok: true, trips: s.listOpen.all(OPEN_JSON, typeof o.after === "string" ? o.after : "",
        toBind(o.limit)).map(toTrip) };
    }),
    getChangeCount: () => changes,
  });
}

module.exports = { createTripRepository, toTrip };
