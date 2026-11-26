"use strict";

const S = require("./schema");
const R = require("./contractRules");

const METRIC_HIRES = "capsuleers.hires";
const METRIC_HIRE_REFUSED = "capsuleers.hireRefused";
const METRIC_HIRE_NO_TREASURY = "capsuleers.hireNoTreasury";
const METRIC_ON_STATION = "capsuleers.contractsOnStation";
const METRIC_COMPLETED = "capsuleers.contractsCompleted";
const METRIC_CANCELLED = "capsuleers.contractsCancelled";
const METRIC_FEE_ISK = "capsuleers.contractFeeIsk";
const METRIC_PAID_ISK = "capsuleers.contractPaidIsk";
const METRIC_REFUND_ISK = "capsuleers.contractRefundIsk";
const METRIC_PAYOUT_CAPPED = "capsuleers.contractPayoutCapped";
const METRIC_REFUND_UNAVAILABLE = "capsuleers.contractRefundUnavailable";
const METRIC_ORPHAN_CLOSED = "capsuleers.contractsOrphanClosed";
const METRIC_OPEN = "capsuleers.contractsOpen";
const COUNTERS = Object.freeze({ hires: METRIC_HIRES, hireRefused: METRIC_HIRE_REFUSED,
  hireNoTreasury: METRIC_HIRE_NO_TREASURY, contractsOnStation: METRIC_ON_STATION,
  contractsCompleted: METRIC_COMPLETED, contractsCancelled: METRIC_CANCELLED, contractFeeIsk: METRIC_FEE_ISK,
  contractPaidIsk: METRIC_PAID_ISK, contractRefundIsk: METRIC_REFUND_ISK, contractPayoutCapped: METRIC_PAYOUT_CAPPED,
  contractRefundUnavailable: METRIC_REFUND_UNAVAILABLE, contractsOrphanClosed: METRIC_ORPHAN_CLOSED });
const KEY_ERRORS = Object.freeze(["NESTED_KEY_REUSED", "IDEMPOTENCY_CONFLICT"]);
const REFUND_UNAVAILABLE = "REFUND_UNAVAILABLE";
const ORPHAN = "ORPHAN";
const MAX_DETAIL = 120;
const SAVEPOINT_ABORT = Symbol("capsuleers-contract-savepoint-abort");

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isText = (v) => typeof v === "string" && v.length >= 1 && v.length <= S.MAX_ID_LENGTH;
const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);

