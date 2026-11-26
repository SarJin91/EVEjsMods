"use strict";

const TOPIC = "scheduler.due";
const VENDOR_LEASE_MS = 30000;
const MAX_TYPES = 16;
const MAX_TYPE_LENGTH = 160;
const TIMELINE_MAX_DEFAULT = 64;
const TIMELINE_TOP = 12;
const TYPE_MAP_MAX = 4096;
const LABEL_MAX = 60;

function parseGateTypes(raw) {
  const types = [];
  const dropped = [];
  for (const part of String(raw == null ? "" : raw).split(",")) {
    const type = part.trim();
    if (type === "") continue;
    if (type.includes("*") || type.length > MAX_TYPE_LENGTH || types.length >= MAX_TYPES) {
      dropped.push(type);
      continue;
    }
    if (!types.includes(type)) types.push(type);
  }
  return { types, dropped };
}

function intOf(value, fallback) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function defaultSetTimer(fn, ms) {
  const handle = setTimeout(fn, ms);
  if (handle && typeof handle.unref === "function") handle.unref();
  return handle;
}

function defaultClearTimer(handle) {
  clearTimeout(handle);
}

function createSchedulerDueGate(o = {}) {
  const types = new Set(Array.isArray(o.types) ? o.types.map(String) : []);
  const releaseDelayMs = intOf(o.releaseDelayMs, 30000);
  const maxHoldMs = Math.max(1, intOf(o.maxHoldMs, 300000));
  const pumpIntervalMs = Math.max(1, intOf(o.pumpIntervalMs, 100));
  const batch = Math.max(1, intOf(o.batch, 8));
  const maxInFlight = Math.max(1, intOf(o.maxInFlight, 2));
  const minLeaseLeftMs = intOf(o.minLeaseLeftMs, 10000);
  const staleDropMs = intOf(o.staleDropMs, 120000);
  const maxHeld = Math.max(1, intOf(o.maxHeld, 100000));
  const unseenReleaseMs = Math.max(1, intOf(o.unseenReleaseMs, 10000));
  const now = typeof o.now === "function" ? o.now : Date.now;
  const setTimer = typeof o.setTimer === "function" ? o.setTimer : defaultSetTimer;
  const clearTimer = typeof o.clearTimer === "function" ? o.clearTimer : defaultClearTimer;
  const log = typeof o.log === "function" ? o.log : () => {};
  const onPhase = typeof o.onPhase === "function" ? o.onPhase : null;
  const onBreadcrumb = typeof o.onBreadcrumb === "function" ? o.onBreadcrumb : null;
  const slowCallMs = intOf(o.slowCallMs, 0);
  const timelineMax = Math.max(1, intOf(o.timelineMax, TIMELINE_MAX_DEFAULT));
  const typeByJobID = new Map();
  const timeline = new Map();
  let currentPhase = "boot";
  let startPending = false;
  let startAt = 0;
  let timelineCalls = 0;

  let mode = "idle";
  let inCapture = false;
  let captureUsed = false;
  let captured = false;
  let firstCaptureAt = null;
  let openedAt = null;
  let original = null;
  let holdTimer = null;
  let pumpTimer = null;
  let pumpStarted = false;
  let pumping = false;
  const held = new Map();
  const inFlight = new Map();
  const counters = { heldTotal: 0, replaced: 0, released: 0, staleDropped: 0, overflow: 0, inFlightExpired: 0 };
  let openedReason = null;
  let openedAfterMs = null;

  function safeLog(line) {
    try {
      log(line);
    } catch (_error) {
    }
  }

  function deliver(fn, event) {
    try {
      fn(event);
    } catch (error) {
      safeLog(`scheduler due gate: onEvent error: ${error && error.message || error}`);
    }
  }

  function crumb(label) {
    if (onBreadcrumb === null) return;
    try {
      onBreadcrumb(label);
    } catch (_error) {
    }
  }

  function setPhase(p) {
    currentPhase = p;
    if (onPhase === null) return;
    try {
      onPhase(p);
    } catch (_error) {
    }
  }

  function rememberType(jobID, type) {
    if (typeByJobID.size >= TYPE_MAP_MAX && !typeByJobID.has(jobID)) typeByJobID.clear();
    typeByJobID.set(jobID, type);
  }

  function labelOf(command, payload) {
    let label = "";
    if (payload && typeof payload === "object") {
      if (typeof payload.type === "string") label = payload.type;
      else if (payload.jobID != null) {
        const id = String(payload.jobID);
        label = typeByJobID.get(id) || id.split(":")[0];
      }
    }
    if (label === "") label = String(command);
    return label.length > LABEL_MAX ? label.slice(0, LABEL_MAX) : label;
  }

  function beginOwners() {
    setPhase("owners");
    startPending = true;
    startAt = now();
    timeline.clear();
    timelineCalls = 0;
  }

  function endOwners() {
    if (!startPending) return;
    setPhase("after_owners");
    startPending = false;
    const sec = (ms) => (ms / 1000).toFixed(1);
    const top = [...timeline.entries()]
      .sort((a, b) => (b[1].lastMs - b[1].firstMs) - (a[1].lastMs - a[1].firstMs))
      .slice(0, TIMELINE_TOP)
      .map(([key, e]) => `${key}=${e.n}@${sec(e.firstMs)}-${sec(e.lastMs)}s rt${e.maxRtMs}ms`);
    safeLog(`scheduler owners: timeline startMs=${now() - startAt} calls=${timelineCalls} top: ${top.join(", ")}`);
    timeline.clear();
  }

  function observe(command, label, payload, promise) {
    if (onBreadcrumb === null && slowCallMs === 0 && !startPending) return;
    const cmd = String(command);
    if (label === null) label = labelOf(cmd, payload);
    const t = now();
    let entry = null;
    if (startPending) {
      timelineCalls += 1;
      let key = `${cmd}:${label}`;
      if (!timeline.has(key) && timeline.size >= timelineMax) key = "other";
      entry = timeline.get(key);
      if (entry === undefined) {
        entry = { n: 0, firstMs: t - startAt, lastMs: t - startAt, maxRtMs: 0 };
        timeline.set(key, entry);
      }
      entry.n += 1;
      entry.lastMs = t - startAt;
    }
    if (!promise || typeof promise.then !== "function") return;
    const settled = () => {
      try {
        crumb(`reply:${cmd}:${label}`);
        const rt = now() - t;
        if (entry !== null && rt > entry.maxRtMs) entry.maxRtMs = rt;
        if (slowCallMs > 0 && rt >= slowCallMs) {
          safeLog(`scheduler owners: slow call cmd=${cmd} label=${label} rtMs=${rt} phase=${currentPhase}`);
        }
      } catch (_error) {
      }
    };
    promise.then(settled, settled);
  }

  function stopTimers() {
    if (holdTimer !== null) clearTimer(holdTimer);
    if (pumpTimer !== null) clearTimer(pumpTimer);
    holdTimer = null;
    pumpTimer = null;
  }

  function capture(fn) {
    if (captureUsed) return fn();
    captureUsed = true;
    if (firstCaptureAt === null) firstCaptureAt = now();
    inCapture = true;
    try {
      return fn();
    } finally {
      inCapture = false;
      if (!captured && mode === "idle") {
        mode = "passthrough";
        safeLog("DRIFT: scheduler due gate: createProductionSchedulerRuntime did not create the scheduler client through the " +
          "wrapped createOrderedProcessClient — due gate inactive (vendor dispatch)");
      }
    }
  }

  function capturing() {
    return inCapture && !captured;
  }

  function armHoldTimer() {
    if (holdTimer !== null || mode !== "holding") return;
    holdTimer = setTimer(() => {
      holdTimer = null;
      open("max_hold");
    }, maxHoldMs);
  }

  function armPump(ms) {
    if (pumpTimer !== null || mode !== "open") return;
    pumpTimer = setTimer(() => {
      pumpTimer = null;
      pumpStarted = true;
      try {
        pumpStep();
      } catch (error) {
        safeLog(`scheduler due gate: pump error: ${error && error.message || error}`);
      }
      armPump(pumpIntervalMs);
    }, ms);
  }

  function goPassthrough() {
    mode = "passthrough";
    stopTimers();
    const drainMs = openedAt === null ? 0 : now() - openedAt;
    const openedAfter = openedAfterMs === null ? "?" : `${Math.round(openedAfterMs / 1000)}s`;
    safeLog(`scheduler due gate: drained released=${counters.released} replaced=${counters.replaced}` +
      ` staleDropped=${counters.staleDropped} overflow=${counters.overflow} openedAfter=${openedAfter} drainMs=${drainMs}`);
  }

  function pumpStep() {
    if (mode !== "open" || pumping) return;
    pumping = true;
    try {
      pumpOnce();
    } finally {
      pumping = false;
    }
    if (mode === "open" && held.size === 0 && inFlight.size === 0) goPassthrough();
  }

  function pumpOnce() {
    const t = now();
    for (const [jobID, entry] of inFlight) {
      if (t - entry.at > (entry.seen ? VENDOR_LEASE_MS + staleDropMs : unseenReleaseMs)) {
        inFlight.delete(jobID);
        counters.inFlightExpired += 1;
      }
    }
    let skipped = 0;
    let releasedNow = 0;
    const waiting = [];
    for (const [jobID, event] of held) {
      if (skipped >= 4 * batch || releasedNow >= batch || inFlight.size >= maxInFlight) break;
      const leaseUntilMs = Number(event.payload && event.payload.leaseUntilMs) || 0;
      if (leaseUntilMs - t >= minLeaseLeftMs) {
        held.delete(jobID);
        inFlight.set(jobID, { leaseToken: event.payload.leaseToken, at: t, seen: false });
        counters.released += 1;
        releasedNow += 1;
        crumb(`release:${event.payload.type}`);
        deliver(original, event);
      } else if (leaseUntilMs + staleDropMs < t) {
        held.delete(jobID);
        counters.staleDropped += 1;
      } else {
        skipped += 1;
        waiting.push(jobID);
      }
    }
    for (const jobID of waiting) {
      const event = held.get(jobID);
      if (event === undefined) continue;
      held.delete(jobID);
      held.set(jobID, event);
    }
  }

  function kick() {
    if (mode !== "open" || !pumpStarted || pumping) return;
    try {
      pumpStep();
    } catch (error) {
      safeLog(`scheduler due gate: pump error: ${error && error.message || error}`);
    }
  }

  function wrapOnEvent(originalOnEvent) {
    if (typeof originalOnEvent !== "function" || !capturing()) return originalOnEvent;
    captured = true;
    original = originalOnEvent;
    mode = "holding";
    return function gatedOnEvent(event) {
      const payload = event && event.payload;
      const jobID = payload && payload.jobID != null ? String(payload.jobID) : "";
      const isDue = Boolean(event) && event.topic === TOPIC;
      if (isDue && jobID !== "" && typeof payload.type === "string") rememberType(jobID, payload.type);
      if (mode === "passthrough" || !isDue || jobID === "" || !types.has(String(payload.type || ""))) {
        if (isDue) crumb(`due:${payload && payload.type || "?"}`);
        return originalOnEvent.apply(this, arguments);
      }
      if (held.has(jobID)) {
        held.delete(jobID);
        counters.replaced += 1;
      } else if (held.size >= maxHeld) {
        counters.overflow += 1;
        crumb(`due:${payload.type}`);
        return originalOnEvent.apply(this, arguments);
      }
      held.set(jobID, event);
      counters.heldTotal += 1;
      armHoldTimer();
      return undefined;
    };
  }

  function track(command, payload, promise) {
    if (!payload || typeof payload !== "object" || payload.jobID == null) return;
    const jobID = String(payload.jobID);
    const entry = inFlight.get(jobID);
    if (!entry || entry.leaseToken !== payload.leaseToken) return;
    entry.seen = true;
    const release = () => {
      const current = inFlight.get(jobID);
      if (current !== entry) return;
      inFlight.delete(jobID);
      kick();
    };
    if (!promise || typeof promise.then !== "function") {
      if (command === "ack" || command === "retry") release();
      return;
    }
    if (command === "ack" || command === "retry") promise.then(release, release);
    else if (command === "validateLease") promise.then(() => {}, release);
  }

  function wrapClient(client) {
    if (!captured || !client || typeof client.call !== "function") return client;
    const vendorCall = client.call;
    return Object.freeze({
      ...client,
      call(command, payload) {
        let label = null;
        if (onBreadcrumb !== null) {
          try {
            label = labelOf(String(command), payload);
            crumb(`call:${command}:${label}`);
          } catch (_error) {
            label = null;
          }
        }
        const result = vendorCall.apply(client, arguments);
        try {
          observe(command, label, payload, result);
        } catch (_error) {
        }
        try {
          track(command, payload, result);
        } catch (_error) {
        }
        return result;
      },
    });
  }

  function open(reason) {
    if (mode === "open" || mode === "passthrough") return;
    if (mode === "idle") {
      mode = "passthrough";
      return;
    }
    mode = "open";
    if (holdTimer !== null) clearTimer(holdTimer);
    holdTimer = null;
    openedAt = now();
    openedReason = String(reason || "unknown");
    openedAfterMs = firstCaptureAt === null ? 0 : openedAt - firstCaptureAt;
    safeLog(`scheduler due gate: open (${openedReason}) held=${held.size} types=${[...types].join(",")}`);
    armPump(releaseDelayMs);
  }

  function wrapRuntime(runtime) {
    if (!runtime || typeof runtime.start !== "function") {
      open("runtime_invalid");
      return runtime;
    }
    return Object.freeze({
      getState: runtime.getState,
      shutdown() {
        shutdown();
        return runtime.shutdown.apply(runtime, arguments);
      },
      start() {
        beginOwners();
        let started;
        try {
          started = runtime.start.apply(runtime, arguments);
        } catch (error) {
          endOwners();
          open("owners_failed");
          throw error;
        }
        if (!started || typeof started.then !== "function") {
          endOwners();
          open("owners_ready");
          return Promise.resolve(started);
        }
        return started.then((value) => {
          endOwners();
          open("owners_ready");
          return value;
        }, (error) => {
          endOwners();
          open("owners_failed");
          throw error;
        });
      },
    });
  }

  function shutdown() {
    stopTimers();
    held.clear();
    inFlight.clear();
    mode = "passthrough";
  }

  function stats() {
    return {
      held: held.size, inFlight: inFlight.size, heldTotal: counters.heldTotal, replaced: counters.replaced,
      released: counters.released, staleDropped: counters.staleDropped, overflow: counters.overflow,
      inFlightExpired: counters.inFlightExpired, openedReason, openedAfterMs,
    };
  }

  function drainStatsLines() {
    if (!captured) return [];
    const s = stats();
    return [`dueGate mode=${mode} held=${s.held} released=${s.released} replaced=${s.replaced}` +
      ` staleDropped=${s.staleDropped} overflow=${s.overflow}`];
  }

  return {
    capture, capturing, wrapOnEvent, wrapClient, wrapRuntime, open, shutdown,
    mode: () => mode, stats, drainStatsLines, pumpStep,
  };
}

module.exports = { createSchedulerDueGate, parseGateTypes, VENDOR_LEASE_MS, TOPIC, MAX_TYPES, MAX_TYPE_LENGTH };
