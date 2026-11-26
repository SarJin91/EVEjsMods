"use strict";

const S = require("./schema");
const { planMirror } = require("./mirror");
const { journalEdgeInTx, EVENT: SIEGE_EVENT } = require("./siege");
const { createPoller, defaultSetTimer } = require("../../presence/poller");

const WORK_CLASS = "MAINTENANCE";
const FULL_EVERY_PASSES = 10;
const MAX_DETAIL = 160;

const COUNTER_NAMES = Object.freeze(["passes", "skippedUnchanged", "inserted", "promoted", "rebased", "ended",
  "ownerChanged", "duplicates", "autoCaptured", "autoCaptureRefused", "scanOverBudget", "readFailed", "txFailed",
  "pruned"]);

const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function createPlayerSovService(deps) {
  const { store, repository, adapter, virtualCorps, clock } = deps;
  const C = deps.config.playerSov;
  const chunkRows = deps.chunkRows;
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  let poller = null;
  let stopped = false;
  let inPass = false;
  let vcState = "pending";
  let lastStamp;
  let stampKnown = false;
  let lastFullAt = null;
  let dirty = true;
  let live = null;
  let lastPassAt = null;
  let idleReason = null;
  let lastError = null;
  let budgetLogged = false;
  const inFlight = new Set();
  const deferredCaptures = new Map();

  try {
    if (virtualCorps && typeof virtualCorps.whenReady === "function") {
      Promise.resolve(virtualCorps.whenReady()).then(() => { vcState = "ready"; }, () => { vcState = "failed"; });
    } else {
      vcState = "failed";
    }
  } catch (_err) {
    vcState = "failed";
  }

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  }

  function bump(name, n = 1) {
    if (!(n > 0) || !Object.prototype.hasOwnProperty.call(counters, name)) return;
    counters[name] += n;
    metric("count", `world.playerSov.${name}`, n);
  }

  function log(line) {
    if (logger) call(() => logger.log(line), null);
  }

  function noteRefusal(where, reason) {
    lastError = `${where}:${String(reason).slice(0, MAX_DETAIL)}`;
  }

  function admitted() {
    const governor = typeof deps.getGovernor === "function" ? call(deps.getGovernor, null) : null;
    if (!governor || typeof governor.admits !== "function") return true;
    return call(() => governor.admits(WORK_CLASS), true) !== false;
  }

  const isVirtualAlliance = (allianceId) => call(() => virtualCorps.isVirtualAlliance(allianceId) === true, false);

  function readMarker() {
    const r = call(() => adapter.readSovereigntyTableUpdatedAt(), null);
    return r && r.ok === true ? { ok: true, value: r.updatedAt ?? null } : { ok: false };
  }

  function refreshLive() {
    const r = call(() => store.transaction("playerSov.live", (db) => repository.countLive(db)), null);
    const v = r && r.ok ? r.value : null;
    if (v && v.ok) {
      live = v.live;
      metric("gauge", S.LIVE_GAUGE, live);
    }
  }

  function applyAction(db, a) {
    if (a.kind === S.ACTION.INSERT) {
      const r = repository.insertClaim(db, { systemId: a.systemId, allianceId: a.allianceId, corpId: a.corpId,
        hubItemId: a.hubItemId, origin: S.ORIGIN.MIRROR, state: a.state, at: a.at });
      if (r.ok) return "inserted";
      if (r.reason === S.CODES.DUPLICATE) return "duplicates";
      noteRefusal("insert", r.reason);
      return null;
    }
    const read = repository.getById(db, a.claimId);
    const claim = read.ok ? read.claim : null;
    if (!claim || !S.LIVE_STATES.includes(claim.state)) {
      if (!read.ok) noteRefusal("read", read.reason);
      return null;
    }
    let r;
    if (a.kind === S.ACTION.PROMOTE) r = repository.transition(db, { claim, to: S.HELD, at: a.at });
    else if (a.kind === S.ACTION.SET_BASE) r = repository.setBase(db, claim, a.baseState, a.at);
    else r = repository.transition(db, { claim, to: S.LOST, reason: a.reason, at: a.at });
    if (!r.ok) {
      if (r.reason !== S.CODES.VERSION_CONFLICT) noteRefusal(a.kind, r.reason);
      return null;
    }
    if (a.kind === S.ACTION.END && claim.state === S.RETAKING && deps.journal) {
      const j = journalEdgeInTx(deps.journal, db, claim, r.claim, SIEGE_EVENT.LOST, C.reinforceMs);
      if (!j.ok) throw new Error(`journal ${j.reason}`);
    }
    if (a.kind === S.ACTION.PROMOTE) return "promoted";
    if (a.kind === S.ACTION.SET_BASE) return "rebased";
    return a.reason === S.END_REASON.OWNER_CHANGED ? "endedOwnerChanged" : "ended";
  }

  function applyPlan(actions) {
    let complete = actions.length <= C.maxRowsPerPass;
    const todo = actions.slice(0, C.maxRowsPerPass);
    for (let i = 0; i < todo.length; i += chunkRows) {
      const chunk = todo.slice(i, i + chunkRows);
      const tx = store.transaction("playerSov.mirror", (db) => {
        const tally = { inserted: 0, promoted: 0, rebased: 0, ended: 0, endedOwnerChanged: 0, duplicates: 0, stale: 0 };
        for (const a of chunk) {
          const key = applyAction(db, a);
          if (key === null) tally.stale += 1;
          else tally[key] += 1;
        }
        return tally;
      });
      if (!tx.ok || !tx.value) {
        bump("txFailed");
        noteRefusal("tx", tx.reason || "no value");
        return false;
      }
      const t = tx.value;
      bump("inserted", t.inserted);
      bump("promoted", t.promoted);
      bump("rebased", t.rebased);
      bump("ended", t.ended + t.endedOwnerChanged);
      bump("ownerChanged", t.endedOwnerChanged);
      bump("duplicates", t.duplicates);
      if (t.stale > 0) complete = false;
    }
    return complete;
  }

  function mirrorPass(now, marker) {
    const t0 = nowMs();
    const read = call(() => adapter.readPlayerSov({ isVirtualAlliance }), null);
    const scanMs = Math.max(0, nowMs() - t0);
    metric("observe", S.SCAN_HISTOGRAM, scanMs);
    if (scanMs > C.scanBudgetMs) {
      bump("scanOverBudget");
      if (!budgetLogged) {
        budgetLogged = true;
        log(`playerSov: vendor scan ${Math.round(scanMs)} ms > playerSov.scanBudgetMs ${C.scanBudgetMs} (logged once)`);
      }
    }
    if (!read || read.ok !== true || !Array.isArray(read.rows)) {
      bump("readFailed");
      noteRefusal("readPlayerSov", (read && (read.detail || read.reason)) || "no result");
      return { ok: false, reason: "READ_FAILED" };
    }
    const liveTx = store.transaction("playerSov.readLive", (db) => repository.listLive(db));
    const liveRead = liveTx.ok ? liveTx.value : null;
    if (!liveRead || liveRead.ok !== true) {
      bump("txFailed");
      noteRefusal("listLive", (liveRead && liveRead.reason) || liveTx.reason || "no value");
      return { ok: false, reason: "TX_FAILED" };
    }
    const liveRows = new Map(liveRead.claims.map((c) => [c.systemId, c]));
    const complete = applyPlan(planMirror(read.rows, liveRows, now));
    const prune = store.transaction("playerSov.prune",
      (db) => repository.pruneTerminal(db, Math.max(0, now - C.retentionMs), chunkRows));
    if (prune.ok && prune.value && prune.value.ok) bump("pruned", prune.value.pruned);
    if (complete) {
      lastStamp = marker.ok ? marker.value : undefined;
      stampKnown = marker.ok;
      lastFullAt = now;
      dirty = false;
    } else {
      dirty = true;
    }
    return { ok: true };
  }

  function autoCapture(now) {
    if (!(C.autoCaptureMs > 0)) return;
    for (const [id, until] of deferredCaptures) if (until <= now) deferredCaptures.delete(id);
    const limit = Math.min(C.maxRetakesPerPass + deferredCaptures.size, C.maxRowsPerPass);
    const tx = store.transaction("playerSov.autoCapture",
      (db) => repository.listByState(db, S.CAPTURING, Math.max(0, now - C.autoCaptureMs), limit));
    const r = tx.ok ? tx.value : null;
    if (!r || r.ok !== true) return;
    const picked = r.claims.filter((c) => !deferredCaptures.has(c.claimId)).slice(0, C.maxRetakesPerPass);
    for (const claim of picked) {
      if (inFlight.has(claim.systemId)) continue;
      inFlight.add(claim.systemId);
      const done = (res) => {
        inFlight.delete(claim.systemId);
        if (res && res.ok === true && res.outcome === "captured") {
          dirty = true;
          bump("autoCaptured");
        } else {
          deferredCaptures.set(claim.claimId, call(() => clock.now(), now) + C.retakeRetryMs);
          bump("autoCaptureRefused");
          noteRefusal("autoCapture", (res && (res.outcome || res.reason)) || "no result");
        }
      };
      try {
        Promise.resolve(adapter.capturePlayerSov(claim.systemId, { allianceId: claim.allianceId, corpId: claim.corpId,
          hubItemId: claim.hubItemId })).then(done, (err) => done({ ok: false, reason: messageOf(err) }));
      } catch (err) {
        done({ ok: false, reason: messageOf(err) });
      }
    }
  }

  function runPass() {
    if (inPass || stopped) return { ok: false, reason: inPass ? "IN_PASS" : "STOPPED" };
    inPass = true;
    try {
      bump("passes");
      const now = clock.now();
      lastPassAt = now;
      if (!admitted()) {
        idleReason = "GOVERNOR_DEFERRED";
        return { ok: false, reason: idleReason };
      }
      if (vcState !== "ready") {
        idleReason = vcState === "pending" ? "VCORPS_PENDING" : "VCORPS_FAILED";
        return { ok: false, reason: idleReason };
      }
      idleReason = null;
      const marker = readMarker();
      const full = dirty || lastFullAt === null || now >= lastFullAt + FULL_EVERY_PASSES * C.reconcileMs
        || !marker.ok || !stampKnown || marker.value !== lastStamp;
      let result = { ok: true, skipped: true };
      if (full) result = mirrorPass(now, marker);
      else bump("skippedUnchanged");
      autoCapture(now);
      refreshLive();
      return result;
    } catch (err) {
      noteRefusal("pass", messageOf(err));
      dirty = true;
      return { ok: false, reason: "PASS_FAILED" };
    } finally {
      inPass = false;
    }
  }

  function start() {
    if (stopped) return { ok: false, reason: "stopped" };
    poller = createPoller({ runPass, intervalMs: C.reconcileMs, now: () => clock.now(),
      setTimer: deps.setTimer || defaultSetTimer, onError: (err) => noteRefusal("poller", messageOf(err)) });
    const res = poller.start();
    if (!res || !res.ok) return res || { ok: false, reason: "POLLER_START_FAILED" };
    refreshLive();
    return { ok: true };
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (poller) call(() => poller.stop(), null);
  }

  function getStatus() {
    return Object.freeze({ state: stopped ? "stopped" : (idleReason ? "idle" : "running"), enabled: true,
      reason: stopped ? "stopped" : idleReason, live, lastPassAt, lastFullAt, chunkRows, lastError,
      counters: Object.freeze({ ...counters }) });
  }

  return Object.freeze({ start, stop, getStatus, runPass, refreshLive, isStopped: () => stopped });
}

module.exports = { createPlayerSovService, COUNTER_NAMES, FULL_EVERY_PASSES };
