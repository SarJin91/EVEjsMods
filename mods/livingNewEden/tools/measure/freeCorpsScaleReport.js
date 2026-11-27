#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { sampleLoop } = require("../scalingBench");
const { extractRow, snapshotOf, viewOf } = require("./freeCorpsScale/extract");
const { THRESHOLDS, PHASE_FLAGS, STEPS, summarize, verdict, recommend, withThreshold } =
  require("./freeCorpsScale/aggregate");
const { runCensus, REASONS: CENSUS_REASONS } = require("./freeCorpsScale/census");
const offline = require("../offlineDb");

const TOOL = "freeCorpsScaleReport";
const FORMAT = 1;
const EXIT = Object.freeze({ OK: 0, USAGE: 1, REFUSED: 2, FAILED: 3 });
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60000;
const DEFAULTS = Object.freeze({ minutes: 1500, everyS: 300, minEveryS: 60, viewsEveryS: 1800, minViewsEveryS: 300,
  baseUrl: "http://127.0.0.1:26410", timeoutMs: 10000 });
const TELEMETRY_PATH = "/api/views/telemetry";
const VIEW_PATHS = Object.freeze([["status", "/api/views/status"], ["fleets", "/api/views/fleets"],
  ["freeCorps", "/api/views/free-corps"]]);
const BOOLEAN_FLAGS = Object.freeze(["early", "snapshot"]);
const LIST_FLAGS = Object.freeze(["in", "threshold"]);
const TARGETS = Object.freeze(["start", "stretch"]);

const USAGE = [
  "usage: node mods/livingNewEden/tools/measure/freeCorpsScaleReport.js sample --label <L> --out <file.jsonl>",
  "         [--minutes 1500] [--every-s 300] [--views-every-s 1800] [--base-url http://127.0.0.1:26410]",
  "       node .../freeCorpsScaleReport.js census [--snapshot] [--tmp-dir <dir>] --out <file.json> [--db <file>]",
  "       node .../freeCorpsScaleReport.js report --in <seg.jsonl> [--in ...] --target start|stretch",
  "         [--phase core|pvp|full] [--step S0..S4] [--early] [--census-start f] [--census-end f] [--docker-start f]",
  "         [--docker-end f] [--log f] [--audit f] [--prev report.json] [--threshold <path>=<n>] [--md f] [--json f]",
].join("\n");

const messageOf = (err) => String((err && err.message) || err);
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return { ok: false, error: "no command" };
  const [cmd, ...rest] = argv;
  const opts = { in: [], threshold: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i];
    if (!key.startsWith("--")) return { ok: false, error: `unexpected argument ${key}` };
    const name = key.slice(2);
    if (BOOLEAN_FLAGS.includes(name)) {
      opts[name] = true;
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) return { ok: false, error: `${key} needs a value` };
    i += 1;
    if (LIST_FLAGS.includes(name)) opts[name].push(value);
    else if (Object.prototype.hasOwnProperty.call(opts, name)) return { ok: false, error: `${key} given twice` };
    else opts[name] = value;
  }
  return { ok: true, cmd, opts };
}

function numArg(v, min, fallback) {
  if (v === undefined) return { ok: true, value: fallback };
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? { ok: true, value: n } : { ok: false };
}

function createFetcher(deps) {
  const stats = { viewErrors: 0 };
  let lastSeq = null;
  let lastStartedAt = null;
  let lastViewsAt = null;
  async function getJson(p) {
    const res = await deps.fetch(`${deps.baseUrl}${p}`, { signal: deps.timeoutSignal(deps.timeoutMs) });
    if (!res || res.status !== 200) throw new Error(`HTTP ${res ? res.status : "-"} ${p}`);
    return res.json();
  }
  async function readSnapshot() {
    const telemetry = await getJson(TELEMETRY_PATH);
    const snap = snapshotOf(telemetry);
    if (!isObject(snap)) throw new Error("telemetry unavailable");
    const out = { telemetry };
    if (snap.seq === lastSeq && snap.startedAtMs === lastStartedAt) return out;
    const t = deps.now();
    const newProcess = snap.startedAtMs !== lastStartedAt;
    lastSeq = snap.seq;
    lastStartedAt = snap.startedAtMs;
    if (newProcess || lastViewsAt === null || t - lastViewsAt >= deps.viewsEveryMs) {
      lastViewsAt = t;
      let errors = 0;
      for (const [key, p] of VIEW_PATHS) {
        try {
          const body = await getJson(p);
          if (viewOf(body) === null) throw new Error(`${p} unavailable`);
          out[key] = body;
        } catch (_err) {
          errors += 1;
          out[key] = null;
        }
      }
      out.viewErrors = errors;
      stats.viewErrors += errors;
    }
    return out;
  }
  return { readSnapshot, stats };
}

