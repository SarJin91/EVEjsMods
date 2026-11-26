"use strict";

const { performance } = require("node:perf_hooks");
const { SCHEMA } = require("../../config");
const { baseName, redactConfigValues, redactMessages } = require("./effectiveConfig");
const { buildInputsProblem } = require("../runtime/buildInputsCheck");

const GOVERNOR_SAMPLE_WARNINGS = Object.freeze(["no_tick_samples", "tick_samples_stale"]);
const STATUS_HIDDEN_KEYS = Object.freeze(["dataDir"]);

function statusConfigValues(config, schema) {
  const values = redactConfigValues(config || null, schema);
  if (values && typeof values === "object" && !Array.isArray(values)) {
    for (const key of STATUS_HIDDEN_KEYS) delete values[key];
  }
  return values;
}

function call(obj, name) {
  return obj && typeof obj[name] === "function" ? obj[name]() : undefined;
}

function list(value) {
  return Array.isArray(value) ? [...value] : [];
}

function servicesStatus(ctx) {
  return ctx.services && typeof ctx.services.getStatus === "function" ? ctx.services.getStatus() : null;
}

function persistenceView(ctx, services) {
  const p = ctx.persistence;
  if (p && p.ok === true && p.store) {
    const store = p.store;
    const open = call(store, "isOpen") === true && !(services && services.stopped);
    return {
      available: true, open, state: call(store, "getState") || null, stateReason: call(store, "getStateReason") || null,
      lockingMode: store.lockingMode || null, schemaVersion: call(store, "getSchemaVersion") ?? null,
      filePath: store.filePath ? baseName(store.filePath) : null,
    };
  }
  if (p) return { available: false, reason: String(p.reason || "unknown"), detail: p.detail || null };
  return { available: false, reason: "not_started" };
}

function governorView(ctx) {
  const telemetry = ctx.telemetry;
  if (!telemetry) return { pointInTime: true, available: false, status: null, warnings: ["telemetry_disabled"] };
  const snap = call(telemetry, "getSnapshot") || null;
  const gov = (snap && snap.governor) || null;
  const warnings = [];
  if (!gov) warnings.push("governor_unavailable");
  else if (GOVERNOR_SAMPLE_WARNINGS.includes(gov.reason)) warnings.push(gov.reason);
  const counts = (gov && gov.counts) || {};
  const tickMax = snap && snap.tick && snap.tick.intervalMs ? snap.tick.intervalMs.max : null;
  return {
    pointInTime: true, available: true,
    capturedAtMs: snap ? snap.capturedAtMs : null, intervalMs: snap ? snap.intervalMs : null,
    status: gov,
    perTick: { emergencySamples: counts.emergencySamples ?? null, unplayableSamples: counts.unplayableSamples ?? null },
    tickIntervalMaxMs: tickMax ?? null,
    warnings,
  };
}

function buildStatusView(deps) {
  const ctx = deps.ctx;
  const schema = Array.isArray(deps.schema) ? deps.schema : SCHEMA;
  return {
    title: "Mod status",
    order: 0,
    getData() {
      const services = servicesStatus(ctx);
      const configResult = (ctx.state && ctx.state.configResult) || {};
      const persistence = persistenceView(ctx, services);
      const governor = governorView(ctx);
      const snap = ctx.telemetry ? call(ctx.telemetry, "getSnapshot") : null;
      const problems = [];
      const serviceList = services ? services.services : [];
      for (const s of serviceList) {
        if (s.state === "failed") problems.push(`service ${s.name} failed: ${s.reason}`);
      }
      if (persistence.available && persistence.state === "suspended") {
        problems.push(`persistence suspended: ${persistence.stateReason}`);
      }
      for (const alarm of (snap && Array.isArray(snap.alarms) ? snap.alarms : [])) {
        if (alarm.level === "error") problems.push(`alarm ${alarm.id}: ${alarm.message}`);
      }
      const telemetryService = serviceList.find((s) => s.name === "telemetry");
      const telemetryOff = telemetryService && telemetryService.state === "disabled";
      for (const w of governor.warnings) {
        if (!(w === "telemetry_disabled" && telemetryOff)) problems.push(`governor: ${w}`);
      }
      const buildInputs = (ctx.state && ctx.state.buildInputs) || { state: "not_run" };
      const buildProblem = buildInputsProblem(buildInputs);
      if (buildProblem) problems.push(buildProblem);
      let overall = problems.length > 0 ? "degraded" : "ok";
      if (services && services.refusal) {
        overall = "refused";
        problems.unshift(`mod refused: ${services.refusal}`);
      }
      const gate = ctx.state && ctx.state.bootGate;
      return {
        overall,
        problems,
        mod: { version: ctx.modVersion || null, pid: process.pid, gate: (gate && gate.diag) || null },
        services: services || { available: false, reason: "registry_unavailable" },
        probe: ctx.adapter ? call(ctx.adapter, "getProbeReport") || null : null,
        config: {
          values: statusConfigValues(ctx.config, schema),
          sources: configResult.sources || {},
          warnings: redactMessages(list(configResult.warnings), schema),
          errors: redactMessages(list(configResult.errors), schema),
        },
        persistence,
        governor,
        buildInputs,
        observer: deps.getObserverStats(),
      };
    },
  };
}

