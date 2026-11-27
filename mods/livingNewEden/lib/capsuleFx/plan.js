"use strict";

const { deterministicUnit } = require("../util/rng");

const METERS_PER_AU = 149597870700;
const RNG_STREAM = "capsuleFx";
const FALLBACK_DIRECTION = Object.freeze({ x: 1, y: 0, z: 0 });
const SOURCE_FLAGS = Object.freeze({
  civilian: "civilianEnabled",
  rats: "ratsEnabled",
  ratsMission: "missionRatsEnabled",
  lneFleets: "lneFleetsEnabled",
});

function createState() {
  return { pending: [], active: new Map(), perSystem: new Map(), seenWrecks: new Set() };
}

function lifetimeOf(cfg) {
  return Math.max(cfg.maxLifetimeMs, cfg.warpDelayMs + cfg.despawnAfterWarpMs);
}

function sourceEnabled(cfg, source) {
  const flag = Object.prototype.hasOwnProperty.call(SOURCE_FLAGS, source) ? SOURCE_FLAGS[source] : null;
  return flag !== null && cfg[flag] === true;
}

function admit(state, facts, cfg, now) {
  if (!sourceEnabled(cfg, facts.source)) return { ok: false, reason: "SOURCE_OFF" };
  if (state.seenWrecks.has(facts.wreckId)) return { ok: false, reason: "DUPLICATE" };
  if ((state.perSystem.get(facts.sceneKey) || 0) >= cfg.maxPerSystem) return { ok: false, reason: "SYSTEM_FULL" };
  if (state.pending.length + state.active.size >= cfg.maxGlobal) return { ok: false, reason: "GLOBAL_FULL" };
  if (state.pending.length >= cfg.maxPending) return { ok: false, reason: "QUEUE_FULL" };
  state.pending.push({ ...facts, queuedAtMs: now });
  state.seenWrecks.add(facts.wreckId);
  state.perSystem.set(facts.sceneKey, (state.perSystem.get(facts.sceneKey) || 0) + 1);
  return { ok: true };
}

function release(state, sceneKey, wreckId) {
  state.seenWrecks.delete(wreckId);
  const n = (state.perSystem.get(sceneKey) || 0) - 1;
  if (n > 0) state.perSystem.set(sceneKey, n);
  else state.perSystem.delete(sceneKey);
}

function directionOf(wreckId) {
  const x = deterministicUnit(RNG_STREAM, wreckId, "x") * 2 - 1;
  const y = deterministicUnit(RNG_STREAM, wreckId, "y") * 2 - 1;
  const z = deterministicUnit(RNG_STREAM, wreckId, "z") * 2 - 1;
  const length = Math.hypot(x, y, z);
  if (!(length > 0)) return { ...FALLBACK_DIRECTION };
  return { x: x / length, y: y / length, z: z / length };
}

function offsetPoint(from, dir, meters) {
  return { x: from.x + dir.x * meters, y: from.y + dir.y * meters, z: from.z + dir.z * meters };
}

function spawnPointOf(facts, dir, cfg) {
  return offsetPoint(facts.position, dir, facts.radius + cfg.spawnOffsetMeters);
}

function warpPointOf(spawnPoint, dir, cfg) {
  return offsetPoint(spawnPoint, dir, cfg.warpDistanceAu * METERS_PER_AU);
}

function schedule(spawnedAtMs, cfg) {
  return { warpAtMs: spawnedAtMs + cfg.warpDelayMs, removeAtMs: spawnedAtMs + lifetimeOf(cfg) };
}

function dueActions(state, now, cfg) {
  const out = { spawn: [], stale: [], warp: [], remove: [] };
  if (state.pending.length === 0 && state.active.size === 0) return out;
  let actions = cfg.maxActionsPerPass;
  for (const entry of state.active.values()) {
    if (actions <= 0) break;
    if (now >= entry.removeAtMs) {
      out.remove.push(entry);
      actions -= 1;
    }
  }
  for (const entry of state.active.values()) {
    if (actions <= 0) break;
    if (now < entry.removeAtMs && entry.warpedAtMs === null && entry.warpFailed !== true && now >= entry.warpAtMs) {
      out.warp.push(entry);
      actions -= 1;
    }
  }
  for (const entry of state.pending) {
    if (now - entry.queuedAtMs > cfg.pendingMaxAgeMs) out.stale.push(entry);
    else if (out.spawn.length < cfg.maxSpawnsPerPass) out.spawn.push(entry);
  }
  return out;
}

module.exports = { METERS_PER_AU, SOURCE_FLAGS, createState, lifetimeOf, admit, release, directionOf, spawnPointOf,
  warpPointOf, schedule, dueActions };
