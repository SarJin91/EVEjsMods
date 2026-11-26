"use strict";

const { sweepOutboxKey, sweepCommandId, EVENT_OUTBOX_SWEEP } = require("./schema");

const SWEEP_AGGREGATE = "trade_sweep";
const SWEEP_DESCRIPTION = "lne-trade market refund sweep";

async function runRefundSweep(deps, maxSweepsPerPass, maxRows) {
  const { store, journal, adapter, config, telemetry, logger, offers } = deps;
  const sweepState = deps.sweepState || { corpIndex: 0, blockedLogged: false };
  if (!(sweepState.collisionLogged instanceof Set)) sweepState.collisionLogged = new Set();

  if (!maxSweepsPerPass || maxSweepsPerPass <= 0) {
    return { swept: 0, failed: 0, blocked: 0, errors: 0, nextCorpIndex: sweepState.corpIndex };
  }

  const tradeCfg = config.trade || {};
  const accountKey = Math.trunc(tradeCfg.buyOrderWalletAccountKey || 1005);
  const walletAccountKey = Math.trunc(tradeCfg.walletAccountKey || 1000);

  if (accountKey === walletAccountKey) {
    metric(telemetry, "trade.marketSweepBlocked", 1);
    if (!sweepState.blockedLogged) {
      sweepState.blockedLogged = true;
      log(logger, "[tradeExecutor] refund sweep blocked: buyOrderWalletAccountKey === walletAccountKey");
    }
    return { swept: 0, failed: 0, blocked: 1, errors: 0, nextCorpIndex: sweepState.corpIndex };
  }

  const corpRes = store.transaction("trade.sweep.list_corps", (db) => offers.listMarketCorporations(db));
  if (!corpRes.ok || !corpRes.value || corpRes.value.ok !== true) {
    log(logger, `[tradeExecutor] listMarketCorporations failed: ${reasonOf(corpRes)}`);
    return { swept: 0, failed: 0, blocked: 0, errors: 1, nextCorpIndex: sweepState.corpIndex };
  }
  const corporationIds = corpRes.value.corporationIds;
  if (corporationIds.length === 0) {
    return { swept: 0, failed: 0, blocked: 0, errors: 0, nextCorpIndex: sweepState.corpIndex };
  }

  let corpIndex = Number.isSafeInteger(sweepState.corpIndex) && sweepState.corpIndex >= 0
    ? sweepState.corpIndex % corporationIds.length : 0;
  const totals = { swept: 0, failed: 0, blocked: 0, errors: 0 };

  for (let i = 0; i < maxSweepsPerPass && i < corporationIds.length; i++) {
    const corpId = corporationIds[corpIndex];
    corpIndex = (corpIndex + 1) % corporationIds.length;
    try {
      const outcome = await sweepCorporation({ store, journal, adapter, telemetry, logger, sweepState },
        corpId, accountKey, maxRows);
      totals[outcome] = (totals[outcome] || 0) + 1;
    } catch (err) {
      log(logger, `[tradeExecutor] sweep error for corp ${corpId}: ${err && err.message}`);
      totals.errors += 1;
      metric(telemetry, "trade.seamError", 1);
    }
  }

  sweepState.corpIndex = corpIndex;
  return { swept: totals.swept, failed: totals.failed, blocked: totals.blocked, errors: totals.errors,
    nextCorpIndex: corpIndex };
}

