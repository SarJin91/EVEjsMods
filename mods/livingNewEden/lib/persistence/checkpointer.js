"use strict";

const STATE = Object.freeze({ IDLE: "idle", RUNNING: "running", ARMED: "armed", STOPPED: "stopped" });
const REASONS = Object.freeze(["force", "target", "interval"]);
const COUNT_NAMES = Object.freeze([...REASONS, "busy", "failed"]);
const DEFERRING_MODES = Object.freeze(["SHED", "OVERLOADED"]);
const STORE_REASONS = Object.freeze(["STORE_SUSPENDED", "STORE_CLOSED"]);
const STORE_STATE_REASON = Object.freeze({ suspended: "STORE_SUSPENDED", closed: "STORE_CLOSED" });
const MAINTENANCE = "MAINTENANCE";

function noop() {}

function messageOf(err) {
  return String((err && err.message) || err);
}

function defaultSetTimer(fn, ms) {
  const handle = setTimeout(fn, ms);
  if (handle && typeof handle.unref === "function") handle.unref();
  return {
    cancel: () => clearTimeout(handle),
    hasRef: () => Boolean(handle && typeof handle.hasRef === "function" && handle.hasRef()),
  };
}

function defaultSetImmediate(fn) {
  setImmediate(fn);
}

function decideCheckpoint(wal, gov, nowMs, s) {
  if (!wal || !s) return null;
  const frames = Number(wal.estimatedFrames) || 0;
  if (frames >= s.checkpointForceFrames) return "force";
  if (s.checkpointSlowMs > 0 && typeof wal.backoffUntilMs === "number" && nowMs < wal.backoffUntilMs) return null;
  if (gov && DEFERRING_MODES.includes(gov.mode)) return null;
  if (frames >= s.checkpointTargetFrames && (!gov || gov.maintenanceAdmitted === true)) return "target";
  const last = wal.lastCheckpointAtMs;
  if (wal.rowsSinceCheckpoint > 0 && typeof last === "number" && nowMs - last >= s.checkpointMaxIntervalMs) {
    return "interval";
  }
  return null;
}

