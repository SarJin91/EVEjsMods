"use strict";

const { STATE } = require("./schema");

const METRIC_REFRESHES = "abyssal.pressureRefreshes";
const METRIC_REFRESH_FAILED = "abyssal.pressureRefreshFailed";
const METRIC_REFRESH_MS = "abyssal.pressureRefreshMs";
const TOP_REGIONS_MAX = 32;
const UNAVAILABLE = "ABYSSAL_UNAVAILABLE";
const DISABLED = "PRESSURE_DISABLED";

function weightOf(state, cfg) {
  if (state === STATE.EXITED) return cfg.exitedMilli;
  if (state === STATE.FAILED) return cfg.failedMilli;
  if (state === STATE.LOST) return cfg.lostMilli;
  return 0;
}

function abyssalPressure(runs, nowMs, cfg, regionOf) {
  const out = new Map();
  for (const run of Array.isArray(runs) ? runs : []) {
    if (!run || !Number.isSafeInteger(run.sourceSystemId) || run.sourceSystemId <= 0) continue;
    if (!Number.isFinite(run.finishedAtMs)) continue;
    const weight = weightOf(run.state, cfg);
    if (!(weight > 0)) continue;
    const regionId = regionOf(run.sourceSystemId);
    if (!Number.isSafeInteger(regionId) || regionId <= 0) continue;
    const age = Math.max(0, nowMs - run.finishedAtMs);
    const milli = Math.floor(weight * Math.pow(2, -age / cfg.halfLifeMs));
    if (milli > 0) out.set(regionId, (out.get(regionId) || 0) + milli);
  }
  return out;
}

function topOf(map, limit) {
  const n = Math.max(0, Math.min(TOP_REGIONS_MAX, Number.isSafeInteger(limit) ? limit : 0));
  return [...map].filter(([, milli]) => milli > 0)
    .sort((a, b) => (b[1] - a[1]) || (a[0] - b[0]))
    .slice(0, n)
    .map(([regionId, milli]) => Object.freeze({ regionId, milli }));
}

function createPressureMemo(deps) {
  const s = deps.settings;
  const cfg = Object.freeze({ exitedMilli: s.pressureExitedMilli, failedMilli: s.pressureFailedMilli,
    lostMilli: s.pressureLostMilli, halfLifeMs: s.pressureHalfLifeMs });
  const limit = Math.min(s.pressureMaxRuns, s.maxRows);
  const telemetry = deps.telemetry || null;
  let memo = new Map();
  let atMs = null;
  let refreshes = 0;
  let failures = 0;
  let lastError = null;

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try { telemetry[kind](name, value); } catch (_err) {}
  }

  function fail(reason) {
    failures += 1;
    lastError = reason;
    metric("count", METRIC_REFRESH_FAILED, 1);
    return { ok: false, reason };
  }

  function refresh(nowMs) {
    const t0 = deps.now();
    try {
      const regionOf = deps.getRegionOf();
      if (typeof regionOf !== "function") return fail("GRAPH_NOT_READY");
      const r = deps.listFinished({ sinceMs: Math.max(-1, nowMs - s.pressureWindowMs), newest: true, limit });
      if (!r || r.ok !== true || !Array.isArray(r.runs)) return fail(String((r && r.reason) || "READ_FAILED"));
      memo = abyssalPressure(r.runs, nowMs, cfg, regionOf);
      atMs = nowMs;
      refreshes += 1;
      lastError = null;
      metric("count", METRIC_REFRESHES, 1);
      metric("observe", METRIC_REFRESH_MS, Math.max(0, deps.now() - t0));
      return { ok: true };
    } catch (err) {
      return fail(`THREW: ${String((err && err.message) || err)}`);
    }
  }

  function pressureOf(regionId) {
    return { ok: true, milli: memo.get(Number(regionId)) || 0, atMs };
  }

  function topRegions(n) {
    return { ok: true, regions: Object.freeze(topOf(memo, n)), atMs };
  }

  function getStatus() {
    return Object.freeze({ regions: memo.size, atMs, refreshes, failures, lastError });
  }

  return Object.freeze({ refresh, pressureOf, topRegions, getStatus });
}

function pressureStub(reason) {
  const refusal = Object.freeze({ ok: false, reason });
  return Object.freeze({ pressureOf: () => refusal, topRegions: () => refusal });
}

module.exports = { abyssalPressure, topOf, createPressureMemo, pressureStub, TOP_REGIONS_MAX,
  PRESSURE_UNAVAILABLE: UNAVAILABLE, PRESSURE_DISABLED: DISABLED };
