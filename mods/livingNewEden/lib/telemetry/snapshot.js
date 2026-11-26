"use strict";

const path = require("node:path");
const { emptySummary, round } = require("./histogram");
const { GC_KINDS: GC_KIND_NAMES } = require("./gc");
const { FRAMES_PREFIX, ROWS_PREFIX, TX_PREFIX, BY_NAME_PREFIX } = require("./walAttribution");
const { COUNTER_NAMES: RETENTION_COUNTS } = require("../retention/schema");
const { COUNT_NAMES: BACKUP_COUNTS } = require("../persistence/backupRules");

const SNAPSHOT_SCHEMA_VERSION = 1;
const SNAPSHOT_FILE_NAME = "latest.json";
const TMP_SUFFIX = ".tmp";
const TX_OUTCOMES = Object.freeze(["ok", "TX_FAILED", "TX_NESTED", "TX_CONSTRAINT", "TX_ROW_LIMIT", "TX_ABORTED"]);
const CHECKPOINT_COUNTS = Object.freeze(["force", "target", "interval", "busy", "failed"]);
const ALERT_COUNTS = Object.freeze(["sent", "failed", "dropped", "suppressed", "events"]);
const MODULE_CHANNELS = Object.freeze(["scheduler", "economy", "battleResolver", "materialization", "events",
  "governor", "observer", "presence", "fleets", "battle", "strategy",
  "logistics", "mining", "production", "salvage", "stations",
  "graph", "world",
  "trade",
  "virtualCorps",
  "sovProjection",
  "sovReconcile",
  "sites",
  "structures",
  "hunt",
  "salvageAnomaly",
  "wormholes",
  "treasury",
  "lowsec",
  "capsuleers",
  "expeditions",
  "playerHunt",
  "fleetExposure",
  "frontChat",
  "notices",
  "battleAnnounce",
  "frontJobs",
  "warContracts",
  "killboard",
  "devIndices",
  "news",
  "eventRewards",
  "localPilots",
  "localContacts",
  "crews",
  "garrisonPatrol",
  "loyalty",
  "blockade",
  "fortress",
  "capitalLive",
  "sentries",
  "vendorPauses",
  "highsecLife",
  "freeCorps",
  "inGameMap",
  "jobBoard",
  "modSettings",
  "capsuleSweep",
  "bookmarkSiteWarp",
  "chatterAi",
  "npcVoices",
  "fame",
  "shipAi",
  "buildInputs",
  "abyssal",
  "escalations",
  "worldBosses",
  "names",
  "bounty",
  "trigBridge",
  "transit",
  "playerValue",
  "harvestRaid",
  "archaeology",
  "listeningPost",
  "situations",
  "gameMaster",
  "seasons",
  "population",
  "extraction",
  "perf"]);

const ALARMS = Object.freeze([
  Object.freeze({ id: "journal.conflict", counter: "journal.conflicts", level: "error",
    message: "idempotency conflict: volatile payload field or same key for APPLY/OUTBOX - programmer error" }),
  Object.freeze({ id: "persistence.tx.TX_NESTED", counter: "persistence.tx.TX_NESTED", level: "error",
    message: "nested store.transaction - programmer error" }),
  Object.freeze({ id: "persistence.tx.TX_FAILED", counter: "persistence.tx.TX_FAILED", level: "warn",
    message: "SQLite failure, includes applyOnce errors after auto-rollback" }),
  Object.freeze({ id: "capture.writeErrors", counter: "capture.writeErrors", level: "warn",
    message: "telemetry/latest.json write failed - retried at the next interval" }),
  Object.freeze({ id: "telemetry.rejectedMetrics", counter: "telemetry.rejectedMetrics", level: "warn",
    message: "metric names refused: registry full (raise telemetry.maxMetrics) or bad name - new metrics are not kept" }),
  Object.freeze({ id: "persistence.backup.failed", counter: "persistence.backup.failed", level: "warn",
    message: "online backup of world.sqlite failed - see the backup: lines of the server log; retried after backup.retryMs" }),
]);
const REGISTRY_ALARM_COUNTERS = Object.freeze(ALARMS.map((a) => a.counter)
  .filter((c) => c !== "capture.writeErrors" && c !== "telemetry.rejectedMetrics"));

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function buildAlarms(counters) {
  const out = [];
  for (const alarm of ALARMS) {
    const count = counters[alarm.counter] || 0;
    if (count > 0) out.push({ id: alarm.id, level: alarm.level, count, message: alarm.message });
  }
  return out;
}

const BUDGET_ALARMS = Object.freeze({
  heapAfterMajorWarn: Object.freeze({ id: "heapAfterMajorWarn", level: "warning",
    message: "heap after the last major GC above telemetry.budgets.heapAfterMajorWarnBytes - see process.heap" }),
  heapAfterMajorCritical: Object.freeze({ id: "heapAfterMajorCritical", level: "critical",
    message: "heap after the last major GC above telemetry.budgets.heapAfterMajorCriticalBytes - see process.heap" }),
  moduleOverBudget: Object.freeze({ id: "moduleOverBudget", level: "warning",
    message: "labels above telemetry.budgets.moduleMsPerMin in the last full bucket - see moduleCost" }),
});

