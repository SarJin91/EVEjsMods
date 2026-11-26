"use strict";

const S = require("./schema");
const { abortAllowed, issuerOf, issuerOfPayload, sellGrantGate, planReturn, closeWanted } = require("./executorRules");
const { characterSeamsOk } = require("./orphans");

const METRIC_WTS_ISSUED = "trade.wtsIssued";
const METRIC_WTS_GRANT_FAILED = "trade.wtsGrantFailed";
const METRIC_WTS_RETURNED = "trade.wtsReturned";
const METRIC_WTS_RETURNED_UNITS = "trade.wtsReturnedUnits";
const METRIC_WTS_RETURN_SHORT = "trade.wtsReturnShort";
const METRIC_WTS_STOCK_LOST = "trade.wtsStockLost";
const METRIC_CONTRACT_LIMIT = "trade.contractLimit";
const METRIC_WTS_SOLD = "trade.wtsSold";
const METRIC_WTS_DELIVERED = "trade.wtsDelivered";
const METRIC_WTS_PROCEEDS_ISK = "trade.wtsProceedsIsk";
const METRIC_WTS_PROCEEDS_TREASURY = "trade.wtsProceedsTreasury";
const METRIC_WTS_PROCEEDS_BURNED = "trade.wtsProceedsBurned";
const METRIC_WTS_PROCEEDS_FAILED = "trade.wtsProceedsFailed";
const METRIC_WTS_PROCEEDS_WAIT = "trade.wtsProceedsWait";

const PROCEEDS_PERMANENT = Object.freeze(["INSUFFICIENT_FUNDS", "CORPORATION_NOT_FOUND", "CHARACTER_NOT_FOUND"]);
const TREASURY_NOT_READY = "TREASURY_NOT_READY";

class SellRollback extends Error {
  constructor(refusal) {
    super(String((refusal && refusal.reason) || "SELL_ROLLBACK"));
    this.refusal = refusal;
  }
}

function metric(telemetry, name, value) {
  if (!telemetry || typeof telemetry.count !== "function") return;
  try { telemetry.count(name, value); } catch (_err) {}
}
function log(logger, ...args) {
  if (logger && typeof logger.log === "function") logger.log(...args);
}

function txReason(txRes) {
  const refusal = txRes && txRes.error instanceof SellRollback ? txRes.error.refusal : null;
  return String((refusal && refusal.reason) || (txRes && txRes.reason) || "TX_FAILED");
}

const ensure = (res, fallback) => {
  if (!res || res.ok !== true) throw new SellRollback(res || { ok: false, reason: fallback });
  return res;
};

function sellSeamsOk(adapter) {
  if (!adapter || typeof adapter.tradeSellSeams !== "function" || typeof adapter.tradeGrantStock !== "function"
      || typeof adapter.tradeGrantReceipt !== "function" || typeof adapter.tradeCreateSellContract !== "function") {
    return false;
  }
  try {
    const r = adapter.tradeSellSeams();
    return Boolean(r && r.ok === true);
  } catch (_err) {
    return false;
  }
}

function readIssueState(deps, offerId, issueKey) {
  const { store, journal, offers } = deps;
  const r = store.transaction("trade.sell.read_issue", (db) => {
    const cur = offers.getOffer(db, offerId);
    if (!cur || cur.ok !== true || !cur.offer) return { ok: false, reason: "OFFER_NOT_FOUND" };
    const box = journal.findByKey(db, typeof issueKey === "string" ? issueKey : S.issueOutboxKey(offerId));
    if (!box || box.ok !== true || !box.found) return { ok: false, reason: "NO_OUTBOX" };
    const out = journal.findByKey(db, S.stockOutKey(offerId));
    if (!out || out.ok !== true) return { ok: false, reason: (out && out.reason) || "JOURNAL_READ_FAILED" };
    return { ok: true, offer: cur.offer, entry: box.entry, stockOutFound: out.found === true };
  });
  if (!r.ok) return { ok: false, reason: r.reason || "TX_FAILED" };
  return r.value;
}

