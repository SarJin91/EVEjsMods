"use strict";

const { toBind } = require("../../persistence/repository");
const S = require("./schema");
const R = require("./contractRules");

const T = S.CONTRACT_TABLE;
const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const OPEN_JSON = JSON.stringify(R.OPEN_CONTRACT_STATES);
const TERMINAL = Object.freeze([R.COMPLETED, R.CANCELLED]);
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isText = (v, max) => typeof v === "string" && v.length >= 1 && v.length <= max;
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const isIsk = (v) => Number.isSafeInteger(v) && v >= 0 && v <= R.MAX_FEE_ISK;
const PATCH = Object.freeze({
  onStationAt: ["on_station_at", isTime],
  endedAt: ["ended_at", isTime],
  endReason: ["end_reason", (v) => isText(v, S.MAX_REASON_LENGTH)],
  paidIsk: ["paid_isk", isIsk],
  refundedIsk: ["refunded_isk", isIsk],
});

const invalid = (detail) => ({ ok: false, reason: "CAPSULEERS_INVALID_INPUT", detail });
const txMissing = (tx) => !tx || tx.inTransaction !== true;
const num = (v) => (v === null || v === undefined ? null : Number(v));

function toContract(row) {
  return Object.freeze({
    contractId: row.contract_id, idempotencyKey: row.idempotency_key, corpSlot: num(row.corp_slot),
    fleetId: row.fleet_id, tripId: row.trip_id, employerFactionId: num(row.employer_faction_id),
    enemyFactionId: num(row.enemy_faction_id), targetSystemId: num(row.target_system_id), kind: row.kind,
    state: row.state, feeIsk: num(row.fee_isk), paidIsk: num(row.paid_isk), refundedIsk: num(row.refunded_isk),
    guardMs: num(row.guard_ms), signedAt: num(row.signed_at), onStationAt: num(row.on_station_at),
    endedAt: num(row.ended_at), endReason: row.end_reason, createdAt: num(row.created_at),
    updatedAt: num(row.updated_at), version: num(row.version),
  });
}

