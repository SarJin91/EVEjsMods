"use strict";

const { pickWindows, counterDelta, slopePerHour, auditSummaryOf } = require("../../scaling/aggregate");
const { PHASE_FLAG_KEYS, SETTING_KEYS, FREE_CORPS_COUNTERS } = require("./extract");
const { deferredMark } = require("../histogramsDeferred");

const MS_PER_HOUR = 3600000;
const MS_PER_SECOND = 1000;
const SECONDS_PER_HOUR = 3600;
const HOURS_PER_DAY = 24;
const BYTES_PER_MB = 1024 * 1024;
const BYTES_PER_GIB = 1024 * 1024 * 1024;
const DEFAULT_EVERY_S = 300;
const STALL_LINES_KEPT = 20;
const SERVER_NAME_PART = "server";
const RUNNING = "running";
const FC = "channels.freeCorps";

function deepFreeze(v) {
  if (v !== null && typeof v === "object" && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const k of Object.keys(v)) deepFreeze(v[k]);
  }
  return v;
}

const THRESHOLDS = deepFreeze({
  common: { warmupS: 1800, minCoverageH: 20, earlyCoverageH: 2, gapFactor: 2, steadyShare: 0.95,
    minWindowSamples: 20, heapWindowH: 2, heapMinSegmentH: 6, walPagesPerRow: 3, badTickP95Ms: 130 },
  G1: { start: { p95Ms: 105 }, stretch: { p95Ms: 110 } },
  G1b: { start: { maxWindows: 2 }, stretch: { maxWindows: 2 } },
  G2: { start: { p95Ms: 4, maxMs: 20 }, stretch: { p95Ms: 6, maxMs: 30 } },
  G3: { start: { framesPerS: 200 }, stretch: { framesPerS: 200 } },
  G3b: { start: { rowsPerS: 10 }, stretch: { rowsPerS: 20 } },
  G3c: { start: { factor: 1.25, slackMs: 2 }, stretch: { factor: 1.25, slackMs: 2 } },
  G4: { start: { p95Ms: 20, maxMs: 250 }, stretch: { p95Ms: 20, maxMs: 250 } },
  G5: { start: { heapDeltaMb: 100, rssGiB: 7.0 }, stretch: { heapDeltaMb: 300, rssGiB: 8.0 } },
  G6: { start: { modeChanges: 3, emergencySamples: 0 }, stretch: { modeChanges: 3, emergencySamples: 0 } },
  G9: { start: { perHour: 6, p95Ms: 100, maxMs: 500, slowPause: 0 },
    stretch: { perHour: 12, p95Ms: 100, maxMs: 500, slowPause: 0 } },
  G10: { start: { open: 40, p95Ms: 100 }, stretch: { open: 120, p95Ms: 100 } },
  G11: { start: { p95Ms: 100, slowPause: 0 }, stretch: { p95Ms: 100, slowPause: 0 } },
  G12: { start: { open: 8, p95Ms: 100 }, stretch: { open: 8, p95Ms: 100 } },
  early: { badWindows: 2, sagaP95Ms: 20, rssWorldGiB: 9 },
  entry: { S4: { fleetsActiveMax: 790 } },
});

const PHASE_FLAGS = deepFreeze({
  core: { "freeCorps.enabled": true, "freeCorps.ventures.enabled": true, "freeCorps.local.enabled": true,
    "freeCorps.map.enabled": true, "freeCorps.chatter.enabled": true, "freeCorps.wormholes.enabled": true,
    "freeCorps.hunting.enabled": false, "freeCorps.wars.enabled": false, "freeCorps.killmails.enabled": false,
    "freeCorps.contracts.enabled": false, "freeCorps.recycle.enabled": false, "freeCorps.structures.enabled": false },
  pvp: { "freeCorps.enabled": true, "freeCorps.ventures.enabled": true, "freeCorps.local.enabled": true,
    "freeCorps.map.enabled": true, "freeCorps.chatter.enabled": true, "freeCorps.wormholes.enabled": true,
    "freeCorps.hunting.enabled": true, "freeCorps.wars.enabled": true, "freeCorps.killmails.enabled": true,
    "freeCorps.contracts.enabled": false, "freeCorps.recycle.enabled": false, "freeCorps.structures.enabled": false },
  full: { "freeCorps.enabled": true, "freeCorps.ventures.enabled": true, "freeCorps.local.enabled": true,
    "freeCorps.map.enabled": true, "freeCorps.chatter.enabled": true, "freeCorps.wormholes.enabled": true,
    "freeCorps.hunting.enabled": true, "freeCorps.wars.enabled": true, "freeCorps.killmails.enabled": true,
    "freeCorps.contracts.enabled": true, "freeCorps.recycle.enabled": true, "freeCorps.structures.enabled": true },
});

const LADDER = deepFreeze([
  { step: "S0", env: [], planCharacters: 760 },
  { step: "S1", env: ["EVEJS_LNE_FREE_CORPS_TARGET_CORPS=150"], planCharacters: 1210 },
  { step: "S2", env: ["EVEJS_LNE_FREE_CORPS_TARGET_CORPS=400", "EVEJS_LNE_FREE_CORPS_MEMBERS_MAX=9",
    "EVEJS_LNE_VIRTUAL_CORPS_OWNER_CHARACTER_BUDGET=3500"], planCharacters: 2860 },
  { step: "S3", env: ["EVEJS_LNE_HIGHSEC_LIFE_CIVILIAN_CORPS=60"], planCharacters: 3060 },
  { step: "S4", env: ["EVEJS_LNE_CAPSULEERS_MAX_CORPS=32", "EVEJS_LNE_CAPSULEERS_MEMBERS_PER_CORP=6",
    "EVEJS_LNE_CAPSULEERS_MAX_FLEETS_TOTAL=96"], planCharacters: 3250 },
]);
const STEPS = Object.freeze(LADDER.map((s) => s.step));
const FULL_ONLY_FLAGS = Object.freeze(["freeCorps.contracts.enabled", "freeCorps.recycle.enabled",
  "freeCorps.structures.enabled"]);

