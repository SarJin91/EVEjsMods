#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { isConduitInvasionId } = require("../../lib/world/invasions/schema");

const FACTIONS = Object.freeze([500026, 500029, 500021]);
const TARGET = 500026;
const NO_HARM = Object.freeze([500029, 500021]);
const DEFAULT_HQ_SYSTEM_ID = 30002797;
const DAY_MS = 86400000;
const HOUR_MS = 3600000;

const DB_FILE = "world.sqlite";
const SEGMENT_REPORT_RE = /^seg(\d+)\.report\.json$/;
const LOG_ERROR_RE = / error|TX_FAILED/;
const LOG_ROW_LIMIT_RE = /TX_ROW_LIMIT/;
const LOG_INVADER_WARNING_RE = /config: warning.*invaderEconomy/;
const NOTE_CODES = Object.freeze(["INVADER_RAIDS_NO_FOOTHOLDS", "RAID_FRONT_LIMIT", "INSUFFICIENT_RESOURCES",
  "INVADER_HOME_POOL_FULL", "NO_TEMPLATE"]);
const OPEN_OPERATION_STATES = Object.freeze(["PLANNED", "ACTIVE"]);
const GONE_FLEET_STATES = Object.freeze(["DESTROYED", "DISBANDED"]);
const POOL_ROLE = "garrison";
const OPERATION_INVASION = "invasion";
const OPERATION_RAID = "raid";
const OPERATION_GANK = "gank";

const GAUGES = Object.freeze([
  Object.freeze(["yieldIsk", "strategy", "invaderEconomy.triglavian.yieldIsk"]),
  Object.freeze(["yieldUnits", "strategy", "invaderEconomy.triglavian.yieldUnits"]),
]);
const COUNTERS = Object.freeze([
  Object.freeze(["homePoolMobilize", "strategy", "invaderEconomy.homePoolMobilize"]),
  Object.freeze(["raidFrontLimit", "strategy", "review.raidFrontLimit"]),
  Object.freeze(["insufficientResources", "strategy", "review.insufficientResources"]),
]);

const THRESHOLDS = Object.freeze({
  bandRel: 0.40,
  noiseFactor: 2,
  minBand: 1,
  i1: Object.freeze({ minCheckRuns: 3, logErrorsSlack: 2 }),
  i2: Object.freeze({ iskFactor: 1.5, poolFleetsMin: 3, invasionsSlackPerDay: 0.5, invasionsMinPerDay: 0.5,
    raidsMinPerDay: 1 }),
  i3: Object.freeze({ conduitReserveIsk: 2e11, austerity: "AUSTERITY" }),
  i4: Object.freeze({ maxRaidFronts: 2, conduitMaxActive: 2, conduitMaxSpawnsPerDay: 2, maxActiveFronts: 3,
    registryFrontLimit: 1 }),
  i5: Object.freeze({ passFactor: 1.25, passSlackMs: 2, latenessFactor: 1.25, latenessSlackMs: 2000 }),
  homeFleetsMax: 8,
});

const CALIBRATION = Object.freeze({
  maxKeys: 2,
  r1: Object.freeze({ NO_ROLL: Object.freeze({ conduitChancePermille: 800 }),
    DAY_CAP: Object.freeze({ conduitMaxSpawnsPerDay: 3 }),
    NO_POOL: Object.freeze({ homeMobilizationsPerReview: 2 }),
    NO_ROOM: Object.freeze({ conduitMaxActive: 3 }),
    NO_SURPLUS: Object.freeze({ conduitReserveIsk: 1e11 }) }),
  r2: Object.freeze({ maxRaidFronts: 3 }),
  r3: Object.freeze({ insufficientResources: Object.freeze({ unitsPerHomeSystemPerPeriod: 4 }),
    poolFull: Object.freeze({ homeFleetsMax: 12 }) }),
  r4: Object.freeze({ baseIncomeIskPerDay: 6e9 }),
  thresholds: Object.freeze({ maxRaidFronts: Object.freeze(["i4", "maxRaidFronts"]),
    conduitMaxActive: Object.freeze(["i4", "conduitMaxActive"]),
    conduitMaxSpawnsPerDay: Object.freeze(["i4", "conduitMaxSpawnsPerDay"]),
    conduitReserveIsk: Object.freeze(["i3", "conduitReserveIsk"]),
    homeFleetsMax: Object.freeze(["homeFleetsMax"]) }),
});

const USAGE = "usage: node mods/livingNewEden/tools/measure/invaderReport.js --seed <dir> --variant <name>=<dir> "
  + "[--variant ...] --base <name> --noise <name> --yield <name> --pool <name> --raid <name> [--hq <name>] "
  + "[--ctl <name>] [--hq-system <id>] [--json <file>]";

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

const round3 = (v) => (isNum(v) ? Number(v.toFixed(3)) : v);

