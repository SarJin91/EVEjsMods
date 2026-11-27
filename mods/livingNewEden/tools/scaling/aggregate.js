"use strict";

const { deferredMark } = require("../measure/histogramsDeferred");

const MS_PER_HOUR = 3600000;
const MS_PER_MINUTE = 60000;
const MS_PER_SECOND = 1000;
const BYTES_PER_MB = 1024 * 1024;
const PERCENT = 100;
const NORMAL_MODE = "NORMAL";
const MIN_LNE_STOPS = 2;
const RECOMMEND_AXES = Object.freeze(["base", "virtual"]);

const DEFAULT_THRESHOLDS = Object.freeze({ warnP95Ms: 120, failP95Ms: 130, stopMs: 500,
  warmupMs: 600000, backlogGrowthMin: 50, backlogGrowthRatio: 0.2, rssGrowthMbPerHour: 100,
  degradedResidencyMax: 0.5, budgetSaturationShare: 0.9 });

const VERDICTS = Object.freeze({ OK: "OK", WARN: "WARN", FAIL: "FAIL", NO_DATA: "NO_DATA" });
const WARN_FLAGS = Object.freeze(["BACKLOG_GROWING", "RSS_GROWING", "REPEATED_STOPS_LNE", "GOVERNOR_DEGRADED",
  "FLEET_LIMIT_HIT"]);
const SAFETY_FLAGS = Object.freeze(["QUARANTINED", "AUDIT_DUPLICATE_SETTLEMENTS", "ALARM_ERROR"]);
const AUDIT_TOOL = "auditWorldDb";
const AUDIT_ERROR = "ERROR";
const AUDIT_DUPLICATE_SETTLEMENTS = "duplicateSettlements";
const FLEET_DESTROYED = "DESTROYED";
const RSS_BASELINE_NONE = "none";
const BASELINE_AXIS = "instrument";
const P95_SOURCES = Object.freeze({ WINDOWS: "windows", ROWS: "rows" });

