#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { FACTIONS_V1 } = require("../../lib/strategy/data/factions");

const DB_FILE = "world.sqlite";
const SEGMENT_REPORT_RE = /^seg(\d+)\.report\.json$/;
const LOG_ERROR_RE = / error|TX_FAILED/;
const LOG_ROW_LIMIT_RE = /TX_ROW_LIMIT/;
const COUNTER_CHANNEL = "strategy";

const COUNTERS = Object.freeze(["review.hqHold", "review.hqUnheld", "review.hqReturnPlanned", "review.patrolsLaunched",
  "review.mobilized", "review.launches", "review.attacks", "review.homeSpaceUnavailable",
  "review.upkeepReserveBlocked"]);

const THRESHOLDS = Object.freeze({
  noiseFactor: 2,
  minBand: 2,
  correctness: Object.freeze({ minCheckRuns: 3, logErrorsSlack: 2 }),
  fronts: Object.freeze({ capturesLowRel: 0.30, capturesHighRel: 0.25, battlesLowRel: 0.40, battlesHighRel: 0.50 }),
  cost: Object.freeze({ passFactor: 1.25, passSlackMs: 2, latenessFactor: 1.25, latenessSlackMs: 2000 }),
  income: Object.freeze({ maxUnpaidPeriods: 3 }),
  freeze: Object.freeze({ minEmpireShipsShare: 0.70, minMobilizedShare: 0.50 }),
  expansion: Object.freeze({ capturesHighRel: 0.25 }),
  calibration: Object.freeze({
    hq: Object.freeze({ "strategy.hqGarrisonRoles": "garrison" }),
    upkFreeze: Object.freeze({ "upkeep.homeSpaceIncomePermille": 400 }),
    upkExpansion: Object.freeze({ "upkeep.homeSpaceIncomePermille": 150 }),
  }),
});

const USAGE = "usage: node mods/livingNewEden/tools/measure/worldFlagsReport.js --variant <name>=<dir> [--variant ...] "
  + "--base <name> --noise <name> [--hq <name>] [--upk <name>] [--ctl <name> --ctl-of hq|upk] [--json <file>]";

function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

const num = (v) => (isNum(v) ? v : 0);