async function sweepCorporation(ctx, corpId, accountKey, maxRows) {
  const { store, journal, adapter, telemetry, logger, sweepState } = ctx;
  const prefix = sweepOutboxKey(corpId, "");

  const countRes = store.transaction("trade.sweep.count",
    (db) => journal.countKeyRange(db, prefix, `${prefix.slice(0, -1)};`, maxRows));
  if (!countRes.ok || !countRes.value || countRes.value.ok !== true) {
    log(logger, `[tradeExecutor] sweep count failed for corp ${corpId}: ${reasonOf(countRes)}`);
    return "errors";
  }
  const c = countRes.value.count;
  if (c >= maxRows) {
    if (!sweepState.collisionLogged.has(corpId)) {
      sweepState.collisionLogged.add(corpId);
      log(logger, `[tradeExecutor] sweep stopped for corp ${corpId}: ${c} entries = maxRows ${maxRows} (retention)`);
    }
    metric(telemetry, "trade.marketSweepFailed", 1);
    return "failed";
  }

  let n = c;
  let journalId = null;
  let amountIsk = 0;

  if (c > 0) {
    const findRes = store.transaction("trade.sweep.find_last", (db) => journal.findByKey(db, sweepOutboxKey(corpId, c - 1)));
    if (!findRes.ok || !findRes.value || findRes.value.ok !== true) {
      log(logger, `[tradeExecutor] sweep read of entry ${c - 1} failed for corp ${corpId}: ${reasonOf(findRes)}`);
      return "errors";
    }
    const entry = findRes.value.found ? findRes.value.entry : null;
    if (entry && entry.state === "PENDING") {
      const payload = entry.payload || {};
      if (!Number.isSafeInteger(payload.amountIsk) || payload.amountIsk < 1) {
        log(logger, `[tradeExecutor] sweep entry ${entry.key} has no valid amount, left PENDING`);
        return "errors";
      }
      n = c - 1;
      journalId = entry.journalId;
      amountIsk = payload.amountIsk;
    }
  }

  if (journalId === null) {
    const walletRes = await adapter.tradeReadWallet(corpId, accountKey);
    if (!walletRes || walletRes.ok !== true || !Number.isFinite(walletRes.balanceIsk)) {
      log(logger, `[tradeExecutor] sweep read wallet failed for corp ${corpId}: ${(walletRes && walletRes.reason) || "no balance"}`);
      return "idle";
    }
    amountIsk = Math.floor(walletRes.balanceIsk);
    if (amountIsk < 1) return "idle";

    const payload = { corporationId: corpId, accountKey, amountIsk };
    const enqueueRes = store.transaction("trade.sweep.enqueue", (db) => journal.enqueueOutbox(db, {
      key: sweepOutboxKey(corpId, n),
      aggregate: { type: SWEEP_AGGREGATE, id: String(corpId) },
      eventType: EVENT_OUTBOX_SWEEP,
      payload,
    }));
    if (!enqueueRes.ok || !enqueueRes.value || enqueueRes.value.ok !== true) {
      log(logger, `[tradeExecutor] sweep enqueue failed for corp ${corpId} n=${n}: ${reasonOf(enqueueRes)}`);
      return "errors";
    }
    journalId = enqueueRes.value.journalId;
  }

  const adjustRes = await adapter.tradeAdjustWallet({
    corporationId: corpId,
    accountKey,
    deltaIsk: -amountIsk,
    commandId: sweepCommandId(corpId, n),
    description: SWEEP_DESCRIPTION,
  });

  if (adjustRes && adjustRes.ok === true && adjustRes.fingerprintMismatch === true) {
    return markFailed(ctx, journalId, "WALLET", corpId, n, "fingerprintMismatch");
  }
  if (adjustRes && adjustRes.ok === true) {
    const markRes = store.transaction("trade.sweep.mark_applied", (db) => journal.markApplied(db, journalId));
    if (!markRes.ok || !markRes.value || markRes.value.ok !== true) {
      log(logger, `[tradeExecutor] sweep markApplied failed for corp ${corpId} n=${n}: ${reasonOf(markRes)}`);
      return "errors";
    }
    if (markRes.value.alreadyApplied === true) return "idle";
    metric(telemetry, "trade.marketRefundSweeps", 1);
    metric(telemetry, "trade.marketRefundSweptIsk", amountIsk);
    log(logger, `[tradeExecutor] sweep corp ${corpId} n=${n} amount=${amountIsk}${adjustRes.duplicate ? " (receipt replay)" : ""}`);
    return "swept";
  }
  const reason = adjustRes && adjustRes.reason;
  if (reason === "INSUFFICIENT_FUNDS") {
    return markFailed(ctx, journalId, "SHORT", corpId, n, reason);
  }
  if (reason === "WALLET_KEY_INVALID" || (adjustRes && adjustRes.permanent === true)) {
    return markFailed(ctx, journalId, "WALLET", corpId, n, (adjustRes && adjustRes.detail) || reason);
  }
  log(logger, `[tradeExecutor] sweep transient failure corp ${corpId} n=${n}: ${reason || "unknown"}, will retry`);
  return "waiting";
}

function markFailed(ctx, journalId, detail, corpId, n, why) {
  const { store, journal, telemetry, logger } = ctx;
  const markRes = store.transaction("trade.sweep.mark_failed", (db) => journal.markFailed(db, journalId, detail));
  if (!markRes.ok || !markRes.value || markRes.value.ok !== true) {
    log(logger, `[tradeExecutor] sweep markFailed ${detail} failed for corp ${corpId} n=${n}: ${reasonOf(markRes)}`);
    return "errors";
  }
  metric(telemetry, "trade.marketSweepFailed", 1);
  log(logger, `[tradeExecutor] sweep ${detail} corp ${corpId} n=${n}: ${why}`);
  return "failed";
}

function reasonOf(res) {
  if (!res) return "no_result";
  if (res.ok !== true) return res.reason || "transaction_failed";
  const v = res.value;
  return (v && (v.reason + (v.detail ? `: ${v.detail}` : ""))) || "no_value";
}

function metric(telemetry, name, value) {
  if (!telemetry || typeof telemetry.count !== "function") return;
  try { telemetry.count(name, value); } catch (_err) {}
}

function log(logger, ...args) {
  if (logger && typeof logger.log === "function") logger.log(...args);
}

module.exports = { runRefundSweep };