function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function round(n, digits) {
  if (!isNum(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function mean(values) {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

function maxOf(values) {
  return values.length === 0 ? null : Math.max(...values);
}

function numbers(rows, key) {
  const out = [];
  for (const r of rows) if (isNum(r[key])) out.push(r[key]);
  return out;
}

function pickWindows(rows, histPath) {
  const spanKey = `${histPath}.spanMs`;
  const out = [];
  let lastAt = null;
  for (const r of Array.isArray(rows) ? rows : []) {
    const span = r[spanKey];
    if (!isNum(span) || span <= 0 || !isNum(r.capturedAtMs)) continue;
    if (lastAt === null || r.capturedAtMs - span >= lastAt) {
      out.push(r);
      lastAt = r.capturedAtMs;
    }
  }
  return out;
}

function counterDelta(rows, path) {
  let delta = 0;
  let segments = 0;
  let prev = null;
  for (const r of Array.isArray(rows) ? rows : []) {
    const v = r[path];
    if (!isNum(v)) continue;
    if (prev === null || r.startedAtMs !== prev.startedAtMs || v < prev.value) {
      segments += 1;
    } else {
      delta += v - prev.value;
    }
    prev = { value: v, startedAtMs: r.startedAtMs };
  }
  return { delta, segments };
}

function slopePerHour(points) {
  const pts = (Array.isArray(points) ? points : []).filter((p) => p && isNum(p.atMs) && isNum(p.value));
  if (pts.length < 2) return 0;
  const mx = mean(pts.map((p) => p.atMs));
  const my = mean(pts.map((p) => p.value));
  let sxx = 0;
  let sxy = 0;
  for (const p of pts) {
    sxx += (p.atMs - mx) ** 2;
    sxy += (p.atMs - mx) * (p.value - my);
  }
  return sxx > 0 ? (sxy / sxx) * MS_PER_HOUR : 0;
}

function verdictOf(p95Ms, t) {
  const th = { ...DEFAULT_THRESHOLDS, ...(t || {}) };
  if (!isNum(p95Ms)) return VERDICTS.NO_DATA;
  if (p95Ms < th.warnP95Ms) return VERDICTS.OK;
  if (p95Ms < th.failP95Ms) return VERDICTS.WARN;
  return VERDICTS.FAIL;
}

function seriesOf(rows, key, scale) {
  return rows.filter((r) => isNum(r[key]) && isNum(r.capturedAtMs))
    .map((r) => ({ atMs: r.capturedAtMs, value: r[key] / scale }));
}

function p95Median(rows, histPath) {
  const p95Key = `${histPath}.p95`;
  const fromWindows = numbers(pickWindows(rows, histPath), p95Key);
  if (fromWindows.length > 0) return { value: median(fromWindows), source: P95_SOURCES.WINDOWS };
  const samplesKey = `${histPath}.samples`;
  const fromRows = numbers((Array.isArray(rows) ? rows : []).filter((r) => isNum(r[samplesKey]) && r[samplesKey] > 0),
    p95Key);
  if (fromRows.length > 0) return { value: median(fromRows), source: P95_SOURCES.ROWS };
  return { value: null, source: null };
}

function pickRssBaseline(headers, explicit) {
  const list = (Array.isArray(headers) ? headers : []).filter((h) => h && typeof h === "object");
  if (explicit === RSS_BASELINE_NONE) return { ok: true, label: null };
  if (explicit !== undefined) {
    return list.some((h) => h.label === explicit) ? { ok: true, label: explicit } : { ok: false, reason: "UNKNOWN_LABEL" };
  }
  const base = list.find((h) => h.axis === BASELINE_AXIS && typeof h.label === "string");
  return { ok: true, label: base ? base.label : null };
}

function countRestarts(rows) {
  let restarts = 0;
  let prev;
  for (const r of rows) {
    if (!isNum(r.startedAtMs)) continue;
    if (prev !== undefined && r.startedAtMs !== prev) restarts += 1;
    prev = r.startedAtMs;
  }
  return restarts;
}

function grownMax(rows, path) {
  let best = null;
  let first = null;
  let last = null;
  const close = () => {
    if (first !== null && last !== null && last.value > first.value) best = best === null ? last.value
      : Math.max(best, last.value);
  };
  for (const r of rows) {
    const v = r[path];
    if (!isNum(v)) continue;
    if (last === null || r.startedAtMs !== last.startedAtMs || v < last.value) {
      close();
      first = { value: v, startedAtMs: r.startedAtMs };
    }
    last = { value: v, startedAtMs: r.startedAtMs };
  }
  close();
  return best;
}

function auditSummaryOf(report) {
  if (!report || typeof report !== "object" || Array.isArray(report) || report.tool !== AUDIT_TOOL
    || !Array.isArray(report.findings)) return { ok: false, reason: "NOT_AN_AUDIT" };
  const dup = report.findings.find((f) => f && f.id === AUDIT_DUPLICATE_SETTLEMENTS);
  if (!dup || !isNum(dup.count)) return { ok: false, reason: "NO_DUPLICATE_SETTLEMENTS" };
  const errors = report.findings.filter((f) => f && f.severity === AUDIT_ERROR && isNum(f.count) && f.count > 0)
    .length;
  const growth = report.growth;
  const fleets = growth && typeof growth === "object" ? growth.fleets : null;
  const byState = fleets && typeof fleets === "object" ? fleets.byState : null;
  const out = { ok: true, duplicateSettlements: dup.count, errors };
  if (byState && typeof byState === "object" && !Array.isArray(byState)) {
    let liveFleets = 0;
    for (const [state, n] of Object.entries(byState)) if (state !== FLEET_DESTROYED && isNum(n)) liveFleets += n;
    out.liveFleets = liveFleets;
    out.destroyedFleets = isNum(byState[FLEET_DESTROYED]) ? byState[FLEET_DESTROYED] : 0;
  }
  return out;
}

function summarizeStage(header, rows, thresholds, footer, audit, opts) {
  const t = { ...DEFAULT_THRESHOLDS, ...(thresholds || {}) };
  const h = header || {};
  const all = Array.isArray(rows) ? rows : [];
  const measured = all.filter((r) => isNum(r["process.uptimeSeconds"])
    && r["process.uptimeSeconds"] * MS_PER_SECOND >= t.warmupMs);
  const windows = pickWindows(measured, "tick.intervalMs");
  const p95s = numbers(windows, "tick.intervalMs.p95");
  const first = measured.length > 0 ? measured[0] : null;
  const last = measured.length > 0 ? measured[measured.length - 1] : null;
  const spanMs = first && last && isNum(first.capturedAtMs) && isNum(last.capturedAtMs)
    ? last.capturedAtMs - first.capturedAtMs : 0;
  const hours = spanMs / MS_PER_HOUR;
  const minutes = spanMs / MS_PER_MINUTE;
  const delta = (path) => counterDelta(measured, path).delta;
  const workP95 = p95Median(measured, "tick.workMs");
  const passP95 = p95Median(measured, "channels.scheduler.passMs");
  const latenessP95 = p95Median(measured, "channels.scheduler.lateness");
  const txP95 = p95Median(measured, "persistence.txMs");
  const checkpointP95 = p95Median(measured, "persistence.checkpoint.ms");
  const deferredRows = deferredMark(measured);

  const tick = {
    p95Median: round(median(p95s), 1),
    p95Max: round(maxOf(p95s), 1),
    max: round(maxOf(numbers(measured, "tick.intervalMs.max")), 1),
    workP95Median: round(workP95.value, 2),
    workP95Source: workP95.source,
    stopWindows: numbers(windows, "tick.intervalMs.max").filter((m) => m >= t.stopMs).length,
  };

  const backlog = numbers(measured, "channels.scheduler.dueBacklog");
  const backlogSlope = slopePerHour(seriesOf(measured, "channels.scheduler.dueBacklog", 1));
  const completed = delta("channels.scheduler.completed");
  const passes = delta("channels.scheduler.passes");
  const passAvg = mean(numbers(measured, "channels.scheduler.passMs.avg"));
  const budgetExhausted = delta("channels.scheduler.budgetExhausted");
  const scheduler = {
    passP95Median: round(passP95.value, 2),
    passP95Source: passP95.source,
    latenessP95Median: round(latenessP95.value, 1),
    latenessP95Source: latenessP95.source,
    budgetExhaustedShare: passes > 0 ? round(budgetExhausted / passes, 3) : null,
    dueBacklog: { first: backlog.length > 0 ? backlog[0] : null, last: backlog.length > 0 ? backlog[backlog.length - 1]
      : null, max: maxOf(backlog), slopePerHour: round(backlogSlope, 1) },
    completedPerMin: minutes > 0 ? round(completed / minutes, 1) : null,
    msPerEventEstimate: passAvg !== null && completed > 0 ? round((passAvg * passes) / completed, 3) : null,
  };

  const rss = numbers(measured, "process.rssBytes").map((b) => b / BYTES_PER_MB);
  const heap = numbers(measured, "process.heapUsedBytes").map((b) => b / BYTES_PER_MB);
  const rssSlope = slopePerHour(seriesOf(measured, "process.rssBytes", BYTES_PER_MB));
  const base = opts && opts.rssBaseline ? opts.rssBaseline : null;
  const relative = base !== null && base.label !== h.label && isNum(base.slopeMbPerHour);
  const rssThreshold = relative ? Math.max(0, base.slopeMbPerHour) + t.rssGrowthMbPerHour : t.rssGrowthMbPerHour;
  const memory = {
    rssMbFirst: round(rss.length > 0 ? rss[0] : null, 1),
    rssMbLast: round(rss.length > 0 ? rss[rss.length - 1] : null, 1),
    rssMbMax: round(maxOf(rss), 1),
    rssSlopeMbPerHour: round(rssSlope, 1),
    heapUsedMbLast: round(heap.length > 0 ? heap[heap.length - 1] : null, 1),
    rssPoints: rss.length,
    rssFlagMode: relative ? "baseline" : "absolute",
    rssBaselineLabel: relative ? base.label : null,
    rssFlagThresholdMbPerHour: round(rssThreshold, 1),
  };

  const gcTotalMs = delta("gc.totalMs");
  const wallMs = delta("process.uptimeSeconds") * MS_PER_SECOND;
  const gc = {
    count: delta("gc.count"),
    totalMs: round(gcTotalMs, 1),
    majorCount: delta("gc.kinds.major.count"),
    majorMaxMs: round(grownMax(measured, "gc.kinds.major.maxMs"), 1),
    wallPercent: wallMs > 0 ? round((gcTotalMs / wallMs) * PERCENT, 3) : null,
  };

  const cpu = {
    userAvg: round(mean(numbers(measured, "process.cpu.userPercentOfOneCore")), 1),
    eluAvg: round(mean(numbers(measured, "process.cpu.eventLoopUtilizationPercent")), 1),
  };

  const modes = measured.map((r) => r["governor.mode"]).filter((m) => typeof m === "string");
  const governor = {
    nonNormalShare: modes.length > 0 ? round(modes.filter((m) => m !== NORMAL_MODE).length / modes.length, 3) : null,
    changesDelta: delta("governor.changes"),
    emergencyDelta: delta("governor.counts.emergencySamples"),
    unplayableDelta: delta("governor.counts.unplayableSamples"),
  };

  const spikes = {
    lne: delta("spikes.bySource.lne"),
    gc: delta("spikes.bySource.gc"),
    evejsTick: delta("spikes.bySource.evejsTick"),
    unattributed: delta("spikes.bySource.unattributed"),
  };

  const persistence = {
    txP95Median: round(txP95.value, 2),
    txP95Source: txP95.source,
    checkpointP95Median: round(checkpointP95.value, 2),
    checkpointP95Source: checkpointP95.source,
    slowOpsDelta: delta("persistence.slowOps"),
  };

  const alarms = [...new Set(measured.flatMap((r) => (Array.isArray(r.alarms) ? r.alarms : [])))].sort();
  const safety = {
    quarantinedDelta: delta("channels.scheduler.quarantined"),
    duplicatesDelta: delta("journal.duplicates"),
    alarms,
    fleetLimitDelta: delta("channels.fleets.limit"),
    audit: audit && isNum(audit.duplicateSettlements) ? { file: typeof audit.file === "string" ? audit.file : "",
      duplicateSettlements: audit.duplicateSettlements, errors: isNum(audit.errors) ? audit.errors : 0 } : null,
  };

  const materialization = {
    liveShipsMax: maxOf(numbers(measured, "channels.materialization.liveShips")),
    liveBattlesMax: maxOf(numbers(measured, "channels.materialization.liveBattles")),
    spawnP95Max: round(maxOf(numbers(measured, "channels.materialization.spawnMs.p95")), 1),
    failedBattlesMax: maxOf(numbers(measured, "channels.materialization.failedBattles")),
  };

  const flags = [];
  const meanBacklog = mean(backlog);
  if (meanBacklog !== null
    && backlogSlope * hours > Math.max(t.backlogGrowthMin, t.backlogGrowthRatio * meanBacklog)) {
    flags.push("BACKLOG_GROWING");
  }
  if (rss.length >= 2 && rssSlope > rssThreshold) flags.push("RSS_GROWING");
  if (spikes.lne >= MIN_LNE_STOPS) flags.push("REPEATED_STOPS_LNE");
  if (governor.nonNormalShare !== null && governor.nonNormalShare > t.degradedResidencyMax) {
    flags.push("GOVERNOR_DEGRADED");
  }
  if (safety.fleetLimitDelta > 0) flags.push("FLEET_LIMIT_HIT");
  if (safety.quarantinedDelta > 0) flags.push("QUARANTINED");
  if (safety.audit !== null && safety.audit.duplicateSettlements > 0) flags.push("AUDIT_DUPLICATE_SETTLEMENTS");
  if (alarms.some((a) => a.startsWith("error:"))) flags.push("ALARM_ERROR");

  let verdict = verdictOf(tick.p95Median, t);
  if (verdict !== VERDICTS.NO_DATA) {
    if (flags.some((f) => SAFETY_FLAGS.includes(f))) verdict = VERDICTS.FAIL;
    else if (verdict === VERDICTS.OK && flags.some((f) => WARN_FLAGS.includes(f))) verdict = VERDICTS.WARN;
  }

  return {
    label: typeof h.label === "string" ? h.label : "",
    axis: typeof h.axis === "string" ? h.axis : "",
    benchFleets: Number.isSafeInteger(h.benchFleets) ? h.benchFleets : 0,
    demoMultiplier: Number.isSafeInteger(h.demoMultiplier) ? h.demoMultiplier : 1,
    note: typeof h.note === "string" ? h.note : "",
    rows: all.length,
    measuredRows: measured.length,
    windows: windows.length,
    histogramsDeferred: deferredRows.histogramsDeferred,
    deferredRows: deferredRows.deferredWindows,
    deferredWindows: deferredMark(windows).deferredWindows,
    deferredMax: deferredRows.deferredMax,
    minutes: round(minutes, 1),
    restarts: countRestarts(all),
    interrupted: !footer || footer.type !== "footer",
    tick, verdict, flags, scheduler, memory, gc, cpu, governor, spikes, persistence, safety, materialization,
    fleets: {
      live: audit && isNum(audit.liveFleets) ? audit.liveFleets : null,
      destroyed: audit && isNum(audit.destroyedFleets) ? audit.destroyedFleets : null,
    },
  };
}

function recommend(stages, opts) {
  const aiFleets = opts && Number.isSafeInteger(opts.aiFleets) && opts.aiFleets >= 0 ? opts.aiFleets : null;
  const t = { ...DEFAULT_THRESHOLDS, ...((opts && opts.thresholds) || {}) };
  const notes = [];
  let lastOk = null;
  let stoppedAt = null;
  for (const s of Array.isArray(stages) ? stages : []) {
    if (!RECOMMEND_AXES.includes(s.axis)) {
      notes.push(`${s.label}: axis ${s.axis} outside the virtual fleet axis, verdict ${s.verdict}`);
      continue;
    }
    if (stoppedAt !== null) {
      notes.push(`${s.label}: after the stop stage ${stoppedAt}, skipped`);
      continue;
    }
    if (!s.safety || !s.safety.audit) {
      notes.push(`${s.label}: no audit (--audit) - double settlement not checked`);
    }
    if (s.verdict === VERDICTS.NO_DATA) {
      notes.push(`${s.label}: no measurement windows (NO_DATA), skipped`);
      continue;
    }
    const live = s.fleets && isNum(s.fleets.live) ? s.fleets.live : null;
    if (live !== null && aiFleets !== null && live !== aiFleets + s.benchFleets) {
      notes.push(`${s.label}: live fleets ${live} != nominal ${aiFleets + s.benchFleets} (audit)`);
    }
    const share = s.scheduler ? s.scheduler.budgetExhaustedShare : null;
    if (isNum(share) && share >= t.budgetSaturationShare) {
      notes.push(`${s.label}: scheduler budget exhausted in ${round(share * PERCENT, 1)} % of passes`
        + " - throughput saturated, stage has no headroom");
    }
    if (s.verdict === VERDICTS.OK) lastOk = s;
    else stoppedAt = s.label;
  }
  let candidate = null;
  if (lastOk === null) notes.push("no OK stage on the base/virtual axis - no candidate");
  else if (aiFleets === null) notes.push("no --ai-fleets - maxVirtualFleets candidate unknown");
  else candidate = Math.floor((aiFleets + lastOk.benchFleets) / 2);
  return { lastOk: lastOk === null ? null : lastOk.label, stoppedAt, candidateMaxVirtualFleets: candidate, notes };
}

module.exports = { DEFAULT_THRESHOLDS, VERDICTS, WARN_FLAGS, SAFETY_FLAGS, pickWindows, counterDelta, slopePerHour,
  verdictOf, auditSummaryOf, summarizeStage, recommend, p95Median, pickRssBaseline };