function buildBudgetAlarms(state) {
  const out = [];
  const b = state.budgets;
  const heap = state.process && state.process.heap;
  const used = heap && heap.afterMajor ? heap.afterMajor.lastUsedBytes : null;
  if (b && typeof used === "number" && Number.isFinite(used)) {
    let alarm = null;
    if (Number.isFinite(b.heapAfterMajorCriticalBytes) && used >= b.heapAfterMajorCriticalBytes) {
      alarm = BUDGET_ALARMS.heapAfterMajorCritical;
    } else if (Number.isFinite(b.heapAfterMajorWarnBytes) && used >= b.heapAfterMajorWarnBytes) {
      alarm = BUDGET_ALARMS.heapAfterMajorWarn;
    }
    if (alarm !== null) out.push({ id: alarm.id, level: alarm.level, count: 1, message: alarm.message });
  }
  const over = state.moduleOverBudget;
  if (Number.isSafeInteger(over) && over > 0) {
    const a = BUDGET_ALARMS.moduleOverBudget;
    out.push({ id: a.id, level: a.level, count: over, message: a.message });
  }
  return out;
}

function groupChannels(metrics) {
  const channels = {};
  for (const name of MODULE_CHANNELS) channels[name] = {};
  for (const kind of ["counters", "gauges", "histograms"]) {
    for (const [name, value] of Object.entries(metrics[kind])) {
      const dot = name.indexOf(".");
      const channel = name.slice(0, dot);
      if (MODULE_CHANNELS.includes(channel)) channels[channel][name.slice(dot + 1)] = value;
    }
  }
  return channels;
}

function walPerTxOf(counters, gauges) {
  if (counters["persistence.walPerTx.txTotal"] === undefined) return null;
  const keys = {};
  const names = {};
  const slot = (k) => {
    if (!Object.prototype.hasOwnProperty.call(keys, k)) keys[k] = { frames: 0, rows: 0, tx: 0 };
    return keys[k];
  };
  const fields = [[FRAMES_PREFIX, "frames"], [ROWS_PREFIX, "rows"], [TX_PREFIX, "tx"]];
  const byName = BY_NAME_PREFIX;
  for (const [name, value] of Object.entries(counters)) {
    if (!name.startsWith("persistence.wal")) continue;
    if (name.startsWith(byName)) {
      names[name.slice(byName.length)] = value;
      continue;
    }
    for (const [prefix, field] of fields) {
      if (name.startsWith(prefix)) {
        slot(name.slice(prefix.length))[field] = value;
        break;
      }
    }
  }
  const c = (name) => counters[name] || 0;
  return {
    calibrated: gauges["persistence.walPerTx.calibrated"] === 1,
    frameBytes: gauges["persistence.walPerTx.frameBytes"] === undefined ? null : gauges["persistence.walPerTx.frameBytes"],
    overflow: c("persistence.walPerTx.overflow"),
    framesUnknown: c("persistence.walPerTx.framesUnknown"),
    total: { frames: c("persistence.walPerTx.framesTotal"), rows: c("persistence.walPerTx.rowsTotal"),
      tx: c("persistence.walPerTx.txTotal") },
    keys,
    names,
  };
}

