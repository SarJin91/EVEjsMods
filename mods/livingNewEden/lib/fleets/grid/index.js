"use strict";

const { performance } = require("node:perf_hooks");
const { anchorRef, orderAnchors, clusterAnchors, controlPointOf } = require("./anchors");
const { gridPositionAt, isVisitValid } = require("./position");
const repo = require("./visitRepository");
const { VIA } = require("./schema");
const { createAnchorCache } = require("./anchorCache");
const { createGridMoves } = require("./moves");

const GRID_METRICS = Object.freeze({
  visitsWritten: "fleets.grid.visitsWritten",
  visitsDuplicate: "fleets.grid.visitsDuplicate",
  visitsPurged: "fleets.grid.visitsPurged",
  recordErrors: "fleets.grid.recordErrors",
  anchorCacheMiss: "fleets.grid.anchorCacheMiss",
  anchorsUnavailable: "fleets.grid.anchorsUnavailable",
  anchorsTruncated: "fleets.grid.anchorsTruncated",
  anchorGone: "fleets.grid.anchorGone",
  anchorReadMs: "fleets.grid.anchorReadMs",
  anchorCacheSize: "fleets.grid.anchorCacheSize",
  movesPlanned: "fleets.grid.movesPlanned",
  movesSameGrid: "fleets.grid.movesSameGrid",
  movesStay: "fleets.grid.movesStay",
  movesRefused: "fleets.grid.movesRefused",
  movesLimited: "fleets.grid.movesLimited",
  workTargetMissing: "fleets.grid.workTargetMissing",
  moveArrivals: "fleets.grid.moveArrivals",
  moveArrivalsStale: "fleets.grid.moveArrivalsStale",
  gridListenerErrors: "fleets.grid.gridListenerErrors",
  moveMs: "fleets.grid.moveMs",
  movesDeferred: "fleets.grid.movesDeferred",
  workOverrideErrors: "fleets.grid.workOverrideErrors",
  alignHeld: "fleets.grid.alignHeld",
  placed: "fleets.grid.placed",
});
const COUNTER_NAMES = Object.freeze(["visitsWritten", "visitsDuplicate", "visitsPurged", "recordErrors",
  "anchorCacheMiss", "anchorsUnavailable", "anchorsTruncated", "anchorGone", "movesPlanned", "movesSameGrid",
  "movesStay", "movesRefused", "movesLimited", "workTargetMissing", "moveArrivals", "moveArrivalsStale",
  "gridListenerErrors", "movesDeferred", "workOverrideErrors", "alignHeld", "placed"]);
const LOCK_MS_RANGE = Object.freeze([0, 60000]);
const INTEGER_SETTINGS = Object.freeze([
  ["contactRangeM", 10000, 8000000],
  ["maxAnchorsPerSystem", 8, 256],
  ["anchorCacheSystems", 16, 8192],
  ["dynamicAnchorTtlMs", 10000, 3600000],
  ["visitPurgePerWrite", 0, 64],
  ["maxPositionsPerCall", 16, 1024],
  ["maxMovesPerVisit", 1, 64],
  ["workTargetScanFleets", 1, 64],
  ["moveArrivalMaxPerPass", 1, 1024],
]);
const UNAVAILABLE = "GRID_ANCHORS_UNAVAILABLE";
const MS_DECIMALS = 10;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const detailOf = (err) => String((err && err.message) || err);