function createSleeper(io) {
  let pending = null;
  return {
    sleep(ms) {
      return new Promise((resolve) => {
        const timer = io.setTimer(() => {
          pending = null;
          resolve();
        }, ms);
        pending = { timer, resolve };
      });
    },
    wake() {
      if (pending === null) return;
      io.clearTimer(pending.timer);
      const { resolve } = pending;
      pending = null;
      resolve();
    },
  };
}

async function runSample(opts, io) {
  const label = opts.label;
  if (typeof label !== "string" || label.trim() === "") return io.usage("--label is required");
  if (typeof opts.out !== "string" || opts.out === "") return io.usage("--out is required");
  const minutes = numArg(opts.minutes, Number.MIN_VALUE, DEFAULTS.minutes);
  if (!minutes.ok) return io.usage("--minutes must be a number > 0");
  const every = numArg(opts["every-s"], DEFAULTS.minEveryS, DEFAULTS.everyS);
  if (!every.ok) return io.usage(`--every-s must be a number >= ${DEFAULTS.minEveryS}`);
  const views = numArg(opts["views-every-s"], DEFAULTS.minViewsEveryS, DEFAULTS.viewsEveryS);
  if (!views.ok) return io.usage(`--views-every-s must be a number >= ${DEFAULTS.minViewsEveryS}`);
  const baseUrl = typeof opts["base-url"] === "string" ? opts["base-url"].replace(/\/+$/u, "") : DEFAULTS.baseUrl;
  if (!/^https?:\/\//u.test(baseUrl)) return io.usage("--base-url must start with http:// or https://");
  if (typeof io.fetch !== "function") {
    io.err(`${TOOL}: no global fetch (Node >= 18 needed)`);
    return EXIT.FAILED;
  }
  const out = path.resolve(opts.out);
  if (io.fs.existsSync(out)) return io.usage(`--out ${out} exists (one new file per segment)`);
  let fd;
  try {
    fd = io.fs.openSync(out, "wx");
  } catch (err) {
    io.err(`${TOOL}: cannot create --out ${out} - ${messageOf(err)}`);
    return EXIT.FAILED;
  }
  const fetcher = createFetcher({ fetch: io.fetch, baseUrl, viewsEveryMs: views.value * MS_PER_SECOND, now: io.now,
    timeoutSignal: io.timeoutSignal, timeoutMs: DEFAULTS.timeoutMs });
  const sleeper = createSleeper(io);
  let stopped = false;
  const onSigint = () => {
    stopped = true;
    sleeper.wake();
  };
  io.onSigint(onSigint);
  io.out(`${TOOL}: sample ${label} base=${baseUrl} every=${every.value}s views=${views.value}s minutes=${minutes.value} `
    + `out=${out}`);
  let result;
  try {
    result = await sampleLoop({
      readFile: () => Promise.reject(new Error("unused")),
      appendLine: (line) => io.fs.writeSync(fd, line),
      now: io.now,
      sleep: (ms) => sleeper.sleep(ms),
      file: baseUrl,
      everyMs: every.value * MS_PER_SECOND,
      durationMs: minutes.value * MS_PER_MINUTE,
      header: { label, baseUrl, everyS: every.value, viewsEveryS: views.value },
      shouldStop: () => stopped,
      extract: extractRow,
      readSnapshot: () => fetcher.readSnapshot(),
      tool: TOOL,
    });
  } finally {
    io.offSigint(onSigint);
    try {
      io.fs.closeSync(fd);
    } catch (_err) {
    }
  }
  io.out(`${TOOL}: rows=${result.rows} readErrors=${result.readErrors} unchangedReads=${result.unchangedReads} `
    + `viewErrors=${fetcher.stats.viewErrors}${stopped ? " (SIGINT)" : ""}`);
  if (result.writeError) {
    io.err(`${TOOL}: write to ${out} failed - ${result.writeError}`);
    return EXIT.FAILED;
  }
  return EXIT.OK;
}

async function runCensusCmd(opts, io) {
  if (typeof opts.out !== "string" || opts.out === "") return io.usage("--out is required");
  const driver = io.driver || offline.loadDriver();
  if (!driver || !driver.ok || typeof driver.Database !== "function") {
    io.err(`${TOOL}: no sqlite driver (${(driver && (driver.reason || driver.detail)) || "-"})`);
    return EXIT.FAILED;
  }
  const { file } = offline.resolveDbFile(opts.db, io.env);
  if (!io.fs.existsSync(file)) {
    io.err(`${TOOL}: no database ${file}`);
    return EXIT.USAGE;
  }
  const r = runCensus({ file, snapshot: opts.snapshot === true, tmpDir: opts["tmp-dir"] || os.tmpdir(), driver: driver,
    now: io.now });
  if (!r.ok) {
    if (r.reason === CENSUS_REASONS.LOCKED) {
      io.err(`${offline.LOCKED_MESSAGE} Or run with --snapshot (a copy of the database, works while the server runs).`);
      return EXIT.REFUSED;
    }
    if (r.reason === CENSUS_REASONS.NOT_LNE) {
      io.err(`REFUSED: this is not a Living New Eden database (${r.detail})`);
      return EXIT.REFUSED;
    }
    io.err(`${TOOL}: census failed ${r.reason} - ${r.detail}`);
    return EXIT.FAILED;
  }
  try {
    io.fs.writeFileSync(path.resolve(opts.out), `${JSON.stringify({ ...r.census, file }, null, 2)}\n`, "utf8");
  } catch (err) {
    io.err(`${TOOL}: cannot write --out - ${messageOf(err)}`);
    return EXIT.FAILED;
  }
  for (const n of r.notes) io.out(`  note: ${n}`);
  io.out(`${TOOL}: census schema ${r.census.schemaVersion}, free corps open ${r.census.freeCorps
    ? r.census.freeCorps.open : "-"}, fleets active ${r.census.fleets ? r.census.fleets.active : "-"} -> ${opts.out}`);
  return EXIT.OK;
}

function parseSegment(text, name) {
  const lines = String(text).split(/\r?\n/u).filter((l) => l.trim() !== "");
  if (lines.length === 0) return { ok: false, error: `${name}: empty file` };
  const objs = [];
  for (let i = 0; i < lines.length; i += 1) {
    try {
      objs.push(JSON.parse(lines[i]));
    } catch (err) {
      return { ok: false, error: `${name}:${i + 1}: bad JSON - ${messageOf(err)}` };
    }
  }
  const header = objs[0];
  if (!isObject(header) || header.type !== "header" || header.tool !== TOOL || header.format !== FORMAT) {
    return { ok: false, error: `${name}: line 1 is not a ${TOOL} format ${FORMAT} header` };
  }
  const rows = [];
  let footer = null;
  for (let i = 1; i < objs.length; i += 1) {
    const o = objs[i];
    if (isObject(o) && o.type === "row" && footer === null) rows.push(o);
    else if (isObject(o) && o.type === "footer" && footer === null) footer = o;
    else return { ok: false, error: `${name}:${i + 1}: unexpected line type ${o && o.type}` };
  }
  return { ok: true, header, rows, footer };
}

const fmt = (v) => (typeof v === "number" && Number.isFinite(v) ? String(Number(v.toFixed(3))) : "-");

function renderMarkdown(r) {
  const s = r.summary;
  const v = r.verdict;
  const rec = r.recommendation;
  const lines = [`## freeCorpsScaleReport ${r.step || "S0"} (${r.target}${r.phase ? `, phase ${r.phase}` : ""}`
    + `${r.early ? ", --early" : ""}): ${v.verdict}`, "",
  `- rows ${s.rows} (after warmup ${s.measuredRows}, steady state ${s.steadyRows}), segments ${s.segments}, `
    + `restarts ${s.restarts}, readErrors ${s.readErrors}, viewErrors ${s.viewErrors}`,
  `- coverage ${fmt(s.coverage.measuredHours)} h, steady state ${fmt(s.coverage.steadyHours)} h (${s.coverage.steadyRule})`,
  `- tick p95 median ${fmt(s.tick.p95Median)} ms, worst window ${fmt(s.tick.p95Worst)}, max ${fmt(s.tick.max)}`,
  `- freeCorps.passMs p95 ${fmt(s.histograms.passMs.p95Worst)} / max ${fmt(s.histograms.passMs.max)} ms; saga p95 `
    + `${fmt(s.saga.p95Worst)} / max ${fmt(s.saga.max)} ms (${s.saga.state})`,
  `- WAL ${fmt(s.wal.framesPerS)} frames/s, freeCorps (estimate) ${fmt(s.wal.fcRowsPerSEstimate)} /s, `
    + `freeCorps (measured) ${fmt(s.wal.measured ? s.wal.measured.fcFramesPerS : null)} frames/s, checkpoint p95 `
    + `${fmt(s.checkpoint.p95Ms)} ms`,
  `- heap afterMajor delta ${fmt(s.heap.deltaMb)} MB (${s.heap.mode}), container RSS `
    + `${fmt(s.rss.containerEndBytes === null ? null : s.rss.containerEndBytes / 1073741824)} GiB`,
  `- seedMs of the first rows of each segment: ${s.seedMs.map(fmt).join(", ") || "-"}`];
  const deferred = [["tick", s.tick], ["passMs", s.histograms.passMs], ["saga", s.saga]]
    .filter(([, h]) => h && h.histogramsDeferred).map(([n, h]) => `${n} ${h.deferredWindows}`);
  if (deferred.length > 0) lines.push(`- histogramsDeferred: windows ${deferred.join(", ")} (p95 may be older)`);
  if (v.missing.length > 0) lines.push("", ...v.missing.map((m) => `- missing: ${m}`));
  const gates = Object.values(v.gates || {});
  if (gates.length > 0) {
    lines.push("", "| gate | result | blocking | details |", "|---|---|---|---|");
    for (const g of gates) {
      lines.push(`| ${g.id} | ${g.status} | ${g.blocking ? "yes" : "no"} | ${g.lines.join("; ").replace(/\|/gu, "/")} |`);
    }
  }
  if (v.early && v.lines.length > 0) lines.push("", ...v.lines.map((l) => `- ${l}`));
  lines.push("", `Recommendation: ${rec.action}${rec.next ? ` ${rec.next}` : ""}`, ...rec.lines.map((l) => `- ${l}`));
  if (rec.env.length > 0) lines.push("", "```", ...rec.env, "```");
  if (rec.rows.length > 0) {
    lines.push("", "| FAIL gate | likely cause | knob (first) | follow-up |", "|---|---|---|---|");
    for (const row of rec.rows) lines.push(`| ${row.gate} | ${row.cause} | ${row.knob} | ${row.task} |`);
  }
  if (s.log && s.log.stallDiagLines.length > 0) lines.push("", "stall-diag:", ...s.log.stallDiagLines.map((l) => `    ${l}`));
  return `${lines.join("\n")}\n`;
}

function readOptional(io, file, kind) {
  if (file === undefined) return { ok: true, value: null };
  let text;
  try {
    text = io.fs.readFileSync(path.resolve(file), "utf8");
  } catch (err) {
    return { ok: false, code: EXIT.USAGE, error: `cannot read ${file} - ${messageOf(err)}` };
  }
  if (kind === "text") return { ok: true, value: text };
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, code: EXIT.FAILED, error: `${file}: bad JSON - ${messageOf(err)}` };
  }
}

