"use strict";

const fs = require("node:fs");
const os = require("node:os");

const { loadConfig } = require("../config");
const { readSchemaVersion, LATEST_SCHEMA_VERSION } = require("../lib/persistence/migrations");
const offline = require("./offlineDb");
const { runAudit, runIntegrity, referenceTime, SEVERITY } = require("./audit/checks");
const { collectGrowth, diffGrowth } = require("./audit/growth");

const { MOD_DIR, LOCKED_MESSAGE, messageOf, loadDriver, resolveDbFile, openLocked, closeQuietly, sideFilesOf,
  removeCreatedSideFiles, takeSnapshot } = offline;
const EXIT = Object.freeze({ ...offline.EXIT, FINDINGS: 4 });
const FORMAT_VERSION = 1;
const SNAPSHOT_ATTEMPTS = 2;
const SNAPSHOT_PREFIX = "lne-audit-";
const DEFAULT_STALE_HOURS = 2;
const DEFAULT_BACKLOG_LAG_MIN = 15;
const DEFAULT_SAMPLE = 5;
const HOUR_MS = 3.6e6;
const MINUTE_MS = 60000;
const INTEGRITY_MODES = Object.freeze(["full", "quick", "off"]);
const USAGE = "usage: node mods/livingNewEden/tools/auditWorldDb.js [--db <file>] [--snapshot] [--tmp-dir <dir>] "
  + "[--integrity full|quick|off] [--stale-hours <h>] [--backlog-lag-min <m>] [--now <ms>] [--json] "
  + "[--out <file.json>] [--baseline <file.json>] [--sample <n>]";
const FLAGS = Object.freeze(["--snapshot", "--json"]);
const VALUE_ARGS = Object.freeze(["--db", "--tmp-dir", "--integrity", "--stale-hours", "--backlog-lag-min", "--now",
  "--out", "--baseline", "--sample"]);

function parseArgs(argv) {
  const out = { db: null, snapshot: false, tmpDir: null, integrity: "full", staleHours: DEFAULT_STALE_HOURS,
    backlogLagMin: DEFAULT_BACKLOG_LAG_MIN, now: null, json: false, out: null, baseline: null, sample: DEFAULT_SAMPLE };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (FLAGS.includes(arg)) {
      if (arg === "--snapshot") out.snapshot = true;
      else out.json = true;
      continue;
    }
    if (!VALUE_ARGS.includes(arg)) return { ok: false, detail: `unknown argument ${arg}` };
    const value = argv[i + 1];
    if (typeof value !== "string" || value === "" || value.startsWith("--")) {
      return { ok: false, detail: `${arg} needs a value` };
    }
    i += 1;
    if (arg === "--db") out.db = value;
    else if (arg === "--tmp-dir") out.tmpDir = value;
    else if (arg === "--out") out.out = value;
    else if (arg === "--baseline") out.baseline = value;
    else if (arg === "--integrity") {
      if (!INTEGRITY_MODES.includes(value)) return { ok: false, detail: `--integrity needs ${INTEGRITY_MODES.join("|")}` };
      out.integrity = value;
    } else if (arg === "--stale-hours" || arg === "--backlog-lag-min") {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) return { ok: false, detail: `${arg} needs a number > 0` };
      if (arg === "--stale-hours") out.staleHours = n;
      else out.backlogLagMin = n;
    } else {
      const n = Number(value);
      if (!Number.isSafeInteger(n) || n < 0) return { ok: false, detail: `${arg} needs an integer >= 0` };
      if (arg === "--now") out.now = n;
      else out.sample = n;
    }
  }
  return { ok: true, ...out };
}

function readBaseline(file) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return { ok: false, detail: `--baseline unreadable: ${messageOf(err)}` };
  }
  if (!parsed || parsed.tool !== "auditWorldDb" || parsed.formatVersion !== FORMAT_VERSION) {
    return { ok: false, detail: `--baseline: expected an auditWorldDb result with formatVersion ${FORMAT_VERSION} `
      + `(got ${parsed && parsed.formatVersion})` };
  }
  if (!Number.isFinite(parsed.refNow) || !parsed.growth || typeof parsed.growth !== "object") {
    return { ok: false, detail: "--baseline: no refNow / growth" };
  }
  return { ok: true, report: parsed };
}

