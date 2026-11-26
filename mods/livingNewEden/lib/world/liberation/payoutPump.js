"use strict";

const S = require("./rewardSchema");

const LEG = S.LEG_STATE;
const ROW = S.ROW_STATE;
const MAX_ERROR = 120;
const PERMANENT_REASONS = new Set(["CHARACTER_NOT_FOUND", "BALANCE_LIMIT", "WALLET_KEY_INVALID",
  "INVALID_OWNER_OR_ISSUER"]);
const PUMP_METHODS = Object.freeze(["rewardCreditIsk", "rewardCreditLp", "rewardSeams"]);

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_ERROR);
}

function legKeyOf(payoutKey, leg) {
  const prefix = `${S.KEY_PREFIX}:`;
  const rest = payoutKey.startsWith(prefix) ? payoutKey.slice(prefix.length) : payoutKey;
  return `lne:${S.KEY_PREFIX}:${rest}:${leg}`;
}

function retryDelayOf(attempts, baseMs, maxMs) {
  return Math.min(maxMs, baseMs * 2 ** Math.min(attempts, 62));
}

function createPayoutPump(deps) {
  const { store, repo, params, count, isStopped } = deps;
  const adapter = deps.adapter || null;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const log = typeof deps.log === "function" ? deps.log : () => {};
  let lastRefusal = null;
  let seamsMissing = false;
  let passes = 0;

  function bump(name, n = 1) {
    if (!(n > 0)) return;
    try {
      count(name, n);
    } catch (_err) {
    }
  }

  function refuse(where, reason) {
    lastRefusal = `${where}:${String(reason).slice(0, MAX_ERROR)}`;
  }

  function governorAdmits() {
    try {
      const g = getGovernor();
      return !g || typeof g.admits !== "function" || g.admits("MAINTENANCE") !== false;
    } catch (_err) {
      return true;
    }
  }

  function seamsReady() {
    if (!adapter || PUMP_METHODS.some((m) => typeof adapter[m] !== "function")) {
      return { ok: false, missing: ["adapter.rewardCreditIsk/rewardCreditLp/rewardSeams"] };
    }
    try {
      const r = adapter.rewardSeams();
      return r && r.ok === true ? { ok: true } : { ok: false, missing: (r && r.missing) || ["no result"] };
    } catch (err) {
      return { ok: false, missing: [messageOf(err)] };
    }
  }

  function legOutcome(r, stats) {
    if (r && r.ok === true) {
      if (r.duplicate === true) stats.duplicates += 1;
      if (r.fingerprintMismatch === true) stats.mismatch += 1;
      return { state: LEG.DONE, transient: false, error: null };
    }
    const reason = (r && r.reason) || "NO_RESULT";
    const error = `${reason}${r && r.detail ? `:${r.detail}` : ""}`;
    if ((r && r.permanent === true) || PERMANENT_REASONS.has(reason)) {
      return { state: LEG.FAILED, transient: false, error };
    }
    return { state: LEG.PENDING, transient: true, error };
  }

  async function payIsk(row, stats) {
    if (row.iskState !== LEG.PENDING) return { state: row.iskState, transient: false, error: null };
    let r;
    try {
      r = await adapter.rewardCreditIsk({ characterId: row.characterId, amountIsk: row.iskAmount,
        commandId: legKeyOf(row.payoutKey, "isk"), issuerCorporationId: row.lpCorporationId,
        systemId: row.systemId, description: row.description });
    } catch (err) {
      r = { ok: false, reason: "WALLET_FAILED", permanent: false, detail: messageOf(err) };
    }
    return legOutcome(r, stats);
  }

  function payLp(row, stats) {
    if (row.lpState !== LEG.PENDING) return { state: row.lpState, transient: false, error: null };
    let r;
    try {
      r = adapter.rewardCreditLp({ characterId: row.characterId, amountLp: row.lpAmount,
        issuerCorporationId: row.lpCorporationId, commandId: legKeyOf(row.payoutKey, "lp") });
    } catch (err) {
      r = { ok: false, reason: "LP_FAILED", permanent: false, detail: messageOf(err) };
    }
    return legOutcome(r, stats);
  }

  function planMark(row, isk, lp, now) {
    const transient = isk.transient || lp.transient;
    const error = [isk.error, lp.error].filter(Boolean).join("; ").slice(0, MAX_ERROR) || null;
    let iskState = isk.state;
    let lpState = lp.state;
    let attempts = row.attempts;
    let nextAttemptAt = row.nextAttemptAt;
    let retry = false;
    if (transient) {
      attempts += 1;
      if (attempts >= params.payoutMaxAttempts) {
        if (iskState === LEG.PENDING) iskState = LEG.FAILED;
        if (lpState === LEG.PENDING) lpState = LEG.FAILED;
      } else {
        retry = true;
        nextAttemptAt = now + retryDelayOf(row.attempts, params.payoutRetryBaseMs, params.payoutRetryMaxMs);
      }
    }
    const pending = iskState === LEG.PENDING || lpState === LEG.PENDING;
    const state = pending ? ROW.PENDING : (iskState === LEG.FAILED || lpState === LEG.FAILED ? ROW.FAILED : ROW.PAID);
    return { payoutKey: row.payoutKey, iskState, lpState, state, attempts, nextAttemptAt,
      lastError: error, now, retry };
  }

  function prune(now, summary) {
    const r = store.transaction("liberation.prune", (tx) => {
      const p = repo.prunePayoutsInTx(tx, now - params.payoutRetentionMs, params.rewardPrunePerPass);
      if (!p.ok) return p;
      const c = repo.pruneContributionsInTx(tx, now - params.rewardContributionWindowMs, params.rewardPrunePerPass);
      if (!c.ok) return c;
      return { ok: true, payouts: p.deleted, contributions: c.deleted };
    });
    const v = r && r.ok ? r.value : null;
    if (!v || !v.ok) {
      refuse("liberation.prune", (v && (v.detail || v.reason)) || (r && r.reason) || "TX_FAILED");
      return;
    }
    summary.pruned = v.payouts;
    summary.contributionsPruned = v.contributions;
    bump("payoutsPruned", v.payouts);
    bump("contributionsPruned", v.contributions);
  }

  async function payRows(now, summary) {
    const ready = seamsReady();
    if (!ready.ok) {
      if (!seamsMissing) log(`liberation: payout seams missing - ${ready.missing.join(", ")} (rows wait PENDING)`);
      seamsMissing = true;
      refuse("liberation.payoutSeams", ready.missing.join(","));
      summary.outcome = "SEAMS_MISSING";
      return;
    }
    if (seamsMissing) log("liberation: payout seams ready");
    seamsMissing = false;
    const read = store.transaction("liberation.payoutRead",
      (tx) => repo.listDuePayoutsInTx(tx, now, params.payoutMaxPerPass));
    const list = read && read.ok ? read.value : null;
    if (!list || !list.ok) {
      refuse("liberation.payoutRead", (list && (list.detail || list.reason)) || (read && read.reason) || "TX_FAILED");
      summary.outcome = "READ_FAILED";
      return;
    }
    for (const row of list.rows) {
      if (isStopped()) {
        summary.outcome = "STOPPED";
        return;
      }
      const stats = { duplicates: 0, mismatch: 0 };
      const isk = await payIsk(row, stats);
      const lp = payLp(row, stats);
      const m = planMark(row, isk, lp, now);
      const w = store.transaction("liberation.payoutMark", (tx) => repo.markPayoutInTx(tx, m));
      const done = w && w.ok ? w.value : null;
      if (!done || !done.ok) {
        refuse("liberation.payoutMark", (done && (done.detail || done.reason)) || (w && w.reason) || "TX_FAILED");
        summary.markFailed += 1;
        continue;
      }
      bump("payoutDuplicates", stats.duplicates);
      bump("payoutFingerprintMismatch", stats.mismatch);
      if (!done.changed) continue;
      if (m.state === ROW.PAID) {
        summary.paid += 1;
        bump("payoutsPaid");
      } else if (m.state === ROW.FAILED) {
        summary.failed += 1;
        bump("payoutsFailed");
        refuse("liberation.payout", `${row.payoutKey} ${m.lastError || "FAILED"}`);
        log(`liberation: payout ${row.payoutKey} FAILED (isk=${m.iskState} lp=${m.lpState}) ${m.lastError || ""}`);
      } else if (m.retry) {
        summary.retries += 1;
        bump("payoutRetries");
        refuse("liberation.payout", `${row.payoutKey} ${m.lastError || "RETRY"}`);
      }
    }
  }

  async function runPass(now) {
    const summary = { outcome: "DONE", paid: 0, failed: 0, retries: 0, markFailed: 0, pruned: 0,
      contributionsPruned: 0 };
    try {
      if (isStopped()) return { ...summary, outcome: "STOPPED" };
      passes += 1;
      if (!governorAdmits()) {
        bump("payoutDeferred");
        return { ...summary, outcome: "DEFERRED" };
      }
      if (params.payoutEnabled === true) await payRows(now, summary);
      if (!isStopped()) prune(now, summary);
      return summary;
    } catch (err) {
      refuse("liberation.payoutPass", messageOf(err));
      return { ...summary, outcome: "FAILED" };
    }
  }

  function getStatus() {
    return { passes, seamsMissing, lastRefusal };
  }

  return Object.freeze({ runPass, getStatus });
}

module.exports = { createPayoutPump, legKeyOf, retryDelayOf, PUMP_METHODS, PERMANENT_REASONS };