function openInTx(deps, offer, journalId, contractId, now) {
  const { store, journal, offers } = deps;
  const tx = store.transaction("trade.sell.issuing_open", (db) => {
    ensure(offers.transitionOfferInTx(db, {
      offerId: offer.offerId, expectedVersion: offer.version, from: S.ISSUING, to: S.OPEN, reason: "", at: now,
      patch: { contractId },
    }, S.transitionKey(offer.offerId, offer.stateSeq + 1, S.OPEN)), "TRANSITION_FAILED");
    ensure(journal.markApplied(db, journalId), "MARK_FAILED");
    return { ok: true };
  });
  return tx.ok ? { ok: true } : { ok: false, reason: txReason(tx) };
}

async function stepIssueSell(deps, offer) {
  const { adapter, config, clock, telemetry, logger, mode, lastPermanent } = deps;
  const tradeCfg = (config && config.trade) || {};
  const read = readIssueState(deps, offer.offerId);
  if (!read.ok) return { action: "error", reason: read.reason };
  const current = read.offer;
  if (current.side !== S.SIDE_SELL) return { action: "error", reason: "SELL_NOT_SELL" };
  if (current.state !== S.ISSUING) return { action: "retry", reason: "STALE" };
  const payload = read.entry.payload;
  const journalId = read.entry.journalId;
  const now = clock.now();

  if (!sellSeamsOk(adapter)) {
    log(logger, `[tradeExecutor] WTS seams unavailable, offer ${current.offerId} waits`);
    return { action: "error", reason: "SELL_SEAMS_UNAVAILABLE" };
  }

  const iss = issuerOfPayload(payload, tradeCfg.walletAccountKey);
  const findRes = await adapter.tradeFindContract({ ownerKind: iss.kind, ownerId: iss.ownerId, offerId: current.offerId });
  if (!findRes || !findRes.ok) return { action: "error", reason: (findRes && findRes.reason) || "FIND_FAILED" };

  if (findRes.found === "record") {
    const opened = openInTx(deps, current, journalId, findRes.contractId, now);
    if (!opened.ok) return { action: "error", reason: opened.reason };
    lastPermanent.delete(current.offerId);
    if (findRes.duplicates > 0) log(logger, `[tradeExecutor] duplicate WTS contracts for ${current.offerId}: ${findRes.duplicates}`);
    metric(telemetry, METRIC_WTS_ISSUED, 1);
    return { action: "opened", contractId: findRes.contractId };
  }
  if (findRes.found === "pending") return { action: "retry" };

  const abort = abortAllowed(findRes, current, now, tradeCfg.issueTimeoutMs, lastPermanent.get(current.offerId) === true);
  if ((mode === "cleanup" && findRes.found === null) || abort) {
    return abortSell(deps, current, mode === "cleanup" ? S.END_REASON_DISABLED : S.END_REASON_ISSUE_FAILED);
  }
  if (mode === "cleanup") return { action: "retry" };

  const gate = sellGrantGate(current, read.stockOutFound);
  if (gate !== null) {
    const seen = deps.gateSeen instanceof Set ? deps.gateSeen : null;
    if (seen === null || !seen.has(current.offerId)) {
      if (seen !== null) seen.add(current.offerId);
      log(logger, `[tradeExecutor] WTS offer ${current.offerId}: ${gate} - no grant`);
    }
    return { action: "error", reason: gate };
  }

  const grant = await adapter.tradeGrantStock({
    ownerKind: iss.kind, ownerId: iss.ownerId, npcStationId: payload.npcStationId, typeId: payload.typeId,
    quantity: payload.quantity, packaged: payload.packaged === true, key: payload.grantKey,
  });
  if (!grant || !grant.ok) {
    metric(telemetry, METRIC_WTS_GRANT_FAILED, 1);
    if (grant && grant.permanent === true && grant.ambiguous !== true) lastPermanent.set(current.offerId, true);
    log(logger, `[tradeExecutor] WTS grant failed offer ${current.offerId}: ${(grant && (grant.detail || grant.reason)) || "no_result"}`);
    return { action: "retry", reason: (grant && grant.reason) || "GRANT_FAILED" };
  }

  const createRes = await adapter.tradeCreateSellContract({ ...payload, grantItemIds: grant.itemIds, quantity: payload.quantity });
  if (!createRes || !createRes.ok) {
    if (createRes && createRes.rejected === true) {
      metric(telemetry, "trade.createRejected", 1);
      log(logger, `[tradeExecutor] WTS create rejected offer ${current.offerId}: ${createRes.detail || ""}`);
    }
    if (createRes && createRes.reason === "CONTRACT_LIMIT") {
      metric(telemetry, METRIC_CONTRACT_LIMIT, 1);
      return abortSell(deps, current, S.END_REASON_ISSUE_FAILED);
    }
    if (createRes && createRes.permanent === true) lastPermanent.set(current.offerId, true);
    return { action: "retry", reason: (createRes && createRes.reason) || "CONTRACT_CREATE_FAILED" };
  }
  if (!Number.isSafeInteger(createRes.contractId) || createRes.contractId <= 0) return { action: "retry", reason: "NO_CONTRACT_ID" };
  const opened = openInTx(deps, current, journalId, createRes.contractId, now);
  if (!opened.ok) return { action: "error", reason: opened.reason };
  lastPermanent.delete(current.offerId);
  metric(telemetry, METRIC_WTS_ISSUED, 1);
  return { action: "opened", contractId: createRes.contractId };
}

