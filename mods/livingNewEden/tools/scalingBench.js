"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { resolveDataDir } = require("../config");
const { extractRow } = require("./scaling/extract");
const { DEFAULT_THRESHOLDS, auditSummaryOf, summarizeStage, recommend, pickRssBaseline } =
  require("./scaling/aggregate");
const { renderMarkdown, renderJson } = require("./scaling/render");

const MOD_DIR = path.resolve(__dirname, "..");
const TOOL = "scalingBench";
const FORMAT = 1;
const AXES = Object.freeze(["instrument", "control", "base", "virtual", "physical"]);
const DEFAULT_EVERY_S = 10;
const MIN_EVERY_S = 5;
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60000;
const TELEMETRY_DIR = "telemetry";
const SNAPSHOT_FILE = "latest.json";
const EXIT = Object.freeze({ OK: 0, USAGE: 1, FAILED: 3 });

const USAGE = [
  "usage: node mods/livingNewEden/tools/scalingBench.js sample --label <L> --axis <" + AXES.join("|") + ">",
  "         --minutes <n> --out <file.jsonl> [--bench-fleets <n>] [--demo-multiplier <m>] [--note <txt>]",
  "         [--file <latest.json>] [--every-s <s>]",
  "       node mods/livingNewEden/tools/scalingBench.js report --in <a.jsonl> [--in <b.jsonl> ...] [--ai-fleets <n>]",
  "         [--warmup-min 10] [--warn-ms 120] [--fail-ms 130] [--stop-ms 500] [--md <out.md>] [--json <out.json>]",
  "         [--audit <stage label>=<audit.json> ...] [--rss-baseline <label|none>]",
].join("\n");

function messageOf(err) {
  return String((err && err.message) || err);
}

async function sampleLoop(deps) {
  const { readFile, appendLine, now, sleep, file, everyMs, durationMs, header } = deps;
  const stop = typeof deps.shouldStop === "function" ? deps.shouldStop : () => false;
  const extract = typeof deps.extract === "function" ? deps.extract : extractRow;
  const readSnapshot = typeof deps.readSnapshot === "function" ? deps.readSnapshot
    : async (f) => JSON.parse(await readFile(f));
  const tool = typeof deps.tool === "string" && deps.tool !== "" ? deps.tool : TOOL;
  const out = { rows: 0, readErrors: 0, unchangedReads: 0 };
  const write = (obj) => {
    try {
      appendLine(`${JSON.stringify(obj)}\n`);
      return true;
    } catch (err) {
      out.writeError = messageOf(err);
      return false;
    }
  };
  try {
    const startMs = now();
    if (!write({ type: "header", tool, format: FORMAT, ...header, file, startedAtMs: startMs })) return out;
    let lastSeq = null;
    for (;;) {
      let row = null;
      try {
        const extracted = extract(await readSnapshot(file));
        if (extracted.ok) row = extracted.row;
        else out.readErrors += 1;
      } catch (_err) {
        out.readErrors += 1;
      }
      if (row !== null) {
        if (row.seq === lastSeq) out.unchangedReads += 1;
        else {
          if (!write({ type: "row", ...row })) return out;
          lastSeq = row.seq;
          out.rows += 1;
        }
      }
      const left = durationMs - (now() - startMs);
      if (left <= 0 || stop()) break;
      await sleep(Math.min(everyMs, left));
      if (stop()) break;
    }
    write({ type: "footer", rows: out.rows, readErrors: out.readErrors, unchangedReads: out.unchangedReads,
      endedAtMs: now() });
  } catch (err) {
    out.writeError = out.writeError || messageOf(err);
  }
  return out;
}

function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return { ok: false, error: "no command" };
  const [cmd, ...rest] = argv;
  const opts = { in: [], audit: [] };
  for (let i = 0; i < rest.length; i += 1) {
    const key = rest[i];
    if (!key.startsWith("--")) return { ok: false, error: `unexpected argument ${key}` };
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) return { ok: false, error: `${key} needs a value` };
    i += 1;
    const name = key.slice(2);
    if (name === "in" || name === "audit") opts[name].push(value);
    else opts[name] = value;
  }
  return { ok: true, cmd, opts };
}

function intArg(v, min, fallback) {
  if (v === undefined) return { ok: true, value: fallback };
  const n = Number(v);
  return Number.isSafeInteger(n) && n >= min ? { ok: true, value: n } : { ok: false };
}

function numArg(v, min, fallback) {
  if (v === undefined) return { ok: true, value: fallback };
  const n = Number(v);
  return Number.isFinite(n) && n >= min ? { ok: true, value: n } : { ok: false };
}

function createSleeper() {
  let pending = null;
  return {
    sleep(ms) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending = null;
          resolve();
        }, ms);
        pending = { timer, resolve };
      });
    },
    wake() {
      if (pending === null) return;
      clearTimeout(pending.timer);
      const { resolve } = pending;
      pending = null;
      resolve();
    },
  };
}

