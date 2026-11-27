#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_FORTRESS_ID = 30100000;
const DEFAULT_HALT_MEMORY_MS = 86400000;
const DB_FILE = "world.sqlite";
const SEGMENT_REPORT_RE = /^seg(\d+)\.report\.json$/;
const AVG_DECIMALS = 3;
const LOG_ERROR_RE = / error|TX_FAILED/;
const LOG_ROW_LIMIT_RE = /TX_ROW_LIMIT/;
const LOG_ROW_BOUND_RE = /FORTRESS_ROW_BOUND/;
const LOG_ROW_WARNING_RE = /one strategy review may write/;
const LOG_SERVICES_RE = /^services:.*\bfortress=(\S+)/;

const THRESHOLDS = Object.freeze({
  f1: Object.freeze({ logErrorsSlack: 2, runningState: "running" }),
  f2: Object.freeze({ maxRatio: 0.30 }),
  f3: Object.freeze({ tooFarRel: 0.05, plansRel: 0.005 }),
  f4: Object.freeze({ maxHaltsOneFleet: 2 }),
  f5: Object.freeze({ passFactor: 1.25, passSlackMs: 2, routeSearchP95MaxMs: 1.0 }),
  borderlineRel: 0.10,
  borderlineSeed: 8,
  exemptShare: 0.50,
  replanPerDay: 1,
  batteries: Object.freeze({ minHalts: 5, grindShare: 0.80 }),
  aversion: Object.freeze({ minShare: 0.20, minLegDelta: 0.2 }),
});

const CALIBRATION = Object.freeze({
  1: Object.freeze({ "fortress.interceptChancePermille": 900, "fortress.haltMemoryMs": 259200000 }),
  3: Object.freeze({ "fortress.haltMemoryDetourMaxJumps": 40 }),
  "1+3": Object.freeze({ "fortress.interceptChancePermille": 900, "fortress.haltMemoryDetourMaxJumps": 40 }),
});
const CALIBRATION_RULE_4 = Object.freeze({ "fortress.routeDetourMaxJumps": 12 });

const COUNTERS = Object.freeze([
  ["graph.routeAversionApplied", "graph", "routeAversionApplied"],
  ["graph.routeAversionKept", "graph", "routeAversionKept"],
  ["graph.routeAversionChecks", "graph", "routeAversionChecks"],
  ["fortress.halts", "fortress", "halts"],
  ["fortress.passed", "fortress", "passed"],
  ["fortress.stale", "fortress", "stale"],
  ["fortress.observedPass", "fortress", "observedPass"],
  ["fortress.budgetPass", "fortress", "budgetPass"],
  ["fortress.memoryWrites", "fortress", "memoryWrites"],
  ["fortress.avoidAdvised", "fortress", "avoidAdvised"],
  ["travel.routeAdvised", "fleets", "travel.routeAdvised"],
  ["travel.routeAdviceRefused", "fleets", "travel.routeAdviceRefused"],
  ["travel.routeAdviceRefusedTooFar", "fleets", "travel.routeAdviceRefusedTooFar"],
  ["travel.routeAdviceRefusedNoPath", "fleets", "travel.routeAdviceRefusedNoPath"],
  ["travel.routeAdviceRefusedNoPathTooFar", "fleets", "travel.routeAdviceRefusedNoPathTooFar"],
  ["travel.routeTooFar", "fleets", "travel.routeTooFar"],
  ["travel.routeUnreachable", "fleets", "travel.routeUnreachable"],
  ["travel.replanAdviceHalted", "fleets", "travel.replanAdviceHalted"],
  ["travel.wormholeHalted", "fleets", "travel.wormholeHalted"],
]);
const HISTOGRAMS = Object.freeze([["graph.routeSearchMs.p95", "graph", "routeSearchMs", "p95"]]);
const ROLE_PREFIX = "travel.adviceRefused_";

const USAGE = "usage: node mods/livingNewEden/tools/measure/fortressReport.js --variant <name>=<dir> "
  + "[--variant <name>=<dir> ...] [--fortress <systemId>] [--halt-memory-ms <ms>] [--base <name> --on <name> "
  + "[--route <name>] [--full <name>] [--ctl <name>]] [--json <file>]";

function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function bumpMap(map, key, n = 1) {
  const k = String(key);
  map[k] = (map[k] || 0) + n;
}

function addMaps(into, from) {
  for (const [k, v] of Object.entries(from || {})) bumpMap(into, k, v);
}

