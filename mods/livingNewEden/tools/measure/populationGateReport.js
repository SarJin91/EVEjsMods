#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { sampleLoop } = require("../scalingBench");
const { extractRow, snapshotOf, viewOf } = require("./populationGate/extract");
const { THRESHOLDS, roleOf, summarizePhase, verdict, withThreshold } = require("./populationGate/aggregate");
const { decodeLog } = require("./populationGate/logScan");

const TOOL = "populationGateReport";
const FORMAT = 1;
const EXIT = Object.freeze({ OK: 0, USAGE: 1, BAD_INPUT: 2, FAILED: 3 });
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60000;
const DEFAULTS = Object.freeze({ minutes: 125, everyS: 30, minEveryS: 10, viewsEveryS: 300, minViewsEveryS: 60,
  baseUrl: "http://127.0.0.1:26410", timeoutMs: 10000 });
const TELEMETRY_PATH = "/api/views/telemetry";
const VIEW_PATHS = Object.freeze([["status", "/api/views/status"], ["population", "/api/views/population"]]);
const BOOLEAN_FLAGS = Object.freeze(["no-log"]);
const LIST_FLAGS = Object.freeze(["phase", "base", "threshold"]);
const SAMPLES_FILE = "samples.jsonl";
const LOG_FILE = "log.txt";
const LABEL = /^[0-9A-Za-z]{1,8}$/u;

const USAGE = [
  "usage: node mods/livingNewEden/tools/measure/populationGateReport.js sample --label <0|A|B> --out <dir>/samples.jsonl",
  "         [--minutes 125] [--every-s 30] [--views-every-s 300] [--base-url http://127.0.0.1:26410]",
  "       node .../populationGateReport.js report --phase 0=<dir> --phase A=<dir> --phase B=<dir>",
  "         [--base A=0] [--threshold <name>=<n>] [--no-log] [--md f] [--json f]",
  "       node .../populationGateReport.js report --phase T=<dir> --phase L=<dir> --phase N=<dir>  (life cycle gate)",
  "         [--base L=N] [--threshold <name>=<n>] [--no-log] [--md f] [--json f]",
].join("\n");

const messageOf = (err) => String((err && err.message) || err);
const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return { ok: false, error: "no command" };
  const [cmd, ...rest] = argv;
  const opts = { phase: [], base: [], threshold: [] };
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

function extractForLoop(fetched) {
  const row = extractRow(fetched);
  return row ? { ok: true, row } : { ok: false };
}