function median(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function channelsOf(telemetry) {
  if (!telemetry || typeof telemetry !== "object") return null;
  if (telemetry.channels && typeof telemetry.channels === "object") return telemetry.channels;
  return telemetry;
}

function countersOf(telemetry) {
  const ch = channelsOf(telemetry);
  const names = ch && ch[COUNTER_CHANNEL] && typeof ch[COUNTER_CHANNEL] === "object" ? ch[COUNTER_CHANNEL] : {};
  const out = {};
  for (const name of COUNTERS) out[name] = num(names[name]);
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

function factionRowOf(r) {
  return { factionId: r.factionId, unpaidPeriods: num(r.unpaidPeriods), resourceUnits: num(r.resourceUnits),
    incomeTotal: num(r.incomeTotal), upkeepTotal: num(r.upkeepTotal), liveShips: num(r.liveShips),
    liveFleets: num(r.liveFleets), idleFleets: num(r.idleFleets), fleetsInHq: num(r.fleetsInHq) };
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
  const empireIds = new Set(Array.isArray(input.empireIds) ? input.empireIds : []);
  const hqFactionIds = new Set(Array.isArray(input.hqFactionIds) ? input.hqFactionIds : []);
  const contiguous = segs.every((d, i) => d.index === i + 1);
  const perDay = segs.map((d) => ({ index: d.index, startVirtualAt: d.startVirtualAt, stopVirtualAt: d.stopVirtualAt,
    exitOk: segmentExitOk(d), battles: 0, shipsLost: 0, captures: 0, empireCaptures: 0,
    logErrors: num(d.logErrors), logRowLimit: num(d.logRowLimit),
    checks: d.report && d.report.checks ? { runs: d.report.checks.runs || 0, pass: d.report.checks.pass || 0,
      fail: d.report.checks.fail || 0, error: d.report.checks.error || 0 } : { runs: 0, pass: 0, fail: 0, error: 0 },
    counters: countersOf(d.telemetry) }));
  const dayOf = (t) => {
    for (let i = 0; i < segs.length; i += 1) if (segs[i].startVirtualAt <= t && t < segs[i].stopVirtualAt) return perDay[i];
    return null;
  };
  const inWindow = (t) => isNum(t) && t >= from && t < to;
  const out = { ok: true, windowMs: to - from, segments: segs.length,
    exitOk: contiguous && perDay.every((d) => d.exitOk), checks: { runs: 0, pass: 0, fail: 0, error: 0 },
    battles: 0, shipsLost: 0, captures: 0, empireCaptures: 0,
    counters: Object.fromEntries(COUNTERS.map((n) => [n, 0])), passP95MsMedian: null, latenessP95MsMedian: null,
    logErrors: 0, logRowLimit: 0, empires: [], empireLiveShips: 0, hqHeldFactions: 0,
    telemetryMissing: segs.filter((d) => channelsOf(d.telemetry) === null).map((d) => `seg${d.index}`), perDay };
  for (const b of input.battles || []) {
    if (!b || !inWindow(b.createdAt)) continue;
    const lost = num(b.shipsLost);
    out.battles += 1;
    out.shipsLost += lost;
    const day = dayOf(b.createdAt);
    if (day) {
      day.battles += 1;
      day.shipsLost += lost;
    }
  }
  for (const c of input.captures || []) {
    if (!c || !inWindow(c.capturedAt)) continue;
    const empire = empireIds.has(c.controllerFactionId);
    out.captures += 1;
    if (empire) out.empireCaptures += 1;
    const day = dayOf(c.capturedAt);
    if (day) {
      day.captures += 1;
      if (empire) day.empireCaptures += 1;
    }
  }
  const passAll = [];
  const lateAll = [];
  for (const [i, d] of segs.entries()) {
    const day = perDay[i];
    for (const k of ["runs", "pass", "fail", "error"]) out.checks[k] += day.checks[k];
    out.logErrors += day.logErrors;
    out.logRowLimit += day.logRowLimit;
    for (const name of COUNTERS) out.counters[name] += day.counters[name];
    passAll.push(...schedulerValues(d.status, "passP95Ms"));
    lateAll.push(...schedulerValues(d.status, "latenessP95Ms"));
  }
  out.passP95MsMedian = median(passAll);
  out.latenessP95MsMedian = median(lateAll);
  const rows = (Array.isArray(input.factions) ? input.factions : []).filter((r) => r && Number.isSafeInteger(r.factionId))
    .map(factionRowOf).sort((a, b) => a.factionId - b.factionId);
  out.empires = rows.filter((r) => empireIds.has(r.factionId));
  out.empireLiveShips = out.empires.reduce((s, r) => s + r.liveShips, 0);
  out.hqHeldFactions = rows.filter((r) => hqFactionIds.has(r.factionId) && r.fleetsInHq >= 1).length;
  return out;
}

const counterOf = (s, name) => num(s.counters[name]);

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

const fmt = (v) => (isNum(v) ? String(Number(v.toFixed(3))) : "-");

const telemetryMissingOf = (s) => (Array.isArray(s.telemetryMissing) ? s.telemetryMissing : ["(no telemetryMissing)"]);

function telemetryGate(g, named) {
  for (const [label, s] of named) {
    const missing = telemetryMissingOf(s);
    if (missing.length > 0) fail(g, `${label} telemetryMissing: [${missing.join(", ")}]`);
  }
}

function correctnessGate(on, base, T) {
  const g = gate(true);
  telemetryGate(g, [["on", on], ["base", base]]);
  if (!on.exitOk) fail(g, "exitOk false (a segment without report, with report.error or exit != 0)");
  if (on.checks.fail !== 0 || on.checks.error !== 0) fail(g, `checks fail=${on.checks.fail} error=${on.checks.error}`);
  if (on.checks.runs < T.correctness.minCheckRuns) fail(g, `checks.runs=${on.checks.runs} < ${T.correctness.minCheckRuns}`);
  if (on.logErrors > base.logErrors + T.correctness.logErrorsSlack) {
    fail(g, `logErrors=${on.logErrors} > base=${base.logErrors} + ${T.correctness.logErrorsSlack}`);
  }
  if (on.logRowLimit > base.logRowLimit) fail(g, `logRowLimit=${on.logRowLimit} > base=${base.logRowLimit}`);
  note(g, `checks runs/pass/fail/error ${on.checks.runs}/${on.checks.pass}/${on.checks.fail}/${on.checks.error}; `
    + `logErrors ${on.logErrors} (base ${base.logErrors}); logRowLimit ${on.logRowLimit} (base ${base.logRowLimit})`);
  return g;
}

function costGate(on, base, T) {
  const g = gate(true);
  const line = (field, factor, slack) => {
    const limit = isNum(base[field]) ? factor * base[field] + slack : null;
    const text = `${field}=${fmt(on[field])} <= ${fmt(limit)} (base ${fmt(base[field])})`;
    if (limit === null || !isNum(on[field])) fail(g, `${text} - no data`);
    else if (on[field] > limit) fail(g, text);
    else note(g, text);
  };
  line("passP95MsMedian", T.cost.passFactor, T.cost.passSlackMs);
  line("latenessP95MsMedian", T.cost.latenessFactor, T.cost.latenessSlackMs);
  return g;
}

function verdict(summaries, roles, thresholds = THRESHOLDS) {
  const T = thresholds;
  const pickName = (name) => (typeof name === "string" && summaries && summaries[name]
    && summaries[name].ok === true ? summaries[name] : null);
  const base = pickName(roles && roles.base);
  const noise = pickName(roles && roles.noise);
  if (!base || !noise) return { ok: false, reason: "INVALID_INPUT", detail: `roles base/noise: ${JSON.stringify(roles)}` };
  const hasCtl = typeof roles.ctl === "string" && (roles.ctlOf === "hq" || roles.ctlOf === "upk");
  if (typeof roles.ctl === "string" && !hasCtl) {
    return { ok: false, reason: "INVALID_INPUT", detail: "ctl needs ctlOf hq|upk" };
  }
  const nameOf = (role) => (hasCtl && roles.ctlOf === role ? roles.ctl : roles[role]);
  const band = (m, rel) => Math.max(rel * base[m], T.noiseFactor * Math.abs(base[m] - noise[m]), T.minBand);
  const inBand = (g, on, m, lowRel, highRel) => {
    const lo = base[m] - band(m, lowRel);
    const hi = base[m] + band(m, highRel);
    const line = `${m}=${on[m]} in [${fmt(lo)}, ${fmt(hi)}] (base ${base[m]}, noise ${noise[m]})`;
    if (on[m] < lo) {
      fail(g, `${line} - below`);
      return "below";
    }
    if (on[m] > hi) {
      fail(g, `${line} - above`);
      return "above";
    }
    note(g, line);
    return "in";
  };

  let hq = null;
  const hqOn = pickName(nameOf("hq"));
  if (hqOn) {
    const q1 = correctnessGate(hqOn, base, T);
    const q2 = gate(true);
    telemetryGate(q2, [["hq", hqOn]]);
    const hold = counterOf(hqOn, "review.hqHold");
    if (hold > 0) note(q2, `review.hqHold=${hold}`);
    else fail(q2, "review.hqHold=0");
    if (hqOn.hqHeldFactions >= base.hqHeldFactions + 1) {
      note(q2, `hqHeldFactions=${hqOn.hqHeldFactions} >= base ${base.hqHeldFactions} + 1`);
    } else fail(q2, `hqHeldFactions=${hqOn.hqHeldFactions} < base ${base.hqHeldFactions} + 1`);
    note(q2, `review.hqReturnPlanned=${counterOf(hqOn, "review.hqReturnPlanned")}, `
      + `review.hqUnheld=${counterOf(hqOn, "review.hqUnheld")}`);
    const q3 = gate(true);
    const captures = inBand(q3, hqOn, "captures", T.fronts.capturesLowRel, T.fronts.capturesHighRel);
    const battles = inBand(q3, hqOn, "battles", T.fronts.battlesLowRel, T.fronts.battlesHighRel);
    inBand(q3, hqOn, "shipsLost", T.fronts.battlesLowRel, T.fronts.battlesHighRel);
    const q4 = costGate(hqOn, base, T);
    const gates = { Q1: q1, Q2: q2, Q3: q3, Q4: q4 };
    const go = Object.values(gates).every((g) => g.pass);
    let calibration = null;
    const isCtl = hasCtl && roles.ctlOf === "hq";
    if (!isCtl && !q3.pass && q1.pass && q2.pass && q4.pass && (captures === "below" || battles === "below")) {
      calibration = { rule: "hq-fronts-below", set: { ...T.calibration.hq } };
    }
    hq = { verdict: go ? "GO" : "NO_GO", gates, calibration };
  }

  let upk = null;
  const upkOn = pickName(nameOf("upk"));
  if (upkOn) {
    const u1 = correctnessGate(upkOn, base, T);
    const unavailable = counterOf(upkOn, "review.homeSpaceUnavailable");
    if (unavailable !== 0) fail(u1, `review.homeSpaceUnavailable=${unavailable} != 0`);
    const baseRows = new Map(base.empires.map((r) => [r.factionId, r]));
    const u2 = gate(true);
    const u3 = gate(true);
    telemetryGate(u3, [["upk", upkOn], ["base", base]]);
    for (const r of upkOn.empires) {
      const b = baseRows.get(r.factionId);
      const bIncome = b ? b.incomeTotal : 0;
      if (r.incomeTotal > bIncome) note(u2, `${r.factionId} incomeTotal=${r.incomeTotal} > base ${bIncome}`);
      else fail(u2, `${r.factionId} incomeTotal=${r.incomeTotal} <= base ${bIncome}`);
      if (r.unpaidPeriods > T.income.maxUnpaidPeriods) {
        fail(u2, `${r.factionId} unpaidPeriods=${r.unpaidPeriods} > ${T.income.maxUnpaidPeriods}`);
      }
      if (r.liveShips > 0) note(u3, `${r.factionId} liveShips=${r.liveShips} (base ${b ? b.liveShips : 0})`);
      else fail(u3, `${r.factionId} liveShips=0`);
    }
    if (upkOn.empires.length === 0) fail(u2, "no empire rows");
    const shipsMin = T.freeze.minEmpireShipsShare * base.empireLiveShips;
    if (upkOn.empireLiveShips >= shipsMin) {
      note(u3, `empireLiveShips=${upkOn.empireLiveShips} >= ${fmt(shipsMin)} (base ${base.empireLiveShips})`);
    } else fail(u3, `empireLiveShips=${upkOn.empireLiveShips} < ${fmt(shipsMin)} (base ${base.empireLiveShips})`);
    const mobMin = T.freeze.minMobilizedShare * counterOf(base, "review.mobilized");
    const mob = counterOf(upkOn, "review.mobilized");
    if (mob >= mobMin) note(u3, `review.mobilized=${mob} >= ${fmt(mobMin)}`);
    else fail(u3, `review.mobilized=${mob} < ${fmt(mobMin)} (base ${counterOf(base, "review.mobilized")})`);
    const u4 = gate(true);
    for (const m of ["empireCaptures", "captures"]) {
      const hi = base[m] + band(m, T.expansion.capturesHighRel);
      const line = `${m}=${upkOn[m]} <= ${fmt(hi)} (base ${base[m]}, noise ${noise[m]})`;
      if (upkOn[m] > hi) fail(u4, line);
      else note(u4, line);
    }
    inBand(u4, upkOn, "battles", T.fronts.battlesLowRel, T.fronts.battlesHighRel);
    inBand(u4, upkOn, "shipsLost", T.fronts.battlesLowRel, T.fronts.battlesHighRel);
    const u5 = costGate(upkOn, base, T);
    const gates = { U1: u1, U2: u2, U3: u3, U4: u4, U5: u5 };
    const go = Object.values(gates).every((g) => g.pass);
    let calibration = null;
    const isCtl = hasCtl && roles.ctlOf === "upk";
    const others = u1.pass && u2.pass && u5.pass;
    if (!isCtl && others && !u3.pass) calibration = { rule: "upk-freeze", set: { ...T.calibration.upkFreeze } };
    else if (!isCtl && others && u3.pass && !u4.pass) {
      calibration = { rule: "upk-expansion", set: { ...T.calibration.upkExpansion } };
    }
    upk = { verdict: go ? "GO" : "NO_GO", gates, calibration };
  }
  return { hq, upk };
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

function registryFacts() {
  const hq = new Map();
  const empireIds = [];
  for (const f of FACTIONS_V1) {
    if (!Number.isSafeInteger(f.hqSystemId)) continue;
    hq.set(f.factionId, f.hqSystemId);
    if (f.kind === "empire") empireIds.push(f.factionId);
  }
  return { hq, empireIds, hqFactionIds: [...hq.keys()] };
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
  const facts = registryFacts();
  const Database = opts.Database || require("better-sqlite3");
  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    const battles = db.prepare(`SELECT b.created_at AS createdAt,
        (SELECT coalesce(sum(l.count), 0) FROM battle_losses l WHERE l.battle_id = b.battle_id) AS shipsLost
      FROM battle_records b WHERE b.created_at >= ? AND b.created_at < ?`).all(from, to)
      .map((r) => ({ createdAt: Number(r.createdAt), shipsLost: Number(r.shipsLost) }));
    const captures = db.prepare(`SELECT captured_at AS capturedAt, controller_faction_id AS controllerFactionId
      FROM world_system_state WHERE captured_at IS NOT NULL AND captured_at >= ? AND captured_at < ?`).all(from, to)
      .map((r) => ({ capturedAt: Number(r.capturedAt), controllerFactionId: r.controllerFactionId === null
        ? null : Number(r.controllerFactionId) }));
    const byFaction = new Map();
    for (const r of db.prepare(`SELECT faction_id AS factionId, upkeep_unpaid_periods AS unpaidPeriods,
        resource_units AS resourceUnits, income_total AS incomeTotal, upkeep_total AS upkeepTotal
      FROM world_factions`).all()) {
      const id = Number(r.factionId);
      byFaction.set(id, { factionId: id, unpaidPeriods: Number(r.unpaidPeriods), resourceUnits: Number(r.resourceUnits),
        incomeTotal: Number(r.incomeTotal), upkeepTotal: Number(r.upkeepTotal), liveShips: 0, liveFleets: 0,
        idleFleets: 0, fleetsInHq: 0 });
    }
    for (const r of db.prepare(`SELECT faction_id AS factionId, current_system_id AS systemId,
        coalesce(sum(ship_count), 0) AS ships, count(*) AS fleets, coalesce(sum(state = 'IDLE'), 0) AS idle
      FROM virtual_fleets WHERE state <> 'DESTROYED' GROUP BY faction_id, current_system_id`).all()) {
      const row = byFaction.get(Number(r.factionId));
      if (!row) continue;
      row.liveShips += Number(r.ships);
      row.liveFleets += Number(r.fleets);
      row.idleFleets += Number(r.idle);
      if (r.systemId !== null && facts.hq.get(row.factionId) === Number(r.systemId)) row.fleetsInHq += Number(r.fleets);
    }
    return summarize({ days, battles, captures, factions: [...byFaction.values()], empireIds: facts.empireIds,
      hqFactionIds: facts.hqFactionIds });
  } finally {
    db.close();
  }
}

const ROLE_FLAGS = Object.freeze({ "--base": "base", "--noise": "noise", "--hq": "hq", "--upk": "upk", "--ctl": "ctl",
  "--ctl-of": "ctlOf" });

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
      if (typeof v !== "string" || v === "") throw new UsageError(`${a} needs a value`);
      out.roles[ROLE_FLAGS[a]] = v;
    } else if (a === "--json") {
      if (typeof v !== "string" || v === "") throw new UsageError("--json needs a file");
      out.json = path.resolve(v);
    } else throw new UsageError(`unknown argument ${a}`);
    i += 1;
  }
  if (out.variants.length === 0) throw new UsageError("at least one --variant");
  for (const role of ["base", "noise"]) if (!out.roles[role]) throw new UsageError(`--${role} is required`);
  if (!out.roles.hq && !out.roles.upk) throw new UsageError("--hq or --upk is required");
  if (out.roles.ctlOf !== undefined && out.roles.ctlOf !== "hq" && out.roles.ctlOf !== "upk") {
    throw new UsageError("--ctl-of needs hq or upk");
  }
  if ((out.roles.ctl === undefined) !== (out.roles.ctlOf === undefined)) {
    throw new UsageError("--ctl and --ctl-of go together");
  }
  for (const role of ["base", "noise", "hq", "upk", "ctl"]) {
    const name = out.roles[role];
    if (name !== undefined && !out.variants.some((x) => x.name === name)) {
      throw new UsageError(`--${role} ${name} is not a --variant`);
    }
  }
  return out;
}

