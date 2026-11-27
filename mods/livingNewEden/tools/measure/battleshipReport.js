#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const S = require("./segments");
const { DOCTRINES_V1 } = require("../../lib/strategy/data/doctrines");
const { FACTIONS_V1 } = require("../../lib/strategy/data/factions");

const { isNum, median, schedulerValues, segmentExitOk, UsageError } = S;

const DAY_MS = 86400000;
const BATTLESHIP_GROUP = "battleship";
const PIRATE_KIND = "pirate";
const NATIVE_OBJECTIVES = Object.freeze(["capture", "destroy"]);
const STRATEGY_LINE_PREFIX = "strategy: battleshipDoctrines=";

const LOG_PATTERNS = Object.freeze({
  logErrors: / error|TX_FAILED/,
  logRowLimit: /TX_ROW_LIMIT/,
  logOverlayDropped: /battleship garrison overlay dropped/,
});

const THRESHOLDS = Object.freeze({
  noiseFactor: 2,
  minBand: 2,
  b1: Object.freeze({ minCheckRuns: 3, logErrorsSlack: 2, strategyLine: "calibrated=on garrisonOverlay=4" }),
  b2: Object.freeze({ mobilizedRel: 0.7 }),
  b3: Object.freeze({ maxUnpaidStreak: 2 }),
  b4: Object.freeze({ garrisonFactor: 1.2, garrisonSlack: 2 }),
  b5: Object.freeze({ capturesRel: 0.30 }),
  b6: Object.freeze({ factor: 2, slack: 4 }),
  b7: Object.freeze({ passFactor: 1.25, passSlackMs: 2, latenessFactor: 1.25, latenessSlackMs: 2000 }),
});

const USAGE = "usage: node mods/livingNewEden/tools/measure/battleshipReport.js --variant <name>=<dir> [--variant ...] "
  + "--off <name> --noise <name> [--direct <name>] [--ramp <name>] [--json <file>]";

const numOr0 = (v) => (isNum(v) ? v : 0);
const dayOf = (at) => Math.floor(at / DAY_MS);

function nativeBattleshipFactions(doctrines, factions) {
  const native = new Set((doctrines || []).filter((d) => d && d.templates && Object.values(d.templates)
    .some((entries) => Array.isArray(entries) && entries.some((e) => e && e.hullGroup === BATTLESHIP_GROUP)))
    .map((d) => d.doctrineId));
  return [...new Set((factions || []).filter((f) => f && native.has(f.doctrineId)).map((f) => f.factionId))]
    .sort((a, b) => a - b);
}

function unpaidStreaks(rows, fromDay, toDay) {
  const days = new Map();
  for (const r of rows || []) {
    if (!r || r.kind !== PIRATE_KIND || !Number.isSafeInteger(r.day) || r.day < fromDay || r.day > toDay) continue;
    if (!(numOr0(r.unpaid) > 0)) continue;
    if (!days.has(r.factionId)) days.set(r.factionId, new Set());
    days.get(r.factionId).add(r.day);
  }
  const out = {};
  for (const [factionId, set] of [...days].sort((a, b) => a[0] - b[0])) {
    let best = 0;
    for (const d of set) {
      if (set.has(d - 1)) continue;
      let n = 1;
      while (set.has(d + n)) n += 1;
      best = Math.max(best, n);
    }
    out[factionId] = best;
  }
  return out;
}