function buildSnapshot(state) {
  const { counters, gauges, histograms } = state.metrics;
  const capacity = state.histogramSamples;
  const hist = (name) => histograms[name] || emptySummary(capacity);
  const counter = (name) => counters[name] || 0;
  const tx = {};
  for (const outcome of TX_OUTCOMES) tx[outcome] = counter(`persistence.tx.${outcome}`);
  const kinds = {};
  let gcCount = 0;
  let gcTotalMs = 0;
  for (const kind of GC_KIND_NAMES) {
    const k = (state.gcKinds && state.gcKinds[kind]) || { count: 0, totalMs: 0, maxMs: 0 };
    kinds[kind] = { count: k.count, totalMs: k.totalMs, maxMs: k.maxMs };
    gcCount += k.count;
    gcTotalMs += k.totalMs;
  }
  const failing = Boolean(state.status && state.status.snapshotWrite === "failing");
  const allCounters = { ...counters, "capture.writeErrors": failing ? state.capture.writeErrors : 0 };
  return {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    seq: state.seq,
    capturedAtMs: state.capturedAtMs,
    capturedAt: new Date(state.capturedAtMs).toISOString(),
    startedAtMs: state.startedAtMs,
    intervalMs: state.intervalMs,
    status: { ...state.status },
    window: { histogramSamples: capacity },
    process: state.process,
    tick: {
      intervalMs: hist("tick.intervalMs"),
      workMs: hist("tick.workMs"),
      latenessMs: hist("tick.latenessMs"),
      sceneCount: state.tick.sceneCount,
      tickedSceneCount: state.tick.tickedSceneCount,
      samplesTotal: state.tick.samplesTotal,
      lastSampleAgeMs: state.tick.lastSampleAgeMs,
      wrapErrors: state.tick.wrapErrors,
    },
    gc: { pauseMs: hist("gc.pauseMs"), count: gcCount, totalMs: round(gcTotalMs), kinds },
    persistence: {
      txMs: hist("persistence.txMs"),
      txRows: hist("persistence.txRows"),
      tx,
      openMs: gauges["persistence.openMs"] === undefined ? null : gauges["persistence.openMs"],
      migrateMs: gauges["persistence.migrateMs"] === undefined ? null : gauges["persistence.migrateMs"],
      checkpoint: {
        ms: hist("persistence.checkpointMs"),
        frames: hist("persistence.checkpointFrames"),
        counts: Object.fromEntries(CHECKPOINT_COUNTS.map((k) => [k, counter(`persistence.checkpoints.${k}`)])),
        lastAtAgeMs: gauges["persistence.checkpointAgeMs"] === undefined ? null : gauges["persistence.checkpointAgeMs"],
        walEstimatedFrames: gauges["persistence.walEstimatedFrames"] === undefined ? null
          : gauges["persistence.walEstimatedFrames"],
      },
      slowOps: counter("persistence.slowOps"),
      walPerTx: walPerTxOf(counters, gauges),
      warmup: gauges["persistence.warmupBytes"] === undefined ? null
        : { bytes: gauges["persistence.warmupBytes"],
          ms: gauges["persistence.warmupMs"] === undefined ? null : gauges["persistence.warmupMs"] },
      retention: gauges["persistence.retention.dryRun"] === undefined ? null
        : { dryRun: gauges["persistence.retention.dryRun"] === 1,
          counts: Object.fromEntries(RETENTION_COUNTS.map((k) => [k, counter(`persistence.retention.${k}`)])),
          passMs: hist("persistence.retention.passMs") },
      backup: gauges["persistence.backup.enabled"] === undefined ? null
        : { counts: Object.fromEntries(BACKUP_COUNTS.map((k) => [k, counter(`persistence.backup.${k}`)])),
          lastOkAgeSeconds: gauges["persistence.backup.lastOkAgeSeconds"] === undefined ? null
            : gauges["persistence.backup.lastOkAgeSeconds"],
          files: gauges["persistence.backup.files"] === undefined ? null : gauges["persistence.backup.files"],
          totalBytes: gauges["persistence.backup.totalBytes"] === undefined ? null
            : gauges["persistence.backup.totalBytes"],
          toolCopiesBytes: gauges["persistence.backup.toolCopiesBytes"] === undefined ? null
            : gauges["persistence.backup.toolCopiesBytes"],
          durationMs: hist("persistence.backup.durationMs"),
          maxGapMs: hist("persistence.backup.maxGapMs"),
          finalStepMs: hist("persistence.backup.finalStepMs") },
    },
    journal: { duplicates: counter("journal.duplicates"), conflicts: counter("journal.conflicts") },
    alarms: [...buildAlarms(allCounters), ...buildBudgetAlarms(state)],
    channels: groupChannels(state.metrics),
    capture: {
      buildDurationMs: 0,
      lastWriteMs: state.capture.lastWriteMs,
      writeSkips: state.capture.writeSkips,
      writeErrors: state.capture.writeErrors,
      lastWriteError: state.capture.lastWriteError,
      path: state.capture.path,
    },
    telemetry: { rejectedMetrics: counter("telemetry.rejectedMetrics"),
      callbackErrors: counter("telemetry.callbackErrors"),
      rejectedNames: Array.isArray(state.rejectedNames) ? state.rejectedNames : [],
      alerts: gauges["telemetry.alerts.queue"] === undefined ? null
        : { queue: gauges["telemetry.alerts.queue"],
          counts: Object.fromEntries(ALERT_COUNTS.map((k) => [k, counter(`telemetry.alerts.${k}`)])) } },
    governor: state.governor || null,
    spikes: state.spikes || null,
    ...(state.moduleCost ? { moduleCost: state.moduleCost } : {}),
  };
}

function writeSnapshotAtomic(fsApi, dir, json) {
  const target = path.join(dir, SNAPSHOT_FILE_NAME);
  const tmp = `${target}${TMP_SUFFIX}`;
  return fsApi.promises.writeFile(tmp, json, "utf8").then(() => fsApi.promises.rename(tmp, target)).then(() => target);
}

module.exports = {
  SNAPSHOT_SCHEMA_VERSION, SNAPSHOT_FILE_NAME, TX_OUTCOMES, ALARMS, REGISTRY_ALARM_COUNTERS, MODULE_CHANNELS,
  CHECKPOINT_COUNTS, BUDGET_ALARMS, deepFreeze, buildAlarms, buildBudgetAlarms, buildSnapshot, writeSnapshotAtomic,
};
