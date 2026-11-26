"use strict";

function detailOf(err) {
  return String((err && err.message) || err);
}

function codeOf(err) {
  return err && typeof err.code === "string" ? err.code : undefined;
}

function runPacedBackup(handle, o) {
  return new Promise((resolve) => {
    let closed = false;
    let done = false;
    const close = () => {
      if (closed) return;
      closed = true;
      try {
        handle.close();
      } catch (_err) {
      }
    };
    const finish = (result) => {
      if (done) return;
      done = true;
      close();
      resolve(result);
    };
    const failed = (err, detail) => {
      const code = codeOf(err);
      finish({ ok: false, reason: "BACKUP_FAILED", ...(code ? { code } : {}),
        detail: detail === undefined ? detailOf(err) : detail, paced: true });
    };
    if (!handle || typeof handle.transfer !== "function" || typeof handle.close !== "function" || !o) {
      if (handle && typeof handle.close === "function") close();
      resolve({ ok: false, reason: "BACKUP_FAILED", detail: "invalid arguments", paced: true });
      return;
    }
    const shouldAbort = typeof o.shouldAbort === "function" ? o.shouldAbort : () => null;
    const shouldPause = typeof o.shouldPause === "function" ? o.shouldPause : () => false;
    const { minPagesPerStep: minPages, maxPagesPerStep: maxPages, stepTargetMs, stepGapMs, governorPauseMs,
      maxPauseMs } = o;
    const startedAt = o.nowMs();
    let pages = Math.max(minPages, Math.min(maxPages, o.pagesPerStep));
    let steps = 0;
    let maxStepMs = 0;
    let maxGapMs = 0;
    let lastEndAt = null;
    let pauses = 0;
    let pausedMs = 0;
    let minPagesUsed = null;

    const arm = (ms) => {
      try {
        o.setTimer(step, ms);
      } catch (err) {
        failed(err, `timer: ${detailOf(err)}`);
      }
    };

    function step() {
      if (done) return;
      try {
        const code = shouldAbort();
        if (code !== null && code !== undefined) {
          finish({ ok: false, reason: "BACKUP_ABORTED", code: String(code), paced: true });
          return;
        }
        if (shouldPause() === true) {
          if (pausedMs + governorPauseMs > maxPauseMs) {
            finish({ ok: false, reason: "BACKUP_ABORTED", code: "GOVERNOR", paced: true });
            return;
          }
          pauses += 1;
          pausedMs += governorPauseMs;
          arm(governorPauseMs);
          return;
        }
      } catch (err) {
        failed(err);
        return;
      }
      const used = pages;
      const t = o.nowMs();
      let r;
      try {
        r = handle.transfer(used);
      } catch (err) {
        failed(err);
        return;
      }
      const end = o.nowMs();
      const d = end - t;
      steps += 1;
      maxStepMs = Math.max(maxStepMs, d);
      if (lastEndAt !== null) maxGapMs = Math.max(maxGapMs, end - lastEndAt);
      lastEndAt = end;
      minPagesUsed = minPagesUsed === null ? used : Math.min(minPagesUsed, used);
      const remaining = r ? Number(r.remainingPages) : NaN;
      if (!Number.isFinite(remaining)) {
        failed(null, "transfer returned no progress");
        return;
      }
      if (remaining <= 0) {
        finish({ ok: true, totalPages: Number(r.totalPages) || 0, ms: o.nowMs() - startedAt, steps, maxGapMs,
          finalStepMs: d, maxStepMs, pauses, pausedMs, minPagesUsed, paced: true });
        return;
      }
      if (d > stepTargetMs) pages = Math.max(minPages, Math.floor(pages / 2));
      else if (d < stepTargetMs / 2) pages = Math.min(maxPages, pages * 2);
      arm(stepGapMs);
    }

    arm(0);
  });
}

module.exports = { runPacedBackup };
