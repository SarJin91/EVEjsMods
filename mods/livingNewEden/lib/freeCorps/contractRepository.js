"use strict";

const { toBind } = require("../persistence/repository");
const { CONTRACT_KINDS, CONTRACT_GOODS, CONTRACT_STATES, MAX_RETURN_PLAN, MAX_CONTRACT_END_REASON } = require("./schema");

const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const CAS_CONFLICT = Object.freeze({ ok: false, reason: "CAS_CONFLICT" });
const DUPLICATE = Object.freeze({ ok: false, reason: "DUPLICATE" });
const txMissing = (tx) => !tx || typeof tx.prepare !== "function";
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isKey = (v) => typeof v === "string" && v.length >= 7 && v.length <= 48;
const isReason = (v) => typeof v === "string" && v.length >= 1 && v.length <= MAX_CONTRACT_END_REASON;
const invalid = (detail) => ({ ok: false, reason: "INVALID_INPUT", detail });
const num = (v) => (v === null || v === undefined ? null : Number(v));
const S = CONTRACT_STATES;
const STATE_VALUES = Object.freeze(Object.values(S));

const COLUMNS = "contract_key, outbox_key, venture_id, corp_id, kind, goods, state, open, type_id, station_id, "
  + "system_id, issuer_character_id, issuer_corporation_id, lot_isk, quantity, price_isk, vendor_contract_id, "
  + "return_plan, revenue_isk, close_attempts, created_at, opened_at, expires_at, next_check_at, updated_at, ended_at, "
  + "end_reason, version, "
  + "dest_station_id, dest_system_id, reward_isk, collateral_isk, deadline_at, refund_isk";
const INT_COLUMNS = Object.freeze(["corp_id", "open", "type_id", "station_id", "system_id", "issuer_character_id",
  "issuer_corporation_id", "lot_isk", "quantity", "price_isk", "vendor_contract_id", "revenue_isk", "close_attempts",
  "created_at", "opened_at", "expires_at", "next_check_at", "updated_at", "ended_at", "version", "dest_station_id",
  "dest_system_id", "reward_isk", "collateral_isk", "deadline_at", "refund_isk"]);
const COURIER = "COURIER";
const COURIER_GOODS = Object.freeze(["ORE", "MINERAL"]);

function rowOf(r) {
  const out = { ...r };
  for (const c of INT_COLUMNS) out[c] = num(r[c]);
  return Object.freeze(out);
}

function isUnique(err) {
  return Boolean(err && typeof err.code === "string"
    && (err.code.startsWith("SQLITE_CONSTRAINT_UNIQUE") || err.code.startsWith("SQLITE_CONSTRAINT_PRIMARYKEY")))
    || Boolean(err && /UNIQUE constraint failed/.test(String(err.message)));
}

function planText(plan) {
  if (!Array.isArray(plan) || plan.length > 16) return null;
  if (!plan.every((p) => p && isId(p.itemId) && isId(p.quantity))) return null;
  const text = JSON.stringify(plan.map((p) => ({ itemId: p.itemId, quantity: p.quantity })));
  return text.length <= MAX_RETURN_PLAN ? text : null;
}

