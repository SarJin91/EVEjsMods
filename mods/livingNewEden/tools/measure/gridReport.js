#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DB_FILE = "world.sqlite";
const SEGMENT_REPORT_RE = /^seg(\d+)\.report\.json$/;
const LOG_ERROR_RE = / error|TX_FAILED/;
const LOG_ROW_LIMIT_RE = /TX_ROW_LIMIT/;
const NO_KEY = "none";

const COUNTER_PREFIXES = Object.freeze({
  fleets: Object.freeze({ prefixes: Object.freeze(["grid."]), contains: Object.freeze([]) }),
  battle: Object.freeze({ prefixes: Object.freeze(["contacts."]), contains: Object.freeze([]) }),
  lowsec: Object.freeze({ prefixes: Object.freeze(["gate", "campGate", "strikesOffGate"]), contains: Object.freeze([]) }),
  blockade: Object.freeze({ prefixes: Object.freeze(["gate", "position"]), contains: Object.freeze([]) }),
  sentries: Object.freeze({ prefixes: Object.freeze([]), contains: Object.freeze(["rid"]) }),
  materialization: Object.freeze({ prefixes: Object.freeze(["gridAnchor"]), contains: Object.freeze([]) }),
});

const HISTOGRAMS = Object.freeze([
  Object.freeze(["fleets.grid.anchorReadMs", "fleets", "grid.anchorReadMs"]),
  Object.freeze(["fleets.grid.moveMs", "fleets", "grid.moveMs"]),
  Object.freeze(["fleets.grid.defense.decideMs", "fleets", "grid.defense.decideMs"]),
  Object.freeze(["fleets.grid.defense.crossingListenerMs", "fleets", "grid.defense.crossingListenerMs"]),
]);

const THRESHOLDS = Object.freeze({
  noiseFactor: 2,
  minBand: 2,
  g1: Object.freeze({
    minCheckRuns: 3,
    logErrorsSlack: 2,
    zeroCounters: Object.freeze(["fleets.grid.recordErrors", "fleets.grid.gridListenerErrors",
      "fleets.grid.workOverrideErrors", "fleets.grid.defense.crossingPlaceFailed"]),
  }),
  g2: Object.freeze({ capturesHighRel: 0.25, battlesLowRel: 0.40, battlesHighRel: 0.50 }),
  g3: Object.freeze({
    minGridShare: 0.30,
    positiveCounters: Object.freeze(["fleets.grid.visitsWritten", "fleets.grid.movesPlanned",
      "fleets.grid.defense.alerts", "fleets.grid.defense.pursuits", "battle.contacts.gridQueued"]),
    crossingChecks: "fleets.grid.defense.crossingChecks",
    crossingsCaught: "fleets.grid.defense.crossingsCaught",
  }),
  g4: Object.freeze({ rel: 0.25, unsupportedName: "readGridAnchors", unavailableCounter: "fleets.grid.anchorsUnavailable" }),
  g5: Object.freeze({ passFactor: 1.25, passSlackMs: 2, latenessFactor: 1.25, latenessSlackMs: 2000,
    histogramMaxMs: 5, costHistograms: Object.freeze(["fleets.grid.anchorReadMs", "fleets.grid.defense.decideMs",
      "fleets.grid.defense.crossingListenerMs"]) }),
  calibration: Object.freeze({
    1: Object.freeze({ "grid.defense.locateMs": 45000, "grid.defense.maxPursuersPerIntruder": 4 }),
    2: Object.freeze({ "grid.contactRangeM": 500000, "grid.defense.maxPursuitsPerSystem": 4 }),
    3: Object.freeze({ "grid.defense.maxPursuitsPerSystem": 1 }),
    "1+2": Object.freeze({ "grid.defense.locateMs": 45000, "grid.contactRangeM": 500000 }),
  }),
});

const USAGE = "usage: node mods/livingNewEden/tools/measure/gridReport.js --variant <name>=<dir> [--variant ...] "
  + "--base <name> --noise <name> --on <name> [--nostat <name>] [--ctl <name>] [--json <file>]";

