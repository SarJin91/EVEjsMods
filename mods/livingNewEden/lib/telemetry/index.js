"use strict";

const fs = require("node:fs");
const path = require("node:path");
const perfHooksModule = require("node:perf_hooks");
const v8Module = require("node:v8");
const { isModuleEnabled } = require("../../config");
const { createClock } = require("../util/clock");
const { isInside } = require("../util/paths");
const { round } = require("./histogram");
const { createRegistry } = require("./registry");
const { startGcObserver, GC_KINDS } = require("./gc");
const { buildSnapshot, writeSnapshotAtomic, deepFreeze, SNAPSHOT_FILE_NAME, REGISTRY_ALARM_COUNTERS } = require("./snapshot");
const { createSlowOpLog } = require("./slowOps");
const { createSpikeAttribution, OP_KINDS } = require("./spikeAttribution");
const { createHeapDetail } = require("./heapDetail");
const { createStallDiag, METRIC_CAPTURE_SKIPPED, METRIC_PROFILE_STARTED, METRIC_PROFILE_FAILED } = require("./stallDiag");
const { createCpuProfile } = require("./cpuProfile");
const { defaultSetTimer } = require("../presence/poller");
const { CHECKPOINT_TIMING } = require("../persistence/store");
const { createWalAttribution } = require("./walAttribution");
const { createCostLedger } = require("./costLedger");

const TELEMETRY_DIR_NAME = "telemetry";
const STALL_DIAG_DIR_NAME = "diag";
const MS_PER_SECOND = 1000;
const US_PER_MS = 1000;
const PERCENT = 100;
const MAX_ERROR_LENGTH = 200;
const BYTES_PER_MB = 1024 * 1024;
const LOGGED_ALARMS = Object.freeze(["journal.conflict", "persistence.tx.TX_NESTED"]);
const OPEN_TIMINGS = Object.freeze({ open: "persistence.openMs", migrate: "persistence.migrateMs" });
const JOURNAL_COUNTS = Object.freeze({ "journal.duplicate": "journal.duplicates",
  "journal.conflict": "journal.conflicts" });
const MAX_PROBE_NAME = 80;

function noop() {}

function conflictLine(d) {
  const text = (v) => (v === undefined || v === null ? "-" : String(v));
  return `telemetry: journal conflict kind=${text(d.kind)} key=${text(d.key)} eventType=${text(d.eventType)} `
    + `aggregate=${text(d.aggregateType)}/${text(d.aggregateId)} existing=${text(d.journalId)} `
    + `${text(d.existingKind)} ${text(d.existingEventType)} ${text(d.existingAggregateType)}/`
    + `${text(d.existingAggregateId)}`;
}

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_ERROR_LENGTH);
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function startTelemetry(deps) {
  let service = null;
  try {
    if (!deps || !isModuleEnabled(deps.config, "telemetry")) return { ok: false, reason: "disabled_by_config" };
    service = createService(deps);
    service.start();
    return { ok: true, telemetry: service.api };
  } catch (err) {
    if (service) {
      try {
        service.api.stop();
      } catch (_err) {
      }
    }
    return { ok: false, reason: "TELEMETRY_START_FAILED", detail: messageOf(err) };
  }
}

