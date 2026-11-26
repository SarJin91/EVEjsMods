"use strict";

const { createAbortSentinel } = require("../../persistence/store");
const R = require("./rules");
const S = require("./schema");

const ABORT = createAbortSentinel("devIndices.invest.ABORT");
const CONFLICT = createAbortSentinel("devIndices.invest.VERSION_CONFLICT");
const MAX_BACKOFF_EXPONENT = 30;
const MAX_REASON = 32;
const LIMIT_REASONS = Object.freeze(["LIMIT_MIN", "LIMIT_COMMAND", "LIMIT_CHARACTER_DAY", "LIMIT_SYSTEM_DAY"]);

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const messageOf = (err) => String((err && err.message) || err).slice(0, 160);

function iskText(amount) {
  return String(amount).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function backoffMs(attempts, P) {
  const exp = Math.min(MAX_BACKOFF_EXPONENT, Math.max(0, attempts));
  return Math.min(P.investRetryMaxMs, P.investRetryMs * 2 ** exp);
}

function createInvest(deps) {
  const { store, repo, memory, settings: P, ids } = deps;
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const bump = typeof deps.bump === "function" ? deps.bump : () => {};
  const gauge = typeof deps.gauge === "function" ? deps.gauge : () => {};
  const inFlight = new Set();
  let resuming = false;
  let stopped = false;

  function safe(fn, fallback) {
    try {
      return fn();
    } catch (_err) {
      return fallback;
    }
  }

  const worldRepository = () => safe(() => (typeof deps.getWorldRepository === "function"
    ? deps.getWorldRepository() : null), null);
  const nameOf = (systemId) => {
    const n = safe(() => (typeof deps.systemNameOf === "function" ? deps.systemNameOf(systemId) : null), null);
    return typeof n === "string" && /^[\x20-\x7e]+$/.test(n) ? n : String(systemId);
  };

  function tell(inv, text) {
    if (typeof deps.sendCharacterSystemLine !== "function") return;
    safe(() => deps.sendCharacterSystemLine({ characterId: inv.characterId, systemId: inv.systemId, text }), null);
  }

  function requestInTx(tx, spec) {
    if (!spec || !isId(spec.characterId) || !isId(spec.systemId) || !S.KINDS.includes(spec.kind)
      || !isId(spec.amount) || typeof spec.nonce !== "string" || spec.nonce.length < 1 || !isTime(spec.now)) {
      return { ok: false, reason: "INVALID" };
    }
    const key = `${S.INVEST_KEY_PREFIX}${spec.characterId}:${spec.nonce}`;
    const known = repo.findInvestByKeyInTx(tx, key);
    if (!known.ok) return known;
    if (known.invest) return { ok: false, reason: "DUPLICATE" };
    const points = R.investPoints(spec.amount, P);
    if (spec.amount < P.investMinIsk || points < 1) return { ok: false, reason: "LIMIT_MIN" };
    if (spec.amount > P.investMaxIskPerCommand || spec.amount > S.MAX_INVEST_ISK) {
      return { ok: false, reason: "LIMIT_COMMAND" };
    }
    const sums = repo.sumInvestSinceInTx(tx, { characterId: spec.characterId, systemId: spec.systemId,
      since: Math.max(0, spec.now - S.INVEST_DAY_MS) });
    if (!sums.ok) return sums;
    if (sums.characterIsk + spec.amount > P.investMaxIskPerCharacterPerDay) {
      return { ok: false, reason: "LIMIT_CHARACTER_DAY" };
    }
    if (sums.systemPoints + points > P.investMaxPointsPerSystemPerDay) return { ok: false, reason: "LIMIT_SYSTEM_DAY" };
    const investId = ids.next(S.INVEST_ID_PREFIX);
    const ins = repo.insertInvestInTx(tx, { investId, idempotencyKey: key, characterId: spec.characterId,
      systemId: spec.systemId, kind: spec.kind, amount: spec.amount, points }, spec.now);
    if (!ins.ok) return ins;
    return { ok: true, investId, points };
  }

  function request(spec) {
    if (stopped) return { ok: false, reason: "STOPPED" };
    const tx = store.transaction("devIndices.investRequest", (db) => requestInTx(db, spec));
    const r = tx && tx.ok ? tx.value : { ok: false, reason: String((tx && tx.reason) || "TX_FAILED") };
    if (r.ok) bump("invest.confirmed");
    else if (r.reason === "DUPLICATE") bump("invest.duplicate");
    else if (LIMIT_REASONS.includes(r.reason)) bump("invest.limit");
    return r;
  }

  function currentOf(world, db, systemId) {
    const r = world.getSystem(db, systemId);
    if (!r || r.ok !== true) return null;
    const sys = r.system;
    return { controllerFactionId: sys && isId(sys.controllerFactionId) ? sys.controllerFactionId : null,
      occupationState: sys ? sys.occupationState : null };
  }

  function applyTx(investId, now, world) {
    let detail = null;
    const fail = (text) => {
      detail = text;
      throw ABORT;
    };
    const tx = store.transaction("devIndices.investApply", (db) => {
      const cur = repo.getInvestInTx(db, investId);
      if (!cur.ok) fail(`invest ${cur.reason}`);
      const inv = cur.invest;
      if (!inv || inv.state !== S.INVEST_STATES.PENDING) return { done: inv ? inv.state : null };
      const u = repo.updateInvestInTx(db, { investId, version: inv.version, state: S.INVEST_STATES.APPLIED,
        endReason: null, attempts: inv.attempts + 1, nextAttemptAt: null }, now);
      if (!u.ok && u.reason === "VERSION_CONFLICT") throw CONFLICT;
      if (!u.ok) fail(`invest write ${u.reason}`);
      const got = repo.getInTx(db, inv.systemId);
      if (!got.ok) fail(`row ${got.reason}`);
      const current = currentOf(world, db, inv.systemId);
      if (!current) fail(`world getSystem ${inv.systemId}`);
      const base = got.row ? R.captureLoss(R.decayRow(got.row, now, P), current, P).row : null;
      const capped = !got.row && memory.size() >= P.maxTrackedSystems;
      let next = R.applyDelta(base, inv.systemId, { [inv.kind]: inv.points }, now, P);
      if (next && !base) next = R.captureLoss(next, current, P).row;
      if (!next) return { done: S.INVEST_STATES.APPLIED, invest: u.invest, row: null, capped, gained: 0 };
      const gained = Math.max(0, next[inv.kind] - (base ? base[inv.kind] : 0));
      next = Object.freeze({ ...next, investedIskTotal: Math.min(S.MAX_ISK_TOTAL, next.investedIskTotal + inv.amount) });
      const w = repo.upsertInTx(db, next, now);
      if (!w.ok && w.reason === "VERSION_CONFLICT") throw CONFLICT;
      if (!w.ok) fail(`row write ${w.reason}${w.detail ? `:${w.detail}` : ""}`);
      return { done: S.INVEST_STATES.APPLIED, invest: u.invest, row: w.row, capped, gained };
    });
    if (!tx || !tx.ok) {
      const reason = tx && tx.error === CONFLICT ? "VERSION_CONFLICT" : String((tx && tx.reason) || "TX_FAILED");
      return { ok: false, reason, detail };
    }
    return { ok: true, value: tx.value };
  }

  function endOrRetryTx(investId, now, refusal) {
    const permanent = refusal.permanent === true;
    const tx = store.transaction(permanent ? "devIndices.investRefuse" : "devIndices.investRetry", (db) => {
      const cur = repo.getInvestInTx(db, investId);
      if (!cur.ok) throw ABORT;
      const inv = cur.invest;
      if (!inv || inv.state !== S.INVEST_STATES.PENDING) return { done: inv ? inv.state : null };
      const change = permanent
        ? { state: S.INVEST_STATES.REFUSED, endReason: String(refusal.reason || "WALLET_FAILED").slice(0, MAX_REASON),
          attempts: inv.attempts + 1, nextAttemptAt: null }
        : { state: S.INVEST_STATES.PENDING, endReason: null, attempts: inv.attempts + 1,
          nextAttemptAt: now + backoffMs(inv.attempts, P) };
      const u = repo.updateInvestInTx(db, { investId, version: inv.version, ...change }, now);
      if (!u.ok) throw u.reason === "VERSION_CONFLICT" ? CONFLICT : ABORT;
      return { done: change.state, invest: u.invest };
    });
    if (!tx || !tx.ok) return { ok: false, reason: String((tx && tx.reason) || "TX_FAILED") };
    return { ok: true, value: tx.value };
  }

  async function runSaga(investId, now) {
    if (stopped) return { ok: false, state: null, reason: "STOPPED" };
    if (inFlight.has(investId)) return { ok: false, state: S.INVEST_STATES.PENDING, reason: "IN_FLIGHT" };
    inFlight.add(investId);
    try {
      const read = store.transaction("devIndices.investRead", (db) => repo.getInvestInTx(db, investId));
      const got = read && read.ok ? read.value : null;
      if (!got || !got.ok) return { ok: false, state: null, reason: String((got && got.reason) || "TX_FAILED") };
      const inv = got.invest;
      if (!inv) return { ok: false, state: null, reason: "NOT_FOUND" };
      if (inv.state !== S.INVEST_STATES.PENDING) return { ok: true, state: inv.state };
      const world = worldRepository();
      if (!world || typeof world.getSystem !== "function") {
        return { ok: false, state: S.INVEST_STATES.PENDING, reason: "WORLD_UNAVAILABLE" };
      }
      let res;
      try {
        res = await deps.tradeAdjustWallet({ ownerKind: "character", ownerId: inv.characterId, deltaIsk: -inv.amount,
          commandId: `${S.INVEST_COMMAND_PREFIX}${inv.investId}`, description: S.INVEST_DESCRIPTION });
      } catch (err) {
        res = { ok: false, reason: "WALLET_FAILED", permanent: false, detail: messageOf(err) };
      }
      if (!res || typeof res !== "object") res = { ok: false, reason: "WALLET_FAILED", permanent: false };
      if (res.ok === true) {
        const a = applyTx(investId, now, world);
        if (!a.ok) {
          log(`invest ${investId} apply refused ${a.reason}${a.detail ? ` - ${a.detail}` : ""}`);
          return { ok: false, state: S.INVEST_STATES.PENDING, reason: a.reason };
        }
        const v = a.value;
        if (v.done !== S.INVEST_STATES.APPLIED || !v.invest) return { ok: true, state: v.done };
        if (v.row) memory.put(v.row);
        bump("invest.applied");
        if (v.capped) bump("capped.trackedInvest");
        const gained = Number.isSafeInteger(v.gained) ? v.gained : 0;
        tell(v.invest, `Invest: ${iskText(v.invest.amount)} ISK spent, ${v.invest.kind.toUpperCase()} +${gained}`
          + `${gained < v.invest.points ? " (index maximum)" : ""} in ${nameOf(v.invest.systemId)}`);
        return { ok: true, state: S.INVEST_STATES.APPLIED };
      }
      const reason = String(res.reason || "WALLET_FAILED");
      const e = endOrRetryTx(investId, now, { reason, permanent: res.permanent === true });
      if (!e.ok) return { ok: false, state: S.INVEST_STATES.PENDING, reason: e.reason };
      if (e.value.done === S.INVEST_STATES.REFUSED && e.value.invest) {
        bump("invest.refused");
        tell(e.value.invest, `Invest refused (${reason}) - no ISK taken`);
        return { ok: false, state: S.INVEST_STATES.REFUSED, reason };
      }
      if (e.value.done === S.INVEST_STATES.PENDING) {
        bump("invest.retry");
        return { ok: false, state: S.INVEST_STATES.PENDING, reason };
      }
      return { ok: true, state: e.value.done };
    } catch (err) {
      log(`invest ${investId} saga threw - ${messageOf(err)}`);
      return { ok: false, state: S.INVEST_STATES.PENDING, reason: "SAGA_THREW" };
    } finally {
      inFlight.delete(investId);
    }
  }

  async function resumeDue(now) {
    if (stopped) return { ok: false, resumed: 0, reason: "STOPPED" };
    if (resuming) return { ok: false, resumed: 0, reason: "BUSY" };
    resuming = true;
    try {
      const tx = store.transaction("devIndices.investDue", (db) => repo.listDueInvestsInTx(db, now, P.investPassRows));
      const v = tx && tx.ok ? tx.value : null;
      if (!v || !v.ok) return { ok: false, resumed: 0, reason: String((v && v.reason) || (tx && tx.reason) || "TX_FAILED") };
      let resumed = 0;
      for (const inv of v.invests) {
        if (stopped) break;
        await runSaga(inv.investId, now);
        resumed += 1;
      }
      return { ok: true, resumed };
    } catch (err) {
      log(`invest resume threw - ${messageOf(err)}`);
      return { ok: false, resumed: 0, reason: "RESUME_THREW" };
    } finally {
      resuming = false;
    }
  }

  function pruneInTx(tx, now) {
    return repo.pruneInvestsInTx(tx, Math.max(0, now - P.investRetentionMs), P.investPruneBatch);
  }

  function pass(now) {
    if (stopped) return { ok: false, pruned: 0, pending: null };
    const tx = store.transaction("devIndices.investPrune", (db) => {
      const p = pruneInTx(db, now);
      if (!p.ok) throw ABORT;
      const c = repo.countPendingInvestsInTx(db);
      if (!c.ok) throw ABORT;
      return { pruned: p.pruned, pending: c.pending };
    });
    let out = { ok: false, pruned: 0, pending: null };
    if (tx && tx.ok) {
      out = { ok: true, pruned: tx.value.pruned, pending: tx.value.pending };
      bump("invest.pruned", out.pruned);
      gauge("devIndices.invest.pending", out.pending);
    } else {
      log(`invest prune refused ${(tx && tx.reason) || "TX_FAILED"}`);
    }
    resumeDue(now).catch((err) => log(`invest resume rejected - ${messageOf(err)}`));
    return out;
  }

  return Object.freeze({ requestInTx, request, runSaga, resumeDue, pruneInTx, pass, iskText,
    stop() { stopped = true; } });
}

module.exports = { createInvest, backoffMs, iskText, LIMIT_REASONS };
