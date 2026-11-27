"use strict";

const fs = require("node:fs");
const path = require("node:path");

const MS_PER_MINUTE = 60000;
const MS_PER_SECOND = 1000;
const BYTES_PER_MB = 1024 * 1024;
const PERCENT = 100;
const SHORT_WINDOW_RATIO = 0.9;
const SNAP_FILE_RE = /^snap-(\d+)\.json$/u;

const REASONS = Object.freeze({
  TOO_FEW_SNAPSHOTS: "TOO_FEW_SNAPSHOTS",
  PROCESS_RESTARTED: "PROCESS_RESTARTED",
  TELEMETRY_UNAVAILABLE: "TELEMETRY_UNAVAILABLE",
  READ_FAILED: "READ_FAILED",
});

function round(n, digits) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function normalizeSnapshot(raw) {
  let body = raw;
  if (isObject(body) && isObject(body.data) && !isObject(body.gc)) body = body.data;
  if (isObject(body) && Object.prototype.hasOwnProperty.call(body, "available")) {
    if (body.available !== true) {
      return { ok: false, reason: REASONS.TELEMETRY_UNAVAILABLE, detail: String(body.reason || "available:false") };
    }
    body = body.snapshot;
  }
  if (!isObject(body) || !isObject(body.gc) || !isObject(body.tick)) {
    return { ok: false, reason: REASONS.TELEMETRY_UNAVAILABLE, detail: "no gc / tick in the snapshot" };
  }
  return { ok: true, snapshot: body };
}

function kind(snap, name) {
  const kinds = isObject(snap.gc.kinds) ? snap.gc.kinds : {};
  const k = isObject(kinds[name]) ? kinds[name] : {};
  return { count: num(k.count), totalMs: num(k.totalMs), maxMs: num(k.maxMs) };
}

function proc(snap) {
  return isObject(snap.process) ? snap.process : {};
}

function governorCount(snap, name) {
  const g = isObject(snap.governor) ? snap.governor : null;
  return g && isObject(g.counts) ? num(g.counts[name]) : 0;
}

function interval(snap) {
  return isObject(snap.tick.intervalMs) ? snap.tick.intervalMs : {};
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function summarizeRun(snaps) {
  if (!Array.isArray(snaps) || snaps.length < 2) {
    return { ok: false, reason: REASONS.TOO_FEW_SNAPSHOTS, detail: `${Array.isArray(snaps) ? snaps.length : 0} < 2` };
  }
  const list = [];
  for (let i = 0; i < snaps.length; i += 1) {
    const n = normalizeSnapshot(snaps[i]);
    if (!n.ok) return { ok: false, reason: n.reason, detail: `snap ${i}: ${n.detail}` };
    list.push(n.snapshot);
  }
  for (let i = 1; i < list.length; i += 1) {
    const a = list[i - 1];
    const b = list[i];
    const pa = proc(a);
    const pb = proc(b);
    if (pa.pid !== pb.pid) {
      return { ok: false, reason: REASONS.PROCESS_RESTARTED, detail: `snap ${i}: pid ${pa.pid} -> ${pb.pid}` };
    }
    if (num(pb.uptimeSeconds) < num(pa.uptimeSeconds)) {
      return { ok: false, reason: REASONS.PROCESS_RESTARTED, detail: `snap ${i}: uptime went down` };
    }
    if (num(b.gc.count) < num(a.gc.count)) {
      return { ok: false, reason: REASONS.PROCESS_RESTARTED, detail: `snap ${i}: gc.count went down` };
    }
  }

  const first = list[0];
  const last = list[list.length - 1];
  const minor0 = kind(first, "minor");
  const minor1 = kind(last, "minor");
  const major0 = kind(first, "major");
  const major1 = kind(last, "major");
  const minorCount = minor1.count - minor0.count;
  const minorTotalMs = minor1.totalMs - minor0.totalMs;
  const wallMs = (num(proc(last).uptimeSeconds) - num(proc(first).uptimeSeconds)) * MS_PER_SECOND;
  const gcMs = num(last.gc.totalMs) - num(first.gc.totalMs);

  const p95s = [];
  let intervalMax = 0;
  let windowsShort = 0;
  for (let i = 1; i < list.length; i += 1) {
    const iv = interval(list[i]);
    p95s.push(num(iv.p95));
    intervalMax = Math.max(intervalMax, num(iv.max));
    const gapMs = num(list[i].capturedAtMs) - num(list[i - 1].capturedAtMs);
    if (num(iv.spanMs) < SHORT_WINDOW_RATIO * gapMs) windowsShort += 1;
  }

  const mb = (bytes) => round(num(bytes) / BYTES_PER_MB, 1);
  return {
    ok: true,
    row: {
      minutes: round((num(last.capturedAtMs) - num(first.capturedAtMs)) / MS_PER_MINUTE, 1),
      minorCount,
      minorTotalMs: round(minorTotalMs, 1),
      minorAvgMs: minorCount > 0 ? round(minorTotalMs / minorCount, 2) : 0,
      majorCount: major1.count - major0.count,
      majorTotalMs: round(major1.totalMs - major0.totalMs, 1),
      majorMaxMs: major1.maxMs > major0.maxMs ? major1.maxMs : null,
      gcPercentWall: wallMs > 0 ? round((gcMs / wallMs) * PERCENT, 3) : 0,
      intervalP95Median: round(median(p95s), 1),
      intervalP95Max: round(Math.max(...p95s), 1),
      intervalMax: round(intervalMax, 1),
      emergencySamples: governorCount(last, "emergencySamples") - governorCount(first, "emergencySamples"),
      unplayableSamples: governorCount(last, "unplayableSamples") - governorCount(first, "unplayableSamples"),
      rssStartMB: mb(proc(first).rssBytes),
      rssEndMB: mb(proc(last).rssBytes),
      heapUsedEndMB: mb(proc(last).heapUsedBytes),
      windowsShort,
    },
    majorMaxBeforeMs: major0.maxMs,
  };
}

function readRunDir(dir) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (err) {
    return { ok: false, reason: REASONS.READ_FAILED, detail: err && err.code ? err.code : String(err) };
  }
  const files = names
    .map((name) => ({ name, m: SNAP_FILE_RE.exec(name) }))
    .filter((f) => f.m)
    .sort((a, b) => Number(a.m[1]) - Number(b.m[1]));
  const snaps = [];
  for (const f of files) {
    try {
      snaps.push(JSON.parse(fs.readFileSync(path.join(dir, f.name), "utf8")));
    } catch (err) {
      return { ok: false, reason: REASONS.READ_FAILED, detail: `${f.name}: ${err && err.message ? err.message : err}` };
    }
  }
  return { ok: true, snaps };
}

