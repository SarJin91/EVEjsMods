"use strict";

const crypto = require("node:crypto");
const { createDailyBudget, createBreaker } = require("../../chatterAi/limits");
const { BREAKER } = require("../../chatterAi/schema");
const { METRIC, VOICE_INTEGER_RANGES } = require("../schema");
const { PIPER_NAME_RE } = require("./voicePrefs");

const MILLI = 1000;
const RIFF = "RIFF";
const WAVE = "WAVE";
const WAVE_AT = 8;
const HEADER_BYTES = 12;
const [LENGTH_SCALE_MIN, LENGTH_SCALE_MAX] = VOICE_INTEGER_RANGES.voiceLengthScaleMilli;

function isWav(bytes) {
  return Buffer.isBuffer(bytes) && bytes.length >= HEADER_BYTES && bytes.toString("latin1", 0, 4) === RIFF
    && bytes.toString("latin1", WAVE_AT, WAVE_AT + 4) === WAVE;
}

function voiceOf(S, lang) {
  const prefix = String(lang || "").slice(0, 2).toLowerCase();
  if (prefix === "pl") return S.voicePiperVoicePl;
  if (prefix === "en") return S.voicePiperVoiceEn;
  return "";
}

function voicePrefixOf(lang) {
  const prefix = String(lang || "").slice(0, 2).toLowerCase();
  return /^[a-z]{2}$/.test(prefix) ? `${prefix}_` : "";
}

function keyOf(voice, lengthScaleMilli, text) {
  return crypto.createHash("sha256").update(`${voice}|${lengthScaleMilli}|${text}`, "utf8").digest("base64url");
}

function stillWanted(wanted) {
  if (typeof wanted !== "function") return true;
  try {
    return wanted() !== false;
  } catch (_err) {
    return true;
  }
}