async function abortSell(deps, offer, reason, opts) {
  const { store, journal, offers, adapter, config, clock, telemetry, logger, lastPermanent } = deps;
  const tradeCfg = (config && config.trade) || {};
  const o = opts || {};
  const read = readIssueState(deps, offer.offerId, o.issueKey);
  if (!read.ok) return { action: "error", reason: read.reason };
  const current = read.offer;
  if (current.state !== S.ISSUING) return { action: "retry", reason: "STALE" };
  const payload = read.entry.payload;
  const journalId = read.entry.journalId;
  const now = clock.now();
  const transition = (db, to, why) => ensure(offers.transitionOfferInTx(db, {
    offerId: current.offerId, expectedVersion: current.version, from: S.ISSUING, to, reason: why, at: now,
  }, S.transitionKey(current.offerId, current.stateSeq + 1, to)), "TRANSITION_FAILED");

  if (!read.stockOutFound) {
    const tx = store.transaction("trade.sell.abort_lost", (db) => {
      transition(db, S.LOST, S.END_REASON_SELL_STOCK_OUT_MISSING);
      ensure(journal.markFailed(db, journalId, `lost:${S.END_REASON_SELL_STOCK_OUT_MISSING}`), "MARK_FAILED");
      return { ok: true };
    });
    if (!tx.ok) return { action: "error", reason: txReason(tx) };
    lastPermanent.delete(current.offerId);
    log(logger, `[tradeExecutor] WTS offer ${current.offerId}: no stock-out entry - LOST ${S.END_REASON_SELL_STOCK_OUT_MISSING}`);
    return { action: "aborted", reason: S.END_REASON_SELL_STOCK_OUT_MISSING, outcome: "LOST" };
  }

  if (!sellSeamsOk(adapter)) return { action: "error", reason: "SELL_SEAMS_UNAVAILABLE" };
  const receipt = await adapter.tradeGrantReceipt(payload.grantKey);
  if (!receipt || (!receipt.ok && receipt.reason !== "GRANT_RECEIPT_AMBIGUOUS")) {
    return { action: "error", reason: (receipt && receipt.reason) || "GRANT_RECEIPT_FAILED" };
  }

  if (receipt.ok && receipt.found !== true) {
    let stockBack = null;
    const tx = store.transaction("trade.sell.abort_cancel", (db) => {
      const t = transition(db, S.CANCELLED, reason);
      stockBack = t.stockBack || null;
      ensure(journal.markFailed(db, journalId, `aborted:${reason}`), "MARK_FAILED");
      return { ok: true };
    });
    if (!tx.ok) {
      const why = txReason(tx);
      if (why === "STATIONS_NOT_READY") return { action: "retry", reason: why };
      return { action: "error", reason: why };
    }
    lastPermanent.delete(current.offerId);
    if (stockBack && stockBack.lost > 0) metric(telemetry, METRIC_WTS_STOCK_LOST, stockBack.lost);
    return { action: "aborted", reason, outcome: "CANCELLED" };
  }

  const iss = issuerOfPayload(payload, tradeCfg.walletAccountKey);
  const npcStationId = payload.npcStationId !== undefined ? payload.npcStationId : payload.stationId;
  const listed = await adapter.tradeListDeliveredStacks({ ownerKind: iss.kind, ownerId: iss.ownerId,
    npcStationId, typeId: payload.typeId, ...(o.stackFlag ? { flag: o.stackFlag } : {}) });
  if (!listed || !listed.ok) return { action: "error", reason: (listed && listed.reason) || "LIST_FAILED" };
  const own = receipt.ok && Array.isArray(receipt.itemIds) && receipt.itemIds.length > 0 ? new Set(receipt.itemIds) : null;
  const stacks = (listed.stacks || []).filter((s) => own === null || own.has(s.itemId));
  const plan = planReturn(current.quantity, stacks);
  const returnPayload = {
    offerId: current.offerId, npcStationId, ownerKind: iss.kind, ownerId: iss.ownerId,
    corporationId: iss.corporationId, typeId: payload.typeId, stacks: plan.stacks, reason,
    ...(o.stackFlag ? { flag: o.stackFlag } : {}),
  };
  const tx = store.transaction("trade.sell.abort_intake", (db) => {
    transition(db, S.INTAKE, "");
    ensure(journal.markFailed(db, journalId, `aborted:${reason}`), "MARK_FAILED");
    ensure(journal.enqueueOutbox(db, {
      key: S.returnOutboxKey(current.offerId),
      aggregate: { type: S.OFFER_AGGREGATE, id: current.offerId },
      eventType: S.EVENT_OUTBOX_RETURN,
      payload: returnPayload,
    }), "OUTBOX_FAILED");
    return { ok: true };
  });
  if (!tx.ok) return { action: "error", reason: txReason(tx) };
  lastPermanent.delete(current.offerId);
  return { action: "aborted", reason, outcome: "INTAKE" };
}

