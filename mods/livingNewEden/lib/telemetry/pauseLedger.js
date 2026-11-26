"use strict";

const RING_CAPACITY = 16;
const EXCUSE_WINDOW_MS = 60000;

function finite(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function createPauseLedger(options) {
  const maxExcuseMs = finite(options && options.maxExcuseMs) && options.maxExcuseMs > 0 ? options.maxExcuseMs : 0;
  const perMinute = finite(options && options.perMinute) && options.perMinute > 0 ? Math.floor(options.perMinute) : 0;
  const starts = new Array(RING_CAPACITY).fill(0);
  const ends = new Array(RING_CAPACITY).fill(0);
  let next = 0;
  let filled = 0;
  const excusedAt = [];

  function add(pause) {
    if (!pause || !finite(pause.startMs) || !finite(pause.endMs) || pause.endMs <= pause.startMs) return false;
    starts[next] = pause.startMs;
    ends[next] = Math.min(pause.endMs, pause.startMs + maxExcuseMs);
    next = (next + 1) % RING_CAPACITY;
    if (filled < RING_CAPACITY) filled += 1;
    return true;
  }

  function overlapMs(fromMs, toMs) {
    if (!finite(fromMs) || !finite(toMs) || toMs <= fromMs) return 0;
    let sum = 0;
    for (let i = 0; i < filled; i += 1) {
      const lo = Math.max(fromMs, starts[i]);
      const hi = Math.min(toMs, ends[i]);
      if (hi > lo) sum += hi - lo;
    }
    return Math.min(sum, toMs - fromMs);
  }

  function admitExcuse(atMs) {
    if (!finite(atMs)) return false;
    while (excusedAt.length > 0 && excusedAt[0] <= atMs - EXCUSE_WINDOW_MS) excusedAt.shift();
    if (excusedAt.length >= perMinute) return false;
    excusedAt.push(atMs);
    return true;
  }

  return { add, overlapMs, admitExcuse, size: () => filled };
}

module.exports = { createPauseLedger, RING_CAPACITY, EXCUSE_WINDOW_MS };