const fmtCell = (v) => (v === null || v === undefined ? "-" : String(v));

const TABLE_HEAD = ["variant", "exitOk", "checks r/p/f/e", "battles", "shipsLost", "captures", "empireCaptures",
  "logErr/rowLimit", "passP95 med", "lateP95 med", "hqHold", "hqUnheld", "hqReturnPlanned", "patrols", "mobilized",
  "homeSpaceUnavail", "hqHeldFactions", "empireShips", "telemetryMissing"];

function rowOf(name, s) {
  const c = (k) => counterOf(s, k);
  return [name, s.exitOk, `${s.checks.runs}/${s.checks.pass}/${s.checks.fail}/${s.checks.error}`, s.battles,
    s.shipsLost, s.captures, s.empireCaptures, `${s.logErrors}/${s.logRowLimit}`, fmtCell(s.passP95MsMedian),
    fmtCell(s.latenessP95MsMedian), c("review.hqHold"), c("review.hqUnheld"), c("review.hqReturnPlanned"),
    c("review.patrolsLaunched"), c("review.mobilized"), c("review.homeSpaceUnavailable"), s.hqHeldFactions,
    s.empireLiveShips, telemetryMissingOf(s).join(",") || "-"];
}

function gateTable(title, v) {
  const lines = [`${title}: ${v.verdict}${v.calibration ? ` (calibration ${v.calibration.rule}: `
    + `${JSON.stringify(v.calibration.set)})` : ""}`, "", "| gate | pass | blocking | detail |", "|---|---|---|---|"];
  for (const [g, r] of Object.entries(v.gates)) {
    lines.push(`| ${g} | ${r.pass ? "PASS" : "FAIL"} | ${r.blocking ? "yes" : "no"} | ${r.detail.join("; ")} |`);
  }
  return lines;
}