async function stepReturn(deps, offer) {
  const { store, journal, offers, adapter, clock, telemetry, logger } = deps;
  const read = store.transaction("trade.sell.read_return", (db) => journal.findByKey(db, S.returnOutboxKey(offer.offerId)));
  if (!read.ok || !read.value || read.value.ok !== true || !read.value.found) {
    log(logger, `[tradeExecutor] WTS return outbox missing for ${offer.offerId}`);
    metric(telemetry, "trade.seamError", 1);
    return { action: "ERROR", reason: "NO_OUTBOX" };
  }
  const plan = read.value.entry.payload || {};
  const journalId = read.value.entry.journalId;
  const ownerKind = plan.ownerKind === S.ISSUER_KIND_CHARACTER ? S.ISSUER_KIND_CHARACTER : S.ISSUER_KIND_CORPORATION;
  const endReason = typeof plan.reason === "string" && plan.reason.length > 0 ? plan.reason : S.END_REASON_ISSUE_FAILED;

  let voided = 0;
  for (const stack of Array.isArray(plan.stacks) ? plan.stacks : []) {
    const res = await adapter.tradeVoidStack({
      ownerKind, ownerId: plan.ownerId, corporationId: plan.corporationId, npcStationId: plan.npcStationId,
      itemId: stack.itemId, quantity: stack.quantity, key: S.voidKey(offer.offerId, stack.itemId),
      ...(plan.flag === "hangar" ? { flag: "hangar" } : {}),
    });
    if (!res || !res.ok) {
      if (res && res.reason === "ITEM_MISSING" && res.permanent === true) continue;
      if (!res || res.ambiguous === true || res.permanent === false) return { action: "RETRY", reason: (res && res.reason) || "VOID_FAILED" };
      log(logger, `[tradeExecutor] WTS void failed ${offer.offerId} item ${stack.itemId}: ${res.reason}`);
      metric(telemetry, "trade.seamError", 1);
      return { action: "ERROR", reason: res.reason };
    }
    if (res.outcome === "VOIDED" || res.outcome === "DUPLICATE" || res.outcome === "ALREADY_COMMITTED") voided += stack.quantity;
  }

  const now = clock.now();
  const tx = store.transaction("trade.sell.return", (db) => {
    const cur = ensure(offers.getOffer(db, offer.offerId), "OFFER_READ_FAILED").offer;
    if (!cur || cur.state !== S.INTAKE) return { outcome: "STALE" };
    const to = voided > 0 ? S.CANCELLED : S.LOST;
    const t = ensure(offers.transitionOfferInTx(db, {
      offerId: cur.offerId, expectedVersion: cur.version, from: S.INTAKE, to,
      reason: voided > 0 ? endReason : S.END_REASON_NOTHING_RETURNED, at: now,
      ...(voided > 0 ? { patch: { deliveredQuantity: voided } } : {}),
    }, S.transitionKey(cur.offerId, cur.stateSeq + 1, to)), "TRANSITION_FAILED");
    ensure(journal.markApplied(db, journalId), "MARK_FAILED");
    return { outcome: to, quantity: cur.quantity, stockBack: t.stockBack || null };
  });
  if (!tx.ok) {
    const why = txReason(tx);
    if (why === "STATIONS_NOT_READY") return { action: "WAIT", reason: why };
    log(logger, `[tradeExecutor] WTS return failed for ${offer.offerId}: ${why}`);
    metric(telemetry, "trade.seamError", 1);
    return { action: "ERROR", reason: why };
  }
  const out = tx.value;
  if (out.outcome === "STALE") return { action: "STALE" };
  const credited = out.stockBack ? out.stockBack.credited : 0;
  const lost = Math.max(0, out.quantity - credited);
  if (out.outcome === S.CANCELLED) metric(telemetry, METRIC_WTS_RETURNED, 1);
  if (credited > 0) metric(telemetry, METRIC_WTS_RETURNED_UNITS, credited);
  if (lost > 0) metric(telemetry, METRIC_WTS_STOCK_LOST, lost);
  if (voided < out.quantity) metric(telemetry, METRIC_WTS_RETURN_SHORT, 1);
  if (out.outcome === S.LOST) {
    log(logger, `[tradeExecutor] WTS ${offer.offerId}: nothing returned - LOST ${S.END_REASON_NOTHING_RETURNED}`);
    return { action: "LOST", reason: S.END_REASON_NOTHING_RETURNED };
  }
  return { action: "RETURNED", reason: endReason, returned: credited };
}