function median(values) {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function round(v) {
  return v === null ? null : Number(v.toFixed(AVG_DECIMALS));
}

function strictSum(values) {
  let out = 0;
  for (const v of values) {
    if (!isNum(v)) return null;
    out += v;
  }
  return out;
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

function telemetryOf(telemetry) {
  const ch = channelsOf(telemetry);
  const out = {};
  for (const [key, channel, name] of COUNTERS) {
    const has = Boolean(ch && ch[channel] && typeof ch[channel] === "object");
    const v = has ? ch[channel][name] : undefined;
    out[key] = !has ? null : (isNum(v) ? v : 0);
  }
  for (const [key, channel, name, field] of HISTOGRAMS) {
    const h = ch && ch[channel] ? ch[channel][name] : undefined;
    out[key] = h && typeof h === "object" && isNum(h[field]) ? h[field] : null;
  }
  let roles = null;
  const fleets = ch && ch.fleets && typeof ch.fleets === "object" ? ch.fleets : null;
  if (fleets) {
    for (const [name, v] of Object.entries(fleets)) {
      if (!name.startsWith(ROLE_PREFIX) || !isNum(v)) continue;
      if (roles === null) roles = {};
      roles[name.slice(ROLE_PREFIX.length)] = v;
    }
  }
  out.adviceRefusedByRole = roles;
  out.tooFarTotal = strictSum([out["travel.routeTooFar"], out["travel.routeAdviceRefusedTooFar"],
    out["travel.routeAdviceRefusedNoPathTooFar"]]);
  return out;
}

function statusOf(records) {
  const pick = (field) => (Array.isArray(records) ? records : [])
    .map((r) => (r && r.scheduler && typeof r.scheduler === "object" ? r.scheduler[field] : undefined))
    .filter(isNum);
  const agg = (vals) => (vals.length === 0 ? null : { max: Math.max(...vals), median: median(vals) });
  return { latenessP95Ms: agg(pick("latenessP95Ms")), passP95Ms: agg(pick("passP95Ms")) };
}

function segmentExitOk(d) {
  if (!d.report || typeof d.report !== "object" || Object.prototype.hasOwnProperty.call(d.report, "error")) return false;
  return d.exitCode === undefined || d.exitCode === null || d.exitCode === 0;
}

const LOG_FIELDS = Object.freeze(["logErrors", "logRowLimit", "rowBoundRefusals", "rowWarnings"]);
const CHECK_FIELDS = Object.freeze(["runs", "pass", "fail", "error"]);

function checksOf(report) {
  const c = report && report.checks && typeof report.checks === "object" ? report.checks : {};
  return Object.fromEntries(CHECK_FIELDS.map((k) => [k, isNum(c[k]) ? c[k] : 0]));
}

function emptyDay(d) {
  const day = { index: d.index, startVirtualAt: d.startVirtualAt, stopVirtualAt: d.stopVirtualAt,
    plans: 0, retreats: 0, legJumps: 0, avgLegJumps: null,
    crossings: 0, crossingsWh: 0, crossingsRetreat: 0, byFaction: {}, byRole: {}, fleetsCrossing: 0,
    halts: 0, fleetsHalted: 0, maxHaltsOneFleet: 0, repeatHaltsSameFaction: 0,
    battles: 0, shipsLost: 0, shipsInput: 0, outcomes: {},
    convoysEndedBy: {}, expeditionsCutOff: 0 };
  for (const k of LOG_FIELDS) day[k] = isNum(d[k]) ? d[k] : 0;
  day.fortressState = typeof d.fortressState === "string" ? d.fortressState : null;
  day.exitCode = isNum(d.exitCode) ? d.exitCode : null;
  day.exitOk = segmentExitOk(d);
  day.checks = checksOf(d.report);
  return day;
}

function inside(systems, fortressId) {
  if (!Array.isArray(systems)) return false;
  for (let i = 1; i < systems.length - 1; i += 1) if (Number(systems[i]) === fortressId) return true;
  return false;
}

function summarize(input, opts) {
  if (!input || typeof input !== "object" || !Array.isArray(input.days)) {
    return { ok: false, reason: "INVALID_INPUT", detail: "days" };
  }
  const fortressId = opts && Number.isSafeInteger(opts.fortressId) && opts.fortressId > 0 ? opts.fortressId : null;
  const haltMemoryMs = opts && Number.isSafeInteger(opts.haltMemoryMs) && opts.haltMemoryMs >= 0
    ? opts.haltMemoryMs : null;
  if (fortressId === null) return { ok: false, reason: "INVALID_INPUT", detail: "fortressId" };
  if (haltMemoryMs === null) return { ok: false, reason: "INVALID_INPUT", detail: "haltMemoryMs" };
  const segs = [...input.days].sort((a, b) => a.index - b.index);
  for (const d of segs) {
    if (!Number.isSafeInteger(d.index) || !isNum(d.startVirtualAt) || !isNum(d.stopVirtualAt)
      || d.stopVirtualAt < d.startVirtualAt) {
      return { ok: false, reason: "INVALID_INPUT", detail: `day ${d && d.index}` };
    }
  }
  const days = segs.map(emptyDay);
  let outside = 0;
  const dayOf = (t) => {
    if (!isNum(t)) return null;
    for (let i = 0; i < segs.length; i += 1) if (segs[i].startVirtualAt <= t && t < segs[i].stopVirtualAt) return days[i];
    return null;
  };
  const crossingFleets = days.map(() => new Set());
  const allCrossingFleets = new Set();
  for (const t of input.transitions || []) {
    const day = dayOf(t.createdAt);
    if (!day) {
      outside += 1;
      continue;
    }
    const through = inside(t.systems, fortressId);
    if (t.to === "RETREATING") {
      day.retreats += 1;
      if (through) day.crossingsRetreat += 1;
      continue;
    }
    if (t.to !== "TRAVELLING") continue;
    day.plans += 1;
    day.legJumps += Array.isArray(t.systems) && t.systems.length > 0 ? t.systems.length - 1 : 0;
    if (!through) continue;
    day.crossings += 1;
    if (t.wormhole === true) day.crossingsWh += 1;
    bumpMap(day.byFaction, t.factionId === null || t.factionId === undefined ? "unknown" : t.factionId);
    bumpMap(day.byRole, t.fleetRole || "unknown");
    crossingFleets[days.indexOf(day)].add(t.fleetId);
    allCrossingFleets.add(t.fleetId);
  }
  const halts = [...(input.halts || [])].sort((a, b) => a.createdAt - b.createdAt);
  const lastHaltOf = new Map();
  const haltsPerFleet = days.map(() => new Map());
  const allHaltsPerFleet = new Map();
  for (const h of halts) {
    const day = dayOf(h.createdAt);
    if (!day) {
      outside += 1;
      continue;
    }
    day.halts += 1;
    const per = haltsPerFleet[days.indexOf(day)];
    per.set(h.fleetId, (per.get(h.fleetId) || 0) + 1);
    allHaltsPerFleet.set(h.fleetId, (allHaltsPerFleet.get(h.fleetId) || 0) + 1);
    if (h.factionId !== null && h.factionId !== undefined) {
      const prev = lastHaltOf.get(h.factionId);
      if (prev !== undefined && h.createdAt - prev < haltMemoryMs) day.repeatHaltsSameFaction += 1;
      lastHaltOf.set(h.factionId, h.createdAt);
    }
  }
  for (const b of input.battles || []) {
    const day = dayOf(b.createdAt);
    if (!day) {
      outside += 1;
      continue;
    }
    day.battles += 1;
    day.shipsLost += isNum(b.shipsLost) ? b.shipsLost : 0;
    day.shipsInput += isNum(b.shipsInput) ? b.shipsInput : 0;
    bumpMap(day.outcomes, b.outcome || "null");
  }
  for (const c of input.convoysEnded || []) {
    const day = dayOf(c.endedAt);
    if (!day) {
      outside += 1;
      continue;
    }
    bumpMap(day.convoysEndedBy, c.endReason || "null");
  }
  for (const e of input.expeditionsCutOff || []) {
    const day = dayOf(e.cutOffAt);
    if (!day) {
      outside += 1;
      continue;
    }
    day.expeditionsCutOff += 1;
  }
  days.forEach((day, i) => {
    day.avgLegJumps = day.plans > 0 ? round(day.legJumps / day.plans) : null;
    day.fleetsCrossing = crossingFleets[i].size;
    day.fleetsHalted = haltsPerFleet[i].size;
    day.maxHaltsOneFleet = maxOf([...haltsPerFleet[i].values()]) || 0;
    Object.assign(day, { telemetry: telemetryOf(segs[i].telemetry) }, statusOf(segs[i].status));
  });

  const sum = (k) => days.reduce((s, d) => s + d[k], 0);
  const total = { days: days.length, plans: sum("plans"), retreats: sum("retreats"), legJumps: sum("legJumps"),
    avgLegJumps: null, crossings: sum("crossings"), crossingsWh: sum("crossingsWh"),
    crossingsRetreat: sum("crossingsRetreat"), byFaction: {}, byRole: {}, fleetsCrossing: allCrossingFleets.size,
    halts: sum("halts"), fleetsHalted: allHaltsPerFleet.size, maxHaltsOneFleet: maxOf([...allHaltsPerFleet.values()]) || 0,
    repeatHaltsSameFaction: sum("repeatHaltsSameFaction"), battles: sum("battles"), shipsLost: sum("shipsLost"),
    shipsInput: sum("shipsInput"), outcomes: {}, convoysEndedBy: {}, expeditionsCutOff: sum("expeditionsCutOff"),
    telemetry: {}, latenessP95Ms: null, passP95Ms: null, outside,
    memoryRows: isNum(input.memoryRows) ? input.memoryRows : null };
  total.avgLegJumps = total.plans > 0 ? round(total.legJumps / total.plans) : null;
  for (const d of days) {
    addMaps(total.byFaction, d.byFaction);
    addMaps(total.byRole, d.byRole);
    addMaps(total.outcomes, d.outcomes);
    addMaps(total.convoysEndedBy, d.convoysEndedBy);
  }
  for (const [key] of COUNTERS) total.telemetry[key] = strictSum(days.map((d) => d.telemetry[key]));
  for (const [key] of HISTOGRAMS) total.telemetry[key] = maxOf(days.map((d) => d.telemetry[key]));
  total.telemetry.tooFarTotal = strictSum(days.map((d) => d.telemetry.tooFarTotal));
  const roleDays = days.map((d) => d.telemetry.adviceRefusedByRole);
  if (roleDays.length > 0 && roleDays.every((r) => r !== null)) {
    total.telemetry.adviceRefusedByRole = {};
    for (const r of roleDays) addMaps(total.telemetry.adviceRefusedByRole, r);
  } else total.telemetry.adviceRefusedByRole = null;
  for (const k of ["latenessP95Ms", "passP95Ms"]) {
    const maxes = days.map((d) => (d[k] ? d[k].max : null));
    const medians = days.map((d) => (d[k] ? d[k].median : null)).filter(isNum);
    total[k] = maxOf(maxes) === null ? null : { max: maxOf(maxes), median: median(medians) };
  }
  for (const k of LOG_FIELDS) total[k] = sum(k);
  total.checks = Object.fromEntries(CHECK_FIELDS.map((k) => [k, days.reduce((s, d) => s + d.checks[k], 0)]));
  total.exitOk = days.length > 0 && days.every((d, i) => d.index === i + 1 && d.exitOk);
  total.fortressStates = [...new Set(days.map((d) => d.fortressState).filter((s) => s !== null))].sort();
  return { ok: true, days, total };
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

const num3 = (v) => (isNum(v) ? String(Number(v.toFixed(AVG_DECIMALS))) : "-");
const telOf = (s, key) => (s.total.telemetry && isNum(s.total.telemetry[key]) ? s.total.telemetry[key] : null);

function nearLimit(value, limit, rel) {
  return isNum(value) && isNum(limit) && limit !== 0 && Math.abs(value - limit) <= rel * Math.abs(limit);
}

function verdict(results, roles, thresholds = THRESHOLDS) {
  const T = thresholds;
  const pick = (role) => (roles && typeof roles[role] === "string" && results && results[roles[role]]
    && results[roles[role]].ok === true && results[roles[role]].total ? results[roles[role]] : null);
  const base = pick("base");
  const on = pick("on");
  if (!base || !on) return { ok: false, reason: "INVALID_INPUT", detail: `roles base/on: ${JSON.stringify(roles)}` };
  const route = pick("route");
  const full = pick("full");
  const named = [["base", base], ["on", on], ["route", route], ["full", full]].filter(([, s]) => s !== null);
  const label = (role) => `${role}=${roles[role]}`;
  const b = base.total;
  const o = on.total;
  const notes = [];

  const f1 = gate(true);
  for (const [role, s] of named) {
    const t = s.total;
    if (!t.exitOk) fail(f1, `${label(role)} exitOk false (a segment without report, with report.error or exit != 0)`);
    if (t.checks.fail !== 0 || t.checks.error !== 0) {
      fail(f1, `${label(role)} checks fail=${t.checks.fail} error=${t.checks.error}`);
    }
    if (t.rowBoundRefusals !== 0) fail(f1, `${label(role)} FORTRESS_ROW_BOUND lines=${t.rowBoundRefusals}`);
    if (t.rowWarnings !== 0) fail(f1, `${label(role)} "one strategy review may write" lines=${t.rowWarnings}`);
  }
  for (const [role, s] of [["full", full], ["on", on]]) {
    if (!s) continue;
    const states = s.total.fortressStates;
    if (states.length !== 1 || states[0] !== T.f1.runningState) {
      fail(f1, `${label(role)} fortress states ${JSON.stringify(states)} != ["${T.f1.runningState}"]`);
    }
  }
  if (o.logRowLimit > b.logRowLimit) fail(f1, `logRowLimit on=${o.logRowLimit} > base=${b.logRowLimit}`);
  if (o.logErrors > b.logErrors + T.f1.logErrorsSlack) {
    fail(f1, `logErrors on=${o.logErrors} > base=${b.logErrors} + ${T.f1.logErrorsSlack}`);
  }
  note(f1, `checks runs/pass/fail/error on ${o.checks.runs}/${o.checks.pass}/${o.checks.fail}/${o.checks.error}; `
    + `logErrors ${o.logErrors} (base ${b.logErrors}); logRowLimit ${o.logRowLimit} (base ${b.logRowLimit}); `
    + `fortress states on ${JSON.stringify(o.fortressStates)}`);

  const f2 = gate(true);
  const R = b.crossings > 0 ? o.crossings / b.crossings : null;
  if (R === null) fail(f2, "base crossings=0 (no ratio)");
  else if (R > T.f2.maxRatio) fail(f2, `R=${o.crossings}/${b.crossings}=${num3(R)} > ${T.f2.maxRatio}`);
  else note(f2, `R=${o.crossings}/${b.crossings}=${num3(R)} <= ${T.f2.maxRatio}`);

  const f3 = gate(true);
  const tfOn = telOf(on, "tooFarTotal");
  const tfOff = telOf(base, "tooFarTotal");
  let dTF = null;
  let tfLimit = null;
  if (tfOn === null || tfOff === null) fail(f3, `tooFarTotal on=${num3(tfOn)} off=${num3(tfOff)} - no data`);
  else {
    dTF = tfOn - tfOff;
    tfLimit = Math.max(T.f3.tooFarRel * tfOff, T.f3.plansRel * b.plans);
    const line = `dTF=${tfOn}-${tfOff}=${dTF} <= max(${T.f3.tooFarRel} x ${tfOff}, ${T.f3.plansRel} x ${b.plans})`
      + `=${num3(tfLimit)}`;
    if (dTF > tfLimit) fail(f3, line);
    else note(f3, line);
  }

  const f4 = gate(true);
  if (o.maxHaltsOneFleet > T.f4.maxHaltsOneFleet) {
    fail(f4, `maxHaltsOneFleet on=${o.maxHaltsOneFleet} > ${T.f4.maxHaltsOneFleet}`);
  } else note(f4, `maxHaltsOneFleet on=${o.maxHaltsOneFleet} <= ${T.f4.maxHaltsOneFleet}`);
  if (o.repeatHaltsSameFaction > o.days) fail(f4, `repeatHaltsSameFaction on=${o.repeatHaltsSameFaction} > days=${o.days}`);
  else note(f4, `repeatHaltsSameFaction on=${o.repeatHaltsSameFaction} <= days=${o.days}`);

  const f5 = gate(true);
  const passOn = o.passP95Ms ? o.passP95Ms.median : null;
  const passOff = b.passP95Ms ? b.passP95Ms.median : null;
  const passLimit = isNum(passOff) ? T.f5.passFactor * passOff + T.f5.passSlackMs : null;
  const passLine = `passP95 median on=${num3(passOn)} <= ${num3(passLimit)} (base ${num3(passOff)})`;
  if (!isNum(passOn) || passLimit === null) fail(f5, `${passLine} - no data`);
  else if (passOn > passLimit) fail(f5, passLine);
  else note(f5, passLine);
  const search = telOf(on, "graph.routeSearchMs.p95");
  if (search !== null && search > T.f5.routeSearchP95MaxMs) {
    fail(f5, `graph.routeSearchMs.p95 max on=${num3(search)} > ${T.f5.routeSearchP95MaxMs} ms`);
  } else note(f5, `graph.routeSearchMs.p95 max on=${num3(search)} <= ${T.f5.routeSearchP95MaxMs} ms`);

  for (const [role, s] of [["route", route], ["full", full]]) {
    if (!s) continue;
    notes.push(`${label(role)}: crossings ${s.total.crossings} (R ${b.crossings > 0 ? num3(s.total.crossings / b.crossings)
      : "-"}), avgLegJumps ${num3(s.total.avgLegJumps)} (base ${num3(b.avgLegJumps)}), halts ${s.total.halts}`);
  }
  const replan = telOf(on, "travel.replanAdviceHalted");
  const replanPerDay = replan !== null && o.days > 0 ? replan / o.days : null;
  if (replanPerDay !== null && replanPerDay >= T.replanPerDay) {
    notes.push(`SWEEP: replanAdviceHalted ${replan} = ${num3(replanPerDay)}/day >= ${T.replanPerDay} - `
      + "propose a NOTE task");
  } else notes.push(`SWEEP: replanAdviceHalted ${num3(replan)} (${num3(replanPerDay)}/day) - accepted`);
  const budgetPass = telOf(on, "fortress.budgetPass");
  notes.push(`budgetPass ${num3(budgetPass)} ${budgetPass !== null && budgetPass > o.halts ? ">" : "<="} halts `
    + `${o.halts}${budgetPass !== null && budgetPass > o.halts ? " - propose maxCheckpointsPerTransaction=2" : ""}`);
  if (o.halts >= T.batteries.minHalts && o.shipsLost === 0) {
    notes.push(`batteries (rule 5): shipsLost 0 at ${o.halts} HALT - propose fortress.batteryDps x2`);
  } else if (o.shipsInput > 0 && o.shipsLost > T.batteries.grindShare * o.shipsInput) {
    notes.push(`batteries (rule 5): shipsLost ${o.shipsLost} > ${T.batteries.grindShare} x ${o.shipsInput} - `
      + "propose fortress.batteryDps / 2");
  } else notes.push(`batteries: shipsLost/ships ${o.shipsLost}/${o.shipsInput} at ${o.halts} HALT - no change`);
  notes.push(`routeAdviceRefusedNoPath on=${num3(telOf(on, "travel.routeAdviceRefusedNoPath"))} `
    + `base=${num3(telOf(base, "travel.routeAdviceRefusedNoPath"))}`);
  const borderline = (R !== null && nearLimit(R, T.f2.maxRatio, T.borderlineRel))
    || (dTF !== null && nearLimit(dTF, tfLimit, T.borderlineRel));
  if (borderline) notes.push(`borderline (R or dTF within ${T.borderlineRel * 100}% of the limit) - propose a second run `
    + `with --seed ${T.borderlineSeed}`);

  const gates = { F1: f1, F2: f2, F3: f3, F4: f4, F5: f5 };
  const go = Object.values(gates).every((g) => g.pass || !g.blocking);
  let calibration = null;
  const isCtl = typeof roles.ctl === "string" && roles.ctl === roles.on;
  if (!go && f1.pass && (!f2.pass || !f3.pass)) {
    const exemptShare = o.crossings > 0 ? (o.crossingsWh + o.crossingsRetreat) / o.crossings : 0;
    const rule1 = !f2.pass && R !== null && exemptShare < T.exemptShare;
    if (!f2.pass && R !== null && !rule1) {
      notes.push(`Rule 2: wormhole + retreat crossings ${o.crossingsWh + o.crossingsRetreat}/${o.crossings} >= `
        + `${T.exemptShare} - exempt by design, no change of parameters`);
    }
    const rule3 = !f3.pass && dTF !== null;
    let rule = null;
    if (rule1 && rule3) rule = "1+3";
    else if (rule1) rule = "1";
    else if (rule3) rule = "3";
    if (rule !== null && !isCtl) calibration = { rule, set: { ...CALIBRATION[rule] } };
    if (rule !== null && isCtl) {
      const rs = route ? route.total : null;
      const applied = rs ? telOf(route, "graph.routeAversionApplied") : null;
      const kept = rs ? telOf(route, "graph.routeAversionKept") : null;
      const share = applied !== null && kept !== null && applied + kept > 0 ? applied / (applied + kept) : null;
      const legDelta = rs && isNum(rs.avgLegJumps) && isNum(b.avgLegJumps) ? rs.avgLegJumps - b.avgLegJumps : null;
      if (share !== null && legDelta !== null && share < T.aversion.minShare && legDelta < T.aversion.minLegDelta) {
        notes.push(`ctl still fails: rule 4 proposal ${JSON.stringify(CALIBRATION_RULE_4)} (aversion share `
          + `${num3(share)}, leg delta ${num3(legDelta)}) - no second ctl run`);
      } else notes.push("ctl still fails: NO_GO, no second ctl run");
    }
  }
  return { verdict: go ? "GO" : "NO_GO", gates, notes, calibration };
}

class UsageError extends Error {}

function logCounts(file) {
  const out = { logErrors: 0, logRowLimit: 0, rowBoundRefusals: 0, rowWarnings: 0, fortressState: null };
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (LOG_ERROR_RE.test(line)) out.logErrors += 1;
    if (LOG_ROW_LIMIT_RE.test(line)) out.logRowLimit += 1;
    if (LOG_ROW_BOUND_RE.test(line)) out.rowBoundRefusals += 1;
    if (LOG_ROW_WARNING_RE.test(line)) out.rowWarnings += 1;
    const m = LOG_SERVICES_RE.exec(line);
    if (m) out.fortressState = m[1];
  }
  return out;
}

function exitCodeOf(file) {
  if (!fs.existsSync(file)) return null;
  const n = Number(fs.readFileSync(file, "utf8").trim());
  return Number.isSafeInteger(n) ? n : -1;
}

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

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch (_err) {
    return null;
  }
}

function shipsOfInput(inputJson) {
  const input = parseJson(inputJson);
  let n = 0;
  const fleets = input && input.sideA && Array.isArray(input.sideA.fleets) ? input.sideA.fleets : [];
  for (const f of fleets) {
    for (const e of Array.isArray(f.composition) ? f.composition : []) n += isNum(e.count) ? e.count : 0;
  }
  return n;
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

function readVariant(resultsDir, opts) {
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
  const Database = opts.Database || require("better-sqlite3");
  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    const transitions = db.prepare(`SELECT j.created_at AS createdAt, j.payload AS payload, f.faction_id AS factionId,
        f.fleet_role AS fleetRole FROM world_event_journal j
      LEFT JOIN virtual_fleets f ON f.fleet_id = json_extract(j.payload, '$.fleetId')
      WHERE j.event_type = 'FLEET_TRANSITION' AND json_extract(j.payload, '$.to') IN ('TRAVELLING', 'RETREATING')`)
      .all().map((r) => {
        const p = parseJson(r.payload) || {};
        const route = p.patch && p.patch.route ? p.patch.route : {};
        return { createdAt: Number(r.createdAt), fleetId: p.fleetId, to: p.to,
          systems: Array.isArray(route.systems) ? route.systems.map(Number) : [],
          wormhole: Array.isArray(route.wormholeEdges) && route.wormholeEdges.length > 0,
          factionId: r.factionId === null ? null : Number(r.factionId), fleetRole: r.fleetRole };
      });
    const halts = db.prepare(`SELECT j.created_at AS createdAt, json_extract(j.payload, '$.fleetId') AS fleetId,
        f.faction_id AS factionId FROM world_event_journal j
      LEFT JOIN virtual_fleets f ON f.fleet_id = json_extract(j.payload, '$.fleetId')
      WHERE j.event_type = 'FORTRESS_CHECKPOINT_RESOLVED' AND json_extract(j.payload, '$.outcome') = 'HALT'`)
      .all().map((r) => ({ createdAt: Number(r.createdAt), fleetId: r.fleetId,
        factionId: r.factionId === null ? null : Number(r.factionId) }));
    const battles = db.prepare(`SELECT b.battle_id AS battleId, b.created_at AS createdAt, b.input_json AS inputJson,
        json_extract(b.result_json, '$.outcome') AS outcome,
        (SELECT coalesce(sum(l.count), 0) FROM battle_losses l WHERE l.battle_id = b.battle_id) AS shipsLost
      FROM battle_records b WHERE b.system_id = ? AND json_extract(b.input_json, '$.fixedDefenses') IS NOT NULL`)
      .all(opts.fortressId).map((r) => ({ battleId: r.battleId, createdAt: Number(r.createdAt),
        outcome: r.outcome === undefined ? null : r.outcome, shipsLost: Number(r.shipsLost),
        shipsInput: shipsOfInput(r.inputJson) }));
    const convoysEnded = db.prepare(`SELECT ended_at AS endedAt, end_reason AS endReason FROM world_convoys
      WHERE ended_at IS NOT NULL`).all().map((r) => ({ endedAt: Number(r.endedAt), endReason: r.endReason }));
    const expeditionsCutOff = db.prepare(`SELECT cut_off_at AS cutOffAt FROM world_wh_expeditions
      WHERE cut_off_at IS NOT NULL`).all().map((r) => ({ cutOffAt: Number(r.cutOffAt) }));
    const memoryRows = Number(db.prepare("SELECT count(*) AS n FROM world_fortress_halt_memory").get().n);
    return summarize({ days, transitions, halts, battles, convoysEnded, expeditionsCutOff, memoryRows }, opts);
  } finally {
    db.close();
  }
}

const ROLE_FLAGS = Object.freeze({ "--base": "base", "--on": "on", "--route": "route", "--full": "full",
  "--ctl": "ctl" });

function parseArgs(argv) {
  const out = { variants: [], fortressId: DEFAULT_FORTRESS_ID, haltMemoryMs: DEFAULT_HALT_MEMORY_MS, json: null,
    roles: {} };
  const int = (v, name) => {
    const n = Number(v);
    if (!Number.isSafeInteger(n) || n < 0) throw new UsageError(`${name} needs a non-negative integer`);
    return n;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--variant") {
      const m = typeof v === "string" ? /^([A-Za-z0-9_-]+)=(.+)$/.exec(v) : null;
      if (!m) throw new UsageError("--variant needs <name>=<dir>");
      out.variants.push({ name: m[1], dir: path.resolve(m[2]) });
    } else if (a === "--fortress") out.fortressId = int(v, "--fortress");
    else if (a === "--halt-memory-ms") out.haltMemoryMs = int(v, "--halt-memory-ms");
    else if (ROLE_FLAGS[a]) {
      if (typeof v !== "string" || v === "" || v.startsWith("--")) throw new UsageError(`${a} needs a variant name`);
      out.roles[ROLE_FLAGS[a]] = v;
    } else if (a === "--json") {
      if (typeof v !== "string" || v === "") throw new UsageError("--json needs a file");
      out.json = path.resolve(v);
    } else throw new UsageError(`unknown argument ${a}`);
    i += 1;
  }
  if (out.variants.length === 0) throw new UsageError("at least one --variant");
  const roleNames = Object.keys(out.roles);
  if (roleNames.length > 0 && (!out.roles.base || !out.roles.on)) {
    throw new UsageError("a verdict needs both --base and --on");
  }
  for (const [role, name] of Object.entries(out.roles)) {
    if (!out.variants.some((x) => x.name === name)) throw new UsageError(`--${role} ${name} is not a --variant`);
  }
  return out;
}

