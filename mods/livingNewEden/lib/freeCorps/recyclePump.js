"use strict";

const { createPoller } = require("../presence/poller");
const { createAbortSentinel } = require("../persistence/store");
const { backoffMs } = require("./recycle");
const { OUTBOX_KIND_JOIN, OUTBOX_KIND_CORP_CLOSE, OUTBOX_KIND_CEO_CLEAN, MEMBER_STATES: MS } = require("./schema");

const CLAIM_CONFLICT = createAbortSentinel("freeCorps.recycle.claimConflict");
const SETTLE_CONFLICT = createAbortSentinel("freeCorps.recycle.settleConflict");
const RECYCLE_PUMP_MODE = Object.freeze({ LIVE: "LIVE", DRAIN: "DRAIN" });
const PERMANENT = Object.freeze(["CHARACTER_MISSING", "TARGET_MISSING", "INVALID_INPUT"]);
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
const parse = (text) => safe(() => JSON.parse(text), null);
const must = (r, what) => {
  if (!r || r.ok !== true) {
    if (r && r.reason === "CAS_CONFLICT") return false;
    throw new Error(`${what}: ${(r && r.reason) || "no_result"}`);
  }
  return true;
};

function createRecyclePump(deps) {
  const { store, outbox, members, repo, clock, S } = deps;
  const R = deps.retention || { ventureRetentionMs: 0, pruneBatch: 0 };
  const nowMs = deps.nowMs;
  const bump = typeof deps.bump === "function" ? deps.bump : () => {};
  const metric = typeof deps.metric === "function" ? deps.metric : () => {};
  const log = typeof deps.log === "function" ? deps.log : () => {};
  const onWrite = typeof deps.onWrite === "function" ? deps.onWrite : () => {};
  const isRunning = typeof deps.isRunning === "function" ? deps.isRunning : () => true;
  const mode = deps.mode === RECYCLE_PUMP_MODE.DRAIN ? RECYCLE_PUMP_MODE.DRAIN : RECYCLE_PUMP_MODE.LIVE;
  let stopped = false;
  let running = false;
  let slowUntil = 0;
  let lastCallMs = null;
  let free = null;
  let joining = null;
  let seamOk = null;
  let poller = null;

  function claimTx(tx, now) {
    const out = { op: "idle", pruned: 0, pending: 0, row: null, payload: null, spec: null, wrote: false };
    if (R.pruneBatch > 0) {
      const pr = outbox.pruneInTx(tx, { before: Math.max(0, now - R.ventureRetentionMs), limit: R.pruneBatch });
      must(pr, "prune");
      out.pruned = pr.deleted;
    }
    const pj = outbox.countPendingInTx(tx, { kind: OUTBOX_KIND_JOIN });
    must(pj, "count join");
    const pc = outbox.countPendingInTx(tx, { kind: OUTBOX_KIND_CORP_CLOSE });
    must(pc, "count close");
    const pe = outbox.countPendingInTx(tx, { kind: OUTBOX_KIND_CEO_CLEAN });
    must(pe, "count ceo clean");
    out.pending = pj.count + pc.count + pe.count;
    out.joins = pj.count;
    const cf = members.countFreeInTx(tx);
    must(cf, "count free");
    out.free = cf.count;
    const lj = outbox.lastAttemptAtInTx(tx, { kind: OUTBOX_KIND_JOIN });
    must(lj, "last join");
    const lc = outbox.lastAttemptAtInTx(tx, { kind: OUTBOX_KIND_CORP_CLOSE });
    must(lc, "last close");
    const le = outbox.lastAttemptAtInTx(tx, { kind: OUTBOX_KIND_CEO_CLEAN });
    must(le, "last ceo clean");
    const last = Math.max(lj.at === null ? -1 : lj.at, lc.at === null ? -1 : lc.at, le.at === null ? -1 : le.at);
    if (last >= 0 && now < last + S.joinSpacingMs) {
      out.op = "wait";
      return out;
    }
    const dj = outbox.nextDueInTx(tx, { kind: OUTBOX_KIND_JOIN, now });
    must(dj, "next join");
    const dc = outbox.nextDueInTx(tx, { kind: OUTBOX_KIND_CORP_CLOSE, now });
    must(dc, "next close");
    const de = outbox.nextDueInTx(tx, { kind: OUTBOX_KIND_CEO_CLEAN, now });
    must(de, "next ceo clean");
    let row = null;
    for (const r of [dj.row, dc.row, de.row]) if (r && (!row || r.next_at < row.next_at)) row = r;
    if (!row) return out;
    const payload = parse(row.payload);
    if (row.kind === OUTBOX_KIND_CEO_CLEAN) {
      const fail = (error, op) => {
        if (!must(outbox.failInTx(tx, { key: row.key, expectedVersion: row.version, now, error }), op)) {
          throw CLAIM_CONFLICT;
        }
        out.op = "ceoCleanRefused";
        out.wrote = true;
        return out;
      };
      if (!payload || !Number.isSafeInteger(payload.corpId) || payload.corpId <= 0
        || !Number.isSafeInteger(payload.characterId) || payload.characterId <= 0
        || !Number.isSafeInteger(payload.fromCorporationId) || payload.fromCorporationId < 0) {
        return fail("INVALID_INPUT", "ceo clean payload");
      }
      const t = repo.getInTx(tx, payload.corpId);
      must(t, "ceo clean target");
      if (!t.row || t.row.open === 0) return fail("TARGET_CLOSED", "ceo clean closed");
      if (t.row.corporation_id === null) return fail("TARGET_PENDING", "ceo clean pending");
      out.spec = { characterId: payload.characterId, toCorporationId: t.row.corporation_id,
        fromHint: payload.fromCorporationId, cleanSource: true };
    }
    if (row.kind === OUTBOX_KIND_JOIN) {
      const m = payload ? members.getInTx(tx, payload.characterId) : { ok: true, row: null };
      must(m, "member");
      const mr = m.row;
      if (!payload || !mr || mr.state !== MS.JOINING || mr.moves !== payload.seq || mr.corp_id !== payload.corpId) {
        if (!must(outbox.failInTx(tx, { key: row.key, expectedVersion: row.version, now, error: "SUPERSEDED" }),
          "superseded")) throw CLAIM_CONFLICT;
        out.op = "superseded";
        out.wrote = true;
        return out;
      }
      const t = repo.getInTx(tx, payload.corpId);
      must(t, "target");
      if (t.row && t.row.open === 0) {
        if (!must(outbox.failInTx(tx, { key: row.key, expectedVersion: row.version, now, error: "TARGET_CLOSED" }),
          "target closed")) throw CLAIM_CONFLICT;
        if (!must(members.moveInTx(tx, { characterId: mr.character_id, expectedVersion: mr.version, corpId: null,
          state: MS.FREE, now, moves: mr.moves }), "target closed member")) throw CLAIM_CONFLICT;
        out.op = "targetClosed";
        out.wrote = true;
        return out;
      }
      if (t.row && t.row.corporation_id === null) {
        if (!must(outbox.retryInTx(tx, { key: row.key, expectedVersion: row.version, nextAt: now + S.targetWaitMs,
          error: "TARGET_PENDING" }), "target wait")) throw CLAIM_CONFLICT;
        out.op = "targetWait";
        out.wrote = true;
        return out;
      }
      out.spec = { characterId: payload.characterId, toCorporationId: t.row ? t.row.corporation_id : 0,
        fromHint: mr.vendor_corporation_id, cleanSource: S.cleanSourceRoster === true };
    }
    const cl = outbox.claimInTx(tx, { key: row.key, expectedVersion: row.version, now });
    if (!must(cl, "claim")) throw CLAIM_CONFLICT;
    out.op = "call";
    out.wrote = true;
    out.payload = payload;
    out.row = { ...row, version: cl.version, attempts: row.attempts + 1, attempted_at: now };
    return out;
  }

  function call(v) {
    if (v.row.kind === OUTBOX_KIND_CEO_CLEAN) {
      const r = safe(() => deps.moveFreeCharacter(v.spec), { ok: false, reason: "ADAPTER_THROW" });
      return r && typeof r === "object" ? r : { ok: false, reason: "NO_RESULT" };
    }
    if (v.row.kind === OUTBOX_KIND_JOIN) {
      if (!(v.spec.toCorporationId > 0)) return { ok: false, reason: "TARGET_MISSING" };
      const r = safe(() => deps.moveFreeCharacter(v.spec), { ok: false, reason: "ADAPTER_THROW" });
      return r && typeof r === "object" ? r : { ok: false, reason: "NO_RESULT" };
    }
    const p = v.payload;
    if (!p || !Number.isSafeInteger(p.corporationId) || typeof p.description !== "string") {
      return { ok: false, reason: "INVALID_INPUT", detail: "payload" };
    }
    const r = safe(() => deps.setCorporationDescription(p.corporationId, p.description),
      { ok: false, reason: "ADAPTER_THROW" });
    return r && typeof r === "object" ? r : { ok: false, reason: "NO_RESULT" };
  }

  function settleTx(tx, v, r, now) {
    const row = v.row;
    const join = row.kind === OUTBOX_KIND_JOIN;
    const key = { key: row.key, expectedVersion: row.version, now };
    if (r && r.ok === true) {
      const resultId = join || row.kind === OUTBOX_KIND_CEO_CLEAN ? v.spec.toCorporationId : v.payload.corporationId;
      if (!must(outbox.completeInTx(tx, { ...key, resultId }), "complete")) throw SETTLE_CONFLICT;
      if (join) {
        const m = members.getInTx(tx, v.spec.characterId);
        must(m, "member");
        const mr = m.row;
        if (mr && mr.state === MS.JOINING && mr.moves === v.payload.seq) {
          if (!must(members.settleInTx(tx, { characterId: mr.character_id, expectedVersion: mr.version,
            state: MS.MEMBER, vendorCorporationId: resultId, now }), "member settle")) throw SETTLE_CONFLICT;
        } else if (mr && mr.vendor_corporation_id !== resultId) {
          if (!must(members.noteVendorCorporationInTx(tx, { characterId: mr.character_id, expectedVersion: mr.version,
            vendorCorporationId: resultId, now }), "member vendor")) throw SETTLE_CONFLICT;
        }
      }
      return "done";
    }
    const error = `${(r && r.reason) || "NO_RESULT"}${r && r.detail ? ` ${r.detail}` : ""}`;
    if ((r && PERMANENT.includes(r.reason)) || row.attempts >= S.maxAttempts) {
      if (!must(outbox.failInTx(tx, { ...key, error }), "fail")) throw SETTLE_CONFLICT;
      if (join) {
        const m = members.getInTx(tx, v.spec.characterId);
        must(m, "member");
        const mr = m.row;
        if (mr && mr.state === MS.JOINING && mr.moves === v.payload.seq) {
          if (!must(members.settleInTx(tx, { characterId: mr.character_id, expectedVersion: mr.version, state: MS.LOST,
            now }), "member lost")) throw SETTLE_CONFLICT;
          must(repo.adjustRecruitedInTx(tx, { corpId: v.payload.corpId, delta: -1, at: now }), "recruited");
        }
      }
      return "failed";
    }
    if (!must(outbox.retryInTx(tx, { key: row.key, expectedVersion: row.version,
      nextAt: now + backoffMs(row.attempts, S), error }), "retry")) throw SETTLE_CONFLICT;
    return "retry";
  }

  function runNow() {
    if (stopped || safe(isRunning, false) !== true) return { ok: true, ran: false, reason: "NOT_RUNNING" };
    if (running) return { ok: true, ran: false, reason: "BUSY" };
    const governor = safe(() => deps.getGovernor(), null);
    if (governor && typeof governor.admits === "function"
      && safe(() => governor.admits(deps.workClass), true) === false) {
      bump("rcDeferred");
      return { ok: true, ran: false, reason: "DEFERRED" };
    }
    const seam = safe(() => deps.freeCorpRecycleSeams(), null);
    seamOk = Boolean(seam && seam.ok === true);
    if (!seamOk) {
      bump("rcSeamUnavailable");
      return { ok: true, ran: false, reason: "SEAM_UNAVAILABLE" };
    }
    const now = clock.now();
    if (now < slowUntil) {
      bump("rcSlowPaused");
      return { ok: true, ran: false, reason: "SLOW_PAUSED" };
    }
    running = true;
    try {
      const c = store.transaction("freeCorps.recycle.claim", (tx) => claimTx(tx, now));
      if (!c || c.ok !== true) {
        if (c && c.error === CLAIM_CONFLICT) bump("rcClaimConflict");
        else log(`recycle claim failed - ${(c && c.reason) || "TX_FAILED"}${c && c.error ? ` ${detailOf(c.error)}` : ""}`);
        return { ok: false, reason: "CLAIM_FAILED" };
      }
      const v = c.value;
      if (v.pruned > 0 || v.wrote) onWrite();
      free = v.free;
      joining = v.joins;
      metric("gauge", "freeCorps.membersFree", v.free);
      metric("gauge", "freeCorps.joinsPending", v.joins);
      if (v.op === "wait") {
        bump("rcSpacing");
        return { ok: true, ran: false, reason: "SPACING" };
      }
      if (v.op === "superseded") {
        bump("rcJoinSuperseded");
        return { ok: true, ran: true, outcome: "superseded" };
      }
      if (v.op === "targetClosed") {
        bump("rcJoinTargetClosed");
        return { ok: true, ran: true, outcome: "targetClosed" };
      }
      if (v.op === "targetWait") {
        bump("rcJoinTargetWait");
        return { ok: true, ran: true, outcome: "targetWait" };
      }
      if (v.op === "ceoCleanRefused") {
        bump("rcCeoCleanFailed");
        return { ok: true, ran: true, outcome: "failed" };
      }
      if (v.op !== "call") {
        if (mode === RECYCLE_PUMP_MODE.DRAIN && v.pending === 0 && poller) {
          poller.stop();
          log("recycle drain done - pump stopped");
        }
        return { ok: true, ran: false, reason: "IDLE" };
      }
      const join = v.row.kind === OUTBOX_KIND_JOIN;
      const ceoClean = v.row.kind === OUTBOX_KIND_CEO_CLEAN;
      const t0 = nowMs();
      const r = call(v);
      const ms = nowMs() - t0;
      if (!ceoClean) bump(join ? "rcJoinCalls" : "rcCloseCalls");
      lastCallMs = Math.round(ms * MS_DECIMALS) / MS_DECIMALS;
      metric("observe", "freeCorps.joinCallMs", lastCallMs);
      if (ms > S.slowCallMs) {
        slowUntil = now + S.slowPauseMs;
        bump("rcSlowPause");
        log(`recycle call slow (${lastCallMs} ms > ${S.slowCallMs} ms) - pump paused until ${slowUntil}`);
      }
      const s = store.transaction("freeCorps.recycle.settle", (tx) => settleTx(tx, v, r, now));
      if (!s || s.ok !== true) {
        if (s && s.error === SETTLE_CONFLICT) bump("rcSettleConflict");
        else log(`recycle settle failed - ${(s && s.reason) || "TX_FAILED"}${s && s.error ? ` ${detailOf(s.error)}` : ""}`);
        return { ok: false, reason: "SETTLE_FAILED", call: r };
      }
      onWrite();
      if (ceoClean) {
        if (s.value === "done") bump("rcCeoCleanDone");
        else if (s.value === "failed") bump("rcCeoCleanFailed");
      } else if (join) {
        if (s.value === "done") {
          bump("rcJoinDone");
          if (r.already === true) bump("rcJoinAlready");
          if (r.cleaned === true) bump("rcJoinCleaned");
        } else if (s.value === "failed") {
          bump("rcJoinFailed");
        } else {
          bump("rcJoinRetry");
        }
      } else if (s.value === "done") {
        bump("rcCloseDone");
      } else if (s.value === "failed") {
        bump("rcCloseFailed");
      }
      return { ok: true, ran: true, outcome: s.value, key: v.row.key, call: r };
    } catch (err) {
      log(`recycle pump failed - ${detailOf(err)}`);
      return { ok: false, reason: "PUMP_FAILED" };
    } finally {
      running = false;
    }
  }

  poller = createPoller({ runPass: () => { runNow(); }, intervalMs: S.pumpMs, now: () => clock.now(),
    setTimer: deps.setTimer, onError: (err) => log(`recycle pump timer - ${detailOf(err)}`) });

  return Object.freeze({
    start: () => poller.start(),
    stop: () => {
      stopped = true;
      poller.stop();
    },
    runNow,
    status: () => Object.freeze({ mode, seam: seamOk === false ? "UNAVAILABLE" : "OK", free, joining, lastCallMs,
      slowUntil: slowUntil > 0 ? slowUntil : null }),
  });
}

module.exports = { createRecyclePump, RECYCLE_PUMP_MODE };
