// Structure copied from world/liberation/payoutPump.js plus a third leg, standing.

"use strict";

const { LEG_STATE: LEG, ROW_STATE: ROW } = require("./schema");
const { STANDING_REASON, STANDING_DATA, ISK_SOURCE } = require("./data");

const MAX_ERROR = 120;
const MICRO = 1e6;
const PERMANENT_REASONS = new Set(["CHARACTER_NOT_FOUND", "BALANCE_LIMIT", "WALLET_KEY_INVALID",
  "INVALID_OWNER_OR_ISSUER", "IDEMPOTENCY_KEY_REUSED"]);
const PUMP_METHODS = Object.freeze(["rewardCreditIsk", "rewardCreditLp", "rewardSeams", "applyStandingGrant"]);

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_ERROR);
}

function legKeyOf(payoutKey, leg) {
  return `lne:${payoutKey}:${leg}`;
}

function retryDelayOf(attempts, baseMs, maxMs) {
  return Math.min(maxMs, baseMs * 2 ** Math.min(attempts, 62));
}

const DEFAULT_LABELS = Object.freeze({ txPrefix: "frontJobs", standingReason: STANDING_REASON,
  standingData: STANDING_DATA, iskSource: ISK_SOURCE });
const STRING_LABELS = Object.freeze(["txPrefix", "standingReason", "iskSource"]);

function labelsOf(raw) {
  if (raw === undefined || raw === null) return { labels: DEFAULT_LABELS, invalid: false };
  if (typeof raw !== "object") return { labels: DEFAULT_LABELS, invalid: true };
  const L = { ...DEFAULT_LABELS, ...raw };
  const badString = STRING_LABELS.some((k) => typeof L[k] !== "string" || L[k] === "");
  const d = L.standingData;
  const badData = !d || typeof d !== "object" || !(Number.isSafeInteger(d.eventTypeId) && d.eventTypeId > 0)
    || !d.msgByReason || typeof d.msgByReason[L.standingReason] !== "string";
  return badString || badData ? { labels: DEFAULT_LABELS, invalid: true } : { labels: Object.freeze(L), invalid: false };
}