const fmt = (v) => (v === null || v === undefined ? "-" : String(v));
const pair = (a, b) => `${fmt(a)}/${fmt(b)}`;

const TABLE_HEAD = ["variant", "day", "plans", "avgLeg", "X", "X wh/ret", "fleetsX", "halts", "fleetsH", "maxH1",
  "repH", "battles", "lost/ships", "outcomes", "avers app/kept", "fz pass/stale/obs/budget", "tooFar", "routeTF/UR",
  "advRef TF/NP/NPTF", "replanH", "searchP95", "lateP95", "passP95"];

function rowOf(variant, label, d) {
  const t = d.telemetry;
  return [variant, label, d.plans, fmt(d.avgLegJumps), d.crossings, pair(d.crossingsWh, d.crossingsRetreat),
    d.fleetsCrossing, d.halts, d.fleetsHalted, d.maxHaltsOneFleet, d.repeatHaltsSameFaction, d.battles,
    pair(d.shipsLost, d.shipsInput), Object.entries(d.outcomes).map(([k, v]) => `${k}:${v}`).join(" ") || "-",
    pair(t["graph.routeAversionApplied"], t["graph.routeAversionKept"]),
    [t["fortress.passed"], t["fortress.stale"], t["fortress.observedPass"], t["fortress.budgetPass"]].map(fmt).join("/"),
    fmt(t.tooFarTotal), pair(t["travel.routeTooFar"], t["travel.routeUnreachable"]),
    [t["travel.routeAdviceRefusedTooFar"], t["travel.routeAdviceRefusedNoPath"],
      t["travel.routeAdviceRefusedNoPathTooFar"]].map(fmt).join("/"), fmt(t["travel.replanAdviceHalted"]),
    fmt(t["graph.routeSearchMs.p95"]), fmt(d.latenessP95Ms && d.latenessP95Ms.max), fmt(d.passP95Ms && d.passP95Ms.max)];
}

