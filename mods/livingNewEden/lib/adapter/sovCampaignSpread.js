"use strict";

const FNV_OFFSET_BASIS = 2166136261;
const FNV_PRIME = 16777619;
const CAMPAIGN_TICK_JOB_TYPE = "sovereignty.campaign-tick";
const OWNED_HUB_EPOCH = /^owned-hub:(\d+):(\d+):/;
const WRAPPED_CAMPAIGN_SPREAD = Symbol.for("livingNewEden.sovCampaignSpread");
const COUNTER_NAMES = Object.freeze(["SPREAD", "ZERO", "NOT_CAMPAIGN", "NOT_WINDOW", "NO_SYSTEM",
  "CLAIM_UNAVAILABLE", "NOT_LNE", "failed", "RETRY_SPREAD", "RETRY_SKIPPED", "RETRY_FAILED",
  "PROVISIONAL", "RETRY_KEPT", "RETRY_RESTORED"]);
const RETRYABLE = new Set(["CLAIM_UNAVAILABLE", "NOT_LNE"]);

function fnv1a32(text) {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

function spreadOffsetMs(targetID, spreadMs) {
  const span = Math.trunc(Number(spreadMs));
  if (!Number.isSafeInteger(span) || span <= 0) return 0;
  return fnv1a32(String(targetID)) % span;
}

function same(job, reason) {
  return { job, spread: false, reason };
}

function spreadCampaignJob(job, deps) {
  if (!job || typeof job !== "object" || job.type !== CAMPAIGN_TICK_JOB_TYPE) return same(job, "NOT_CAMPAIGN");
  const payload = job.payload && typeof job.payload === "object" ? job.payload : null;
  if (!payload || !Number.isFinite(payload.windowEventMs) || !Number.isFinite(job.dueAtMs)) {
    return same(job, "NOT_WINDOW");
  }
  const match = typeof payload.captureEpoch === "string" ? OWNED_HUB_EPOCH.exec(payload.captureEpoch) : null;
  if (!match) return same(job, "NO_SYSTEM");
  const systemID = Number(match[1]);
  let allianceID;
  try {
    allianceID = deps.allianceOfSystem(systemID);
  } catch (_err) {
    return same(job, "CLAIM_UNAVAILABLE");
  }
  if (!Number.isSafeInteger(allianceID) || allianceID <= 0) return same(job, "CLAIM_UNAVAILABLE");
  if (deps.isVirtualAlliance(allianceID) !== true) return same(job, "NOT_LNE");
  const offset = spreadOffsetMs(payload.targetID, deps.spreadMs);
  if (offset === 0) return same(job, "ZERO");
  return { job: { ...job, dueAtMs: job.dueAtMs + offset }, spread: true, reason: "SPREAD" };
}

function noteOutcome(deps, reason) {
  if (typeof deps.onOutcome !== "function") return;
  try {
    deps.onOutcome(reason);
  } catch (_err) {
  }
}

function makeProxy(scheduler, deps, pending, provisional) {
  const proxy = Object.create(scheduler);
  Object.defineProperty(proxy, "schedule", { value: scheduleSpread, writable: false, enumerable: true, configurable: false });
  function scheduleSpread(job, ...rest) {
    let out = job;
    let reason = "failed";
    try {
      const decision = spreadCampaignJob(job, deps);
      out = decision.job;
      reason = decision.reason;
    } catch (_err) {
      out = job;
    }
    let provisionalDueAtMs = null;
    if (provisional && RETRYABLE.has(reason) && pending.isRecording()) {
      const offset = spreadOffsetMs(job.payload.targetID, deps.spreadMs);
      if (offset > 0) provisionalDueAtMs = job.dueAtMs + offset;
    }
    const stored = pending.note(scheduler, job, reason, provisionalDueAtMs);
    if (stored && provisionalDueAtMs !== null) {
      out = { ...job, dueAtMs: provisionalDueAtMs };
      reason = "PROVISIONAL";
    }
    noteOutcome(deps, reason);
    return scheduler.schedule(out, ...rest);
  }
  return proxy;
}

function createPending(max) {
  const limit = Number.isSafeInteger(max) && max > 0 ? max : 0;
  const entries = new Map();
  let recording = limit > 0;
  return {
    note(scheduler, job, reason, provisionalDueAtMs) {
      if (!job || typeof job !== "object" || typeof job.jobID !== "string") return false;
      if (!recording || !RETRYABLE.has(reason)) {
        entries.delete(job.jobID);
        return false;
      }
      if (!entries.has(job.jobID) && entries.size >= limit) return false;
      const entry = { scheduler, job };
      if (Number.isFinite(provisionalDueAtMs)) entry.provisionalDueAtMs = provisionalDueAtMs;
      entries.set(job.jobID, entry);
      return true;
    },
    isRecording: () => recording,
    stopRecording() {
      recording = false;
    },
    take(count) {
      const out = [];
      for (const [jobID, entry] of entries) {
        if (out.length >= count) break;
        entries.delete(jobID);
        out.push(entry);
      }
      return out;
    },
    size: () => entries.size,
    clear() {
      recording = false;
      entries.clear();
    },
  };
}

function drainPending(pending, deps, nowMs, limit, marginMs) {
  pending.stopRecording();
  const count = Number.isSafeInteger(limit) && limit > 0 ? limit : 0;
  const margin = Number.isSafeInteger(marginMs) && marginMs > 0 ? marginMs : 0;
  const writes = [];
  const write = (scheduler, job) => writes.push(Promise.resolve()
    .then(() => scheduler.schedule(job))
    .then(() => undefined, () => noteOutcome(deps, "RETRY_FAILED")));
  let spread = 0;
  let skipped = 0;
  let kept = 0;
  let restored = 0;
  for (const { scheduler, job, provisionalDueAtMs } of pending.take(count)) {
    if (provisionalDueAtMs !== undefined) {
      if (!(provisionalDueAtMs > nowMs + margin)) {
        skipped += 1;
        noteOutcome(deps, "RETRY_SKIPPED");
        continue;
      }
      let decision = null;
      try {
        decision = spreadCampaignJob(job, deps);
      } catch (_err) {
        decision = null;
      }
      if (decision && decision.spread === true && decision.job.dueAtMs === provisionalDueAtMs) {
        kept += 1;
        noteOutcome(deps, "RETRY_KEPT");
      } else if (decision && decision.spread === true) {
        spread += 1;
        noteOutcome(deps, "RETRY_SPREAD");
        write(scheduler, decision.job);
      } else {
        restored += 1;
        noteOutcome(deps, "RETRY_RESTORED");
        write(scheduler, job);
      }
      continue;
    }
    let decision = null;
    try {
      decision = Number.isFinite(job.dueAtMs) && job.dueAtMs > nowMs + margin ? spreadCampaignJob(job, deps) : null;
    } catch (_err) {
      decision = null;
    }
    if (!decision || decision.spread !== true) {
      skipped += 1;
      noteOutcome(deps, "RETRY_SKIPPED");
      continue;
    }
    spread += 1;
    noteOutcome(deps, "RETRY_SPREAD");
    write(scheduler, decision.job);
  }
  return { ok: true, spread, skipped, kept, restored, remaining: pending.size(),
    settled: Promise.all(writes).then(() => undefined) };
}

function restorePending(pending, deps, limit) {
  pending.stopRecording();
  const count = Number.isSafeInteger(limit) && limit > 0 ? limit : 0;
  const writes = [];
  let restored = 0;
  for (const { scheduler, job, provisionalDueAtMs } of pending.take(count)) {
    if (provisionalDueAtMs === undefined) continue;
    restored += 1;
    noteOutcome(deps, "RETRY_RESTORED");
    writes.push(Promise.resolve()
      .then(() => scheduler.schedule(job))
      .then(() => undefined, () => noteOutcome(deps, "RETRY_FAILED")));
  }
  return { ok: true, restored, remaining: pending.size(), settled: Promise.all(writes).then(() => undefined) };
}

function wrapCampaignBinding(exports, deps) {
  if (!exports || typeof exports.bindDurableScheduler !== "function") return { ok: false, reason: "BIND_NOT_A_FUNCTION" };
  if (typeof exports.unbindDurableScheduler !== "function") return { ok: false, reason: "UNBIND_NOT_A_FUNCTION" };
  if (!deps || typeof deps !== "object" || !Number.isFinite(deps.spreadMs)
    || typeof deps.allianceOfSystem !== "function" || typeof deps.isVirtualAlliance !== "function") {
    return { ok: false, reason: "DEPS_INVALID" };
  }
  if (exports[WRAPPED_CAMPAIGN_SPREAD] === true) return { ok: true, noop: true };
  const originalBind = exports.bindDurableScheduler;
  const originalUnbind = exports.unbindDurableScheduler;
  const proxies = new WeakMap();
  const retryMax = Math.trunc(Number(deps.retryMax));
  const pending = createPending(retryMax);
  const provisional = deps.provisional === true && Number.isSafeInteger(retryMax) && retryMax > 0;

  exports.bindDurableScheduler = function bindDurableSchedulerSpread(...args) {
    const scheduler = args[0];
    if (scheduler && typeof scheduler === "object" && typeof scheduler.schedule === "function") {
      let proxy = proxies.get(scheduler);
      if (!proxy) {
        try {
          proxy = makeProxy(scheduler, deps, pending, provisional);
          proxies.set(scheduler, proxy);
        } catch (_err) {
          proxy = null;
          noteOutcome(deps, "failed");
        }
      }
      if (proxy) args[0] = proxy;
    }
    return originalBind.apply(this, args);
  };
  exports.unbindDurableScheduler = function unbindDurableSchedulerSpread(...args) {
    const scheduler = args[0];
    if (scheduler && typeof scheduler === "object" && proxies.has(scheduler)) args[0] = proxies.get(scheduler);
    return originalUnbind.apply(this, args);
  };
  Object.defineProperty(exports, WRAPPED_CAMPAIGN_SPREAD, { value: true, enumerable: false });
  return {
    ok: true,
    retry: {
      size: () => pending.size(),
      drain: (nowMs, limit, marginMs) => drainPending(pending, deps, nowMs, limit, marginMs),
      restore: (limit) => restorePending(pending, deps, limit),
      clear: () => pending.clear(),
    },
  };
}

async function runCampaignRetry(retry, opts) {
  if (typeof opts.wait !== "function") {
    return { ok: false, reason: "FAILED", restored: await restoreAll(retry, opts, null) };
  }
  const wait = opts.wait;
  try {
    await opts.whenReady();
  } catch (_err) {
    return { ok: false, reason: "NOT_READY", restored: await restoreAll(retry, opts, wait) };
  }
  const totals = { ok: true, spread: 0, skipped: 0, kept: 0, restored: 0, slices: 0 };
  try {
    while (retry.size() > 0) {
      if (typeof opts.isStopped === "function" && opts.isStopped()) {
        retry.clear();
        return { ok: false, reason: "STOPPED", restored: totals.restored };
      }
      const slice = retry.drain(opts.nowMs(), opts.batch, opts.delayMs);
      totals.slices += 1;
      totals.spread += slice.spread;
      totals.skipped += slice.skipped;
      totals.kept += slice.kept || 0;
      totals.restored += slice.restored || 0;
      await slice.settled;
      if (slice.remaining > 0) await wait(opts.delayMs);
    }
    retry.drain(opts.nowMs(), 0);
    return totals;
  } catch (_err) {
    return { ok: false, reason: "FAILED", restored: totals.restored + await restoreAll(retry, opts, wait) };
  }
}

async function restoreAll(retry, opts, wait) {
  let restored = 0;
  try {
    if (typeof retry.restore !== "function") {
      retry.clear();
      return 0;
    }
    const batch = Number.isSafeInteger(opts.batch) && opts.batch > 0 ? opts.batch : 1;
    while (retry.size() > 0) {
      if (typeof opts.isStopped === "function" && opts.isStopped()) break;
      const slice = retry.restore(batch);
      restored += slice.restored;
      await slice.settled;
      if (slice.remaining > 0 && wait) await wait(opts.delayMs);
    }
    retry.clear();
  } catch (_err) {
    try {
      retry.clear();
    } catch (_ignored) {
    }
  }
  return restored;
}

module.exports = {
  runCampaignRetry,
  spreadOffsetMs,
  spreadCampaignJob,
  wrapCampaignBinding,
  WRAPPED_CAMPAIGN_SPREAD,
  COUNTER_NAMES,
  CAMPAIGN_TICK_JOB_TYPE,
};
