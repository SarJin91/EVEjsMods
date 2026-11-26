"use strict";

const STATUS = Object.freeze({ OPEN: "open", CLOSED: "closed" });

function isRoutable(pair, opts) {
  if (!pair || pair.active !== true) return false;
  if (pair.fromSystemId === pair.toSystemId) return false;
  if (!opts.hasSystem(pair.fromSystemId) || !opts.hasSystem(pair.toSystemId)) return false;
  return pair.expiresAt === 0 || pair.expiresAt - opts.now >= opts.minRemainingMs;
}

function byKey(a, b) {
  if (a.connectionId < b.connectionId) return -1;
  return a.connectionId > b.connectionId ? 1 : 0;
}

function createdAtOf(pair) {
  return Number.isSafeInteger(pair.createdAt) && pair.createdAt > 0 ? pair.createdAt : 0;
}

function diffWormholeEdges(prev, pairs, opts) {
  const next = new Map();
  for (const pair of pairs) {
    if (!isRoutable(pair, opts)) continue;
    next.set(pair.pairKey, Object.freeze({ fromSystemId: pair.fromSystemId, toSystemId: pair.toSystemId,
      expiresAt: pair.expiresAt, maxJumpMass: pair.maxJumpMass, createdAt: createdAtOf(pair) }));
  }
  const closed = [];
  const opened = [];
  for (const [connectionId, edge] of prev) {
    if (next.has(connectionId)) continue;
    closed.push({ connectionId, state: { fromSystemId: edge.fromSystemId, toSystemId: edge.toSystemId,
      status: STATUS.CLOSED, expiresAtMs: edge.expiresAt, maxJumpMass: edge.maxJumpMass,
      createdAtMs: edge.createdAt || 0 } });
  }
  for (const [connectionId, edge] of next) {
    const old = prev.get(connectionId);
    if (old !== undefined && old.fromSystemId === edge.fromSystemId && old.toSystemId === edge.toSystemId
      && old.expiresAt === edge.expiresAt && old.maxJumpMass === edge.maxJumpMass
      && (old.createdAt || 0) === edge.createdAt) continue;
    opened.push({ connectionId, state: { fromSystemId: edge.fromSystemId, toSystemId: edge.toSystemId,
      status: STATUS.OPEN, expiresAtMs: edge.expiresAt, maxJumpMass: edge.maxJumpMass, createdAtMs: edge.createdAt } });
  }
  return { next, changes: [...closed.sort(byKey), ...opened.sort(byKey)] };
}

module.exports = { STATUS, isRoutable, diffWormholeEdges };
