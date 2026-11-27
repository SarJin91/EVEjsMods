"use strict";

const { percentile } = require("../../../lib/telemetry/histogram");

const DAY_MS = 86400000;
const PERMILLE = 1000;
const P95 = 0.95;
const QUARTER = 4;
const CAREERS = Object.freeze(["ROOKIE", "PILOT", "SEASONED", "VETERAN"]);
const TUNING_NOTE = "tuning = an operator decision";
const SKIPPED_NOTE = "AWAY + ROOKIE + another region; not the count of inactive pilots";

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const nums = (list) => list.filter(isNum);
const maxOf = (list) => (nums(list).length > 0 ? Math.max(...nums(list)) : null);
const round1 = (v) => (v === null ? null : Math.round(v * 10) / 10);

function median(values) {
  const v = nums(values).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function panelRows(rows) {
  const list = rows.filter((r) => r["views.population"] === true && isNum(r["populationView.generatedAt"]))
    .sort((a, b) => a["populationView.generatedAt"] - b["populationView.generatedAt"]);
  const g0 = list.length > 0 ? list[0]["populationView.generatedAt"] : 0;
  return list.map((r) => ({ row: r, day: (r["populationView.generatedAt"] - g0) / DAY_MS }));
}

const counter = (r, name) => r[`populationView.counters.${name}`];

function growth(list, name) {
  if (list.length === 0) return null;
  const a = counter(list[0].row, name);
  const b = counter(list[list.length - 1].row, name);
  return isNum(a) && isNum(b) ? b - a : null;
}

function perDay(list, name) {
  if (list.length < 2) return null;
  const days = list[list.length - 1].day - list[0].day;
  const d = growth(list, name);
  return days > 0 && d !== null ? round1(d / days) : null;
}

function collector() {
  const checks = [];
  const incomplete = [];
  const check = (name, value, limit, result, note) => checks.push({ name, value: value === undefined ? null : value,
    limit: limit === undefined ? null : limit, result, ...(note ? { note } : {}) });
  const flag = (reason) => {
    if (!incomplete.includes(reason)) incomplete.push(reason);
  };
  return { checks, incomplete, check, flag };
}

function summarizeTempo(rows, profile, t) {
  const { checks, incomplete, check, flag } = collector();
  const size = profile && isNum(profile["population.size"]) ? profile["population.size"] : t.size;
  const panel = panelRows(rows);
  const days = panel.length > 0 ? panel[panel.length - 1].day : 0;
  check("tempo days", round1(days), t.tempoMinDays, days >= t.tempoMinDays ? "PASS" : "INFO");
  if (days < t.tempoMinDays) flag("TOO_SHORT");

  const lags = nums(rows.filter((r) => r["governor.mode"] === "NORMAL").map((r) => r["channels.population.lagMs"]))
    .sort((a, b) => a - b);
  const lag = lags.length > 0 ? percentile(lags, P95) : null;
  check("lagMs p95 (NORMAL)", lag, t.tempoLagP95Ms, lag !== null && lag <= t.tempoLagP95Ms ? "PASS" : "INFO",
    lag === null ? "no data" : null);
  if (lag !== null && lag > t.tempoLagP95Ms) flag("TEMPO_LAGGING");

  const pilots = rows.map((r) => r["channels.population.pilots"]).filter(isNum);
  const changed = pilots.filter((p) => p !== size);
  check("pilots constant", changed.length > 0 ? changed[0] : pilots.length > 0 ? size : null, size,
    pilots.length === 0 ? "INFO" : changed.length > 0 ? "FAIL" : "PASS", changed.length > 0 ? "PILOTS_CHANGED" : null);

  const win = panel.filter((p) => p.day >= t.awayFromDay);
  if (win.length < t.minTempoRows) flag("TEMPO_ROWS");
  const away = median(win.map((p) => p.row["populationView.lifecycle.awayPermille"]));
  check("away permille (median)", away, `${t.awayMinPermille}-${t.awayMaxPermille}`, away === null ? "INFO"
    : away >= t.awayMinPermille && away <= t.awayMaxPermille ? "PASS" : "FAIL", TUNING_NOTE);
  const reborn = perDay(win, "lifecycle.reborn");
  check("reborn per day", reborn, `${t.rebornMinPerDay}-${t.rebornMaxPerDay}`, reborn === null ? "INFO"
    : reborn >= t.rebornMinPerDay && reborn <= t.rebornMaxPerDay ? "PASS" : "WARN", TUNING_NOTE);
  for (const name of ["returned", "away", "promoted", "homeMoved"]) {
    check(`${name} per day`, perDay(win, `lifecycle.${name}`), null, "INFO");
  }

  const wake = growth(panel, "lifecycle.wakeFailed");
  check("wakeFailed growth", wake, 0, wake === null ? "INFO" : wake > 0 ? "FAIL" : "PASS");
  for (const name of ["rookieFallback", "awayCapped"]) {
    const g = growth(panel, `lifecycle.${name}`);
    check(`${name} growth`, g, 0, g === null ? "INFO" : g > 0 ? "WARN" : "PASS");
  }

  const last = panel.length > 0 ? panel[panel.length - 1].row : null;
  const unassigned = last ? last["populationView.lifecycle.byCareer.UNASSIGNED"] : null;
  const unassignedPm = isNum(unassigned) && size > 0 ? Math.round((unassigned * PERMILLE) / size) : null;
  check("unassigned permille", unassignedPm, t.unassignedMaxPermille, unassignedPm === null ? "INFO"
    : unassignedPm > t.unassignedMaxPermille ? "WARN" : "PASS");
  const careers = last && size > 0 ? CAREERS.map((c) => {
    const v = last[`populationView.lifecycle.byCareer.${c}`];
    return `${c} ${isNum(v) ? Math.round((v * PERMILLE) / size) : "-"}`;
  }).join(" / ") : null;
  check("careers permille", careers, null, "INFO");

  const opens = panel.map((p) => p.row["populationView.lifecycle.corps.open"]);
  if (nums(opens).length === 0) {
    flag("NO_CORPS");
    check("corps open ratio", null, t.corpsOpenMinRatio, "INFO", "no corps block in the panel");
  } else {
    const q = Math.max(1, Math.floor(panel.length / QUARTER));
    const lastQ = median(opens.slice(panel.length - q));
    const max = maxOf(opens);
    const ratio = max > 0 && lastQ !== null ? Math.round((lastQ / max) * 1000) / 1000 : null;
    check("corps open ratio", ratio, t.corpsOpenMinRatio, ratio === null ? "INFO"
      : ratio < t.corpsOpenMinRatio ? "WARN" : "PASS", ratio !== null && ratio < t.corpsOpenMinRatio
      ? `CORPS_SHRINKING (last quarter median ${lastQ}, max ${max})` : `last quarter median ${lastQ}, max ${max}`);
  }
  check("dissolvedInactive per day", perDay(win, "corps.dissolvedInactive"), null, "INFO");
  check("skipped candidates", growth(panel, "corps.skippedInactive"), null, "INFO", SKIPPED_NOTE);

  const mem = maxOf(rows.map((r) => r["memory.approxBytes"]));
  if (mem === null) flag("NO_MEMORY_PROBE");
  check("population.memory approxBytes", mem, t.memoryBytes, mem === null ? "INFO" : mem <= t.memoryBytes ? "PASS"
    : "FAIL");
  check("passMs p95 / max", `${maxOf(rows.map((r) => r["channels.population.passMs.p95"]))} / `
    + `${maxOf(rows.map((r) => r["channels.population.passMs.max"]))}`, null, "INFO",
  "speed > 1, raised pass limits: not a cost measurement");
  return { checks, incomplete };
}

function lifecycleChecks(role, rows, _t) {
  const { checks, incomplete, check, flag } = collector();
  const panel = panelRows(rows);
  if (panel.length === 0) {
    flag("NO_PANEL");
    check("population panel (life cycle)", null, null, "INFO", "panel never answered");
    return { checks, incomplete };
  }
  if (role === "lifecycle") {
    const block = panel[panel.length - 1].row["populationView.lifecycle"] === true;
    check("lifecycle block", block, true, block ? "PASS" : "FAIL");
    const wake = growth(panel, "lifecycle.wakeFailed");
    check("wakeFailed growth", wake, 0, wake === null ? "INFO" : wake > 0 ? "FAIL" : "PASS");
    const capped = growth(panel, "lifecycle.awayCapped");
    check("awayCapped growth", capped, 0, capped === null ? "INFO" : capped > 0 ? "WARN" : "PASS");
  } else {
    const bad = panel.filter((p) => isNum(p.row["populationView.byState.AWAY"])
      || p.row["populationView.lifecycle"] === true);
    check("AWAY with the flag off", bad.length, 0, bad.length > 0 ? "FAIL" : "PASS",
      bad.length > 0 ? "AWAY_WITH_FLAG_OFF" : null);
    check("loadNormalized", counter(panel[0].row, "loadNormalized"), null, "INFO",
      "AWAY pilots sent home at load");
  }
  return { checks, incomplete };
}

module.exports = { summarizeTempo, lifecycleChecks };