const iso = (ms) => (Number.isSafeInteger(ms) ? new Date(ms).toISOString() : "none");

function summaryOf(findings) {
  const count = (sev) => findings.filter((f) => f.severity === sev && f.count > 0).length;
  const errors = count(SEVERITY.ERROR);
  return { errors, warnings: count(SEVERITY.WARN), infos: count(SEVERITY.INFO), pass: errors === 0 };
}

function printText(print, r) {
  print(`refNow ${iso(r.refNow)} (${r.refNowSource}), boot ${iso(r.lastBootAt)}; schema ${r.schemaVersion}`
    + ` (tool knows ${r.latestSchemaVersion}); integrity ${r.integrity.mode}`);
  const tag = { ERROR: "ERROR", WARN: "WARN", INFO: "INFO" };
  for (const f of r.findings) {
    if (f.count <= 0) continue;
    print(`${tag[f.severity]} ${f.id}=${f.count}${f.sample.length > 0 ? ` [${f.sample.join(", ")}]` : ""}`
      + `${f.note ? ` (${f.note})` : ""}`);
    if (f.detail && f.id === "integrity") for (const m of f.detail.messages || []) print(`    ${m}`);
  }
  if (r.delta) {
    print(`delta since ${iso(r.delta.baselineRefNow)} (${Math.round(r.delta.hours * 100) / 100} h):`);
    for (const [k, v] of Object.entries(r.delta.rows)) {
      if (v.delta !== 0) print(`    ${k}: ${v.from} -> ${v.to} (${v.delta > 0 ? "+" : ""}${v.delta}, /h ${v.perHour})`);
    }
  }
  for (const n of r.notes) print(`  note: ${n}`);
  print(`result: ${r.summary.pass ? "PASS" : "FAIL"} errors=${r.summary.errors} warnings=${r.summary.warnings}`);
}

function emit(print, args, report) {
  if (args.out) {
    try {
      fs.writeFileSync(args.out, `${JSON.stringify(report, null, 2)}\n`);
    } catch (err) {
      print(`auditWorldDb: writing --out failed: ${messageOf(err)}`);
      return false;
    }
  }
  if (args.json) print(JSON.stringify(report, null, 2));
  else printText(print, report);
  return true;
}

function safeIntegrity(db, mode) {
  try {
    return runIntegrity(db, mode);
  } catch (err) {
    return { ok: false, failed: true, messages: [messageOf(err)] };
  }
}

function openTarget(driver, file, args, tmpRoot) {
  if (!args.snapshot) {
    const sideBefore = sideFilesOf(file);
    const opened = openLocked(driver, file, { readonly: true });
    if (opened.ok) return { ok: true, db: opened.db, snap: null, sideBefore, attempts: 0, integrityResult: null, notes: [] };
    if (opened.reason === "LOCKED") {
      return { ok: false, code: EXIT.REFUSED,
        message: `${LOCKED_MESSAGE} Or run with --snapshot (a copy of the database, works while the server runs).` };
    }
    return { ok: false, code: EXIT.FAILED, message: `auditWorldDb: cannot open the database: ${opened.detail}` };
  }
  const notes = [];
  let lastDetail = "";
  for (let attempt = 1; attempt <= SNAPSHOT_ATTEMPTS; attempt += 1) {
    let snap;
    try {
      fs.mkdirSync(tmpRoot, { recursive: true });
      snap = takeSnapshot(file, tmpRoot, SNAPSHOT_PREFIX);
    } catch (err) {
      return { ok: false, code: EXIT.FAILED, message: `auditWorldDb: copy failed: ${messageOf(err)}` };
    }
    const opened = openLocked(driver, snap.file, { readonly: true });
    if (!opened.ok) {
      lastDetail = opened.detail;
      fs.rmSync(snap.dir, { recursive: true, force: true });
      if (attempt < SNAPSHOT_ATTEMPTS) notes.push(`copy ${attempt} torn (open: ${opened.detail}) - new copy`);
      continue;
    }
    const integrityResult = args.integrity === "off" ? null : safeIntegrity(opened.db, args.integrity);
    if (integrityResult && integrityResult.failed) {
      closeQuietly(opened.db);
      fs.rmSync(snap.dir, { recursive: true, force: true });
      return { ok: false, code: EXIT.FAILED,
        message: `auditWorldDb: FAILED integrity: ${integrityResult.messages[0] || "?"}` };
    }
    const torn = Boolean(integrityResult && integrityResult.ok === false && integrityResult.pragmaCount > 0);
    if (torn && attempt < SNAPSHOT_ATTEMPTS) {
      lastDetail = integrityResult.messages[0] || "";
      closeQuietly(opened.db);
      fs.rmSync(snap.dir, { recursive: true, force: true });
      notes.push(`copy ${attempt} torn (integrity: ${lastDetail}) - new copy`);
      continue;
    }
    if (attempt > 1) notes.push(torn ? "both copies inconsistent - repeat with the server stopped" : "first copy torn");
    return { ok: true, db: opened.db, snap, sideBefore: null, attempts: attempt, integrityResult, notes };
  }
  return { ok: false, code: EXIT.FINDINGS, torn: { attempts: SNAPSHOT_ATTEMPTS, detail: lastDetail },
    message: "auditWorldDb: the copy does not open after 2 attempts" };
}