function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function bumpMap(map, key, n = 1) {
  const k = String(key);
  map[k] = (map[k] || 0) + n;
}

function median(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function maxOf(values) {
  const nums = values.filter(isNum);
  return nums.length === 0 ? null : Math.max(...nums);
}

function channelsOf(telemetry) {
  if (!telemetry || typeof telemetry !== "object") return null;
  if (telemetry.channels && typeof telemetry.channels === "object") return telemetry.channels;
  return telemetry;
}

function selected(channel, name) {
  const rule = COUNTER_PREFIXES[channel];
  if (!rule) return false;
  return rule.prefixes.some((p) => name.startsWith(p)) || rule.contains.some((c) => name.includes(c));
}

function countersOf(telemetry) {
  const ch = channelsOf(telemetry);
  const out = {};
  if (!ch) return out;
  for (const channel of Object.keys(COUNTER_PREFIXES)) {
    const names = ch[channel] && typeof ch[channel] === "object" ? ch[channel] : {};
    for (const [name, v] of Object.entries(names)) if (isNum(v) && selected(channel, name)) out[`${channel}.${name}`] = v;
  }
  return out;
}

function histogramsOf(telemetry) {
  const ch = channelsOf(telemetry);
  const out = {};
  for (const [key, channel, name] of HISTOGRAMS) {
    const h = ch && ch[channel] ? ch[channel][name] : undefined;
    out[key] = h && typeof h === "object" && isNum(h.p95) ? h.p95 : null;
  }
  return out;
}

function schedulerValues(records, field) {
  return (Array.isArray(records) ? records : [])
    .map((r) => (r && r.scheduler && typeof r.scheduler === "object" ? r.scheduler[field] : undefined))
    .filter(isNum);
}

function segmentExitOk(s) {
  if (!s.report || typeof s.report !== "object" || Object.prototype.hasOwnProperty.call(s.report, "error")) return false;
  return s.exitCode === undefined || s.exitCode === null || s.exitCode === 0;
}

function summarize(input) {
  if (!input || typeof input !== "object" || !Array.isArray(input.days) || input.days.length === 0) {
    return { ok: false, reason: "INVALID_INPUT", detail: "days" };
  }
  const segs = [...input.days].sort((a, b) => a.index - b.index);
  for (const d of segs) {
    if (!d || !Number.isSafeInteger(d.index) || !isNum(d.startVirtualAt) || !isNum(d.stopVirtualAt)
      || d.stopVirtualAt < d.startVirtualAt) {
      return { ok: false, reason: "INVALID_INPUT", detail: `day ${d && d.index}` };
    }
  }
  const from = segs[0].startVirtualAt;
  const to = segs[segs.length - 1].stopVirtualAt;
  const contiguous = segs.every((d, i) => d.index === i + 1);
  const perDay = segs.map((d) => ({ index: d.index, startVirtualAt: d.startVirtualAt, stopVirtualAt: d.stopVirtualAt,
    exitOk: segmentExitOk(d), battles: 0, battlesWithGrid: 0, shipsLost: 0, captures: 0,
    logErrors: isNum(d.logErrors) ? d.logErrors : 0, logRowLimit: isNum(d.logRowLimit) ? d.logRowLimit : 0,
    checks: d.report && d.report.checks ? { runs: d.report.checks.runs || 0, pass: d.report.checks.pass || 0,
      fail: d.report.checks.fail || 0, error: d.report.checks.error || 0 } : { runs: 0, pass: 0, fail: 0, error: 0 },
    passP95MsMedian: median(schedulerValues(d.status, "passP95Ms")),
    latenessP95MsMedian: median(schedulerValues(d.status, "latenessP95Ms")) }));
  const dayOf = (t) => {
    if (!isNum(t)) return null;
    for (let i = 0; i < segs.length; i += 1) if (segs[i].startVirtualAt <= t && t < segs[i].stopVirtualAt) return perDay[i];
    return null;
  };
  const out = { ok: true, windowMs: to - from, segments: segs.length,
    exitOk: contiguous && perDay.every((d) => d.exitOk),
    checks: { runs: 0, pass: 0, fail: 0, error: 0 }, battles: 0, battlesWithGrid: 0, battlesByGridKind: {},
    battlesByObjective: {}, shipsLost: 0, captures: 0, counters: {}, histogramsP95Max: {}, passP95MsMedian: null,
    latenessP95MsMedian: null, visitRows: isNum(input.visitRows) ? input.visitRows : 0,
    liveFleets: isNum(input.liveFleets) ? input.liveFleets : 0, logErrors: 0, logRowLimit: 0, unsupported: {},
    telemetryMissing: segs.filter((d) => channelsOf(d.telemetry) === null).map((d) => `seg${d.index}`), perDay };
  for (const b of input.battles || []) {
    if (!b || !isNum(b.createdAt) || b.createdAt < from || b.createdAt >= to) continue;
    const lost = isNum(b.shipsLost) ? b.shipsLost : 0;
    const withGrid = typeof b.gridKind === "string" && b.gridKind !== "";
    out.battles += 1;
    out.shipsLost += lost;
    if (withGrid) out.battlesWithGrid += 1;
    bumpMap(out.battlesByGridKind, withGrid ? b.gridKind : NO_KEY);
    bumpMap(out.battlesByObjective, b.objective || NO_KEY);
    const day = dayOf(b.createdAt);
    if (day) {
      day.battles += 1;
      day.shipsLost += lost;
      if (withGrid) day.battlesWithGrid += 1;
    }
  }
  for (const c of input.captures || []) {
    if (!c || !isNum(c.capturedAt) || c.capturedAt < from || c.capturedAt >= to) continue;
    out.captures += 1;
    const day = dayOf(c.capturedAt);
    if (day) day.captures += 1;
  }
  const passAll = [];
  const lateAll = [];
  for (const [i, d] of segs.entries()) {
    const day = perDay[i];
    for (const k of ["runs", "pass", "fail", "error"]) out.checks[k] += day.checks[k];
    out.logErrors += day.logErrors;
    out.logRowLimit += day.logRowLimit;
    for (const [k, v] of Object.entries(countersOf(d.telemetry))) bumpMap(out.counters, k, v);
    const unsupported = d.report && d.report.unsupported && typeof d.report.unsupported === "object"
      ? d.report.unsupported : {};
    for (const [k, v] of Object.entries(unsupported)) if (isNum(v)) bumpMap(out.unsupported, k, v);
    const h = histogramsOf(d.telemetry);
    for (const [key] of HISTOGRAMS) out.histogramsP95Max[key] = maxOf([out.histogramsP95Max[key], h[key]]);
    passAll.push(...schedulerValues(d.status, "passP95Ms"));
    lateAll.push(...schedulerValues(d.status, "latenessP95Ms"));
  }
  out.passP95MsMedian = median(passAll);
  out.latenessP95MsMedian = median(lateAll);
  return out;
}

const counterOf = (s, name) => (isNum(s.counters[name]) ? s.counters[name] : 0);

function gate(blocking) {
  return { pass: true, blocking, detail: [] };
}

function fail(g, line) {
  g.pass = false;
  g.detail.push(`FAIL ${line}`);
}

function note(g, line) {
  g.detail.push(line);
}

const telemetryMissingOf = (s) => (Array.isArray(s.telemetryMissing) ? s.telemetryMissing : ["(no telemetryMissing)"]);

function telemetryGate(g, label, s) {
  const missing = telemetryMissingOf(s);
  if (missing.length > 0) fail(g, `${label} telemetryMissing: [${missing.join(", ")}]`);
}

function verdict(summaries, roles, thresholds = THRESHOLDS) {
  const T = thresholds;
  const pick = (role) => (roles && typeof roles[role] === "string" && summaries && summaries[roles[role]]
    && summaries[roles[role]].ok === true ? summaries[roles[role]] : null);
  const base = pick("base");
  const noise = pick("noise");
  const on = pick("on");
  if (!base || !noise || !on) {
    return { ok: false, reason: "INVALID_INPUT", detail: `roles base/noise/on: ${JSON.stringify(roles)}` };
  }
  const nostat = pick("nostat");
  const valueOf = (s, m) => s[m];
  const band = (m, rel) => Math.max(rel * valueOf(base, m), T.noiseFactor * Math.abs(valueOf(base, m)
    - valueOf(noise, m)), T.minBand);
  const fmt = (v) => (isNum(v) ? String(Number(v.toFixed(3))) : "-");

  const g1 = gate(true);
  telemetryGate(g1, "on", on);
  if (!on.exitOk) fail(g1, "exitOk false (a segment without report, with report.error or exit != 0)");
  if (on.checks.fail !== 0 || on.checks.error !== 0) fail(g1, `checks fail=${on.checks.fail} error=${on.checks.error}`);
  if (on.checks.runs < T.g1.minCheckRuns) fail(g1, `checks.runs=${on.checks.runs} < ${T.g1.minCheckRuns}`);
  for (const name of T.g1.zeroCounters) if (counterOf(on, name) !== 0) fail(g1, `${name}=${counterOf(on, name)} != 0`);
  if (on.logErrors > base.logErrors + T.g1.logErrorsSlack) {
    fail(g1, `logErrors on=${on.logErrors} > base=${base.logErrors} + ${T.g1.logErrorsSlack}`);
  }
  if (on.logRowLimit > base.logRowLimit) fail(g1, `logRowLimit on=${on.logRowLimit} > base=${base.logRowLimit}`);
  note(g1, `checks runs/pass/fail/error ${on.checks.runs}/${on.checks.pass}/${on.checks.fail}/${on.checks.error}; `
    + `logErrors ${on.logErrors} (base ${base.logErrors}); logRowLimit ${on.logRowLimit} (base ${base.logRowLimit})`);

  const g2 = gate(true);
  let capturesHigh = false;
  let battlesLow = false;
  let battlesHigh = false;
  const capHi = base.captures + band("captures", T.g2.capturesHighRel);
  if (on.captures > capHi) {
    capturesHigh = true;
    fail(g2, `captures on=${on.captures} > base=${base.captures} + band=${fmt(capHi)}`);
  } else note(g2, `captures on=${on.captures} <= ${fmt(capHi)} (base ${base.captures}, noise ${noise.captures})`);
  for (const m of ["battles", "shipsLost"]) {
    const lo = base[m] - band(m, T.g2.battlesLowRel);
    const hi = base[m] + band(m, T.g2.battlesHighRel);
    const line = `${m} on=${on[m]} in [${fmt(lo)}, ${fmt(hi)}] (base ${base[m]}, noise ${noise[m]})`;
    if (on[m] < lo) {
      battlesLow = true;
      fail(g2, `${line} - below`);
    } else if (on[m] > hi) {
      battlesHigh = true;
      fail(g2, `${line} - above`);
    } else note(g2, line);
  }

  const g3 = gate(true);
  telemetryGate(g3, "on", on);
  const share = on.battles > 0 ? on.battlesWithGrid / on.battles : 0;
  if (share < T.g3.minGridShare) {
    fail(g3, `battlesWithGrid/battles=${on.battlesWithGrid}/${on.battles} < ${T.g3.minGridShare}`);
  } else note(g3, `battlesWithGrid/battles=${on.battlesWithGrid}/${on.battles}`);
  for (const name of T.g3.positiveCounters) {
    if (counterOf(on, name) > 0) note(g3, `${name}=${counterOf(on, name)}`);
    else fail(g3, `${name}=0`);
  }
  const checks = counterOf(on, T.g3.crossingChecks);
  const caught = counterOf(on, T.g3.crossingsCaught);
  if (checks <= 0) fail(g3, `${T.g3.crossingChecks}=0`);
  else if (caught < 1) fail(g3, `${T.g3.crossingChecks}=${checks} with ${T.g3.crossingsCaught}=0`);
  else note(g3, `${T.g3.crossingChecks}=${checks}, ${T.g3.crossingsCaught}=${caught}`);

  const g4 = gate(false);
  if (!nostat) fail(g4, "no nostat variant");
  else {
    telemetryGate(g4, "nostat", nostat);
    for (const m of ["battles", "captures"]) {
      const b = band(m, T.g4.rel);
      const line = `${m} nostat=${nostat[m]} in base ${base[m]} +- ${fmt(b)}`;
      if (Math.abs(nostat[m] - base[m]) > b) fail(g4, line);
      else note(g4, line);
    }
    const unsupported = isNum(nostat.unsupported[T.g4.unsupportedName]) ? nostat.unsupported[T.g4.unsupportedName] : 0;
    const unavailable = counterOf(nostat, T.g4.unavailableCounter);
    const line = `unsupported.${T.g4.unsupportedName}=${unsupported}, ${T.g4.unavailableCounter}=${unavailable}`;
    if (unsupported > 0 || unavailable > 0) note(g4, line);
    else fail(g4, line);
  }

  const g5 = gate(true);
  telemetryGate(g5, "on", on);
  const costLine = (field, factor, slack) => {
    const limit = isNum(base[field]) ? factor * base[field] + slack : null;
    const line = `${field} on=${fmt(on[field])} <= ${fmt(limit)} (base ${fmt(base[field])})`;
    if (limit === null || !isNum(on[field])) fail(g5, `${line} - no data`);
    else if (on[field] > limit) fail(g5, line);
    else note(g5, line);
  };
  costLine("passP95MsMedian", T.g5.passFactor, T.g5.passSlackMs);
  costLine("latenessP95MsMedian", T.g5.latenessFactor, T.g5.latenessSlackMs);
  for (const [key] of HISTOGRAMS) {
    const v = on.histogramsP95Max[key];
    if (!T.g5.costHistograms.includes(key)) note(g5, `${key} p95 max=${fmt(v)} (virtual duration, no cost limit)`);
    else if (isNum(v) && v > T.g5.histogramMaxMs) fail(g5, `${key} p95 max=${fmt(v)} > ${T.g5.histogramMaxMs} ms`);
    else note(g5, `${key} p95 max=${fmt(v)}`);
  }
  if (on.visitRows > on.liveFleets) fail(g5, `visitRows=${on.visitRows} > liveFleets=${on.liveFleets}`);
  else note(g5, `visitRows=${on.visitRows} <= liveFleets=${on.liveFleets}`);

  const gates = { G1: g1, G2: g2, G3: g3, G4: g4, G5: g5 };
  const go = g1.pass && g2.pass && g3.pass && g5.pass;
  let calibration = null;
  const isCtl = typeof roles.ctl === "string" && roles.ctl === roles.on;
  if (!g2.pass && g1.pass && g3.pass && g5.pass && !isCtl) {
    const low = battlesLow;
    let rule = null;
    if (capturesHigh && low) rule = "1+2";
    else if (capturesHigh) rule = "1";
    else if (low) rule = "2";
    else if (battlesHigh) rule = "3";
    if (rule !== null) calibration = { rule, set: { ...T.calibration[rule] } };
  }
  return { verdict: go ? "GO" : "NO_GO", gates, calibration };
}

class UsageError extends Error {}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      out.push(JSON.parse(line));
    } catch (_err) {
    }
  }
  return out;
}

