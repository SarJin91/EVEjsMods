"use strict";

const { round } = require("./histogram");

const MS_PER_MIN = 60000;
const MIN_SPAN_MS = 1000;
const POLLER_PREFIX = "poller:";
const SCHED_PREFIX = "sched:";

function isPollerLabel(label) {
  if (label.startsWith(POLLER_PREFIX)) return true;
  const slash = label.indexOf("/");
  const colon = label.indexOf(":");
  return slash > 0 && (colon < 0 || slash < colon);
}

function moduleOf(label) {
  if (label.startsWith(POLLER_PREFIX)) return "poller";
  const slash = label.indexOf("/");
  const colon = label.indexOf(":");
  if (slash > 0 && (colon < 0 || slash < colon)) return label.slice(0, slash);
  if (colon < 0) return label;
  const rest = label.slice(colon + 1);
  const dot = rest.indexOf(".");
  return `${label.slice(0, colon)}:${dot < 0 ? rest : rest.slice(0, dot)}`;
}

function isSummed(label) {
  return isPollerLabel(label) || label.startsWith(SCHED_PREFIX);
}

function byCost(a, b) {
  if (b.msPerMin !== a.msPerMin) return b.msPerMin - a.msPerMin;
  const x = a.label || a.module;
  const y = b.label || b.module;
  if (x < y) return -1;
  return x > y ? 1 : 0;
}

function createCostLedger(s) {
  const bucketMs = s.bucketMs;
  const n = s.windowMinutes;
  const maxLabels = s.maxLabels;
  const maxPollerLabels = Number.isSafeInteger(s.maxPollerLabels) ? s.maxPollerLabels : maxLabels;
  const topN = s.topN;
  const budgetPerBucket = (s.moduleMsPerMin * bucketMs) / MS_PER_MIN;
  const ring = [];
  for (let i = 0; i < n; i += 1) {
    ring.push({ id: -1, labels: new Map(), summed: 0, otherMs: 0, otherCalls: 0, otherLabels: new Set() });
  }
  let firstId = null;

  function slotOf(id) {
    const b = ring[id % n];
    if (b.id === id) return b;
    if (b.id > id) return null;
    b.id = id;
    b.labels.clear();
    b.summed = 0;
    b.otherMs = 0;
    b.otherCalls = 0;
    b.otherLabels.clear();
    return b;
  }

  function heldBucket(id) {
    if (id < 0) return null;
    const b = ring[id % n];
    return b.id === id ? b : null;
  }

  function note(label, ms, nowMs) {
    if (typeof label !== "string" || label === "" || !(ms >= 0) || ms === Infinity || !(nowMs >= 0)) return false;
    const id = Math.floor(nowMs / bucketMs);
    if (!Number.isSafeInteger(id)) return false;
    if (firstId === null) firstId = id;
    const b = slotOf(id);
    if (b === null) return false;
    let e = b.labels.get(label);
    if (e === undefined) {
      const summed = isSummed(label);
      const full = summed ? b.summed >= maxPollerLabels : b.labels.size - b.summed >= maxLabels;
      if (full) {
        b.otherMs += ms;
        b.otherCalls += 1;
        if (b.otherLabels.size < maxLabels) b.otherLabels.add(label);
        return true;
      }
      e = { ms: 0, calls: 0, maxMs: 0 };
      b.labels.set(label, e);
      if (summed) b.summed += 1;
    }
    e.ms += ms;
    e.calls += 1;
    if (ms > e.maxMs) e.maxMs = ms;
    return false;
  }

  function overOf(b, label) {
    if (b === null) return false;
    const e = b.labels.get(label);
    return e !== undefined && e.ms > budgetPerBucket;
  }

  function read(nowMs) {
    const now = nowMs >= 0 ? nowMs : 0;
    const cur = Math.floor(now / bucketMs);
    const lo = cur - n + 1;
    const agg = new Map();
    let otherMs = 0;
    const otherLabels = new Set();
    for (const b of ring) {
      if (b.id < lo || b.id > cur) continue;
      for (const [label, e] of b.labels) {
        const a = agg.get(label);
        if (a === undefined) agg.set(label, { ms: e.ms, calls: e.calls, maxMs: e.maxMs });
        else {
          a.ms += e.ms;
          a.calls += e.calls;
          if (e.maxMs > a.maxMs) a.maxMs = e.maxMs;
        }
      }
      otherMs += b.otherMs;
      for (const label of b.otherLabels) otherLabels.add(label);
    }
    const from = firstId === null ? cur : Math.min(cur, Math.max(lo, firstId));
    const spanMs = Math.max(MIN_SPAN_MS, (cur - from) * bucketMs + (now - cur * bucketMs));
    const perMin = (ms) => round((ms * MS_PER_MIN) / spanMs);
    const lastFull = heldBucket(cur - 1);
    const labels = [];
    const sums = new Map();
    for (const [label, a] of agg) {
      labels.push({ label, module: moduleOf(label), msPerMin: perMin(a.ms), calls: a.calls, maxMs: round(a.maxMs),
        overBudget: overOf(lastFull, label) });
      if (isSummed(label)) {
        const m = moduleOf(label);
        sums.set(m, (sums.get(m) || 0) + a.ms);
      }
    }
    labels.sort(byCost);
    const modules = [...sums].map(([module, ms]) => ({ module, msPerMin: perMin(ms) })).sort(byCost);
    return { windowMs: round(spanMs), labels: labels.slice(0, topN), modules,
      other: { msPerMin: perMin(otherMs), labels: otherLabels.size } };
  }

  function overBudget(label, nowMs, windows) {
    if (!Number.isSafeInteger(windows) || windows < 1 || windows > n - 1 || !(nowMs >= 0)) return false;
    const cur = Math.floor(nowMs / bucketMs);
    for (let k = 1; k <= windows; k += 1) {
      if (!overOf(heldBucket(cur - k), label)) return false;
    }
    return true;
  }

  function inBudget(label, nowMs, windows) {
    if (!Number.isSafeInteger(windows) || windows < 1 || windows > n - 1 || !(nowMs >= 0)) return false;
    const cur = Math.floor(nowMs / bucketMs);
    for (let k = 1; k <= windows; k += 1) {
      if (overOf(heldBucket(cur - k), label)) return false;
    }
    return true;
  }

  function countOverBudget(nowMs) {
    if (!(nowMs >= 0)) return 0;
    const b = heldBucket(Math.floor(nowMs / bucketMs) - 1);
    if (b === null) return 0;
    let count = 0;
    for (const e of b.labels.values()) if (e.ms > budgetPerBucket) count += 1;
    return count;
  }

  return Object.freeze({ note, read, overBudget, inBudget, countOverBudget });
}

module.exports = { createCostLedger, moduleOf, isPollerLabel, isSummed, MS_PER_MIN };