function gridSettings(config) {
  const g = (config && config.grid) || null;
  if (!g || typeof g.enabled !== "boolean") return { ok: false, key: "enabled" };
  if (typeof g.movesEnabled !== "boolean") return { ok: false, key: "movesEnabled" };
  const settings = { enabled: g.enabled, movesEnabled: g.movesEnabled };
  for (const [key, min, max] of INTEGER_SETTINGS) {
    const v = g[key];
    if (!Number.isSafeInteger(v) || v < min || v > max) return { ok: false, key };
    settings[key] = v;
  }
  const factor = config.fleets && config.fleets.travelTimeFactor;
  if (typeof factor !== "number" || !Number.isFinite(factor) || factor <= 0) {
    return { ok: false, key: "fleets.travelTimeFactor" };
  }
  settings.timeFactor = factor;
  const cr = g.crossings;
  settings.crossingsEnabled = false;
  settings.lockMs = 0;
  if (cr !== undefined && cr !== null) {
    if (typeof cr !== "object" || typeof cr.enabled !== "boolean") return { ok: false, key: "crossings.enabled" };
    if (!Number.isSafeInteger(cr.lockMs) || cr.lockMs < LOCK_MS_RANGE[0] || cr.lockMs > LOCK_MS_RANGE[1]) {
      return { ok: false, key: "crossings.lockMs" };
    }
    settings.crossingsEnabled = cr.enabled;
    settings.lockMs = cr.lockMs;
  }
  return { ok: true, settings: Object.freeze(settings) };
}

function visitOf(fleet, visit) {
  if (!isVisitValid(fleet, visit)) return null;
  return Object.freeze({ moveSeq: visit.moveSeq, purpose: visit.purpose, targetFleetId: visit.targetFleetId,
    attempts: visit.attempts, arriveAt: Number.isSafeInteger(visit.arriveAt) ? visit.arriveAt : null });
}

const SYSTEM_CP = (systemId) => Object.freeze({ kind: "system", id: systemId, position: null, toSystemId: null,
  lneStationId: null, lneSovStructureId: null, ownerCorpId: null });

function createUnavailableGrid(reason) {
  const off = Object.freeze({ ok: false, reason: "GRID_OFF" });
  return Object.freeze({ isEnabled: () => false, movesEnabled: () => false, readSystemGrid: () => off,
    positionsOf: () => off, moveInTx: () => off, moveGroupInTx: () => off, addGridArrivalListener: () => off,
    addWorkTargetOverride: () => off, placeInTx: () => off,
    getStatus: () => Object.freeze({ enabled: false, movesEnabled: false, lastMoveRefusal: null,
      reason: reason === undefined ? null : String(reason) }) });
}