function channelsOf(telemetry) {
  if (!telemetry || typeof telemetry !== "object") return null;
  if (telemetry.channels && typeof telemetry.channels === "object") return telemetry.channels;
  return telemetry;
}

function metricOf(telemetry, channel, name) {
  const ch = channelsOf(telemetry);
  if (!ch || !ch[channel] || typeof ch[channel] !== "object") return null;
  const v = ch[channel][name];
  return isNum(v) ? v : 0;
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

const numOr = (v, d) => (isNum(v) ? v : d);

function summarize(input, opts = {}) {
  if (!input || typeof input !== "object" || !Array.isArray(input.days) || input.days.length === 0) {
    return { ok: false, reason: "INVALID_INPUT", detail: "days" };
  }
  const hq = Number.isSafeInteger(opts && opts.hqSystemId) ? opts.hqSystemId : DEFAULT_HQ_SYSTEM_ID;
  const segs = [...input.days].sort((a, b) => a.index - b.index);
  for (const d of segs) {
    if (!d || !Number.isSafeInteger(d.index) || !isNum(d.startVirtualAt) || !isNum(d.stopVirtualAt)
      || d.stopVirtualAt < d.startVirtualAt) {
      return { ok: false, reason: "INVALID_INPUT", detail: `day ${d && d.index}` };
    }
  }
  const from = segs[0].startVirtualAt;
  const to = segs[segs.length - 1].stopVirtualAt;
  const hours = (to - from) / HOUR_MS;
  const inWindow = (t) => isNum(t) && t >= from && t < to;
  const perDay = (n) => (hours > 0 ? round3((n * 24) / hours) : 0);
  const contiguous = segs.every((d, i) => d.index === i + 1);

  const out = { ok: true, hours: round3(hours), segments: segs.length,
    exitOk: contiguous && segs.every(segmentExitOk), checks: { runs: 0, pass: 0, fail: 0, error: 0 },
    logErrors: 0, logRowLimit: 0, invaderWarnings: 0, passP95MsMedian: null, latenessP95MsMedian: null,
    yieldIskLast: null, yieldUnitsLast: null, telemetry: {}, factions: {},
    logMissing: segs.filter((d) => d.logMissing === true).map((d) => `seg${d.index}`) };
  const passAll = [];
  const lateAll = [];
  for (const d of segs) {
    const c = d.report && d.report.checks ? d.report.checks : {};
    for (const k of ["runs", "pass", "fail", "error"]) out.checks[k] += numOr(c[k], 0);
    out.logErrors += numOr(d.logErrors, 0);
    out.logRowLimit += numOr(d.logRowLimit, 0);
    out.invaderWarnings += numOr(d.invaderWarnings, 0);
    passAll.push(...schedulerValues(d.status, "passP95Ms"));
    lateAll.push(...schedulerValues(d.status, "latenessP95Ms"));
    for (const [key, channel, name] of COUNTERS) {
      const v = metricOf(d.telemetry, channel, name);
      if (v !== null) out.telemetry[key] = (out.telemetry[key] || 0) + v;
    }
  }
  for (const [key] of COUNTERS) if (!(key in out.telemetry)) out.telemetry[key] = null;
  out.passP95MsMedian = median(passAll);
  out.latenessP95MsMedian = median(lateAll);
  const last = segs[segs.length - 1];
  out.yieldIskLast = metricOf(last.telemetry, GAUGES[0][1], GAUGES[0][2]);
  out.yieldUnitsLast = metricOf(last.telemetry, GAUGES[1][1], GAUGES[1][2]);

  const seed = input.seed || {};
  const end = input.end || {};
  const pick = (map, f) => (map && typeof map === "object" ? map[f] : undefined);
  for (const f of FACTIONS) {
    const tSeed = pick(seed.treasury, f);
    const tEnd = pick(end.treasury, f);
    const uSeed = pick(seed.resourceUnits, f);
    const uEnd = pick(end.resourceUnits, f);
    const fl = pick(end.frontLimit, f);
    const fleets = (input.fleetsEnd || []).filter((x) => x && x.factionId === f && !GONE_FLEET_STATES.includes(x.state));
    const byRole = {};
    for (const x of fleets) bumpMap(byRole, x.role);
    const pool = fleets.filter((x) => x.role === POOL_ROLE && x.homeSystemId === hq && x.systemId === hq).length;
    const inHq = fleets.filter((x) => x.systemId === hq).length;
    const created = (input.fleetsCreated || []).filter((x) => x && x.factionId === f && inWindow(x.createdAt)).length;
    const inv = (input.invasions || []).filter((x) => x && x.factionId === f);
    const invWin = inv.filter((x) => inWindow(x.startedAt));
    const conduit = invWin.filter((x) => isConduitInvasionId(x.invasionId));
    const roll = invWin.length - conduit.length;
    const perUtcDay = {};
    for (const x of conduit) bumpMap(perUtcDay, Math.floor(x.startedAt / DAY_MS));
    const ops = (input.operations || []).filter((x) => x && x.factionId === f);
    const reviewInv = ops.filter((x) => x.operationType === OPERATION_INVASION && inWindow(x.plannedAt)).length;
    const raids = ops.filter((x) => x.operationType === OPERATION_RAID && inWindow(x.plannedAt)).length;
    const ganks = ops.filter((x) => x.operationType === OPERATION_GANK && inWindow(x.plannedAt)).length;
    const openRaids = ops.filter((x) => x.operationType === OPERATION_RAID && OPEN_OPERATION_STATES.includes(x.state))
      .length;
    const outcomes = {};
    for (const r of input.conduitRolls || []) {
      if (r && r.factionId === f && inWindow(r.createdAt)) bumpMap(outcomes, r.outcome);
    }
    const captures = (input.captures || []).filter((c) => c && c.controllerFactionId === f && inWindow(c.capturedAt))
      .length;
    const notesIn = pick(input.notes, f) || {};
    const notes = Object.fromEntries(NOTE_CODES.map((code) => [code, numOr(notesIn[code], 0)]));
    const incomeDelta = tSeed && tEnd && isNum(tSeed.incomeTotal) && isNum(tEnd.incomeTotal)
      ? tEnd.incomeTotal - tSeed.incomeTotal : null;
    out.factions[f] = {
      iskIncomePerDay: incomeDelta === null ? null : perDay(incomeDelta),
      iskBalanceEnd: tEnd && isNum(tEnd.iskBalance) ? tEnd.iskBalance : null,
      treasuryMode: tEnd && typeof tEnd.mode === "string" ? tEnd.mode : null,
      unitsDelta: isNum(uSeed) && isNum(uEnd) ? uEnd - uSeed : null,
      fleetsEnd: fleets.length, fleetsEndByRole: byRole, poolFleetsEnd: pool, fleetsInHqEnd: inHq,
      fleetsCreatedPerDay: perDay(created),
      invasionsPerDay: { conduit: perDay(conduit.length), roll: perDay(roll) },
      reviewInvasionsPerDay: perDay(reviewInv), raidsPerDay: perDay(raids), ganksPerDay: perDay(ganks),
      capturesPerDay: perDay(captures),
      openRaidsEnd: openRaids,
      openConduitEnd: inv.filter((x) => x.open === true && isConduitInvasionId(x.invasionId)).length,
      conduitSpawnsMaxPerUtcDay: Object.values(perUtcDay).reduce((m, n) => Math.max(m, n), 0),
      conduitOutcomes: outcomes, notes, frontLimit: isNum(fl) ? fl : null,
      counts: { invasions: invWin.length + reviewInv, conduit: conduit.length, roll, reviewInvasions: reviewInv,
        raids, ganks, captures, fleetsCreated: created },
    };
  }
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

const fmt = (v) => (isNum(v) ? String(Number(v.toPrecision(6))) : "-");

function dominantOutcome(outcomes) {
  let best = null;
  let bestN = 0;
  for (const code of Object.keys(CALIBRATION.r1)) {
    const n = numOr(outcomes[code], 0);
    if (n > bestN) {
      best = code;
      bestN = n;
    }
  }
  const other = Object.entries(outcomes).filter(([k]) => k !== "SPAWN" && !(k in CALIBRATION.r1))
    .reduce((m, [, n]) => Math.max(m, n), 0);
  return other > bestN ? null : best;
}

const logMissingOf = (s) => (Array.isArray(s.logMissing) ? s.logMissing : ["(no logMissing)"]);

function verdict(summaries, roles, thresholds = THRESHOLDS) {
  const T = thresholds;
  const pickRole = (role) => (roles && typeof roles[role] === "string" && summaries && summaries[roles[role]]
    && summaries[roles[role]].ok === true ? summaries[roles[role]] : null);
  const base = pickRole("base");
  const noise = pickRole("noise");
  const yld = pickRole("yield");
  const pool = pickRole("pool");
  const raid = pickRole("raid");
  if (!base || !noise || !yld || !pool || !raid) {
    return { ok: false, reason: "INVALID_INPUT", detail: `roles base/noise/yield/pool/raid: ${JSON.stringify(roles)}` };
  }
  const fx = (s, f) => s.factions[f];
  const band = (get) => Math.max(T.bandRel * get(base), T.noiseFactor * Math.abs(get(base) - get(noise)), T.minBand);
  const tb = (s) => fx(s, TARGET);

  const evalVariant = (label, s, frontCheck) => {
    const r = { I1: gate(true), I3: gate(true), I4: gate(true), I5: gate(true), harmFail: false, balanceFail: false };
    const p = (g, ok, line) => (ok ? note(g, `${label}: ${line}`) : fail(g, `${label}: ${line}`));
    p(r.I1, s.exitOk, `exitOk ${s.exitOk}`);
    const logMissing = logMissingOf(s);
    p(r.I1, logMissing.length === 0, `logMissing: [${logMissing.join(", ")}]`);
    p(r.I1, s.checks.fail === 0 && s.checks.error === 0 && s.checks.runs >= T.i1.minCheckRuns,
      `checks r/p/f/e ${s.checks.runs}/${s.checks.pass}/${s.checks.fail}/${s.checks.error}`);
    p(r.I1, s.logErrors <= base.logErrors + T.i1.logErrorsSlack, `logErrors ${s.logErrors} (base ${base.logErrors})`);
    p(r.I1, s.logRowLimit <= base.logRowLimit, `logRowLimit ${s.logRowLimit} (base ${base.logRowLimit})`);
    p(r.I1, s.invaderWarnings === 0, `invaderWarnings ${s.invaderWarnings}`);
    for (const f of NO_HARM) {
      for (const m of ["invasions", "fleetsEnd"]) {
        const get = m === "invasions" ? (x) => fx(x, f).counts.invasions : (x) => fx(x, f).fleetsEnd;
        const lo = get(base) - band(get);
        const ok = get(s) >= lo;
        if (!ok) r.harmFail = true;
        p(r.I3, ok, `${f} ${m} ${get(s)} >= ${fmt(lo)} (base ${get(base)}, noise ${get(noise)})`);
      }
    }
    const bal = tb(s).iskBalanceEnd;
    const balOk = isNum(bal) && bal >= T.i3.conduitReserveIsk && tb(s).treasuryMode !== T.i3.austerity;
    if (!balOk) r.balanceFail = true;
    p(r.I3, balOk, `${TARGET} balance ${fmt(bal)} >= ${fmt(T.i3.conduitReserveIsk)}, mode ${tb(s).treasuryMode}`);
    p(r.I4, tb(s).openRaidsEnd <= T.i4.maxRaidFronts, `openRaidsEnd ${tb(s).openRaidsEnd} <= ${T.i4.maxRaidFronts}`);
    p(r.I4, tb(s).openConduitEnd <= T.i4.conduitMaxActive,
      `openConduitEnd ${tb(s).openConduitEnd} <= ${T.i4.conduitMaxActive}`);
    p(r.I4, tb(s).conduitSpawnsMaxPerUtcDay <= T.i4.conduitMaxSpawnsPerDay,
      `conduitSpawnsMaxPerUtcDay ${tb(s).conduitSpawnsMaxPerUtcDay} <= ${T.i4.conduitMaxSpawnsPerDay}`);
    if (frontCheck) {
      p(r.I4, tb(s).frontLimit === T.i4.maxActiveFronts, `frontLimit ${tb(s).frontLimit} = ${T.i4.maxActiveFronts}`);
    }
    const fl0 = tb(base).frontLimit;
    p(r.I4, fl0 === null || fl0 === T.i4.registryFrontLimit, `frontLimit base ${fl0} = ${T.i4.registryFrontLimit}`);
    const cost = (field, limit) => {
      const ok = limit !== null && isNum(s[field]) && s[field] <= limit;
      p(r.I5, ok, `${field} ${fmt(s[field])} <= ${fmt(limit)} (base ${fmt(base[field])})`);
    };
    cost("passP95MsMedian", isNum(base.passP95MsMedian)
      ? T.i5.passFactor * base.passP95MsMedian + T.i5.passSlackMs : null);
    cost("latenessP95MsMedian", isNum(base.latenessP95MsMedian) && isNum(noise.latenessP95MsMedian)
      ? Math.max(T.i5.latenessFactor * base.latenessP95MsMedian, base.latenessP95MsMedian
        + T.noiseFactor * Math.abs(base.latenessP95MsMedian - noise.latenessP95MsMedian)) + T.i5.latenessSlackMs
      : null);
    return r;
  };
  const evA = evalVariant("pool", pool, false);
  const evB = evalVariant("raid", raid, true);

  const i2 = gate(true);
  const parts = { a: true, b: true, c: true, d: true, e: true, bNoLoss: true };
  const p2 = (k, ok, line) => {
    if (!ok) parts[k] = false;
    return ok ? note(i2, `${k}) ${line}`) : fail(i2, `${k}) ${line}`);
  };
  const isk0 = tb(base).iskIncomePerDay;
  const isk1 = tb(yld).iskIncomePerDay;
  p2("a", isNum(isk1) && isNum(isk0) && isk1 >= T.i2.iskFactor * isk0 && isNum(yld.yieldIskLast)
    && yld.yieldIskLast > 0, `iskIncomePerDay yield ${fmt(isk1)} >= ${T.i2.iskFactor} x ${fmt(isk0)}, `
    + `yieldIskLast ${fmt(yld.yieldIskLast)} > 0`);
  const u0 = tb(base).unitsDelta;
  const u1 = tb(yld).unitsDelta;
  p2("b", isNum(u1) && isNum(u0) && u1 > u0 && isNum(yld.yieldUnitsLast) && yld.yieldUnitsLast > 0,
    `unitsDelta yield ${fmt(u1)} > ${fmt(u0)}, yieldUnitsLast ${fmt(yld.yieldUnitsLast)} > 0`);
  p2("c", tb(pool).fleetsEnd >= tb(base).fleetsEnd + T.i2.poolFleetsMin
    && tb(pool).fleetsCreatedPerDay > tb(base).fleetsCreatedPerDay,
  `fleetsEnd pool ${tb(pool).fleetsEnd} >= ${tb(base).fleetsEnd} + ${T.i2.poolFleetsMin}, fleetsCreatedPerDay `
    + `${tb(pool).fleetsCreatedPerDay} > ${tb(base).fleetsCreatedPerDay} (pool fleets ${tb(pool).poolFleetsEnd})`);
  const invPerDay = (s) => round3(tb(s).invasionsPerDay.conduit + tb(s).invasionsPerDay.roll
    + tb(s).reviewInvasionsPerDay);
  p2("d", invPerDay(pool) >= invPerDay(base) + T.i2.invasionsSlackPerDay && invPerDay(pool) >= T.i2.invasionsMinPerDay,
    `invasions/day pool ${invPerDay(pool)} >= ${invPerDay(base)} + ${T.i2.invasionsSlackPerDay} and >= `
    + `${T.i2.invasionsMinPerDay} (conduit outcomes ${JSON.stringify(tb(pool).conduitOutcomes)})`);
  const sortiesPerDay = round3(tb(raid).raidsPerDay + numOr(tb(raid).ganksPerDay, 0));
  p2("e", sortiesPerDay >= T.i2.raidsMinPerDay, `raid + gank per day raid ${sortiesPerDay} (raids `
    + `${tb(raid).raidsPerDay}, ganks ${numOr(tb(raid).ganksPerDay, 0)}) >= ${T.i2.raidsMinPerDay} `
    + `(open raids ${tb(raid).openRaidsEnd})`);
  for (const m of ["invasions", "fleetsEnd"]) {
    const get = m === "invasions" ? (x) => tb(x).counts.invasions : (x) => tb(x).fleetsEnd;
    const lo = get(pool) - band(get);
    p2("bNoLoss", get(raid) >= lo, `raid ${m} ${get(raid)} >= pool ${get(pool)} - band = ${fmt(lo)}`);
  }

  const merge = (k) => {
    const g = gate(true);
    for (const ev of [evA, evB]) {
      g.pass = g.pass && ev[k].pass;
      g.detail.push(...ev[k].detail);
    }
    return g;
  };
  const gates = { I1: merge("I1"), I2: i2, I3: merge("I3"), I4: merge("I4"), I5: merge("I5") };
  const okOf = (ev) => ev.I1.pass && ev.I3.pass && ev.I4.pass && ev.I5.pass;
  const phaseA = okOf(evA) && parts.a && parts.b && parts.c && parts.d;
  const phaseB = phaseA && okOf(evB) && parts.e && parts.bNoLoss;

  const notes = [];
  const hqS = pickRole("hq");
  if (hqS) {
    notes.push(`hq vs raid: invasions/day ${invPerDay(hqS)} vs ${invPerDay(raid)}; raidsPerDay ${tb(hqS).raidsPerDay}`
      + ` vs ${tb(raid).raidsPerDay}; fleets in HQ ${tb(hqS).fleetsInHqEnd} vs ${tb(raid).fleetsInHqEnd}; fleets on `
      + `fronts ${tb(hqS).fleetsEnd - tb(hqS).fleetsInHqEnd} vs ${tb(raid).fleetsEnd - tb(raid).fleetsInHqEnd}`);
  }

  let calibration = null;
  const isCtl = typeof roles.ctl === "string" && roles.ctl === roles.pool && roles.ctl === roles.raid;
  const structuralOk = [evA, evB].every((ev) => ev.I1.pass && ev.I4.pass && ev.I5.pass && !ev.harmFail);
  if (!isCtl && structuralOk && !(phaseA && phaseB)) {
    const rules = [];
    const set = {};
    const hit = (rule, keys) => {
      if (rules.length >= CALIBRATION.maxKeys) return;
      rules.push(rule);
      Object.assign(set, keys);
    };
    if (!parts.d) {
      const dom = dominantOutcome(tb(pool).conduitOutcomes);
      if (dom) hit(`R1 ${dom}`, CALIBRATION.r1[dom]);
    }
    if (!parts.e) {
      const s = tb(raid);
      const counterUp = isNum(raid.telemetry.raidFrontLimit) && isNum(base.telemetry.raidFrontLimit)
        && raid.telemetry.raidFrontLimit > base.telemetry.raidFrontLimit;
      if (s.notes.RAID_FRONT_LIMIT > 0 || s.openRaidsEnd >= T.i4.maxRaidFronts || counterUp) {
        hit("R2 RAID_FRONT_LIMIT", CALIBRATION.r2);
      } else if (s.notes.INVADER_RAIDS_NO_FOOTHOLDS > 0) notes.push("R2 INVADER_RAIDS_NO_FOOTHOLDS: no key (R1)");
    }
    if (!parts.c) {
      const s = tb(pool);
      const short = isNum(pool.telemetry.insufficientResources) && isNum(base.telemetry.insufficientResources)
        && pool.telemetry.insufficientResources > base.telemetry.insufficientResources && s.poolFleetsEnd < T.homeFleetsMax;
      if (s.notes.INSUFFICIENT_RESOURCES > 0 || short) hit("R3 INSUFFICIENT_RESOURCES", CALIBRATION.r3.insufficientResources);
      else if (s.notes.INVADER_HOME_POOL_FULL > 0 || s.poolFleetsEnd >= T.homeFleetsMax) {
        hit("R3 INVADER_HOME_POOL_FULL", CALIBRATION.r3.poolFull);
      }
    }
    if (evA.balanceFail || evB.balanceFail) hit("R4 balance", CALIBRATION.r4);
    if (rules.length > 0) calibration = { rules, set };
  }
  return { phaseA: phaseA ? "GO" : "NO_GO", phaseB: phaseB ? "GO" : "NO_GO", gates, notes, calibration };
}

function thresholdsWith(set, base = THRESHOLDS) {
  const out = JSON.parse(JSON.stringify(base));
  for (const [key, value] of Object.entries(set || {})) {
    const at = CALIBRATION.thresholds[key];
    if (!at) continue;
    let o = out;
    for (const k of at.slice(0, -1)) o = o[k];
    o[at[at.length - 1]] = value;
  }
  return out;
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
  const out = { logErrors: 0, logRowLimit: 0, invaderWarnings: 0, logMissing: false };
  if (!fs.existsSync(file)) return { ...out, logMissing: true };
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (LOG_ERROR_RE.test(line)) out.logErrors += 1;
    if (LOG_ROW_LIMIT_RE.test(line)) out.logRowLimit += 1;
    if (LOG_INVADER_WARNING_RE.test(line)) out.invaderWarnings += 1;
  }
  return out;
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

function seedDbOf(dir) {
  const db = path.join(dir, DB_FILE);
  if (!fs.existsSync(db)) throw new UsageError(`missing ${DB_FILE} in seed ${dir}`);
  return db;
}

function parseJson(s) {
  try {
    return JSON.parse(s);
  } catch (_err) {
    return null;
  }
}

const FACTION_LIST = FACTIONS.join(", ");

function readEconomy(db) {
  const treasury = {};
  for (const r of db.prepare(`SELECT faction_id AS f, isk_balance AS b, income_total AS i, mode AS m
    FROM world_faction_treasury WHERE faction_id IN (${FACTION_LIST})`).all()) {
    treasury[Number(r.f)] = { iskBalance: Number(r.b), incomeTotal: Number(r.i), mode: r.m };
  }
  const resourceUnits = {};
  const frontLimit = {};
  for (const r of db.prepare(`SELECT faction_id AS f, resource_units AS u, front_limit AS fl FROM world_factions
    WHERE faction_id IN (${FACTION_LIST})`).all()) {
    resourceUnits[Number(r.f)] = Number(r.u);
    frontLimit[Number(r.f)] = r.fl === null || r.fl === undefined ? null : Number(r.fl);
  }
  return { treasury, resourceUnits, frontLimit };
}

function readVariant(resultsDir, opts) {
  const { db: dbFile, segs } = segmentsOf(resultsDir);
  const seedFile = seedDbOf(opts.seedDir);
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
  const sdb = new Database(seedFile, { readonly: true, fileMustExist: true });
  let seed;
  try {
    const e = readEconomy(sdb);
    seed = { treasury: e.treasury, resourceUnits: e.resourceUnits };
  } finally {
    sdb.close();
  }
  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    const end = readEconomy(db);
    const fleetsEnd = db.prepare(`SELECT faction_id AS f, fleet_role AS role, state, home_system_id AS home,
        current_system_id AS sys FROM virtual_fleets WHERE faction_id IN (${FACTION_LIST})`).all()
      .map((r) => ({ factionId: Number(r.f), role: r.role, state: r.state,
        homeSystemId: r.home === null ? null : Number(r.home), systemId: r.sys === null ? null : Number(r.sys) }));
    const fleetsCreated = db.prepare(`SELECT created_at AS at, json_extract(payload, '$.factionId') AS f
      FROM world_event_journal WHERE event_type = 'FLEET_CREATED' AND created_at >= ? AND created_at < ?`)
      .all(from, to).map((r) => ({ factionId: Number(r.f), createdAt: Number(r.at) }));
    const invasions = db.prepare(`SELECT faction_id AS f, invasion_id AS id, started_at AS at, open FROM world_invasions
      WHERE faction_id IN (${FACTION_LIST})`).all()
      .map((r) => ({ factionId: Number(r.f), invasionId: r.id, startedAt: Number(r.at), open: Number(r.open) === 1 }));
    const operations = db.prepare(`SELECT faction_id AS f, operation_type AS t, planned_at AS at, state
      FROM world_operations WHERE faction_id IN (${FACTION_LIST}) AND operation_type IN (?, ?, ?)`)
      .all(OPERATION_INVASION, OPERATION_RAID, OPERATION_GANK)
      .map((r) => ({ factionId: Number(r.f), operationType: r.t, plannedAt: Number(r.at), state: r.state }));
    const conduitRolls = db.prepare(`SELECT created_at AS at, payload FROM world_event_journal
      WHERE event_type = 'INVASION_CONDUIT_ROLLED' AND created_at >= ? AND created_at < ?`).all(from, to)
      .map((r) => {
        const p = parseJson(r.payload) || {};
        return { factionId: Number.isSafeInteger(p.factionId) ? p.factionId : null, createdAt: Number(r.at),
          outcome: typeof p.outcome === "string" ? p.outcome : "UNKNOWN" };
      });
    const captures = db.prepare(`SELECT controller_faction_id AS f, captured_at AS at FROM world_system_state
      WHERE captured_at IS NOT NULL AND captured_at >= ? AND captured_at < ?`).all(from, to)
      .map((r) => ({ controllerFactionId: Number(r.f), capturedAt: Number(r.at) }));
    const notes = {};
    for (const code of NOTE_CODES) {
      for (const r of db.prepare(`SELECT aggregate_id AS f, count(*) AS n FROM world_event_journal
        WHERE aggregate_type = 'world_faction' AND created_at >= ? AND created_at < ? AND payload LIKE ?
        GROUP BY aggregate_id`).all(from, to, `%"${code}"%`)) {
        const f = Number(r.f);
        notes[f] = notes[f] || {};
        notes[f][code] = Number(r.n);
      }
    }
    return summarize({ days, seed, end, fleetsEnd, fleetsCreated, invasions, operations, conduitRolls, captures,
      notes }, { hqSystemId: opts.hqSystemId });
  } finally {
    db.close();
  }
}

const ROLE_FLAGS = Object.freeze({ "--base": "base", "--noise": "noise", "--yield": "yield", "--pool": "pool",
  "--raid": "raid", "--hq": "hq", "--ctl": "ctl" });
const REQUIRED_ROLES = Object.freeze(["base", "noise", "yield", "pool", "raid"]);

function parseArgs(argv) {
  const out = { variants: [], roles: {}, seed: null, hqSystemId: DEFAULT_HQ_SYSTEM_ID, json: null };
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
    } else if (a === "--seed") {
      if (typeof v !== "string" || v === "") throw new UsageError("--seed needs a directory");
      out.seed = path.resolve(v);
    } else if (a === "--hq-system") {
      const n = Number(v);
      if (!Number.isSafeInteger(n) || n <= 0) throw new UsageError("--hq-system needs a positive integer");
      out.hqSystemId = n;
    } else if (a === "--json") {
      if (typeof v !== "string" || v === "") throw new UsageError("--json needs a file");
      out.json = path.resolve(v);
    } else throw new UsageError(`unknown argument ${a}`);
    i += 1;
  }
  if (out.variants.length === 0) throw new UsageError("at least one --variant");
  if (!out.seed) throw new UsageError("--seed is required");
  for (const role of REQUIRED_ROLES) if (!out.roles[role]) throw new UsageError(`--${role} is required`);
  for (const [role, name] of Object.entries(out.roles)) {
    if (!out.variants.some((x) => x.name === name)) throw new UsageError(`--${role} ${name} is not a --variant`);
  }
  return out;
}