function summarize(input) {
  if (!input || typeof input !== "object" || !Array.isArray(input.days) || input.days.length === 0) {
    return { ok: false, reason: "INVALID_INPUT", detail: "days" };
  }
  const segs = [...input.days].sort((a, b) => a.index - b.index);
  for (const d of segs) {
    if (!d || !Number.isSafeInteger(d.index) || !isNum(d.startVirtualAt) || !isNum(d.stopVirtualAt)
      || d.stopVirtualAt < d.startVirtualAt) {
      return { ok: false, reason: "INVALID_INPUT", detail: `segment ${d && d.index}` };
    }
  }
  const from = segs[0].startVirtualAt;
  const to = segs[segs.length - 1].stopVirtualAt;
  const inWindow = (at) => isNum(at) && at >= from && at < to;
  const contiguous = segs.every((d, i) => d.index === i + 1);
  const bySeg = (list, index) => (Array.isArray(list) ? numOr0(list[index - 1]) : 0);
  const windowSum = (list, lo, hi) => segs.filter((d) => d.index >= lo && d.index <= hi)
    .reduce((s, d) => s + bySeg(list, d.index), 0);
  const native = new Set(Array.isArray(input.nativeBsFactions) ? input.nativeBsFactions : []);

  const out = { ok: true, windowMs: to - from, segments: segs.length,
    exitOk: contiguous && segs.every(segmentExitOk), checks: { runs: 0, pass: 0, fail: 0, error: 0 },
    logErrors: 0, logRowLimit: 0, logOverlayDropped: 0, logStrategyLine: null,
    mobilized: { w1: windowSum(input.mobilizedBySeg, 1, 2), w2: windowSum(input.mobilizedBySeg, 3, 4) },
    noHulls: { w1: windowSum(input.noHullsBySeg, 1, 2), w2: windowSum(input.noHullsBySeg, 3, 4) },
    captures: 0, garrisonsByFaction: {}, pirateUnpaidStreak: {}, nativeAttacks: 0, fleetsPerInvasion: null,
    passP95MsMedian: null, latenessP95MsMedian: null };
  const first = segs[0];
  if (first.index === 1 && typeof first.strategyLine === "string") out.logStrategyLine = first.strategyLine;
  const passAll = [];
  const lateAll = [];
  for (const d of segs) {
    const c = d.report && d.report.checks ? d.report.checks : {};
    for (const k of ["runs", "pass", "fail", "error"]) out.checks[k] += numOr0(c[k]);
    out.logErrors += numOr0(d.logErrors);
    out.logRowLimit += numOr0(d.logRowLimit);
    out.logOverlayDropped += numOr0(d.logOverlayDropped);
    passAll.push(...schedulerValues(d.status, "passP95Ms"));
    lateAll.push(...schedulerValues(d.status, "latenessP95Ms"));
  }
  out.passP95MsMedian = median(passAll);
  out.latenessP95MsMedian = median(lateAll);
  for (const c of input.captures || []) if (c && inWindow(c.capturedAt)) out.captures += 1;
  for (const b of input.battles || []) {
    if (!b || !inWindow(b.createdAt) || !NATIVE_OBJECTIVES.includes(b.objective)) continue;
    if ((Array.isArray(b.factionsB) ? b.factionsB : []).some((f) => native.has(f))) out.nativeAttacks += 1;
  }
  const g = input.garrisonsByFaction && typeof input.garrisonsByFaction === "object" ? input.garrisonsByFaction : {};
  for (const k of Object.keys(g).sort((a, b) => Number(a) - Number(b))) out.garrisonsByFaction[k] = numOr0(g[k]);
  out.pirateUnpaidStreak = unpaidStreaks(input.unpaidDays, dayOf(from), dayOf(Math.max(from, to - 1)));
  const inv = (input.invasions || []).filter((x) => x && isNum(x.fleets)
    && (x.plannedAt === undefined || inWindow(x.plannedAt)));
  out.fleetsPerInvasion = inv.length === 0 ? null : inv.reduce((s, x) => s + x.fleets, 0) / inv.length;
  return out;
}

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

