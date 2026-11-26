"use strict";

const path = require("node:path");
const { performance } = require("node:perf_hooks");

const STATE = Object.freeze({ IDLE: "idle", RUNNING: "running", STOPPED: "stopped" });
const UNKNOWN_LABEL = "poller:unknown";
const MAX_LABEL_CHARS = 80;
const slashed = (p) => p.replace(/\\/g, "/");
const SELF_FILE = slashed(__filename);
const LIB_ROOT = `${slashed(path.resolve(__dirname, ".."))}/`;
const MOD_ROOT = `${slashed(path.resolve(__dirname, "..", ".."))}/`;
const FRAME_RE = /\(?([^\s()]+?):(\d+):\d+\)?\s*$/;

let hooks = null;

function noop() {}

function installPollerHooks(h) {
  hooks = h && typeof h === "object" ? h : null;
}

function getPollerHooks() {
  return hooks;
}

function labelFromStack(stack) {
  if (typeof stack !== "string") return UNKNOWN_LABEL;
  const lines = stack.split("\n");
  for (let i = 1; i < lines.length; i += 1) {
    const m = FRAME_RE.exec(lines[i]);
    if (!m) continue;
    const file = slashed(m[1]);
    if (file === SELF_FILE || file.startsWith("node:")) continue;
    let rel;
    if (file.startsWith(LIB_ROOT)) rel = file.slice(LIB_ROOT.length);
    else if (file.startsWith(MOD_ROOT)) rel = file.slice(MOD_ROOT.length);
    else rel = file.slice(file.lastIndexOf("/") + 1);
    return `${rel}:${m[2]}`.slice(0, MAX_LABEL_CHARS);
  }
  return UNKNOWN_LABEL;
}

function labelOf(deps) {
  if (typeof deps.label === "string" && deps.label !== "") return deps.label.slice(0, MAX_LABEL_CHARS);
  try {
    return labelFromStack(new Error().stack);
  } catch (_err) {
    return UNKNOWN_LABEL;
  }
}

function defaultSetTimer(fn, ms) {
  const handle = setTimeout(fn, ms);
  if (handle && typeof handle.unref === "function") handle.unref();
  return {
    cancel: () => clearTimeout(handle),
    hasRef: () => Boolean(handle && typeof handle.hasRef === "function" && handle.hasRef()),
  };
}

function createPoller(deps) {
  const label = labelOf(deps);
  const runPass = deps.runPass;
  const intervalMs = deps.intervalMs;
  const now = deps.now;
  const setTimer = typeof deps.setTimer === "function" ? deps.setTimer : defaultSetTimer;
  const onError = typeof deps.onError === "function" ? deps.onError : noop;
  const pacing = deps.pacing !== false;
  let state = STATE.IDLE;
  let timer = null;
  let dueAt = 0;
  let inPass = false;
  let rerunAt = null;
  let passes = 0;

  function cancelTimer() {
    if (timer === null) return;
    const handle = timer;
    timer = null;
    try {
      handle.cancel();
    } catch (_err) {
    }
  }

  function arm(ms) {
    if (state !== STATE.RUNNING) return;
    const delay = Math.max(0, Number.isFinite(ms) ? ms : intervalMs);
    const at = now() + delay;
    if (inPass) {
      if (rerunAt === null || at < rerunAt) rerunAt = at;
      return;
    }
    if (timer !== null && dueAt <= at) return;
    cancelTimer();
    try {
      timer = setTimer(fire, delay);
      dueAt = at;
    } catch (err) {
      timer = null;
      onError(err);
    }
  }

  function fire() {
    timer = null;
    if (state !== STATE.RUNNING) return;
    const h = hooks;
    const metered = h !== null && typeof h.meter === "function";
    const t0 = metered ? performance.now() : 0;
    inPass = true;
    rerunAt = null;
    try {
      runPass();
    } catch (err) {
      onError(err);
    } finally {
      inPass = false;
      passes += 1;
      if (metered) {
        try {
          h.meter(label, performance.now() - t0);
        } catch (_err) {
        }
      }
    }
    const pending = rerunAt;
    rerunAt = null;
    arm(pending === null ? pacedInterval(h) : Math.max(0, pending - now()));
  }

  function pacedInterval(h) {
    if (h === null || !h.pacer || typeof h.pacer.delayFor !== "function") return intervalMs;
    try {
      const ms = h.pacer.delayFor(label, intervalMs, pacing);
      return Number.isFinite(ms) && ms >= intervalMs ? ms : intervalMs;
    } catch (_err) {
      return intervalMs;
    }
  }

  function start() {
    if (state !== STATE.IDLE) return { ok: false, reason: state === STATE.STOPPED ? "stopped" : "already_started" };
    state = STATE.RUNNING;
    arm(intervalMs);
    return { ok: true };
  }

  function stop() {
    if (state === STATE.STOPPED) return;
    state = STATE.STOPPED;
    cancelTimer();
    const h = hooks;
    if (h !== null && h.pacer && typeof h.pacer.release === "function") {
      try {
        h.pacer.release(label);
      } catch (_err) {
      }
    }
  }

  return Object.freeze({ start, stop, arm, getState: () => state, getPasses: () => passes,
    isArmed: () => timer !== null, getLabel: () => label });
}

module.exports = { createPoller, defaultSetTimer, installPollerHooks, getPollerHooks, labelFromStack,
  POLLER_STATE: STATE, UNKNOWN_POLLER_LABEL: UNKNOWN_LABEL };