function createFreeCorpContractRepository() {
  const cache = new WeakMap();
  function stmts(db) {
    let s = cache.get(db);
    if (s) return s;
    s = {
      insert: db.prepare(`INSERT INTO world_free_corp_contracts (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, 'PLANNED', 1, `
        + "?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 0, 0, ?, NULL, NULL, NULL, ?, NULL, NULL, 1, ?, ?, ?, NULL, NULL, "
        + "NULL)"),
      countOpenKind: db.prepare("SELECT COUNT(*) AS n FROM world_free_corp_contracts WHERE open = 1 AND kind = ?"),
      freezeCourier: db.prepare("UPDATE world_free_corp_contracts SET state = 'ISSUING', quantity = ?, price_isk = ?, "
        + "collateral_isk = ?, updated_at = ?, version = version + 1 "
        + "WHERE contract_key = ? AND version = ? AND state = 'PLANNED' AND kind = 'COURIER'"),
      accept: db.prepare("UPDATE world_free_corp_contracts SET state = 'ACCEPTED', deadline_at = ?, next_check_at = ?, "
        + "updated_at = ?, version = version + 1 "
        + "WHERE contract_key = ? AND version = ? AND state = 'OPEN' AND kind = 'COURIER'"),
      planCourierReturn: db.prepare("UPDATE world_free_corp_contracts SET state = 'RETURNING', return_plan = ?, "
        + "refund_isk = ?, end_reason = ?, next_check_at = ?, updated_at = ?, version = version + 1 "
        + "WHERE contract_key = ? AND version = ? AND state = ? AND kind = 'COURIER'"),
      courierEnded: db.prepare("SELECT end_reason, COUNT(*) AS n, COALESCE(SUM(reward_isk), 0) AS reward "
        + "FROM world_free_corp_contracts WHERE open = 0 AND ended_at >= ? AND kind = 'COURIER' "
        + "GROUP BY end_reason ORDER BY end_reason"),
      countOpen: db.prepare("SELECT COUNT(*) AS n FROM world_free_corp_contracts WHERE open = 1"),
      countOpenCorp: db.prepare("SELECT COUNT(*) AS n FROM world_free_corp_contracts WHERE open = 1 AND corp_id = ?"),
      lot: db.prepare("SELECT 1 AS hit FROM world_free_corp_contracts WHERE open = 1 AND corp_id = ? "
        + "AND station_id = ? AND type_id = ? LIMIT 1"),
      get: db.prepare(`SELECT ${COLUMNS} FROM world_free_corp_contracts WHERE contract_key = ?`),
      byVendor: db.prepare(`SELECT ${COLUMNS} FROM world_free_corp_contracts WHERE vendor_contract_id = ?`),
      stalePlanned: db.prepare(`SELECT ${COLUMNS} FROM world_free_corp_contracts WHERE open = 1 `
        + "AND state = 'PLANNED' AND created_at < ? ORDER BY created_at, contract_key LIMIT ?"),
      freeze: db.prepare("UPDATE world_free_corp_contracts SET state = 'ISSUING', quantity = ?, price_isk = ?, "
        + "updated_at = ?, version = version + 1 WHERE contract_key = ? AND version = ? AND state = 'PLANNED'"),
      open: db.prepare("UPDATE world_free_corp_contracts SET state = 'OPEN', vendor_contract_id = ?, opened_at = ?, "
        + "expires_at = ?, next_check_at = ?, updated_at = ?, version = version + 1 "
        + "WHERE contract_key = ? AND version = ? AND state = 'ISSUING'"),
      due: db.prepare(`SELECT ${COLUMNS} FROM world_free_corp_contracts WHERE next_check_at IS NOT NULL `
        + "AND next_check_at <= ? ORDER BY next_check_at, contract_key LIMIT ?"),
      reschedule: db.prepare("UPDATE world_free_corp_contracts SET next_check_at = ?, close_attempts = ?, "
        + "updated_at = ?, version = version + 1 WHERE contract_key = ? AND version = ? AND state = ?"),
      sold: db.prepare("UPDATE world_free_corp_contracts SET state = 'SOLD', open = 0, revenue_isk = ?, "
        + "next_check_at = NULL, ended_at = ?, end_reason = 'SOLD', updated_at = ?, version = version + 1 "
        + "WHERE contract_key = ? AND version = ? AND state = 'OPEN'"),
      planReturn: db.prepare("UPDATE world_free_corp_contracts SET state = 'RETURNING', return_plan = ?, "
        + "end_reason = ?, next_check_at = ?, updated_at = ?, version = version + 1 "
        + "WHERE contract_key = ? AND version = ? AND state = ?"),
      close: db.prepare("UPDATE world_free_corp_contracts SET state = 'CLOSED', open = 0, next_check_at = NULL, "
        + "ended_at = ?, end_reason = ?, updated_at = ?, version = version + 1 "
        + "WHERE contract_key = ? AND version = ? AND state = 'RETURNING'"),
      cancel: db.prepare("UPDATE world_free_corp_contracts SET state = 'CANCELLED', open = 0, next_check_at = NULL, "
        + "ended_at = ?, end_reason = ?, updated_at = ?, version = version + 1 "
        + "WHERE contract_key = ? AND version = ? AND state = ?"),
      prune: db.prepare("DELETE FROM world_free_corp_contracts WHERE contract_key IN (SELECT contract_key "
        + "FROM world_free_corp_contracts WHERE open = 0 AND ended_at < ? ORDER BY ended_at, contract_key LIMIT ?)"),
      endedSince: db.prepare("SELECT state, COUNT(*) AS n, COALESCE(SUM(revenue_isk), 0) AS revenue "
        + "FROM world_free_corp_contracts WHERE open = 0 AND ended_at >= ? GROUP BY state ORDER BY state"),
      recent: db.prepare(`SELECT ${COLUMNS} FROM world_free_corp_contracts `
        + "ORDER BY created_at DESC, contract_key DESC LIMIT ?"),
    };
    cache.set(db, s);
    return s;
  }

  const cas = (info) => (info.changes === 1 ? { ok: true } : CAS_CONFLICT);
  const transitionArgs = (contractKey, expectedVersion, now) => isKey(contractKey) && isId(expectedVersion)
    && isTime(now);

  function insertPlannedInTx(tx, row) {
    if (txMissing(tx)) return TX_REQUIRED;
    const r = row || {};
    if (!isKey(r.contract_key) || typeof r.outbox_key !== "string" || r.outbox_key.length < 12
      || r.outbox_key.length > 96 || typeof r.venture_id !== "string" || r.venture_id.length < 7
      || r.venture_id.length > 40) {
      return invalid("keys");
    }
    if (!CONTRACT_KINDS.includes(r.kind)) return invalid("kind");
    if (!CONTRACT_GOODS.includes(r.goods)) return invalid("goods");
    if (r.state !== S.PLANNED) return invalid("state");
    for (const c of ["corp_id", "type_id", "station_id", "system_id", "issuer_character_id", "issuer_corporation_id",
      "lot_isk"]) {
      if (!isId(r[c])) return invalid(c);
    }
    if (!isTime(r.created_at)) return invalid("created_at");
    const courier = r.kind === COURIER;
    const nil = (v) => v === null || v === undefined;
    if (courier) {
      if (!isId(r.dest_station_id) || !isId(r.dest_system_id) || !isId(r.reward_isk)) return invalid("courier");
      if (r.dest_station_id === r.station_id) return invalid("dest_station_id");
      if (!COURIER_GOODS.includes(r.goods)) return invalid("goods");
    } else if (!nil(r.dest_station_id) || !nil(r.dest_system_id) || !nil(r.reward_isk)) {
      return invalid("courier columns");
    }
    try {
      stmts(tx).insert.run(r.contract_key, r.outbox_key, r.venture_id, toBind(r.corp_id), r.kind, r.goods,
        toBind(r.type_id), toBind(r.station_id), toBind(r.system_id), toBind(r.issuer_character_id),
        toBind(r.issuer_corporation_id), toBind(r.lot_isk), toBind(r.created_at), toBind(r.created_at),
        courier ? toBind(r.dest_station_id) : null, courier ? toBind(r.dest_system_id) : null,
        courier ? toBind(r.reward_isk) : null);
    } catch (err) {
      if (isUnique(err)) return DUPLICATE;
      throw err;
    }
    return { ok: true, contractKey: r.contract_key };
  }

  function countOpenInTx(tx) {
    if (txMissing(tx)) return TX_REQUIRED;
    return { ok: true, count: num(stmts(tx).countOpen.get().n) };
  }

  function countOpenForCorpInTx(tx, corpId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(corpId)) return invalid("corpId");
    return { ok: true, count: num(stmts(tx).countOpenCorp.get(toBind(corpId)).n) };
  }

  function lotTakenInTx(tx, { corpId, stationId, typeId } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(corpId) || !isId(stationId) || !isId(typeId)) return invalid("lot");
    return { ok: true, taken: stmts(tx).lot.get(toBind(corpId), toBind(stationId), toBind(typeId)) !== undefined };
  }

  function getInTx(tx, contractKey) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isKey(contractKey)) return invalid("contractKey");
    const r = stmts(tx).get.get(contractKey);
    return { ok: true, row: r ? rowOf(r) : null };
  }

  function getByVendorIdInTx(tx, vendorContractId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(vendorContractId)) return invalid("vendorContractId");
    const r = stmts(tx).byVendor.get(toBind(vendorContractId));
    return { ok: true, row: r ? rowOf(r) : null };
  }

  function listStalePlannedInTx(tx, { before, limit } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isTime(before) || !isId(limit)) return invalid("before/limit");
    return { ok: true, rows: stmts(tx).stalePlanned.all(toBind(before), toBind(limit)).map(rowOf) };
  }

  function freezeIssueInTx(tx, { contractKey, expectedVersion, quantity, priceIsk, now } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!transitionArgs(contractKey, expectedVersion, now) || !isId(quantity) || !isId(priceIsk)) {
      return invalid("freeze");
    }
    return cas(stmts(tx).freeze.run(toBind(quantity), toBind(priceIsk), toBind(now), contractKey,
      toBind(expectedVersion)));
  }

  function openInTx(tx, { contractKey, expectedVersion, vendorContractId, now, expiresAt, nextCheckAt } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!transitionArgs(contractKey, expectedVersion, now) || !isId(vendorContractId) || !isTime(expiresAt)
      || !isTime(nextCheckAt)) {
      return invalid("open");
    }
    try {
      return cas(stmts(tx).open.run(toBind(vendorContractId), toBind(now), toBind(expiresAt), toBind(nextCheckAt),
        toBind(now), contractKey, toBind(expectedVersion)));
    } catch (err) {
      if (isUnique(err)) return DUPLICATE;
      throw err;
    }
  }

  function listDueChecksInTx(tx, { now, limit } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isTime(now) || !isId(limit)) return invalid("now/limit");
    return { ok: true, rows: stmts(tx).due.all(toBind(now), toBind(limit)).map(rowOf) };
  }

  function rescheduleCheckInTx(tx, { contractKey, expectedVersion, state, nextCheckAt, closeAttempts, now } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!transitionArgs(contractKey, expectedVersion, now)
      || ![S.ISSUING, S.OPEN, S.RETURNING, S.ACCEPTED].includes(state)
      || !(nextCheckAt === null || isTime(nextCheckAt)) || !Number.isSafeInteger(closeAttempts) || closeAttempts < 0) {
      return invalid("reschedule");
    }
    return cas(stmts(tx).reschedule.run(nextCheckAt === null ? null : toBind(nextCheckAt), toBind(closeAttempts),
      toBind(now), contractKey, toBind(expectedVersion), state));
  }

  function soldInTx(tx, { contractKey, expectedVersion, revenueIsk, now } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!transitionArgs(contractKey, expectedVersion, now) || !isId(revenueIsk)) return invalid("sold");
    return cas(stmts(tx).sold.run(toBind(revenueIsk), toBind(now), toBind(now), contractKey, toBind(expectedVersion)));
  }

  function planReturnInTx(tx, { contractKey, expectedVersion, from, plan, reason, now, nextCheckAt } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    const text = planText(plan);
    if (!transitionArgs(contractKey, expectedVersion, now) || ![S.OPEN, S.ISSUING].includes(from) || text === null
      || !isReason(reason)) {
      return invalid("planReturn");
    }
    const at = nextCheckAt === undefined ? now : nextCheckAt;
    if (!isTime(at)) return invalid("nextCheckAt");
    return cas(stmts(tx).planReturn.run(text, reason, toBind(at), toBind(now), contractKey, toBind(expectedVersion),
      from));
  }

  function closeInTx(tx, { contractKey, expectedVersion, endReason, now } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!transitionArgs(contractKey, expectedVersion, now) || !isReason(endReason)) return invalid("close");
    return cas(stmts(tx).close.run(toBind(now), endReason, toBind(now), contractKey, toBind(expectedVersion)));
  }

  function cancelInTx(tx, { contractKey, expectedVersion, from, endReason, now } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!transitionArgs(contractKey, expectedVersion, now) || ![S.PLANNED, S.ISSUING].includes(from)
      || !isReason(endReason)) {
      return invalid("cancel");
    }
    return cas(stmts(tx).cancel.run(toBind(now), endReason, toBind(now), contractKey, toBind(expectedVersion), from));
  }

  function pruneInTx(tx, { before, limit } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isTime(before) || !isId(limit)) return invalid("before/limit");
    return { ok: true, deleted: Number(stmts(tx).prune.run(toBind(before), toBind(limit)).changes) };
  }

  function statsInTx(tx, { since } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isTime(since)) return invalid("since");
    const s = stmts(tx);
    const out = { ok: true, open: num(s.countOpen.get().n), soldSince: 0, closedSince: 0, cancelledSince: 0,
      revenueSince: 0 };
    for (const r of s.endedSince.all(toBind(since))) {
      if (r.state === S.SOLD) out.soldSince = num(r.n);
      else if (r.state === S.CLOSED) out.closedSince = num(r.n);
      else if (r.state === S.CANCELLED) out.cancelledSince = num(r.n);
      out.revenueSince += num(r.revenue);
    }
    return out;
  }

  function countOpenByKindInTx(tx, kind) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!CONTRACT_KINDS.includes(kind)) return invalid("kind");
    return { ok: true, count: num(stmts(tx).countOpenKind.get(kind).n) };
  }

  function freezeCourierInTx(tx, { contractKey, expectedVersion, quantity, collateralIsk, now } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!transitionArgs(contractKey, expectedVersion, now) || !isId(quantity) || !isId(collateralIsk)) {
      return invalid("freezeCourier");
    }
    return cas(stmts(tx).freezeCourier.run(toBind(quantity), toBind(collateralIsk), toBind(collateralIsk), toBind(now),
      contractKey, toBind(expectedVersion)));
  }

  function acceptInTx(tx, { contractKey, expectedVersion, deadlineAt, nextCheckAt, now } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!transitionArgs(contractKey, expectedVersion, now) || !(deadlineAt === null || isTime(deadlineAt))
      || !isTime(nextCheckAt)) {
      return invalid("accept");
    }
    return cas(stmts(tx).accept.run(deadlineAt === null ? null : toBind(deadlineAt), toBind(nextCheckAt), toBind(now),
      contractKey, toBind(expectedVersion)));
  }

  function planCourierReturnInTx(tx, { contractKey, expectedVersion, from, plan, refundIsk, reason, now,
    nextCheckAt } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    const text = planText(plan);
    if (!transitionArgs(contractKey, expectedVersion, now) || ![S.ISSUING, S.OPEN, S.ACCEPTED].includes(from)
      || text === null || !isReason(reason) || !Number.isSafeInteger(refundIsk) || refundIsk < 0) {
      return invalid("planCourierReturn");
    }
    const at = nextCheckAt === undefined ? now : nextCheckAt;
    if (!isTime(at)) return invalid("nextCheckAt");
    return cas(stmts(tx).planCourierReturn.run(text, toBind(refundIsk), reason, toBind(at), toBind(now), contractKey,
      toBind(expectedVersion), from));
  }

  function courierStatsInTx(tx, { since } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isTime(since)) return invalid("since");
    const s = stmts(tx);
    const out = { ok: true, open: num(s.countOpenKind.get(COURIER).n), delivered: 0, failed: 0, rewardIsk: 0 };
    for (const r of s.courierEnded.all(toBind(since))) {
      if (r.end_reason === "DELIVERED") {
        out.delivered = num(r.n);
        out.rewardIsk = num(r.reward);
      } else if (r.end_reason === "COURIER_FAILED") {
        out.failed = num(r.n);
      }
    }
    return out;
  }

  function recentInTx(tx, { limit } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(limit)) return invalid("limit");
    return { ok: true, rows: stmts(tx).recent.all(toBind(limit)).map(rowOf) };
  }

  return Object.freeze({ insertPlannedInTx, countOpenInTx, countOpenForCorpInTx, lotTakenInTx, getInTx,
    getByVendorIdInTx, listStalePlannedInTx, freezeIssueInTx, openInTx, listDueChecksInTx, rescheduleCheckInTx,
    soldInTx, planReturnInTx, closeInTx, cancelInTx, pruneInTx, statsInTx, recentInTx, countOpenByKindInTx,
    freezeCourierInTx, acceptInTx, planCourierReturnInTx, courierStatsInTx });
}

module.exports = { createFreeCorpContractRepository, STATE_VALUES };