async function deleteCeoOf(adapter, iss) {
  if (iss.kind === S.ISSUER_KIND_CHARACTER) return iss.characterId;
  if (!adapter || typeof adapter.tradeReadIssuer !== "function") return 0;
  const r = await adapter.tradeReadIssuer(iss.corporationId);
  return (r && r.ok && r.issuer && r.issuer.ceoId) || 0;
}

async function stepPollSell(deps, offer, station) {
  const { store, offers, adapter, config, clock, telemetry, mode } = deps;
  const tradeCfg = (config && config.trade) || {};
  const readRes = await adapter.tradeReadContract(offer.contractId);
  if (!readRes || !readRes.ok) return { action: "error", reason: (readRes && readRes.reason) || "CONTRACT_READ_FAILED" };
  const contract = readRes.contract;
  if (!contract) return planClose(deps, offer, S.END_REASON_CONTRACT_MISSING);

  if (contract.status === "FINISHED") {
    const acceptorId = contract.acceptorKind === "character" ? contract.acceptorId : null;
    const at = clock.now();
    const tx = store.transaction("trade.sell.open_accepted", (db) => {
      const tr = ensure(offers.transitionOfferInTx(db, {
        offerId: offer.offerId, expectedVersion: offer.version, from: S.OPEN, to: S.ACCEPTED, reason: "", at,
        patch: { acceptorCharacterId: acceptorId },
      }, S.transitionKey(offer.offerId, offer.stateSeq + 1, S.ACCEPTED)), "TRANSITION_FAILED");
      const ds = deps.deliveryStanding;
      if (tr.duplicate !== true && ds && typeof ds.noteWtsInTx === "function") ds.noteWtsInTx(db, tr.offer, at);
      return tr;
    });
    if (!tx.ok) return { action: "error", reason: txReason(tx) };
    if (tx.value.duplicate !== true) metric(telemetry, METRIC_WTS_SOLD, 1);
    return { action: "accepted" };
  }

  if (contract.status === "OUTSTANDING" && contract.pendingKind) return { action: "retry" };
  const why = closeWanted(offer, station, clock.now(), mode);
  if (contract.status === "OUTSTANDING" || contract.status === "REJECTED") {
    if (contract.status === "OUTSTANDING" && why === null) return { action: "retry" };
    const iss = issuerOf(offer, tradeCfg.walletAccountKey);
    if (iss.kind === S.ISSUER_KIND_CHARACTER && !characterSeamsOk(adapter)) return { action: "retry" };
    const del = await adapter.tradeDeleteContract({ contractId: offer.contractId, ceoId: await deleteCeoOf(adapter, iss),
      corporationId: iss.corporationId });
    if (!del || !del.ok) {
      if (del && del.pending) return { action: "retry" };
      return { action: "error", reason: (del && del.reason) || "CONTRACT_DELETE_FAILED" };
    }
  }
  return planClose(deps, offer, why || S.END_REASON_DELETED_EXTERNALLY);
}

