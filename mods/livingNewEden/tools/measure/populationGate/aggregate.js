"use strict";

const { percentile } = require("../../../lib/telemetry/histogram");
const { scanSlowLines } = require("./logScan");
const { summarizeTempo, lifecycleChecks } = require("./lifecycle");

const MS_PER_MINUTE = 60000;
const S_PER_MINUTE = 60;
const S_PER_HOUR = 3600;
const PERMILLE = 1000;
const P95 = 0.95;

const THRESHOLDS = Object.freeze({
  warmupMin: 10, steadyMin0: 110, steadyMinA: 110, steadyMinB: 50,
  minPassSamples: 600, minPassRows: 3, passP95Ms: 4, passMaxMs: 20,
  minFlushSamples: 30, flushP95Ms: 15, flushMaxMs: 60,
  lagP95Ms: 5000, minNormalPermille: 500,
  dirtyGrowthFactor: 2, flushRowsPerSlice: 1000,
  memoryBytes: 20971520, heapDeltaWarnBytes: 20971520,
  governorSlackPerHour: 2,
  ownedMismatch: 2, ownedMismatchRows: 3,
  gateWarmupMs: 600000, size: 10000,
  steadyMinL: 30, steadyMinN: 30, tempoMinDays: 25, tempoLagP95Ms: 300000, awayFromDay: 22,
  awayMinPermille: 100, awayMaxPermille: 250, rebornMinPerDay: 5, rebornMaxPerDay: 60, unassignedMaxPermille: 100,
  corpsOpenMinRatio: 0.5, lifeDeltaP95Ms: 1, minTempoRows: 3,
});

const ROLES = Object.freeze({ 0: "base", A: "far", B: "live", T: "tempo", L: "lifecycle", N: "nolife" });
const GATES = Object.freeze({ population: Object.freeze(["far", "live"]),
  lifecycle: Object.freeze(["tempo", "lifecycle", "nolife"]) });
const LIFE_ROLES = GATES.lifecycle;
const SHIM_MARK = "node:sqlite shim";
const COMMON_KEYS = Object.freeze(["population.gateWarmupMs", "highsecLife.enabled", "highsecLife.civilians.enabled",
  "highsecLife.traffic.enabled", "highsecLife.traffic.maxShipsGlobal", "highsecLife.traffic.maxShipsPerSystem",
  "localPilots.enabled"]);
const FLAG_KEYS = Object.freeze(["population.near.enabled", "population.live.localEnabled",
  "population.live.trafficEnabled"]);

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const nums = (list) => list.filter(isNum);
const maxOf = (list) => (nums(list).length > 0 ? Math.max(...nums(list)) : null);

function median(values) {
  const v = nums(values).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function roleOf(label) {
  return ROLES[String(label || "").charAt(0)] || null;
}

function profileOf(rows) {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i]["views.status"] === true) {
      const out = {};
      for (const [k, v] of Object.entries(rows[i])) if (k.startsWith("status.config.")) out[k.slice(14)] = v;
      return out;
    }
  }
  return null;
}

function profileMismatches(role, profile, t) {
  if (!profile) return ["no status view"];
  const bad = [];
  const want = (key, value) => {
    if (profile[key] !== value) bad.push(`${key}=${profile[key]} (want ${value})`);
  };
  if (!(isNum(profile["population.gateWarmupMs"]) && profile["population.gateWarmupMs"] >= t.gateWarmupMs)) {
    bad.push(`population.gateWarmupMs=${profile["population.gateWarmupMs"]} (want >= ${t.gateWarmupMs})`);
  }
  if (role === "base") {
    want("population.enabled", false);
    return bad;
  }
  if (LIFE_ROLES.includes(role)) {
    const life = role !== "nolife";
    want("population.enabled", true);
    want("population.size", t.size);
    want("population.standings.enabled", true);
    want("population.corps.enabled", true);
    want("population.lifecycle.enabled", life);
    if (life) {
      want("population.lifecycle.careerEnabled", true);
      want("population.lifecycle.corpsActivityEnabled", true);
    }
    return bad;
  }
  want("population.enabled", true);
  want("population.size", t.size);
  want("population.context.enabled", true);
  for (const k of FLAG_KEYS) want(k, role === "live");
  return bad;
}

