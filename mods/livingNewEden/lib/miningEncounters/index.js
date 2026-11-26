"use strict";

const { performance } = require("node:perf_hooks");
const { createRng, randomSeed } = require("../util/rng");
const { OUTCOME, REFUSAL, SPECIAL_KINDS, ANOMALY_YIELD_KIND, WORK_CLASS, MINUTE_MS, METRIC_FLUSH_MS, COUNTER_NAMES } = require("./schema");
const { createNoiseTracker } = require("./noise");
const { planWave } = require("./wavePlan");
const { DEFAULT_SECURITY_BANDS, parseSecurityBands, selectSecurityBand } = require("./securityBands");
const { createPoller } = require("../presence/poller");

const HAULER_KIND = "hauler";

const SEAM_METHODS = Object.freeze(["bandOf", "locate", "spawnWave", "readVendorBeltFlags"]);
const MS_DECIMALS = 10;
const MAX_DETAIL = 160;
const PERMILLE = 1000;

function isPositiveInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function refusalOf(result, fallback) {
  const reason = result && result.reason;
  return REFUSAL.includes(reason) ? reason : fallback;
}

function createUnavailableMiningEncounters(reason) {
  const why = String(reason || "MINING_ENCOUNTERS_UNAVAILABLE");
  return Object.freeze({
    onLedgerEvent: () => {},
    flushNow: () => ({ ok: false, reason: why }),
    getStatus: () => Object.freeze({ state: "unavailable", reason: why }),
    stop: () => {},
  });
}

