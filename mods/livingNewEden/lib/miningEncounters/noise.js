"use strict";

const { STATE, OUTCOME, BANDS, MINUTE_MS } = require("./schema");

const PERMILLE = 1000;
const CHANCE_KEY = Object.freeze({ highsec: "chanceHighsec", lowsec: "chanceLowsec", nullsec: "chanceNullsec" });

function isPositiveInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function createNoiseTracker(deps) {
  const S = deps && deps.config;
  if (!S || typeof S !== "object") throw new TypeError("createNoiseTracker: config (miningEncounters) required");
  const rng = deps && typeof deps.rng === "function" ? deps.rng : null;
  if (!rng) throw new TypeError("createNoiseTracker: rng required");

  const entries = new Map();
  let queue = [];
  let evicted = 0;

  function resetEntry(entry, atMs) {
    entry.state = STATE.QUIET;
    entry.noise = 0;
    entry.wavesSpawned = 0;
    entry.beltId = null;
    entry.minuteStartMs = atMs;
    entry.minuteNoise = 0;
    entry.rearm = false;
  }

  function dropFromQueue(key) {
    const at = queue.indexOf(key);
    if (at >= 0) queue.splice(at, 1);
  }

  function evictOne(keep) {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [key, entry] of entries) {
      if (key === keep || entry.state === STATE.DUE) continue;
      if (entry.lastEventAtMs < oldestAt) {
        oldestAt = entry.lastEventAtMs;
        oldestKey = key;
      }
    }
    if (oldestKey === null) return 0;
    entries.delete(oldestKey);
    evicted += 1;
    return 1;
  }

  function perEventOf(multiplierPermille) {
    if (!Number.isSafeInteger(multiplierPermille) || multiplierPermille <= PERMILLE) return S.noisePerEvent;
    return Math.max(S.noisePerEvent, Math.floor((S.noisePerEvent * multiplierPermille) / PERMILLE));
  }

  function minuteCapOf(multiplierPermille) {
    if (!Number.isSafeInteger(multiplierPermille) || multiplierPermille <= PERMILLE) return S.maxNoisePerMinute;
    return Math.max(S.maxNoisePerMinute, Math.floor((S.maxNoisePerMinute * multiplierPermille) / PERMILLE));
  }

  function noteEvent(ev) {
    if (!ev || !isPositiveInt(ev.characterId) || !isPositiveInt(ev.systemId) || !BANDS.includes(ev.band)
      || !Number.isFinite(ev.atMs)) {
      return { ok: false, reason: "BAD_EVENT" };
    }
    const key = `${ev.characterId}:${ev.systemId}`;
    const atMs = ev.atMs;
    if (ev.band === "highsec" && S.highsecEnabled !== true) {
      return { ok: true, due: false, key, reason: "HIGHSEC_OFF", added: 0, evicted: 0 };
    }
    let entry = entries.get(key);
    let evictedNow = 0;
    if (!entry) {
      entry = { characterId: ev.characterId, systemId: ev.systemId, band: ev.band, state: STATE.QUIET, noise: 0,
        minuteStartMs: atMs, minuteNoise: 0, lastEventAtMs: atMs, lastWaveAtMs: 0, wavesSpawned: 0, beltId: null, rearm: false,
        yieldKind: "" };
      entries.set(key, entry);
      if (entries.size > S.maxTrackedMiners) evictedNow = evictOne(key);
    } else if (atMs - entry.lastEventAtMs > S.idleResetMs) {
      if (entry.state === STATE.DUE) dropFromQueue(key);
      resetEntry(entry, atMs);
    }
    entry.band = ev.band;
    entry.yieldKind = typeof ev.yieldKind === "string" ? ev.yieldKind : "";
    if (atMs > entry.lastEventAtMs) entry.lastEventAtMs = atMs;
    const base = { ok: true, key, evicted: evictedNow };

    if (entry.state === STATE.EXHAUSTED) return { ...base, due: false, reason: "EXHAUSTED", added: 0 };
    if (entry.state === STATE.DUE) return { ...base, due: false, reason: "ALREADY_DUE", added: 0 };

    if (atMs - entry.minuteStartMs >= MINUTE_MS) {
      entry.minuteStartMs = atMs;
      entry.minuteNoise = 0;
    }
    const room = Math.max(0, minuteCapOf(ev.noiseMultiplierPermille) - entry.minuteNoise);
    const added = Math.min(perEventOf(ev.noiseMultiplierPermille), room);
    entry.noise += added;
    entry.minuteNoise += added;
    if (entry.noise < S.threshold) {
      return { ...base, due: false, added, ...(added === 0 ? { reason: "CAPPED" } : {}) };
    }
    if (entry.lastWaveAtMs > 0 && atMs - entry.lastWaveAtMs < S.waveCooldownMs) {
      return { ...base, due: false, added, reason: "COOLDOWN" };
    }
    if (entry.rearm === true) {
      entry.rearm = false;
      entry.state = STATE.DUE;
      queue.push(key);
      return { ...base, due: true, added };
    }
    const chance = S[CHANCE_KEY[entry.band]];
    if (!(rng() < chance)) {
      entry.noise = Math.floor(S.threshold * S.missKeepRatio);
      return { ...base, due: false, added, reason: "CHANCE_MISS" };
    }
    entry.state = STATE.DUE;
    queue.push(key);
    return { ...base, due: true, added };
  }

  function takeDue(limit) {
    const n = isPositiveInt(limit) ? Math.min(limit, queue.length) : queue.length;
    const taken = queue.slice(0, n);
    queue = queue.slice(n);
    const out = [];
    for (const key of taken) {
      const entry = entries.get(key);
      if (!entry || entry.state !== STATE.DUE) continue;
      out.push({ key, characterId: entry.characterId, systemId: entry.systemId, band: entry.band,
        yieldKind: entry.yieldKind || "",
        atMs: entry.lastEventAtMs });
    }
    return out;
  }

  function prepare(key, opts) {
    const entry = entries.get(key);
    if (!entry) return { ok: false, reason: "UNKNOWN_KEY" };
    if (entry.state !== STATE.DUE) return { ok: false, reason: "NOT_DUE" };
    const beltId = opts && opts.beltId !== undefined ? opts.beltId : null;
    if (entry.beltId !== null && beltId !== entry.beltId) entry.wavesSpawned = 0;
    entry.beltId = beltId;
    return { ok: true, waveNumber: entry.wavesSpawned + 1 };
  }

  function settle(key, outcome, opts) {
    const entry = entries.get(key);
    if (!entry) return { ok: false, reason: "UNKNOWN_KEY" };
    if (entry.state !== STATE.DUE) return { ok: false, reason: "NOT_DUE" };
    const atMs = opts && Number.isFinite(opts.atMs) ? opts.atMs : entry.lastEventAtMs;
    if (outcome === OUTCOME.SPAWNED) {
      entry.wavesSpawned += 1;
      entry.lastWaveAtMs = atMs;
      entry.noise = 0;
      entry.rearm = false;
      entry.state = entry.wavesSpawned >= S.maxWaves ? STATE.EXHAUSTED : STATE.QUIET;
    } else if (outcome === OUTCOME.DEFERRED) {
      entry.state = STATE.QUIET;
      entry.rearm = true;
    } else if (outcome === OUTCOME.REFUSED) {
      entry.state = STATE.QUIET;
      entry.noise = 0;
      entry.rearm = false;
    } else {
      return { ok: false, reason: "BAD_OUTCOME" };
    }
    dropFromQueue(key);
    return { ok: true, state: entry.state };
  }

  function peek(key) {
    const entry = entries.get(key);
    return entry ? Object.freeze({ ...entry }) : null;
  }

  function size() {
    return entries.size;
  }

  function status() {
    return Object.freeze({ tracked: entries.size, dueQueue: queue.length, evicted });
  }

  function clear() {
    entries.clear();
    queue = [];
  }

  return Object.freeze({ noteEvent, takeDue, prepare, settle, peek, size, status, clear });
}

module.exports = { createNoiseTracker };
