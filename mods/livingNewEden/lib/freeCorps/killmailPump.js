"use strict";

const { createPoller } = require("../presence/poller");
const { createAbortSentinel } = require("../persistence/store");
const { backoffMs, spacingMs } = require("./killmails");
const { OUTBOX_KIND_KILLMAIL } = require("./schema");

const CLAIM_CONFLICT = createAbortSentinel("freeCorps.killmails.claimConflict");
const SETTLE_CONFLICT = createAbortSentinel("freeCorps.killmails.settleConflict");
const MAX_DETAIL = 200;
const MS_DECIMALS = 10;

function safe(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

const detailOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);

function createKillmailPump(deps) {
  const { store, outbox, clock, S } = deps;
  const R = deps.retention || { ventureRetentionMs: 0, pruneBatch: 0 };
  const nowMs = deps.nowMs;
  const bump = typeof deps.bump === "function" ? deps.bump : () => {};
  const metric = typeof deps.metric === "function" ? deps.metric : () => {};
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const onWrite = typeof deps.onWrite === "function" ? deps.onWrite : () => {};
  const isRunning = typeof deps.isRunning === "function" ? deps.isRunning : () => true;
  const gap = spacingMs(S.maxPerHour);
  const kind = OUTBOX_KIND_KILLMAIL;
  let stopped = false;
  let running = false;
  let slowUntil = 0;
  let lastCallMs = null;
  let pending = null;
  let seamOk = null;

  function claimTx(tx, now) {
    const out = { op: "idle", expired: 0, pruned: 0, pending: 0, row: null };
    const ex = outbox.expireInTx(tx, { kind, before: Math.max(0, now - S.maxAgeMs), now,
      limit: Math.max(1, R.pruneBatch) });
    if (!ex.ok) throw new Error(`expire: ${ex.reason}`);
    out.expired = ex.expired;
    if (R.pruneBatch > 0) {
      const pr = outbox.pruneInTx(tx, { before: Math.max(0, now - R.ventureRetentionMs), limit: R.pruneBatch });
      if (!pr.ok) throw new Error(`prune: ${pr.reason}`);
      out.pruned = pr.deleted;
    }
    const cp = outbox.countPendingInTx(tx, { kind });
    if (!cp.ok) throw new Error(`count: ${cp.reason}`);
    out.pending = cp.count;
    const last = outbox.lastAttemptAtInTx(tx, { kind });
    if (!last.ok) throw new Error(`last attempt: ${last.reason}`);
    if (last.at !== null && now < last.at + gap) {
      out.op = "wait";
      return out;
    }
    const due = outbox.nextDueInTx(tx, { kind, now });
    if (!due.ok) throw new Error(`next due: ${due.reason}`);
    if (!due.row) return out;
    const cl = outbox.claimInTx(tx, { key: due.row.key, expectedVersion: due.row.version, now });
    if (!cl.ok) {
      if (cl.reason === "CAS_CONFLICT") throw CLAIM_CONFLICT;
      throw new Error(`claim: ${cl.reason}`);
    }
    out.op = "call";
    out.row = { ...due.row, version: cl.version, attempts: due.row.attempts + 1, attempted_at: now };
    return out;
  }

  function settleTx(tx, row, r, now) {
    let w;
    let outcome;
    if (r && r.ok === true) {
      w = outbox.completeInTx(tx, { key: row.key, expectedVersion: row.version, now, resultId: r.killId });
      outcome = "done";
    } else {
      const error = `${(r && r.reason) || "NO_RESULT"}${r && r.detail ? ` ${r.detail}` : ""}`;
      if ((r && r.reason === "INVALID_INPUT") || row.attempts >= S.maxAttempts) {
        w = outbox.failInTx(tx, { key: row.key, expectedVersion: row.version, now, error });
        outcome = "failed";
      } else {
        w = outbox.retryInTx(tx, { key: row.key, expectedVersion: row.version,
          nextAt: now + backoffMs(row.attempts, S), error });
        outcome = "retry";
      }
    }
    if (!w.ok) {
      if (w.reason === "CAS_CONFLICT") throw SETTLE_CONFLICT;
      throw new Error(`settle: ${w.reason}`);
    }
    return outcome;
  }

  function call(row) {
    let spec = null;
    try {
      spec = JSON.parse(row.payload);
    } catch (_err) {
      return { ok: false, reason: "INVALID_INPUT", detail: "payload" };
    }
    const r = safe(() => deps.writeVirtualKillmail(spec, row.key), { ok: false, reason: "ADAPTER_THROW" });
    return r && typeof r === "object" ? r : { ok: false, reason: "NO_RESULT" };
  }

  function runNow() {
    if (stopped || safe(isRunning, false) !== true) return { ok: true, ran: false, reason: "NOT_RUNNING" };
    if (running) return { ok: true, ran: false, reason: "BUSY" };
    const governor = safe(() => deps.getGovernor(), null);
    if (governor && typeof governor.admits === "function"
      && safe(() => governor.admits(deps.workClass), true) === false) {
      bump("kmDeferred");
      return { ok: true, ran: false, reason: "DEFERRED" };
    }
    const seam = safe(() => deps.virtualKillmailSeams(), null);
    seamOk = Boolean(seam && seam.ok === true);
    if (!seamOk) {
      bump("kmSeamUnavailable");
      return { ok: true, ran: false, reason: "SEAM_UNAVAILABLE" };
    }
    const now = clock.now();
    if (now < slowUntil) {
      bump("kmSlowPaused");
      return { ok: true, ran: false, reason: "SLOW_PAUSED" };
    }
    running = true;
    try {
      const c = store.transaction("freeCorps.killmails.claim", (tx) => claimTx(tx, now));
      if (!c || c.ok !== true) {
        if (c && c.error === CLAIM_CONFLICT) bump("kmClaimConflict");
        else log(`killmail claim failed - ${(c && c.reason) || "TX_FAILED"}${c && c.error ? ` ${detailOf(c.error)}` : ""}`);
        return { ok: false, reason: "CLAIM_FAILED" };
      }
      const v = c.value;
      if (v.expired > 0) bump("kmExpired", v.expired);
      if (v.pruned > 0) bump("kmPruned", v.pruned);
      if (v.expired + v.pruned > 0 || v.op === "call") onWrite();
      pending = v.pending;
      metric("gauge", "freeCorps.killmailsPending", v.pending);
      if (v.op === "wait") {
        bump("kmSpacing");
        return { ok: true, ran: false, reason: "SPACING" };
      }
      if (v.op !== "call") return { ok: true, ran: false, reason: "IDLE" };
      const t0 = nowMs();
      const r = call(v.row);
      const ms = nowMs() - t0;
      bump("kmCalls");
      lastCallMs = Math.round(ms * MS_DECIMALS) / MS_DECIMALS;
      metric("observe", "freeCorps.killmailCallMs", lastCallMs);
      if (ms > S.slowCallMs) {
        slowUntil = now + S.slowPauseMs;
        bump("kmSlowPause");
        log(`killmail call slow (${lastCallMs} ms > ${S.slowCallMs} ms) - pump paused until ${slowUntil}`);
      }
      const s = store.transaction("freeCorps.killmails.settle", (tx) => settleTx(tx, v.row, r, now));
      if (!s || s.ok !== true) {
        if (s && s.error === SETTLE_CONFLICT) bump("kmSettleConflict");
        else log(`killmail settle failed - ${(s && s.reason) || "TX_FAILED"}${s && s.error ? ` ${detailOf(s.error)}` : ""}`);
        return { ok: false, reason: "SETTLE_FAILED", call: r };
      }
      onWrite();
      if (s.value === "done") bump("kmDone");
      else if (s.value === "failed") bump("kmFailed");
      else bump("kmRetry");
      return { ok: true, ran: true, outcome: s.value, key: v.row.key, call: r };
    } catch (err) {
      log(`killmail pump failed - ${detailOf(err)}`);
      return { ok: false, reason: "PUMP_FAILED" };
    } finally {
      running = false;
    }
  }

  const poller = createPoller({ runPass: () => { runNow(); }, intervalMs: S.pumpMs, now: () => clock.now(),
    setTimer: deps.setTimer, onError: (err) => log(`killmail pump timer - ${detailOf(err)}`) });

  return Object.freeze({
    start: () => poller.start(),
    stop: () => {
      stopped = true;
      poller.stop();
    },
    runNow,
    status: () => Object.freeze({ seam: seamOk === false ? "UNAVAILABLE" : "OK", pending, lastCallMs,
      slowUntil: slowUntil > 0 ? slowUntil : null }),
  });
}

module.exports = { createKillmailPump };