const cell = (v) => (v === null || v === undefined ? "-" : typeof v === "number" ? fmt(v) : String(v));

const TABLE_HEAD = ["variant", "h", "exitOk", "checks r/p/f/e", "logErr/rowLim/invWarn", "passP95", "lateP95",
  "T ISK/d", "T balance", "T mode", "T unitsΔ", "T fleets", "T pool", "T created/d", "T conduit/d", "T roll/d",
  "T reviewInv/d", "T raids/d", "T ganks/d", "T openRaids", "T openConduit", "T frontLimit", "T captures/d", "yieldIsk",
  "500029 inv/fleets", "500021 inv/fleets"];

function rowOf(name, s) {
  const t = s.factions[TARGET];
  const nh = (f) => `${s.factions[f].counts.invasions}/${s.factions[f].fleetsEnd}`;
  return [name, s.hours, s.exitOk, `${s.checks.runs}/${s.checks.pass}/${s.checks.fail}/${s.checks.error}`,
    `${s.logErrors}/${s.logRowLimit}/${s.invaderWarnings}`, s.passP95MsMedian, s.latenessP95MsMedian,
    t.iskIncomePerDay, t.iskBalanceEnd, t.treasuryMode, t.unitsDelta, t.fleetsEnd, t.poolFleetsEnd,
    t.fleetsCreatedPerDay, t.invasionsPerDay.conduit, t.invasionsPerDay.roll, t.reviewInvasionsPerDay, t.raidsPerDay,
    t.ganksPerDay, t.openRaidsEnd, t.openConduitEnd, t.frontLimit, t.capturesPerDay, s.yieldIskLast, nh(500029), nh(500021)]
    .map(cell);
}