function markdown(results) {
  const lines = [`| ${TABLE_HEAD.join(" | ")} |`, `|${TABLE_HEAD.map(() => "---").join("|")}|`];
  for (const r of results) {
    for (const d of r.summary.days) lines.push(`| ${rowOf(r.name, String(d.index), d).join(" | ")} |`);
    lines.push(`| ${rowOf(r.name, "total", r.summary.total).join(" | ")} |`);
  }
  lines.push("");
  for (const r of results) {
    const t = r.summary.total;
    lines.push(`${r.name}: crossings byFaction ${JSON.stringify(t.byFaction)} byRole ${JSON.stringify(t.byRole)}; `
      + `adviceRefusedByRole ${JSON.stringify(t.telemetry.adviceRefusedByRole)}; memoryRows ${fmt(t.memoryRows)}; `
      + `convoysEndedBy ${JSON.stringify(t.convoysEndedBy)}; expeditionsCutOff ${t.expeditionsCutOff}; `
      + `outside ${t.outside}`);
    lines.push(`${r.name}: exitOk ${t.exitOk}; checks r/p/f/e ${t.checks.runs}/${t.checks.pass}/${t.checks.fail}/`
      + `${t.checks.error}; logErrors ${t.logErrors}; TX_ROW_LIMIT ${t.logRowLimit}; FORTRESS_ROW_BOUND `
      + `${t.rowBoundRefusals}; row warnings ${t.rowWarnings}; fortress states ${JSON.stringify(t.fortressStates)}`);
  }
  return lines.join("\n");
}