function longestRun(rows, pred) {
  let best = 0;
  let cur = 0;
  for (const r of rows) {
    cur = pred(r) ? cur + 1 : 0;
    if (cur > best) best = cur;
  }
  return best;
}

function summarizePhase(phase, thresholds) {
  const t = thresholds || THRESHOLDS;
  const label = String(phase.label);
  const role = roleOf(label);
  const rows = [...(phase.rows || [])].sort((a, b) => (a.capturedAtMs || 0) - (b.capturedAtMs || 0));
  const incomplete = [];
  const checks = [];
  const check = (name, value, limit, result, note) => checks.push({ name, value: value === undefined ? null : value,
    limit: limit === undefined ? null : limit, result, ...(note ? { note } : {}) });
  const out = (rates, heapMedian, profile) => ({ label, role: role || "unknown", ok: incomplete.length === 0
    && !checks.some((c) => c.result === "FAIL"), incomplete, checks, rates, heapMedian, profile });
  if (role === null) {
    incomplete.push("UNKNOWN_ROLE");
    return out({ modeChangesPerHour: null }, null, null);
  }
  if (rows.length === 0) {
    incomplete.push("NO_ROWS");
    return out({ modeChangesPerHour: null }, null, null);
  }
  const measured = role !== "base";

  const profile = profileOf(rows);
  const mismatch = profileMismatches(role, profile, t);
  check("profile", mismatch.length === 0 ? "ok" : mismatch.join("; "), role, mismatch.length === 0 ? "PASS" : "FAIL");
  if (mismatch.length > 0) {
    checks[checks.length - 1].result = "INFO";
    incomplete.push("PROFILE_MISMATCH");
  }
  const pids = new Set(rows.map((r) => r["process.pid"]));
  const starts = new Set(rows.map((r) => r.startedAtMs));
  if (pids.size > 1 || starts.size > 1) incomplete.push("PROCESS_RESTARTED");
  if (measured) {
    const states = rows.map((r) => r["status.services.population.state"]).filter((s) => typeof s === "string");
    const last = states.length > 0 ? states[states.length - 1] : null;
    check("service population", last, "running", last === "running" ? "PASS" : "FAIL");
  }

  const warmS = t.warmupMin * S_PER_MINUTE;
  const steady = rows.filter((r) => isNum(r["process.uptimeSeconds"]) && r["process.uptimeSeconds"] >= warmS);
  const lastUp = steady.length > 0 ? steady[steady.length - 1]["process.uptimeSeconds"] : null;
  const steadyMin = lastUp === null ? 0 : (lastUp - warmS) / S_PER_MINUTE;
  const needMin = role === "base" ? t.steadyMin0 : role === "far" ? t.steadyMinA : role === "lifecycle" ? t.steadyMinL
    : role === "nolife" ? t.steadyMinN : t.steadyMinB;
  if (role !== "tempo") {
    check("steady minutes", Math.round(steadyMin * 10) / 10, needMin, steadyMin >= needMin ? "PASS" : "FAIL");
    if (steadyMin < needMin) {
      checks[checks.length - 1].result = "INFO";
      incomplete.push("TOO_SHORT");
    }
  }

  let modeChangesPerHour = null;
  if (steady.length >= 2) {
    const a = steady[0];
    const b = steady[steady.length - 1];
    const hours = (b["process.uptimeSeconds"] - a["process.uptimeSeconds"]) / S_PER_HOUR;
    if (hours > 0 && isNum(a["channels.governor.modeChanges"]) && isNum(b["channels.governor.modeChanges"])) {
      modeChangesPerHour = (b["channels.governor.modeChanges"] - a["channels.governor.modeChanges"]) / hours;
    }
  }
  const heapMedian = median(steady.map((r) => r["process.heap.afterMajor.lastUsedBytes"]));

  if (steady.some((r) => Array.isArray(r.rejectedNames) && r.rejectedNames.length > 0)
    || rows.some((r) => Array.isArray(r.rejectedNames) && r.rejectedNames.length > 0)) {
    incomplete.push("METRIC_REJECTED");
  }

  if (role === "tempo") {
    const tempo = summarizeTempo(rows, profile, t);
    checks.push(...tempo.checks);
    for (const r of tempo.incomplete) if (!incomplete.includes(r)) incomplete.push(r);
    check("log", typeof phase.logText === "string" ? "present" : null, null, "INFO", "optional for the phase T");
    return out({ modeChangesPerHour: null }, heapMedian, profile);
  }
  const life = LIFE_ROLES.includes(role);

  if (measured) {
    const passRows = steady.filter((r) => isNum(r["channels.population.passMs.samples"])
      && r["channels.population.passMs.samples"] >= t.minPassSamples && isNum(r["channels.population.passMs.p95"]));
    if (passRows.length < t.minPassRows) incomplete.push("PASS_SAMPLES");
    const p95 = maxOf(passRows.map((r) => r["channels.population.passMs.p95"]));
    const pmax = maxOf(passRows.map((r) => r["channels.population.passMs.max"]));
    check("passMs p95", p95, t.passP95Ms, p95 === null ? "INFO" : p95 <= t.passP95Ms ? "PASS" : "FAIL");
    let gcNote = null;
    if (pmax !== null && pmax > t.passMaxMs && passRows.length > 0) {
      const g0 = passRows[0]["gc.kinds.major.count"];
      const g1 = passRows[passRows.length - 1]["gc.kinds.major.count"];
      gcNote = isNum(g0) && isNum(g1) ? `major GC in the window: +${g1 - g0} (max pause `
        + `${passRows[passRows.length - 1]["gc.kinds.major.maxMs"]} ms)` : "major GC: no data";
    }
    check("passMs max", pmax, t.passMaxMs, pmax === null ? "INFO" : pmax <= t.passMaxMs ? "PASS" : "FAIL", gcNote);
    const lastRow = rows[rows.length - 1];
    check("warmupPassMs max", lastRow["channels.population.warmupPassMs.max"], null, "INFO");

    const fs = lastRow["channels.population.flushMs.samples"];
    const fp95 = lastRow["channels.population.flushMs.p95"];
    const fmax = lastRow["channels.population.flushMs.max"];
    if (life) {
      check("flushMs p95", fp95, t.flushP95Ms, "INFO", "information only");
      check("flushMs max", fmax, t.flushMaxMs, "INFO", "information only");
    } else {
      if (!(isNum(fs) && fs >= t.minFlushSamples)) incomplete.push("FLUSH_SAMPLES");
      check("flushMs p95", fp95, t.flushP95Ms, !isNum(fp95) ? "INFO" : fp95 <= t.flushP95Ms ? "PASS" : "FAIL");
      check("flushMs max", fmax, t.flushMaxMs, !isNum(fmax) ? "INFO" : fmax <= t.flushMaxMs ? "PASS" : "FAIL");
    }
    if (isNum(fs) && fs > 0 && fs === lastRow["channels.population.flushMs.capacity"]) {
      check("flushMs ring", fs, lastRow["channels.population.flushMs.capacity"], "WARN", "RING_WRAPPED");
    }

    const normal = steady.filter((r) => r["governor.mode"] === "NORMAL");
    const share = steady.length > 0 ? Math.round((normal.length * PERMILLE) / steady.length) : 0;
    if (share < t.minNormalPermille) incomplete.push("GOVERNOR_NOT_NORMAL");
    const lags = nums(normal.map((r) => r["channels.population.lagMs"])).sort((a, b) => a - b);
    const lag = lags.length > 0 ? percentile(lags, P95) : null;
    check("lagMs p95 (NORMAL)", lag, t.lagP95Ms, lag === null ? "INFO" : lag <= t.lagP95Ms ? "PASS" : "FAIL",
      `NORMAL rows ${share} permille`);

    const size = profile && isNum(profile["population.size"]) ? profile["population.size"] : t.size;
    const over = steady.filter((r) => isNum(r["channels.population.queue"]) && r["channels.population.queue"] > size);
    check("queue <= size", maxOf(steady.map((r) => r["channels.population.queue"])), size,
      over.length === 0 ? "PASS" : "FAIL");
    const dirty = nums(steady.map((r) => r["channels.population.dirty"]));
    if (dirty.length >= 4) {
      const q = Math.floor(dirty.length / 4);
      const first = median(dirty.slice(0, q));
      const lastQ = median(dirty.slice(dirty.length - q));
      const perSlice = profile && isNum(profile["population.flushRowsPerSlice"]) ? profile["population.flushRowsPerSlice"]
        : t.flushRowsPerSlice;
      const limit = Math.max(perSlice, t.dirtyGrowthFactor * first);
      check("dirty last quarter median", lastQ, limit, lastQ <= limit ? "PASS" : "FAIL",
        lastQ <= limit ? null : "DIRTY_GROWING");
    } else check("dirty last quarter median", null, null, "INFO", "fewer than 4 steady rows");

    const panel = rows.filter((r) => r["views.population"] === true);
    if (panel.length > 0) {
      const p0 = panel[0];
      const p1 = panel[panel.length - 1];
      const ff = (p1["populationView.counters.flushFailed"] || 0) - (p0["populationView.counters.flushFailed"] || 0);
      check("flushFailed growth", ff, 0, ff > 0 ? "FAIL" : "PASS");
      const srf = p1["populationView.counters.stationsReadFailed"] || 0;
      check("stationsReadFailed", srf, 0, srf > 0 ? "WARN" : "PASS");
      check("seeded", p1["populationView.counters.seeded"], null, "INFO");
    } else check("population panel", null, null, "INFO", "panel never answered");

    const mem = maxOf(rows.map((r) => r["memory.approxBytes"]));
    if (mem === null) incomplete.push("NO_MEMORY_PROBE");
    check("population.memory approxBytes", mem, t.memoryBytes,
      mem === null ? "INFO" : mem <= t.memoryBytes ? "PASS" : "FAIL");

    if (typeof phase.logText === "string") {
      const startAt = isNum(rows[0].startedAtMs) ? rows[0].startedAtMs : null;
      const scan = scanSlowLines(phase.logText,
        { warmupEndsAtMs: startAt === null ? -Infinity : startAt + t.warmupMin * MS_PER_MINUTE });
      check("slow lines (steady)", scan.steady.length, 0, scan.steady.length === 0 ? "PASS" : "FAIL",
        scan.steady.slice(0, 3).join(" | ") || null);
      check("slow lines (boot / warmup)", scan.boot.length + scan.warmup.length, null, "INFO");
      if (life && phase.logText.includes(SHIM_MARK)) {
        check("sqlite driver", "node:sqlite shim", null, "WARN", "SHIM_DRIVER");
      }
    } else {
      check("slow lines", null, null, "INFO", "not checked (no log.txt)");
      incomplete.push("NO_LOG");
    }

    check("contextMs p95 / max", `${lastRow["channels.population.contextMs.p95"]} / `
      + `${lastRow["channels.population.contextMs.max"]}`, null, "INFO");
    check("routeMs p95 / max", `${lastRow["channels.population.routeMs.p95"]} / `
      + `${lastRow["channels.population.routeMs.max"]}`, null, "INFO");
  }

  if (life) {
    const extra = lifecycleChecks(role, rows, t);
    checks.push(...extra.checks);
    for (const r of extra.incomplete) if (!incomplete.includes(r)) incomplete.push(r);
  }

  if (role === "live") {
    const audited = rows.filter((r) => isNum(r["channels.highsecLife.trafficPilotDuplicates"]));
    if (audited.length === 0) incomplete.push("NO_PILOT_AUDIT");
    const dup = maxOf(audited.map((r) => r["channels.highsecLife.trafficPilotDuplicates"]));
    check("trafficPilotDuplicates", dup, 0, dup === null ? "INFO" : dup > 0 ? "FAIL" : "PASS");
    const globalCap = profile ? profile["highsecLife.traffic.maxShipsGlobal"] : null;
    const sysCap = profile ? profile["highsecLife.traffic.maxShipsPerSystem"] : null;
    const liveMax = maxOf(rows.map((r) => r["channels.highsecLife.trafficLive"]));
    check("trafficLive max", liveMax, globalCap,
      liveMax === null || !isNum(globalCap) ? "INFO" : liveMax > globalCap ? "FAIL" : "PASS");
    const sysMax = maxOf(rows.map((r) => r["channels.highsecLife.trafficMaxPerSystem"]));
    check("trafficMaxPerSystem max", sysMax, sysCap,
      sysMax === null || !isNum(sysCap) ? "INFO" : sysMax > sysCap ? "FAIL" : "PASS");
    const run = longestRun(rows, (r) => isNum(r["channels.population.liveOwned"])
      && isNum(r["channels.highsecLife.trafficPilotShips"])
      && Math.abs(r["channels.population.liveOwned"] - r["channels.highsecLife.trafficPilotShips"]) > t.ownedMismatch);
    check("liveOwned vs trafficPilotShips", run, t.ownedMismatchRows, run >= t.ownedMismatchRows ? "WARN" : "PASS",
      "longest run of rows with a difference above ownedMismatch");
    const panel = rows.filter((r) => r["views.population"] === true);
    const claimed = panel.length > 0 ? panel[panel.length - 1]["populationView.counters.live.claimed"] : null;
    check("live.claimed", claimed, null, claimed === 0 ? "WARN" : "INFO", claimed === 0 ? "NO_LIVE_ACTIVITY" : null);
    check("traffic orphans", null, null, "INFO", "not in telemetry (traffic getStatus only)");
  }
  return out({ modeChangesPerHour }, heapMedian, profile);
}

