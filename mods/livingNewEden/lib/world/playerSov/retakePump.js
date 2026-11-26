"use strict";

const S = require("./schema");
const { createPoller, defaultSetTimer } = require("../../presence/poller");

const WORK_CLASS = "MAINTENANCE";
const MAX_DETAIL = 160;
const EVENT_LOST = "PLAYER_SOV_LOST";

const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

class Rollback {
  constructor(result) {
    this.result = result;
  }
}

function createRetakePump(deps) {
  const { store, clockRepo, ownerOnline, clock } = deps;
  const C = deps.config.playerSov;
  const bump = typeof deps.bump === "function" ? deps.bump : () => {};
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : null;
  const deferred = new Map();
  const logged = new Set();
  const inFlight = new Set();
  let poller = null;
  let stopped = false;
  let inPass = false;
  let lastPassAt = null;
  let lastError = null;

  function log(line) {
    if (logger) call(() => logger.log(line), null);
  }

  function admitted() {
    const governor = typeof deps.getGovernor === "function" ? call(deps.getGovernor, null) : null;
    if (!governor || typeof governor.admits !== "function") return true;
    return call(() => governor.admits(WORK_CLASS), true) !== false;
  }

  const repository = () => (typeof deps.getRepository === "function" ? call(deps.getRepository, null) : null);

  function fail(claim, reason, now) {
    bump("retakeFailed");
    deferred.set(claim.claimId, now + C.retakeRetryMs);
    lastError = `retake:${String(reason).slice(0, MAX_DETAIL)}`;
    if (!logged.has(claim.claimId)) {
      logged.add(claim.claimId);
      log(`playerSov: retake of ${claim.systemId} (${claim.claimId}) failed - ${String(reason).slice(0, MAX_DETAIL)}; `
        + `retry in ${C.retakeRetryMs} ms`);
    }
  }

  function writeLost(claim, reason, at) {
    const repo = repository();
    if (!repo) return { ok: false, reason: S.CODES.UNAVAILABLE };
    const r = store.transaction("playerSov.retake", (db) => {
      const got = repo.getById(db, claim.claimId);
      if (!got.ok) throw new Rollback(got);
      const c = got.claim;
      if (!c || c.state !== S.RETAKING) return { ok: true, stale: true };
      const t = deps.transitionInTx(db, c, { to: S.LOST, reason, at }, EVENT_LOST);
      if (!t.ok) {
        if (t.reason === S.CODES.VERSION_CONFLICT) return { ok: true, stale: true };
        throw new Rollback(t);
      }
      const rm = clockRepo.remove(db, c.claimId);
      if (!rm.ok) throw new Rollback(rm);
      return { ok: true, stale: false };
    });
    if (r.ok) return r.value;
    return r.error instanceof Rollback ? r.error.result : { ok: false, reason: r.reason || "TX_FAILED" };
  }

  function finish(claim, res) {
    const now = call(() => clock.now(), 0);
    const outcome = res && res.ok === true ? res.outcome : null;
    if (outcome !== "released" && outcome !== "alreadyGone" && outcome !== "ownerChanged") {
      fail(claim, (res && (res.reason || res.outcome)) || "no result", now);
      return;
    }
    const w = writeLost(claim, outcome === "ownerChanged" ? S.END_REASON.OWNER_CHANGED : S.END_REASON.RETAKEN, now);
    if (!w || w.ok !== true) {
      fail(claim, (w && w.reason) || "write failed", now);
      return;
    }
    deferred.delete(claim.claimId);
    logged.delete(claim.claimId);
    if (outcome === "released") bump("retakeReleased");
    else if (outcome === "alreadyGone") bump("retakeAlreadyGone");
    else bump("retakeOwnerChanged");
  }

  function release(claim) {
    inFlight.add(claim.claimId);
    const done = (res) => {
      try {
        finish(claim, res);
      } finally {
        inFlight.delete(claim.claimId);
      }
    };
    let p;
    try {
      p = deps.adapter && typeof deps.adapter.releasePlayerSov === "function"
        ? Promise.resolve(deps.adapter.releasePlayerSov(claim.systemId, { allianceId: claim.allianceId,
          hubItemId: claim.hubItemId }))
        : Promise.resolve({ ok: false, reason: "PLAYER_SOV_SEAM_UNAVAILABLE" });
    } catch (err) {
      p = Promise.resolve({ ok: false, reason: messageOf(err) });
    }
    return p.then(done, (err) => done({ ok: false, reason: messageOf(err) }));
  }

  function pruneClocks() {
    const r = call(() => store.transaction("playerSov.clockPrune", (db) => clockRepo.pruneOrphans(db,
      C.maxRetakesPerPass)), null);
    const v = r && r.ok ? r.value : null;
    if (v && v.ok === true) bump("clockPruned", v.pruned);
    else lastError = `prune:${String((v && v.reason) || (r && r.reason) || "no result").slice(0, MAX_DETAIL)}`;
  }

  function runPass() {
    const none = Promise.resolve();
    if (inPass || stopped) return { ok: false, reason: inPass ? "IN_PASS" : "STOPPED", settled: none };
    inPass = true;
    try {
      const now = clock.now();
      lastPassAt = now;
      if (!admitted()) return { ok: false, reason: "GOVERNOR_DEFERRED", settled: none };
      for (const [id, until] of deferred) if (until <= now) deferred.delete(id);
      const repo = repository();
      if (!repo) return { ok: false, reason: S.CODES.UNAVAILABLE, settled: none };
      const limit = C.maxRetakesPerPass + deferred.size + inFlight.size;
      const read = store.transaction("playerSov.retakeRead", (db) => repo.listByState(db, S.RETAKING, now, limit));
      const listed = read.ok ? read.value : read;
      const jobs = [];
      if (listed && listed.ok === true) {
        for (const claim of listed.claims) {
          if (jobs.length >= C.maxRetakesPerPass) break;
          if (deferred.has(claim.claimId) || inFlight.has(claim.claimId)) continue;
          const o = ownerOnline.ownerOnline(claim.corpId, now);
          if (!o || o.online !== true) {
            bump("retakeOwnerOffline");
            continue;
          }
          jobs.push(release(claim));
        }
      } else {
        lastError = `read:${String((listed && listed.reason) || "no result").slice(0, MAX_DETAIL)}`;
      }
      pruneClocks();
      return { ok: true, started: jobs.length, settled: Promise.all(jobs).then(() => undefined) };
    } catch (err) {
      lastError = `pass:${messageOf(err)}`;
      return { ok: false, reason: "PASS_FAILED", settled: none };
    } finally {
      inPass = false;
    }
  }

  function start() {
    if (stopped) return { ok: false, reason: "stopped" };
    poller = createPoller({ runPass, intervalMs: C.retakeRetryMs, now: () => clock.now(),
      setTimer: deps.setTimer || defaultSetTimer, onError: (err) => { lastError = `poller:${messageOf(err)}`; } });
    const res = poller.start();
    return res && res.ok ? { ok: true } : (res || { ok: false, reason: "POLLER_START_FAILED" });
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (poller) call(() => poller.stop(), null);
  }

  function getStatus() {
    return Object.freeze({ state: stopped ? "stopped" : "running", lastPassAt, lastError, deferred: deferred.size,
      inFlight: inFlight.size });
  }

  return Object.freeze({ start, stop, runPass, getStatus });
}

module.exports = { createRetakePump };
