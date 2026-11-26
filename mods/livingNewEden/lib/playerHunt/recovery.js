"use strict";

const { QUIET_REASONS } = require("./repel");

const RESTART = "RESTART";

function recoverStale(store, repo, bootAt, limit) {
  let ended = 0;
  let failed = 0;
  let pages = 0;
  let lastError = null;
  let after = null;
  let repelApplied = 0;
  let repelRefused = 0;
  try {
    for (;;) {
      const r = store.transaction("playerHunt.recover", (db) => {
        const page = repo.listOpenInTx(db, { limit, afterHuntId: after });
        if (!page.ok) return page;
        let e = 0;
        let f = 0;
        let ra = 0;
        let rr = 0;
        let err = null;
        for (const hunt of page.hunts) {
          if (!(hunt.updatedAt < bootAt)) continue;
          const res = repo.endInTx(db, { huntId: hunt.huntId, at: bootAt, reason: RESTART });
          if (res.ok && !res.duplicate) {
            e += 1;
            if (res.repel && res.repel.applied === true) ra += 1;
            else if (res.repel && !QUIET_REASONS.includes(res.repel.reason)) rr += 1;
          } else if (!res.ok) {
            f += 1;
            err = `${hunt.huntId}: ${res.reason}`;
          }
        }
        return { ok: true, ended: e, failed: f, repelApplied: ra, repelRefused: rr, err, next: page.nextAfterHuntId };
      });
      if (!r.ok) {
        const detail = r.error ? String(r.error.message || r.error) : String(r.reason || "");
        return { ok: false, reason: r.reason || "TX_FAILED", detail, ended, failed, repelApplied, repelRefused };
      }
      const v = r.value;
      if (!v || v.ok !== true) {
        return { ok: false, reason: (v && v.reason) || "RECOVER_FAILED", ended, failed, repelApplied, repelRefused };
      }
      pages += 1;
      ended += v.ended;
      failed += v.failed;
      repelApplied += v.repelApplied;
      repelRefused += v.repelRefused;
      if (v.err) lastError = v.err;
      if (v.next === null) break;
      after = v.next;
    }
  } catch (err) {
    return { ok: false, reason: "RECOVER_THREW", detail: String((err && err.message) || err), ended, failed,
      repelApplied, repelRefused };
  }
  return { ok: true, ended, failed, pages, lastError, repelApplied, repelRefused };
}

module.exports = { recoverStale, RESTART };
