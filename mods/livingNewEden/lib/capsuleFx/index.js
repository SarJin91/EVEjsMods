"use strict";

const { createPoller } = require("../presence/poller");
const plan = require("./plan");

const SEAM_METHODS = Object.freeze(["playerNear", "spawn", "warpAway", "remove", "sceneFor"]);
const COUNTER_NAMES = Object.freeze(["queued", "duplicate", "sourceOff", "systemFull", "globalFull", "queueFull",
  "stale", "noPlayer", "spawned", "spawnFailed", "identityDrift", "warped", "warpFailed", "removed",
  "removedLifetime", "removedStop", "removeFailed", "sceneGone", "entityGone", "noWreck", "noOwner"]);
const ADMIT_COUNTERS = Object.freeze({ DUPLICATE: "duplicate", SOURCE_OFF: "sourceOff", SYSTEM_FULL: "systemFull",
  GLOBAL_FULL: "globalFull", QUEUE_FULL: "queueFull" });
const SKIP_COUNTERS = Object.freeze({ noWreck: "noWreck", noOwner: "noOwner" });
const METRIC_PREFIX = "capsuleFx";
const MAX_DETAIL = 160;

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function parseIdSet(text) {
  const out = new Set();
  for (const part of String(text || "").split(",")) {
    const n = Number(part.trim());
    if (Number.isSafeInteger(n) && n > 0) out.add(n);
  }
  return out;
}

function createUnavailableCapsuleFx(reason) {
  const why = String(reason || "CAPSULE_FX_UNAVAILABLE");
  return Object.freeze({
    runPass: () => ({ ok: false, reason: why }),
    getStatus: () => Object.freeze({ state: "unavailable", reason: why }),
    stop: () => {},
  });
}

