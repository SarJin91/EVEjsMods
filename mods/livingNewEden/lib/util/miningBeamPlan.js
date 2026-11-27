"use strict";

const FOLLOW_GAP_METERS = 1000;

function isPoint(p) {
  return Boolean(p) && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z);
}

function distanceSq(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return (dx * dx) + (dy * dy) + (dz * dz);
}

function viewersOf(miners, players, viewMeters) {
  const rangeSq = viewMeters * viewMeters;
  const placed = miners.filter((m) => m && isPoint(m.position));
  const out = new Set();
  for (const p of players) {
    if (!p || p.inWarp === true || !Number.isSafeInteger(p.characterId) || !isPoint(p.position)) continue;
    if (placed.some((m) => distanceSq(m.position, p.position) <= rangeSq)) out.add(p.characterId);
  }
  return out;
}

function stopsOf(shown, keep) {
  const out = [];
  for (const [entityId, rockId] of shown) if (!keep || !keep.has(entityId)) out.push({ entityId, rockId });
  return out;
}

function startOf(m) {
  return { entityId: m.entityId, beltId: Number.isSafeInteger(m.beltId) ? m.beltId : null };
}

function approachingOf(state) {
  return state && state.approaching instanceof Map ? state.approaching : new Map();
}

function retryAtOf(state) {
  return state && Number.isFinite(state.retryAt) ? state.retryAt : -Infinity;
}

function followMetersOf(approachMeters, startMeters) {
  return Math.min(approachMeters, startMeters - FOLLOW_GAP_METERS);
}

function planBeams(input) {
  const now = input.now;
  const miners = (Array.isArray(input.miners) ? input.miners : [])
    .filter((m) => m && Number.isSafeInteger(m.entityId) && m.entityId > 0);
  const players = Array.isArray(input.players) ? input.players : [];
  const state = input.state || null;
  const shown = state && state.shown instanceof Map ? state.shown : new Map();
  const before = state && state.viewers instanceof Set ? state.viewers : new Set();
  const nextAt = state && Number.isFinite(state.nextAt) ? state.nextAt : -Infinity;
  const approaching = approachingOf(state);
  const retryAt = retryAtOf(state);
  const retryMs = Number.isFinite(input.retryMs) && input.retryMs > 0 ? input.retryMs : null;
  const viewers = input.suppress === true ? new Set() : viewersOf(miners, players, input.viewMeters);
  if (viewers.size === 0) {
    return { start: [], stop: stopsOf(shown, null), release: [...approaching.keys()], viewers, full: false, nextAt,
      now, retryMs, retryAt };
  }
  const mining = new Set(miners.map((m) => m.entityId));
  const release = [...approaching.keys()].filter((id) => !mining.has(id));
  const newViewer = [...viewers].some((id) => !before.has(id));
  if (newViewer || now >= nextAt) {
    return { start: miners.map(startOf), stop: stopsOf(shown, null), release, viewers, full: true,
      nextAt: now + input.refreshMs, now, retryMs, retryAt: retryMs === null ? -Infinity : now + retryMs };
  }
  const retryDue = retryMs !== null && now >= retryAt;
  const start = miners.filter((m) => !shown.has(m.entityId)
    && (retryMs === null || retryDue || !approaching.has(m.entityId))).map(startOf);
  return { start, stop: stopsOf(shown, mining), release, viewers, full: false, nextAt, now, retryMs,
    retryAt: retryDue ? now + retryMs : retryAt };
}

function idsOf(list) {
  return Array.isArray(list) ? list : [];
}

function applyBeams(state, plan, result) {
  const prevShown = state && state.shown instanceof Map ? state.shown : new Map();
  const prevApproaching = approachingOf(state);
  if (!plan || !result || result.ok !== true) {
    return { shown: new Map(prevShown), viewers: new Set(), nextAt: state && Number.isFinite(state.nextAt)
      ? state.nextAt : -Infinity, approaching: new Map(prevApproaching), retryAt: retryAtOf(state) };
  }
  const shown = new Map();
  if (!plan.full && plan.viewers.size > 0) {
    const stopped = new Set(plan.stop.map((s) => s.entityId));
    for (const [entityId, rockId] of prevShown) if (!stopped.has(entityId)) shown.set(entityId, rockId);
  }
  const started = idsOf(result.started);
  for (const s of started) shown.set(s.entityId, s.rockId);
  const approaching = new Map(prevApproaching);
  for (const id of idsOf(plan.release)) approaching.delete(id);
  for (const id of idsOf(result.released)) approaching.delete(id);
  for (const s of started) approaching.delete(s.entityId);
  for (const a of idsOf(result.approaching)) approaching.set(a.entityId, a.rockId);
  for (const id of idsOf(result.busy)) approaching.set(id, 0);
  const retryAt = approaching.size > 0 && Number.isFinite(plan.retryAt) && plan.retryMs !== null
    && plan.retryMs !== undefined ? plan.retryAt : -Infinity;
  return { shown, viewers: new Set(plan.viewers), nextAt: plan.nextAt, approaching, retryAt };
}

module.exports = { planBeams, applyBeams, followMetersOf };
