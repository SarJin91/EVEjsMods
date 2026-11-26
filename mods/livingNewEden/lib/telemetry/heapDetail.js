"use strict";

const { round } = require("./histogram");

const STAT_FIELDS = Object.freeze([
  ["limitBytes", "heap_size_limit"],
  ["totalBytes", "total_heap_size"],
  ["usedBytes", "used_heap_size"],
  ["availableBytes", "total_available_size"],
  ["mallocedBytes", "malloced_memory"],
  ["externalBytes", "external_memory"],
  ["nativeContexts", "number_of_native_contexts"],
  ["detachedContexts", "number_of_detached_contexts"],
]);

function noop() {}

function num(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function createHeapDetail(deps) {
  const v8Api = deps && deps.v8Api;
  const ringSize = deps && Number.isSafeInteger(deps.ringSize) && deps.ringSize > 0 ? deps.ringSize : 1;
  const clock = deps && deps.clock && typeof deps.clock.now === "function" ? deps.clock : { now: () => null };
  const onError = deps && typeof deps.onError === "function" ? deps.onError : noop;
  const charactersNow = deps && typeof deps.charactersNow === "function" ? deps.charactersNow : null;
  const ring = [];
  let next = 0;
  const after = { count: 0, lastUsedBytes: null, lastAtMs: null, lastPauseMs: null, minUsedBytes: null,
    maxUsedBytes: null };

  function failed() {
    try {
      onError();
    } catch (_err) {
    }
  }

  function heapStatistics() {
    try {
      const stats = v8Api.getHeapStatistics();
      return stats && typeof stats === "object" ? stats : null;
    } catch (_err) {
      failed();
      return null;
    }
  }

  function spaces() {
    const out = {};
    let list = null;
    try {
      list = v8Api.getHeapSpaceStatistics();
    } catch (_err) {
      failed();
      return out;
    }
    if (!Array.isArray(list)) return out;
    for (const space of list) {
      if (!space || typeof space.space_name !== "string") continue;
      out[space.space_name] = { usedBytes: num(space.space_used_size), sizeBytes: num(space.space_size),
        availableBytes: num(space.space_available_size) };
    }
    return out;
  }

  function characters() {
    try {
      const value = charactersNow();
      return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
    } catch (_err) {
      failed();
      return null;
    }
  }

  function noteMajor(pauseMs) {
    const stats = heapStatistics();
    const usedBytes = stats === null ? null : num(stats.used_heap_size);
    const limitBytes = stats === null ? null : num(stats.heap_size_limit);
    let atMs = null;
    try {
      atMs = num(clock.now());
    } catch (_err) {
      failed();
    }
    const pause = num(pauseMs) === null ? null : round(pauseMs);
    after.count += 1;
    after.lastAtMs = atMs;
    after.lastPauseMs = pause;
    after.lastUsedBytes = usedBytes;
    if (usedBytes !== null) {
      if (after.minUsedBytes === null || usedBytes < after.minUsedBytes) after.minUsedBytes = usedBytes;
      if (after.maxUsedBytes === null || usedBytes > after.maxUsedBytes) after.maxUsedBytes = usedBytes;
      const entry = charactersNow === null ? [atMs, usedBytes, pause] : [atMs, usedBytes, pause, characters()];
      if (ring.length < ringSize) ring.push(entry);
      else ring[next] = entry;
      next = (next + 1) % ringSize;
    }
    return { usedBytes, limitBytes };
  }

  function orderedRing() {
    if (ring.length < ringSize) return ring.map((e) => e.slice());
    const out = [];
    for (let i = 0; i < ring.length; i += 1) out.push(ring[(next + i) % ringSize].slice());
    return out;
  }

  function read() {
    const stats = heapStatistics();
    const heap = {};
    for (const [field, v8Field] of STAT_FIELDS) heap[field] = stats === null ? null : num(stats[v8Field]);
    heap.spaces = spaces();
    heap.afterMajor = { ...after, ring: orderedRing() };
    return heap;
  }

  return Object.freeze({ noteMajor, read });
}

module.exports = { createHeapDetail, STAT_FIELDS };
