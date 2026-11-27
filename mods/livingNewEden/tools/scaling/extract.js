"use strict";

const SUPPORTED_SCHEMA_VERSION = 1;

const REASONS = Object.freeze({
  NOT_A_SNAPSHOT: "NOT_A_SNAPSHOT",
  SCHEMA_UNSUPPORTED: "SCHEMA_UNSUPPORTED",
});

function hist(prefix, keys) {
  return keys.map((k) => `${prefix}.${k}`);
}

const PATHS = Object.freeze([
  "seq", "capturedAtMs", "startedAtMs",
  "process.pid", "process.uptimeSeconds", "process.rssBytes", "process.heapUsedBytes", "process.heapTotalBytes",
  "process.externalBytes", "process.cpu.userPercentOfOneCore", "process.cpu.systemPercentOfOneCore",
  "process.cpu.eventLoopUtilizationPercent",
  ...hist("tick.intervalMs", ["samples", "spanMs", "avg", "p50", "p95", "max"]),
  ...hist("tick.workMs", ["samples", "spanMs", "p95", "max"]),
  ...hist("tick.latenessMs", ["spanMs", "p95"]),
  "gc.count", "gc.totalMs", "gc.kinds.major.count", "gc.kinds.major.totalMs", "gc.kinds.major.maxMs",
  "gc.kinds.minor.count", "gc.kinds.minor.totalMs", "gc.pauseMs.p95",
  ...hist("persistence.txMs", ["samples", "spanMs", "p95"]),
  ...hist("persistence.checkpoint.ms", ["samples", "spanMs", "p95"]),
  "persistence.slowOps",
  "journal.duplicates", "journal.conflicts",
  "governor.mode", "governor.changes", "governor.counts.emergencySamples", "governor.counts.unplayableSamples",
  "spikes.bySource.lne", "spikes.bySource.gc", "spikes.bySource.evejsTick", "spikes.bySource.unattributed",
  ...hist("channels.scheduler.passMs", ["samples", "spanMs", "avg", "p95", "max"]),
  ...hist("channels.scheduler.lateness", ["samples", "spanMs", "p95"]),
  "channels.scheduler.dueBacklog", "channels.scheduler.catchUpBacklog", "channels.scheduler.parked",
  "channels.scheduler.open", "channels.scheduler.inFlight", "channels.scheduler.completed",
  "channels.scheduler.passes", "channels.scheduler.quarantined", "channels.scheduler.slowPasses",
  "channels.scheduler.budgetExhausted", "channels.scheduler.catchUpEpisodes",
  "channels.fleets.limit", "channels.fleets.refused", "channels.fleets.created",
  "channels.materialization.liveBattles", "channels.materialization.liveShips",
  "channels.materialization.failedBattles", "channels.materialization.strayShips",
  ...hist("channels.materialization.passMs", ["samples", "p95"]),
  ...hist("channels.materialization.spawnMs", ["samples", "p95"]),
  "capture.steps.histogramsDeferred",
]);

const FIELDS = Object.freeze(PATHS.map((p) => Object.freeze({ name: p, path: p })));

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function valueAt(snapshot, dotted) {
  let cur = snapshot;
  for (const part of dotted.split(".")) {
    if (!isObject(cur) || !Object.prototype.hasOwnProperty.call(cur, part)) return null;
    cur = cur[part];
  }
  if (typeof cur === "number") return Number.isFinite(cur) ? cur : null;
  if (typeof cur === "string" || typeof cur === "boolean") return cur;
  return null;
}

function alarmsOf(snapshot) {
  if (!Array.isArray(snapshot.alarms)) return [];
  const out = [];
  for (const a of snapshot.alarms) {
    if (isObject(a) && typeof a.id === "string" && typeof a.level === "string") out.push(`${a.level}:${a.id}`);
  }
  return [...new Set(out)].sort();
}

function extractRow(snapshot) {
  if (!isObject(snapshot) || typeof snapshot.schemaVersion !== "number") {
    return { ok: false, reason: REASONS.NOT_A_SNAPSHOT };
  }
  if (snapshot.schemaVersion !== SUPPORTED_SCHEMA_VERSION) return { ok: false, reason: REASONS.SCHEMA_UNSUPPORTED };
  const row = {};
  for (const f of FIELDS) row[f.name] = valueAt(snapshot, f.path);
  row.alarms = alarmsOf(snapshot);
  return { ok: true, row };
}

module.exports = { FIELDS, REASONS, SUPPORTED_SCHEMA_VERSION, extractRow };
