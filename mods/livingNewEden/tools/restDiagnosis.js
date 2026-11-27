"use strict";

const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { SOURCES, LINE_MARKER } = require("../lib/telemetry/spikeAttribution");

const DEFAULT_TELEMETRY_PORT = 26410;
const DEFAULT_TELEMETRY_HOST = "localhost";
const HTTP_TIMEOUT_MS = 5000;
const PAUSE_PROFILE_SUBDIR = path.join("logs", "pause-profiles");
const EVENTS_FILE = "events.jsonl";
const P95 = 95;
const CPU_BUSY_RATIO = 0.5;

const SIGNAL_CAUSES = Object.freeze(["io", "db", "cpu", "offCpu"]);
const LAG_CAUSES = Object.freeze(["gc", ...SIGNAL_CAUSES]);
const UNMATCHED = "unmatched";
const REST_CAUSES = Object.freeze([...SIGNAL_CAUSES, UNMATCHED]);
const COMPONENTS = Object.freeze(["tickWork", "gc", "lne", "rest"]);

const REASONS = Object.freeze({
  TELEMETRY_UNAVAILABLE: "TELEMETRY_UNAVAILABLE",
  SPIKES_DISABLED: "SPIKES_DISABLED",
  UNKNOWN_SHAPE: "UNKNOWN_SHAPE",
});

const SPIKE_RE = new RegExp(`${LINE_MARKER}(\\d+)ms at=(\\S+) source=(\\w+) tickWork=(\\d+) gc=(\\d+)/\\d+`
  + " lne=(\\d+) rest=(\\d+)");

function round(n, digits = 1) {
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function isObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil(p / 100 * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

function buildRows(names, valuesByName) {
  const rows = [];
  let total = 0;
  for (const name of names) {
    const values = (valuesByName[name] || []).filter((v) => v > 0).sort((a, b) => a - b);
    if (values.length === 0) continue;
    const sum = values.reduce((s, v) => s + v, 0);
    total += sum;
    rows.push({ cause: name, count: values.length, totalMs: round(sum), p95: round(percentile(values, P95)),
      maxMs: round(values[values.length - 1]) });
  }
  rows.sort((a, b) => b.totalMs - a.totalMs);
  return { rows, total: round(total) };
}

function formatTable(rows, total, shareLabel = "%rest") {
  const header = `| cause | count | totalMs | p95 | maxMs | ${shareLabel} |`;
  const sep = "|-------|-------|---------|-----|-------|-------|";
  const lines = [header, sep];
  for (const row of rows) {
    const pct = total > 0 ? round((row.totalMs / total) * 100, 1) : 0;
    lines.push(`| ${row.cause} | ${row.count} | ${row.totalMs} | ${row.p95} | ${row.maxMs} | ${pct} |`);
  }
  lines.push(sep);
  lines.push(`| TOTAL | ${rows.reduce((s, r) => s + r.count, 0)} | ${total} | - | - | 100.0 |`);
  return lines.join("\n");
}

function parseSpikeLog(text) {
  const spikes = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = SPIKE_RE.exec(line);
    if (m === null) continue;
    const atWallMs = Date.parse(m[2]);
    spikes.push({ intervalMs: Number(m[1]), atWallMs: Number.isFinite(atWallMs) ? atWallMs : null, source: m[3],
      tickWorkMs: Number(m[4]), gcMs: Number(m[5]), lneMs: Number(m[6]), restMs: Number(m[7]) });
  }
  return spikes;
}

function summarizeSpikeLog(spikes) {
  const values = { tickWork: [], gc: [], lne: [], rest: [] };
  const bySource = {};
  for (const s of SOURCES) bySource[s] = 0;
  for (const sp of spikes) {
    values.tickWork.push(sp.tickWorkMs);
    values.gc.push(sp.gcMs);
    values.lne.push(sp.lneMs);
    values.rest.push(sp.restMs);
    bySource[sp.source] = (bySource[sp.source] || 0) + 1;
  }
  const { rows, total } = buildRows(COMPONENTS, values);
  const restRow = rows.find((r) => r.cause === "rest");
  return { lines: spikes.length, rows, total, restMs: restRow ? restRow.totalMs : 0, bySource };
}

function parsePauseProfileEvents(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const events = [];
  for (const line of content.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      events.push(JSON.parse(line));
    } catch (_) {
    }
  }
  return events;
}