function createPayoutPump(deps) {
  const { store, repo, params, count, isStopped } = deps;
  const adapter = deps.adapter || null;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const { labels: L, invalid: labelsInvalid } = labelsOf(deps.labels);
  if (labelsInvalid) {
    try {
      log("payout labels invalid - the front job labels are used");
    } catch (_err) {
    }
  }
  const P = L.txPrefix;
  let lastRefusal = null;
  let seamsMissing = false;
  let standingMissing = false;
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
      return { ok: false, missing: [`adapter.${PUMP_METHODS.join("/")}`] };
    }
    try {
      const r = adapter.rewardSeams();
      return r && r.ok === true ? { ok: true, standing: standingReady() }
        : { ok: false, missing: (r && r.missing) || ["no result"] };
    } catch (err) {
      return { ok: false, missing: [messageOf(err)] };
    }
  }

  function standingReady() {
    if (typeof adapter.checkStandingWrite !== "function") return { ok: true };
    try {
      const r = adapter.checkStandingWrite();
      return r && r.ok === true ? { ok: true } : { ok: false, reason: String((r && r.reason) || "no result") };
    } catch (err) {
      return { ok: false, reason: messageOf(err) };
    }
  }

  function legOutcome(r, stats) {
    if (r && r.ok === true) {
      if (r.duplicate === true || r.outcome === "DUPLICATE") stats.duplicates += 1;
      return { state: LEG.DONE, transient: false, error: null };
    }
    const reason = (r && r.reason) || "NO_RESULT";
    const error = `${reason}${r && r.detail ? `:${r.detail}` : ""}`;
    if ((r && r.permanent === true) || PERMANENT_REASONS.has(reason)) {
      return { state: LEG.FAILED, transient: false, error };
    }
    return { state: LEG.PENDING, transient: true, error };
  }

  const untouched = (state) => ({ state, transient: false, error: null });

  async function payIsk(row, stats) {
    if (row.iskState !== LEG.PENDING) return untouched(row.iskState);
    let r;
    try {
      r = await adapter.rewardCreditIsk({ characterId: row.characterId, amountIsk: row.iskAmount,
        commandId: legKeyOf(row.payoutKey, "isk"), issuerCorporationId: null, systemId: row.systemId,
        description: row.description, source: L.iskSource });
    } catch (err) {
      r = { ok: false, reason: "WALLET_FAILED", permanent: false, detail: messageOf(err) };
    }
    return legOutcome(r, stats);
  }

  function payLp(row, stats) {
    if (row.lpState !== LEG.PENDING) return untouched(row.lpState);
    let r;
    try {
      r = adapter.rewardCreditLp({ characterId: row.characterId, amountLp: row.lpAmount,
        issuerCorporationId: row.lpCorporationId, commandId: legKeyOf(row.payoutKey, "lp") });
    } catch (err) {
      r = { ok: false, reason: "LP_FAILED", permanent: false, detail: messageOf(err) };
    }
    return legOutcome(r, stats);
  }

  const waiting = (error) => ({ state: LEG.PENDING, transient: false, waiting: true, error });

  function payStanding(row, stats, standingSeam) {
    if (row.stdState !== LEG.PENDING) return untouched(row.stdState);
    if (standingSeam && standingSeam.ok !== true) return waiting(`SEAM_UNAVAILABLE:${standingSeam.reason}`);
    let r;
    try {
      r = adapter.applyStandingGrant({ key: legKeyOf(row.payoutKey, "std"), characterId: row.characterId,
        factionId: row.issuerFactionId, rawChange: row.standingMicro / MICRO, reason: L.standingReason },
      L.standingData);
    } catch (err) {
      r = { ok: false, reason: "STANDING_THREW", permanent: false, detail: messageOf(err) };
    }
    if (r && r.ok !== true && r.reason === "IDEMPOTENCY_KEY_REUSED") stats.keyReused += 1;
    if (r && r.ok !== true && r.reason === "SEAM_UNAVAILABLE") return waiting(`SEAM_UNAVAILABLE:${r.detail || ""}`);
    return legOutcome(r, stats);
  }

  function planMark(row, outcomes, now) {
    const transient = outcomes.some((o) => o.transient);
    const error = outcomes.map((o) => o.error).filter(Boolean).join("; ").slice(0, MAX_ERROR) || null;
    const states = outcomes.map((o) => o.state);
    let attempts = row.attempts;
    let nextAttemptAt = row.nextAttemptAt;
    let retry = false;
    if (transient) {
      attempts += 1;
      if (attempts >= params.payoutMaxAttempts) {
        for (let i = 0; i < states.length; i += 1) if (outcomes[i].transient) states[i] = LEG.FAILED;
      } else {
        retry = true;
        nextAttemptAt = now + retryDelayOf(row.attempts, params.payoutRetryBaseMs, params.payoutRetryMaxMs);
      }
    }
    if (!retry && states.includes(LEG.PENDING) && outcomes.some((o) => o.waiting === true)) {
      nextAttemptAt = now + params.payoutRetryBaseMs;
    }
    const state = states.includes(LEG.PENDING) ? ROW.PENDING
      : (states.includes(LEG.FAILED) ? ROW.FAILED : ROW.PAID);
    return { payoutKey: row.payoutKey, iskState: states[0], lpState: states[1], stdState: states[2], state, attempts,
      nextAttemptAt, lastError: error, now, retry };
  }

  function pruneLimit() {
    const maxRows = store.limits && Number.isSafeInteger(store.limits.maxRowsPerTransaction)
      ? store.limits.maxRowsPerTransaction : null;
    return maxRows === null ? params.prunePerPass
      : Math.max(1, Math.min(params.prunePerPass, Math.floor(maxRows / 3)));
  }

  function prune(now, summary) {
    const r = store.transaction(`${P}.prune`, (tx) => repo.pruneInTx(tx, now - params.retentionMs,
      now - params.payoutRetentionMs, pruneLimit()));
    const v = r && r.ok ? r.value : null;
    if (!v || !v.ok) {
      refuse(`${P}.prune`, (v && (v.detail || v.reason)) || (r && r.reason) || "TX_FAILED");
      return;
    }
    summary.pruned = v.progress + v.jobs + v.payouts;
    bump("pruned", summary.pruned);
  }

  async function payRows(now, summary) {
    const ready = seamsReady();
    if (!ready.ok) {
      if (!seamsMissing) log(`payout seams missing - ${ready.missing.join(", ")} (rows wait PENDING)`);
      if (!seamsMissing) bump("seamsMissing");
      seamsMissing = true;
      refuse(`${P}.payoutSeams`, ready.missing.join(","));
      summary.outcome = "SEAMS_MISSING";
      return;
    }
    if (seamsMissing) log("payout seams ready");
    seamsMissing = false;
    const standingSeam = ready.standing;
    if (standingSeam.ok !== true) {
      if (!standingMissing) {
        log(`standing seam missing - ${standingSeam.reason} (standing legs wait PENDING)`);
        bump("seamsMissing");
      }
      standingMissing = true;
      refuse(`${P}.standingSeam`, standingSeam.reason);
    } else {
      if (standingMissing) log("standing seam ready");
      standingMissing = false;
    }
    const read = store.transaction(`${P}.payoutRead`,
      (tx) => repo.listDuePayoutsInTx(tx, now, params.payoutMaxPerPass));
    const list = read && read.ok ? read.value : null;
    if (!list || !list.ok) {
      refuse(`${P}.payoutRead`, (list && (list.detail || list.reason)) || (read && read.reason) || "TX_FAILED");
      summary.outcome = "READ_FAILED";
      return;
    }
    for (const row of list.rows) {
      if (isStopped()) {
        summary.outcome = "STOPPED";
        return;
      }
      const stats = { duplicates: 0, keyReused: 0 };
      const isk = await payIsk(row, stats);
      const lp = payLp(row, stats);
      const std = payStanding(row, stats, standingSeam);
      const m = planMark(row, [isk, lp, std], now);
      const w = store.transaction(`${P}.payoutMark`, (tx) => repo.markPayoutInTx(tx, m));
      const done = w && w.ok ? w.value : null;
      if (!done || !done.ok) {
        refuse(`${P}.payoutMark`, (done && (done.detail || done.reason)) || (w && w.reason) || "TX_FAILED");
        summary.markFailed += 1;
        continue;
      }
      bump("legDuplicates", stats.duplicates);
      bump("keyReused", stats.keyReused);
      if (!done.changed) continue;
      if (m.state === ROW.PAID) {
        summary.paid += 1;
        bump("payoutsPaid");
      } else if (m.state === ROW.FAILED) {
        summary.failed += 1;
        bump("payoutsFailed");
        refuse(`${P}.payout`, `${row.payoutKey} ${m.lastError || "FAILED"}`);
        log(`payout ${row.payoutKey} FAILED (isk=${m.iskState} lp=${m.lpState} std=${m.stdState}) `
          + `${m.lastError || ""}`);
      } else if (m.retry) {
        summary.retries += 1;
        bump("legRetries");
        refuse(`${P}.payout`, `${row.payoutKey} ${m.lastError || "RETRY"}`);
      }
    }
  }

  async function runPass(now) {
    const summary = { outcome: "DONE", paid: 0, failed: 0, retries: 0, markFailed: 0, pruned: 0 };
    try {
      if (isStopped()) return { ...summary, outcome: "STOPPED" };
      passes += 1;
      if (!governorAdmits()) return { ...summary, outcome: "DEFERRED" };
      if (params.payoutEnabled === true) await payRows(now, summary);
      if (!isStopped()) prune(now, summary);
      return summary;
    } catch (err) {
      refuse(`${P}.payoutPass`, messageOf(err));
      return { ...summary, outcome: "FAILED" };
    }
  }

  function getStatus() {
    return { passes, seamsMissing, standingMissing, lastRefusal };
  }

  return Object.freeze({ runPass, getStatus });
}

module.exports = { createPayoutPump, legKeyOf, retryDelayOf, PUMP_METHODS, PERMANENT_REASONS };
