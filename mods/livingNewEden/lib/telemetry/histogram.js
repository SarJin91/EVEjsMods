"use strict";

const P50 = 0.5;
const P95 = 0.95;
const ROUND_DIGITS = 3;
const ROUND_SCALE = 10 ** ROUND_DIGITS;

function round(value) {
  return Math.round(value * ROUND_SCALE) / ROUND_SCALE;
}

function percentile(sortedAsc, fraction) {
  const n = sortedAsc ? sortedAsc.length : 0;
  if (n <= 0) return 0;
  const index = Math.max(0, Math.min(n - 1, Math.ceil(n * fraction) - 1));
  return sortedAsc[index];
}

function emptySummary(capacity) {
  return { samples: 0, capacity, spanMs: 0, avg: 0, p50: 0, p95: 0, max: 0 };
}

function createHistogram(capacity) {
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError(`histogram capacity ${capacity}`);
  const values = new Float64Array(capacity);
  const times = new Float64Array(capacity);
  let next = 0;
  let filled = 0;
  let total = 0;
  let timedCount = 0;

  function record(value, atMs) {
    if (typeof value !== "number" || !(value >= 0) || value === Infinity) return;
    values[next] = value;
    const timed = typeof atMs === "number" && Number.isFinite(atMs);
    times[next] = timed ? atMs : NaN;
    next = (next + 1) % capacity;
    if (filled < capacity) filled += 1;
    total += 1;
    if (timed) timedCount += 1;
  }

  function spanMs() {
    if (timedCount === 0 || filled < 2) return 0;
    const oldest = filled < capacity ? 0 : next;
    const newest = (next - 1 + capacity) % capacity;
    const span = times[newest] - times[oldest];
    return Number.isFinite(span) && span > 0 ? round(span) : 0;
  }

  function summarize(scratch) {
    if (filled === 0) return emptySummary(capacity);
    let sorted;
    if (scratch instanceof Float64Array && scratch.length >= filled) {
      sorted = scratch.subarray(0, filled);
      sorted.set(values.subarray(0, filled));
      sorted.sort();
    } else {
      sorted = values.slice(0, filled).sort();
    }
    let sum = 0;
    for (let i = 0; i < filled; i += 1) sum += sorted[i];
    return {
      samples: filled,
      capacity,
      spanMs: spanMs(),
      avg: round(sum / filled),
      p50: round(percentile(sorted, P50)),
      p95: round(percentile(sorted, P95)),
      max: round(sorted[filled - 1]),
    };
  }

  return { record, summarize, count: () => total };
}

module.exports = { createHistogram, percentile, emptySummary, round };