function startMiningEncounters(deps) {
  const config = deps && deps.config;
  const S = config && config.miningEncounters;
  if (!S || S.enabled !== true) return { ok: false, reason: "disabled_by_config" };
  const seam = deps.seam;
  if (!seam || SEAM_METHODS.some((name) => typeof seam[name] !== "function")) {
    return { ok: false, reason: "SEAM_UNAVAILABLE" };
  }
  const clock = deps.clock && typeof deps.clock.now === "function" ? deps.clock : { now: () => Date.now() };
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : null;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const getEvents = typeof deps.getEvents === "function" ? deps.getEvents : () => null;
  const rng = typeof deps.rng === "function" ? deps.rng : createRng(randomSeed()).nextFloat;
  const defer = typeof deps.defer === "function" ? deps.defer : (fn) => setImmediate(fn);

  const tracker = createNoiseTracker({ config: S, rng });
  const parsedBands = parseSecurityBands(S.securityBands);
  const securityBands = parsedBands.ok ? parsedBands.bands : parseSecurityBands(DEFAULT_SECURITY_BANDS).bands;
  const counters = Object.fromEntries(COUNTER_NAMES.map((name) => [name, 0]));
  const bandCache = new Map();
  let waveTimes = [];
  let flushPending = false;
  let stopped = false;
  let lastFlush = null;
  const haulerWatch = S.haulerWarpOutEnabled === true && typeof seam.warpOutHaulers === "function";
  const setTimer = typeof deps.setTimer === "function" ? deps.setTimer : undefined;
  const haulerWaves = new Map();
  let haulerSeq = 0;
  let haulerPoller = null;

  function log(line) {
    if (!logger) return;
    try {
      logger.log(`miningEncounters: ${line}`);
    } catch (_err) {
    }
  }

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  }

  function bump(name, n = 1) {
    if (!(n > 0) || !Object.prototype.hasOwnProperty.call(counters, name)) return;
    counters[name] += n;
    metric("count", `world.miningEncounters.${name}`, n);
  }

  function governorAdmits() {
    try {
      const governor = getGovernor();
      return !governor || typeof governor.admits !== "function" || governor.admits(WORK_CLASS) !== false;
    } catch (_err) {
      return true;
    }
  }

  function bandFor(systemId) {
    const cached = bandCache.get(systemId);
    if (cached) return { ok: true, ...cached };
    const res = call("bandOf", systemId);
    if (!res || res.ok !== true) return { ok: false, reason: refusalOf(res, "READ_FAILED") };
    const info = { band: res.band, eligible: res.eligible === true, baseMin: res.baseMin, baseMax: res.baseMax,
      security: Number.isFinite(res.security) ? res.security : null };
    if (bandCache.size >= S.maxTrackedMiners) bandCache.delete(bandCache.keys().next().value);
    bandCache.set(systemId, info);
    return { ok: true, ...info };
  }

  function scheduleFlush() {
    if (flushPending || stopped) return;
    flushPending = true;
    try {
      defer(() => {
        flushPending = false;
        if (!stopped) flushNow();
      });
    } catch (err) {
      flushPending = false;
      log(`defer failed - ${messageOf(err)}`);
    }
  }

  function richVeinPermilleOf(systemId, yieldKind) {
    const m = S.richVeinNoisePermille;
    if (!Number.isSafeInteger(m) || m <= PERMILLE || yieldKind !== ANOMALY_YIELD_KIND) return PERMILLE;
    try {
      const events = getEvents();
      const set = events && typeof events.richVeinSystems === "function" ? events.richVeinSystems() : null;
      return set && typeof set.has === "function" && set.has(systemId) ? m : PERMILLE;
    } catch (_err) {
      return PERMILLE;
    }
  }

  function onLedgerEvent(payload) {
    try {
      if (stopped || !payload) return;
      const characterId = payload.characterId;
      const systemId = payload.systemId;
      if (!isPositiveInt(characterId) || !isPositiveInt(systemId)) return;
      const atMs = Number.isFinite(payload.atMs) ? payload.atMs : clock.now();
      const band = bandFor(systemId);
      if (band.ok !== true) {
        bump(`refused.${band.reason}`);
        return;
      }
      if (band.eligible !== true) {
        bump("refused.BAND_INELIGIBLE");
        return;
      }
      if (band.band === "highsec" && S.highsecEnabled !== true) {
        bump("refused.HIGHSEC_OFF");
        return;
      }
      const yieldKind = typeof payload.yieldKind === "string" ? payload.yieldKind : "";
      const vein = richVeinPermilleOf(systemId, yieldKind);
      const r = tracker.noteEvent({ characterId, systemId, band: band.band, yieldKind, atMs,
        ...(vein > PERMILLE ? { noiseMultiplierPermille: vein } : {}) });
      if (r.ok !== true) return;
      bump("noise", r.added);
      bump("evicted", r.evicted);
      if (r.reason === "CAPPED") bump("capped");
      else if (r.reason === "CHANCE_MISS") bump("chanceMiss");
      else if (r.reason === "EXHAUSTED" || r.reason === "HIGHSEC_OFF") bump(`refused.${r.reason}`);
      if (r.due) {
        bump("due");
        scheduleFlush();
      }
    } catch (err) {
      bump("hookError");
      log(`ledger event failed - ${messageOf(err)}`);
    }
  }

  function settleAs(item, outcome, reason, now, out) {
    tracker.settle(item.key, outcome, { atMs: now });
    if (outcome === OUTCOME.DEFERRED) {
      out.deferred += 1;
      bump(`deferred.${reason}`);
    } else if (outcome === OUTCOME.REFUSED) {
      out.refused += 1;
      bump(`refused.${reason}`);
    }
  }

  function call(name, arg) {
    try {
      return seam[name](arg);
    } catch (err) {
      return { ok: false, reason: "READ_FAILED", detail: messageOf(err) };
    }
  }

  function handle(item, now, out) {
    const anomaly = S.anomalyEnabled === true && item.yieldKind === ANOMALY_YIELD_KIND;
    const loc = call("locate", { characterId: item.characterId, systemId: item.systemId,
      ...(anomaly ? { anomaly: { distanceMeters: S.anomalySpawnDistanceMeters } } : {}) });
    if (!loc || loc.ok !== true) return settleAs(item, OUTCOME.REFUSED, refusalOf(loc, "READ_FAILED"), now, out);
    if (loc.groupsOnBelt > 0) return settleAs(item, OUTCOME.DEFERRED, "BELT_BUSY", now, out);
    if (loc.groupsInSystem >= S.maxBeltGroupsPerSystem) {
      return settleAs(item, OUTCOME.DEFERRED, "SYSTEM_LIMIT", now, out);
    }
    const flags = call("readVendorBeltFlags");
    if (!flags || flags.ok !== true) return settleAs(item, OUTCOME.REFUSED, refusalOf(flags, "READ_FAILED"), now, out);
    if (flags.ratsEnabled === false) return settleAs(item, OUTCOME.REFUSED, "VENDOR_RATS_OFF", now, out);
    const band = bandFor(item.systemId);
    if (band.ok !== true) return settleAs(item, OUTCOME.REFUSED, band.reason, now, out);
    const prep = tracker.prepare(item.key, { beltId: loc.beltId, atMs: now });
    if (prep.ok !== true) return undefined;
    const secBand = band.security === null ? null : selectSecurityBand(securityBands, band.security);
    const plan = planWave({ waveNumber: prep.waveNumber, baseMin: band.baseMin, baseMax: band.baseMax, config: S,
      rng, vendorSpecialsEnabled: flags.specialsEnabled === true,
      sizeMultiplier: secBand ? secBand.sizeMultiplier : 1,
      specialChanceMultiplier: secBand ? secBand.specialChanceMultiplier : 1 });
    const res = call("spawnWave", { characterId: item.characterId, systemId: item.systemId, beltId: loc.beltId,
      minCount: plan.minCount, maxCount: plan.maxCount, specialChain: plan.specialChain, nowMs: now,
      ...(loc.anchor === "ship" ? { anchor: "ship", spawnDistanceMeters: S.anomalySpawnDistanceMeters } : {}) });
    if (res && res.reason === "SCENE_NPC_BUDGET") return settleAs(item, OUTCOME.DEFERRED, "SYSTEM_LIMIT", now, out);
    if (!res || res.ok !== true) return settleAs(item, OUTCOME.REFUSED, refusalOf(res, "SPAWN_FAILED"), now, out);
    tracker.settle(item.key, OUTCOME.SPAWNED, { atMs: now });
    waveTimes.push(now);
    out.spawned += 1;
    bump("wave");
    if (SPECIAL_KINDS.includes(res.kind)) bump(`special.${res.kind}`);
    if (res.degraded === true) bump("degraded");
    trackHaulers(item, res, now);
    return undefined;
  }

  function stopHaulerPoller() {
    if (haulerPoller === null) return;
    haulerPoller.stop();
    haulerPoller = null;
  }

  function sweepHaulers() {
    try {
      if (stopped) return;
      const now = clock.now();
      for (const [key, wave] of haulerWaves) {
        const force = now - wave.spawnedAtMs >= S.haulerWarpOutAfterMs;
        const res = call("warpOutHaulers", { systemId: wave.systemId, characterId: wave.characterId,
          entityIds: wave.entityIds, rangeMeters: S.haulerWarpOutRangeMeters, force });
        if (!res || res.ok !== true || !Array.isArray(res.ships)) {
          if ((res && res.reason === "SCENE_NOT_LOADED") || force) {
            haulerWaves.delete(key);
            bump("hauler.dropped");
          }
          continue;
        }
        const left = [];
        for (const ship of res.ships) {
          const entityId = ship && ship.entityId;
          if (!isPositiveInt(entityId) || !wave.entityIds.includes(entityId)) continue;
          if (ship.state === "gone") {
            bump("hauler.gone");
            continue;
          }
          if (ship.state === "ordered") bump("hauler.warpOut");
          else if (ship.state === "failed") bump("hauler.failed");
          left.push(entityId);
        }
        if (left.length === 0) haulerWaves.delete(key);
        else wave.entityIds = left;
      }
    } catch (err) {
      log(`hauler check failed - ${messageOf(err)}`);
    } finally {
      if (haulerWaves.size === 0 || stopped) stopHaulerPoller();
    }
  }

  function trackHaulers(item, res, now) {
    if (!haulerWatch || res.kind !== HAULER_KIND || !Array.isArray(res.entityIds)) return;
    const entityIds = res.entityIds.filter(isPositiveInt);
    if (entityIds.length === 0) return;
    if (haulerWaves.size >= S.maxTrackedMiners) {
      haulerWaves.delete(haulerWaves.keys().next().value);
      bump("hauler.dropped");
    }
    haulerSeq += 1;
    haulerWaves.set(haulerSeq, { systemId: item.systemId, characterId: item.characterId, entityIds,
      spawnedAtMs: now });
    bump("hauler.tracked");
    if (haulerPoller !== null) return;
    const poller = createPoller({ runPass: sweepHaulers, intervalMs: S.haulerWarpOutCheckMs, now: () => clock.now(),
      setTimer, onError: (err) => log(`hauler poller failed - ${messageOf(err)}`),
      pacing: false });
    haulerPoller = poller;
    poller.start();
  }

  function flushNow() {
    if (stopped) return { ok: false, reason: "STOPPED" };
    const t0 = performance.now();
    const out = { ok: true, spawned: 0, deferred: 0, refused: 0 };
    try {
      const now = clock.now();
      if (!governorAdmits()) {
        for (const item of tracker.takeDue()) settleAs(item, OUTCOME.DEFERRED, "GOVERNOR", now, out);
        return out;
      }
      waveTimes = waveTimes.filter((t) => now - t < MINUTE_MS);
      for (const item of tracker.takeDue(S.maxSpawnsPerFlush)) {
        if (waveTimes.length >= S.maxWavesPerMinute) {
          settleAs(item, OUTCOME.DEFERRED, "RATE_LIMIT", now, out);
          continue;
        }
        try {
          handle(item, now, out);
        } catch (err) {
          tracker.settle(item.key, OUTCOME.REFUSED, { atMs: now });
          out.refused += 1;
          bump("refused.SPAWN_FAILED");
          log(`wave of ${item.key} failed - ${messageOf(err)}`);
        }
      }
      if (tracker.status().dueQueue > 0) {
        if (waveTimes.length >= S.maxWavesPerMinute) {
          for (const item of tracker.takeDue()) settleAs(item, OUTCOME.DEFERRED, "RATE_LIMIT", now, out);
        } else {
          scheduleFlush();
        }
      }
      return out;
    } catch (err) {
      log(`flush failed - ${messageOf(err)}`);
      return { ok: false, reason: "FLUSH_FAILED", detail: messageOf(err) };
    } finally {
      const ms = Math.round((performance.now() - t0) * MS_DECIMALS) / MS_DECIMALS;
      metric("observe", METRIC_FLUSH_MS, ms);
      lastFlush = { ...out, ms };
    }
  }

  function getStatus() {
    return Object.freeze({ state: stopped ? "stopped" : "running", ...tracker.status(), bands: bandCache.size,
      wavesLastMinute: waveTimes.length, flushPending, lastFlush, haulerWaves: haulerWaves.size, counters: Object.freeze({ ...counters }) });
  }

  function stop(reason) {
    if (stopped) return;
    stopped = true;
    tracker.clear();
    bandCache.clear();
    waveTimes = [];
    haulerWaves.clear();
    stopHaulerPoller();
    log(`stopped (${reason || "stop"})`);
  }

  return { ok: true, encounters: Object.freeze({ onLedgerEvent, flushNow, getStatus, stop }) };
}

module.exports = { startMiningEncounters, createUnavailableMiningEncounters };