const HOLD_TABLE = deepFreeze({
  G0: { cause: "correctness (pass failed, journal conflict, error alarm, audit)", knob: "feature flag = 0",
    task: "bug report with the log and the audit" },
  G1: { cause: "saga, vendor pumps, pass", knob: "feature flags one by one (kill switch)",
    task: "bug report with a stall-diag profile" },
  G2: { cause: "listPreyInTx, skirmishes, WH index", knob: "maxSkirmishesPerPass, maxPreyRows, maxCorpsPerPass, maxPassMs",
    task: "freeCorps pass performance work" },
  G3: { cause: "periodic writes", knob: "passMs up, maxCorpsPerPass down",
    task: "module share from persistence.walPerTx, then "
      + "work on this module's writes" },
  G3c: { cause: "checkpoint slower than in the previous step", knob: "passMs up, maxCorpsPerPass down",
    task: "per-module WAL work" },
  G4: { cause: "reserveCharacterID (scan of 4 tables + sync flush)",
    knob: "foundingIntervalMs up, virtualCorps.seedOpsPerSlice down",
    task: "free saga cost: + recycling, research on saga slicing" },
  G5: { cause: "heap / RSS", knob: "-", task: "heap audit (research/heapAudit/, template)" },
  G6: { cause: "tick spikes", knob: "feature flags one by one (kill switch)",
    task: "bug report with a stall-diag profile" },
  G7: { cause: "Local pool", knob: "localPilots.maxPoolCharacters up", task: "-" },
  G8: { cause: "capsuleer fleets", knob: "capsuleers.maxFleetsTotal down", task: "-" },
  G9: { cause: "vendor calls (killmails)", knob: "maxPerHour / *SpacingMs up, feature flag = 0",
    task: "killmail seam work" },
  G10: { cause: "vendor calls (contracts)", knob: "maxPerHour / *SpacingMs up, feature flag = 0",
    task: "contract seam work" },
  G11: { cause: "vendor calls (recycling)", knob: "maxPerHour / *SpacingMs up, feature flag = 0",
    task: "recycling seam work" },
  G12: { cause: "vendor calls (structures)", knob: "maxPerHour / *SpacingMs up, feature flag = 0",
    task: "structure seam work" },
  G13: { cause: "character budget", knob: "virtualCorps.ownerCharacterBudget up (<= 16384)", task: "-" },
});

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const arr = (v) => (Array.isArray(v) ? v : []);