function gateTable(title, v) {
  if (!v || !v.gates) return [`${title}: ${(v && v.reason) || "no verdict"} ${(v && v.detail) || ""}`.trim()];
  const lines = [`${title}: ${v.verdict}${v.calibration ? ` (calibration rule ${v.calibration.rule}: `
    + `${JSON.stringify(v.calibration.set)})` : ""}`, "", "| gate | pass | blocking | detail |", "|---|---|---|---|"];
  for (const [g, r] of Object.entries(v.gates)) {
    lines.push(`| ${g} | ${r.pass ? "PASS" : "FAIL"} | ${r.blocking ? "yes" : "no"} | ${r.detail.join("; ")} |`);
  }
  for (const n of v.notes) lines.push(`- ${n}`);
  return lines;
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
    err(`fortressReport: ${e.message} (${USAGE})`);
    return 1;
  }
  const results = [];
  for (const v of args.variants) {
    let summary;
    try {
      summary = readVariant(v.dir, { fortressId: args.fortressId, haltMemoryMs: args.haltMemoryMs,
        Database: io.Database });
    } catch (e) {
      err(`fortressReport: ${v.name}: read failed - ${(e && e.message) || e}`);
      return 2;
    }
    if (!summary.ok) {
      err(`fortressReport: ${v.name}: ${summary.reason} ${summary.detail || ""}`.trim());
      return 2;
    }
    results.push({ name: v.name, dir: v.dir, summary });
  }
  const verdicts = [];
  if (args.roles.base && args.roles.on) {
    const byName = Object.fromEntries(results.map((r) => [r.name, r.summary]));
    verdicts.push({ title: `verdict on=${args.roles.on}`, value: verdict(byName, args.roles) });
    if (args.roles.ctl) {
      verdicts.push({ title: `verdict on=${args.roles.ctl} (ctl)`, value: verdict(byName, { ...args.roles,
        on: args.roles.ctl }) });
    }
  }
  const text = [markdown(results)];
  for (const v of verdicts) text.push("", ...gateTable(v.title, v.value));
  out(text.join("\n"));
  if (args.json) {
    fs.mkdirSync(path.dirname(args.json), { recursive: true });
    fs.writeFileSync(args.json, `${JSON.stringify({ fortressId: args.fortressId, haltMemoryMs: args.haltMemoryMs,
      variants: results.map((r) => ({ name: r.name, days: r.summary.days, total: r.summary.total })),
      ...(verdicts.length > 0 ? { roles: args.roles, thresholds: THRESHOLDS,
        verdicts: verdicts.map((v) => ({ title: v.title, ...v.value })) } : {}) }, null, 2)}\n`);
  }
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { summarize, verdict, readVariant, parseArgs, main, markdown, THRESHOLDS, CALIBRATION };