const COLUMNS = Object.freeze([
  "run", "min", "minor n", "minor ms", "minor avg ms", "d minor ms vs 1st [%]", "major n", "major ms",
  "major max ms", "GC % wall", "p95 int. median", "p95 int. max", "int. max", "emergency", "unplayable",
  "RSS start MB", "RSS end MB", "heap end MB", "windowsShort",
]);

function formatTable(runs) {
  const lines = [`| ${COLUMNS.join(" | ")} |`, `|${COLUMNS.map(() => "---").join("|")}|`];
  const base = runs.length > 0 && runs[0].result.ok ? runs[0].result.row.minorTotalMs : null;
  for (const { name, result } of runs) {
    if (!result.ok) {
      const cells = [name, `${result.reason}${result.detail ? ` (${result.detail})` : ""}`];
      while (cells.length < COLUMNS.length) cells.push("");
      lines.push(`| ${cells.join(" | ")} |`);
      continue;
    }
    const r = result.row;
    const delta = base !== null && base > 0 ? String(round(((r.minorTotalMs - base) / base) * PERCENT, 1)) : "n/a";
    const majorMax = r.majorMaxMs !== null ? String(r.majorMaxMs) : `<= ${result.majorMaxBeforeMs}`;
    lines.push(`| ${[name, r.minutes, r.minorCount, r.minorTotalMs, r.minorAvgMs, delta, r.majorCount,
      r.majorTotalMs, majorMax, r.gcPercentWall, r.intervalP95Median, r.intervalP95Max, r.intervalMax,
      r.emergencySamples, r.unplayableSamples, r.rssStartMB, r.rssEndMB, r.heapUsedEndMB, r.windowsShort]
      .join(" | ")} |`);
  }
  return lines.join("\n");
}

function main(argv, io) {
  const out = (io && io.out) || ((s) => process.stdout.write(`${s}\n`));
  const err = (io && io.err) || ((s) => process.stderr.write(`${s}\n`));
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((a) => a === "--help" || a === "-h")) {
    err("usage: node mods/livingNewEden/tools/gcWindowReport.js <runDir> [<runDir> ...]");
    return 1;
  }
  const runs = argv.map((dir) => {
    const read = readRunDir(dir);
    const result = read.ok ? summarizeRun(read.snaps) : read;
    return { name: path.basename(path.resolve(dir)), result };
  });
  out(formatTable(runs));
  return runs.every((r) => r.result.ok) ? 0 : 1;
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}

module.exports = { summarizeRun, normalizeSnapshot, readRunDir, formatTable, main, REASONS };