function closeTarget(print, t, file) {
  if (t.snap) {
    closeQuietly(t.db);
    try {
      fs.rmSync(t.snap.dir, { recursive: true, force: true });
    } catch (err) {
      print(`  warning: copy left behind ${t.snap.dir} (${messageOf(err)})`);
    }
    return;
  }
  const first = removeCreatedSideFiles(file, t.sideBefore);
  closeQuietly(t.db);
  const after = first.failed.length > 0 ? removeCreatedSideFiles(file, t.sideBefore, { only: first.failed })
    : { kept: [] };
  const kept = [...first.kept.filter((k) => !first.failed.includes(k.file)), ...after.kept];
  for (const k of kept) print(`  warning: file left behind ${k.file} (${k.detail})`);
}

function baseReport(file, args, thresholds) {
  return { tool: "auditWorldDb", formatVersion: FORMAT_VERSION, file, snapshot: { used: args.snapshot, attempts: 0 },
    schemaVersion: null, latestSchemaVersion: LATEST_SCHEMA_VERSION, refNow: null, refNowSource: null,
    lastBootAt: null, thresholds, integrity: { mode: args.integrity, ok: null }, findings: [], growth: {}, notes: [],
    summary: null };
}

function audit(db, t, ctx) {
  const { args, file, config, clock, thresholds, baseline } = ctx;
  let version;
  try {
    version = readSchemaVersion(db);
  } catch (err) {
    return { code: EXIT.FAILED, message: `auditWorldDb: FAILED reading the schema: ${messageOf(err)}` };
  }
  if (!version.ok || version.version === 0) {
    return { code: EXIT.REFUSED,
      message: `REFUSED: this is not a Living New Eden database (${version.reason || "EMPTY"}: ${version.detail || "-"})` };
  }
  if (version.version > LATEST_SCHEMA_VERSION) {
    return { code: EXIT.REFUSED, message: `REFUSED: database schema ${version.version} newer than the tool `
      + `(${LATEST_SCHEMA_VERSION}) - use the tool from the image that wrote this database` };
  }
  const ref = referenceTime(db, args.now, clock);
  if (!ref.ok) return { code: EXIT.FAILED, message: `auditWorldDb: FAILED reference time: ${ref.detail}` };
  const audited = runAudit(db, { config, refNow: ref.refNow, lastBootAt: ref.lastBootAt, staleMs: thresholds.staleMs,
    backlogLagMs: thresholds.backlogLagMs, sample: args.sample, integrity: args.integrity,
    integrityResult: t.integrityResult || undefined });
  if (!audited.ok) return { code: EXIT.FAILED, message: `auditWorldDb: FAILED check ${audited.check}: ${audited.detail}` };
  let bytes = null;
  try {
    bytes = fs.statSync(file).size;
  } catch (_err) {
    bytes = null;
  }
  const grown = collectGrowth(db, { bytes });
  if (!grown.ok) return { code: EXIT.FAILED, message: `auditWorldDb: FAILED growth counters: ${grown.detail}` };
  const report = baseReport(file, args, thresholds);
  report.snapshot.attempts = t.attempts;
  report.schemaVersion = version.version;
  report.refNow = ref.refNow;
  report.refNowSource = ref.source;
  report.lastBootAt = ref.lastBootAt;
  report.integrity.ok = audited.integrity.ok;
  report.findings = audited.findings;
  report.growth = grown.growth;
  report.notes = [...t.notes, ...audited.notes];
  if (baseline) {
    report.delta = diffGrowth(baseline, report);
    report.notes.push(...report.delta.notes);
  }
  report.summary = summaryOf(report.findings);
  return { code: report.summary.pass ? EXIT.OK : EXIT.FINDINGS, report };
}