function buildTelemetryView(deps) {
  const ctx = deps.ctx;
  return {
    title: "Telemetry",
    order: 10,
    cacheKey() {
      const snap = ctx.telemetry ? call(ctx.telemetry, "getSnapshot") : null;
      if (!ctx.telemetry) return "disabled";
      return snap ? snap.seq : "none";
    },
    getData() {
      if (!ctx.telemetry) return { available: false, reason: "telemetry_disabled" };
      return { available: true, snapshot: call(ctx.telemetry, "getSnapshot") || null };
    },
  };
}

function toEntry(entry, payloadChars) {
  let text;
  try {
    text = JSON.stringify(entry.payload);
  } catch (_err) {
    text = "";
  }
  text = text === undefined ? "" : text;
  return {
    journalId: entry.journalId, key: entry.key, kind: entry.kind, aggregateType: entry.aggregateType,
    aggregateId: entry.aggregateId, eventType: entry.eventType, state: entry.state, createdAt: entry.createdAt,
    appliedAt: entry.appliedAt, error: entry.error,
    payloadPreview: text.slice(0, payloadChars), payloadTruncated: text.length > payloadChars,
  };
}

function buildJournalView(deps) {
  const ctx = deps.ctx;
  const { journalLimit, journalCacheMs, journalPayloadChars } = deps.config;
  const now = typeof deps.now === "function" ? deps.now : () => performance.now();
  return {
    title: "Event journal",
    order: 20,
    cacheKey(req) {
      return journalCacheMs > 0 ? Math.floor(req.nowMs / journalCacheMs) : null;
    },
    getData() {
      const p = ctx.persistence;
      if (!p || p.ok !== true || !p.store || !p.journal) {
        return { available: false, reason: String((p && p.reason) || "persistence_not_started") };
      }
      const store = p.store;
      const services = servicesStatus(ctx);
      if (call(store, "isOpen") !== true || (services && services.stopped)) {
        return { available: false, reason: "STORE_CLOSED", stateReason: call(store, "getStateReason") || null };
      }
      const t0 = now();
      const r = store.transaction("observer.journal", (tx) => p.journal.listRecent(tx, { limit: journalLimit }));
      const ms = Math.max(0, now() - t0);
      if (typeof deps.onJournalMs === "function") deps.onJournalMs(ms);
      if (ctx.telemetry && typeof ctx.telemetry.observe === "function") ctx.telemetry.observe("observer.journalMs", ms);
      if (!r || !r.ok) {
        return { available: false, reason: String((r && r.reason) || "TX_FAILED"),
          detail: (r && (r.detail || (r.error && r.error.message))) || null };
      }
      const listed = r.value;
      if (!listed || !listed.ok) {
        return { available: false, reason: String((listed && listed.reason) || "JOURNAL_FAILED"),
          detail: (listed && listed.detail) || null };
      }
      const entries = listed.entries.map((e) => toEntry(e, journalPayloadChars));
      const ids = entries.map((e) => e.journalId);
      return {
        available: true, mode: "latest", limit: listed.limit, count: entries.length,
        newestId: ids.length > 0 ? Math.max(...ids) : null, oldestId: ids.length > 0 ? Math.min(...ids) : null,
        txMs: Math.round(ms * 1000) / 1000, entries,
      };
    },
  };
}

module.exports = { buildStatusView, buildTelemetryView, buildJournalView };