function gatesOf(V, off, noise, isDirect, T) {
  const N = (m) => Math.abs(numOr0(off[m]) - numOr0(noise[m]));
  const band = (m, rel) => Math.max(rel * off[m], T.noiseFactor * N(m), T.minBand);

  const b1 = gate(true);
  if (!V.exitOk) fail(b1, "exitOk false (a segment without report, with report.error or exit != 0)");
  if (V.checks.runs < T.b1.minCheckRuns) fail(b1, `checks.runs=${V.checks.runs} < ${T.b1.minCheckRuns}`);
  if (V.checks.fail !== 0 || V.checks.error !== 0) fail(b1, `checks fail=${V.checks.fail} error=${V.checks.error}`);
  if (V.logErrors > off.logErrors + T.b1.logErrorsSlack) {
    fail(b1, `logErrors=${V.logErrors} > off=${off.logErrors} + ${T.b1.logErrorsSlack}`);
  }
  if (V.logRowLimit > off.logRowLimit) fail(b1, `logRowLimit=${V.logRowLimit} > off=${off.logRowLimit}`);
  if (typeof V.logStrategyLine !== "string" || !V.logStrategyLine.includes(T.b1.strategyLine)) {
    fail(b1, `start line without "${T.b1.strategyLine}": ${V.logStrategyLine === null ? "-" : V.logStrategyLine}`);
  }
  if (V.logOverlayDropped !== 0) fail(b1, `overlay dropped lines=${V.logOverlayDropped}`);
  note(b1, `checks r/p/f/e ${V.checks.runs}/${V.checks.pass}/${V.checks.fail}/${V.checks.error}; logErrors `
    + `${V.logErrors} (off ${off.logErrors}); logRowLimit ${V.logRowLimit} (off ${off.logRowLimit})`);

  const b2 = gate(true);
  b2.w1Fail = false;
  const windows = isDirect ? ["w1", "w2"] : ["w2"];
  for (const w of windows) {
    const limit = T.b2.mobilizedRel * off.mobilized[w];
    const text = `mobilized.${w}=${V.mobilized[w]} >= ${fmt(limit)} (off ${off.mobilized[w]})`;
    if (V.mobilized[w] < limit) {
      fail(b2, text);
      if (w === "w1") b2.w1Fail = true;
    } else note(b2, text);
  }

  const b3 = gate(true);
  for (const [factionId, streak] of Object.entries(V.pirateUnpaidStreak)) {
    if (streak < T.b3.maxUnpaidStreak) continue;
    const offStreak = numOr0(off.pirateUnpaidStreak[factionId]);
    const text = `pirate ${factionId} unpaid streak ${streak} days (off ${offStreak})`;
    if (offStreak >= T.b3.maxUnpaidStreak) note(b3, text);
    else fail(b3, text);
  }
  if (b3.detail.length === 0) note(b3, "no pirate with an unpaid streak");

  const b4 = gate(true);
  for (const [factionId, n] of Object.entries(V.garrisonsByFaction)) {
    const o = numOr0(off.garrisonsByFaction[factionId]);
    const limit = Math.max(T.b4.garrisonFactor * o, o + T.b4.garrisonSlack);
    if (n > limit) fail(b4, `garrisons ${factionId}=${n} > ${fmt(limit)} (off ${o})`);
  }
  if (b4.pass) note(b4, `garrisons within max(${T.b4.garrisonFactor} x off, off + ${T.b4.garrisonSlack})`);

  const b5 = gate(true);
  const capHi = off.captures + band("captures", T.b5.capturesRel);
  const capText = `captures=${V.captures} <= ${fmt(capHi)} (off ${off.captures}, noise ${noise.captures})`;
  if (V.captures > capHi) fail(b5, capText);
  else note(b5, capText);

  const b6 = gate(true);
  const natHi = Math.max(T.b6.factor * off.nativeAttacks, off.nativeAttacks + T.noiseFactor * N("nativeAttacks"),
    off.nativeAttacks + T.b6.slack);
  const natText = `nativeAttacks=${V.nativeAttacks} <= ${fmt(natHi)} (off ${off.nativeAttacks})`;
  if (V.nativeAttacks > natHi) fail(b6, natText);
  else note(b6, natText);

  const b7 = gate(true);
  const cost = (label, v, o, factor, slack) => {
    const limit = isNum(o) ? factor * o + slack : null;
    const text = `${label}=${fmt(v)} <= ${fmt(limit)} (off ${fmt(o)})`;
    if (limit === null || !isNum(v)) fail(b7, `${text} - no data`);
    else if (v > limit) fail(b7, text);
    else note(b7, text);
  };
  cost("passP95MsMedian", V.passP95MsMedian, off.passP95MsMedian, T.b7.passFactor, T.b7.passSlackMs);
  cost("latenessP95MsMedian", V.latenessP95MsMedian, off.latenessP95MsMedian, T.b7.latenessFactor,
    T.b7.latenessSlackMs);

  const b8 = gate(false);
  note(b8, `noHulls w1/w2 ${V.noHulls.w1}/${V.noHulls.w2} (off ${off.noHulls.w1}/${off.noHulls.w2})`);
  note(b8, `fleetsPerInvasion ${fmt(V.fleetsPerInvasion)} (off ${fmt(off.fleetsPerInvasion)})`);
  const capLo = off.captures - band("captures", T.b5.capturesRel);
  if (V.captures < capLo) note(b8, `captures=${V.captures} below ${fmt(capLo)} (off ${off.captures})`);

  return { B1: b1, B2: b2, B3: b3, B4: b4, B5: b5, B6: b6, B7: b7, B8: b8 };
}