async function planClose(deps, offer, reason) {
  const { store, journal, offers, adapter, config, clock } = deps;
  const tradeCfg = (config && config.trade) || {};
  const read = store.transaction("trade.sell.read_close", (db) => journal.findByKey(db, S.issueOutboxKey(offer.offerId)));
  if (!read.ok || !read.value || read.value.ok !== true || !read.value.found) return { action: "error", reason: "NO_OUTBOX" };
  const payload = read.value.entry.payload || {};
  const iss = issuerOfPayload(payload, tradeCfg.walletAccountKey);
  const listed = await adapter.tradeListDeliveredStacks({ ownerKind: iss.kind, ownerId: iss.ownerId,
    npcStationId: payload.npcStationId, typeId: payload.typeId });
  if (!listed || !listed.ok) return { action: "error", reason: (listed && listed.reason) || "LIST_FAILED" };
  const now = clock.now();
  const tx = store.transaction("trade.sell.close_intake", (db) => {
    const cur = ensure(offers.getOffer(db, offer.offerId), "OFFER_READ_FAILED").offer;
    if (!cur || cur.state !== S.OPEN) return { outcome: "STALE" };
    const plan = planReturn(cur.quantity, listed.stacks || []);
    ensure(offers.transitionOfferInTx(db, {
      offerId: cur.offerId, expectedVersion: cur.version, from: S.OPEN, to: S.INTAKE, reason: "", at: now,
    }, S.transitionKey(cur.offerId, cur.stateSeq + 1, S.INTAKE)), "TRANSITION_FAILED");
    ensure(journal.enqueueOutbox(db, {
      key: S.returnOutboxKey(cur.offerId),
      aggregate: { type: S.OFFER_AGGREGATE, id: cur.offerId },
      eventType: S.EVENT_OUTBOX_RETURN,
      payload: { offerId: cur.offerId, npcStationId: payload.npcStationId, ownerKind: iss.kind, ownerId: iss.ownerId,
        corporationId: iss.corporationId, typeId: payload.typeId, stacks: plan.stacks, reason },
    }), "OUTBOX_FAILED");
    return { outcome: S.INTAKE };
  });
  if (!tx.ok) return { action: "error", reason: txReason(tx) };
  if (tx.value.outcome === "STALE") return { action: "retry", reason: "STALE" };
  return { action: "closed", reason };
}

function loseProceeds(deps, offerId, endReason) {
  const { store, offers, clock, telemetry, logger } = deps;
  const tx = store.transaction("trade.sell.proceeds_lost", (db) => {
    const cur = ensure(offers.getOffer(db, offerId), "OFFER_READ_FAILED").offer;
    if (!cur || cur.state !== S.ACCEPTED) return { outcome: "STALE" };
    ensure(offers.transitionOfferInTx(db, {
      offerId, expectedVersion: cur.version, from: S.ACCEPTED, to: S.LOST, reason: endReason, at: clock.now(),
    }, S.transitionKey(offerId, cur.stateSeq + 1, S.LOST)), "TRANSITION_FAILED");
    return { outcome: S.LOST };
  });
  if (!tx.ok) return { action: "ERROR", reason: txReason(tx) };
  if (tx.value.outcome === "STALE") return { action: "STALE", reason: "STALE" };
  metric(telemetry, METRIC_WTS_PROCEEDS_FAILED, 1);
  metric(telemetry, "trade.lost", 1);
  log(logger, `[tradeExecutor] WTS ${offerId}: proceeds not credited - LOST ${endReason}`);
  return { action: "LOST", reason: endReason };
}

