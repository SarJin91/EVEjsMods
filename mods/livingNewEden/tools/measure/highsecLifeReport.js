#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { CIVILIAN_METRICS, CHATTER_METRICS, TRAFFIC_METRICS, GANK_METRICS } = require("../../lib/highsecLife/schema");

const STATUS_FILE = "status.json";
const TELEMETRY_FILE = "telemetry.json";
const LOG_FILE = "log.txt";
const CHANNEL = "highsecLife";
const SERVICE = "highsecLife";
const DEFAULT_HOURS = 24;
const DEFAULT_PRESENCE_MIN = 60;

const RUNNING_RE = /highsecLife: running - (\d+) systems, civilians ensured (\d+), linked (\d+), refused (\d+), failed (\d+)/;
const OFF_RE = /highsecLife: (traffic|chatter|gank) off - (.*)$/;

const short = (name) => name.slice(CHANNEL.length + 1);
const GAUGE_NAMES = Object.freeze([short(CIVILIAN_METRICS.wanted), short(CIVILIAN_METRICS.assigned),
  short(TRAFFIC_METRICS.live)]);
const COUNTER_NAMES = Object.freeze([short(CIVILIAN_METRICS.shortfall), short(TRAFFIC_METRICS.spawned),
  short(TRAFFIC_METRICS.despawned), short(CHATTER_METRICS.lines), short(CHATTER_METRICS.rumours),
  short(CHATTER_METRICS.rateLimited), short(CHATTER_METRICS.sendFailed), short(GANK_METRICS.fields)]);
const HISTOGRAM_NAMES = Object.freeze([short(TRAFFIC_METRICS.passMs), short(CHATTER_METRICS.passMs),
  short(GANK_METRICS.passMs)]);

const FLAG_KEYS = Object.freeze(["localPilots.enabled", "highsecLife.enabled", "highsecLife.civilians.enabled",
  "highsecLife.traffic.enabled", "highsecLife.chatter.enabled", "highsecLife.gank.enabled"]);

const PHASE_FLAGS = Object.freeze({
  base: Object.freeze({ "highsecLife.enabled": false, "highsecLife.civilians.enabled": false,
    "highsecLife.traffic.enabled": false, "highsecLife.chatter.enabled": false, "highsecLife.gank.enabled": false }),
  h1: Object.freeze({ "localPilots.enabled": true, "highsecLife.enabled": true, "highsecLife.civilians.enabled": true,
    "highsecLife.traffic.enabled": true, "highsecLife.chatter.enabled": false, "highsecLife.gank.enabled": false }),
  h2: Object.freeze({ "localPilots.enabled": true, "highsecLife.enabled": true, "highsecLife.civilians.enabled": true,
    "highsecLife.traffic.enabled": true, "highsecLife.chatter.enabled": true, "highsecLife.gank.enabled": false }),
  h3: Object.freeze({ "localPilots.enabled": true, "highsecLife.enabled": true, "highsecLife.civilians.enabled": true,
    "highsecLife.traffic.enabled": true, "highsecLife.chatter.enabled": true, "highsecLife.gank.enabled": true }),
});

const ROLE_GATES = Object.freeze({
  h1: Object.freeze(["HL0", "HL1", "HL2", "HL5"]),
  h2: Object.freeze(["HL0", "HL1", "HL2", "HL3", "HL5"]),
  h3: Object.freeze(["HL0", "HL1", "HL2", "HL3", "HL4", "HL5"]),
});

const THRESHOLDS = Object.freeze({
  minHours: 1,
  schedulerLateness: Object.freeze({ channel: "scheduler", name: "lateness" }),
  hl0: Object.freeze({ civilianCorpsDefault: 20, informativeSuffix: "(informative)",
    forbiddenWarnings: Object.freeze(["highsecLife", "localPilots.enabled without"]) }),
  hl1: Object.freeze({ minWanted: 1, assignedShare: 0.9 }),
  hl2: Object.freeze({ minSpawned: 3, passP95MaxMs: 5 }),
  hl3: Object.freeze({ minutesPerLine: 5, sendFailedMin: 2, sendFailedShare: 0.01, passP95MaxMs: 5 }),
  hl4: Object.freeze({ minHours: 20, minPerDay: 1, maxPerDay: 14, passP95MaxMs: 5 }),
  hl5: Object.freeze({ latenessFactor: 1.25, latenessSlackMs: 2000 }),
});

