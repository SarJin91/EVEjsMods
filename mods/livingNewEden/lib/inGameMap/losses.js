"use strict";

const { createPoller } = require("../presence/poller");

const READ_TX = "inGameMap.losses";
const WORK_CLASS = "MAINTENANCE";
const WINDOW_MS = 24 * 3600000;
const METRIC = Object.freeze({ refreshes: "inGameMap.starmap.lossRefreshes",
  skipped: "inGameMap.starmap.lossRefreshSkipped", ms: "inGameMap.starmap.lossesMs" });
const MAX_DETAIL = 120;

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function fingerprintOf(losses) {
  let sum = 0;
  for (const l of losses) sum += l.count;
  return `${losses.length}|${losses.length > 0 ? losses[0].settledAt : "-"}|${sum}`;
}

function createLossesCache(deps) {
  const settings = deps.settings;
  const clock = deps.clock;
  const wallNow = typeof deps.wallNow === "function" ? deps.wallNow : () => Date.now();
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const telemetry = deps.telemetry || null;
  const rawLog = typeof deps.log === "function" ? deps.log : null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  let snap = null;
  let print = null;
  let started = false;
  let halted = false;
  let refreshes = 0;
  let skipped = 0;
  let failed = 0;
  let truncated = false;
  let lastRefreshAt = null;
  let lastProblem = null;

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
      rawLog(`starmap losses - ${text}`);
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

  function fail(reason) {
    failed += 1;
    problem(reason);
    return { ok: false, reason };
  }

  function refreshNow() {
    if (halted) return { ok: false, reason: "STOPPED" };
    if (!admitted()) {
      skipped += 1;
      metric("count", METRIC.skipped, 1);
      return { ok: false, reason: "GOVERNOR_HOLD" };
    }
    const battle = deps.battle || null;
    const repository = battle && battle.repository;
    const store = deps.store || null;
    if (!repository || typeof repository.listVirtualLossesSince !== "function" || !store
      || typeof store.transaction !== "function") {
      return fail("BATTLE_UNAVAILABLE");
    }
    const t0 = nowMs();
    try {
      const now = clock.now();
      const sinceMs = Math.max(0, now - WINDOW_MS);
      const tx = store.transaction(READ_TX,
        (db) => repository.listVirtualLossesSince(db, { sinceMs, limit: settings.starmapMaxLossRows }));
      const page = tx && tx.ok ? tx.value : tx;
      if (!page || page.ok !== true) return fail(String((page && page.reason) || "TX_FAILED"));
      truncated = page.truncated === true;
      const next = fingerprintOf(page.losses);
      if (snap === null || next !== print) {
        const losses = page.losses.map((l) => Object.freeze({ systemId: l.systemId, ageMs: Math.max(0, now - l.settledAt),
          typeId: l.typeId, factionId: l.factionId, count: l.count }));
        snap = Object.freeze({ version: snap === null ? 1 : snap.version + 1, builtAtWallMs: wallNow(), builtAtMs: now,
          losses: Object.freeze(losses) });
        print = next;
      }
      refreshes += 1;
      lastRefreshAt = now;
      problem(null);
      metric("count", METRIC.refreshes, 1);
      metric("observe", METRIC.ms, Math.max(0, nowMs() - t0));
      return { ok: true };
    } catch (err) {
      return fail(messageOf(err));
    }
  }

  const poller = createPoller({ runPass: () => { refreshNow(); }, intervalMs: settings.starmapKillsRefreshMs,
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

  return Object.freeze({ start, stop, refreshNow,
    snapshot: () => (halted ? null : snap),
    status: () => ({ version: snap === null ? 0 : snap.version, losses: snap === null ? 0 : snap.losses.length,
      truncated, refreshes, skipped, failed, lastRefreshAt }) });
}

module.exports = { READ_TX, WINDOW_MS, createLossesCache };
