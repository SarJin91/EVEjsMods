"use strict";

const { snapshotOf, viewOf } = require("../freeCorpsScale/extract");

const HIST_KEYS = Object.freeze(["samples", "capacity", "p95", "max"]);
const POPULATION_HISTOGRAMS = Object.freeze(["passMs", "warmupPassMs", "flushMs", "warmupFlushMs", "contextMs",
  "routeMs"]);
const POPULATION_SCALARS = Object.freeze(["lagMs", "queue", "dirty", "pilots", "near", "live", "liveOwned", "events",
  "flushRows",
  "away", "rookies", "veterans"]);
const TRAFFIC_GAUGES = Object.freeze(["trafficLive", "trafficPilotShips", "trafficPilotDuplicates",
  "trafficMaxPerSystem"]);
const MEMORY_PROBE = "population.memory";
const POPULATION_SERVICE = "population";
const REJECTED_PREFIXES = Object.freeze(["population.", "highsecLife."]);

const PROFILE_KEYS = Object.freeze(["population.enabled", "population.size", "population.gateWarmupMs",
  "population.passIntervalMs", "population.flushRowsPerSlice", "population.near.enabled",
  "population.live.localEnabled", "population.live.trafficEnabled", "population.context.enabled",
  "highsecLife.enabled", "highsecLife.civilians.enabled", "highsecLife.traffic.enabled",
  "highsecLife.traffic.maxShipsGlobal", "highsecLife.traffic.maxShipsPerSystem", "localPilots.enabled",
  "telemetry.histogramSamples",
  "population.maxPassMs", "population.maxEventsPerPass", "population.maxRoutesPerPass",
  "population.standings.enabled", "population.corps.enabled", "population.lifecycle.enabled",
  "population.lifecycle.careerEnabled", "population.lifecycle.corpsActivityEnabled"]);
const PANEL_COUNTERS = Object.freeze(["flushFailed", "seeded", "stationsReadFailed", "context.sourceFailed",
  "live.claimed", "live.claimRefused", "live.ownTimeout", "live.KILLED", "live.STUCK", "live.REFUSED",
  "loadNormalized", "lifecycle.away", "lifecycle.awayCapped", "lifecycle.returned", "lifecycle.quit",
  "lifecycle.reborn", "lifecycle.rookieFallback", "lifecycle.wakeFailed", "lifecycle.promoted", "lifecycle.homeMoved",
  "lifecycle.careerSeeded", "corps.founded", "corps.dissolved", "corps.dissolvedInactive", "corps.skippedInactive"]);
const PANEL_STATES = Object.freeze(["DOCKED", "ACTIVE", "TRAVEL", "POD", "AWAY"]);
const PANEL_LIFECYCLE = Object.freeze(["away", "awayPermille", "awayCap", "byCareer.UNASSIGNED", "byCareer.ROOKIE",
  "byCareer.PILOT", "byCareer.SEASONED", "byCareer.VETERAN", "corps.open"]);
const PANEL_TIERS = Object.freeze(["live", "near", "systemsLive", "systemsNear"]);

const hist = (prefix) => HIST_KEYS.map((k) => `${prefix}.${k}`);
const each = (prefix, names) => names.map((n) => `${prefix}.${n}`);

const SNAPSHOT_PATHS = Object.freeze([
  "seq", "capturedAtMs", "startedAtMs",
  "process.pid", "process.uptimeSeconds", "process.heapUsedBytes", "process.heap.afterMajor.lastUsedBytes",
  "gc.kinds.major.count", "gc.kinds.major.maxMs",
  "governor.mode", "channels.governor.modeChanges",
  ...POPULATION_HISTOGRAMS.flatMap((h) => hist(`channels.population.${h}`)),
  ...each("channels.population", POPULATION_SCALARS),
  ...each("channels.highsecLife", TRAFFIC_GAUGES),
]);

const VIEW_KEYS = Object.freeze([
  "views.status", "views.population", "status.services.population.state",
  ...each("status.config", PROFILE_KEYS),
  "populationView.state", ...each("populationView.byState", PANEL_STATES),
  ...each("populationView.tiers", PANEL_TIERS), ...each("populationView.counters", PANEL_COUNTERS),
  "populationView.generatedAt", "populationView.lifecycle", ...each("populationView.lifecycle", PANEL_LIFECYCLE),
]);