function verdict(summaries, bases, thresholds) {
  const t = thresholds || THRESHOLDS;
  const byLabel = new Map(summaries.map((s) => [s.label, s]));
  const phases = summaries.map((s) => ({ ...s, incomplete: [...s.incomplete], checks: [...s.checks] }));
  const reference = phases.find((p) => p.profile) || null;
  for (const p of phases) {
    const add = (name, value, limit, result, note) => p.checks.push({ name, value: value === undefined ? null : value,
      limit: limit === undefined ? null : limit, result, ...(note ? { note } : {}) });
    if (reference && p.profile && p !== reference) {
      const diff = COMMON_KEYS.filter((k) => p.profile[k] !== reference.profile[k]);
      if (diff.length > 0) {
        add("common profile", diff.join(", "), reference.label, "INFO", "differs from the first phase");
        if (!p.incomplete.includes("PROFILE_MISMATCH")) p.incomplete.push("PROFILE_MISMATCH");
      }
    }
    if (p.role === "base" || p.role === "tempo" || p.role === "nolife") continue;
    const baseLabel = (bases && bases[p.label]) || (p.role === "lifecycle" ? "N" : "0");
    const base = byLabel.get(baseLabel) || null;
    const rate = p.rates.modeChangesPerHour;
    if (!base) {
      add("governor modeChanges/h", rate, null, "INFO", `no base phase ${baseLabel}`);
      add("heap afterMajor delta", null, null, "INFO", `no base phase ${baseLabel}`);
      if (!p.incomplete.includes("MISSING_PHASE")) p.incomplete.push("MISSING_PHASE");
    } else {
      const baseRate = base.rates.modeChangesPerHour;
      if (rate === null || baseRate === null) {
        add("governor modeChanges/h", rate, baseRate, "INFO", "no data");
        if (!p.incomplete.includes("NO_GOVERNOR_DATA")) p.incomplete.push("NO_GOVERNOR_DATA");
      } else {
        const limit = baseRate + t.governorSlackPerHour;
        add("governor modeChanges/h", Math.round(rate * 100) / 100, Math.round(limit * 100) / 100,
          rate <= limit ? "PASS" : "FAIL", `base ${baseLabel} ${Math.round(baseRate * 100) / 100}/h`);
      }
      if (p.heapMedian === null || base.heapMedian === null) add("heap afterMajor delta", null, null, "INFO", "no data");
      else {
        const delta = p.heapMedian - base.heapMedian;
        add("heap afterMajor delta", delta, t.heapDeltaWarnBytes, delta > t.heapDeltaWarnBytes ? "WARN" : "PASS",
          "information only");
      }
      if (p.role === "lifecycle") {
        const own = p.checks.find((c) => c.name === "passMs p95");
        const ref = base.checks.find((c) => c.name === "passMs p95");
        const a = own ? own.value : null;
        const b = ref ? ref.value : null;
        if (!isNum(a) || !isNum(b)) {
          add("passMs p95 delta", null, t.lifeDeltaP95Ms, "INFO", `no data (base ${baseLabel})`);
        } else {
          const delta = Math.round((a - b) * 1000) / 1000;
          add("passMs p95 delta", delta, t.lifeDeltaP95Ms, delta > t.lifeDeltaP95Ms ? "WARN" : "PASS",
            `p95 ${p.label} - p95 ${baseLabel}`);
        }
      }
    }
  }
  const reasons = [];
  for (const p of phases) {
    for (const r of p.incomplete) reasons.push(`${p.label}: INCOMPLETE ${r}`);
    for (const c of p.checks) if (c.result === "FAIL") reasons.push(`${p.label}: FAIL ${c.name} = ${c.value}`);
    p.ok = p.incomplete.length === 0 && !p.checks.some((c) => c.result === "FAIL");
  }
  const lifeGate = phases.some((p) => GATES.lifecycle.includes(p.role));
  const popGate = phases.some((p) => p.role === "base" || GATES.population.includes(p.role));
  const mixed = lifeGate && popGate;
  if (mixed) reasons.push("INCOMPLETE MIXED_GATES");
  const missingRoles = mixed ? [] : (lifeGate ? GATES.lifecycle : GATES.population)
    .filter((role) => !phases.some((p) => p.role === role));
  for (const role of missingRoles) reasons.push(`INCOMPLETE MISSING_PHASE ${role}`);
  const anyIncomplete = mixed || missingRoles.length > 0 || phases.some((p) => p.incomplete.length > 0);
  const anyFail = phases.some((p) => p.checks.some((c) => c.result === "FAIL"));
  return { verdict: anyIncomplete ? "INCOMPLETE" : anyFail ? "NO_GO" : "GO", reasons, phases };
}

function withThreshold(thresholds, spec) {
  const m = /^([A-Za-z0-9]+)=(-?\d+(?:\.\d+)?)$/u.exec(String(spec));
  if (!m) return { ok: false, reason: `--threshold ${spec}: expected <name>=<number>` };
  if (!Object.prototype.hasOwnProperty.call(thresholds, m[1])) {
    return { ok: false, reason: `--threshold ${m[1]}: unknown name` };
  }
  return { ok: true, thresholds: Object.freeze({ ...thresholds, [m[1]]: Number(m[2]) }) };
}

module.exports = { THRESHOLDS, COMMON_KEYS, GATES, roleOf, summarizePhase, verdict, withThreshold, median };