function markdown(r) {
  const lines = [`| ${TABLE_HEAD.join(" | ")} |`, `|${TABLE_HEAD.map(() => "---").join("|")}|`];
  for (const x of r.results) lines.push(`| ${rowOf(x.name, x.summary).join(" | ")} |`);
  for (const v of r.verdicts) {
    if (v.value.ok === false) lines.push("", `${v.title}: ${v.value.reason} ${v.value.detail || ""}`.trim());
    for (const flag of ["hq", "upk"]) if (v.value[flag]) lines.push("", ...gateTable(`${v.title} ${flag}`, v.value[flag]));
  }
  lines.push("", "| variant | empire | unpaid | income | upkeep | resources | ships | fleets | idle | inHq |",
    "|---|---|---|---|---|---|---|---|---|---|");
  for (const x of r.results) {
    for (const e of x.summary.empires) {
      lines.push(`| ${x.name} | ${e.factionId} | ${e.unpaidPeriods} | ${e.incomeTotal} | ${e.upkeepTotal} | `
        + `${e.resourceUnits} | ${e.liveShips} | ${e.liveFleets} | ${e.idleFleets} | ${e.fleetsInHq} |`);
    }
  }
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
    err(`worldFlagsReport: ${e.message} (${USAGE})`);
    return 1;
  }
  const summaries = {};
  const results = [];
  for (const v of args.variants) {
    let summary;
    try {
      summary = readVariant(v.dir, { Database: io.Database });
    } catch (e) {
      err(`worldFlagsReport: ${v.name}: read failed - ${(e && e.message) || e}`);
      return 2;
    }
    if (!summary.ok) {
      err(`worldFlagsReport: ${v.name}: ${summary.reason} ${summary.detail || ""}`.trim());
      return 2;
    }
    summaries[v.name] = summary;
    results.push({ name: v.name, summary });
  }
  const { ctl, ctlOf, ...first } = args.roles;
  const verdicts = [{ title: "verdict", value: verdict(summaries, first) }];
  if (ctl) verdicts.push({ title: `verdict ${ctlOf}=${ctl} (ctl)`, value: verdict(summaries, args.roles) });
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

module.exports = { summarize, verdict, readVariant, parseArgs, main, markdown, THRESHOLDS, COUNTERS };