function logCounts(file) {
  if (!fs.existsSync(file)) return { logErrors: 0, logRowLimit: 0 };
  let logErrors = 0;
  let logRowLimit = 0;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (LOG_ERROR_RE.test(line)) logErrors += 1;
    if (LOG_ROW_LIMIT_RE.test(line)) logRowLimit += 1;
  }
  return { logErrors, logRowLimit };
}

function exitCodeOf(file) {
  if (!fs.existsSync(file)) return null;
  const n = Number(fs.readFileSync(file, "utf8").trim());
  return Number.isSafeInteger(n) ? n : -1;
}

function segmentsOf(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new UsageError(`not a directory: ${dir}`);
  const db = path.join(dir, DB_FILE);
  if (!fs.existsSync(db)) throw new UsageError(`missing ${DB_FILE} in ${dir}`);
  const segs = fs.readdirSync(dir).map((f) => SEGMENT_REPORT_RE.exec(f)).filter(Boolean)
    .map((m) => Number(m[1])).sort((a, b) => a - b);
  if (segs.length === 0) throw new UsageError(`missing seg<n>.report.json in ${dir}`);
  return { db, segs };
}

function hasTable(db, name) {
  return Boolean(db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function readVariant(resultsDir, opts = {}) {
  const { db: dbFile, segs } = segmentsOf(resultsDir);
  const days = segs.map((n) => {
    const report = readJson(path.join(resultsDir, `seg${n}.report.json`));
    const telFile = path.join(resultsDir, `seg${n}.telemetry.json`);
    return { index: n, startVirtualAt: report.startVirtualAt, stopVirtualAt: report.stopVirtualAt, report,
      telemetry: fs.existsSync(telFile) ? readJson(telFile) : null,
      status: readJsonl(path.join(resultsDir, `seg${n}.status.jsonl`)),
      ...logCounts(path.join(resultsDir, `seg${n}.log`)),
      exitCode: exitCodeOf(path.join(resultsDir, `seg${n}.exit`)) };
  });
  const sorted = [...days].sort((a, b) => a.index - b.index);
  const from = sorted[0].startVirtualAt;
  const to = sorted[sorted.length - 1].stopVirtualAt;
  const Database = opts.Database || require("better-sqlite3");
  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    const battles = db.prepare(`SELECT b.created_at AS createdAt, b.grid_kind AS gridKind, b.objective AS objective,
        b.mode AS mode,
        (SELECT coalesce(sum(l.count), 0) FROM battle_losses l WHERE l.battle_id = b.battle_id) AS shipsLost
      FROM battle_records b WHERE b.created_at >= ? AND b.created_at < ?`).all(from, to)
      .map((r) => ({ createdAt: Number(r.createdAt), gridKind: r.gridKind === undefined ? null : r.gridKind,
        objective: r.objective === undefined ? null : r.objective, mode: r.mode, shipsLost: Number(r.shipsLost) }));
    const captures = db.prepare(`SELECT captured_at AS capturedAt FROM world_system_state
      WHERE captured_at IS NOT NULL AND captured_at >= ? AND captured_at < ?`).all(from, to)
      .map((r) => ({ capturedAt: Number(r.capturedAt) }));
    const visitRows = hasTable(db, "world_fleet_grid_visits")
      ? Number(db.prepare("SELECT count(*) AS n FROM world_fleet_grid_visits").get().n) : 0;
    const liveFleets = Number(db.prepare("SELECT count(*) AS n FROM virtual_fleets WHERE state <> 'DESTROYED'").get().n);
    return summarize({ days, battles, captures, visitRows, liveFleets });
  } finally {
    db.close();
  }
}

const ROLE_FLAGS = Object.freeze({ "--base": "base", "--noise": "noise", "--on": "on", "--nostat": "nostat",
  "--ctl": "ctl" });

function parseArgs(argv) {
  const out = { variants: [], roles: {}, json: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--variant") {
      const m = typeof v === "string" ? /^([A-Za-z0-9_-]+)=(.+)$/.exec(v) : null;
      if (!m) throw new UsageError("--variant needs <name>=<dir>");
      if (out.variants.some((x) => x.name === m[1])) throw new UsageError(`--variant ${m[1]} twice`);
      out.variants.push({ name: m[1], dir: path.resolve(m[2]) });
    } else if (ROLE_FLAGS[a]) {
      if (typeof v !== "string" || v === "") throw new UsageError(`${a} needs a variant name`);
      out.roles[ROLE_FLAGS[a]] = v;
    } else if (a === "--json") {
      if (typeof v !== "string" || v === "") throw new UsageError("--json needs a file");
      out.json = path.resolve(v);
    } else throw new UsageError(`unknown argument ${a}`);
    i += 1;
  }
  if (out.variants.length === 0) throw new UsageError("at least one --variant");
  for (const role of ["base", "noise", "on"]) if (!out.roles[role]) throw new UsageError(`--${role} is required`);
  for (const [role, name] of Object.entries(out.roles)) {
    if (!out.variants.some((x) => x.name === name)) throw new UsageError(`--${role} ${name} is not a --variant`);
  }
  return out;
}