function round(n, digits) {
  if (!isNum(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function median(values) {
  if (values.length === 0) return null;
  const s = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

const maxOf = (values) => (values.length === 0 ? null : Math.max(...values));
const numbers = (rows, key) => rows.map((r) => r[key]).filter(isNum);
const fmt = (v) => (isNum(v) ? String(Number(v.toFixed(3))) : "-");

const UNIT_BYTES = Object.freeze({ B: 1, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4, KB: 1e3, MB: 1e6,
  GB: 1e9, TB: 1e12 });
const MEM_RE = /([\d.]+)\s*([KMGT]?i?B)\s*\/\s*([\d.]+)\s*([KMGT]?i?B)/i;
const CPU_RE = /([\d.]+)%/;

function bytesOf(n, unit) {
  const k = UNIT_BYTES[String(unit).toUpperCase()];
  const v = Number(n);
  return k !== undefined && Number.isFinite(v) ? v * k : null;
}

function parseDockerStats(text) {
  for (const line of String(text || "").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const name = trimmed.split(/\s+/u)[0];
    if (!name.includes(SERVER_NAME_PART)) continue;
    const m = MEM_RE.exec(trimmed.slice(name.length));
    if (!m) continue;
    const usedBytes = bytesOf(m[1], m[2]);
    const limitBytes = bytesOf(m[3], m[4]);
    if (usedBytes === null || limitBytes === null) continue;
    const cpu = CPU_RE.exec(trimmed.slice(name.length + m.index + m[0].length));
    return { name, usedBytes, limitBytes, cpuPercent: cpu ? Number(cpu[1]) : null };
  }
  return null;
}

const SPIKE_RE = /telemetry: spike .*source=([A-Za-z0-9_]+)/u;

function parseLog(text) {
  if (typeof text !== "string") return null;
  const out = { passFailed: 0, ensureFailed: 0, pumpNotStarted: 0, spikesBySource: {}, stallDiag: 0,
    stallDiagLines: [], txRowLimit: 0 };
  for (const line of text.split(/\r?\n/u)) {
    if (line.includes("freeCorps: pass failed")) out.passFailed += 1;
    if (line.includes("freeCorps: ensureOwnerIdentity failed")) out.ensureFailed += 1;
    if (line.includes("freeCorps: killmail pump not started")) out.pumpNotStarted += 1;
    const spike = line.includes("telemetry: spike ") ? SPIKE_RE.exec(line) : null;
    if (spike) out.spikesBySource[spike[1]] = (out.spikesBySource[spike[1]] || 0) + 1;
    if (line.includes("telemetry: stall-diag ")) {
      out.stallDiag += 1;
      if (out.stallDiagLines.length < STALL_LINES_KEPT) out.stallDiagLines.push(line.trim());
    }
    if (line.includes("TX_ROW_LIMIT")) out.txRowLimit += 1;
  }
  return out;
}

function everySOf(headers) {
  const v = arr(headers).filter(isObject).map((h) => h.everyS).filter((n) => isNum(n) && n > 0);
  return v.length > 0 ? Math.max(...v) : DEFAULT_EVERY_S;
}

function coverageHours(rows, everyS, gapFactor) {
  const maxGap = gapFactor * everyS * MS_PER_SECOND;
  let ms = 0;
  for (let i = 1; i < rows.length; i += 1) {
    const a = rows[i - 1];
    const b = rows[i];
    if (a.startedAtMs !== b.startedAtMs || !isNum(a.capturedAtMs) || !isNum(b.capturedAtMs)) continue;
    const gap = b.capturedAtMs - a.capturedAtMs;
    if (gap > 0 && gap <= maxGap) ms += gap;
  }
  return ms / MS_PER_HOUR;
}

function lastValue(rows, key) {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const v = rows[i][key];
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

function counterOf(rows, key) {
  const present = rows.some((r) => isNum(r[key]));
  if (!present) return { delta: null, present };
  const mapped = rows.map((r) => ({ startedAtMs: r.startedAtMs, [key]: isNum(r[key]) ? r[key] : 0 }));
  return { delta: counterDelta(mapped, key).delta, present };
}
const delta0 = (c) => (c && isNum(c.delta) ? c.delta : 0);

function lastPerSegment(rows) {
  const last = new Map();
  for (const r of rows) last.set(r.startedAtMs, r);
  return [...last.values()];
}

function walMeasuredOf(steady, everyS, gapFactor) {
  const rows = steady.filter((r) => r["persistence.walPerTx.calibrated"] === true);
  const hours = coverageHours(rows, everyS, gapFactor);
  if (rows.length === 0 || !(hours > 0)) return null;
  const perS = (path) => {
    const c = counterOf(rows, path);
    return isNum(c.delta) ? round(c.delta / (hours * SECONDS_PER_HOUR), 3) : null;
  };
  const fc = perS("persistence.walPerTx.keys.freeCorps.frames");
  const vc = perS("persistence.walPerTx.keys.virtualCorps.frames");
  const total = perS("persistence.walPerTx.total.frames");
  const share = (v) => (isNum(v) && isNum(total) && total > 0 ? round(v / total, 4) : null);
  return { fcFramesPerS: fc, vcFramesPerS: vc, totalFramesPerS: total, fcShare: share(fc), vcShare: share(vc),
    hours: round(hours, 2) };
}

function histStat(rows, path, minSamples) {
  const sKey = `${path}.samples`;
  const pKey = `${path}.p95`;
  const withSamples = rows.filter((r) => isNum(r[sKey]) && r[sKey] > 0);
  if (withSamples.length === 0) {
    return { state: "NO_DATA", p95Worst: null, p95Median: null, max: null, windows: 0, source: null };
  }
  const good = pickWindows(withSamples, path).filter((r) => r[sKey] >= minSamples && isNum(r[pKey]));
  let p95s = good.map((r) => r[pKey]);
  let source = "windows";
  if (p95s.length === 0) {
    p95s = numbers(lastPerSegment(withSamples), pKey);
    source = "segments";
  }
  const mark = deferredMark(source === "windows" ? good : lastPerSegment(withSamples));
  return { state: "OK", p95Worst: maxOf(p95s), p95Median: round(median(p95s), 3),
    max: maxOf(numbers(withSamples, `${path}.max`)), windows: good.length, source,
    histogramsDeferred: mark.histogramsDeferred, deferredWindows: mark.deferredWindows };
}

function tickOf(rows, badMs) {
  const windows = pickWindows(rows, "tick.intervalMs");
  const p95s = numbers(windows, "tick.intervalMs.p95");
  const mark = deferredMark(windows.filter((r) => isNum(r["tick.intervalMs.p95"])));
  return { p95Median: round(median(p95s), 2), p95Worst: maxOf(p95s), max: maxOf(numbers(rows, "tick.intervalMs.max")),
    windows: p95s.length, windowsOver: p95s.filter((p) => p > badMs).length,
    sceneCountMax: maxOf(numbers(rows, "tick.sceneCount")),
    histogramsDeferred: mark.histogramsDeferred, deferredWindows: mark.deferredWindows };
}

function heapOf(rows, C) {
  const key = "process.heap.afterMajor.lastUsedBytes";
  const segments = new Map();
  for (const r of rows) {
    if (!isNum(r.capturedAtMs)) continue;
    if (!segments.has(r.startedAtMs)) segments.set(r.startedAtMs, []);
    segments.get(r.startedAtMs).push(r);
  }
  let best = null;
  for (const seg of segments.values()) {
    const len = seg[seg.length - 1].capturedAtMs - seg[0].capturedAtMs;
    if (best === null || len > best.len) best = { seg, len };
  }
  if (best === null) return { deltaMb: null, slopeMbPer24h: null, segmentHours: 0, mode: "none" };
  const seg = best.seg;
  const hours = best.len / MS_PER_HOUR;
  const points = seg.filter((r) => isNum(r[key])).map((r) => ({ atMs: r.capturedAtMs, value: r[key] / BYTES_PER_MB }));
  const slope = points.length >= 2 ? round(slopePerHour(points) * HOURS_PER_DAY, 1) : null;
  if (hours < C.heapMinSegmentH) return { deltaMb: null, slopeMbPer24h: slope, segmentHours: round(hours, 2), mode: "slope" };
  const win = C.heapWindowH * MS_PER_HOUR;
  const t0 = seg[0].capturedAtMs;
  const t1 = seg[seg.length - 1].capturedAtMs;
  const first = median(points.filter((p) => p.atMs <= t0 + win).map((p) => p.value));
  const last = median(points.filter((p) => p.atMs >= t1 - win).map((p) => p.value));
  return { deltaMb: first !== null && last !== null ? round(last - first, 1) : null, slopeMbPer24h: slope,
    segmentHours: round(hours, 2), mode: "afterMajor" };
}

function linkedOf(census) {
  if (!isObject(census) || !isObject(census.identities) || !Array.isArray(census.identities.rows)) return null;
  const out = { capsuleer: 0, civilian: 0, free: 0, faction: 0 };
  for (const r of census.identities.rows) {
    if (!isObject(r) || r.kind !== "character" || r.state !== "linked" || !isNum(r.n)) continue;
    out[r.ownerKind] = (out[r.ownerKind] || 0) + r.n;
  }
  out.owners = out.capsuleer + out.civilian + out.free;
  return out;
}

const SAFETY_COUNTERS = Object.freeze(["journal.conflicts", "telemetry.rejectedMetrics", "governor.counts.emergencySamples",
  "channels.governor.modeChanges", `${FC}.passFailed`, `${FC}.founded`, `${FC}.kmSlowPause`, `${FC}.rcSlowPause`]);
const STEADY_COUNTERS = Object.freeze([...FREE_CORPS_COUNTERS.map((n) => `${FC}.${n}`),
  "channels.localPilots.poolTruncated", "channels.capsuleers.fleetBudget", "channels.fleets.limit",
  "channels.fleets.refused"]);
const HISTOGRAMS = Object.freeze({ passMs: `${FC}.passMs`, killmailCallMs: `${FC}.killmailCallMs`,
  contractIssueMs: `${FC}.contractIssueMs`, joinCallMs: `${FC}.joinCallMs`, structureCallMs: `${FC}.structureCallMs`,
  whIndexMs: `${FC}.whIndexMs`, chatterReadMs: `${FC}.chatterReadMs` });
const WAL_ROW_COUNTERS = Object.freeze(["ventureSteps", "huntSteps", "skirmishes", "founded", "grew", "kmDone",
  "ctIssued", "stAnchored"]);

function summarize(input, thresholds = THRESHOLDS) {
  const C = thresholds.common;
  const src = isObject(input) ? input : {};
  const everyS = everySOf(src.headers);
  const all = arr(src.rows).filter(isObject).slice()
    .sort((a, b) => (isNum(a.capturedAtMs) ? a.capturedAtMs : 0) - (isNum(b.capturedAtMs) ? b.capturedAtMs : 0));
  const measured = all.filter((r) => isNum(r["process.uptimeSeconds"]) && r["process.uptimeSeconds"] >= C.warmupS);

  const flags = {};
  for (const k of PHASE_FLAG_KEYS) {
    const v = lastValue(all, `status.flags.${k}`);
    flags[k] = typeof v === "boolean" ? v : null;
  }
  const settings = {};
  for (const k of SETTING_KEYS) {
    const v = lastValue(all, `status.settings.${k}`);
    settings[k] = isNum(v) ? v : null;
  }
  const fcOn = flags["freeCorps.enabled"] === true;
  const target = settings["freeCorps.targetCorps"];
  let steadyFrom = 0;
  let steadyRule = "whole window";
  if (fcOn && isNum(target) && target > 0) {
    steadyFrom = measured.findIndex((r) => isNum(r[`${FC}.open`]) && r[`${FC}.open`] >= C.steadyShare * target);
    steadyRule = `open >= ${C.steadyShare} x ${target}`;
  }
  const steady = steadyFrom < 0 ? [] : measured.slice(steadyFrom);
  const steadyHours = coverageHours(steady, everyS, C.gapFactor);

  const safety = {};
  for (const k of SAFETY_COUNTERS) safety[k] = counterOf(measured, k);
  const counters = {};
  for (const k of STEADY_COUNTERS) {
    const c = counterOf(steady, k);
    counters[k] = { delta: c.delta, present: c.present,
      perHour: isNum(c.delta) && steadyHours > 0 ? round(c.delta / steadyHours, 3) : null };
  }

  const histograms = {};
  for (const [name, path] of Object.entries(HISTOGRAMS)) histograms[name] = histStat(steady, path, C.minWindowSamples);
  const saga = histStat(measured, "channels.virtualCorps.freeSagaSliceMs", C.minWindowSamples);

  const walWindows = pickWindows(steady, "persistence.checkpoint.frames")
    .filter((r) => isNum(r["persistence.checkpoint.frames.avg"]) && isNum(r["persistence.checkpoint.frames.samples"]));
  let frames = 0;
  let spanMs = 0;
  for (const r of walWindows) {
    frames += r["persistence.checkpoint.frames.avg"] * r["persistence.checkpoint.frames.samples"];
    spanMs += r["persistence.checkpoint.frames.spanMs"];
  }
  const fcRows = WAL_ROW_COUNTERS.reduce((s, n) => s + delta0(counters[`${FC}.${n}`]), 0);
  const wal = { windows: walWindows.length,
    framesPerS: walWindows.length > 0 && spanMs > 0 ? round(frames / (spanMs / MS_PER_SECOND), 2) : null,
    fcRowsPerSEstimate: steadyHours > 0 ? round((fcRows * C.walPagesPerRow) / steadyHours / SECONDS_PER_HOUR, 3) : null,
    measured: walMeasuredOf(steady, everyS, C.gapFactor) };
  const checkpoint = histStat(steady, "persistence.checkpoint.ms", 1);

  const lastHour = measured.length > 0 && isNum(measured[measured.length - 1].capturedAtMs)
    ? measured.filter((r) => r.capturedAtMs >= measured[measured.length - 1].capturedAtMs - MS_PER_HOUR) : [];
  const dockerStart = parseDockerStats(src.dockerStart);
  const dockerEnd = parseDockerStats(src.dockerEnd);
  const auditSum = src.audit === null || src.audit === undefined ? null : auditSummaryOf(src.audit);

  const segmentsFirst = new Map();
  for (const r of all) if (!segmentsFirst.has(r.startedAtMs)) segmentsFirst.set(r.startedAtMs, r);

  return {
    rows: all.length,
    measuredRows: measured.length,
    steadyRows: steady.length,
    segments: arr(src.headers).length,
    restarts: Math.max(0, segmentsFirst.size - 1),
    everyS,
    viewErrors: all.reduce((s, r) => s + (isNum(r.viewErrors) ? r.viewErrors : 0), 0),
    readErrors: arr(src.footers).filter(isObject).reduce((s, f) => s + (isNum(f.readErrors) ? f.readErrors : 0), 0),
    coverage: { measuredHours: round(coverageHours(measured, everyS, C.gapFactor), 2), steadyHours: round(steadyHours, 2),
      steadyReached: steadyFrom >= 0, steadyRule,
      steadyFromAtMs: steady.length > 0 ? steady[0].capturedAtMs : null },
    flags,
    settings,
    service: { overall: lastValue(all, "status.overall"), freeCorpsState: lastValue(all, "status.services.freeCorps.state") },
    tick: tickOf(steady, C.badTickP95Ms),
    tickAll: tickOf(measured, C.badTickP95Ms),
    histograms,
    saga,
    seedMs: [...segmentsFirst.values()].map((r) => r["channels.virtualCorps.seedMs.max"]).filter(isNum),
    safety: Object.fromEntries(Object.entries(safety).map(([k, c]) => [k, c.delta])),
    counters,
    wal,
    checkpoint: { p95Ms: checkpoint.p95Median, max: checkpoint.max, state: checkpoint.state },
    heap: heapOf(steady, C),
    rss: { containerStartBytes: dockerStart ? dockerStart.usedBytes : null,
      containerEndBytes: dockerEnd ? dockerEnd.usedBytes : null,
      containerLimitBytes: dockerEnd ? dockerEnd.limitBytes : null,
      worldMedianLastHourBytes: median(numbers(lastHour, "process.rssBytes")),
      worldMaxBytes: maxOf(numbers(measured, "process.rssBytes")) },
    gauges: { freeCorpsOpenLast: lastValue(measured, `${FC}.open`), freeCorpsOpenMax: maxOf(numbers(steady, `${FC}.open`)),
      foundingMax: maxOf(numbers(steady, `${FC}.founding`)),
      contractsOpenMax: maxOf(numbers(steady, `${FC}.contractsOpen`)),
      structuresOpenMax: maxOf(numbers(steady, `${FC}.structuresOpen`)),
      capsuleerFleetsMax: maxOf(numbers(steady, "channels.capsuleers.fleets")),
      fleetsActiveMax: maxOf(numbers(steady, "fleets.active")),
      strugglingLast: lastValue(all, "freeCorpsView.byState.STRUGGLING"),
      linkedLast: lastValue(measured, "channels.virtualCorps.linked") },
    alarms: [...new Set(measured.flatMap((r) => arr(r.alarms)))].sort(),
    identities: { start: linkedOf(src.censusStart), end: linkedOf(src.censusEnd) },
    log: parseLog(src.logText),
    audit: auditSum && auditSum.ok ? { duplicateSettlements: auditSum.duplicateSettlements, errors: auditSum.errors }
      : auditSum ? { invalid: auditSum.reason } : null,
    inputs: { censusStart: isObject(src.censusStart), censusEnd: isObject(src.censusEnd),
      dockerStart: dockerStart !== null, dockerEnd: dockerEnd !== null, log: typeof src.logText === "string",
      audit: auditSum !== null },
  };
}

function makeGate(id, blocking) {
  return { id, status: "PASS", blocking, lines: [] };
}
function failG(g, text) {
  g.status = "FAIL";
  g.lines.push(`FAIL ${g.id} ${text}`);
}
function noteG(g, text) {
  g.lines.push(`${g.id} ${text}`);
}
function na(id, why) {
  return { id, status: "N/A", blocking: false, lines: [`N/A ${id} ${why}`] };
}

function histGate(g, name, h, p95Ms, maxMs, maxStrict) {
  if (!h || h.state === "NO_DATA" || !isNum(h.p95Worst)) {
    failG(g, `${name} no data (flag on, NO_DATA)`);
    return;
  }
  const line = `${name} p95 ${fmt(h.p95Worst)} ms (${h.source}, windows ${h.windows}) / max ${fmt(h.max)} ms`;
  if (h.p95Worst > p95Ms) failG(g, `${name} p95 ${fmt(h.p95Worst)} > ${p95Ms} ms`);
  if (isNum(maxMs) && isNum(h.max) && (maxStrict ? h.max >= maxMs : h.max > maxMs)) {
    failG(g, `${name} max ${fmt(h.max)} ${maxStrict ? ">=" : ">"} ${maxMs} ms`);
  }
  noteG(g, line);
}

function phaseMismatch(summary, phase) {
  const want = PHASE_FLAGS[phase];
  const out = [];
  for (const [k, v] of Object.entries(want)) {
    const got = summary.flags[k];
    const ok = v === true ? got === true : got === false || got === null;
    if (!ok) out.push(`--phase ${phase}: ${k}=${got} (expected ${v})`);
  }
  return out;
}

function flagOn(summary, key) {
  return summary.flags[key] === true;
}

function earlyVerdict(s, T) {
  const E = T.early;
  if (!(s.coverage.measuredHours >= T.common.earlyCoverageH)) {
    const missing = [`coverage ${fmt(s.coverage.measuredHours)} h < ${T.common.earlyCoverageH} h (--early)`];
    return { verdict: "INCOMPLETE", early: true, missing, gates: {}, lines: missing.map((m) => `MISSING ${m}`) };
  }
  const lines = [];
  const abort = (text) => lines.push(`ABORT ${text}`);
  if (s.tickAll.windowsOver >= E.badWindows) {
    abort(`tick p95 windows > ${T.common.badTickP95Ms} ms: ${s.tickAll.windowsOver} >= ${E.badWindows}`);
  }
  const emergency = s.safety["governor.counts.emergencySamples"] || 0;
  if (emergency > 0) abort(`governor emergencySamples ${emergency} > 0`);
  const founded = s.safety[`${FC}.founded`] || 0;
  if (founded > 0 && isNum(s.saga.p95Worst) && s.saga.p95Worst > E.sagaP95Ms) {
    abort(`saga freeSagaSliceMs p95 ${fmt(s.saga.p95Worst)} > ${E.sagaP95Ms} ms with founded ${founded}`);
  }
  const rssLimit = E.rssWorldGiB * BYTES_PER_GIB;
  if (isNum(s.rss.worldMaxBytes) && s.rss.worldMaxBytes > rssLimit) {
    abort(`world RSS ${fmt(s.rss.worldMaxBytes / BYTES_PER_GIB)} GiB > ${E.rssWorldGiB} GiB`);
  }
  const pauses = (s.safety[`${FC}.kmSlowPause`] || 0) + (s.safety[`${FC}.rcSlowPause`] || 0);
  if (pauses > 0) abort(`slow-call self-pauses (kmSlowPause + rcSlowPause) ${pauses} > 0`);
  const passFailed = s.safety[`${FC}.passFailed`] || 0;
  if (passFailed > 0) abort(`freeCorps passFailed ${passFailed} > 0`);
  return { verdict: lines.length > 0 ? "ABORT" : "CONTINUE", early: true, missing: [], gates: {}, lines };
}

function entryCheck(summary, step, T) {
  const at = STEPS.indexOf(typeof step === "string" && STEPS.includes(step) ? step : STEPS[0]);
  const next = at + 1 < STEPS.length ? STEPS[at + 1] : null;
  const lines = [];
  let ok = true;
  const lim = isObject(T.entry) && isObject(T.entry[next]) ? T.entry[next] : {};
  if (isNum(lim.fleetsActiveMax)) {
    const got = summary && isObject(summary.gauges) ? summary.gauges.fleetsActiveMax : null;
    if (!isNum(got) || got > lim.fleetsActiveMax) {
      ok = false;
      lines.push(`ENTRY ${next} not met: fleets.active max in ${STEPS[at]} ${fmt(got)} > ${lim.fleetsActiveMax}`);
    } else lines.push(`ENTRY ${next}: fleets.active max in ${STEPS[at]} ${fmt(got)} <= ${lim.fleetsActiveMax}`);
  }
  if (next === "S2") {
    const full = summary && isObject(summary.flags) && phaseMismatch(summary, "full").length === 0;
    lines.push(full ? "ENTRY S2: phase full GO - flags allowed in S2"
      : `ENTRY S2: no GO for phase full - in S2 ${FULL_ONLY_FLAGS.join(", ")} stay off`);
  }
  return { next, ok, lines };
}

function verdict(summary, opts = {}) {
  const T = opts.thresholds || THRESHOLDS;
  const s = summary;
  const target = opts.target;
  const missing = [];
  if (target !== "start" && target !== "stretch") missing.push(`--target ${target} (start|stretch)`);
  if (opts.phase !== undefined && opts.phase !== null && !PHASE_FLAGS[opts.phase]) missing.push(`--phase ${opts.phase}`);
  if (opts.step !== undefined && opts.step !== null && !STEPS.includes(opts.step)) missing.push(`--step ${opts.step}`);
  if (!s || s.rows === 0) missing.push("no rows (--in)");
  if (missing.length > 0) {
    return { verdict: "INCOMPLETE", early: opts.early === true, missing, gates: {},
      lines: missing.map((m) => `MISSING ${m}`) };
  }
  if (opts.early === true) return earlyVerdict(s, T);
  const t = target;
  if (!s.coverage.steadyReached) missing.push(`steady state not reached (${s.coverage.steadyRule})`);
  if (!(s.coverage.steadyHours >= T.common.minCoverageH)) {
    missing.push(`steady-state coverage ${fmt(s.coverage.steadyHours)} h < ${T.common.minCoverageH} h`);
  }
  if (!s.inputs.dockerStart) missing.push("no --docker-start (or no server container line)");
  if (!s.inputs.dockerEnd) missing.push("no --docker-end (or no server container line)");
  if (!s.inputs.censusStart) missing.push("no --census-start");
  if (!s.inputs.censusEnd) missing.push("no --census-end");
  if (opts.phase) missing.push(...phaseMismatch(s, opts.phase));
  if (missing.length > 0) {
    return { verdict: "INCOMPLETE", early: false, missing, gates: {}, lines: missing.map((m) => `MISSING ${m}`) };
  }

  const gates = {};
  const fcOn = flagOn(s, "freeCorps.enabled");

  const g0 = makeGate("G0", true);
  noteG(g0, `coverage ${fmt(s.coverage.steadyHours)} h, restarts ${s.restarts}, phase ${opts.phase || "(no --phase)"}`);
  if (fcOn && s.service.freeCorpsState !== RUNNING) failG(g0, `service freeCorps state=${s.service.freeCorpsState}`);
  const passFailed = s.safety[`${FC}.passFailed`] || 0;
  if (passFailed > 0) failG(g0, `delta passFailed ${passFailed} > 0`);
  if ((s.safety["journal.conflicts"] || 0) > 0) failG(g0, `delta journal.conflicts ${s.safety["journal.conflicts"]} > 0`);
  if ((s.safety["telemetry.rejectedMetrics"] || 0) > 0) {
    failG(g0, `delta telemetry.rejectedMetrics ${s.safety["telemetry.rejectedMetrics"]} > 0`);
  }
  for (const a of s.alarms) if (a.startsWith("error:")) failG(g0, `alarm ${a}`);
  if (s.audit === null) noteG(g0, "no --audit: double settlements not checked");
  else if (s.audit.invalid) failG(g0, `--audit unreadable (${s.audit.invalid})`);
  else if (s.audit.duplicateSettlements > 0) failG(g0, `audit duplicateSettlements ${s.audit.duplicateSettlements} > 0`);
  if (s.log === null) noteG(g0, "no log: 'pass failed' lines not checked");
  else if (s.log.passFailed > 0) failG(g0, `log 'freeCorps: pass failed' ${s.log.passFailed} lines`);
  gates.G0 = g0;

  const g1 = makeGate("G1", true);
  const lim1 = T.G1[t].p95Ms;
  if (!isNum(s.tick.p95Median)) failG(g1, "tick p95 no windows");
  else if (s.tick.p95Median > lim1) failG(g1, `tick p95 (median of windows) ${fmt(s.tick.p95Median)} > ${lim1} ms`);
  noteG(g1, `tick p95 median ${fmt(s.tick.p95Median)} ms, worst window ${fmt(s.tick.p95Worst)}, max ${fmt(s.tick.max)}, `
    + `windows ${s.tick.windows}, scenes max ${fmt(s.tick.sceneCountMax)}`);
  gates.G1 = g1;
  const g1b = makeGate("G1b", true);
  if (s.tick.windowsOver > T.G1b[t].maxWindows) {
    failG(g1b, `tick p95 windows > ${T.common.badTickP95Ms} ms: ${s.tick.windowsOver} > ${T.G1b[t].maxWindows}`);
  } else noteG(g1b, `tick p95 windows > ${T.common.badTickP95Ms} ms: ${s.tick.windowsOver}`);
  gates.G1b = g1b;

  if (!fcOn) gates.G2 = na("G2", "freeCorps.enabled off");
  else {
    const g2 = makeGate("G2", true);
    histGate(g2, "freeCorps.passMs", s.histograms.passMs, T.G2[t].p95Ms, T.G2[t].maxMs, false);
    gates.G2 = g2;
  }

  const g3 = makeGate("G3", true);
  if (!isNum(s.wal.framesPerS)) failG(g3, "WAL no checkpoint.frames windows (NO_DATA)");
  else if (s.wal.framesPerS > T.G3[t].framesPerS) failG(g3, `WAL ${fmt(s.wal.framesPerS)} > ${T.G3[t].framesPerS} frames/s`);
  noteG(g3, `WAL ${fmt(s.wal.framesPerS)} frames/s (windows ${s.wal.windows})`);
  const walM = isObject(s.wal.measured) ? s.wal.measured : null;
  if (walM && isNum(walM.fcShare)) {
    noteG(g3, `freeCorps ${fmt(walM.fcShare * 100)}% of frames, virtualCorps `
      + `${isNum(walM.vcShare) ? fmt(walM.vcShare * 100) : "-"}% (measured, ${fmt(walM.totalFramesPerS)} frames/s)`);
  }
  gates.G3 = g3;
  const g3b = makeGate("G3b", false);
  if (walM && isNum(walM.fcFramesPerS)) {
    if (walM.fcFramesPerS > T.G3b[t].rowsPerS) {
      failG(g3b, `WAL freeCorps (measured) ${fmt(walM.fcFramesPerS)} > ${T.G3b[t].rowsPerS} frames/s`);
    } else noteG(g3b, `WAL freeCorps (measured) ${fmt(walM.fcFramesPerS)} frames/s`);
  } else if (!isNum(s.wal.fcRowsPerSEstimate)) noteG(g3b, "WAL freeCorps (estimate) no data");
  else if (s.wal.fcRowsPerSEstimate > T.G3b[t].rowsPerS) {
    failG(g3b, `WAL freeCorps (estimate) ${fmt(s.wal.fcRowsPerSEstimate)} > ${T.G3b[t].rowsPerS} /s`);
  } else noteG(g3b, `WAL freeCorps (estimate) ${fmt(s.wal.fcRowsPerSEstimate)} /s`);
  gates.G3b = g3b;
  const prevP95 = opts.prev && isObject(opts.prev.summary) && isObject(opts.prev.summary.checkpoint)
    ? opts.prev.summary.checkpoint.p95Ms : null;
  const g3c = makeGate("G3c", isNum(prevP95));
  if (isNum(prevP95)) {
    const lim = T.G3c[t].factor * prevP95 + T.G3c[t].slackMs;
    if (!isNum(s.checkpoint.p95Ms)) failG(g3c, "checkpoint ms p95 no data");
    else if (s.checkpoint.p95Ms > lim) failG(g3c, `checkpoint p95 ${fmt(s.checkpoint.p95Ms)} > ${fmt(lim)} ms (prev ${fmt(prevP95)})`);
    else noteG(g3c, `checkpoint p95 ${fmt(s.checkpoint.p95Ms)} <= ${fmt(lim)} ms (prev ${fmt(prevP95)})`);
  } else noteG(g3c, `checkpoint p95 ${fmt(s.checkpoint.p95Ms)} ms (informational, no --prev)`);
  gates.G3c = g3c;

  if (!fcOn) gates.G4 = na("G4", "freeCorps.enabled off");
  else {
    const g4 = makeGate("G4", true);
    if (s.saga.state === "NO_DATA" && t === "start") {
      noteG(g4, "virtualCorps.freeSagaSliceMs NO_DATA - PASS with a note; saga measurement = S1 --early");
    } else histGate(g4, "virtualCorps.freeSagaSliceMs", s.saga, T.G4[t].p95Ms, T.G4[t].maxMs, false);
    gates.G4 = g4;
  }

  const g5 = makeGate("G5", true);
  if (!isNum(s.heap.deltaMb)) {
    failG(g5, `heap afterMajor no delta (segment ${fmt(s.heap.segmentHours)} h, slope ${fmt(s.heap.slopeMbPer24h)} MB/24h)`);
  } else if (s.heap.deltaMb > T.G5[t].heapDeltaMb) failG(g5, `heap afterMajor +${fmt(s.heap.deltaMb)} > ${T.G5[t].heapDeltaMb} MB`);
  else noteG(g5, `heap afterMajor ${fmt(s.heap.deltaMb)} MB (slope ${fmt(s.heap.slopeMbPer24h)} MB/24h)`);
  const rssGiB = s.rss.containerEndBytes / BYTES_PER_GIB;
  if (rssGiB > T.G5[t].rssGiB) failG(g5, `container RSS ${fmt(rssGiB)} > ${T.G5[t].rssGiB} GiB`);
  else noteG(g5, `container RSS ${fmt(rssGiB)} GiB (start ${fmt(s.rss.containerStartBytes / BYTES_PER_GIB)})`);
  gates.G5 = g5;

  const g6 = makeGate("G6", true);
  const modeChanges = s.safety["channels.governor.modeChanges"] || 0;
  const emergency = s.safety["governor.counts.emergencySamples"] || 0;
  if (modeChanges > T.G6[t].modeChanges) failG(g6, `delta governor.modeChanges ${modeChanges} > ${T.G6[t].modeChanges}`);
  if (emergency > T.G6[t].emergencySamples) failG(g6, `delta emergencySamples ${emergency} > ${T.G6[t].emergencySamples}`);
  noteG(g6, `modeChanges ${modeChanges}, emergencySamples ${emergency}`);
  gates.G6 = g6;

  if (!flagOn(s, "localPilots.enabled")) gates.G7 = na("G7", "localPilots.enabled off");
  else {
    const g7 = makeGate("G7", true);
    const trunc = delta0(s.counters["channels.localPilots.poolTruncated"]);
    if (trunc > 0) failG(g7, `delta localPilots.poolTruncated ${trunc} > 0`);
    noteG(g7, `poolTruncated ${trunc}, residentsCut ${fmt(s.counters[`${FC}.residentsCut`].delta)}`);
    gates.G7 = g7;
  }

  const g8 = makeGate("G8", true);
  const maxVf = s.settings["limits.maxVirtualFleets"];
  const headroom = s.settings["capsuleers.minFleetHeadroom"];
  if (!isNum(maxVf) || !isNum(headroom)) failG(g8, "no limits.maxVirtualFleets / capsuleers.minFleetHeadroom in status");
  else if (!isNum(s.gauges.fleetsActiveMax)) failG(g8, "no fleets.active (fleets view)");
  else if (s.gauges.fleetsActiveMax > maxVf - headroom) {
    failG(g8, `fleets.active max ${s.gauges.fleetsActiveMax} > ${maxVf - headroom}`);
  } else noteG(g8, `fleets.active max ${s.gauges.fleetsActiveMax} <= ${maxVf - headroom}`);
  const maxTotal = s.settings["capsuleers.maxFleetsTotal"];
  if (isNum(s.gauges.capsuleerFleetsMax)) {
    if (!isNum(maxTotal)) failG(g8, "no capsuleers.maxFleetsTotal in status");
    else if (s.gauges.capsuleerFleetsMax > maxTotal) {
      failG(g8, `capsuleers.fleets max ${s.gauges.capsuleerFleetsMax} > ${maxTotal}`);
    } else noteG(g8, `capsuleers.fleets max ${s.gauges.capsuleerFleetsMax} <= ${maxTotal}`);
  } else if (flagOn(s, "capsuleers.fleetBudgetEnabled")) {
    failG(g8, "capsuleers.fleets no data (capsuleers.fleetBudgetEnabled on)");
  } else noteG(g8, "capsuleers.fleets missing (capsuleers.fleetBudgetEnabled off/missing)");
  noteG(g8, `delta capsuleers.fleetBudget ${fmt(s.counters["channels.capsuleers.fleetBudget"].delta)}`);
  gates.G8 = g8;

  if (!flagOn(s, "freeCorps.killmails.enabled")) gates.G9 = na("G9", "freeCorps.killmails.enabled off/missing");
  else {
    const g9 = makeGate("G9", true);
    const perHour = s.counters[`${FC}.kmDone`].perHour;
    if (isNum(perHour) && perHour > T.G9[t].perHour) failG(g9, `kmDone ${fmt(perHour)}/h > ${T.G9[t].perHour}/h`);
    else noteG(g9, `kmDone ${fmt(perHour)}/h`);
    histGate(g9, "freeCorps.killmailCallMs", s.histograms.killmailCallMs, T.G9[t].p95Ms, T.G9[t].maxMs, true);
    const pause = delta0(s.counters[`${FC}.kmSlowPause`]);
    if (pause > T.G9[t].slowPause) failG(g9, `delta kmSlowPause ${pause} > ${T.G9[t].slowPause}`);
    gates.G9 = g9;
  }
  if (!flagOn(s, "freeCorps.contracts.enabled")) gates.G10 = na("G10", "freeCorps.contracts.enabled off/missing");
  else {
    const g10 = makeGate("G10", true);
    if (!isNum(s.gauges.contractsOpenMax)) failG(g10, "freeCorps.contractsOpen no data");
    else if (s.gauges.contractsOpenMax > T.G10[t].open) {
      failG(g10, `contractsOpen max ${s.gauges.contractsOpenMax} > ${T.G10[t].open}`);
    } else noteG(g10, `contractsOpen max ${s.gauges.contractsOpenMax}`);
    histGate(g10, "freeCorps.contractIssueMs", s.histograms.contractIssueMs, T.G10[t].p95Ms, null, false);
    gates.G10 = g10;
  }
  if (!flagOn(s, "freeCorps.recycle.enabled")) gates.G11 = na("G11", "freeCorps.recycle.enabled off/missing");
  else {
    const g11 = makeGate("G11", true);
    histGate(g11, "freeCorps.joinCallMs", s.histograms.joinCallMs, T.G11[t].p95Ms, null, false);
    const pause = delta0(s.counters[`${FC}.rcSlowPause`]);
    if (pause > T.G11[t].slowPause) failG(g11, `delta rcSlowPause ${pause} > ${T.G11[t].slowPause}`);
    gates.G11 = g11;
  }
  if (!flagOn(s, "freeCorps.structures.enabled")) gates.G12 = na("G12", "freeCorps.structures.enabled off/missing");
  else {
    const g12 = makeGate("G12", true);
    if (!isNum(s.gauges.structuresOpenMax)) failG(g12, "freeCorps.structuresOpen no data");
    else if (s.gauges.structuresOpenMax > T.G12[t].open) {
      failG(g12, `structuresOpen max ${s.gauges.structuresOpenMax} > ${T.G12[t].open}`);
    } else noteG(g12, `structuresOpen max ${s.gauges.structuresOpenMax}`);
    histGate(g12, "freeCorps.structureCallMs", s.histograms.structureCallMs, T.G12[t].p95Ms, null, false);
    gates.G12 = g12;
  }

  const g13 = makeGate("G13", true);
  const budget = s.settings["virtualCorps.ownerCharacterBudget"];
  const end = s.identities.end;
  if (!isNum(budget)) failG(g13, "no virtualCorps.ownerCharacterBudget in status");
  else if (!end) failG(g13, "census t+24 without identities");
  else if (end.owners > budget) failG(g13, `owner characters LINKED ${end.owners} > budget ${budget}`);
  else noteG(g13, `owner characters LINKED ${end.owners} <= ${budget}`);
  if (t === "stretch" && opts.step && isNum(budget)) {
    const plan = LADDER.find((x) => x.step === opts.step).planCharacters;
    if (plan > budget) failG(g13, `step ${opts.step} plan ${plan} > budget ${budget}`);
    else noteG(g13, `step ${opts.step} plan ${plan} <= ${budget}`);
  }
  gates.G13 = g13;

  const i1 = makeGate("I1", false);
  const d = (n) => s.counters[`${FC}.${n}`].delta;
  const ratio = (a, b) => (isNum(a) && isNum(b) && b > 0 ? fmt(a / b) : "-");
  noteG(i1, `huntNoPrey/huntSteps ${ratio(d("huntNoPrey"), d("huntSteps"))}, skirmishes/day `
    + `${fmt(isNum(d("skirmishes")) && s.coverage.steadyHours > 0 ? (d("skirmishes") * HOURS_PER_DAY) / s.coverage.steadyHours : null)}`
    + `, warsDeclared ${fmt(d("warsDeclared"))}, ventureLost/ventureSteps ${ratio(d("ventureLost"), d("ventureSteps"))}`
    + `, kmBacklogDrop ${fmt(d("kmBacklogDrop"))}, stSkipIsk ${fmt(d("stSkipIsk"))}`);
  noteG(i1, `open ${fmt(s.gauges.freeCorpsOpenLast)}, founding max ${fmt(s.gauges.foundingMax)}, struggling `
    + `${fmt(s.gauges.strugglingLast)}`);
  const st = s.identities.start;
  if (st && end) {
    noteG(i1, `characters LINKED t0 / t+24: capsuleer ${st.capsuleer}/${end.capsuleer}, civilian ${st.civilian}/`
      + `${end.civilian}, free ${st.free}/${end.free} (delta ${end.owners - st.owners})`);
  }
  if (s.log) {
    noteG(i1, `log: ensureOwnerIdentity failed ${s.log.ensureFailed}, killmail pump not started ${s.log.pumpNotStarted}, `
      + `stall-diag ${s.log.stallDiag}, TX_ROW_LIMIT ${s.log.txRowLimit}, spike ${JSON.stringify(s.log.spikesBySource)}`);
  }
  gates.I1 = i1;

  const go = Object.values(gates).every((g) => !g.blocking || g.status !== "FAIL");
  const lines = Object.values(gates).flatMap((g) => g.lines);
  return { verdict: go ? "GO" : "NO_GO", early: false, missing: [], gates, lines,
    entry: entryCheck(s, opts.step, T) };
}

function recommend(summary, v, opts = {}) {
  const ladder = Array.isArray(opts.ladder) ? opts.ladder : LADDER;
  const step = typeof opts.step === "string" && ladder.some((x) => x.step === opts.step) ? opts.step : ladder[0].step;
  const at = ladder.findIndex((x) => x.step === step);
  const base = { step, next: null, env: [], rows: [], lines: [] };
  if (!v || v.verdict === "INCOMPLETE") {
    return { ...base, action: "REPEAT", lines: (v ? v.missing : ["no verdict"]).map((m) => `missing: ${m}`) };
  }
  if (v.verdict === "CONTINUE") return { ...base, action: "CONTINUE", lines: [`${step}: continue measuring (--early)`] };
  if (v.verdict === "ABORT" || v.verdict === "NO_GO") {
    const failed = Object.values(v.gates || {}).filter((g) => g.blocking && g.status === "FAIL").map((g) => g.id);
    const rows = failed.map((id) => ({ gate: id, ...(HOLD_TABLE[id] || HOLD_TABLE[id.replace(/b$/u, "")]
      || { cause: "-", knob: "-", task: "-" }) }));
    const lines = [`HOLD ${step}: stay on the current step, flags unchanged`];
    if (at > 0) {
      lines.push(`ROLLBACK: restore the env of step ${ladder[at - 1].step} (growth stops, the population stays)`);
    }
    if (v.verdict === "ABORT") lines.push(...v.lines);
    return { ...base, action: "HOLD", rows, lines };
  }
  if (at === ladder.length - 1) return { ...base, action: "DONE", lines: [`${step} GO - stretch ladder finished`] };
  const next = ladder[at + 1];
  const entry = isObject(v.entry) && v.entry.next === next.step ? v.entry
    : entryCheck(summary, step, opts.thresholds || THRESHOLDS);
  if (entry.ok === false) {
    return { ...base, action: "HOLD", rows: [],
      lines: [`HOLD ${step}: ${step} GO, but the ${next.step} entry condition is not met`, ...entry.lines] };
  }
  return { ...base, action: "NEXT", next: next.step, env: next.env.slice(),
    lines: [`NEXT ${next.step} (character plan ${next.planCharacters}): ${next.env.join(" ")}`, ...entry.lines] };
}

function withThreshold(thresholds, spec) {
  const m = /^([A-Za-z0-9.]+)=(-?\d+(?:\.\d+)?)$/u.exec(String(spec));
  if (!m) return { ok: false, reason: `--threshold ${spec}: expected <path>=<number>` };
  const parts = m[1].split(".");
  const copy = JSON.parse(JSON.stringify(thresholds));
  let cur = copy;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!isObject(cur[parts[i]])) return { ok: false, reason: `--threshold ${m[1]}: unknown path` };
    cur = cur[parts[i]];
  }
  const leaf = parts[parts.length - 1];
  if (!Object.prototype.hasOwnProperty.call(cur, leaf) || !isNum(cur[leaf])) {
    return { ok: false, reason: `--threshold ${m[1]}: unknown path` };
  }
  cur[leaf] = Number(m[2]);
  return { ok: true, thresholds: deepFreeze(copy) };
}

module.exports = { THRESHOLDS, PHASE_FLAGS, LADDER, STEPS, HOLD_TABLE, parseDockerStats, parseLog, summarize, verdict,
  recommend, withThreshold };