function createCheckpointer(deps) {
  const { store, settings } = deps;
  const nowMs = deps.nowMs;
  const setTimer = typeof deps.setTimer === "function" ? deps.setTimer : defaultSetTimer;
  const setImmediateFn = typeof deps.setImmediateFn === "function" ? deps.setImmediateFn : defaultSetImmediate;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log: noop };
  const metrics = deps.metrics || {};
  const counts = Object.fromEntries(COUNT_NAMES.map((name) => [name, 0]));
  const loggedReasons = new Set();
  let state = STATE.IDLE;
  let timer = null;
  let tickSub = null;
  let armed = null;
  let armedAtMs = null;
  let immediatePending = false;
  let inFlight = false;
  let lastResult = null;
  let startedAtMs = null;
  let backoffUntilMs = null;
  let backoffs = 0;

  function metric(kind, name, value) {
    if (typeof metrics[kind] !== "function") return;
    try {
      metrics[kind](name, value);
    } catch (_err) {
    }
  }

  function logOnce(reason, line) {
    if (loggedReasons.has(reason)) return;
    loggedReasons.add(reason);
    logger.log(line);
  }

  function governorView() {
    try {
      const gov = typeof deps.getGovernor === "function" ? deps.getGovernor() : null;
      if (!gov || typeof gov.evaluate !== "function") return null;
      const policy = gov.evaluate();
      if (!policy || typeof policy.mode !== "string") return null;
      const entry = policy.classes && policy.classes[MAINTENANCE];
      return { mode: policy.mode, maintenanceAdmitted: Boolean(entry && entry.admitted === true) };
    } catch (_err) {
      return null;
    }
  }

  function cancelTimer() {
    if (timer === null) return;
    const handle = timer;
    timer = null;
    try {
      handle.cancel();
    } catch (_err) {
    }
  }

  function schedule(ms) {
    cancelTimer();
    if (state === STATE.STOPPED || state === STATE.IDLE) return;
    try {
      timer = setTimer(fire, ms);
    } catch (err) {
      timer = null;
      stop(`TIMER_FAILED (${messageOf(err)})`);
    }
  }

  function storeRefusal() {
    try {
      const st = typeof store.getState === "function" ? store.getState() : "open";
      return STORE_STATE_REASON[st] || null;
    } catch (_err) {
      return null;
    }
  }

  function runOnce(reason) {
    if (inFlight) return { ok: false, reason: "CHECKPOINT_IN_FLIGHT" };
    inFlight = true;
    let r;
    try {
      r = store.checkpoint(reason);
    } catch (err) {
      r = { ok: false, reason: "CHECKPOINT_FAILED", detail: messageOf(err) };
    } finally {
      inFlight = false;
    }
    if (!r || typeof r !== "object") r = { ok: false, reason: "CHECKPOINT_FAILED", detail: "no result" };
    lastResult = Object.freeze({ ...r, why: String(reason) });
    if (r.ok) {
      if (REASONS.includes(reason)) {
        counts[reason] += 1;
        metric("count", `persistence.checkpoints.${reason}`, 1);
      }
      if (r.busy) {
        counts.busy += 1;
        metric("count", "persistence.checkpoints.busy", 1);
      }
      if (settings.checkpointSlowMs > 0 && typeof r.ms === "number" && r.ms >= settings.checkpointSlowMs) {
        backoffUntilMs = nowMs() + settings.checkpointSlowBackoffMs;
        backoffs += 1;
        metric("count", "persistence.checkpoints.backoff", 1);
      }
    } else {
      counts.failed += 1;
      metric("count", "persistence.checkpoints.failed", 1);
      logOnce(r.reason, `persistence: checkpoint failed - ${r.reason}${r.detail ? ` (${r.detail})` : ""}`);
      if (STORE_REASONS.includes(r.reason)) stop(r.reason);
    }
    return r;
  }

  function publish(wal, now) {
    metric("gauge", "persistence.walEstimatedFrames", Number(wal.estimatedFrames) || 0);
    if (wal.perTx && typeof wal.perTx === "object") {
      metric("gauge", "persistence.walPerTx.calibrated", wal.perTx.calibrated === true ? 1 : 0);
      metric("gauge", "persistence.walPerTx.frameBytes", Number(wal.perTx.frameBytes) || 0);
    }
    const last = typeof wal.lastCheckpointAtMs === "number" ? wal.lastCheckpointAtMs : startedAtMs;
    if (typeof last === "number") metric("gauge", "persistence.checkpointAgeMs", Math.max(0, now - last));
  }

  function runArmed() {
    const reason = armed;
    armed = null;
    armedAtMs = null;
    if (state === STATE.ARMED) state = STATE.RUNNING;
    if (reason === null || state === STATE.STOPPED) return;
    const refusal = storeRefusal();
    if (refusal) {
      stop(refusal);
      return;
    }
    runOnce(reason);
    if (state !== STATE.STOPPED) schedule(settings.checkpointPollMs);
  }

  function poll() {
    const refusal = storeRefusal();
    if (refusal) {
      stop(refusal);
      return;
    }
    let wal;
    try {
      wal = store.getWalStatus();
    } catch (err) {
      logOnce("WAL_STATUS_FAILED", `persistence: checkpoint status failed - ${messageOf(err)}`);
      schedule(settings.checkpointPollMs);
      return;
    }
    const now = nowMs();
    publish(wal, now);
    const view = { ...wal, lastCheckpointAtMs: typeof wal.lastCheckpointAtMs === "number" ? wal.lastCheckpointAtMs
      : startedAtMs, backoffUntilMs };
    const decision = decideCheckpoint(view, governorView(), now, settings);
    if (decision === null) {
      schedule(settings.checkpointPollMs);
      return;
    }
    if (settings.checkpointAlignToTick === true && tickSub !== null) {
      armed = decision;
      armedAtMs = now;
      state = STATE.ARMED;
      schedule(settings.checkpointAlignWaitMs);
      return;
    }
    armed = decision;
    runArmed();
  }

  function fire() {
    timer = null;
    if (state === STATE.STOPPED || state === STATE.IDLE) return;
    try {
      if (state === STATE.ARMED) runArmed();
      else poll();
    } catch (err) {
      logOnce("POLL_THREW", `persistence: checkpoint poll failed - ${messageOf(err)}`);
      if (state !== STATE.STOPPED) schedule(settings.checkpointPollMs);
    }
  }

  function onTick() {
    if (armed === null || immediatePending || state !== STATE.ARMED) return;
    immediatePending = true;
    setImmediateFn(() => {
      immediatePending = false;
      try {
        if (state === STATE.ARMED) runArmed();
      } catch (err) {
        logOnce("TICK_RUN_THREW", `persistence: checkpoint failed - ${messageOf(err)}`);
      }
    });
  }

  function start() {
    if (state === STATE.STOPPED) return { ok: false, reason: "CHECKPOINTER_STOPPED" };
    if (state !== STATE.IDLE) return { ok: false, reason: "already_started" };
    startedAtMs = nowMs();
    if (settings.checkpointAlignToTick === true && typeof deps.addTickListener === "function") {
      try {
        const sub = deps.addTickListener(onTick);
        tickSub = sub && sub.ok ? sub : null;
      } catch (_err) {
        tickSub = null;
      }
    }
    state = STATE.RUNNING;
    schedule(settings.checkpointPollMs);
    return { ok: true };
  }

  function stop(why) {
    if (state === STATE.STOPPED) return;
    const wasActive = state !== STATE.IDLE;
    state = STATE.STOPPED;
    armed = null;
    armedAtMs = null;
    cancelTimer();
    if (tickSub !== null && typeof tickSub.remove === "function") {
      try {
        tickSub.remove();
      } catch (_err) {
      }
    }
    tickSub = null;
    if (wasActive && why !== undefined) logger.log(`persistence: checkpointer stopped - ${why}`);
  }

  function getStatus() {
    return Object.freeze({ state, armed, armedAtMs, aligned: tickSub !== null, lastResult,
      counts: Object.freeze({ ...counts }), backoffUntilMs, backoffs });
  }

  return Object.freeze({ start, stop, runOnce, getStatus });
}

module.exports = { createCheckpointer, decideCheckpoint, defaultSetTimer, CHECKPOINTER_STATE: STATE,
  CHECKPOINT_REASONS: REASONS };