async function runSample(opts, io) {
  const label = opts.label;
  if (typeof label !== "string" || !LABEL.test(label)) return io.usage("--label is required (0, A, B, 0B, T, L, N ...)");
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
  if (io.fs.existsSync(out)) return io.usage(`--out ${out} exists (one new directory per phase)`);
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
      header: { label, baseUrl, everyS: every.value, viewsEveryS: views.value, toolFormat: FORMAT },
      shouldStop: () => stopped,
      extract: extractForLoop,
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

function parseSamples(text, name) {
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
  if (!isObject(header) || header.type !== "header" || header.tool !== TOOL) {
    return { ok: false, error: `${name}: line 1 is not a ${TOOL} header` };
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

function pairsOf(list, flag) {
  const map = new Map();
  for (const spec of list) {
    const i = spec.indexOf("=");
    const key = i > 0 ? spec.slice(0, i) : "";
    const value = i > 0 ? spec.slice(i + 1) : "";
    if (!LABEL.test(key) || value === "") return { ok: false, error: `--${flag} ${spec}: expected <label>=<value>` };
    if (map.has(key)) return { ok: false, error: `--${flag} ${key} given twice` };
    map.set(key, value);
  }
  return { ok: true, map };
}

const cell = (v) => (v === null || v === undefined ? "-" : typeof v === "number" ? String(Math.round(v * 1000) / 1000)
  : String(v)).replace(/\|/gu, "/");

function renderMarkdown(r) {
  const v = r.verdict;
  const lines = [`## populationGateReport: ${v.verdict}`, ""];
  if (v.reasons.length > 0) lines.push(...v.reasons.map((x) => `- ${x}`), "");
  for (const p of v.phases) {
    lines.push(`### Phase ${p.label} (${p.role}): ${p.incomplete.length > 0 ? "INCOMPLETE" : p.ok ? "PASS" : "FAIL"}`, "");
    lines.push("| metric | value | threshold | result | note |", "|---|---|---|---|---|");
    for (const c of p.checks) {
      lines.push(`| ${cell(c.name)} | ${cell(c.value)} | ${cell(c.limit)} | ${c.result} | ${cell(c.note || "")} |`);
    }
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

async function runReport(opts, io) {
  if (opts.phase.length === 0) return io.usage("report needs at least one --phase <label>=<dir>");
  const phasesArg = pairsOf(opts.phase, "phase");
  if (!phasesArg.ok) return io.usage(phasesArg.error);
  const basesArg = pairsOf(opts.base, "base");
  if (!basesArg.ok) return io.usage(basesArg.error);
  let thresholds = THRESHOLDS;
  for (const spec of opts.threshold) {
    const r = withThreshold(thresholds, spec);
    if (!r.ok) return io.usage(r.reason);
    thresholds = r.thresholds;
  }
  const noLog = opts["no-log"] === true;
  const summaries = [];
  for (const [label, dir] of phasesArg.map) {
    const role = roleOf(label);
    if (role === null) return io.usage(`--phase ${label}: the label starts with 0, A, B, T, L or N`);
    const samplesFile = path.resolve(dir, SAMPLES_FILE);
    let text;
    try {
      text = io.fs.readFileSync(samplesFile, "utf8");
    } catch (err) {
      io.err(`${TOOL}: cannot read ${samplesFile} - ${messageOf(err)}`);
      return EXIT.USAGE;
    }
    const parsed = parseSamples(text, samplesFile);
    if (!parsed.ok) {
      io.err(`${TOOL}: ${parsed.error}`);
      return EXIT.BAD_INPUT;
    }
    let logText = null;
    if (role !== "base") {
      const logFile = path.resolve(dir, LOG_FILE);
      if (io.fs.existsSync(logFile)) {
        try {
          logText = decodeLog(io.fs.readFileSync(logFile));
        } catch (err) {
          io.err(`${TOOL}: cannot read ${logFile} - ${messageOf(err)}`);
          return EXIT.USAGE;
        }
      } else if (!noLog && role !== "tempo") {
        io.err(`${TOOL}: no ${logFile} (docker compose logs --timestamps --no-log-prefix server; --no-log only for `
          + "the liveSim rehearsal)");
        return EXIT.USAGE;
      }
    }
    summaries.push(summarizePhase({ label, header: parsed.header, rows: parsed.rows, footer: parsed.footer, logText },
      thresholds));
  }
  const v = verdict(summaries, Object.fromEntries(basesArg.map), thresholds);
  const report = { tool: TOOL, format: FORMAT, kind: "report", thresholds, verdict: v };
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
    fs: given.fs || fs,
    now: given.now || (() => Date.now()),
    fetch: given.fetch || (typeof globalThis.fetch === "function" ? globalThis.fetch : null),
    timeoutSignal: given.timeoutSignal || ((ms) => AbortSignal.timeout(ms)),
    setTimer: given.setTimer || ((fn, ms) => setTimeout(fn, ms)),
    clearTimer: given.clearTimer || ((t) => clearTimeout(t)),
    onSigint: given.onSigint || ((fn) => process.on("SIGINT", fn)),
    offSigint: given.offSigint || ((fn) => process.removeListener("SIGINT", fn)),
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

module.exports = { TOOL, FORMAT, EXIT, parseArgs, parseSamples, createFetcher, renderMarkdown, main };
