"use strict";

const { createHistogram } = require("./histogram");

const CHANNELS = Object.freeze(["tick", "gc", "process", "persistence", "journal", "capture", "telemetry",
  "scheduler", "economy", "battleResolver", "materialization", "events", "governor",
  "observer", "graph", "world", "presence", "fleets", "battle", "strategy",
  "logistics", "mining", "production", "salvage", "stations",
  "trade",
  "virtualCorps",
  "sovProjection",
  "sovReconcile",
  "sites",
  "structures",
  "hunt",
  "salvageAnomaly",
  "wormholes",
  "treasury",
  "lowsec",
  "capsuleers",
  "expeditions",
  "playerHunt",
  "fleetExposure",
  "frontChat",
  "notices",
  "battleAnnounce",
  "frontJobs",
  "warContracts",
  "killboard",
  "devIndices",
  "news",
  "eventRewards",
  "localPilots",
  "localContacts",
  "crews",
  "garrisonPatrol",
  "loyalty",
  "blockade",
  "fortress",
  "capitalLive",
  "sentries",
  "vendorPauses",
  "highsecLife",
  "freeCorps",
  "inGameMap",
  "jobBoard",
  "modSettings",
  "capsuleSweep",
  "bookmarkSiteWarp",
  "chatterAi",
  "npcVoices",
  "fame",
  "shipAi",
  "buildInputs",
  "abyssal",
  "escalations",
  "worldBosses",
  "names",
  "bounty",
  "trigBridge",
  "transit",
  "playerValue",
  "harvestRaid",
  "archaeology",
  "listeningPost",
  "situations",
  "gameMaster",
  "seasons",
  "population",
  "extraction",
  "capsuleFx",
  "perf"]);

const NAME_RE = /^[a-zA-Z][a-zA-Z0-9]*(\.[a-zA-Z0-9_]+)+$/;
const REJECTED = "telemetry.rejectedMetrics";
const MAX_REJECTED_NAMES = 16;

function channelOf(name) {
  return name.slice(0, name.indexOf("."));
}

function isMetricName(name) {
  return typeof name === "string" && NAME_RE.test(name) && CHANNELS.includes(channelOf(name));
}

function createRegistry(opts) {
  const histogramSamples = opts && opts.histogramSamples;
  const maxMetrics = opts && opts.maxMetrics;
  if (!Number.isSafeInteger(histogramSamples) || histogramSamples < 1) throw new RangeError("histogramSamples");
  if (!Number.isSafeInteger(maxMetrics) || maxMetrics < 1) throw new RangeError("maxMetrics");
  const summariesPerRead = opts && Number.isSafeInteger(opts.summariesPerRead) && opts.summariesPerRead >= 1
    ? opts.summariesPerRead : Infinity;
  const counters = new Map();
  const gauges = new Map();
  const histograms = new Map();
  const summaries = new Map();
  const scratch = new Float64Array(histogramSamples);
  const readStats = { reads: 0, summarized: 0, reused: 0, deferred: 0 };
  let rejected = 0;
  let size = 0;
  const rejectedNames = new Map();

  function noteRejected(name, reason) {
    const key = typeof name === "string" ? name.slice(0, 120) : `<${typeof name}>`;
    if (rejectedNames.size < MAX_REJECTED_NAMES && !rejectedNames.has(key)) rejectedNames.set(key, reason);
  }

  function slot(map, name, create) {
    const existing = map.get(name);
    if (existing !== undefined) return existing;
    if (!isMetricName(name) || name === REJECTED || size >= maxMetrics
      || counters.has(name) || gauges.has(name) || histograms.has(name)) {
      rejected += 1;
      noteRejected(name, !isMetricName(name) || name === REJECTED ? "BAD_NAME"
        : size >= maxMetrics ? "REGISTRY_FULL" : "KIND_CONFLICT");
      return undefined;
    }
    const value = create();
    map.set(name, value);
    size += 1;
    return value;
  }

  function count(name, n = 1) {
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return false;
    if (slot(counters, name, () => 0) === undefined) return false;
    counters.set(name, counters.get(name) + n);
    return true;
  }

  function gauge(name, value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return false;
    if (slot(gauges, name, () => 0) === undefined) return false;
    gauges.set(name, value);
    return true;
  }

  function observe(name, value, atMs) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return false;
    const histogram = slot(histograms, name, () => createHistogram(histogramSamples));
    if (histogram === undefined) return false;
    histogram.record(value, atMs);
    return true;
  }

  function read() {
    const out = { counters: { [REJECTED]: rejected }, gauges: {}, histograms: {} };
    for (const [name, value] of counters) out.counters[name] = value;
    for (const [name, value] of gauges) out.gauges[name] = value;
    readStats.reads += 1;
    const due = [];
    let summarized = 0;
    let reused = 0;
    const fresh = (name, histogram) => {
      const summary = histogram.summarize(scratch);
      summaries.set(name, { count: histogram.count(), summary, read: readStats.reads });
      summarized += 1;
      return summary;
    };
    for (const [name, histogram] of histograms) {
      const cached = summaries.get(name);
      if (cached === undefined) {
        out.histograms[name] = fresh(name, histogram);
      } else if (cached.count === histogram.count()) {
        out.histograms[name] = cached.summary;
        reused += 1;
      } else {
        out.histograms[name] = cached.summary;
        due.push(name);
      }
    }
    if (due.length > summariesPerRead) due.sort((a, b) => summaries.get(a).read - summaries.get(b).read);
    const take = Math.min(due.length, summariesPerRead);
    for (let i = 0; i < take; i += 1) out.histograms[due[i]] = fresh(due[i], histograms.get(due[i]));
    readStats.summarized = summarized;
    readStats.reused = reused;
    readStats.deferred = due.length - take;
    return out;
  }

  function lastReadStats() {
    return { summarized: readStats.summarized, reused: readStats.reused, deferred: readStats.deferred };
  }

  function gaugeValue(name) {
    return gauges.has(name) ? gauges.get(name) : null;
  }

  function rejectedNameList() {
    return [...rejectedNames].map(([name, reason]) => ({ name, reason }));
  }

  return { count, gauge, gaugeValue, observe, read, lastReadStats, rejectedNames: rejectedNameList, counter: (name) => (name === REJECTED ? rejected : counters.get(name) || 0) };
}

module.exports = { CHANNELS, REJECTED, isMetricName, channelOf, createRegistry };
