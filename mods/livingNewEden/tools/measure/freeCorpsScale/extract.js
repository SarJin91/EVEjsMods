"use strict";

const SUPPORTED_SCHEMA_VERSION = 1;
const REASONS = Object.freeze({ NOT_A_SNAPSHOT: "NOT_A_SNAPSHOT", SCHEMA_UNSUPPORTED: "SCHEMA_UNSUPPORTED",
  TELEMETRY_UNAVAILABLE: "TELEMETRY_UNAVAILABLE" });
const FREE_CORPS_SERVICE = "freeCorps";
const HIST_KEYS = Object.freeze(["samples", "spanMs", "p95", "max"]);

const hist = (prefix, keys = HIST_KEYS) => keys.map((k) => `${prefix}.${k}`);
const each = (prefix, names) => names.map((n) => `${prefix}.${n}`);

const FREE_CORPS_HISTOGRAMS = Object.freeze(["passMs", "killmailCallMs", "contractIssueMs", "joinCallMs",
  "structureCallMs", "whIndexMs", "chatterReadMs"]);
const FREE_CORPS_GAUGES = Object.freeze(["open", "founding", "openVentures", "openWars", "killmailsPending",
  "contractsOpen", "joinsPending", "structuresOpen"]);
const FREE_CORPS_COUNTERS = Object.freeze(["passes", "passFailed", "passTruncated", "casConflicts", "founded", "grew",
  "dissolved", "struggling", "ventureSteps", "ventureLost", "ventureHeld", "residentsCut", "huntSteps", "huntNoPrey",
  "skirmishes", "warsDeclared", "warsEnded", "kmCalls", "kmDone", "kmFailed", "kmBacklogDrop", "kmSlowPause",
  "touchedSkips",
  "ctIssued", "ctIssueFailed", "ctSold", "rcSlowPause", "rcJoinDone", "rcJoinFailed", "stAnchored", "stSkipIsk",
  "stFailed"]);

const PHASE_FLAG_KEYS = Object.freeze(["freeCorps.enabled", "freeCorps.ventures.enabled", "freeCorps.local.enabled",
  "freeCorps.map.enabled", "freeCorps.chatter.enabled", "freeCorps.wormholes.enabled", "freeCorps.hunting.enabled",
  "freeCorps.wars.enabled", "freeCorps.killmails.enabled", "freeCorps.contracts.enabled", "freeCorps.recycle.enabled",
  "freeCorps.structures.enabled", "capsuleers.fleetBudgetEnabled", "localPilots.enabled",
  "highsecLife.civilians.enabled", "telemetry.stallDiag.enabled",
  "virtualCorps.freeSaga.lean", "virtualCorps.freeSaga.membersStartInCorp"]);
const SETTING_KEYS = Object.freeze(["freeCorps.targetCorps", "freeCorps.membersMin", "freeCorps.membersMax",
  "freeCorps.foundingIntervalMs", "capsuleers.maxCorps", "capsuleers.membersPerCorp", "capsuleers.maxFleetsTotal",
  "capsuleers.minFleetHeadroom", "highsecLife.civilianCorps", "virtualCorps.ownerCharacterBudget",
  "limits.maxVirtualFleets", "localPilots.maxPoolCharacters"]);
const FREE_CORP_STATES = Object.freeze(["FOUNDING", "ACTIVE", "STRUGGLING", "MERGED", "DISSOLVED", "REFUSED"]);

const SNAPSHOT_PATHS = Object.freeze([
  "seq", "capturedAtMs", "startedAtMs",
  "process.uptimeSeconds", "process.rssBytes", "process.heapUsedBytes", "process.heapTotalBytes",
  "process.heap.afterMajor.count", "process.heap.afterMajor.lastUsedBytes", "process.heap.afterMajor.lastAtMs",
  ...hist("tick.intervalMs", ["samples", "spanMs", "p50", "p95", "max"]),
  ...hist("tick.workMs", ["p95", "max"]),
  "tick.sceneCount", "tick.tickedSceneCount",
  ...hist("persistence.checkpoint.ms"),
  ...hist("persistence.checkpoint.frames", ["samples", "spanMs", "avg", "p95", "max"]),
  "persistence.checkpoint.walEstimatedFrames", "persistence.txMs.p95", "persistence.tx.TX_ROW_LIMIT",
  "persistence.walPerTx.calibrated", "persistence.walPerTx.total.frames",
  "persistence.walPerTx.keys.freeCorps.frames", "persistence.walPerTx.keys.freeCorps.rows",
  "persistence.walPerTx.keys.freeCorps.tx", "persistence.walPerTx.keys.virtualCorps.frames",
  "journal.duplicates", "journal.conflicts", "telemetry.rejectedMetrics",
  "governor.mode", "governor.counts.emergencySamples", "governor.counts.unplayableSamples",
  "spikes.bySource.lne", "spikes.bySource.gc", "spikes.bySource.evejsTick", "spikes.bySource.unattributed",
  ...FREE_CORPS_HISTOGRAMS.flatMap((h) => hist(`channels.freeCorps.${h}`)),
  ...each("channels.freeCorps", FREE_CORPS_GAUGES),
  ...each("channels.freeCorps", FREE_CORPS_COUNTERS),
  ...hist("channels.virtualCorps.freeSagaSliceMs"), ...hist("channels.virtualCorps.seedMs"),
  "channels.virtualCorps.linked", "channels.virtualCorps.createdCharacters",
  "channels.virtualCorps.freeAffiliations", "channels.virtualCorps.freeCeoJoinSkipped",
  ...hist("channels.virtualCorps.freeSagaFlushMs"),
  ...each("channels.capsuleers", ["fleetBudget", "fleets", "corps", "fleetsBought"]),
  "channels.localPilots.poolTruncated",
  "channels.fleets.limit", "channels.fleets.refused",
  "channels.governor.modeChanges",
  "capture.steps.histogramsDeferred",
]);