async function runSample(opts, io) {
  const label = opts.label;
  if (typeof label !== "string" || label.trim() === "") return io.usage("--label is required");
  if (!AXES.includes(opts.axis)) return io.usage(`--axis must be one of ${AXES.join(", ")}`);
  const minutes = numArg(opts.minutes, Number.MIN_VALUE, undefined);
  if (!minutes.ok || minutes.value === undefined) return io.usage("--minutes must be a number > 0");
  if (typeof opts.out !== "string" || opts.out === "") return io.usage("--out is required");
  const bench = intArg(opts["bench-fleets"], 0, 0);
  if (!bench.ok) return io.usage("--bench-fleets must be an integer >= 0");
  const demo = intArg(opts["demo-multiplier"], 1, 1);
  if (!demo.ok) return io.usage("--demo-multiplier must be an integer >= 1");
  const every = numArg(opts["every-s"], MIN_EVERY_S, DEFAULT_EVERY_S);
  if (!every.ok) return io.usage(`--every-s must be a number >= ${MIN_EVERY_S}`);
  const out = path.resolve(opts.out);
  if (io.fs.existsSync(out)) return io.usage(`--out ${out} exists (one new file per stage)`);
  const file = typeof opts.file === "string" && opts.file !== "" ? path.resolve(opts.file)
    : path.join(resolveDataDir(io.env, MOD_DIR), TELEMETRY_DIR, SNAPSHOT_FILE);

  let fd;
  try {
    fd = io.fs.openSync(out, "wx");
  } catch (err) {
    io.err(`scalingBench: cannot create --out ${out} - ${messageOf(err)}`);
    return EXIT.FAILED;
  }
  const sleeper = createSleeper();
  let stopped = false;
  const onSigint = () => {
    stopped = true;
    sleeper.wake();
  };
  io.onSigint(onSigint);
  io.out(`scalingBench: sample ${label} axis=${opts.axis} file=${file} every=${every.value}s `
    + `minutes=${minutes.value} out=${out}`);
  let result;
  try {
    result = await sampleLoop({
      readFile: (f) => io.fs.promises.readFile(f, "utf8"),
      appendLine: (line) => io.fs.writeSync(fd, line),
      now: io.now,
      sleep: (ms) => sleeper.sleep(ms),
      file,
      everyMs: every.value * MS_PER_SECOND,
      durationMs: minutes.value * MS_PER_MINUTE,
      header: { label, axis: opts.axis, benchFleets: bench.value, demoMultiplier: demo.value,
        note: typeof opts.note === "string" ? opts.note : "" },
      shouldStop: () => stopped,
    });
  } finally {
    io.offSigint(onSigint);
    try {
      io.fs.closeSync(fd);
    } catch (_err) {
    }
  }
  io.out(`scalingBench: rows=${result.rows} readErrors=${result.readErrors} unchangedReads=${result.unchangedReads}`
    + `${stopped ? " (SIGINT)" : ""}`);
  if (result.writeError) {
    io.err(`scalingBench: write to ${out} failed - ${result.writeError}`);
    return EXIT.FAILED;
  }
  return EXIT.OK;
}

function parseStageFile(text, name) {
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
  if (!header || header.type !== "header" || header.tool !== TOOL || header.format !== FORMAT) {
    return { ok: false, error: `${name}: line 1 is not a ${TOOL} format ${FORMAT} header` };
  }
  const rows = [];
  let footer = null;
  for (let i = 1; i < objs.length; i += 1) {
    const o = objs[i];
    if (o && o.type === "row" && footer === null) rows.push(o);
    else if (o && o.type === "footer" && footer === null) footer = o;
    else return { ok: false, error: `${name}:${i + 1}: unexpected line type ${o && o.type}` };
  }
  if (rows.length === 0) return { ok: false, error: `${name}: no rows` };
  return { ok: true, header, rows, footer };
}

function readAudit(file, io) {
  let parsed;
  try {
    parsed = JSON.parse(io.fs.readFileSync(path.resolve(file), "utf8"));
  } catch (err) {
    return { ok: false, error: `cannot read --audit ${file} - ${messageOf(err)}` };
  }
  const summary = auditSummaryOf(parsed);
  if (!summary.ok) return { ok: false, error: `--audit ${file}: ${summary.reason}` };
  return { ok: true, audit: { file, duplicateSettlements: summary.duplicateSettlements, errors: summary.errors,
    liveFleets: summary.liveFleets === undefined ? null : summary.liveFleets,
    destroyedFleets: summary.destroyedFleets === undefined ? null : summary.destroyedFleets } };
}