function gateTable(title, v) {
  const lines = [`${title}: phase A ${v.phaseA}, phase B ${v.phaseB}${v.calibration ? ` (calibration `
    + `${v.calibration.rules.join(", ")}: ${JSON.stringify(v.calibration.set)})` : ""}`, "",
  "| gate | pass | detail |", "|---|---|---|"];
  for (const [g, r] of Object.entries(v.gates)) lines.push(`| ${g} | ${r.pass ? "PASS" : "FAIL"} | ${r.detail.join("; ")} |`);
  for (const n of v.notes) lines.push(`- ${n}`);
  return lines;
}

function markdown(r) {
  const lines = [`| ${TABLE_HEAD.join(" | ")} |`, `|${TABLE_HEAD.map(() => "---").join("|")}|`];
  for (const x of r.results) lines.push(`| ${rowOf(x.name, x.summary).join(" | ")} |`);
  lines.push("", "conduit outcomes (T): " + r.results.map((x) => `${x.name} ${JSON.stringify(
    x.summary.factions[TARGET].conduitOutcomes)}`).join("; "));
  lines.push("notes (T, journal): " + r.results.map((x) => `${x.name} ${JSON.stringify(
    x.summary.factions[TARGET].notes)}`).join("; "));
  lines.push("telemetry sums: " + r.results.map((x) => `${x.name} ${JSON.stringify(x.summary.telemetry)}`).join("; "));
  for (const v of r.verdicts) {
    if (v.value && v.value.ok === false) lines.push("", `${v.title}: ${v.value.reason} ${v.value.detail || ""}`);
    else lines.push("", ...gateTable(v.title, v.value));
  }
  return lines.join("\n");
}

