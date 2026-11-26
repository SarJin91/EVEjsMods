// Adaptation of X-Eve xEveRuntime._armTimer (see CREDITS.md).

"use strict";

const STATE = Object.freeze({ IDLE: "idle", RUNNING: "running", SUSPENDED: "suspended", STOPPED: "stopped" });

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

function createDriver(deps) {
  const runPass = deps.runPass;
  const intervalMs = deps.intervalMs;
  const setTimer = typeof deps.setTimer === "function" ? deps.setTimer : defaultSetTimer;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log: noop };
  const onState = typeof deps.onState === "function" ? deps.onState : noop;
  let state = STATE.IDLE;
  let reason = null;
  let timer = null;
  let passes = 0;
  let skipped = 0;
  let lastPass = null;

  function setState(next, why) {
    state = next;
    reason = why === undefined ? null : why;
    try {
      onState(next);
    } catch (_err) {
    }
  }

  function arm() {
    if (state !== STATE.RUNNING || timer !== null) return;
    try {
      timer = setTimer(fire, intervalMs);
    } catch (err) {
      timer = null;
      setState(STATE.SUSPENDED, "TIMER_FAILED");
      logger.log(`scheduler: passes suspended - TIMER_FAILED (${messageOf(err)})`);
    }
  }

  function finished(result) {
    lastPass = result && typeof result === "object" ? result : { ok: false, reason: "PASS_THREW" };
    if (lastPass.skipped === true) skipped += 1;
    else passes += 1;
    arm();
  }

  function fire() {
    timer = null;
    if (state !== STATE.RUNNING) return;
    let pending;
    try {
      pending = Promise.resolve(runPass());
    } catch (err) {
      pending = Promise.resolve({ ok: false, reason: "PASS_THREW", detail: messageOf(err) });
    }
    pending
      .then(finished, (err) => finished({ ok: false, reason: "PASS_THREW", detail: messageOf(err) }))
      .catch(noop);
  }

  function start() {
    if (state === STATE.STOPPED) return { ok: false, reason: "SCHEDULER_STOPPED" };
    if (state !== STATE.IDLE) return { ok: false, reason: "already_started" };
    setState(STATE.RUNNING);
    arm();
    return { ok: true };
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

  function stop(why) {
    if (state === STATE.STOPPED) return;
    const wasActive = state === STATE.RUNNING || state === STATE.SUSPENDED;
    cancelTimer();
    setState(STATE.STOPPED, why === undefined ? "stopped" : String(why));
    if (wasActive) logger.log(`scheduler: passes stopped - ${reason}`);
  }

  function suspend(why, detail) {
    if (state === STATE.STOPPED || state === STATE.SUSPENDED) return;
    cancelTimer();
    setState(STATE.SUSPENDED, String(why));
    logger.log(`scheduler: passes suspended - ${reason}${detail ? ` (${detail})` : ""}`);
  }

  function getStatus() {
    return Object.freeze({ state, reason, intervalMs, passes, skipped, lastPass });
  }

  return Object.freeze({ start, stop, suspend, getState: () => state, getStatus });
}

module.exports = { createDriver, defaultSetTimer, DRIVER_STATE: STATE };
