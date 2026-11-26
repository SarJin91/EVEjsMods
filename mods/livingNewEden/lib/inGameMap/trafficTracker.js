"use strict";

const { createPoller } = require("../presence/poller");
const { createLegState, countJumps, mergeLeg, pruneLegs, cutStaleLegs, allLegs } = require("./jumps");

const SCAN_TX = "inGameMap.scan";
const WORK_CLASS = "MAINTENANCE";
const SCAN_STATES = Object.freeze(["TRAVELLING", "RETREATING"]);
const METRIC = Object.freeze({ scans: "inGameMap.starmap.scans", skipped: "inGameMap.starmap.scanSkipped",
  scanMs: "inGameMap.starmap.scanMs", trackedLegs: "inGameMap.starmap.trackedLegs",
  partial: "inGameMap.starmap.scanPartial", staleCuts: "inGameMap.starmap.staleCuts" });
const TRUNCATED = "MAX_SCAN_FLEETS";
const MAX_DETAIL = 120;
const EMPTY = new Map();

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function yieldLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createTrafficTracker(deps) {
  const settings = deps.settings;
  const clock = deps.clock;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const telemetry = deps.telemetry || null;
  const rawLog = typeof deps.log === "function" ? deps.log : null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const maxListLimit = Number.isSafeInteger(deps.maxListLimit) && deps.maxListLimit > 0 ? deps.maxListLimit
    : settings.starmapScanPageSize;
  const pageSize = Math.min(settings.starmapScanPageSize, maxListLimit);
  const limits = Object.freeze({ perShip: settings.starmapJumpsPerShip === true,
    maxTrackedLegs: settings.starmapMaxTrackedLegs });
  const legState = createLegState();
  let running = false;
  let halted = false;
  let started = false;
  let scans = 0;
  let skipped = 0;
  let lastScanAt = null;
  let partial = 0;
  let staleCuts = 0;
  let lastScanComplete = null;
  let lastPartialReason = null;
  let lastProblem = null;
  let cache = new Map();
  let cacheAt = 0;

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  }

  function problem(text) {
    if (text === lastProblem) return;
    lastProblem = text;
    if (text === null || rawLog === null) return;
    try {
      rawLog(`starmap scan - ${text}`);
    } catch (_err) {
    }
  }

  function admitted() {
    try {
      const governor = getGovernor();
      return !governor || typeof governor.admits !== "function" || governor.admits(WORK_CLASS) !== false;
    } catch (_err) {
      return true;
    }
  }

  function readPage(store, repository, state, after, limit) {
    const tx = store.transaction(SCAN_TX, (db) => repository.listFleetsByState(db, state, { limit, afterFleetId: after }));
    const page = tx && tx.ok ? tx.value : tx;
    if (!page || page.ok !== true) return { ok: false, reason: String((page && page.reason) || "TX_FAILED") };
    return page;
  }

  async function scanNow() {
    if (running || halted) return;
    if (!admitted()) {
      skipped += 1;
      metric("count", METRIC.skipped, 1);
      return;
    }
    const fleets = deps.fleets || null;
    const repository = fleets && fleets.repository;
    const store = deps.store || null;
    if (!repository || typeof repository.listFleetsByState !== "function" || !store
      || typeof store.transaction !== "function") {
      problem("no fleets repository or store (modules.fleets off, W57)");
      return;
    }
    running = true;
    const t0 = nowMs();
    try {
      let read = 0;
      let failed = null;
      const seen = new Map();
      for (const state of SCAN_STATES) {
        let after = "";
        while (failed === null) {
          if (read >= settings.starmapMaxScanFleets) {
            failed = TRUNCATED;
            break;
          }
          if (read > 0) await yieldLoop();
          if (halted) {
            failed = "STOPPED";
            break;
          }
          if (!admitted()) {
            failed = "GOVERNOR_HOLD";
            break;
          }
          const page = readPage(store, repository, state, after, Math.min(pageSize, settings.starmapMaxScanFleets - read));
          if (!page.ok) {
            failed = page.reason;
            break;
          }
          const seenAt = clock.now();
          for (const fleet of page.fleets) {
            mergeLeg(legState, fleet, limits, seenAt);
            if (fleet && typeof fleet.fleetId === "string") seen.set(fleet.fleetId, fleet.legSeq);
          }
          read += page.fleets.length;
          if (page.nextAfterFleetId === null) break;
          after = page.nextAfterFleetId;
        }
        if (failed !== null) break;
      }
      const now = clock.now();
      if (failed === null) {
        const cut = cutStaleLegs(legState, seen, now);
        staleCuts += cut;
        if (cut > 0) metric("count", METRIC.staleCuts, cut);
      } else {
        partial += 1;
        lastPartialReason = failed;
        metric("count", METRIC.partial, 1);
      }
      lastScanComplete = failed === null;
      pruneLegs(legState, now, limits);
      cache = new Map();
      lastScanAt = now;
      scans += 1;
      problem(failed === null || failed === "STOPPED" || failed === TRUNCATED ? null : failed);
      metric("count", METRIC.scans, 1);
      metric("observe", METRIC.scanMs, Math.max(0, nowMs() - t0));
      metric("gauge", METRIC.trackedLegs, legState.size);
    } catch (err) {
      partial += 1;
      lastScanComplete = false;
      lastPartialReason = "SCAN_THREW";
      problem(messageOf(err));
    } finally {
      running = false;
    }
  }

  function jumpCounts(windowMs) {
    if (halted) return EMPTY;
    const now = clock.now();
    if (now - cacheAt >= settings.starmapScanMs || now < cacheAt) {
      cache = new Map();
      cacheAt = now;
    }
    const hit = cache.get(windowMs);
    if (hit) return hit;
    const counts = countJumps(allLegs(legState), now, windowMs);
    cache.set(windowMs, counts);
    return counts;
  }

  const poller = createPoller({ runPass: () => { scanNow(); }, intervalMs: settings.starmapScanMs,
    now: () => clock.now(), setTimer: deps.setTimer, onError: (err) => problem(messageOf(err)) });

  function start() {
    if (started || halted) return;
    started = true;
    poller.start();
    poller.arm(0);
  }

  function stop() {
    halted = true;
    poller.stop();
  }

  return Object.freeze({ start, stop, jumpCounts, scanNow,
    status: () => ({ legs: legState.size, lastScanAt, scans, skipped, partial, lastScanComplete, lastPartialReason,
      staleCuts }) });
}

module.exports = { SCAN_TX, createTrafficTracker };