function safeCall(fn, fallback) {
  try { return fn(); } catch (_err) { return fallback; }
}

function treasuryContextOf(deps) {
  const config = deps.config;
  const tradeCfg = (config && config.trade) || {};
  const capIsk = Number.isSafeInteger(tradeCfg.iskBudgetCap) && tradeCfg.iskBudgetCap >= 0 ? tradeCfg.iskBudgetCap : 0;
  const treasuryOn = Boolean(config && config.treasury && config.treasury.enabled === true);
  const tr = typeof deps.getTreasury === "function" ? safeCall(deps.getTreasury, null) : null;
  const trReady = Boolean(tr && typeof tr.fundsTrade === "function" && typeof tr.creditTradeProceedsInTx === "function"
    && safeCall(() => tr.fundsTrade(), false) === true);
  return { capIsk, treasuryOn, tr, trReady };
}

function settleProceedsTx(db, deps, cur, isk, at, tctx) {
  const { budgets } = deps;
  const { capIsk, treasuryOn, tr, trReady } = tctx || treasuryContextOf(deps);
  if (!Number.isSafeInteger(isk) || isk < 1) return { creditedIsk: 0, treasuryIsk: 0, burnedIsk: 0 };
  const c = ensure(budgets.creditProceedsInTx(db, { factionId: cur.factionId, isk, capIsk, at },
    S.proceedsBudgetKey(cur.offerId)), "BUDGET_CREDIT_FAILED");
  let treasuryIsk = 0;
  let burnedIsk = 0;
  if (c.overflowIsk > 0) {
    if (trReady) {
      const t = tr.creditTradeProceedsInTx(db, { factionId: cur.factionId, isk: c.overflowIsk, at },
        S.proceedsTreasuryKey(cur.offerId));
      if (t && t.ok === true) treasuryIsk = t.duplicate === true ? 0 : c.overflowIsk;
      else if (t && t.reason === "NO_TREASURY") burnedIsk = c.overflowIsk;
      else throw new SellRollback(t || { ok: false, reason: "TREASURY_CREDIT_FAILED" });
    } else if (treasuryOn) {
      throw new SellRollback({ ok: false, reason: TREASURY_NOT_READY });
    } else {
      burnedIsk = c.overflowIsk;
    }
  }
  ensure(budgets.recordProceedsSplitInDb(db, cur.factionId, { treasuryIsk, burnedIsk }, at), "BUDGET_SPLIT_FAILED");
  return { creditedIsk: c.creditedIsk, treasuryIsk, burnedIsk };
}