function classifySample(sample, gcMs = 0) {
  const s = isObject(sample) ? sample : {};
  const rd = isObject(s.resourceDelta) ? s.resourceDelta : {};
  const lagMs = Math.max(0, num(s.lagMs));
  const dbSignal = typeof rd.majorPageFault === "number" && Number.isFinite(rd.majorPageFault);
  let cause = "offCpu";
  if (num(rd.fsRead) > 0 || num(rd.fsWrite) > 0) cause = "io";
  else if (dbSignal && rd.majorPageFault > 0) cause = "db";
  else if (num(s.gapMs) > 0 && num(s.cpuUserMs) + num(s.cpuSystemMs) >= CPU_BUSY_RATIO * num(s.gapMs)) cause = "cpu";
  const parts = {};
  for (const c of LAG_CAUSES) parts[c] = 0;
  parts.gc = Math.min(lagMs, Math.max(0, num(gcMs)));
  parts[cause] = lagMs - parts.gc;
  return { cause, lagMs, parts, dbSignal };
}

function isSampleEvent(ev) {
  return isObject(ev) && (ev.type === "sample" || ev.type === "stall");
}

function gcPerSample(samples, events) {
  const out = samples.map(() => 0);
  for (const ev of events) {
    if (!isObject(ev) || ev.type !== "gc") continue;
    const end = num(ev.endMonoMs);
    const i = samples.findIndex((s) => num(s.intervalStartMonoMs) < end && end <= num(s.intervalEndMonoMs));
    if (i >= 0) out[i] += num(ev.totalDurationMs);
  }
  return out;
}

function profileSamples(events) {
  const list = Array.isArray(events) ? events : [];
  const samples = list.filter(isSampleEvent);
  const gc = gcPerSample(samples, list);
  return samples.map((s, i) => {
    const endWall = Date.parse(s.utc);
    const c = classifySample(s, gc[i]);
    return { ...c, wallStart: Number.isFinite(endWall) ? endWall - num(s.wallGapMs) : null,
      wallEnd: Number.isFinite(endWall) ? endWall : null };
  });
}

function aggregateFromPauseProfile(events) {
  const classified = profileSamples(events);
  const values = {};
  for (const c of LAG_CAUSES) values[c] = [];
  let dbSignalSamples = 0;
  for (const c of classified) {
    for (const k of LAG_CAUSES) values[k].push(c.parts[k]);
    if (c.dbSignal) dbSignalSamples += 1;
  }
  const { rows, total } = buildRows(LAG_CAUSES, values);
  return { rows, totalLag: total, samples: classified.length,
    dbSignalAvailable: classified.length > 0 && dbSignalSamples === classified.length };
}

function overlapMs(aStart, aEnd, bStart, bEnd) {
  const ms = Math.min(aEnd, bEnd) - Math.max(aStart, bStart);
  return ms > 0 ? ms : 0;
}

function correlateRestWithProfile(spikes, events) {
  const classified = profileSamples(events).filter((c) => c.wallStart !== null);
  const values = {};
  for (const c of REST_CAUSES) values[c] = [];
  let matched = 0;
  for (const sp of Array.isArray(spikes) ? spikes : []) {
    if (!(sp.restMs > 0)) continue;
    let best = null;
    let bestMs = 0;
    if (sp.atWallMs !== null) {
      const gs = sp.atWallMs - sp.intervalMs;
      for (const c of classified) {
        const ms = overlapMs(gs, sp.atWallMs, c.wallStart, c.wallEnd);
        if (ms > bestMs) {
          bestMs = ms;
          best = c;
        }
      }
    }
    if (best === null) {
      values[UNMATCHED].push(sp.restMs);
    } else {
      matched += 1;
      values[best.cause].push(sp.restMs);
    }
  }
  const { rows, total } = buildRows(REST_CAUSES, values);
  return { rows, totalRest: total, matched };
}

function profileRoot(env) {
  if (env.EVEJS_PAUSE_PROFILE_DIR) return path.resolve(env.EVEJS_PAUSE_PROFILE_DIR);
  return path.resolve(env.EVEJS_DATA_ROOT || process.cwd(), PAUSE_PROFILE_SUBDIR);
}

function findLatestPauseProfileDir(root) {
  if (!fs.existsSync(root)) return null;
  const dirs = fs.readdirSync(root)
    .map((d) => path.join(root, d))
    .filter((d) => fs.statSync(d).isDirectory())
    .sort()
    .reverse();
  return dirs[0] || null;
}

