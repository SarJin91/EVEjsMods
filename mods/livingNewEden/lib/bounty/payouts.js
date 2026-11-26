"use strict";

const S = require("./schema");
const R = require("./repository");

const MAX_DETAIL = 120;
const PERMANENT_REASONS = new Set(["CHARACTER_NOT_FOUND", "BALANCE_LIMIT", "WALLET_KEY_INVALID",
  "INVALID_OWNER_OR_ISSUER", "IDEMPOTENCY_KEY_REUSED"]);
const PAYOUT_COUNTER_NAMES = Object.freeze(["paid", "payFailed", "payRetry", "payDuplicate", "payMarkFailed",
  "payPruned"]);

const SEAM_WAIT_REASON = "SEAM_UNAVAILABLE";

const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);

function retryDelayOf(attempts, baseMs, maxMs) {
  return Math.min(maxMs, baseMs * 2 ** Math.min(attempts, 62));
}

function outcomeOf(payout, r, P, now) {
  if (r && r.ok === true) return { state: S.PAYOUT_ROW_STATES.PAID, attempts: payout.attempts, lastReason: null,
    retry: false, nextAttemptAt: null };
  const reason = String((r && r.reason) || "NO_RESULT");
  const lastReason = `${reason}${r && r.detail ? `:${r.detail}` : ""}`.slice(0, MAX_DETAIL);
  if ((r && r.permanent === true) || PERMANENT_REASONS.has(reason)) {
    return { state: S.PAYOUT_ROW_STATES.FAILED, attempts: payout.attempts, lastReason, retry: false,
      nextAttemptAt: null };
  }
  if (reason === SEAM_WAIT_REASON) {
    return { state: S.PAYOUT_ROW_STATES.PENDING, attempts: payout.attempts, lastReason, retry: true,
      nextAttemptAt: now + P.payoutRetryBaseMs };
  }
  const attempts = payout.attempts + 1;
  return attempts >= P.payoutMaxAttempts
    ? { state: S.PAYOUT_ROW_STATES.FAILED, attempts, lastReason, retry: false, nextAttemptAt: null }
    : { state: S.PAYOUT_ROW_STATES.PENDING, attempts, lastReason, retry: true,
      nextAttemptAt: now + retryDelayOf(payout.attempts, P.payoutRetryBaseMs, P.payoutRetryMaxMs) };
}

function createBountyPayoutPump(deps) {
  const { store, bump, log, isStopped } = deps;
  const P = deps.settings;
  const metric = typeof deps.metric === "function" ? deps.metric : () => {};
  let pending = 0;
  let nextDueAt = 0;
  let planned = false;
  let nextPruneAt = 0;
  let passes = 0;
  let lastRefusal = null;

  function tx(name, fn) {
    let res = null;
    try {
      res = store.transaction(name, fn);
    } catch (err) {
      return { ok: false, reason: "TX_THREW", detail: messageOf(err) };
    }
    if (!res || res.ok !== true) {
      return { ok: false, reason: String((res && res.reason) || "no_result"),
        detail: res && res.error ? messageOf(res.error) : undefined };
    }
    const v = res.value;
    return v && v.ok === true ? v : { ok: false, reason: String((v && v.reason) || "no_result") };
  }

  function boot() {
    const r = tx("bounty.payoutBoot", (t) => R.countPendingPayoutsInTx(t));
    if (r.ok) pending = r.pending;
    return r;
  }

  function prune(now) {
    if (now < nextPruneAt) return;
    nextPruneAt = now + P.pruneEveryMs;
    if (now - P.payoutRetentionMs <= 0) return;
    const r = tx("bounty.payoutPrune", (t) => R.prunePayoutsInTx(t, now - P.payoutRetentionMs, P.prunePerRun));
    if (r.ok) bump("payPruned", r.deleted);
    else lastRefusal = `payoutPrune:${r.reason}`;
  }

  async function payOne(p, now, out, gate) {
    let r;
    try {
      r = await deps.rewardCreditIsk({ characterId: p.characterId, amountIsk: p.amountIsk, commandId: p.payoutKey,
        issuerCorporationId: null, systemId: p.systemId, description: S.PAYOUT_DESCRIPTION, source: S.ISK_SOURCE });
    } catch (err) {
      r = { ok: false, reason: "WALLET_FAILED", permanent: false, detail: messageOf(err) };
    }
    if (isStopped()) return false;
    const m = outcomeOf(p, r, P, now);
    const w = tx("bounty.payout", (t) => R.settlePayoutInTx(t, p, m, now));
    if (!w.ok) {
      bump("payMarkFailed");
      lastRefusal = `payout:${p.payoutKey} ${w.reason}`;
      gate.due = Math.min(gate.due, now);
      return true;
    }
    if (r && r.ok === true && r.duplicate === true) bump("payDuplicate");
    if (m.state === S.PAYOUT_ROW_STATES.PENDING) {
      gate.due = Math.min(gate.due, m.nextAttemptAt);
      out.retried += 1;
      bump("payRetry");
      lastRefusal = `payout:${p.payoutKey} ${m.lastReason}`;
      return true;
    }
    pending = Math.max(0, pending - 1);
    if (m.state === S.PAYOUT_ROW_STATES.PAID) {
      out.paid += 1;
      bump("paid");
      metric("count", "bounty.paidIsk", p.amountIsk);
    } else {
      out.failed += 1;
      bump("payFailed");
      lastRefusal = `payout:${p.payoutKey} ${m.lastReason}`;
      log(`payout ${p.payoutKey} FAILED - ${m.lastReason}`);
    }
    return true;
  }

  async function runPayoutPass(now) {
    const out = { ok: true, paid: 0, failed: 0, retried: 0 };
    try {
      if (isStopped()) return { ok: false, reason: "STOPPED" };
      passes += 1;
      if (P.payoutEnabled !== true) return out;
      if (pending > 0 && now >= nextDueAt) {
        planned = false;
        const read = tx("bounty.payoutRead", (t) => R.listPendingPayoutsInTx(t, P.payoutBatch, now));
        if (!read.ok) {
          lastRefusal = `payoutRead:${read.reason}`;
          return { ok: false, reason: read.reason };
        }
        const short = read.payouts.length < P.payoutBatch;
        if (short) pending = read.payouts.length + (read.waiting || 0);
        const gate = { due: short && read.nextDueAt !== null ? read.nextDueAt : (short ? Infinity : now) };
        let stoppedMid = false;
        for (const p of read.payouts) {
          if (isStopped() || !(await payOne(p, now, out, gate))) {
            stoppedMid = true;
            break;
          }
        }
        nextDueAt = planned || gate.due === Infinity ? 0 : gate.due;
        if (stoppedMid) return { ok: false, reason: "STOPPED" };
      }
      if (!isStopped()) prune(now);
      return out;
    } catch (err) {
      lastRefusal = `payoutPass:${messageOf(err)}`;
      return { ok: false, reason: "PASS_FAILED" };
    }
  }

  return Object.freeze({
    boot,
    notePlanned: () => {
      pending += 1;
      nextDueAt = 0;
      planned = true;
    },
    runPayoutPass,
    status: () => Object.freeze({ pending, nextDueAt, passes, lastRefusal }),
  });
}

module.exports = { createBountyPayoutPump, outcomeOf, retryDelayOf, PAYOUT_COUNTER_NAMES, PERMANENT_REASONS };