const FIELDS = Object.freeze([...SNAPSHOT_PATHS, "memory.entries", "memory.approxBytes", ...VIEW_KEYS]);

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function rawAt(obj, dotted) {
  let cur = obj;
  for (const part of dotted.split(".")) {
    if (!isObject(cur) || !Object.prototype.hasOwnProperty.call(cur, part)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function scalar(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" || typeof v === "boolean") return v;
  return null;
}

function alarmsOf(snapshot) {
  if (!Array.isArray(snapshot.alarms)) return [];
  const out = [];
  for (const a of snapshot.alarms) {
    if (isObject(a) && typeof a.id === "string" && typeof a.level === "string") out.push(`${a.level}:${a.id}`);
  }
  return [...new Set(out)].sort();
}

function rejectedOf(snapshot) {
  const list = rawAt(snapshot, "telemetry.rejectedNames");
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const r of list) {
    const name = isObject(r) ? r.name : r;
    if (typeof name === "string" && REJECTED_PREFIXES.some((p) => name.startsWith(p))) out.push(name);
  }
  return [...new Set(out)].sort();
}

function memoryOf(row, snapshot) {
  const list = rawAt(snapshot, "moduleCost.memory");
  const probe = Array.isArray(list) ? list.find((m) => isObject(m) && m.name === MEMORY_PROBE) : null;
  row["memory.entries"] = probe ? scalar(probe.entries) : null;
  row["memory.approxBytes"] = probe ? scalar(probe.approxBytes) : null;
}

function viewFields(row, fetched) {
  for (const key of VIEW_KEYS) row[key] = null;
  const status = viewOf(fetched.status);
  row["views.status"] = status !== null;
  if (status) {
    const list = isObject(status.services) && Array.isArray(status.services.services) ? status.services.services : [];
    const svc = list.find((s) => isObject(s) && s.name === POPULATION_SERVICE);
    row["status.services.population.state"] = svc ? scalar(svc.state) : null;
    const values = isObject(status.config) && isObject(status.config.values) ? status.config.values : null;
    if (values) for (const key of PROFILE_KEYS) row[`status.config.${key}`] = scalar(rawAt(values, key));
  }
  const pop = viewOf(fetched.population);
  row["views.population"] = pop !== null;
  if (pop) {
    const st = isObject(pop.status) ? pop.status : {};
    row["populationView.state"] = scalar(st.state);
    for (const s of PANEL_STATES) row[`populationView.byState.${s}`] = scalar(rawAt(pop, `byState.${s}`));
    for (const t of PANEL_TIERS) row[`populationView.tiers.${t}`] = scalar(rawAt(pop, `tiers.${t}`));
    const counters = isObject(pop.counters) ? pop.counters : {};
    for (const c of PANEL_COUNTERS) {
      row[`populationView.counters.${c}`] = Object.prototype.hasOwnProperty.call(counters, c) ? scalar(counters[c]) : 0;
    }
    row["populationView.generatedAt"] = scalar(pop.generatedAt);
    row["populationView.lifecycle"] = isObject(pop.lifecycle);
    for (const k of PANEL_LIFECYCLE) row[`populationView.lifecycle.${k}`] = scalar(rawAt(pop, `lifecycle.${k}`));
  }
}

function extractRow(fetched) {
  const input = isObject(fetched) && Object.prototype.hasOwnProperty.call(fetched, "telemetry") ? fetched
    : { telemetry: fetched };
  const snapshot = snapshotOf(input.telemetry);
  if (!isObject(snapshot)) return null;
  const row = {};
  for (const p of SNAPSHOT_PATHS) row[p] = scalar(rawAt(snapshot, p));
  memoryOf(row, snapshot);
  row.rejectedNames = rejectedOf(snapshot);
  row.alarms = alarmsOf(snapshot);
  viewFields(row, input);
  row.viewErrors = Number.isSafeInteger(input.viewErrors) && input.viewErrors > 0 ? input.viewErrors : 0;
  return row;
}

module.exports = { FIELDS, PROFILE_KEYS, PANEL_COUNTERS, POPULATION_HISTOGRAMS, TRAFFIC_GAUGES, MEMORY_PROBE,
  extractRow, snapshotOf, viewOf };