const fmtCell = (v) => (v === null || v === undefined ? "-" : String(v));

const TABLE_HEAD = ["variant", "exitOk", "checks r/p/f/e", "battles", "withGrid", "shipsLost", "captures",
  "logErr/rowLimit", "passP95 med", "lateP95 med", "visits/fleets", "alerts", "pursuits", "crossChecks/caught",
  "gridQueued", "anchorRead p95", "telemetryMissing"];

function rowOf(name, s) {
  const c = (k) => counterOf(s, k);
  return [name, s.exitOk, `${s.checks.runs}/${s.checks.pass}/${s.checks.fail}/${s.checks.error}`, s.battles,
    s.battlesWithGrid, s.shipsLost, s.captures, `${s.logErrors}/${s.logRowLimit}`, fmtCell(s.passP95MsMedian),
    fmtCell(s.latenessP95MsMedian), `${s.visitRows}/${s.liveFleets}`, c("fleets.grid.defense.alerts"),
    c("fleets.grid.defense.pursuits"), `${c("fleets.grid.defense.crossingChecks")}/${c("fleets.grid.defense.crossingsCaught")}`,
    c("battle.contacts.gridQueued"), fmtCell(s.histogramsP95Max["fleets.grid.anchorReadMs"]),
    telemetryMissingOf(s).join(",") || "-"];
}