function createService(deps) {
  const { config, adapter, modDir } = deps;
  const logger = deps.logger || { log: noop };
  const settings = config.telemetry;
  const clock = deps.clock || createClock();
  const timers = deps.timers || { setInterval, clearInterval };
  const fsApi = deps.fsApi || fs;
  const perfHooks = deps.perfHooks || perfHooksModule;
  const processApi = deps.processApi || process;
  const v8Api = deps.v8Api || v8Module;
  const performance = perfHooks.performance;
  const intervalMs = settings.intervalSeconds * MS_PER_SECOND;
  const registry = createRegistry({ histogramSamples: settings.histogramSamples, maxMetrics: settings.maxMetrics,
    summariesPerRead: settings.histogramSummariesPerPass });
  for (const name of REGISTRY_ALARM_COUNTERS) registry.count(name, 0);

  const status = { tick: "unavailable", tickReason: "not_started", gc: "unavailable", gcReason: "not_started",
    snapshotWrite: "unavailable", snapshotWriteReason: "not_started" };
  const tick = { samples: 0, sceneCount: 0, tickedSceneCount: 0, lastAtMs: null };
  const gcKinds = {};
  for (const kind of GC_KINDS) gcKinds[kind] = { count: 0, totalMs: 0, maxMs: 0 };
  const capture = { lastWriteMs: 0, writeSkips: 0, writeErrors: 0, lastWriteError: "", path: null };
  const loggedAlarmCounts = {};
  const startedAtMs = clock.now();
  let dir = null;
  let dirReady = false;
  let writeInFlight = false;
  let loggedWriteError = "";
  let tickSub = null;
  let bootGraceEndsAtMs = -Infinity;
  let gcSub = null;
  let handle = null;
  let stopped = false;
  let seq = 0;
  let latest = null;
  let lastResource = null;
  const slowLog = createSlowOpLog({ slowOpMs: settings.slowOpMs, perMin: settings.slowOpLogPerMin,
    nowMs: () => performance.now(), logger });
  const conflictLog = createSlowOpLog({ perMin: settings.slowOpLogPerMin, nowMs: () => performance.now(), logger });
  const heapDetail = settings.heapDetail === true ? createHeapDetail({ v8Api,
    ringSize: settings.heapAfterMajorRing, clock, onError: callbackError,
    charactersNow: () => registry.gaugeValue("presence.characters") }) : null;
  const majorGcLogMs = Number.isFinite(settings.majorGcLogMs) && settings.majorGcLogMs > 0 ? settings.majorGcLogMs : 0;
  const majorGcLog = createSlowOpLog({ perMin: settings.slowOpLogPerMin, nowMs: () => performance.now(), logger });
  const txFailureLogLimit = Number.isSafeInteger(settings.txFailureLogLimit) && settings.txFailureLogLimit > 0
    ? settings.txFailureLogLimit : 0;
  let txFailuresLogged = 0;
  const walPerTxSettings = config.persistence && config.persistence.walPerTx;
  const walAttribution = walPerTxSettings && walPerTxSettings.enabled === true
    ? createWalAttribution({ maxKeys: walPerTxSettings.maxKeys, detailModule: walPerTxSettings.detailModule,
      maxDetailNames: walPerTxSettings.maxDetailNames }) : null;
  const tickListeners = [];
  let governorSource = null;
  const stall = settings.stallDiag;
  const stallOn = settings.spikeAttribution === true && Boolean(stall) && stall.enabled === true;
  let cpuProfile = null;
  const stallDiag = stallOn ? createStallDiag({
    ringSize: stall.ringSize,
    maxLabels: stall.maxLabels,
    maxOpsPerLine: settings.spikeMaxOpsPerLine,
    slowCallbackMs: stall.slowCallbackMs,
    summaryMinutes: stall.summaryMinutes,
    count: (name, n) => registry.count(name, n),
    profileTrigger: stall.profile && stall.profile.enabled === true ? {
      restMs: stall.profile.triggerRestMs,
      bootGraceEndsAtMs: () => bootGraceEndsAtMs,
      fire: (reason) => (cpuProfile !== null ? cpuProfile.trigger(reason) : null),
    } : undefined,
  }) : null;
  const attribution = settings.spikeAttribution === true ? createSpikeAttribution({
    thresholdMs: settings.spikeLogMs > 0 ? settings.spikeLogMs
      : (config.governor && config.governor.emergencyMs) || 0,
    ringSize: settings.spikeRingSize,
    maxPending: settings.spikeMaxPending,
    maxOpsPerLine: settings.spikeMaxOpsPerLine,
    perfNow: () => performance.now(),
    wallNow: () => clock.now(),
    log: createSlowOpLog({ slowOpMs: settings.slowOpMs, perMin: settings.slowOpLogPerMin,
      nowMs: () => performance.now(), logger }).log,
    count: (name, n) => registry.count(name, n),
    bootGraceEndsAtMs: () => bootGraceEndsAtMs,
    ...(stallDiag !== null ? { extraSuffix: (gs, ge, parts) => stallDiag.suffixForGap(gs, ge, parts) } : {}),
  }) : null;
  const stallLog = stallDiag !== null ? createSlowOpLog({ perMin: settings.slowOpLogPerMin,
    nowMs: () => performance.now(), logger }).log : noop;
  const stallTimers = stallDiag !== null && deps.stallTimers && typeof deps.stallTimers.getStatus === "function"
    ? deps.stallTimers : null;
  const stallRun = { pauseSub: null, loop: null, lastSummaryAt: 0, lastCost: { captures: 0, skipped: 0, captureMs: 0 } };
  const mc = settings.moduleCost && settings.moduleCost.enabled === true ? settings.moduleCost : null;
  const budgets = settings.budgets && typeof settings.budgets === "object" ? settings.budgets : null;
  const ledger = mc !== null ? createCostLedger({ bucketMs: mc.bucketMs, windowMinutes: mc.windowMinutes,
    maxLabels: mc.maxLabels, maxPollerLabels: mc.maxPollerLabels, topN: mc.topN,
    moduleMsPerMin: budgets !== null && Number.isFinite(budgets.moduleMsPerMin) ? budgets.moduleMsPerMin : Infinity })
    : null;
  const memoryProbes = new Map();
  const probeRun = { atMs: null, rows: [], version: 0, ranVersion: -1 };

  function callbackError() {
    try {
      registry.count("telemetry.callbackErrors");
    } catch (_err) {
    }
  }

  function guarded(fn) {
    return function telemetryHook(...args) {
      try {
        fn(...args);
      } catch (_err) {
        callbackError();
      }
    };
  }

  function onTickSample(sample) {
    tick.samples += 1;
    registry.observe("tick.intervalMs", sample.intervalMs, sample.atMs);
    registry.observe("tick.workMs", sample.workMs, sample.atMs);
    registry.observe("tick.latenessMs", sample.latenessMs, sample.atMs);
    tick.sceneCount = sample.sceneCount;
    tick.tickedSceneCount = sample.tickedSceneCount;
    tick.lastAtMs = performance.now();
    for (let i = 0; i < tickListeners.length; i += 1) {
      try {
        tickListeners[i](sample);
      } catch (_err) {
        callbackError();
      }
    }
    if (attribution !== null) {
      try {
        attribution.onTick(sample);
      } catch (_err) {
        callbackError();
      }
    }
  }

  function ledgerNote(label, ms) {
    try {
      if (ledger.note(label, ms, performance.now())) registry.count("telemetry.moduleCost.otherNotes");
    } catch (_err) {
      callbackError();
    }
  }

  function notePoller(label, ms) {
    if (ledger !== null) ledgerNote(label, ms);
  }

  function registerMemoryProbe(name, fn) {
    if (typeof name !== "string" || name === "" || name.length > MAX_PROBE_NAME || typeof fn !== "function") {
      return { ok: false, reason: "INVALID" };
    }
    if (stopped) return { ok: false, reason: "stopped" };
    if (memoryProbes.has(name)) return { ok: false, reason: "DUPLICATE" };
    if (memoryProbes.size >= mc.maxMemoryProbes) return { ok: false, reason: "LIMIT" };
    memoryProbes.set(name, fn);
    probeRun.version += 1;
    return { ok: true, unregister() {
      if (memoryProbes.get(name) !== fn) return;
      memoryProbes.delete(name);
      probeRun.version += 1;
    } };
  }

  function runMemoryProbes(nowMs) {
    if (probeRun.atMs !== null && probeRun.ranVersion === probeRun.version
      && nowMs - probeRun.atMs < mc.memoryProbeMs) return probeRun.rows;
    probeRun.atMs = nowMs;
    probeRun.ranVersion = probeRun.version;
    const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const rows = [];
    for (const [name, fn] of memoryProbes) {
      try {
        const r = fn();
        rows.push({ name, entries: num(r && r.entries), approxBytes: num(r && r.approxBytes) });
      } catch (_err) {
        registry.count("telemetry.moduleCost.probeErrors");
        rows.push({ name, entries: null, approxBytes: null, error: true });
      }
    }
    rows.sort((a, b) => (a.name < b.name ? -1 : 1));
    probeRun.rows = rows;
    return rows;
  }

  function moduleCostNow(counters) {
    if (ledger === null) return { moduleCost: null, overBudget: 0 };
    try {
      const at = performance.now();
      const read = ledger.read(at);
      return {
        moduleCost: { ...read, memory: runMemoryProbes(at),
          counts: { otherNotes: counters["telemetry.moduleCost.otherNotes"] || 0,
            probeErrors: counters["telemetry.moduleCost.probeErrors"] || 0 } },
        overBudget: ledger.countOverBudget(at),
      };
    } catch (_err) {
      callbackError();
      return { moduleCost: null, overBudget: 0 };
    }
  }

  function ledgerOpLabel(kind, label) {
    if (kind === "observer" && typeof label === "string") {
      const q = label.indexOf("?");
      if (q >= 0) return `observer:${label.slice(0, q)}`;
    }
    return `${kind}:${label}`;
  }

  function noteOp(kind, label, startMs, ms) {
    if (ledger !== null) ledgerNote(ledgerOpLabel(kind, label), ms);
    if (attribution === null) return;
    try {
      if (!OP_KINDS.includes(kind)) {
        callbackError();
        return;
      }
      attribution.noteOp(kind, label, startMs, ms);
      if (kind === "trade") {
        if (slowLog.isSlow(ms)) {
          registry.count("trade.slowSegments");
          slowLog.log(`trade: slow segment ${round(ms)}ms after=${label}`);
        }
      } else if (kind === "observer") {
        registry.observe("observer.requestMs", ms);
        if (slowLog.isSlow(ms)) {
          registry.count("observer.slowRequests");
          slowLog.log(`observer: slow request ${round(ms)}ms ${label}`);
        }
      }
    } catch (_err) {
      callbackError();
    }
  }

  function noteSelf(label, startMs) {
    if (attribution === null) return;
    noteOp("telemetry", label, startMs, performance.now() - startMs);
  }

  function addTickListener(fn) {
    if (typeof fn !== "function") return { ok: false, reason: "not_a_function" };
    if (stopped) return { ok: false, reason: "stopped" };
    tickListeners.push(fn);
    return {
      ok: true,
      remove() {
        const at = tickListeners.indexOf(fn);
        if (at !== -1) tickListeners.splice(at, 1);
      },
    };
  }

  function governorStatus() {
    if (governorSource === null) return null;
    try {
      governorSource.evaluate();
      return governorSource.getStatus();
    } catch (_err) {
      callbackError();
      return null;
    }
  }

  function onGcPause(ms, kind, atMs) {
    if (typeof ms !== "number" || !(ms >= 0) || ms === Infinity) return;
    registry.observe("gc.pauseMs", ms, atMs);
    const k = gcKinds[kind] || gcKinds.unknown;
    k.count += 1;
    k.totalMs = round(k.totalMs + ms);
    if (ms > k.maxMs) k.maxMs = round(ms);
    if (attribution !== null) attribution.noteGc(kind, atMs, ms);
    if (kind === "major") noteMajorHeap(ms);
  }

  function noteMajorHeap(ms) {
    try {
      const after = heapDetail !== null ? heapDetail.noteMajor(ms) : { usedBytes: null, limitBytes: null };
      if (majorGcLogMs > 0 && ms >= majorGcLogMs) {
        const mb = (bytes) => (typeof bytes === "number" ? `${Math.round(bytes / BYTES_PER_MB)}MB` : "-");
        majorGcLog.log(`telemetry: major GC ${round(ms)}ms usedAfter=${mb(after.usedBytes)} `
          + `limit=${mb(after.limitBytes)}`);
      }
    } catch (_err) {
      callbackError();
    }
  }

  function noteTxFailure(name, outcome, failure) {
    try {
      const f = failure && typeof failure === "object" ? failure : {};
      const text = (v) => String(v).replace(/\s+/g, " ").slice(0, MAX_ERROR_LENGTH);
      const code = typeof f.code === "string" && f.code !== "" ? f.code : "-";
      const reason = typeof f.reason === "string" && f.reason !== "" ? ` reason=${text(f.reason)}` : "";
      const message = f.message === undefined ? "-" : text(f.message);
      logger.log(`persistence: tx ${outcome} ${text(name)} code=${code}${reason} error=${message} `
        + `(${txFailuresLogged}/${txFailureLogLimit})`);
    } catch (_err) {
      callbackError();
    }
  }

  const hooks = Object.freeze({
    onTiming: guarded((name, ms, outcome, rows, why, failure, wal) => {
      if ((outcome === "TX_FAILED" || outcome === "TX_CONSTRAINT") && txFailuresLogged < txFailureLogLimit) {
        txFailuresLogged += 1;
        noteTxFailure(name, outcome, failure);
      }
      if (outcome === undefined) {
        if (hasOwn(OPEN_TIMINGS, name)) registry.gauge(OPEN_TIMINGS[name], ms);
        return;
      }
      if (ledger !== null) ledgerNote(name === CHECKPOINT_TIMING ? "checkpoint:wal" : `tx:${name}`, ms);
      if (attribution !== null) {
        const checkpoint = name === CHECKPOINT_TIMING;
        attribution.noteOp(checkpoint ? "checkpoint" : "tx", checkpoint ? "wal" : name, performance.now() - ms, ms);
      }
      if (name === CHECKPOINT_TIMING) {
        registry.observe("persistence.checkpointMs", ms);
        if (typeof rows === "number") registry.observe("persistence.checkpointFrames", rows);
        if (slowLog.isSlow(ms)) {
          registry.count("persistence.slowOps");
          slowLog.log(`persistence: slow checkpoint wal ${round(ms)}ms frames=${rows}`
            + `${typeof why === "string" && why !== "" ? ` why=${why}` : ""}`);
        }
        return;
      }
      if (slowLog.isSlow(ms)) {
        registry.count("persistence.slowOps");
        slowLog.log(`persistence: slow tx ${name} ${round(ms)}ms rows=${rows === undefined ? "-" : rows}`);
      }
      registry.observe("persistence.txMs", ms);
      if (typeof rows === "number") registry.observe("persistence.txRows", rows);
      registry.count(`persistence.tx.${outcome}`);
      if (wal !== undefined && walAttribution !== null) {
        for (const [counterName, n] of walAttribution.note(name, rows, wal)) registry.count(counterName, n);
      }
    }),
    onCount: guarded((name, n, detail) => {
      registry.count(hasOwn(JOURNAL_COUNTS, name) ? JOURNAL_COUNTS[name] : name, n);
      if (name === "journal.conflict" && detail && typeof detail === "object") conflictLog.log(conflictLine(detail));
    }),
  });

  function sampleProcess() {
    const memory = processApi.memoryUsage();
    const cpuUsage = processApi.cpuUsage();
    const atMs = performance.now();
    const elu = typeof performance.eventLoopUtilization === "function" ? performance.eventLoopUtilization() : null;
    const previous = lastResource;
    lastResource = { atMs, cpuUsage, elu };
    const cpu = { sampleWindowMs: 0, userPercentOfOneCore: 0, systemPercentOfOneCore: 0,
      eventLoopUtilizationPercent: 0 };
    if (previous) {
      const windowMs = Math.max(1, atMs - previous.atMs);
      const windowUs = windowMs * US_PER_MS;
      const pct = (deltaUs) => round((Math.max(0, deltaUs) / windowUs) * PERCENT);
      cpu.sampleWindowMs = round(windowMs);
      cpu.userPercentOfOneCore = pct(cpuUsage.user - previous.cpuUsage.user);
      cpu.systemPercentOfOneCore = pct(cpuUsage.system - previous.cpuUsage.system);
      if (elu && previous.elu) {
        const active = Math.max(0, elu.active - previous.elu.active);
        const idle = Math.max(0, elu.idle - previous.elu.idle);
        cpu.eventLoopUtilizationPercent = active + idle > 0 ? round((active / (active + idle)) * PERCENT) : 0;
      }
    }
    return {
      pid: processApi.pid,
      uptimeSeconds: round(processApi.uptime()),
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
      heapTotalBytes: memory.heapTotal,
      externalBytes: memory.external,
      cpu,
      heap: heapDetail === null ? null : heapDetail.read(),
    };
  }

  function logAlarms(snapshot) {
    const grown = [];
    for (const alarm of snapshot.alarms) {
      if (!LOGGED_ALARMS.includes(alarm.id)) continue;
      if (alarm.count > (loggedAlarmCounts[alarm.id] || 0)) grown.push(alarm);
      loggedAlarmCounts[alarm.id] = alarm.count;
    }
    if (grown.length > 0) {
      logger.log(`telemetry: ALARM ${grown.map((a) => `${a.id}=${a.count}`).join(" ")} - `
        + grown.map((a) => a.message).join("; "));
    }
  }

  function noteSlowCapture(steps, totalMs) {
    try {
      if (!slowLog.isSlow(totalMs)) return;
      const h = registry.lastReadStats();
      slowLog.log(`telemetry: slow capture ${round(totalMs)}ms governor=${steps.governorMs} read=${steps.registryReadMs}`
        + ` moduleCost=${steps.moduleCostMs} process=${steps.processMs} build=${steps.buildMs}`
        + ` freeze=${round(steps.freezeMs)} histograms=${h.summarized}/${h.reused}/${h.deferred}`);
    } catch (_err) {
      callbackError();
    }
  }

  function captureNow() {
    const buildStartedAt = performance.now();
    if (tickSub !== null) status.tick = tick.samples > 0 ? "ok" : "waiting";
    seq += 1;
    let at = buildStartedAt;
    const lap = () => {
      const now = performance.now();
      const ms = round(now - at);
      at = now;
      return ms;
    };
    const governor = governorStatus();
    const governorMs = lap();
    const metrics = registry.read();
    const registryReadMs = lap();
    const cost = moduleCostNow(metrics.counters);
    const moduleCostMs = lap();
    const processSample = sampleProcess();
    const processMs = lap();
    const snapshot = buildSnapshot({
      seq,
      capturedAtMs: clock.now(),
      startedAtMs,
      intervalMs,
      histogramSamples: settings.histogramSamples,
      status,
      process: processSample,
      metrics,
      rejectedNames: registry.rejectedNames(),
      tick: {
        sceneCount: tick.sceneCount,
        tickedSceneCount: tick.tickedSceneCount,
        samplesTotal: tick.samples,
        lastSampleAgeMs: tick.lastAtMs === null ? null : round(performance.now() - tick.lastAtMs),
        wrapErrors: tickSub !== null ? tickSub.errors() : 0,
      },
      gcKinds,
      capture,
      governor,
      spikes: attribution !== null ? attribution.getStatus() : null,
      ...(cost.moduleCost !== null ? { moduleCost: cost.moduleCost } : {}),
      budgets,
      moduleOverBudget: cost.overBudget,
    });
    const buildMs = lap();
    const h = registry.lastReadStats();
    const steps = { governorMs, registryReadMs, moduleCostMs, processMs, buildMs,
      histogramsSummarized: h.summarized, histogramsReused: h.reused, histogramsDeferred: h.deferred };
    snapshot.capture.steps = steps;
    snapshot.capture.buildDurationMs = round(performance.now() - buildStartedAt);
    latest = deepFreeze(snapshot);
    const freezeAt = performance.now();
    logAlarms(latest);
    noteSlowCapture({ ...steps, freezeMs: freezeAt - at }, freezeAt - buildStartedAt);
    return latest;
  }

  function queueWrite(snapshot) {
    if (dir === null) return Promise.resolve(false);
    if (writeInFlight) {
      capture.writeSkips += 1;
      return Promise.resolve(false);
    }
    writeInFlight = true;
    const startedAt = performance.now();
    return Promise.resolve()
      .then(() => (dirReady ? undefined : fsApi.promises.mkdir(dir, { recursive: true })))
      .then(() => {
        dirReady = true;
        const stringifyAt = performance.now();
        const json = `${JSON.stringify(snapshot, null, 2)}\n`;
        noteSelf("stringify", stringifyAt);
        return writeSnapshotAtomic(fsApi, dir, json);
      })
      .then(() => {
        capture.lastWriteMs = round(performance.now() - startedAt);
        capture.lastWriteError = "";
        status.snapshotWrite = "ok";
        delete status.snapshotWriteReason;
        loggedWriteError = "";
        return true;
      }, (err) => {
        const message = messageOf(err);
        capture.writeErrors += 1;
        capture.lastWriteError = message;
        status.snapshotWrite = "failing";
        status.snapshotWriteReason = message;
        dirReady = false;
        if (message !== loggedWriteError) logger.log(`telemetry: snapshot write failed - ${message}`);
        loggedWriteError = message;
        return false;
      })
      .catch(() => false)
      .finally(() => {
        writeInFlight = false;
      });
  }

  function pass() {
    try {
      if (stopped) return Promise.resolve(false);
      if (attribution !== null) {
        try {
          attribution.resolve(performance.now());
        } catch (_err) {
          callbackError();
        }
      }
      stallSummary();
      const captureAt = performance.now();
      const snapshot = captureNow();
      noteSelf("capture", captureAt);
      return queueWrite(snapshot);
    } catch (_err) {
      callbackError();
      return Promise.resolve(false);
    }
  }

  function startTick() {
    if (!adapter || typeof adapter.subscribeTickSamples !== "function") {
      status.tickReason = "adapter_unavailable";
      return;
    }
    const disabled = typeof adapter.getDisabledModules === "function" ? adapter.getDisabledModules() : {};
    if (disabled && disabled.telemetry) {
      status.tickReason = `probe_drift:${disabled.telemetry}`;
      return;
    }
    const sub = adapter.subscribeTickSamples(onTickSample);
    if (!sub || !sub.ok) {
      status.tickReason = sub ? sub.reason : "no_result";
      return;
    }
    tickSub = sub;
    const graceSeconds = settings.bootGraceSeconds;
    if (Number.isFinite(graceSeconds) && graceSeconds > 0) {
      bootGraceEndsAtMs = performance.now() + graceSeconds * MS_PER_SECOND;
    }
    status.tick = "waiting";
    delete status.tickReason;
  }

  function startGc() {
    const result = startGcObserver({ PerformanceObserver: perfHooks.PerformanceObserver,
      constants: perfHooks.constants, onPause: onGcPause });
    if (!result.ok) {
      status.gcReason = result.detail ? `${result.reason}: ${result.detail}` : result.reason;
      return;
    }
    gcSub = result;
    status.gc = "ok";
    delete status.gcReason;
  }

  function noteForeign(label, startMs, ms) {
    if (stallDiag === null) return;
    try {
      stallDiag.noteForeign(label, startMs, ms);
    } catch (_err) {
      callbackError();
    }
  }

  function noteJob(type, atMs, ms) {
    if (stallDiag === null) return;
    try {
      stallDiag.noteJob(type, atMs, ms);
    } catch (_err) {
      callbackError();
    }
  }

  function stallSummary() {
    if (stallDiag === null || !(stallDiag.windowMs() > 0)) return;
    const at = performance.now();
    if (at - stallRun.lastSummaryAt < stallDiag.windowMs()) return;
    stallRun.lastSummaryAt = at;
    try {
      let loop = null;
      if (stallRun.loop !== null) {
        const ns = (v) => (Number.isFinite(v) ? v / 1e6 : 0);
        loop = { p50: ns(stallRun.loop.percentile(50)), p99: ns(stallRun.loop.percentile(99)),
          max: ns(stallRun.loop.max) };
        stallRun.loop.reset();
      }
      let cost = { state: "on" };
      if (stallTimers !== null) {
        const st = stallTimers.getStatus();
        const last = stallRun.lastCost;
        cost = { state: st.state, captures: st.captures - last.captures, skipped: st.skipped - last.skipped,
          captureMs: st.captureMs - last.captureMs };
        if (cost.skipped > 0) registry.count(METRIC_CAPTURE_SKIPPED, cost.skipped);
        stallRun.lastCost = { captures: st.captures, skipped: st.skipped, captureMs: st.captureMs };
      }
      stallLog(stallDiag.summaryLine(loop, cost));
      stallDiag.resetWindow();
    } catch (_err) {
      callbackError();
    }
  }

  function startStallDiag() {
    if (stallDiag === null) return;
    stallRun.lastSummaryAt = performance.now();
    const resolution = stall.loopDelayResolutionMs;
    if (Number.isSafeInteger(resolution) && resolution > 0 && typeof perfHooks.monitorEventLoopDelay === "function") {
      try {
        const h = perfHooks.monitorEventLoopDelay({ resolution });
        if (typeof h.enable === "function") {
          h.enable();
          stallRun.loop = h;
        }
      } catch (_err) {
        callbackError();
      }
    }
    const g = config.governor || {};
    if (adapter && typeof adapter.subscribeVendorPauses === "function") {
      try {
        const sub = adapter.subscribeVendorPauses((p) => noteForeign(`vendor:${p.kind}`, p.startMs, p.endMs - p.startMs),
          g.vendorPauseExcuseEnabled === true ? {} : { minMs: g.vendorPauseMinMs });
        if (sub && sub.ok === true) stallRun.pauseSub = sub;
      } catch (_err) {
        callbackError();
      }
    }
    if (stall.profile && stall.profile.enabled === true) {
      const diagDir = typeof config.dataDir === "string" && config.dataDir !== ""
        ? path.join(config.dataDir, STALL_DIAG_DIR_NAME) : null;
      cpuProfile = createCpuProfile({
        inspector: deps.inspector || require("node:inspector"),
        fs: fsApi,
        dir: diagDir !== null && !(typeof modDir === "string" && modDir !== "" && isInside(modDir, diagDir))
          ? diagDir : null,
        now: () => performance.now(),
        wallNow: () => clock.now(),
        durationSec: stall.profile.durationSec,
        samplingIntervalUs: stall.profile.samplingIntervalUs,
        topN: stall.profile.topN,
        maxPerBoot: stall.profile.maxPerBoot,
        log: (line) => logger.log(line),
        noteOp,
        setTimer: deps.setTimer || defaultSetTimer,
        count: (name, n) => registry.count(name, n),
        gaps: () => stallDiag.unattributedGaps(),
        rootDir: typeof modDir === "string" && modDir !== "" ? path.resolve(modDir, "..", "..") : "",
        metrics: { started: METRIC_PROFILE_STARTED, failed: METRIC_PROFILE_FAILED },
      });
    }
  }

  function stopStallDiag() {
    if (stallDiag === null) return;
    if (stallRun.pauseSub !== null) {
      try {
        stallRun.pauseSub.unsubscribe();
      } catch (_err) {
        callbackError();
      }
      stallRun.pauseSub = null;
    }
    if (stallRun.loop !== null) {
      try {
        stallRun.loop.disable();
      } catch (_err) {
        callbackError();
      }
      stallRun.loop = null;
    }
    if (cpuProfile !== null) cpuProfile.stop();
    if (stallTimers !== null && typeof stallTimers.uninstall === "function") {
      try {
        stallTimers.uninstall();
      } catch (_err) {
        callbackError();
      }
    }
  }

  function stallStatus() {
    const st = stallDiag.getStatus();
    return { ...st, timers: stallTimers !== null ? stallTimers.getStatus() : null,
      profile: cpuProfile !== null ? cpuProfile.getStatus() : null };
  }

  function resolveDir() {
    if (typeof config.dataDir !== "string" || config.dataDir === "") {
      status.snapshotWriteReason = "no_data_dir";
      return;
    }
    const candidate = path.join(config.dataDir, TELEMETRY_DIR_NAME);
    if (typeof modDir === "string" && modDir !== "" && isInside(modDir, candidate)) {
      status.snapshotWriteReason = "SNAPSHOT_PATH_IN_MOD_DIR";
      return;
    }
    dir = candidate;
    capture.path = path.join(candidate, SNAPSHOT_FILE_NAME);
    status.snapshotWrite = "ok";
    delete status.snapshotWriteReason;
  }

  function start() {
    resolveDir();
    startTick();
    startGc();
    startStallDiag();
    captureNow();
    handle = timers.setInterval(pass, intervalMs);
    if (handle && typeof handle.unref === "function") handle.unref();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    if (handle !== null) {
      timers.clearInterval(handle);
      handle = null;
    }
    if (tickSub !== null) tickSub.unwrap();
    if (gcSub !== null) gcSub.stop();
    stopStallDiag();
    tickListeners.length = 0;
    governorSource = null;
    memoryProbes.clear();
  }

  const api = Object.freeze({
    hooks,
    count: registry.count,
    gauge: registry.gauge,
    observe: registry.observe,
    getSnapshot: () => latest,
    capture: () => (stopped ? latest : captureNow()),
    getStatus: () => ({ tick: status.tick, gc: status.gc, snapshotWrite: status.snapshotWrite,
      timer: handle !== null, ...(stallDiag !== null ? { stallDiag: stallStatus() } : {}) }),
    noteForeign,
    noteJob,
    addTickListener,
    bootGraceEndsAtMs: () => bootGraceEndsAtMs,
    noteOp,
    attachGovernor: (source) => {
      governorSource = !stopped && source && typeof source.evaluate === "function"
        && typeof source.getStatus === "function" ? source : null;
    },
    stop,
    ...(ledger !== null ? {
      notePoller,
      registerMemoryProbe,
      moduleOverBudget: (label, windows) => ledger.overBudget(label, performance.now(), windows),
      moduleInBudget: (label, windows) => ledger.inBudget(label, performance.now(), windows),
    } : {}),
  });

  return { start, api };
}

module.exports = { TELEMETRY_DIR_NAME, LOGGED_ALARMS, startTelemetry };
