"use strict";

const RESTART = "RESTART";

function recoverStale(store, repo, bootAt, limit) {
  let ended = 0;
  let failed = 0;
  let pages = 0;
  let lastError = null;
  let after = null;
  try {
    for (;;) {
      const r = store.transaction("fleetExposure.recover", (db) => {
        const page = repo.listOpenInTx(db, { limit, afterExposureId: after });
        if (!page.ok) return page;
        let e = 0;
        let f = 0;
        let err = null;
        for (const exposure of page.exposures) {
          if (!(exposure.updatedAt < bootAt)) continue;
          const res = repo.endInTx(db, { exposureId: exposure.exposureId, at: bootAt, reason: RESTART });
          if (res.ok && !res.duplicate) e += 1;
          else if (!res.ok) {
            f += 1;
            err = `${exposure.exposureId}: ${res.reason}`;
          }
        }
        return { ok: true, ended: e, failed: f, err, next: page.nextAfterExposureId };
      });
      if (!r.ok) {
        const detail = r.error ? String(r.error.message || r.error) : String(r.reason || "");
        return { ok: false, reason: r.reason || "TX_FAILED", detail, ended, failed };
      }
      const v = r.value;
      if (!v || v.ok !== true) return { ok: false, reason: (v && v.reason) || "RECOVER_FAILED", ended, failed };
      pages += 1;
      ended += v.ended;
      failed += v.failed;
      if (v.err) lastError = v.err;
      if (v.next === null) break;
      after = v.next;
    }
  } catch (err) {
    return { ok: false, reason: "RECOVER_THREW", detail: String((err && err.message) || err), ended, failed };
  }
  return { ok: true, ended, failed, pages, lastError };
}

module.exports = { recoverStale, RESTART };