function createContractRepository(deps) {
  const { journal, clock } = deps || {};
  if (!journal || typeof journal.applyOnce !== "function") throw new TypeError("contractRepository: journal");
  if (!clock || typeof clock.now !== "function") throw new TypeError("contractRepository: clock");
  const cache = new WeakMap();
  let changes = 0;

  function stmts(db) {
    let s = cache.get(db);
    if (s) return s;
    s = {
      updates: new Map(),
      byId: db.prepare(`SELECT * FROM ${T} WHERE contract_id = ?`),
      openByFleet: db.prepare(`SELECT * FROM ${T} WHERE fleet_id = ? AND state IN ${S.OPEN_CONTRACT_STATES_SQL}`),
      listOpen: db.prepare(`SELECT * FROM ${T} WHERE state IN (SELECT value FROM json_each(?)) AND contract_id > ?
        ORDER BY contract_id LIMIT ?`),
      insert: db.prepare(`INSERT INTO ${T} (contract_id, idempotency_key, corp_slot, fleet_id, trip_id,
        employer_faction_id, enemy_faction_id, target_system_id, kind, state, fee_isk, paid_isk, refunded_isk,
        guard_ms, signed_at, on_station_at, ended_at, end_reason, created_at, updated_at, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, NULL, NULL, NULL, ?, ?, 1)`),
      pruneIds: db.prepare(`SELECT contract_id FROM ${T} WHERE ended_at IS NOT NULL AND ended_at < ?
        ORDER BY ended_at, contract_id LIMIT ?`),
      deleteContract: db.prepare(`DELETE FROM ${T} WHERE contract_id = ?`),
    };
    cache.set(db, s);
    return s;
  }

  function readNow() {
    const now = clock.now();
    return isTime(now) ? now : undefined;
  }

  const unwrap = (result) => (result.reason === "APPLY_REFUSED" ? result.refusal : result);

  function createContract(tx, spec, key) {
    if (txMissing(tx)) return TX_REQUIRED;
    const p = spec || {};
    if (!isText(p.contractId, S.MAX_ID_LENGTH) || !isText(p.idempotencyKey, S.MAX_KEY_LENGTH) || !isId(p.slot)
      || !isText(p.fleetId, S.MAX_ID_LENGTH) || !isText(p.tripId, S.MAX_ID_LENGTH) || !isId(p.employerFactionId)
      || !isId(p.enemyFactionId) || !isId(p.targetSystemId) || !R.CONTRACT_KINDS.includes(p.kind)
      || !isIsk(p.feeIsk) || p.feeIsk < 1 || !isId(p.guardMs) || !isTime(p.signedAt)
      || typeof key !== "string" || key.length < 1) return invalid("spec");
    const now = readNow();
    if (now === undefined) return invalid("clock.now");
    const payload = { contractId: p.contractId, slot: p.slot, fleetId: p.fleetId, tripId: p.tripId,
      employerFactionId: p.employerFactionId, enemyFactionId: p.enemyFactionId, targetSystemId: p.targetSystemId,
      kind: p.kind, feeIsk: p.feeIsk, guardMs: p.guardMs };
    const r = journal.applyOnce(tx, { key, aggregate: { type: S.CONTRACT_AGGREGATE, id: p.contractId },
      eventType: S.EVENT_CONTRACT_CREATED, payload }, (db) => {
      const s = stmts(db);
      if (s.byId.get(p.contractId)) return { ok: false, reason: "CONTRACT_EXISTS", contractId: p.contractId };
      const open = s.openByFleet.get(p.fleetId);
      if (open) return { ok: false, reason: "CONTRACT_OPEN", contractId: open.contract_id };
      s.insert.run(p.contractId, p.idempotencyKey, toBind(p.slot), p.fleetId, p.tripId, toBind(p.employerFactionId),
        toBind(p.enemyFactionId), toBind(p.targetSystemId), p.kind, R.DISPATCHED, toBind(p.feeIsk),
        toBind(p.guardMs), toBind(p.signedAt), toBind(now), toBind(now));
      return { ok: true };
    });
    if (!r.ok) return unwrap(r);
    if (!r.duplicate) changes += 1;
    return { ok: true, duplicate: r.duplicate === true, contractId: p.contractId };
  }

  function transitionContract(tx, change, key) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!change || !isText(change.contractId, S.MAX_ID_LENGTH)) return invalid("contractId");
    if (!Number.isSafeInteger(change.expectedVersion) || change.expectedVersion < 1) return invalid("expectedVersion");
    if (typeof key !== "string" || key.length < 1) return invalid("key");
    const edge = R.canTransitionContract(change.from, change.to);
    if (!edge.ok) return edge;
    const patch = change.patch || {};
    const sets = [];
    const values = [];
    for (const k of Object.keys(patch).sort()) {
      const spec = PATCH[k];
      if (!spec || !spec[1](patch[k])) return invalid(`patch.${k}`);
      sets.push(`${spec[0]} = ?`);
      values.push(toBind(patch[k]));
    }
    if (change.to === R.ON_STATION && !isTime(patch.onStationAt)) return invalid("patch.onStationAt");
    if (TERMINAL.includes(change.to) && (!isTime(patch.endedAt) || typeof patch.endReason !== "string")) {
      return invalid("patch.endedAt/endReason");
    }
    const now = readNow();
    if (now === undefined) return invalid("clock.now");
    const r = journal.applyOnce(tx, { key, aggregate: { type: S.CONTRACT_AGGREGATE, id: change.contractId },
      eventType: S.EVENT_CONTRACT_TRANSITION, payload: { contractId: change.contractId, from: change.from,
        to: change.to } }, (db) => {
      const s = stmts(db);
      const row = s.byId.get(change.contractId);
      if (!row) return { ok: false, reason: "ROW_NOT_FOUND", contractId: change.contractId };
      if (Number(row.version) !== change.expectedVersion) {
        return { ok: false, reason: "VERSION_CONFLICT", expectedVersion: change.expectedVersion,
          actualVersion: Number(row.version) };
      }
      if (row.state !== change.from) return { ok: false, reason: "STATE_MISMATCH", expected: change.from,
        actual: row.state };
      const fee = Number(row.fee_isk);
      if ((patch.paidIsk !== undefined && patch.paidIsk > fee)
        || (patch.refundedIsk !== undefined && patch.refundedIsk > fee)) return invalid("patch above the fee");
      const sql = `UPDATE ${T} SET ${[...sets, "state = ?", "updated_at = ?", "version = version + 1"].join(", ")}
        WHERE contract_id = ? AND version = ?`;
      if (!s.updates.has(sql)) s.updates.set(sql, db.prepare(sql));
      s.updates.get(sql).run(...values, change.to, toBind(now), change.contractId, toBind(change.expectedVersion));
      return { ok: true, contract: toContract(s.byId.get(change.contractId)) };
    });
    if (!r.ok) return unwrap(r);
    if (r.duplicate) {
      const row = stmts(tx).byId.get(change.contractId);
      return { ok: true, duplicate: true, contract: row ? toContract(row) : null };
    }
    changes += 1;
    return { ok: true, duplicate: false, contract: r.value.contract };
  }

  function prune(tx, before, limit) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isTime(before) || !isCount(limit)) return invalid("prune");
    if (limit === 0) return { ok: true, pruned: 0 };
    const s = stmts(tx);
    const ids = s.pruneIds.all(toBind(before), toBind(limit)).map((r) => r.contract_id);
    for (const id of ids) s.deleteContract.run(id);
    if (ids.length > 0) changes += 1;
    return { ok: true, pruned: ids.length };
  }

  const read = (tx, fn) => (txMissing(tx) ? TX_REQUIRED : fn(stmts(tx)));

  return Object.freeze({
    createContract,
    transitionContract,
    prune,
    getContract: (tx, contractId) => read(tx, (s) => {
      if (!isText(contractId, S.MAX_ID_LENGTH)) return invalid("contractId");
      const row = s.byId.get(contractId);
      return { ok: true, contract: row ? toContract(row) : null };
    }),
    findOpenByFleet: (tx, fleetId) => read(tx, (s) => {
      if (!isText(fleetId, S.MAX_ID_LENGTH)) return invalid("fleetId");
      const row = s.openByFleet.get(fleetId);
      return { ok: true, contract: row ? toContract(row) : null };
    }),
    listOpen: (tx, opts) => read(tx, (s) => {
      const o = opts || {};
      if (!isId(o.limit)) return invalid("limit");
      return { ok: true, contracts: s.listOpen.all(OPEN_JSON, typeof o.after === "string" ? o.after : "",
        toBind(o.limit)).map(toContract) };
    }),
    getChangeCount: () => changes,
  });
}

module.exports = { createContractRepository, toContract };
