"use strict";

const S = require("./schema");
const R = require("./repository");

const MAX_DETAIL = 120;
const PERMANENT_REASONS = new Set(["CHARACTER_NOT_FOUND", "BALANCE_LIMIT", "WALLET_KEY_INVALID",
  "INVALID_OWNER_OR_ISSUER", "IDEMPOTENCY_KEY_REUSED", "GRANT_INVALID"]);
const SEAM_WAIT_REASON = "SEAM_UNAVAILABLE";

const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);

function legKeyOf(payoutKey, leg) {
  return `lne:${payoutKey}:${leg}`;
}

function retryDelayOf(attempts, baseMs, maxMs) {
  return Math.min(maxMs, baseMs * 2 ** Math.min(attempts, 62));
}

function legOutcome(r) {
  if (r && r.ok === true) {
    return { state: S.LEG_STATES.DONE, transient: false, waiting: false, error: null,
      duplicate: r.duplicate === true || r.outcome === "DUPLICATE" };
  }
  const reason = String((r && r.reason) || "NO_RESULT");
  const error = `${reason}${r && r.detail ? `:${r.detail}` : ""}`.slice(0, MAX_DETAIL);
  if ((r && r.permanent === true) || PERMANENT_REASONS.has(reason)) {
    return { state: S.LEG_STATES.FAILED, transient: false, waiting: false, error, duplicate: false };
  }
  if (reason === SEAM_WAIT_REASON) {
    return { state: S.LEG_STATES.PENDING, transient: false, waiting: true, error, duplicate: false };
  }
  return { state: S.LEG_STATES.PENDING, transient: true, waiting: false, error, duplicate: false };
}

const untouched = (state) => ({ state, transient: false, waiting: false, error: null, duplicate: false });

function planMark(row, outcomes, P, now) {
  const states = outcomes.map((o) => o.state);
  const transient = outcomes.some((o) => o.transient);
  const lastReason = outcomes.map((o) => o.error).filter(Boolean).join("; ").slice(0, MAX_DETAIL) || null;
  let attempts = row.attempts;
  let nextAttemptAt = null;
  let retry = false;
  if (transient) {
    attempts += 1;
    if (attempts >= P.payoutMaxAttempts) {
      for (let i = 0; i < states.length; i += 1) if (outcomes[i].transient) states[i] = S.LEG_STATES.FAILED;
    } else {
      retry = true;
      nextAttemptAt = now + retryDelayOf(row.attempts, P.payoutRetryBaseMs, P.payoutRetryMaxMs);
    }
  }
  if (!retry && states.includes(S.LEG_STATES.PENDING) && outcomes.some((o) => o.waiting)) {
    nextAttemptAt = now + P.payoutRetryBaseMs;
    retry = true;
  }
  const state = states.includes(S.LEG_STATES.PENDING) ? S.PAYOUT_ROW_STATES.PENDING
    : (states.includes(S.LEG_STATES.FAILED) ? S.PAYOUT_ROW_STATES.FAILED : S.PAYOUT_ROW_STATES.PAID);
  return { iskState: states[0], stdState: states[1], state, attempts, nextAttemptAt, lastReason, retry };
}

function createSituationPayoutPump(deps) {
  const { store, bump, log, isStopped } = deps;
  const P = deps.settings;
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
    if (!res || res.ok !== true) return { ok: false, reason: String((res && res.reason) || "no_result") };
    const v = res.value;
    return v && v.ok === true ? v : { ok: false, reason: String((v && v.reason) || "no_result") };
  }

  function boot() {
    const r = tx("situations.payoutBoot", (t) => R.countPendingPayoutsInTx(t));
    if (r.ok) pending = r.pending;
    return r;
  }

  function prune(now) {
    if (now < nextPruneAt) return;
    nextPruneAt = now + P.pruneEveryMs;
    if (now - P.payoutRetentionMs <= 0) return;
    const r = tx("situations.payoutPrune", (t) => R.prunePayoutsInTx(t, now - P.payoutRetentionMs, P.prunePerRun));
    if (r.ok) bump("payoutsPruned", r.deleted);
    else lastRefusal = `payoutPrune:${r.reason}`;
  }

  async function payIsk(p) {
    if (p.iskState !== S.LEG_STATES.PENDING) return untouched(p.iskState);
    let r;
    try {
      r = await deps.rewardCreditIsk({ characterId: p.characterId, amountIsk: p.amountIsk,
        commandId: legKeyOf(p.payoutKey, "isk"), issuerCorporationId: null, systemId: p.systemId,
        description: S.PAYOUT_DESCRIPTION, source: S.ISK_SOURCE });
    } catch (err) {
      r = { ok: false, reason: "WALLET_FAILED", permanent: false, detail: messageOf(err) };
    }
    return legOutcome(r);
  }

  function payStanding(p) {
    if (p.stdState !== S.LEG_STATES.PENDING) return untouched(p.stdState);
    let r;
    try {
      r = deps.applyStandingGrant({ key: legKeyOf(p.payoutKey, "std"), characterId: p.characterId,
        factionId: p.standingFactionId, rawChange: p.standingMicro / S.STANDING_MICRO, reason: S.STANDING_REASON },
      S.STANDING_DATA);
    } catch (err) {
      r = { ok: false, reason: "STANDING_THREW", permanent: false, detail: messageOf(err) };
    }
    return legOutcome(r);
  }

  async function payOne(p, now, out, gate) {
    const isk = await payIsk(p);
    if (isStopped()) return false;
    const std = payStanding(p);
    const m = planMark(p, [isk, std], P, now);
    const w = tx("situations.payout", (t) => R.markPayoutInTx(t, p, m, now));
    if (!w.ok) {
      bump("payoutMarkFailed");
      lastRefusal = `payout:${p.payoutKey} ${w.reason}`;
      gate.due = Math.min(gate.due, now);
      return true;
    }
    if (isk.duplicate || std.duplicate) bump("payoutDuplicates");
    if (m.state === S.PAYOUT_ROW_STATES.PENDING) {
      gate.due = Math.min(gate.due, m.nextAttemptAt === null ? now : m.nextAttemptAt);
      out.retried += 1;
      bump("payoutRetries");
      lastRefusal = `payout:${p.payoutKey} ${m.lastReason}`;
      return true;
    }
    pending = Math.max(0, pending - 1);
    if (m.state === S.PAYOUT_ROW_STATES.PAID) {
      out.paid += 1;
      bump("payoutsPaid");
    } else {
      out.failed += 1;
      bump("payoutsFailed");
      lastRefusal = `payout:${p.payoutKey} ${m.lastReason}`;
      log(`payout ${p.payoutKey} FAILED (isk=${m.iskState} std=${m.stdState}) - ${m.lastReason}`);
    }
    return true;
  }

  async function runPayoutPass(now) {
    const out = { ok: true, paid: 0, failed: 0, retried: 0 };
    try {
      if (isStopped()) return { ok: false, reason: "STOPPED" };
      passes += 1;
      if (P.rewardsEnabled !== true) return out;
      if (pending > 0 && now >= nextDueAt) {
        planned = false;
        const read = tx("situations.payoutRead", (t) => R.listDuePayoutsInTx(t, P.payoutBatch, now));
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
    notePlanned: (n = 1) => {
      if (!(n > 0)) return;
      pending += n;
      nextDueAt = 0;
      planned = true;
    },
    runPayoutPass,
    status: () => Object.freeze({ pending, nextDueAt, passes, lastRefusal }),
  });
}

module.exports = { createSituationPayoutPump, legKeyOf, retryDelayOf, planMark, legOutcome, PERMANENT_REASONS };