function resolveEventsFile(target, root) {
  let p = target;
  if (!p) {
    p = findLatestPauseProfileDir(root);
    if (p === null) throw new Error(`no pause profile directory under ${root} (start the server with EVEJS_PAUSE_PROFILE=1)`);
  }
  const file = fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.join(p, EVENTS_FILE) : p;
  if (!fs.existsSync(file)) throw new Error(`${EVENTS_FILE} not found: ${file}`);
  return file;
}

function fetchTelemetry(host, port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: host, port, path: "/api/views/telemetry", timeout: HTTP_TIMEOUT_MS }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (err) {
          reject(new Error(`Invalid JSON from telemetry (HTTP ${res.statusCode}): ${err.message}`));
        }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("Telemetry request timeout"));
    });
  });
}

function analyzeTelemetrySpikes(telemetryData) {
  let body = telemetryData;
  if (isObject(body) && isObject(body.data) && !Object.prototype.hasOwnProperty.call(body, "spikes")) body = body.data;
  if (isObject(body) && Object.prototype.hasOwnProperty.call(body, "available")) {
    if (body.available !== true) {
      return { ok: false, reason: REASONS.TELEMETRY_UNAVAILABLE, detail: String(body.reason || "available:false") };
    }
    body = body.snapshot;
  }
  if (!isObject(body) || !Object.prototype.hasOwnProperty.call(body, "spikes")) {
    return { ok: false, reason: REASONS.UNKNOWN_SHAPE, detail: "no snapshot.spikes" };
  }
  const st = body.spikes;
  if (st === null) {
    return { ok: false, reason: REASONS.SPIKES_DISABLED, detail: "telemetry.spikeAttribution is off" };
  }
  if (!isObject(st) || !isObject(st.bySource) || typeof st.total !== "number") {
    return { ok: false, reason: REASONS.UNKNOWN_SHAPE, detail: "snapshot.spikes is not { total, bySource, ... }" };
  }
  const names = [...SOURCES, ...Object.keys(st.bySource).filter((k) => !SOURCES.includes(k))];
  const rows = names
    .map((source) => ({ source, count: num(st.bySource[source]) }))
    .filter((r) => r.count > 0)
    .map((r) => ({ ...r, pct: st.total > 0 ? round((r.count / st.total) * 100, 1) : 0 }));
  return { ok: true, total: st.total, thresholdMs: st.thresholdMs, pending: num(st.pending), dropped: num(st.dropped),
    truncated: num(st.truncated), rows, last: isObject(st.last) ? { ...st.last } : null };
}

function formatTelemetry(r) {
  const lines = [`spikes total=${r.total} thresholdMs=${r.thresholdMs} pending=${r.pending} dropped=${r.dropped}`
    + ` truncated=${r.truncated}`, "| source | count | %spikes |", "|--------|-------|---------|"];
  for (const row of r.rows) lines.push(`| ${row.source} | ${row.count} | ${row.pct} |`);
  const l = r.last;
  lines.push(l === null ? "last: -"
    : `last: source=${l.source} interval=${Math.round(num(l.intervalMs))} tickWork=${Math.round(num(l.tickWorkMs))}`
      + ` gc=${Math.round(num(l.gcMs))} lne=${Math.round(num(l.lneMs))} rest=${Math.round(num(l.restMs))}`);
  lines.push("note: telemetry carries spike counts only; milliseconds of rest: --log <server log>");
  return lines.join("\n");
}

function printUsage() {
  console.error(`
Usage:
  node mods/livingNewEden/tools/restDiagnosis.js --log <server.log> [--json]
  node mods/livingNewEden/tools/restDiagnosis.js --profile [<dir|events.jsonl>] [--profile-root <dir>] [--log <server.log>] [--json]
  node mods/livingNewEden/tools/restDiagnosis.js --telemetry [--host <host>] [--port <port>] [--json]

Options:
  --log <file>          Server log with "telemetry: spike" lines (e.g. docker compose logs --no-color server > file)
  --profile [<path>]    Pause profile directory or events.jsonl (default: newest under --profile-root)
  --profile-root <dir>  Default: EVEJS_PAUSE_PROFILE_DIR, else <EVEJS_DATA_ROOT or cwd>/logs/pause-profiles
  --telemetry           GET /api/views/telemetry: spike counts per source (no milliseconds)
  --json                Output JSON instead of tables
  --host <host>         Telemetry host (default: ${DEFAULT_TELEMETRY_HOST})
  --port <port>         Telemetry port (default: ${DEFAULT_TELEMETRY_PORT})
  --help, -h            Show this help
`);
}