const USAGE = "usage: node mods/livingNewEden/tools/measure/highsecLifeReport.js --phase <name>=<dir> [--phase ...] "
  + "[--hours <name>=H] [--presence-min <name>=N] --base <name> --phase-name <name> --role h1|h2|h3 [--json <file>]";

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

function getPath(obj, key) {
  let cur = obj;
  for (const part of key.split(".")) {
    if (!isObject(cur) || !Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function statusBody(raw) {
  if (isObject(raw) && isObject(raw.data) && !isObject(raw.config)) return raw.data;
  return isObject(raw) ? raw : null;
}

function snapshotBody(raw) {
  let body = raw;
  if (isObject(body) && isObject(body.data) && !isObject(body.channels)
    && !Object.prototype.hasOwnProperty.call(body, "available")) body = body.data;
  if (isObject(body) && Object.prototype.hasOwnProperty.call(body, "available")) {
    return body.available === true && isObject(body.snapshot) ? body.snapshot : null;
  }
  return isObject(body) && isObject(body.channels) ? body : null;
}

function parseLog(text) {
  const out = { runningLine: null, logFailures: { traffic: 0, gank: 0, chatter: 0, off: [] } };
  for (const line of String(text || "").split(/\r?\n/)) {
    const running = RUNNING_RE.exec(line);
    if (running) {
      out.runningLine = { systems: Number(running[1]), ensured: Number(running[2]), linked: Number(running[3]),
        refused: Number(running[4]), failed: Number(running[5]) };
      continue;
    }
    const off = OFF_RE.exec(line);
    if (off) {
      out.logFailures.off.push(`${off[1]}: ${off[2].trim()}`);
      continue;
    }
    if (line.includes("highsecLife: traffic ") && line.includes(" failed")) out.logFailures.traffic += 1;
    else if (line.includes("highsecLife: gank ") && line.includes(" failed")) out.logFailures.gank += 1;
    else if (line.includes("highsecLife: chatter") && line.includes("failed")) out.logFailures.chatter += 1;
  }
  return out;
}

function summarize(input, thresholds = THRESHOLDS) {
  const T = thresholds;
  const src = isObject(input) ? input : {};
  const status = statusBody(src.status);
  const values = status && isObject(status.config) && isObject(status.config.values) ? status.config.values : null;
  const flags = {};
  for (const key of FLAG_KEYS) {
    const v = values ? getPath(values, key) : undefined;
    flags[key] = typeof v === "boolean" ? v : null;
  }
  const setting = (key) => {
    const v = values ? getPath(values, key) : undefined;
    return isNum(v) ? v : null;
  };
  const services = status && isObject(status.services) && Array.isArray(status.services.services)
    ? status.services.services : [];
  const service = services.find((s) => isObject(s) && s.name === SERVICE);
  const warnings = status && isObject(status.config) && Array.isArray(status.config.warnings)
    ? status.config.warnings.map(String) : [];

  const snap = snapshotBody(src.telemetry);
  const channel = snap && isObject(snap.channels) && isObject(snap.channels[CHANNEL]) ? snap.channels[CHANNEL] : {};
  const counters = {};
  for (const name of COUNTER_NAMES) counters[name] = isNum(channel[name]) ? channel[name] : 0;
  const gauges = {};
  for (const name of GAUGE_NAMES) if (isNum(channel[name])) gauges[name] = channel[name];
  const histogramsP95 = {};
  for (const name of HISTOGRAM_NAMES) {
    const h = channel[name];
    if (isObject(h) && isNum(h.p95) && isNum(h.samples) && h.samples > 0) histogramsP95[name] = h.p95;
  }
  const L = T.schedulerLateness;
  const late = snap && isObject(snap.channels) && isObject(snap.channels[L.channel])
    ? snap.channels[L.channel][L.name] : undefined;
  const tx = snap && isObject(snap.persistence) && isObject(snap.persistence.tx) ? snap.persistence.tx : {};

  return {
    name: typeof src.name === "string" ? src.name : "",
    overall: status && typeof status.overall === "string" ? status.overall : null,
    serviceState: service && typeof service.state === "string" ? service.state : null,
    flags,
    configWarnings: warnings,
    counters,
    gauges,
    histogramsP95,
    schedulerLatenessP95: isObject(late) && isNum(late.p95) && isNum(late.samples) && late.samples > 0 ? late.p95 : null,
    txRowLimit: isNum(tx.TX_ROW_LIMIT) ? tx.TX_ROW_LIMIT : 0,
    ...parseLog(src.logText),
    hours: isNum(src.hours) ? src.hours : 0,
    presenceMin: isNum(src.presenceMin) ? src.presenceMin : 0,
    valuesPresent: values !== null,
    telemetryAvailable: snap !== null,
    settings: { civilianCorps: setting("highsecLife.civilianCorps"),
      maxShipsGlobal: setting("highsecLife.traffic.maxShipsGlobal"),
      maxLinesPerMinute: setting("highsecLife.chatter.maxLinesPerMinute") },
  };
}

function gate() {
  return { pass: true, blocking: true, detail: [] };
}

function fail(g, line) {
  g.pass = false;
  g.detail.push(`FAIL ${line}`);
}

function note(g, line) {
  g.detail.push(line);
}

const fmt = (v) => (isNum(v) ? String(Number(v.toFixed(3))) : "-");

function missingOf(s, role, T, label) {
  const out = [];
  if (!s) return [`${label}: no summary`];
  if (!s.valuesPresent) out.push(`${label}: no config.values in status.json`);
  if (!s.telemetryAvailable) out.push(`${label}: telemetry unavailable`);
  if (!(s.hours >= T.minHours)) out.push(`${label}: hours=${s.hours} < ${T.minHours}`);
  for (const key of Object.keys(PHASE_FLAGS[role])) {
    if (s.flags[key] === null || s.flags[key] === undefined) out.push(`${label}: no ${key} in config.values`);
  }
  if (role !== "base" && !(isNum(s.gauges.civiliansWanted) && s.gauges.civiliansWanted >= T.hl1.minWanted)) {
    out.push(`${label}: civiliansWanted=${fmt(s.gauges.civiliansWanted)} (the operator pilot was not in highsec at the snapshot)`);
  }
  return out;
}

function verdict(summaries, roles, thresholds = THRESHOLDS) {
  const T = thresholds;
  const role = roles && roles.role;
  if (!ROLE_GATES[role]) return { verdict: "INCOMPLETE", gates: {}, missing: [`role ${role} is not h1|h2|h3`] };
  const p = summaries && roles.phase ? summaries[roles.phase] : null;
  const b = summaries && roles.base ? summaries[roles.base] : null;
  const missing = [...missingOf(p, role, T, `phase ${roles.phase}`), ...missingOf(b, "base", T, `base ${roles.base}`)];
  if (missing.length > 0) return { verdict: "INCOMPLETE", gates: {}, missing };

  const gates = {};
  const want = ROLE_GATES[role];

  const hl0 = gate();
  if (p.overall === "refused") fail(hl0, "overall refused");
  if (p.serviceState !== "running") fail(hl0, `service ${SERVICE} state=${p.serviceState}`);
  for (const [key, v] of Object.entries(PHASE_FLAGS[role])) {
    if (p.flags[key] !== v) fail(hl0, `${key}=${p.flags[key]} (want ${v})`);
  }
  const badWarnings = p.configWarnings.filter((w) => T.hl0.forbiddenWarnings.some((f) => w.includes(f))
    && !w.trim().endsWith(T.hl0.informativeSuffix));
  for (const w of badWarnings) fail(hl0, `config warning: ${w}`);
  const corps = isNum(p.settings.civilianCorps) ? p.settings.civilianCorps : T.hl0.civilianCorpsDefault;
  const r = p.runningLine;
  if (!r) fail(hl0, "no line highsecLife: running - ... in log.txt");
  else {
    if (r.failed !== 0) fail(hl0, `running line failed=${r.failed}`);
    if (r.ensured + r.linked !== corps) fail(hl0, `ensured ${r.ensured} + linked ${r.linked} != civilianCorps ${corps}`);
    note(hl0, `running: ${r.systems} systems, ensured ${r.ensured}, linked ${r.linked}, refused ${r.refused}`);
  }
  const lf = p.logFailures;
  for (const k of ["traffic", "gank", "chatter"]) if (lf[k] !== 0) fail(hl0, `log ${k} failures=${lf[k]}`);
  for (const off of lf.off) fail(hl0, `off line: ${off}`);
  gates.HL0 = hl0;

  const hl1 = gate();
  const wanted = p.gauges.civiliansWanted;
  const assigned = isNum(p.gauges.civiliansAssigned) ? p.gauges.civiliansAssigned : 0;
  const line1 = `civiliansAssigned=${assigned} of civiliansWanted=${wanted} (>= ${T.hl1.assignedShare})`;
  if (assigned < T.hl1.assignedShare * wanted) fail(hl1, line1);
  else note(hl1, line1);
  note(hl1, `civiliansShortfall=${p.counters.civiliansShortfall}`);
  gates.HL1 = hl1;

  const hl2 = gate();
  const spawned = p.counters.trafficSpawned;
  const despawned = p.counters.trafficDespawned;
  if (spawned < T.hl2.minSpawned) fail(hl2, `trafficSpawned=${spawned} < ${T.hl2.minSpawned}`);
  else note(hl2, `trafficSpawned=${spawned}`);
  if (despawned > spawned) fail(hl2, `trafficDespawned=${despawned} > trafficSpawned=${spawned}`);
  else note(hl2, `trafficDespawned=${despawned}`);
  const live = isNum(p.gauges.trafficLive) ? p.gauges.trafficLive : 0;
  const maxGlobal = p.settings.maxShipsGlobal;
  if (!isNum(maxGlobal)) fail(hl2, "no highsecLife.traffic.maxShipsGlobal in config.values");
  else if (live > maxGlobal) fail(hl2, `trafficLive=${live} > maxShipsGlobal=${maxGlobal}`);
  else note(hl2, `trafficLive=${live} <= ${maxGlobal}`);
  passLimit(hl2, p, "trafficPassMs", T.hl2.passP95MaxMs);
  gates.HL2 = hl2;

  if (want.includes("HL3")) {
    const hl3 = gate();
    const lines = p.counters.chatterLines;
    const minLines = p.presenceMin / T.hl3.minutesPerLine;
    if (lines < minLines) fail(hl3, `chatterLines=${lines} < presenceMin ${p.presenceMin} / ${T.hl3.minutesPerLine}`);
    else note(hl3, `chatterLines=${lines} >= ${fmt(minLines)}`);
    const perMin = p.settings.maxLinesPerMinute;
    if (!isNum(perMin)) fail(hl3, "no highsecLife.chatter.maxLinesPerMinute in config.values");
    else if (lines > p.presenceMin * perMin) fail(hl3, `chatterLines=${lines} > ${p.presenceMin} x ${perMin}`);
    const sendFailed = p.counters.chatterSendFailed;
    const maxFailed = Math.max(T.hl3.sendFailedMin, T.hl3.sendFailedShare * lines);
    if (sendFailed > maxFailed) fail(hl3, `chatterSendFailed=${sendFailed} > ${fmt(maxFailed)}`);
    else note(hl3, `chatterSendFailed=${sendFailed} <= ${fmt(maxFailed)}`);
    passLimit(hl3, p, "chatterPassMs", T.hl3.passP95MaxMs);
    note(hl3, `chatterRumours=${p.counters.chatterRumours}, chatterRateLimited=${p.counters.chatterRateLimited}`);
    gates.HL3 = hl3;
  }

  if (want.includes("HL4")) {
    const hl4 = gate();
    if (p.hours < T.hl4.minHours) fail(hl4, `hours=${p.hours} < ${T.hl4.minHours}`);
    const perDay = p.hours > 0 ? (p.counters.gankFields * 24) / p.hours : 0;
    const line4 = `gankFields=${p.counters.gankFields} in ${p.hours} h = ${fmt(perDay)}/day `
      + `in [${T.hl4.minPerDay}, ${T.hl4.maxPerDay}]`;
    if (perDay < T.hl4.minPerDay || perDay > T.hl4.maxPerDay) fail(hl4, line4);
    else note(hl4, line4);
    passLimit(hl4, p, "gankPassMs", T.hl4.passP95MaxMs);
    gates.HL4 = hl4;
  }

  const hl5 = gate();
  for (const [key, v] of Object.entries(PHASE_FLAGS.base)) {
    if (b.flags[key] !== v) fail(hl5, `base ${key}=${b.flags[key]} (base must be H0, all off)`);
  }
  const limit = isNum(b.schedulerLatenessP95)
    ? T.hl5.latenessFactor * b.schedulerLatenessP95 + T.hl5.latenessSlackMs : null;
  const line5 = `scheduler lateness p95 phase=${fmt(p.schedulerLatenessP95)} <= ${fmt(limit)} `
    + `(base ${fmt(b.schedulerLatenessP95)})`;
  if (limit === null || !isNum(p.schedulerLatenessP95)) fail(hl5, `${line5} - no data`);
  else if (p.schedulerLatenessP95 > limit) fail(hl5, line5);
  else note(hl5, line5);
  if (p.txRowLimit > b.txRowLimit) fail(hl5, `TX_ROW_LIMIT phase=${p.txRowLimit} > base=${b.txRowLimit}`);
  else note(hl5, `TX_ROW_LIMIT phase=${p.txRowLimit} (base ${b.txRowLimit})`);
  gates.HL5 = hl5;

  const go = want.every((g) => gates[g] && gates[g].pass);
  return { verdict: go ? "GO" : "NO_GO", gates };
}

function passLimit(g, s, name, maxMs) {
  const v = s.histogramsP95[name];
  if (!isNum(v)) fail(g, `${name} p95 - no samples`);
  else if (v > maxMs) fail(g, `${name} p95=${fmt(v)} > ${maxMs} ms`);
  else note(g, `${name} p95=${fmt(v)}`);
}

class UsageError extends Error {}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function readPhase(dir, opts = {}) {
  const files = [STATUS_FILE, TELEMETRY_FILE, LOG_FILE].map((f) => path.join(dir, f));
  for (const f of files) if (!fs.existsSync(f)) return { ok: false, reason: "MISSING_FILE", detail: f };
  const parsed = {};
  for (const [key, f] of [["status", files[0]], ["telemetry", files[1]]]) {
    try {
      parsed[key] = readJson(f);
    } catch (e) {
      return { ok: false, reason: "PARSE_ERROR", detail: `${f}: ${(e && e.message) || e}` };
    }
  }
  return { ok: true, input: { name: opts.name || path.basename(dir),
    hours: isNum(opts.hours) ? opts.hours : DEFAULT_HOURS,
    presenceMin: isNum(opts.presenceMin) ? opts.presenceMin : DEFAULT_PRESENCE_MIN,
    status: parsed.status, telemetry: parsed.telemetry, logText: fs.readFileSync(files[2], "utf8") } };
}

function namedPair(flag, v, re) {
  const m = typeof v === "string" ? /^([A-Za-z0-9_-]+)=(.+)$/.exec(v) : null;
  if (!m || (re && !re.test(m[2]))) throw new UsageError(`${flag} needs <name>=<value>`);
  return [m[1], m[2]];
}

function parseArgs(argv) {
  const out = { phases: [], hours: {}, presenceMin: {}, base: null, phase: null, role: null, json: null };
  const NUM_RE = /^\d+(\.\d+)?$/;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--phase") {
      const [name, dir] = namedPair(a, v);
      if (out.phases.some((x) => x.name === name)) throw new UsageError(`--phase ${name} twice`);
      out.phases.push({ name, dir: path.resolve(dir) });
    } else if (a === "--hours") {
      const [name, h] = namedPair(a, v, NUM_RE);
      out.hours[name] = Number(h);
    } else if (a === "--presence-min") {
      const [name, n] = namedPair(a, v, NUM_RE);
      out.presenceMin[name] = Number(n);
    } else if (a === "--base" || a === "--phase-name" || a === "--role") {
      if (typeof v !== "string" || v === "") throw new UsageError(`${a} needs a value`);
      out[a === "--base" ? "base" : a === "--role" ? "role" : "phase"] = v;
    } else if (a === "--json") {
      if (typeof v !== "string" || v === "") throw new UsageError("--json needs a file");
      out.json = path.resolve(v);
    } else throw new UsageError(`unknown argument ${a}`);
    i += 1;
  }
  if (out.phases.length === 0) throw new UsageError("at least one --phase");
  for (const k of ["base", "phase", "role"]) if (!out[k]) throw new UsageError(`--${k === "phase" ? "phase-name" : k} is required`);
  if (!ROLE_GATES[out.role]) throw new UsageError(`--role ${out.role} is not h1|h2|h3`);
  for (const name of [out.base, out.phase]) {
    if (!out.phases.some((x) => x.name === name)) throw new UsageError(`${name} is not a --phase`);
  }
  for (const name of [...Object.keys(out.hours), ...Object.keys(out.presenceMin)]) {
    if (!out.phases.some((x) => x.name === name)) throw new UsageError(`${name} is not a --phase`);
  }
  return out;
}

const TABLE_HEAD = ["phase", "hours", "overall", "service", "warnings", "running e/l/r/f", "log fail t/g/c/off",
  "civ wanted/assigned", "traffic spawn/despawn/live", "chatter lines/rumours/sendFailed", "gank fields",
  "p95 traffic/chatter/gank", "lateness p95", "TX_ROW_LIMIT"];

function rowOf(s) {
  const r = s.runningLine;
  const c = s.counters;
  const h = s.histogramsP95;
  return [s.name, s.hours, s.overall || "-", s.serviceState || "-", s.configWarnings.filter((w) => w.includes("highsecLife")).length,
    r ? `${r.ensured}/${r.linked}/${r.refused}/${r.failed}` : "-",
    `${s.logFailures.traffic}/${s.logFailures.gank}/${s.logFailures.chatter}/${s.logFailures.off.length}`,
    `${fmt(s.gauges.civiliansWanted)}/${fmt(s.gauges.civiliansAssigned)}`,
    `${c.trafficSpawned}/${c.trafficDespawned}/${fmt(s.gauges.trafficLive)}`,
    `${c.chatterLines}/${c.chatterRumours}/${c.chatterSendFailed}`, c.gankFields,
    `${fmt(h.trafficPassMs)}/${fmt(h.chatterPassMs)}/${fmt(h.gankPassMs)}`, fmt(s.schedulerLatenessP95), s.txRowLimit];
}

function markdown(r) {
  const lines = [`| ${TABLE_HEAD.join(" | ")} |`, `|${TABLE_HEAD.map(() => "---").join("|")}|`];
  for (const x of r.results) lines.push(`| ${rowOf(x.summary).join(" | ")} |`);
  lines.push("", `${r.title}: ${r.verdict.verdict}`);
  if (Array.isArray(r.verdict.missing) && r.verdict.missing.length > 0) {
    lines.push("", ...r.verdict.missing.map((m) => `- missing: ${m}`));
  }
  const gates = Object.entries(r.verdict.gates || {});
  if (gates.length > 0) {
    lines.push("", "| gate | pass | blocking | detail |", "|---|---|---|---|");
    for (const [g, v] of gates) lines.push(`| ${g} | ${v.pass ? "PASS" : "FAIL"} | ${v.blocking ? "yes" : "no"} | ${v.detail.join("; ")} |`);
  }
  return lines.join("\n");
}

function main(argv, io = {}) {
  const out = io.out || ((s) => process.stdout.write(`${s}\n`));
  const err = io.err || ((s) => process.stderr.write(`${s}\n`));
  let args;
  try {
    args = parseArgs(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    err(`highsecLifeReport: ${e.message} (${USAGE})`);
    return 1;
  }
  const summaries = {};
  const results = [];
  for (const ph of args.phases) {
    const read = readPhase(ph.dir, { name: ph.name, hours: args.hours[ph.name], presenceMin: args.presenceMin[ph.name] });
    if (!read.ok) {
      err(`highsecLifeReport: ${ph.name}: ${read.reason} ${read.detail}`);
      return read.reason === "MISSING_FILE" ? 1 : 2;
    }
    const summary = summarize(read.input);
    summaries[ph.name] = summary;
    results.push({ name: ph.name, summary });
  }
  const roles = { base: args.base, phase: args.phase, role: args.role };
  const v = verdict(summaries, roles);
  const title = `verdict ${args.phase} (role ${args.role}, base ${args.base})`;
  out(markdown({ results, title, verdict: v }));
  if (args.json) {
    fs.mkdirSync(path.dirname(args.json), { recursive: true });
    fs.writeFileSync(args.json, `${JSON.stringify({ roles, thresholds: THRESHOLDS,
      phases: Object.fromEntries(results.map((x) => [x.name, x.summary])), verdict: v }, null, 2)}\n`);
  }
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { summarize, verdict, readPhase, parseArgs, main, markdown, THRESHOLDS, PHASE_FLAGS };