async function stepProceeds(deps, offer) {
  const { store, offers, adapter, config, clock, telemetry, logger, walletLeg, noteWalletResult } = deps;
  const tradeCfg = (config && config.trade) || {};
  const iss = issuerOf(offer, tradeCfg.walletAccountKey);
  if (iss.kind === S.ISSUER_KIND_CHARACTER && !characterSeamsOk(adapter)) {
    return { action: "WAIT", reason: "CHARACTER_SEAMS_UNAVAILABLE" };
  }

  const { journal } = deps;
  const legKey = S.proceedsLegKey(offer.offerId);
  const seen = store.transaction("trade.sell.proceeds_leg_read", (db) => journal.findByKey(db, legKey));
  if (!seen.ok || !seen.value || seen.value.ok !== true) return { action: "ERROR", reason: "JOURNAL_READ_FAILED" };
  if (seen.value.found !== true) {
    const leg = await walletLeg(iss, offer.offerId, "proceeds", -offer.iskTotal);
    if (typeof noteWalletResult === "function") noteWalletResult(leg, offer.offerId, "proceeds");
    if (!leg || leg.ok !== true) {
      const why = String((leg && leg.reason) || "WALLET_FAILED");
      if (PROCEEDS_PERMANENT.includes(why)) {
        log(logger, `[tradeExecutor] WTS proceeds leg refused for ${offer.offerId}: ${why}`);
        return loseProceeds(deps, offer.offerId, S.END_REASON_PROCEEDS_FAILED);
      }
      return { action: "RETRY", reason: why };
    }
    const mark = store.transaction("trade.sell.proceeds_leg", (db) => ensure(journal.applyOnce(db, {
      key: legKey, aggregate: { type: S.OFFER_AGGREGATE, id: offer.offerId }, eventType: S.EVENT_WTS_PROCEEDS_LEG,
      payload: { offerId: offer.offerId, isk: offer.iskTotal },
    }, () => ({ ok: true })), "LEG_MARK_FAILED"));
    if (!mark.ok) {
      log(logger, `[tradeExecutor] WTS proceeds leg mark failed for ${offer.offerId}: ${txReason(mark)}`);
      metric(telemetry, "trade.seamError", 1);
      return { action: "ERROR", reason: txReason(mark) };
    }
  }

  const tctx = treasuryContextOf(deps);
  const at = clock.now();
  const tx = store.transaction("trade.sell.proceeds", (db) => {
    const cur = ensure(offers.getOffer(db, offer.offerId), "OFFER_READ_FAILED").offer;
    if (!cur || cur.state !== S.ACCEPTED) return { outcome: "STALE" };
    const { creditedIsk, treasuryIsk, burnedIsk } = settleProceedsTx(db, deps, cur, cur.iskTotal, at, tctx);
    ensure(offers.transitionOfferInTx(db, {
      offerId: cur.offerId, expectedVersion: cur.version, from: S.ACCEPTED, to: S.DELIVERED, reason: S.DELIVERED, at,
      patch: { deliveredQuantity: cur.quantity },
    }, S.transitionKey(cur.offerId, cur.stateSeq + 1, S.DELIVERED)), "TRANSITION_FAILED");
    return { outcome: S.DELIVERED, creditedIsk, treasuryIsk, burnedIsk };
  });
  if (!tx.ok) {
    const why = txReason(tx);
    if (why === TREASURY_NOT_READY) {
      metric(telemetry, METRIC_WTS_PROCEEDS_WAIT, 1);
      return { action: "WAIT", reason: why };
    }
    log(logger, `[tradeExecutor] WTS proceeds failed for ${offer.offerId}: ${why}`);
    metric(telemetry, "trade.seamError", 1);
    return { action: "ERROR", reason: why };
  }
  const out = tx.value;
  if (out.outcome === "STALE") return { action: "STALE", reason: "STALE" };
  if (out.creditedIsk > 0) metric(telemetry, METRIC_WTS_PROCEEDS_ISK, out.creditedIsk);
  if (out.treasuryIsk > 0) metric(telemetry, METRIC_WTS_PROCEEDS_TREASURY, out.treasuryIsk);
  if (out.burnedIsk > 0) metric(telemetry, METRIC_WTS_PROCEEDS_BURNED, out.burnedIsk);
  metric(telemetry, METRIC_WTS_DELIVERED, 1);
  return { action: "DELIVERED", creditedIsk: out.creditedIsk, treasuryIsk: out.treasuryIsk, burnedIsk: out.burnedIsk };
}

module.exports = {
  stepIssueSell, abortSell, stepReturn, SellRollback, sellSeamsOk,
  METRIC_WTS_PROCEEDS_WAIT, TREASURY_NOT_READY,
  stepPollSell, planClose, stepProceeds, loseProceeds,
  settleProceedsTx, treasuryContextOf,
  METRIC_WTS_ISSUED, METRIC_WTS_GRANT_FAILED, METRIC_WTS_RETURNED, METRIC_WTS_RETURNED_UNITS, METRIC_WTS_RETURN_SHORT,
  METRIC_WTS_STOCK_LOST, METRIC_CONTRACT_LIMIT,
  METRIC_WTS_SOLD, METRIC_WTS_DELIVERED, METRIC_WTS_PROCEEDS_ISK, METRIC_WTS_PROCEEDS_TREASURY,
  METRIC_WTS_PROCEEDS_BURNED, METRIC_WTS_PROCEEDS_FAILED,
};