async function runReport(opts, io) {
  if (opts.in.length === 0) return io.usage("report needs at least one --in");
  const ai = opts["ai-fleets"] === undefined ? { ok: true, value: null } : intArg(opts["ai-fleets"], 0, null);
  if (!ai.ok) return io.usage("--ai-fleets must be an integer >= 0");
  const thresholds = { ...DEFAULT_THRESHOLDS };
  const numeric = [["warmup-min", "warmupMs", MS_PER_MINUTE], ["warn-ms", "warnP95Ms", 1], ["fail-ms", "failP95Ms", 1],
    ["stop-ms", "stopMs", 1]];
  for (const [arg, key, scale] of numeric) {
    const v = numArg(opts[arg], 0, undefined);
    if (!v.ok) return io.usage(`--${arg} must be a number >= 0`);
    if (v.value !== undefined) thresholds[key] = v.value * scale;
  }
  if (thresholds.failP95Ms < thresholds.warnP95Ms) return io.usage("--fail-ms below --warn-ms");
  const auditFiles = new Map();
  for (const spec of opts.audit) {
    const at = spec.indexOf("=");
    const label = at > 0 ? spec.slice(0, at) : "";
    const file = at > 0 ? spec.slice(at + 1) : "";
    if (label === "" || file === "") return io.usage(`--audit ${spec}: expected <stage label>=<audit.json>`);
    if (auditFiles.has(label)) return io.usage(`--audit ${label} given twice`);
    auditFiles.set(label, file);
  }
  const parsedStages = [];
  for (const file of opts.in) {
    let text;
    try {
      text = io.fs.readFileSync(path.resolve(file), "utf8");
    } catch (err) {
      io.err(`scalingBench: cannot read ${file} - ${messageOf(err)}`);
      return EXIT.FAILED;
    }
    const parsed = parseStageFile(text, file);
    if (!parsed.ok) {
      io.err(`scalingBench: ${parsed.error}`);
      return EXIT.FAILED;
    }
    parsedStages.push(parsed);
  }
  const labels = new Set(parsedStages.map((p) => p.header.label));
  for (const label of auditFiles.keys()) {
    if (!labels.has(label)) return io.usage(`--audit ${label}: no --in stage with this label`);
  }
  const baselinePick = pickRssBaseline(parsedStages.map((p) => p.header), opts["rss-baseline"]);
  if (!baselinePick.ok) return io.usage(`--rss-baseline ${opts["rss-baseline"]}: no --in stage with this label`);
  const audits = [];
  for (const parsed of parsedStages) {
    const auditFile = auditFiles.get(parsed.header.label);
    let audit = null;
    if (auditFile !== undefined) {
      const read = readAudit(auditFile, io);
      if (!read.ok) {
        io.err(`scalingBench: ${read.error}`);
        return EXIT.FAILED;
      }
      audit = read.audit;
    }
    audits.push(audit);
  }
  let rssBaseline = null;
  const baselineNotes = [];
  if (baselinePick.label !== null) {
    const at = parsedStages.findIndex((p) => p.header.label === baselinePick.label);
    const p = parsedStages[at];
    const baseSummary = summarizeStage(p.header, p.rows, thresholds, p.footer, audits[at]);
    const slope = baseSummary.memory.rssPoints >= 2 ? baseSummary.memory.rssSlopeMbPerHour : null;
    if (slope === null) baselineNotes.push(`rss baseline ${baselinePick.label}: no slope - absolute assessment`);
    rssBaseline = { label: baselinePick.label, slopeMbPerHour: slope };
  }
  const stages = parsedStages.map((p, i) => summarizeStage(p.header, p.rows, thresholds, p.footer, audits[i],
    { rssBaseline }));
  const reportBaseline = { mode: rssBaseline !== null && rssBaseline.slopeMbPerHour !== null ? "baseline" : "absolute",
    label: rssBaseline === null ? null : rssBaseline.label,
    slopeMbPerHour: rssBaseline === null ? null : rssBaseline.slopeMbPerHour };
  const recommendation = recommend(stages, { aiFleets: ai.value, thresholds });
  recommendation.notes.push(...baselineNotes);
  const report = { thresholds, aiFleets: ai.value, rssBaseline: reportBaseline, stages, recommendation };
  const md = renderMarkdown(report);
  io.out(md.trimEnd());
  try {
    if (typeof opts.md === "string") io.fs.writeFileSync(path.resolve(opts.md), md, "utf8");
    if (typeof opts.json === "string") io.fs.writeFileSync(path.resolve(opts.json), renderJson(report), "utf8");
  } catch (err) {
    io.err(`scalingBench: cannot write the report - ${messageOf(err)}`);
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
    onSigint: given.onSigint || ((fn) => process.on("SIGINT", fn)),
    offSigint: given.offSigint || ((fn) => process.removeListener("SIGINT", fn)),
  };
  io.usage = (msg) => {
    io.err(`scalingBench: ${msg}`);
    io.err(USAGE);
    return EXIT.USAGE;
  };
  const parsed = parseArgs(argv);
  if (!parsed.ok) return io.usage(parsed.error);
  try {
    if (parsed.cmd === "sample") return await runSample(parsed.opts, io);
    if (parsed.cmd === "report") return await runReport(parsed.opts, io);
  } catch (err) {
    io.err(`scalingBench: failed - ${messageOf(err)}`);
    return EXIT.FAILED;
  }
  return io.usage(`unknown command ${parsed.cmd}`);
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}

module.exports = { sampleLoop, parseArgs, parseStageFile, main, AXES, EXIT };