function main(opts = {}) {
  const print = typeof opts.print === "function" ? opts.print : (line) => process.stdout.write(`${line}\n`);
  const env = opts.env || process.env;
  const args = parseArgs(opts.argv || []);
  if (!args.ok) {
    print(`auditWorldDb: ${args.detail}`);
    print(USAGE);
    return EXIT.USAGE;
  }
  let baseline = null;
  if (args.baseline) {
    const b = readBaseline(args.baseline);
    if (!b.ok) {
      print(`auditWorldDb: ${b.detail}`);
      return EXIT.USAGE;
    }
    baseline = b.report;
  }
  const { file, warnings } = resolveDbFile(args.db, env);
  const say = args.json ? () => {} : print;
  say(`auditWorldDb (read-only${args.snapshot ? ", copy" : ""}): database ${file}`);
  for (const w of warnings) say(`  warning (config): ${w}`);
  if (!fs.existsSync(file)) {
    print("No database file.");
    return EXIT.OK;
  }
  const config = opts.config || (loadConfig({ modDir: MOD_DIR, env }).config || {});
  const clock = typeof opts.now === "function" ? opts.now : Date.now;
  const thresholds = { staleMs: Math.round(args.staleHours * HOUR_MS),
    backlogLagMs: Math.round(args.backlogLagMin * MINUTE_MS) };
  const driver = opts.driver || loadDriver();
  if (!driver || driver.ok === false || typeof driver.Database !== "function") {
    print(`auditWorldDb: no better-sqlite3 driver (${(driver && (driver.detail || driver.reason)) || "?"})`);
    return EXIT.FAILED;
  }
  const tmpRoot = args.tmpDir || opts.tmpDir || os.tmpdir();
  const t = openTarget(driver, file, args, tmpRoot);
  if (!t.ok) {
    if (!t.torn) {
      print(t.message);
      return t.code;
    }
    const report = baseReport(file, args, thresholds);
    report.snapshot.attempts = t.torn.attempts;
    report.integrity.ok = false;
    report.findings = [{ id: "integrity", severity: SEVERITY.ERROR, count: 1, sample: [],
      detail: { mode: args.integrity, messages: [t.torn.detail] }, note: "repeat with the server stopped" }];
    report.notes = [t.message];
    report.summary = summaryOf(report.findings);
    return emit(print, args, report) ? EXIT.FINDINGS : EXIT.FAILED;
  }
  let result;
  try {
    result = audit(t.db, t, { args, file, config, clock, thresholds, baseline });
  } catch (err) {
    result = { code: EXIT.FAILED, message: `auditWorldDb: FAILED: ${messageOf(err)}` };
  } finally {
    closeTarget(say, t, file);
  }
  if (!result.report) {
    print(result.message);
    return result.code;
  }
  return emit(print, args, result.report) ? result.code : EXIT.FAILED;
}

module.exports = { main, parseArgs, EXIT, FORMAT_VERSION, SNAPSHOT_ATTEMPTS };

if (require.main === module) process.exitCode = main({ argv: process.argv.slice(2) });