function optionValue(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  return v === undefined || v.startsWith("--") ? null : v;
}

function readSpikes(logPath) {
  return parseSpikeLog(fs.readFileSync(logPath, "utf8"));
}

function runLogMode(logPath, jsonOutput) {
  const summary = summarizeSpikeLog(readSpikes(logPath));
  if (jsonOutput) {
    console.log(JSON.stringify({ mode: "log", file: logPath, ...summary }, null, 2));
    return;
  }
  console.log(`spike lines: ${summary.lines} (rate limited; telemetry total counts every spike)`);
  console.log(formatTable(summary.rows, summary.total, "%sum"));
  console.log(`by source: ${Object.entries(summary.bySource).map(([k, v]) => `${k}=${v}`).join(" ")}`);
}

function runProfileMode(target, root, logPath, jsonOutput) {
  const file = resolveEventsFile(target, root);
  const events = parsePauseProfileEvents(file);
  const lag = aggregateFromPauseProfile(events);
  const rest = logPath ? correlateRestWithProfile(readSpikes(logPath), events) : null;
  if (jsonOutput) {
    console.log(JSON.stringify({ mode: "profile", file, lag, rest }, null, 2));
    return;
  }
  console.log(`profile: ${file} samples=${lag.samples} dbSignal=${lag.dbSignalAvailable ? "yes" : "unavailable"}`);
  console.log("event-loop lag (disjoint split):");
  console.log(formatTable(lag.rows, lag.totalLag, "%lag"));
  if (rest !== null) {
    console.log(`rest of spikes by profile sample cause (matched ${rest.matched}):`);
    console.log(formatTable(rest.rows, rest.totalRest, "%rest"));
  }
}

async function runTelemetryMode(host, port, jsonOutput) {
  const result = analyzeTelemetrySpikes(await fetchTelemetry(host, port));
  if (!result.ok) throw new Error(`${result.reason}: ${result.detail}`);
  if (jsonOutput) console.log(JSON.stringify({ mode: "telemetry", host, port, ...result }, null, 2));
  else console.log(formatTelemetry(result));
}

async function main(argv, env = process.env) {
  const args = argv.slice(2);
  if (args.includes("--help") || args.includes("-h") || args.length === 0) {
    printUsage();
    return 1;
  }
  const jsonOutput = args.includes("--json");
  const logPath = optionValue(args, "--log");
  if (logPath === null) {
    console.error("--log needs a file");
    return 1;
  }
  try {
    if (args.includes("--profile")) {
      const target = optionValue(args, "--profile");
      if (target !== null && /^\d+$/.test(target)) {
        console.error("--profile takes a directory or events.jsonl; the profiler runs inside the server "
          + "(EVEJS_PAUSE_PROFILE=1, EVEJS_PAUSE_PROFILE_SECONDS)");
        return 1;
      }
      const rootOpt = optionValue(args, "--profile-root");
      runProfileMode(target || null, rootOpt ? path.resolve(rootOpt) : profileRoot(env), logPath, jsonOutput);
      return 0;
    }
    if (args.includes("--telemetry")) {
      const host = optionValue(args, "--host") || DEFAULT_TELEMETRY_HOST;
      const portOpt = optionValue(args, "--port");
      const port = portOpt ? parseInt(portOpt, 10) : DEFAULT_TELEMETRY_PORT;
      if (!Number.isSafeInteger(port) || port <= 0) {
        console.error("Invalid --port");
        return 1;
      }
      await runTelemetryMode(host, port, jsonOutput);
      return 0;
    }
    if (logPath) {
      runLogMode(logPath, jsonOutput);
      return 0;
    }
  } catch (err) {
    console.error(`restDiagnosis failed: ${err.message}`);
    return 1;
  }
  printUsage();
  return 1;
}

if (require.main === module) {
  main(process.argv).then((code) => {
    process.exitCode = code;
  }).catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

module.exports = {
  REASONS,
  SIGNAL_CAUSES,
  LAG_CAUSES,
  parseSpikeLog,
  summarizeSpikeLog,
  parsePauseProfileEvents,
  classifySample,
  aggregateFromPauseProfile,
  correlateRestWithProfile,
  analyzeTelemetrySpikes,
  formatTable,
  main,
};
