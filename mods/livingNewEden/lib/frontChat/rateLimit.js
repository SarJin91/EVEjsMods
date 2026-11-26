"use strict";

const WINDOW_MS = 60000;

function positiveInt(value, fallback) {
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function createRateLimiter(opts) {
  const cooldownMs = positiveInt(opts && opts.cooldownMs, 1);
  const maxPerMinute = positiveInt(opts && opts.maxPerMinute, 1);
  const maxTracked = positiveInt(opts && opts.maxTracked, 1);
  const lastAt = new Map();
  const window = [];

  function prune(now) {
    for (const [id, at] of lastAt) {
      if (now - at < cooldownMs) break;
      lastAt.delete(id);
    }
    while (lastAt.size > maxTracked) lastAt.delete(lastAt.keys().next().value);
    while (window.length > 0 && window[0] <= now - WINDOW_MS) window.shift();
  }

  function take(characterId, now) {
    prune(now);
    const last = lastAt.get(characterId);
    if (last !== undefined && now - last < cooldownMs) {
      return { ok: false, reason: "COOLDOWN", waitMs: Math.min(cooldownMs, Math.max(0, cooldownMs - (now - last))) };
    }
    if (window.length >= maxPerMinute) {
      return { ok: false, reason: "GLOBAL", waitMs: Math.min(WINDOW_MS, Math.max(0, window[0] + WINDOW_MS - now)) };
    }
    window.push(now);
    lastAt.delete(characterId);
    lastAt.set(characterId, now);
    while (lastAt.size > maxTracked) lastAt.delete(lastAt.keys().next().value);
    return { ok: true };
  }

  return Object.freeze({ take, size: () => lastAt.size });
}

function createLiveRateLimiter(optsOf, versionOf) {
  const same = (a, b) => a.cooldownMs === b.cooldownMs && a.maxPerMinute === b.maxPerMinute
    && a.maxTracked === b.maxTracked;
  let version = versionOf();
  let opts = optsOf();
  let limiter = createRateLimiter(opts);

  function current() {
    const v = versionOf();
    if (v === version) return limiter;
    version = v;
    const next = optsOf();
    if (!same(next, opts)) {
      opts = next;
      limiter = createRateLimiter(next);
    }
    return limiter;
  }

  return Object.freeze({ take: (characterId, now) => current().take(characterId, now), size: () => limiter.size() });
}

module.exports = { WINDOW_MS, createRateLimiter, createLiveRateLimiter };