const blockingFails = (gates) => Object.entries(gates).filter(([, g]) => g.blocking && !g.pass).map(([k]) => k);

function verdict(summaries, roles, thresholds = THRESHOLDS) {
  const T = thresholds;
  const pick = (role) => (roles && typeof roles[role] === "string" && summaries && summaries[roles[role]]
    && summaries[roles[role]].ok === true ? summaries[roles[role]] : null);
  const off = pick("off");
  const noise = pick("noise");
  if (!off || !noise) return { ok: false, reason: "INVALID_INPUT", detail: `roles off/noise: ${JSON.stringify(roles)}` };
  const variants = {};
  for (const role of ["direct", "ramp"]) {
    const V = pick(role);
    if (!V) {
      variants[role] = { verdict: "MISSING", gates: {} };
      continue;
    }
    const gates = gatesOf(V, off, noise, role === "direct", T);
    variants[role] = { verdict: blockingFails(gates).length === 0 ? "GO" : "NO_GO", gates };
  }
  const direct = variants.direct;
  let result = "NO_GO";
  if (direct.verdict === "GO") result = "GO_A";
  else if (direct.verdict === "NO_GO") {
    const fails = blockingFails(direct.gates);
    const onlyW1 = fails.length === 1 && fails[0] === "B2" && direct.gates.B2.w1Fail === true
      && direct.gates.B2.detail.filter((x) => x.startsWith("FAIL ")).length === 1;
    if (onlyW1 && variants.ramp.verdict === "GO") result = "GO_B";
  }
  return { variants, result, pmStep: result === "GO_A" ? "A" : result === "GO_B" ? "B" : null };
}

