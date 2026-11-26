"use strict";

const { jumpMsForComposition } = require("../travel");
const { HULL_TRAVEL, GATE_TRANSIT_MS } = require("../data/travelProfiles");
const { entryGateOf } = require("./anchors");

const MS_PER_SECOND = 1000;
const GATE = Object.freeze({ IN: "in", OUT: "out" });
const GATE_ORDER = Object.freeze([GATE.IN, GATE.OUT]);

const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isId = (v) => Number.isSafeInteger(v) && v > 0;

function alignRawOf(hullGroup) {
  return Object.prototype.hasOwnProperty.call(HULL_TRAVEL, hullGroup)
    ? HULL_TRAVEL[hullGroup].alignSeconds * MS_PER_SECOND : 0;
}

function legOf(leg) {
  if (!leg || typeof leg !== "object" || !Array.isArray(leg.systems) || !leg.systems.every(isId)) return null;
  if (!isTime(leg.departAt) || !Number.isSafeInteger(leg.jumpMs) || leg.jumpMs < 1) return null;
  return leg;
}

function transitTimelineOf(leg, systemIndex, composition) {
  try {
    const l = legOf(leg);
    if (!l) return { ok: false, reason: "BAD_LEG" };
    if (!Number.isSafeInteger(systemIndex) || systemIndex <= 0 || systemIndex >= l.systems.length - 1) {
      return { ok: false, reason: "NOT_INNER" };
    }
    const raw = jumpMsForComposition(composition, { timeFactor: 1 });
    if (!raw.ok) return { ok: false, reason: raw.reason };
    const rawJumpMs = raw.baseJumpMs;
    const alignRaw = alignRawOf(raw.hullGroup);
    const s = l.jumpMs / rawJumpMs;
    const from = l.departAt + systemIndex * l.jumpMs;
    const until = from + l.jumpMs;
    const inUntil = Math.min(until, from + Math.round(s * alignRaw));
    const outFrom = Math.min(until, from + Math.round(s * Math.max(0, rawJumpMs - GATE_TRANSIT_MS)));
    return { ok: true, from, inUntil, outFrom, until, alignRaw, rawJumpMs, s, hullGroup: raw.hullGroup };
  } catch (_err) {
    return { ok: false, reason: "BAD_LEG" };
  }
}

function catchAtOf(timeline, gate, lockMs) {
  const lock = Number.isSafeInteger(lockMs) && lockMs > 0 ? lockMs : 0;
  const rawAt = gate === GATE.OUT ? Math.max(0, timeline.rawJumpMs - GATE_TRANSIT_MS) + lock : lock;
  const at = timeline.from + Math.round(timeline.s * rawAt);
  return Math.max(timeline.from, Math.min(timeline.until - 1, at));
}

function exposedOf(gate, timeline, exposureMs, lockMs) {
  if (gate === GATE.IN) return timeline.alignRaw > lockMs;
  if (gate === GATE.OUT) return Number.isFinite(exposureMs) && exposureMs > lockMs;
  return false;
}

function gatesOf(anchors, leg, systemIndex) {
  const l = legOf(leg);
  if (!l || !Number.isSafeInteger(systemIndex) || systemIndex <= 0 || systemIndex >= l.systems.length - 1) {
    return { in: null, out: null };
  }
  return { in: entryGateOf(anchors, l.systems[systemIndex - 1]), out: entryGateOf(anchors, l.systems[systemIndex + 1]) };
}

function nextCrossingOf(leg, composition, after, candidateSystems, exposureOf, settings) {
  try {
    const l = legOf(leg);
    if (!l || !(candidateSystems instanceof Set) || candidateSystems.size === 0) return null;
    const lockMs = settings && Number.isSafeInteger(settings.lockMs) ? settings.lockMs : 0;
    const startI = after && Number.isSafeInteger(after.i) ? Math.max(1, after.i) : 1;
    for (let i = startI; i < l.systems.length - 1; i += 1) {
      const systemId = l.systems[i];
      if (!candidateSystems.has(systemId)) continue;
      const tl = transitTimelineOf(l, i, composition);
      if (!tl.ok) return null;
      for (const gate of GATE_ORDER) {
        if (after && i === after.i && GATE_ORDER.indexOf(gate) <= GATE_ORDER.indexOf(after.gate)) continue;
        const exposure = gate === GATE.OUT && typeof exposureOf === "function" ? exposureOf(systemId) : 0;
        if (!exposedOf(gate, tl, exposure, lockMs)) continue;
        return { systemIndex: i, systemId, gate, at: catchAtOf(tl, gate, lockMs) };
      }
    }
    return null;
  } catch (_err) {
    return null;
  }
}

function gateGridsOf(anchors, gridOf, leg, systemIndex) {
  try {
    const g = gatesOf(anchors, leg, systemIndex);
    const withGrid = (a) => {
      if (!a) return null;
      const ref = `${a.kind}:${a.id}`;
      const key = gridOf instanceof Map ? gridOf.get(ref) : undefined;
      return Object.freeze({ anchor: Object.freeze({ kind: a.kind, id: a.id }),
        gridKey: typeof key === "string" ? key : ref });
    };
    return { in: withGrid(g.in), out: withGrid(g.out) };
  } catch (_err) {
    return { in: null, out: null };
  }
}

function preparedCatchOf(input) {
  try {
    const grids = input && input.grids ? input.grids : null;
    if (!grids || (!grids.in && !grids.out)) return { ok: false, reason: "NO_GATE" };
    const tl = input.timeline;
    const at = input.at;
    if (!tl || !Number.isFinite(at)) return { ok: false, reason: "GATE_AWAY" };
    const has = (set, g) => Boolean(g) && set instanceof Set && set.has(g.gridKey);
    if (input.onlyOut !== true && has(input.inGridKeys, grids.in) && at < Math.max(tl.inUntil, tl.from + 1)) {
      return { ok: true, gate: GATE.IN, catchAt: Math.max(at, tl.from), anchor: grids.in.anchor };
    }
    if (has(input.outGridKeys, grids.out)) {
      return { ok: true, gate: GATE.OUT, catchAt: outCatchAtOf(tl, at), anchor: grids.out.anchor };
    }
    return { ok: false, reason: "GATE_AWAY" };
  } catch (_err) {
    return { ok: false, reason: "GATE_AWAY" };
  }
}

function outCatchAtOf(timeline, at) {
  return Math.min(timeline.until - 1, Math.max(at, timeline.outFrom));
}

module.exports = { GATE, alignRawOf, transitTimelineOf, catchAtOf, exposedOf, gatesOf, nextCrossingOf, gateGridsOf,
  preparedCatchOf, outCatchAtOf };