function gateTable(title, v) {
  const lines = [`${title}: ${v.verdict}${v.calibration ? ` (calibration rule ${v.calibration.rule}: `
    + `${JSON.stringify(v.calibration.set)})` : ""}`, "", "| gate | pass | blocking | detail |", "|---|---|---|---|"];
  for (const [g, r] of Object.entries(v.gates)) {
    lines.push(`| ${g} | ${r.pass ? "PASS" : "FAIL"} | ${r.blocking ? "yes" : "no"} | ${r.detail.join("; ")} |`);
  }
  return lines;
}

function markdown(r) {
  const lines = [`| ${TABLE_HEAD.join(" | ")} |`, `|${TABLE_HEAD.map(() => "---").join("|")}|`];
  for (const x of r.results) lines.push(`| ${rowOf(x.name, x.summary).join(" | ")} |`);
  for (const v of r.verdicts) lines.push("", ...gateTable(v.title, v.value));
  return lines.join("\n");
}

function main(argv, io = {}) {
  const out = io.out || ((s) => process.stdout.write(`${s}\n`));
  const err = io.err || ((s) => process.stderr.write(`${s}\n`));
  let args;
  try {
    args = parseArgs(argv);
    for (const v of args.variants) segmentsOf(v.dir);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    err(`gridReport: ${e.message} (${USAGE})`);
    return 1;
  }
  const summaries = {};
  const results = [];
  for (const v of args.variants) {
    let summary;
    try {
      summary = readVariant(v.dir, { Database: io.Database });
    } catch (e) {
      err(`gridReport: ${v.name}: read failed - ${(e && e.message) || e}`);
      return 2;
    }
    if (!summary.ok) {
      err(`gridReport: ${v.name}: ${summary.reason} ${summary.detail || ""}`.trim());
      return 2;
    }
    summaries[v.name] = summary;
    results.push({ name: v.name, summary });
  }
  const verdicts = [{ title: `verdict on=${args.roles.on}`, value: verdict(summaries, args.roles) }];
  if (args.roles.ctl) {
    verdicts.push({ title: `verdict on=${args.roles.ctl} (ctl)`, value: verdict(summaries, { ...args.roles,
      on: args.roles.ctl }) });
  }
  out(markdown({ results, verdicts }));
  if (args.json) {
    fs.mkdirSync(path.dirname(args.json), { recursive: true });
    fs.writeFileSync(args.json, `${JSON.stringify({ roles: args.roles, thresholds: THRESHOLDS,
      variants: Object.fromEntries(results.map((x) => [x.name, x.summary])),
      verdicts: verdicts.map((v) => ({ title: v.title, ...v.value })) }, null, 2)}\n`);
  }
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { summarize, verdict, readVariant, parseArgs, main, markdown, THRESHOLDS, COUNTER_PREFIXES };
