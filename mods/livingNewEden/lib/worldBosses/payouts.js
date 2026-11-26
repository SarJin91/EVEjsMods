"use strict";

const S = require("./schema");

const MAX_DETAIL = 120;
const MAINTENANCE = "MAINTENANCE";
const PERMANENT_REASONS = new Set(["CHARACTER_NOT_FOUND", "BALANCE_LIMIT", "WALLET_KEY_INVALID",
  "INVALID_OWNER_OR_ISSUER", "IDEMPOTENCY_KEY_REUSED"]);
const SEAM_WAIT_REASON = "SEAM_UNAVAILABLE";

const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);

function legKeyOf(payoutKey) {
  return `lne:${payoutKey}:isk`;
}

function retryDelayOf(attempts, baseMs, maxMs) {
  return Math.min(maxMs, baseMs * 2 ** Math.min(attempts, 62));
}

function planMark(row, r, R, now) {
  if (r && r.ok === true) {
    return { state: S.PAYOUT_STATES.PAID, attempts: row.attempts, nextAttemptAt: null, lastReason: null,
      duplicate: r.duplicate === true || r.outcome === "DUPLICATE" };
  }
  const reason = String((r && r.reason) || "NO_RESULT");
  const lastReason = `${reason}${r && r.detail ? `:${r.detail}` : ""}`.slice(0, MAX_DETAIL);
  if ((r && r.permanent === true) || PERMANENT_REASONS.has(reason)) {
    return { state: S.PAYOUT_STATES.FAILED, attempts: row.attempts, nextAttemptAt: null, lastReason, duplicate: false };
  }
  if (reason === SEAM_WAIT_REASON) {
    return { state: S.PAYOUT_STATES.PENDING, attempts: row.attempts, nextAttemptAt: now + R.payoutRetryBaseMs,
      lastReason, duplicate: false };
  }
  const attempts = row.attempts + 1;
  if (attempts >= R.payoutMaxAttempts) {
    return { state: S.PAYOUT_STATES.FAILED, attempts, nextAttemptAt: null, lastReason, duplicate: false };
  }
  return { state: S.PAYOUT_STATES.PENDING, attempts,
    nextAttemptAt: now + retryDelayOf(row.attempts, R.payoutRetryBaseMs, R.payoutRetryMaxMs), lastReason,
    duplicate: false };
}

function createWorldBossPayoutPump(deps) {
  const { store, repo, bump, log, isStopped } = deps;
  const P = deps.settings;
  const R = P.rewards;
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

  function admitted() {
    const g = typeof deps.getGovernor === "function" ? deps.getGovernor() : null;
    if (!g || typeof g.admits !== "function") return true;
    try {
      return g.admits(MAINTENANCE) !== false;
    } catch (_err) {
      return true;
    }
  }

  function boot() {
    const r = tx("worldBosses.payoutBoot", (t) => repo.countPendingPayoutsInTx(t));
    if (r.ok) pending = r.pending;
    else {
      pending = 1;
      lastRefusal = `payoutBoot:${r.reason}`;
      log(`payout boot read failed - ${r.reason}, first pass reads the table`);
    }
    return r;
  }

  function prune(now) {
    if (now < nextPruneAt) return;
    nextPruneAt = now + P.pruneEveryMs;
    if (now - R.payoutRetentionMs <= 0) return;
    const r = tx("worldBosses.payoutPrune", (t) => repo.prunePayoutsInTx(t, now - R.payoutRetentionMs,
      P.prunePerRun));
    if (r.ok) bump("payoutsPruned", r.deleted);
    else lastRefusal = `payoutPrune:${r.reason}`;
  }

  async function payOne(p, now, out, gate) {
    let r;
    try {
      r = await deps.rewardCreditIsk({ characterId: p.characterId, amountIsk: p.amountIsk,
        commandId: legKeyOf(p.payoutKey), issuerCorporationId: null, systemId: p.systemId,
        description: S.PAYOUT_DESCRIPTION, source: S.ISK_SOURCE });
    } catch (err) {
      r = { ok: false, reason: "WALLET_FAILED", permanent: false, detail: messageOf(err) };
    }
    if (isStopped()) return false;
    const m = planMark(p, r, R, now);
    const w = tx("worldBosses.payout", (t) => repo.markPayoutInTx(t, p, m, now));
    if (!w.ok) {
      lastRefusal = `payout:${p.payoutKey} ${w.reason}`;
      gate.due = Math.min(gate.due, now);
      return true;
    }
    if (m.state === S.PAYOUT_STATES.PENDING) {
      gate.due = Math.min(gate.due, m.nextAttemptAt === null ? now : m.nextAttemptAt);
      out.retried += 1;
      lastRefusal = `payout:${p.payoutKey} ${m.lastReason}`;
      return true;
    }
    pending = Math.max(0, pending - 1);
    if (m.state === S.PAYOUT_STATES.PAID) {
      out.paid += 1;
      bump("payoutsPaid");
    } else {
      out.failed += 1;
      bump("payoutsFailed");
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
      if (R.enabled !== true || !admitted()) return out;
      if (pending > 0 && now >= nextDueAt) {
        planned = false;
        const read = tx("worldBosses.payoutRead", (t) => repo.listDuePayoutsInTx(t, R.payoutBatch, now));
        if (!read.ok) {
          lastRefusal = `payoutRead:${read.reason}`;
          return { ok: false, reason: read.reason };
        }
        const short = read.payouts.length < R.payoutBatch;
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

module.exports = { createWorldBossPayoutPump, legKeyOf, retryDelayOf, planMark, PERMANENT_REASONS };
