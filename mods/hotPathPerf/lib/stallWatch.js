"use strict";

const path = require("path");

const PHASES = Object.freeze(["boot", "owners", "after_owners"]);
const HDR = Object.freeze({
  HEARTBEAT: 0, PHASE: 1, SEQ: 2, CRUMB_AT: 3, LABEL_LEN: 4, STALLS: 5, MAX_GAP: 6, SAMPLES: 7,
});
const HEADER_BYTES = 64;
const LABEL_BYTES = 128;
const LABEL_MAX_BYTES = 120;
const WORKER_FILE = path.join(__dirname, "stallWatch.worker.js");
const TERMINATE_AFTER_MS = 1000;

function shouldStart({ env, isMainThread, argv1, enabled } = {}) {
  if (enabled !== true) return { start: false, reason: "disabled" };
  if (isMainThread === false) return { start: false, reason: "not_main_thread" };
  if (/\.worker\.js$/i.test(String(argv1 || ""))) return { start: false, reason: "worker_process" };
  const role = String((env && env.EVEJS_GAMESTORE_OWNER_ROLE) || "").trim();
  if (role === "") return { start: false, reason: "no_role" };
  if (role !== "world") return { start: false, reason: `role:${role}` };
  return { start: true, reason: "world" };
}

function viewsOf(sab) {
  return { hdr: new Int32Array(sab, 0, HEADER_BYTES / 4), bytes: new Uint8Array(sab, HEADER_BYTES, LABEL_BYTES) };
}

function readBreadcrumb(sab) {
  const { hdr, bytes } = viewsOf(sab);
  const len = Math.min(LABEL_MAX_BYTES, Math.max(0, Atomics.load(hdr, HDR.LABEL_LEN)));
  const copy = new Uint8Array(len);
  copy.set(bytes.subarray(0, len));
  return {
    seq: Atomics.load(hdr, HDR.SEQ), atMs: Atomics.load(hdr, HDR.CRUMB_AT), label: new TextDecoder().decode(copy),
    phase: PHASES[Atomics.load(hdr, HDR.PHASE)] || "boot",
  };
}

function intOf(value, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function defaultCreateWorker(file, opts) {
  const { Worker } = require("worker_threads");
  return new Worker(file, opts);
}

function unrefOf(handle) {
  if (handle && typeof handle.unref === "function") handle.unref();
  return handle;
}

function startStallWatch(o = {}) {
  if (o.enabled === false) return { ok: false, reason: "disabled" };
  if (typeof SharedArrayBuffer !== "function" || typeof Atomics !== "object") {
    return { ok: false, reason: "no_worker_threads" };
  }
  const log = typeof o.log === "function" ? o.log : () => {};
  const now = typeof o.now === "function" ? o.now : Date.now;
  const setIntervalFn = typeof o.setInterval === "function" ? o.setInterval : setInterval;
  const clearIntervalFn = typeof o.clearInterval === "function" ? o.clearInterval : clearInterval;
  const setTimeoutFn = typeof o.setTimeout === "function" ? o.setTimeout : setTimeout;
  const clearTimeoutFn = typeof o.clearTimeout === "function" ? o.clearTimeout : clearTimeout;
  let createWorker = o.createWorker;
  if (typeof createWorker !== "function") {
    try {
      if (typeof require("worker_threads").Worker !== "function") return { ok: false, reason: "no_worker_threads" };
    } catch (_error) {
      return { ok: false, reason: "no_worker_threads" };
    }
    createWorker = defaultCreateWorker;
  }
  const heartbeatMs = Math.max(1, intOf(o.heartbeatMs, 250));
  const windowMs = intOf(o.windowMs, 0);

  const sab = new SharedArrayBuffer(HEADER_BYTES + LABEL_BYTES);
  const { hdr, bytes } = viewsOf(sab);
  const labelView = bytes.subarray(0, LABEL_MAX_BYTES);
  const encoder = new TextEncoder();
  const t0 = now();
  let stopped = false;
  let worker = null;
  let heartbeat = null;
  let windowTimer = null;

  function safeLog(line) {
    try {
      log(line);
    } catch (_error) {
    }
  }

  function beat() {
    Atomics.store(hdr, HDR.HEARTBEAT, now() - t0);
  }

  function stopHeartbeat() {
    if (heartbeat !== null) clearIntervalFn(heartbeat);
    heartbeat = null;
    if (windowTimer !== null) clearTimeoutFn(windowTimer);
    windowTimer = null;
  }

  beat();
  try {
    worker = createWorker(o.workerFile || WORKER_FILE, {
      workerData: {
        sab, t0,
        thresholdMs: intOf(o.thresholdMs, 5000),
        sampleEveryMs: intOf(o.sampleEveryMs, 20000),
        maxSamples: intOf(o.maxSamples, 40),
        frames: Math.max(1, intOf(o.frames, 12)),
        serverRoot: o.serverRoot ? String(o.serverRoot) : null,
        testExitInPause: o.testExitInPause === true,
      },
      execArgv: [],
      stdout: false,
      stderr: false,
      resourceLimits: { maxOldGenerationSizeMb: 32 },
    });
  } catch (error) {
    safeLog(`stallWatch: worker failed: ${error && error.message || error}`);
    return { ok: false, reason: "worker_failed" };
  }
  let exited = false;
  const onGone = (detail) => {
    if (exited) return;
    exited = true;
    stopHeartbeat();
    if (!stopped) safeLog(`stallWatch: worker exited ${detail}`);
    stopped = true;
  };
  try {
    if (typeof worker.on === "function") {
      worker.on("error", (error) => onGone(`code=error ${error && error.message || error}`));
      worker.on("exit", (code) => onGone(`code=${code}`));
    }
    if (typeof worker.unref === "function") worker.unref();
  } catch (_error) {
  }
  heartbeat = unrefOf(setIntervalFn(beat, heartbeatMs));

  const watch = {
    setPhase(p) {
      try {
        const index = PHASES.indexOf(p);
        if (index >= 0) Atomics.store(hdr, HDR.PHASE, index);
      } catch (_error) {
      }
    },
    breadcrumb(label) {
      try {
        const { written } = encoder.encodeInto(String(label), labelView);
        Atomics.store(hdr, HDR.LABEL_LEN, written);
        Atomics.store(hdr, HDR.CRUMB_AT, now() - t0);
        Atomics.add(hdr, HDR.SEQ, 1);
      } catch (_error) {
      }
    },
    stop(reason) {
      if (stopped) return;
      stopped = true;
      stopHeartbeat();
      try {
        worker.postMessage({ stop: true, reason: String(reason || "stop") });
      } catch (_error) {
      }
      unrefOf(setTimeoutFn(() => {
        try {
          if (typeof worker.terminate === "function") worker.terminate();
        } catch (_error) {
        }
      }, TERMINATE_AFTER_MS));
    },
    stats() {
      return {
        stalls: Atomics.load(hdr, HDR.STALLS), maxGapMs: Atomics.load(hdr, HDR.MAX_GAP),
        samples: Atomics.load(hdr, HDR.SAMPLES),
      };
    },
    running: () => !stopped,
    sab,
  };
  if (windowMs > 0) windowTimer = unrefOf(setTimeoutFn(() => {
    windowTimer = null;
    watch.stop("window");
  }, windowMs));
  return { ok: true, watch };
}

module.exports = {
  startStallWatch, shouldStart, readBreadcrumb, PHASES, HDR, HEADER_BYTES, LABEL_BYTES, LABEL_MAX_BYTES, WORKER_FILE,
};