function hasTable(db, name) {
  return Boolean(db.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

function parseJsonOr(text, fallback) {
  try {
    return JSON.parse(text);
  } catch (_err) {
    return fallback;
  }
}

function strategyLineOf(file) {
  if (!fs.existsSync(file)) return null;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const i = line.indexOf(STRATEGY_LINE_PREFIX);
    if (i >= 0) return line.slice(i);
  }
  return null;
}

function invasionFactions(native) {
  const overlay = new Set(DOCTRINES_V1.filter((d) => d.battleshipTemplates && d.battleshipTemplates.invasion)
    .map((d) => d.doctrineId));
  return new Set([...native, ...FACTIONS_V1.filter((f) => overlay.has(f.doctrineId)).map((f) => f.factionId)]);
}

function readVariant(resultsDir, opts = {}) {
  const { db: dbFile, days, from, to } = S.readDays(resultsDir, LOG_PATTERNS);
  if (days.length > 0) days[0].strategyLine = strategyLineOf(path.join(resultsDir, `seg${days[0].index}.log`));
  const nativeBsFactions = nativeBattleshipFactions(DOCTRINES_V1, FACTIONS_V1);
  const counterOf = (d, name) => S.counter(d.telemetry, "strategy", name);
  const mobilizedBySeg = [];
  const noHullsBySeg = [];
  for (const d of days) {
    mobilizedBySeg[d.index - 1] = counterOf(d, "review.mobilized");
    noHullsBySeg[d.index - 1] = counterOf(d, "review.noHulls");
  }
  const Database = opts.Database || require("better-sqlite3");
  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    const sideB = db.prepare("SELECT DISTINCT faction_id AS f FROM battle_participants WHERE battle_id = ? AND side = 'B'");
    const battles = db.prepare(`SELECT battle_id AS battleId, created_at AS createdAt, objective FROM battle_records
      WHERE state = 'COMPLETED' AND created_at >= ? AND created_at < ?`).all(from, to)
      .map((r) => ({ createdAt: Number(r.createdAt), objective: r.objective,
        factionsB: sideB.all(r.battleId).map((x) => Number(x.f)) }));
    const captures = db.prepare(`SELECT captured_at AS capturedAt FROM world_system_state
      WHERE captured_at IS NOT NULL AND captured_at >= ? AND captured_at < ?`).all(from, to)
      .map((r) => ({ capturedAt: Number(r.capturedAt) }));
    const garrisonsByFaction = {};
    for (const r of db.prepare(`SELECT faction_id AS f, count(*) AS n FROM virtual_fleets
      WHERE fleet_role = 'garrison' AND state <> 'DESTROYED' GROUP BY faction_id`).all()) {
      garrisonsByFaction[Number(r.f)] = Number(r.n);
    }
    const unpaidDays = hasTable(db, "world_faction_treasury") && hasTable(db, "world_faction_treasury_days")
      ? db.prepare(`SELECT d.faction_id AS factionId, t.kind AS kind, d.day AS day, d.unpaid AS unpaid
        FROM world_faction_treasury_days d JOIN world_faction_treasury t ON t.faction_id = d.faction_id`).all()
        .map((r) => ({ factionId: Number(r.factionId), kind: r.kind, day: Number(r.day), unpaid: Number(r.unpaid) }))
      : [];
    const wanted = invasionFactions(nativeBsFactions);
    const invasions = db.prepare(`SELECT faction_id AS f, fleet_ids AS ids, planned_at AS at FROM world_operations
      WHERE operation_type = 'invasion' AND planned_at >= ? AND planned_at < ?`).all(from, to)
      .filter((r) => wanted.has(Number(r.f)))
      .map((r) => {
        const ids = parseJsonOr(r.ids, null);
        return { factionId: Number(r.f), fleets: Array.isArray(ids) ? ids.length : 0, plannedAt: Number(r.at) };
      });
    return summarize({ days, mobilizedBySeg, noHullsBySeg, battles, captures, garrisonsByFaction, unpaidDays,
      invasions, nativeBsFactions });
  } finally {
    db.close();
  }
}

const ROLE_FLAGS = Object.freeze({ "--off": "off", "--noise": "noise", "--direct": "direct", "--ramp": "ramp" });

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
  for (const role of ["off", "noise"]) if (!out.roles[role]) throw new UsageError(`--${role} is required`);
  for (const [role, name] of Object.entries(out.roles)) {
    if (!out.variants.some((x) => x.name === name)) throw new UsageError(`--${role} ${name} is not a --variant`);
  }
  return out;
}

const fmtCell = (v) => (v === null || v === undefined ? "-" : String(v));