function startCapsuleFx(deps) {
  const config = deps && deps.config;
  const S = config && config.capsuleFx;
  if (!S || S.enabled !== true) return { ok: false, reason: "disabled_by_config" };
  const adapter = deps.adapter;
  if (!adapter || typeof adapter.getCapsuleFxScene !== "function"
    || typeof adapter.addNpcWreckListener !== "function") {
    return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "adapter" };
  }
  let got;
  try {
    got = adapter.getCapsuleFxScene();
  } catch (err) {
    return { ok: false, reason: "SEAM_UNAVAILABLE", detail: messageOf(err) };
  }
  const seam = got && got.ok === true ? got.seam : null;
  if (!seam || !SEAM_METHODS.every((name) => typeof seam[name] === "function")) {
    return { ok: false, reason: "SEAM_UNAVAILABLE",
      detail: String((got && (Array.isArray(got.missing) ? got.missing.join(",") : got.reason)) || "") };
  }
  const cfg = Object.freeze({ ...S });
  const clock = deps.clock && typeof deps.clock.now === "function" ? deps.clock : { now: () => Date.now() };
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => clock.now();
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : null;
  const counters = Object.fromEntries(COUNTER_NAMES.map((name) => [name, 0]));
  const state = plan.createState();
  let stopped = false;
  let tripped = false;
  let lastError = null;

  function log(line) {
    if (!logger) return;
    try {
      logger.log(`capsuleFx ${line}`);
    } catch (_err) {
    }
  }

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](`${METRIC_PREFIX}.${name}`, value);
    } catch (_err) {
    }
  }

  function bump(name) {
    counters[name] += 1;
    metric("count", name, 1);
  }

  function onFacts(facts) {
    if (stopped || tripped) return;
    const r = plan.admit(state, facts, cfg, nowMs());
    bump(r.ok ? "queued" : ADMIT_COUNTERS[r.reason]);
  }

  function onSkip(reason) {
    if (stopped || !Object.prototype.hasOwnProperty.call(SKIP_COUNTERS, reason)) return;
    bump(SKIP_COUNTERS[reason]);
  }

  function dropActive(entry) {
    state.active.delete(entry.entityId);
    plan.release(state, entry.sceneKey, entry.wreckId);
  }

  function sceneStill(entry) {
    return seam.sceneFor(entry.sceneDescriptor, entry.systemId) === entry.scene;
  }

  function removeEntry(entry) {
    if (!sceneStill(entry)) {
      bump("sceneGone");
      dropActive(entry);
      return;
    }
    const r = seam.remove(entry.scene, entry.entity);
    if (r && r.ok === true && r.removed === false) {
      bump("entityGone");
    } else if (r && r.ok === true) {
      bump("removed");
      if (entry.warpedAtMs === null) bump("removedLifetime");
    } else {
      bump("removeFailed");
    }
    dropActive(entry);
  }

  function warpEntry(entry, now) {
    if (!sceneStill(entry)) {
      bump("sceneGone");
      dropActive(entry);
      return;
    }
    const r = seam.warpAway(entry.scene, entry.entity, entry.warpPoint);
    if (r && r.ok === true) {
      bump("warped");
      entry.warpedAtMs = now;
      entry.removeAtMs = Math.min(entry.removeAtMs, now + cfg.despawnAfterWarpMs);
    } else if (r && r.reason === "GONE") {
      bump("entityGone");
      dropActive(entry);
    } else {
      bump("warpFailed");
      entry.warpFailed = true;
    }
  }

  function trip() {
    tripped = true;
    for (const entry of state.pending) plan.release(state, entry.sceneKey, entry.wreckId);
    state.pending = [];
    log("spawn identity drift - capsule spawns stopped until restart");
  }

  function spawnEntry(entry, now) {
    const near = seam.playerNear(entry.systemId, entry.sceneDescriptor, entry.position, cfg.viewMeters, entry.victim);
    if (!near || near.ok !== true || near.near !== true) {
      bump(near && near.ok === true ? "noPlayer" : "spawnFailed");
      plan.release(state, entry.sceneKey, entry.wreckId);
      return;
    }
    const direction = plan.directionOf(entry.wreckId);
    const at = plan.spawnPointOf(entry, direction, cfg);
    const r = seam.spawn({ sceneDescriptor: entry.sceneDescriptor, systemId: entry.systemId, position: at, direction,
      ownerId: entry.ownerId, corporationId: entry.corporationId, allianceId: entry.allianceId,
      factionId: entry.factionId, victim: entry.victim, untargetable: cfg.untargetable });
    if (!r || r.ok !== true) {
      plan.release(state, entry.sceneKey, entry.wreckId);
      if (r && r.reason === "IDENTITY_DRIFT") {
        bump("identityDrift");
        trip();
      } else {
        bump("spawnFailed");
      }
      return;
    }
    bump("spawned");
    state.active.set(r.entityId, { entityId: r.entityId, wreckId: entry.wreckId, sceneKey: entry.sceneKey,
      systemId: entry.systemId, sceneDescriptor: entry.sceneDescriptor, entity: r.entity, scene: r.scene,
      spawnedAtMs: now, ...plan.schedule(now, cfg), warpedAtMs: null, warpFailed: false,
      warpPoint: plan.warpPointOf(at, direction, cfg) });
  }

  function runPass() {
    if (stopped) return { ok: false, reason: "STOPPED" };
    const now = nowMs();
    const due = plan.dueActions(state, now, cfg);
    for (const entry of due.remove) removeEntry(entry);
    for (const entry of due.warp) {
      if (state.active.get(entry.entityId) === entry) warpEntry(entry, now);
    }
    if (due.stale.length > 0 || due.spawn.length > 0) {
      const handled = new Set([...due.stale, ...due.spawn]);
      state.pending = state.pending.filter((entry) => !handled.has(entry));
      for (const entry of due.stale) {
        bump("stale");
        plan.release(state, entry.sceneKey, entry.wreckId);
      }
      for (const entry of due.spawn) {
        if (tripped) plan.release(state, entry.sceneKey, entry.wreckId);
        else spawnEntry(entry, now);
      }
    }
    metric("gauge", "active", state.active.size);
    return { ok: true, removed: due.remove.length, warped: due.warp.length, spawned: due.spawn.length,
      stale: due.stale.length };
  }

  const listener = adapter.addNpcWreckListener(onFacts, { excludedFactionIds: parseIdSet(cfg.excludedFactionIds),
    onSkip });
  if (!listener || listener.ok !== true) {
    return { ok: false, reason: String((listener && listener.reason) || "HOOK_NOT_INSTALLED") };
  }

  const poller = createPoller({ runPass, intervalMs: cfg.pollMs, now: nowMs, setTimer: deps.setTimer,
    onError: (err) => { lastError = messageOf(err); }, pacing: false });

  function stop() {
    if (stopped) return;
    stopped = true;
    try {
      listener.remove();
    } catch (_err) {
    }
    poller.stop();
    for (const entry of [...state.active.values()]) {
      try {
        if (sceneStill(entry)) seam.remove(entry.scene, entry.entity);
      } catch (_err) {
      }
      bump("removedStop");
      dropActive(entry);
    }
    state.pending = [];
    state.seenWrecks.clear();
    state.perSystem.clear();
    metric("gauge", "active", 0);
  }

  function getStatus() {
    const phase = stopped ? "stopped" : (tripped ? "tripped" : "running");
    return Object.freeze({ state: phase, pending: state.pending.length, active: state.active.size,
      counters: Object.freeze({ ...counters }), lastError });
  }

  const armed = poller.start();
  if (armed && armed.ok === false) {
    stop();
    return { ok: false, reason: "POLLER_FAILED", detail: String(armed.reason || "") };
  }
  const sources = Object.keys(plan.SOURCE_FLAGS).filter((source) => cfg[plan.SOURCE_FLAGS[source]] === true);
  log(`running (sources=${sources.join(",") || "none"}, maxPerSystem=${cfg.maxPerSystem}, `
    + `maxGlobal=${cfg.maxGlobal}, untargetable=${cfg.untargetable === true})`);
  return { ok: true, capsuleFx: Object.freeze({ runPass, getStatus, stop, onFacts, onSkip }) };
}

module.exports = { startCapsuleFx, createUnavailableCapsuleFx, parseIdSet, SEAM_METHODS, COUNTER_NAMES };