async function runReport(opts, io) {
  if (opts.in.length === 0) return io.usage("report needs at least one --in");
  if (!TARGETS.includes(opts.target)) return io.usage("--target must be start or stretch");
  if (opts.phase !== undefined && !PHASE_FLAGS[opts.phase]) return io.usage("--phase must be core, pvp or full");
  if (opts.step !== undefined && !STEPS.includes(opts.step)) return io.usage(`--step must be one of ${STEPS.join(", ")}`);
  let thresholds = THRESHOLDS;
  for (const spec of opts.threshold) {
    const r = withThreshold(thresholds, spec);
    if (!r.ok) return io.usage(r.reason);
    thresholds = r.thresholds;
  }
  const headers = [];
  const footers = [];
  const rows = [];
  for (const file of opts.in) {
    let text;
    try {
      text = io.fs.readFileSync(path.resolve(file), "utf8");
    } catch (err) {
      io.err(`${TOOL}: cannot read ${file} - ${messageOf(err)}`);
      return EXIT.USAGE;
    }
    const seg = parseSegment(text, file);
    if (!seg.ok) {
      io.err(`${TOOL}: ${seg.error}`);
      return EXIT.FAILED;
    }
    headers.push(seg.header);
    if (seg.footer) footers.push(seg.footer);
    rows.push(...seg.rows);
  }
  const inputs = {};
  for (const [key, opt, kind] of [["censusStart", "census-start", "json"], ["censusEnd", "census-end", "json"],
    ["dockerStart", "docker-start", "text"], ["dockerEnd", "docker-end", "text"], ["logText", "log", "text"],
    ["audit", "audit", "json"], ["prev", "prev", "json"]]) {
    const r = readOptional(io, opts[opt], kind);
    if (!r.ok) {
      io.err(`${TOOL}: ${r.error}`);
      return r.code;
    }
    inputs[key] = r.value;
  }
  const summary = summarize({ rows, headers, footers, censusStart: inputs.censusStart, censusEnd: inputs.censusEnd,
    dockerStart: inputs.dockerStart, dockerEnd: inputs.dockerEnd, logText: inputs.logText, audit: inputs.audit },
  thresholds);
  const v = verdict(summary, { target: opts.target, phase: opts.phase, step: opts.step, early: opts.early === true,
    prev: inputs.prev, thresholds });
  const recommendation = recommend(summary, v, { step: opts.step });
  const report = { tool: TOOL, format: FORMAT, kind: "report", target: opts.target, phase: opts.phase || null,
    step: opts.step || null, early: opts.early === true, thresholds, summary, verdict: v, recommendation };
  const md = renderMarkdown(report);
  io.out(md.trimEnd());
  try {
    if (typeof opts.md === "string") io.fs.writeFileSync(path.resolve(opts.md), md, "utf8");
    if (typeof opts.json === "string") {
      io.fs.writeFileSync(path.resolve(opts.json), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    }
  } catch (err) {
    io.err(`${TOOL}: cannot write the report - ${messageOf(err)}`);
    return EXIT.FAILED;
  }
  return EXIT.OK;
}

async function main(argv, ioIn) {
  const given = ioIn || {};
  const io = {
    out: given.out || ((s) => process.stdout.write(`${s}\n`)),
    err: given.err || ((s) => process.stderr.write(`${s}\n`)),
    env: given.env || process.env,
    fs: given.fs || fs,
    now: given.now || (() => Date.now()),
    fetch: given.fetch || (typeof globalThis.fetch === "function" ? globalThis.fetch : null),
    timeoutSignal: given.timeoutSignal || ((ms) => AbortSignal.timeout(ms)),
    setTimer: given.setTimer || ((fn, ms) => setTimeout(fn, ms)),
    clearTimer: given.clearTimer || ((t) => clearTimeout(t)),
    onSigint: given.onSigint || ((fn) => process.on("SIGINT", fn)),
    offSigint: given.offSigint || ((fn) => process.removeListener("SIGINT", fn)),
    driver: given.driver || null,
  };
  io.usage = (msg) => {
    io.err(`${TOOL}: ${msg}`);
    io.err(USAGE);
    return EXIT.USAGE;
  };
  const parsed = parseArgs(argv);
  if (!parsed.ok) return io.usage(parsed.error);
  try {
    if (parsed.cmd === "sample") return await runSample(parsed.opts, io);
    if (parsed.cmd === "census") return await runCensusCmd(parsed.opts, io);
    if (parsed.cmd === "report") return await runReport(parsed.opts, io);
  } catch (err) {
    io.err(`${TOOL}: failed - ${messageOf(err)}`);
    return EXIT.FAILED;
  }
  return io.usage(`unknown command ${parsed.cmd}`);
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

module.exports = { TOOL, FORMAT, EXIT, parseArgs, parseSegment, createFetcher, renderMarkdown, main };