const TABLE_HEAD = ["variant", "exitOk", "checks r/p/f/e", "mobilized w1/w2", "noHulls w1/w2", "captures",
  "nativeAttacks", "fleetsPerInvasion", "garrisons", "pirate unpaid streak", "logErr/rowLimit/dropped", "passP95 med",
  "lateP95 med", "start line"];

function rowOf(name, s) {
  const pairs = (o) => Object.entries(o).map(([k, v]) => `${k}:${v}`).join(" ") || "-";
  return [name, s.exitOk, `${s.checks.runs}/${s.checks.pass}/${s.checks.fail}/${s.checks.error}`,
    `${s.mobilized.w1}/${s.mobilized.w2}`, `${s.noHulls.w1}/${s.noHulls.w2}`, s.captures, s.nativeAttacks,
    fmt(s.fleetsPerInvasion), pairs(s.garrisonsByFaction), pairs(s.pirateUnpaidStreak),
    `${s.logErrors}/${s.logRowLimit}/${s.logOverlayDropped}`, fmtCell(s.passP95MsMedian),
    fmtCell(s.latenessP95MsMedian), fmtCell(s.logStrategyLine)];
}

function markdown(r) {
  const lines = [`| ${TABLE_HEAD.join(" | ")} |`, `|${TABLE_HEAD.map(() => "---").join("|")}|`];
  for (const x of r.results) lines.push(`| ${rowOf(x.name, x.summary).join(" | ")} |`);
  const v = r.verdict;
  if (!v || !v.variants) {
    lines.push("", `verdict: ${v ? `${v.reason} ${v.detail || ""}` : "-"}`);
    return lines.join("\n");
  }
  lines.push("", "| variant | verdict | gate | pass | blocking | detail |", "|---|---|---|---|---|---|");
  for (const [role, x] of Object.entries(v.variants)) {
    for (const [g, gx] of Object.entries(x.gates)) {
      lines.push(`| ${role} | ${x.verdict} | ${g} | ${gx.pass ? "PASS" : "FAIL"} | ${gx.blocking ? "yes" : "no"} | `
        + `${gx.detail.join("; ")} |`);
    }
  }
  lines.push("", `result: ${v.result} (operator step variant ${v.pmStep === null ? "-" : v.pmStep})`);
  return lines.join("\n");
}

function main(argv, io = {}) {
  const out = io.out || ((s) => process.stdout.write(`${s}\n`));
  const err = io.err || ((s) => process.stderr.write(`${s}\n`));
  let args;
  try {
    args = parseArgs(argv);
    for (const v of args.variants) S.segmentsOf(v.dir);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    err(`battleshipReport: ${e.message} (${USAGE})`);
    return 1;
  }
  const summaries = {};
  const results = [];
  for (const v of args.variants) {
    let summary;
    try {
      summary = readVariant(v.dir, { Database: io.Database });
    } catch (e) {
      err(`battleshipReport: ${v.name}: read failed - ${(e && e.message) || e}`);
      return 2;
    }
    if (!summary.ok) {
      err(`battleshipReport: ${v.name}: ${summary.reason} ${summary.detail || ""}`.trim());
      return 2;
    }
    summaries[v.name] = summary;
    results.push({ name: v.name, summary });
  }
  const verdictValue = verdict(summaries, args.roles);
  out(markdown({ results, verdict: verdictValue }));
  if (args.json) {
    fs.mkdirSync(path.dirname(args.json), { recursive: true });
    fs.writeFileSync(args.json, `${JSON.stringify({ roles: args.roles, thresholds: THRESHOLDS,
      variants: Object.fromEntries(results.map((x) => [x.name, x.summary])), verdict: verdictValue }, null, 2)}\n`);
  }
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { summarize, verdict, nativeBattleshipFactions, readVariant, parseArgs, main, markdown, THRESHOLDS };