function createGrid(deps) {
  const adapter = deps.adapter || null;
  const clock = deps.clock;
  const telemetry = deps.telemetry || null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const parsed = gridSettings(deps.config);
  const settings = parsed.ok ? parsed.settings : null;
  const configReason = parsed.ok ? null : `GRID_CONFIG_INVALID:${parsed.key}`;
  const counters = Object.fromEntries(COUNTER_NAMES.map((name) => [name, 0]));
  let stopped = false;
  const cache = settings ? createAnchorCache({ maxSystems: settings.anchorCacheSystems,
    ttlMs: settings.dynamicAnchorTtlMs, clock }) : null;

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  }
  function bump(name, n = 1) {
    counters[name] += n;
    metric("count", GRID_METRICS[name], n);
  }

  const isEnabled = () => !stopped && settings !== null && settings.enabled === true;
  const movesEnabled = () => isEnabled() && settings.movesEnabled === true;

  function recordArrivalInTx(tx, arrival, context) {
    if (!isEnabled()) return { ok: true, written: false };
    const entry = arrival && arrival.entry ? arrival.entry : { via: VIA.NONE, fromSystemId: null };
    try {
      const r = repo.recordArrivalInTx(tx, { fleetId: arrival.fleetId, systemId: arrival.systemId,
        legSeq: arrival.legSeq, at: arrival.at, via: entry.via, fromSystemId: entry.fromSystemId });
      if (!r.ok) {
        bump("recordErrors");
        return { ok: false, reason: "GRID_RECORD_FAILED", detail: r.detail };
      }
      if (!r.written) {
        bump("visitsDuplicate");
        return { ok: true, written: false };
      }
      bump("visitsWritten");
      const p = repo.purgeStaleInSystemInTx(tx, arrival.systemId, arrival.fleetId, settings.visitPurgePerWrite);
      if (p.ok && p.purged > 0) bump("visitsPurged", p.purged);
      if (moves !== null && context && movesEnabled()) {
        try {
          moves.planWorkMoveInTx(tx, arrival, context);
        } catch (err) {
          if (!tx || tx.inTransaction === false) throw err;
          bump("movesRefused");
        }
      }
      return { ok: true, written: true };
    } catch (err) {
      if (!tx || tx.inTransaction === false) throw err;
      bump("recordErrors");
      return { ok: false, reason: "GRID_RECORD_FAILED", detail: detailOf(err) };
    }
  }

  function systemGrid(systemId) {
    const hit = cache.get(systemId);
    if (hit) return { ok: true, entry: hit, cached: true };
    bump("anchorCacheMiss");
    if (!adapter || typeof adapter.readGridAnchors !== "function") {
      bump("anchorsUnavailable");
      return { ok: false, reason: UNAVAILABLE, detail: "adapter" };
    }
    const t0 = nowMs();
    let r;
    try {
      r = adapter.readGridAnchors(systemId, { maxAnchors: settings.maxAnchorsPerSystem });
    } catch (err) {
      r = { ok: false, reason: UNAVAILABLE, detail: detailOf(err) };
    }
    metric("observe", GRID_METRICS.anchorReadMs, Math.round((nowMs() - t0) * MS_DECIMALS) / MS_DECIMALS);
    if (!r || r.ok !== true || !Array.isArray(r.anchors)) {
      bump("anchorsUnavailable");
      const reason = r && r.reason === "INVALID_INPUT" ? "INVALID_INPUT" : UNAVAILABLE;
      return { ok: false, reason, ...(r && r.detail ? { detail: String(r.detail) } : {}) };
    }
    const anchors = Object.freeze(orderAnchors(r.anchors));
    const { grids, gridOf } = clusterAnchors(anchors, settings.contactRangeM);
    const byRef = new Map(anchors.map((a) => [anchorRef(a.kind, a.id), a]));
    if (r.truncated === true) bump("anchorsTruncated");
    const entry = Object.freeze({ systemId, anchors, byRef, grids: Object.freeze(grids.map((g) => Object.freeze({
      gridKey: g.gridKey, anchors: Object.freeze(g.anchors) }))), gridOf, cp: controlPointOf(anchors, systemId),
    truncated: r.truncated === true, readAt: clock.now() });
    cache.set(systemId, entry);
    metric("gauge", GRID_METRICS.anchorCacheSize, cache.size());
    return { ok: true, entry, cached: false };
  }

  function readSystemGrid(systemId) {
    if (!isEnabled()) return { ok: false, reason: "GRID_OFF" };
    if (!isId(systemId)) return { ok: false, reason: "INVALID_INPUT", detail: "systemId" };
    const s = systemGrid(systemId);
    if (!s.ok) return s;
    const e = s.entry;
    return { ok: true, anchors: e.anchors, grids: e.grids, cp: e.cp, truncated: e.truncated, cached: s.cached };
  }

  function positionsOf(tx, systemId, fleets, at, opts) {
    if (!isEnabled()) return { ok: false, reason: "GRID_OFF" };
    if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
    if (!isId(systemId)) return { ok: false, reason: "INVALID_INPUT", detail: "systemId" };
    if (!Array.isArray(fleets) || fleets.length > settings.maxPositionsPerCall) {
      return { ok: false, reason: "INVALID_INPUT", detail: "fleets" };
    }
    if (!fleets.every((f) => f && typeof f.fleetId === "string")) {
      return { ok: false, reason: "INVALID_INPUT", detail: "fleets" };
    }
    if (!Number.isFinite(at)) return { ok: false, reason: "INVALID_INPUT", detail: "at" };
    const s = systemGrid(systemId);
    let anchorsReason = null;
    let sys;
    if (s.ok) {
      sys = s.entry;
    } else {
      anchorsReason = s.reason;
      sys = { systemId, anchors: [], byRef: new Map(), gridOf: new Map(), cp: SYSTEM_CP(systemId) };
    }
    const read = repo.getManyInTx(tx, fleets.map((f) => f.fleetId));
    if (!read.ok) return { ok: false, reason: "INVALID_INPUT", detail: read.detail };
    const withVisit = Boolean(opts && opts.withVisit === true);
    const positions = new Map();
    for (const f of fleets) {
      const visit = read.visits.get(f.fleetId) || null;
      const pos = gridPositionAt(f, visit, at, sys);
      if (pos.source === "GONE") bump("anchorGone");
      positions.set(f.fleetId, withVisit ? { ...pos, visit: visitOf(f, visit) } : pos);
    }
    return { ok: true, positions, anchorsReason };
  }

  const moves = settings && deps.store && deps.repository ? createGridMoves({ store: deps.store,
    repository: deps.repository, scheduler: deps.scheduler || null, clock, settings, worldSeed: deps.worldSeed,
    systemGrid, isEnabled, movesEnabled, bump,
    observe: (name, value) => metric("observe", GRID_METRICS[name], value) }) : null;
  const movesOff = Object.freeze({ ok: false, reason: "GRID_OFF" });

  function moveInTx(tx, spec, opts) {
    return moves === null ? movesOff : moves.moveInTx(tx, spec, opts);
  }

  function moveGroupInTx(tx, spec, opts) {
    return moves === null ? movesOff : moves.moveGroupInTx(tx, spec, opts);
  }

  function addWorkTargetOverride(fn) {
    if (typeof fn !== "function") return { ok: false, reason: "INVALID_LISTENER" };
    return moves === null ? movesOff : moves.addWorkTargetOverride(fn);
  }

  function addGridArrivalListener(fn) {
    if (typeof fn !== "function") return { ok: false, reason: "INVALID_LISTENER" };
    return moves === null ? movesOff : moves.addGridArrivalListener(fn);
  }

  function placeInTx(tx, spec) {
    if (!isEnabled()) return { ok: false, reason: "GRID_OFF" };
    if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
    if (!spec || typeof spec !== "object" || !isId(spec.systemId) || !spec.anchor || typeof spec.anchor !== "object") {
      return { ok: false, reason: "INVALID_INPUT", detail: "spec" };
    }
    const s = systemGrid(spec.systemId);
    if (!s.ok) return { ok: false, reason: "ANCHORS_UNAVAILABLE", detail: s.reason };
    if (!s.entry.byRef.has(anchorRef(spec.anchor.kind, spec.anchor.id))) {
      return { ok: false, reason: "TARGET_UNKNOWN", detail: anchorRef(spec.anchor.kind, spec.anchor.id) };
    }
    try {
      const r = repo.placeAtInTx(tx, { fleetId: spec.fleetId, systemId: spec.systemId, legSeq: spec.legSeq,
        anchor: { kind: spec.anchor.kind, id: spec.anchor.id }, at: spec.at });
      if (!r.ok) return r;
      if (r.placed) bump("placed");
      return r;
    } catch (err) {
      if (!tx || tx.inTransaction === false) throw err;
      return { ok: false, reason: "INVALID_INPUT", detail: detailOf(err) };
    }
  }

  function getStatus() {
    return Object.freeze({ enabled: isEnabled(), movesEnabled: movesEnabled(),
      reason: configReason || (stopped ? "STOPPED" : null), cacheSize: cache ? cache.size() : 0,
      lastMoveRefusal: moves ? moves.getLastRefusal() : null, counters: Object.freeze({ ...counters }) });
  }

  const facade = Object.freeze({ isEnabled, movesEnabled, readSystemGrid, positionsOf, moveInTx, moveGroupInTx,
    addGridArrivalListener, addWorkTargetOverride, placeInTx, getStatus });
  return { recorder: Object.freeze({ recordArrivalInTx }), facade, handlers: moves ? moves.handlers : null, stop() {
    stopped = true;
    if (cache) cache.clear();
    if (moves) moves.clearListeners();
  } };
}

module.exports = { createGrid, createUnavailableGrid, gridSettings, GRID_METRICS };