function createContractService(deps) {
  const { journal, contracts, corps, ids, config } = deps;
  const C = config.capsuleers;
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  const counters = Object.fromEntries(Object.keys(COUNTERS).map((n) => [n, 0]));
  const memory = new Map();
  let memoryVersion = 0;
  let lastRefusal = null;

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  }

  function bump(name, n = 1) {
    if (!(n > 0) || !Object.prototype.hasOwnProperty.call(counters, name)) return;
    counters[name] += n;
    metric("count", COUNTERS[name], n);
  }

  function treasuryOf() {
    try {
      const t = typeof deps.getTreasury === "function" ? deps.getTreasury() : null;
      return t || null;
    } catch (_err) {
      return null;
    }
  }

  function countTreasury(name, n) {
    const t = treasuryOf();
    if (!t || typeof t.count !== "function" || !(n > 0)) return;
    try {
      t.count(name, n);
    } catch (_err) {
    }
  }

  function openCount() {
    let n = 0;
    for (const c of memory.values()) if (R.OPEN_CONTRACT_STATES.includes(c.state)) n += 1;
    return n;
  }

  function remember(contract) {
    if (!contract || !contract.contractId) return;
    memory.set(contract.contractId, contract);
    memoryVersion += 1;
    metric("gauge", METRIC_OPEN, openCount());
  }

  function setContracts(list) {
    memory.clear();
    for (const c of list || []) if (c && c.contractId) memory.set(c.contractId, c);
    memoryVersion += 1;
    metric("gauge", METRIC_OPEN, openCount());
  }

  function listContracts() {
    return [...memory.values()].sort((a, b) => (a.contractId < b.contractId ? -1 : a.contractId > b.contractId ? 1
      : 0));
  }

  const savepoints = new WeakMap();
  function inSavepoint(tx, fn) {
    let run = savepoints.get(tx);
    if (!run) {
      run = tx.transaction((body, holder) => {
        const r = body();
        if (!r || r.ok !== true) {
          holder.refusal = r || { ok: false, reason: "CAPSULEERS_FAILED" };
          throw SAVEPOINT_ABORT;
        }
        return r;
      });
      savepoints.set(tx, run);
    }
    const holder = { refusal: null };
    try {
      return run(fn, holder);
    } catch (err) {
      if (err === SAVEPOINT_ABORT && tx.inTransaction === true) return holder.refusal;
      throw err;
    }
  }

  function hireInTx(db, spec, k, ratting) {
    const p = spec || {};
    if (!db || db.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
    if (!isId(p.slot) || !isText(p.fleetId) || !isId(p.baseSystemId) || !isId(p.targetSystemId)
      || !isId(p.employerFactionId) || !isId(p.enemyFactionId) || !R.CONTRACT_KINDS.includes(p.kind)
      || !Number.isSafeInteger(p.feeIsk) || p.feeIsk < 1 || !isId(p.guardMs) || !isTime(p.at)
      || !Number.isSafeInteger(p.expectedVersion) || p.expectedVersion < 1 || typeof k !== "string" || k === ""
      || !ratting || typeof ratting.dispatchInTx !== "function") {
      return { ok: false, reason: "CAPSULEERS_INVALID_INPUT" };
    }
    const treasury = treasuryOf();
    if (!treasury || typeof treasury.readMercAccountInDb !== "function"
      || typeof treasury.chargeMercInTx !== "function") return { ok: false, reason: "TREASURY_OFF" };
    const acc = treasury.readMercAccountInDb(db, p.employerFactionId);
    if (!acc || acc.ok !== true) return acc || { ok: false, reason: "TREASURY_READ_FAILED" };
    if (acc.mode !== "ready") return { ok: false, reason: "TREASURY_OFF" };
    if (acc.seeded !== true) return { ok: false, reason: "NO_TREASURY" };
    if (acc.accountMode === "AUSTERITY") return { ok: false, reason: "TREASURY_AUSTERITY" };
    if (!(acc.balanceIsk >= p.feeIsk * C.mercMinTreasuryMultiple)) return { ok: false, reason: "TREASURY_LOW" };
    const fee = treasury.chargeMercInTx(db, { factionId: p.employerFactionId, isk: p.feeIsk, direction: "fee",
      at: p.at }, `${k}:fee`);
    if (!fee || fee.ok !== true) return fee || { ok: false, reason: "TREASURY_FEE_FAILED" };
    if (fee.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${k}:fee` };
    const contractId = ids.next("cc");
    const tripId = ids.next("ct");
    const op = R.KIND_OPERATION[p.kind];
    const c = contracts.createContract(db, { contractId, idempotencyKey: k, slot: p.slot, fleetId: p.fleetId,
      tripId, employerFactionId: p.employerFactionId, enemyFactionId: p.enemyFactionId,
      targetSystemId: p.targetSystemId, kind: p.kind, feeIsk: p.feeIsk, guardMs: p.guardMs, signedAt: p.at },
    `${k}:contract`);
    if (!c.ok) return c;
    if (c.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${k}:contract` };
    const d = ratting.dispatchInTx(db, { kind: S.MERC_TRIP_KIND, slot: p.slot, fleetId: p.fleetId,
      expectedVersion: p.expectedVersion, baseSystemId: p.baseSystemId, targetSystemId: p.targetSystemId, tripId,
      contractId, operationType: op.operationType, objective: op.objective, at: p.at }, k);
    if (!d || d.ok !== true) return d || { ok: false, reason: "DISPATCH_FAILED" };
    if (d.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: `${k}:trip` };
    const g = contracts.getContract(db, contractId);
    if (!g.ok) return g;
    if (!g.contract) return { ok: false, reason: "ROW_NOT_FOUND" };
    return { ok: true, contract: g.contract, trip: d.trip || null };
  }

  function onStationInTx(tx, trip, at, key) {
    if (!trip || !trip.contractId) return { ok: true, skipped: "NO_CONTRACT" };
    const g = contracts.getContract(tx, trip.contractId);
    if (!g.ok) return g;
    const c = g.contract;
    if (!c) return { ok: true, skipped: "NO_CONTRACT" };
    if (c.state !== R.DISPATCHED) return { ok: true, skipped: c.state };
    const t = contracts.transitionContract(tx, { contractId: c.contractId, expectedVersion: c.version,
      from: R.DISPATCHED, to: R.ON_STATION, patch: { onStationAt: at } }, `${key}:contract:station`);
    if (!t.ok) return t;
    return { ok: true, station: t.contract };
  }

  function closeWith(tx, contractId, cause, at, keys) {
    const g = contracts.getContract(tx, contractId);
    if (!g.ok) return g;
    const c = g.contract;
    if (!c) return { ok: true, closed: null, skipped: "NO_CONTRACT" };
    const o = R.closeOutcomeOf(c);
    if (!o) return { ok: true, closed: null, skipped: c.state };
    const reason = String(cause || "CLOSED").slice(0, S.MAX_REASON_LENGTH);
    if (o.to === R.COMPLETED) {
      const cg = corps.getCorp(tx, c.corpSlot);
      if (!cg.ok) return cg;
      const corp = cg.corp;
      const room = corp && corp.state === "ACTIVE" ? C.maxIskBalance - corp.iskBalance : 0;
      let amount = Math.min(c.feeIsk, room);
      if (!(Number.isSafeInteger(amount) && amount > 0)) amount = 0;
      if (amount > 0) {
        const w = journal.applyOnce(tx, { key: keys.pay, aggregate: { type: S.CORP_AGGREGATE, id: c.corpSlot },
          eventType: S.EVENT_WALLET, payload: { kind: "contract", slot: c.corpSlot, contractId: c.contractId,
            amount } }, (db) => corps.credit(db, { slot: c.corpSlot, expectedVersion: corp.version, amount,
          maxBalance: C.maxIskBalance, at }));
        if (!w.ok) {
          if (w.reason === "APPLY_REFUSED") amount = 0;
          else return w;
        }
      }
      const t = contracts.transitionContract(tx, { contractId: c.contractId, expectedVersion: c.version,
        from: c.state, to: R.COMPLETED, patch: { paidIsk: amount, endedAt: at, endReason: reason } }, keys.close);
      if (!t.ok) return t;
      return { ok: true, closed: { to: R.COMPLETED, paidIsk: amount, refundedIsk: 0, capped: amount < c.feeIsk,
        refundUnavailable: false, contract: t.contract } };
    }
    const treasury = treasuryOf();
    let rf;
    try {
      rf = treasury && typeof treasury.chargeMercInTx === "function"
        ? treasury.chargeMercInTx(tx, { factionId: c.employerFactionId, isk: c.feeIsk, direction: "refund", at },
          keys.refund) : { ok: false, reason: "TREASURY_OFF" };
    } catch (err) {
      rf = { ok: false, reason: `TREASURY_THREW: ${messageOf(err)}` };
    }
    if (rf && rf.ok !== true && KEY_ERRORS.includes(rf.reason)) return rf;
    const refunded = rf && rf.ok === true;
    const t = contracts.transitionContract(tx, { contractId: c.contractId, expectedVersion: c.version,
      from: c.state, to: R.CANCELLED, patch: { refundedIsk: refunded ? c.feeIsk : 0, endedAt: at,
        endReason: refunded ? reason : REFUND_UNAVAILABLE } }, keys.close);
    if (!t.ok) return t;
    return { ok: true, closed: { to: R.CANCELLED, paidIsk: 0, refundedIsk: refunded ? c.feeIsk : 0, capped: false,
      refundUnavailable: !refunded, refusal: refunded ? null : String((rf && rf.reason) || "REFUSED"),
      contract: t.contract } };
  }

  function closeForTripInTx(tx, trip, cause, at, key) {
    if (!trip || !trip.contractId) return { ok: true, closed: null, skipped: "NO_CONTRACT" };
    return closeWith(tx, trip.contractId, cause, at, { close: `${key}:contract:close`, pay: `${key}:contract:pay`,
      refund: `${key}:contract:refund` });
  }

  function closeOrphanInTx(tx, contract, at, key, trips) {
    if (!contract || !contract.contractId || !trips) return { ok: true, closed: null, skipped: "NO_CONTRACT" };
    const t = trips.getTrip(tx, contract.tripId);
    if (!t.ok) return t;
    if (t.trip && S.OPEN_TRIP_STATES.includes(t.trip.state)) return { ok: true, closed: null, skipped: "TRIP_OPEN" };
    return inSavepoint(tx, () => closeWith(tx, contract.contractId, ORPHAN, at, { close: key, pay: `${key}:pay`,
      refund: `${key}:refund` }));
  }

  function guardMsOf(tx, contractId) {
    if (!contractId) return C.mercGuardMs;
    const g = contracts.getContract(tx, contractId);
    return g && g.ok && g.contract && isId(g.contract.guardMs) ? g.contract.guardMs : C.mercGuardMs;
  }

  function noteClosed(closed, orphan) {
    if (!closed || !closed.contract) return;
    if (closed.to === R.COMPLETED) {
      bump("contractsCompleted");
      bump("contractPaidIsk", closed.paidIsk);
      if (closed.capped) bump("contractPayoutCapped");
    } else {
      bump("contractsCancelled");
      bump("contractRefundIsk", closed.refundedIsk);
      countTreasury("mercRefundIsk", closed.refundedIsk);
      if (closed.refundUnavailable) {
        bump("contractRefundUnavailable");
        lastRefusal = `REFUND_${closed.refusal || "UNAVAILABLE"}`;
        logger.log(`capsuleers: contract ${closed.contract.contractId} refund unavailable ${closed.refusal || ""}`);
      }
    }
    if (orphan) bump("contractsOrphanClosed");
    remember(closed.contract);
  }

  function onStepCommitted(v) {
    if (!v) return;
    if (v.station) {
      bump("contractsOnStation");
      remember(v.station);
    }
    noteClosed(v.closed, false);
  }

  function onReviewCommitted(v) {
    if (!v) return;
    const hires = Array.isArray(v.hires) ? v.hires : [];
    bump("hires", hires.length);
    const fees = hires.reduce((n, h) => n + (h.contract ? h.contract.feeIsk : 0), 0);
    bump("contractFeeIsk", fees);
    countTreasury("mercFeeIsk", fees);
    bump("hireRefused", v.hireRefused || 0);
    bump("hireNoTreasury", v.hireNoTreasury || 0);
    if (v.lastRefusal) lastRefusal = String(v.lastRefusal).slice(0, MAX_DETAIL);
    setContracts([...(v.open || []), ...hires.map((h) => h.contract).filter((c) => c)]);
    for (const closed of v.orphans || []) noteClosed(closed, true);
  }

  return Object.freeze({
    hireInTx,
    onStationInTx,
    closeForTripInTx,
    closeOrphanInTx,
    guardMsOf,
    onStepCommitted,
    onReviewCommitted,
    setContracts,
    remember,
    listContracts,
    getMemoryVersion: () => memoryVersion,
    getStatus: () => Object.freeze({ counters: Object.freeze({ ...counters }), contractsOpen: openCount(),
      lastRefusal }),
  });
}

module.exports = { createContractService, COUNTERS };