const VIEW_KEYS = Object.freeze([
  "fleets.active", "fleets.limit", "status.overall", "status.services.freeCorps.state",
  ...each("status.flags", PHASE_FLAG_KEYS), ...each("status.settings", SETTING_KEYS),
  "freeCorpsView.state", ...each("freeCorpsView.byState", FREE_CORP_STATES), "freeCorpsView.ventures.open",
]);

const FIELDS = Object.freeze([...SNAPSHOT_PATHS, ...VIEW_KEYS].map((name) => Object.freeze({ name })));

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function rawAt(obj, dotted) {
  let cur = obj;
  for (const part of dotted.split(".")) {
    if (!isObject(cur) || !Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function scalar(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" || typeof v === "boolean") return v;
  return null;
}

function unwrap(raw) {
  if (isObject(raw) && Object.prototype.hasOwnProperty.call(raw, "ok") && Object.prototype.hasOwnProperty.call(raw, "id")
    && isObject(raw.data)) return raw.data;
  return isObject(raw) ? raw : null;
}

function snapshotOf(raw) {
  const body = unwrap(raw);
  if (body && Object.prototype.hasOwnProperty.call(body, "available")) {
    return body.available === true && isObject(body.snapshot) ? body.snapshot : null;
  }
  return body;
}

function viewOf(raw) {
  const body = unwrap(raw);
  if (!body) return null;
  if (Object.prototype.hasOwnProperty.call(body, "available") && body.available !== true) return null;
  return body;
}

function alarmsOf(snapshot) {
  if (!Array.isArray(snapshot.alarms)) return [];
  const out = [];
  for (const a of snapshot.alarms) {
    if (isObject(a) && typeof a.id === "string" && typeof a.level === "string") out.push(`${a.level}:${a.id}`);
  }
  return [...new Set(out)].sort();
}

function viewFields(row, fetched) {
  for (const key of VIEW_KEYS) row[key] = null;
  const fleets = viewOf(fetched.fleets);
  if (fleets) {
    row["fleets.active"] = scalar(rawAt(fleets, "fleets.active"));
    row["fleets.limit"] = scalar(rawAt(fleets, "fleets.limit"));
  }
  const status = viewOf(fetched.status);
  if (status) {
    row["status.overall"] = scalar(status.overall);
    const list = isObject(status.services) && Array.isArray(status.services.services) ? status.services.services : [];
    const svc = list.find((s) => isObject(s) && s.name === FREE_CORPS_SERVICE);
    row["status.services.freeCorps.state"] = svc ? scalar(svc.state) : null;
    const values = isObject(status.config) && isObject(status.config.values) ? status.config.values : null;
    if (values) {
      for (const key of PHASE_FLAG_KEYS) {
        const v = rawAt(values, key);
        row[`status.flags.${key}`] = typeof v === "boolean" ? v : null;
      }
      for (const key of SETTING_KEYS) {
        const v = rawAt(values, key);
        row[`status.settings.${key}`] = typeof v === "number" && Number.isFinite(v) ? v : null;
      }
    }
  }
  const fc = viewOf(fetched.freeCorps);
  if (fc) {
    row["freeCorpsView.state"] = scalar(fc.state);
    for (const s of FREE_CORP_STATES) {
      const v = rawAt(fc, `byState.${s}`);
      row[`freeCorpsView.byState.${s}`] = v === undefined ? 0 : scalar(v);
    }
    row["freeCorpsView.ventures.open"] = scalar(rawAt(fc, "ventures.open"));
  }
}

function extractRow(fetched) {
  const input = isObject(fetched) && Object.prototype.hasOwnProperty.call(fetched, "telemetry") ? fetched
    : { telemetry: fetched };
  const snapshot = snapshotOf(input.telemetry);
  if (snapshot === null) return { ok: false, reason: REASONS.TELEMETRY_UNAVAILABLE };
  if (typeof snapshot.schemaVersion !== "number") return { ok: false, reason: REASONS.NOT_A_SNAPSHOT };
  if (snapshot.schemaVersion !== SUPPORTED_SCHEMA_VERSION) return { ok: false, reason: REASONS.SCHEMA_UNSUPPORTED };
  const row = {};
  for (const p of SNAPSHOT_PATHS) row[p] = scalar(rawAt(snapshot, p));
  row.alarms = alarmsOf(snapshot);
  viewFields(row, input);
  row.viewErrors = Number.isSafeInteger(input.viewErrors) && input.viewErrors > 0 ? input.viewErrors : 0;
  return { ok: true, row };
}

module.exports = { FIELDS, REASONS, PHASE_FLAG_KEYS, SETTING_KEYS, FREE_CORPS_COUNTERS, FREE_CORPS_HISTOGRAMS,
  FREE_CORP_STATES, SUPPORTED_SCHEMA_VERSION, extractRow, snapshotOf, viewOf };