function main(argv, io = {}) {
  const out = io.out || ((s) => process.stdout.write(`${s}\n`));
  const err = io.err || ((s) => process.stderr.write(`${s}\n`));
  let args;
  try {
    args = parseArgs(argv);
    seedDbOf(args.seed);
    for (const v of args.variants) segmentsOf(v.dir);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    err(`invaderReport: ${e.message} (${USAGE})`);
    return 1;
  }
  const summaries = {};
  const results = [];
  for (const v of args.variants) {
    let summary;
    try {
      summary = readVariant(v.dir, { seedDir: args.seed, hqSystemId: args.hqSystemId, Database: io.Database });
    } catch (e) {
      err(`invaderReport: ${v.name}: read failed - ${(e && e.message) || e}`);
      return 2;
    }
    if (!summary.ok) {
      err(`invaderReport: ${v.name}: ${summary.reason} ${summary.detail || ""}`.trim());
      return 2;
    }
    summaries[v.name] = summary;
    results.push({ name: v.name, summary });
  }
  const first = verdict(summaries, args.roles);
  const verdicts = [{ title: `verdict pool=${args.roles.pool} raid=${args.roles.raid}`, value: first }];
  if (args.roles.ctl) {
    const set = first && first.calibration ? first.calibration.set : {};
    verdicts.push({ title: `verdict pool=raid=${args.roles.ctl} (ctl ${JSON.stringify(set)})`,
      value: verdict(summaries, { ...args.roles, pool: args.roles.ctl, raid: args.roles.ctl }, thresholdsWith(set)) });
  }
  out(markdown({ results, verdicts }));
  if (args.json) {
    fs.mkdirSync(path.dirname(args.json), { recursive: true });
    fs.writeFileSync(args.json, `${JSON.stringify({ roles: args.roles, hqSystemId: args.hqSystemId,
      thresholds: THRESHOLDS, calibrationRules: CALIBRATION,
      variants: Object.fromEntries(results.map((x) => [x.name, x.summary])),
      verdicts: verdicts.map((v) => ({ title: v.title, ...v.value })) }, null, 2)}\n`);
  }
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { summarize, verdict, readVariant, parseArgs, main, markdown, thresholdsWith, THRESHOLDS,
  CALIBRATION, FACTIONS };