function createPiperEngine(deps) {
  const S = deps.S;
  const transport = deps.transport;
  const cache = deps.cache;
  const url = deps.url;
  const nowMs = deps.nowMs;
  const telemetry = deps.telemetry && typeof deps.telemetry.count === "function" ? deps.telemetry : null;
  const budget = createDailyBudget(S.voiceDailyChars);
  const breaker = createBreaker({ breakerFailures: S.voiceBreakerFailures, breakerCooldownMs: S.voiceBreakerCooldownMs,
    breakerMaxCooldownMs: S.voiceBreakerCooldownMs });
  const abort = new AbortController();
  const waiting = [];
  const inflightByKey = new Map();
  const wantedByKey = new Map();
  const counts = { synth: 0, cacheHits: 0, joined: 0, dropped: 0, unwanted: 0, voicesListed: 0 };
  const failed = {};
  const voicesUrl = deps.voicesUrl instanceof URL ? deps.voicesUrl : null;
  let voiceList = null;
  let listInflight = null;
  const listFailedBy = {};
  const listFailed = (reason) => {
    listFailedBy[reason] = (listFailedBy[reason] || 0) + 1;
    return { ok: false, reason };
  };
  let running = 0;
  let stopped = false;
  let reserved = 0;

  const metric = (fn) => {
    if (!telemetry) return;
    try {
      fn(telemetry);
    } catch (_err) {
    }
  };

  const fail = (reason) => {
    failed[reason] = (failed[reason] || 0) + 1;
    return { ok: false, reason };
  };

  function pump() {
    while (!stopped && running < S.voicePiperMaxInFlight && waiting.length > 0) {
      const job = waiting.shift();
      if (nowMs() - job.atMs > S.voicePiperTimeoutMs) {
        job.fail("TIMEOUT");
        continue;
      }
      if (!job.wanted()) {
        counts.unwanted += 1;
        job.fail("UNWANTED");
        continue;
      }
      job.run();
    }
  }

  async function request(playerId, key, text, voice, lsm) {
    const t0 = nowMs();
    let r;
    try {
      r = await transport.post(url, { text, voice, length_scale: lsm / MILLI },
        { timeoutMs: S.voicePiperTimeoutMs, maxBytes: S.voicePiperMaxBytes, signal: abort.signal });
    } catch (_err) {
      r = { ok: false, reason: "NET_ERROR" };
    }
    const now = nowMs();
    running -= 1;
    try {
      if (stopped || (r && r.reason === "ABORTED")) return fail("STOPPED");
      metric((t) => t.observe && t.observe(METRIC.voiceSynthMs, Math.max(0, now - t0)));
      const res = r && r.ok === true ? (isWav(r.bytes) ? r : { ok: false, reason: "BAD_AUDIO" })
        : { ok: false, reason: r && typeof r.reason === "string" ? r.reason : "NET_ERROR" };
      if (!res.ok) {
        breaker.failure(now, null);
        metric((t) => t.count(METRIC.voiceFailed, 1));
        return fail(res.reason);
      }
      breaker.success(now);
      counts.synth += 1;
      metric((t) => t.count(METRIC.voiceSynth, 1));
      return { ok: true, audioId: cache.put(key, res.bytes, playerId).id, cached: false };
    } finally {
      pump();
    }
  }

  function admit(playerId, key, text, voice, lsm, wanted) {
    const now = nowMs();
    const chars = text.length;
    if (!budget.canSpend(reserved + chars, now)) return Promise.resolve(fail("BUDGET"));
    if (!breaker.allow(now)) return Promise.resolve(fail("BREAKER"));
    const start = () => {
      running += 1;
      budget.spend(chars, nowMs());
      return request(playerId, key, text, voice, lsm);
    };
    if (running < S.voicePiperMaxInFlight && waiting.length === 0) return start();
    if (waiting.length >= S.voiceQueueMax) {
      breaker.release();
      counts.dropped += 1;
      return Promise.resolve(fail("DROPPED"));
    }
    reserved += chars;
    return new Promise((resolve) => {
      waiting.push({ atMs: now, wanted,
        run: () => {
          reserved -= chars;
          start().then(resolve, () => resolve(fail("NET_ERROR")));
        },
        fail: (reason) => {
          reserved -= chars;
          breaker.release();
          resolve(fail(reason));
        } });
    });
  }

  async function synthesize(playerId, text, lang, opts) {
    const wanted = opts && typeof opts.wanted === "function" ? opts.wanted : null;
    try {
      if (stopped) return fail("STOPPED");
      const line = typeof text === "string" ? text.trim() : "";
      if (line === "") return fail("EMPTY");
      const chosen = opts && typeof opts.voice === "string" ? opts.voice : "";
      const prefix = voicePrefixOf(lang);
      const voice = chosen !== "" && prefix !== "" && PIPER_NAME_RE.test(chosen) && chosen.startsWith(prefix)
        ? chosen : voiceOf(S, lang);
      if (typeof voice !== "string" || voice === "") return fail("NO_VOICE");
      const asked = opts ? opts.lengthScaleMilli : undefined;
      const lsm = Number.isSafeInteger(asked) && asked >= LENGTH_SCALE_MIN && asked <= LENGTH_SCALE_MAX ? asked
        : S.voiceLengthScaleMilli;
      const key = keyOf(voice, lsm, line);
      const hit = cache.get(key, playerId);
      if (hit) {
        counts.cacheHits += 1;
        return { ok: true, audioId: hit.id, cached: true };
      }
      const pending = inflightByKey.get(key);
      if (pending) {
        counts.joined += 1;
        const list = wantedByKey.get(key);
        if (list) list.push(wanted);
        const first = await pending;
        if (!first.ok) return first;
        const again = cache.get(key, playerId);
        return again ? { ok: true, audioId: again.id, cached: true } : fail("NO_REUSE");
      }
      const list = [wanted];
      const p = admit(playerId, key, line, voice, lsm, () => list.some(stillWanted));
      inflightByKey.set(key, p);
      wantedByKey.set(key, list);
      try {
        return await p;
      } finally {
        if (inflightByKey.get(key) === p) {
          inflightByKey.delete(key);
          wantedByKey.delete(key);
        }
      }
    } catch (_err) {
      return fail("NET_ERROR");
    }
  }

  const voicesFor = (all, lang) => {
    const prefix = voicePrefixOf(lang);
    return prefix === "" ? [] : all.filter((id) => id.startsWith(prefix)).slice(0, S.voicePiperMaxVoices);
  };

  async function fetchVoices() {
    let r;
    try {
      r = await transport.get(voicesUrl, { timeoutMs: S.voicePiperListTimeoutMs, maxBytes: S.voicePiperListMaxBytes,
        signal: abort.signal });
    } catch (_err) {
      r = { ok: false, reason: "NET_ERROR" };
    }
    if (stopped || (r && r.reason === "ABORTED")) return { ok: false, reason: "STOPPED" };
    if (!r || r.ok !== true) return { ok: false, reason: r && typeof r.reason === "string" ? r.reason : "NET_ERROR" };
    let parsed;
    try {
      parsed = JSON.parse(Buffer.isBuffer(r.bytes) ? r.bytes.toString("utf8") : "");
    } catch (_err) {
      return { ok: false, reason: "BAD_JSON" };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: "BAD_JSON" };
    return { ok: true, all: Object.keys(parsed).filter((id) => PIPER_NAME_RE.test(id)).sort() };
  }

  async function listVoices(lang) {
    try {
      if (stopped) return listFailed("STOPPED");
      if (!voicesUrl) return listFailed("NET_ERROR");
      if (voiceList && nowMs() - voiceList.atMs < S.voicePiperVoicesTtlMs) {
        return { ok: true, voices: voicesFor(voiceList.all, lang), cached: true };
      }
      if (!listInflight) {
        listInflight = fetchVoices().then((res) => {
          if (res.ok) {
            voiceList = Object.freeze({ atMs: nowMs(), all: Object.freeze(res.all) });
            counts.voicesListed += 1;
          }
          return res;
        }, () => ({ ok: false, reason: "NET_ERROR" })).finally(() => {
          listInflight = null;
        });
      }
      const res = await listInflight;
      if (!res.ok) return listFailed(res.reason);
      return { ok: true, voices: voicesFor(res.all, lang), cached: false };
    } catch (_err) {
      return listFailed("NET_ERROR");
    }
  }

  function knownVoices(lang) {
    if (!voiceList) return null;
    return new Set(lang === undefined ? voiceList.all : voicesFor(voiceList.all, lang));
  }

  function status() {
    const now = nowMs();
    const c = cache.stats();
    const out = { state: stopped ? "stopped" : "running", inFlight: running, waiting: waiting.length,
      synth: counts.synth, cacheHits: counts.cacheHits, joined: counts.joined, dropped: counts.dropped,
      unwanted: counts.unwanted, charsReserved: reserved, cacheEntries: c.entries, cacheBytes: c.bytes, cacheEvicted: c.evicted,
      breakerOpen: breaker.state(now) !== BREAKER.CLOSED, charsToday: budget.usedToday(now) };
    for (const [reason, n] of Object.entries(failed)) out[`failed_${reason}`] = n;
    out.voicesListed = counts.voicesListed;
    for (const [reason, n] of Object.entries(listFailedBy)) out[`listFailed_${reason}`] = n;
    return out;
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    try {
      abort.abort();
    } catch (_err) {
    }
    while (waiting.length > 0) waiting.shift().fail("STOPPED");
    inflightByKey.clear();
    wantedByKey.clear();
    cache.clear();
  }

  return Object.freeze({ synthesize, listVoices, knownVoices, status, stop });
}

module.exports = { createPiperEngine, isWav, voiceOf, keyOf, voicePrefixOf };
