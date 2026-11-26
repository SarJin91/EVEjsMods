"use strict";

const { performance } = require("node:perf_hooks");
const { OPEN_BATTLE_STATES } = require("../../battle/schema");
const { OPEN_OPERATION_STATES } = require("../../fleets/schema");
const { positionAt } = require("../../fleets/travel");
const S = require("../../world/occupation/schema");
const siteRepository = require("../../events/sites/siteRepository");
const anomalyRepository = require("../../events/salvage/anomalyRepository");

const VIEW_ID = "system-interior";
const WORK_CLASS = "MAINTENANCE";
const METRIC_BUILD_MS = "observer.systemInteriorMs";
const METRIC_DEFERRALS = "observer.systemInterior.deferrals";
const METRIC_STATIC_HIT = "observer.systemInterior.staticHit";
const METRIC_STATIC_MISS = "observer.systemInterior.staticMiss";
const MS_DECIMALS = 10;
const DESTROYED = "DESTROYED";
const ENGAGED = "ENGAGED";
const PRESENT_STATES = Object.freeze([...S.STANDING_FLEET_STATES, ENGAGED]);
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const ANGLE_STEPS = 3600;
const STATION_ROLES = Object.freeze(["garrison", "reserve", "logistics"]);
const SUN_FALLBACK = Object.freeze({ kind: "sun", itemId: null });
const MATERIALIZED = "MATERIALIZED";
const LIVE = "LIVE";
const SPACE_ANCHOR = Object.freeze({ kind: "space", itemId: null });
const GRID_SHOWN_SOURCES = Object.freeze(["ENTRY", "MOVE"]);
const GRID_STATIC_KINDS = Object.freeze(["gate", "station", "belt", "sun"]);
const GRID_SPACE_KINDS = Object.freeze(["structure", "pos"]);

function call(obj, name) {
  try {
    return obj && typeof obj[name] === "function" ? obj[name]() : undefined;
  } catch (_err) {
    return undefined;
  }
}

function section(fn) {
  try {
    const v = fn();
    return v === undefined ? null : v;
  } catch (_err) {
    return null;
  }
}

function running(service) {
  if (!service || typeof service.getStatus !== "function") return false;
  const st = call(service, "getStatus");
  return Boolean(st && st.state === "running");
}

function fnv1a(key) {
  const s = String(key);
  let h = FNV_OFFSET;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, FNV_PRIME) >>> 0;
  }
  return h >>> 0;
}

function projectPosition(p, origin) {
  if (!p || typeof p !== "object") return null;
  const o = origin || { x: 0, y: 0, z: 0 };
  const x = Number(p.x) - Number(o.x);
  const y = -(Number(p.z) - Number(o.z));
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

function assignAnchors(objects, statics, systemId, live) {
  const byKind = new Map();
  if (statics && Array.isArray(statics.objects)) {
    for (const o of statics.objects) {
      if (!byKind.has(o.kind)) byKind.set(o.kind, []);
      byKind.get(o.kind).push(o);
    }
    for (const list of byKind.values()) list.sort((a, b) => a.itemId - b.itemId);
  }
  const anchorOf = (kinds, key) => {
    if (!statics) return SUN_FALLBACK;
    for (const k of kinds) {
      const list = byKind.get(k);
      if (list && list.length > 0) {
        const o = list[fnv1a(key) % list.length];
        return { kind: o.kind, itemId: o.itemId };
      }
    }
    return SUN_FALLBACK;
  };
  const enroute = (key) => (statics ? { kind: "enroute", itemId: null,
    angle: ((fnv1a(key) % ANGLE_STEPS) / ANGLE_STEPS) * 2 * Math.PI } : SUN_FALLBACK);

  const battles = objects.battles === null || objects.battles === undefined ? null
    : objects.battles.map((b) => ({ ...b, anchor: anchorOf(["gate", "belt", "planet", "sun"], b.battleId) }));
  const firstOpen = battles && battles.length > 0
    ? [...battles].sort((a, b) => (a.battleId < b.battleId ? -1 : (a.battleId > b.battleId ? 1 : 0)))[0] : null;

  const fleetAnchor = (f) => {
    if (f.state === ENGAGED && firstOpen) return firstOpen.anchor;
    if (f.role === "mining") return anchorOf(["belt", "planet", "sun"], f.fleetId);
    if (STATION_ROLES.includes(f.role)) return anchorOf(["station", "gate", "planet", "sun"], f.fleetId);
    return anchorOf(["gate", "planet", "sun"], f.fleetId);
  };
  const staticById = new Map();
  for (const list of byKind.values()) for (const o of list) staticById.set(o.itemId, o);
  const origin = statics && statics.system && statics.system.origin ? statics.system.origin : null;
  const gridAnchorOf = (f) => {
    const g = f.grid;
    if (!statics || !g || !GRID_SHOWN_SOURCES.includes(g.source)) return null;
    if (GRID_STATIC_KINDS.includes(g.anchorKind)) {
      const st = staticById.get(g.anchorId);
      return st && st.kind === g.anchorKind ? { ...f, anchor: { kind: st.kind, itemId: st.itemId } } : null;
    }
    const pos = GRID_SPACE_KINDS.includes(g.anchorKind) ? projectPosition(g.position, origin) : null;
    return pos ? { ...f, position: pos, anchor: null } : null;
  };
  const fleetRow = (f) => {
    if (!(f.state === ENGAGED && firstOpen)) {
      const g = gridAnchorOf(f);
      if (g) return g;
    }
    return { ...f, anchor: fleetAnchor(f) };
  };
  const materializedRow = (f) => {
    const l = live instanceof Map ? live.get(f.fleetId) : undefined;
    const obj = l && l.object ? l.object : null;
    const st = obj && obj.itemId !== null ? staticById.get(obj.itemId) : undefined;
    const info = { source: l ? l.source : null, mode: l ? l.mode : null, phase: l ? l.phase : null,
      objectKind: obj ? obj.kind : null, objectItemId: obj ? obj.itemId : null, objectName: st ? st.name || null : null };
    if (st) return { ...f, live: info, anchor: { kind: st.kind, itemId: st.itemId } };
    const pos = statics && obj && obj.point ? projectPosition(obj.point, origin) : null;
    if (pos) return { ...f, live: info, position: pos, anchor: null };
    return { ...f, live: info, anchor: statics ? SPACE_ANCHOR : SUN_FALLBACK };
  };
  const incomingAnchor = (f) => {
    if (!statics) return SUN_FALLBACK;
    if (f.nextSystemId === systemId) {
      const gates = byKind.get("gate") || [];
      const gate = gates.find((g) => g.toSystemId === f.fromSystemId);
      if (gate) return { kind: "gate", itemId: gate.itemId };
    }
    return enroute(f.fleetId);
  };
  const placed = (key) => (row) => ({ ...row,
    anchor: row.position ? null : anchorOf(["planet", "sun"], row[key]) });
  const wreckAnchor = () => (firstOpen ? firstOpen.anchor : anchorOf(["belt", "gate", "sun"], `wrecks:${systemId}`));
  const rowsOf = (sec, fn) => (sec ? { ...sec, rows: sec.rows.map(fn) } : null);

  return {
    fleets: rowsOf(objects.fleets, (f) => (f.state === MATERIALIZED ? materializedRow(f) : fleetRow(f))),
    incoming: rowsOf(objects.incoming, (f) => ({ ...f, anchor: incomingAnchor(f) })),
    battles,
    stations: objects.stations ? objects.stations.map(placed("stationId")) : null,
    sites: rowsOf(objects.sites, placed("siteKey")),
    wrecks: objects.wrecks ? { ...objects.wrecks, anchor: wreckAnchor() } : null,
    salvage: objects.salvage ? { ...objects.salvage, anchor: wreckAnchor() } : null,
  };
}

function factionIdsOf(out) {
  const ids = new Set();
  const add = (v) => {
    if (Number.isSafeInteger(v) && v > 0) ids.add(v);
  };
  for (const r of (out.fleets && out.fleets.rows) || []) add(r.factionId);
  for (const r of (out.incoming && out.incoming.rows) || []) add(r.factionId);
  for (const b of out.battles || []) {
    if (b.sides && b.sides.A) add(b.sides.A.factionId);
    if (b.sides && b.sides.B) add(b.sides.B.factionId);
  }
  for (const r of out.stations || []) add(r.ownerFactionId);
  for (const r of (out.sites && out.sites.rows) || []) add(r.factionId);
  return [...ids].sort((a, b) => a - b);
}

function readGridPositions(grid, db, id, fleets, now) {
  let enabled = false;
  try {
    enabled = Boolean(grid && typeof grid.isEnabled === "function" && grid.isEnabled() === true);
  } catch (_err) {
    enabled = false;
  }
  if (!enabled) return null;
  const out = new Map();
  try {
    const r = grid.positionsOf(db, id, fleets, now);
    if (!r || r.ok !== true) return out;
    for (const [fleetId, p] of r.positions) {
      if (p && p.kind === "anchor") {
        out.set(fleetId, { gridKey: p.gridKey, anchorKind: p.anchorKind, anchorId: p.anchorId,
          position: p.position || null, source: p.source });
      }
    }
  } catch (_err) {
  }
  return out;
}

function readFleets(repo, db, id, maxFleets, grid, now) {
  const r = repo.listFleetsInSystem(db, id, { limit: maxFleets + 1, states: [...PRESENT_STATES] });
  if (!r.ok) return null;
  const shown = r.fleets.slice(0, maxFleets);
  const positions = readGridPositions(grid, db, id, shown, now);
  return { rows: shown.map((f) => {
    const row = { fleetId: f.fleetId, factionId: f.factionId, role: f.fleetRole, state: f.state, ships: f.shipCount };
    if (positions !== null) row.grid = positions.get(f.fleetId) || null;
    return row;
  }), truncated: r.fleets.length > maxFleets };
}

function readIncoming(repo, db, id, now, maxFleets, maxOperations) {
  if (maxOperations < 1) return { rows: [], truncated: false };
  const r = repo.listOperationsByTarget(db, id, { states: [...OPEN_OPERATION_STATES], limit: maxOperations + 1 });
  if (!r.ok) return null;
  const rows = [];
  const seen = new Set();
  let truncated = r.operations.length > maxOperations;
  for (const op of r.operations.slice(0, maxOperations)) {
    const members = repo.listFleetsOfOperation(db, op.operationId);
    if (!members.ok) return null;
    for (const f of members.fleets) {
      if (f.state === DESTROYED || seen.has(f.fleetId) || f.targetSystemId !== id) continue;
      const pos = positionAt(f, now);
      if (!pos.inFlight) continue;
      if (rows.length >= maxFleets) {
        truncated = true;
        break;
      }
      seen.add(f.fleetId);
      rows.push({ fleetId: f.fleetId, factionId: f.factionId, role: f.fleetRole, ships: f.shipCount,
        fromSystemId: pos.systemId, nextSystemId: pos.nextSystemId, etaMs: pos.arriveAt - now });
    }
  }
  return { rows, truncated };
}

function buildSystemInteriorView(deps) {
  const { ctx, store, clock, settings } = deps;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const telemetry = deps.telemetry || null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const factionNames = deps.factionNames instanceof Map ? deps.factionNames : new Map();
  const refreshMs = Math.max(1, Math.trunc(Number(settings.refreshMs) || 0));
  const cacheSystems = Math.max(1, Math.trunc(Number(settings.staticCacheSystems) || 0));
  const staticCache = new Map();

  function admitted() {
    try {
      const governor = getGovernor();
      return !governor || typeof governor.admits !== "function" || governor.admits(WORK_CLASS) !== false;
    } catch (_err) {
      return true;
    }
  }

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  }

  const keyAt = (now) => `k${Math.floor(now / refreshMs)}`;

  function readStatics(id) {
    if (staticCache.has(id)) {
      const hit = staticCache.get(id);
      staticCache.delete(id);
      staticCache.set(id, hit);
      metric("count", METRIC_STATIC_HIT, 1);
      return { statics: hit, reason: null };
    }
    metric("count", METRIC_STATIC_MISS, 1);
    const adapter = ctx.adapter;
    if (!adapter || typeof adapter.readSystemInterior !== "function") return { statics: null, reason: "NO_ADAPTER" };
    let r;
    try {
      r = adapter.readSystemInterior(id, { maxObjects: settings.maxObjects });
    } catch (_err) {
      r = null;
    }
    if (!r || r.ok !== true) return { statics: null, reason: String((r && r.reason) || "STATICS_FAILED") };
    const statics = Object.freeze({ system: r.system, objects: r.objects, truncated: r.truncated === true });
    staticCache.set(id, statics);
    while (staticCache.size > cacheSystems) staticCache.delete(staticCache.keys().next().value);
    return { statics, reason: null };
  }

  function readLive(id) {
    const out = new Map();
    const mst = call(ctx.materialization, "getStatus");
    const add = (source, list) => {
      if (!Array.isArray(list)) return;
      for (const e of list) {
        if (!e || e.systemId !== id || e.state !== LIVE || e.despawned === true || out.has(e.fleetId)) continue;
        out.set(e.fleetId, { source, mode: e.mode ?? null, phase: e.phase ?? null, object: e.object || null });
      }
    };
    if (mst && typeof mst === "object") {
      add("hunt", mst.hunts && mst.hunts.hunts);
      add("patrol", mst.patrols && mst.patrols.list);
      add("presence", mst.presence && mst.presence.entries);
    }
    return out;
  }

  function readPresence(id) {
    const out = new Map();
    const mst = call(ctx.materialization, "getStatus");
    const p = mst && typeof mst === "object" ? mst.presence : null;
    if (!p || typeof p !== "object") return out;
    for (const e of Array.isArray(p.entries) ? p.entries : []) {
      if (e && e.systemId === id) {
        out.set(e.fleetId, { phase: e.phase || null, ships: e.ships || 0, reason: null,
          transitTo: e.transit && Number.isSafeInteger(e.transit.toSystemId) ? e.transit.toSystemId : null });
      }
    }
    const hidden = p.hidden && Array.isArray(p.hidden[id]) ? p.hidden[id] : [];
    for (const h of hidden) {
      if (h && !out.has(h.fleetId)) out.set(h.fleetId, { phase: null, ships: 0, reason: h.reason || null });
    }
    return out;
  }

  function readObjects(db, id, now, origin) {
    const fleetsRepo = ctx.fleets && ctx.fleets.repository;
    const battleRepo = ctx.battle && ctx.battle.repository;
    const stationsRepo = ctx.stations && ctx.stations.repository;
    const wrecksRepo = ctx.wrecks && ctx.wrecks.repository;
    const { maxFleets, maxOperations, maxBattles, maxSites } = settings;
    return {
      fleets: section(() => (fleetsRepo ? readFleets(fleetsRepo, db, id, maxFleets,
        ctx.fleets ? ctx.fleets.grid : null, now) : null)),
      incoming: section(() => (fleetsRepo ? readIncoming(fleetsRepo, db, id, now, maxFleets, maxOperations) : null)),
      battles: section(() => {
        if (!battleRepo) return null;
        if (maxBattles < 1) return [];
        const r = battleRepo.summarizeInSystem(db, id, { limit: maxBattles });
        return r.ok ? r.battles.filter((b) => OPEN_BATTLE_STATES.includes(b.state))
          .map((b) => ({ battleId: b.battleId, state: b.state, mode: b.mode, sides: b.sides })) : null;
      }),
      stations: section(() => {
        if (!stationsRepo) return null;
        const r = stationsRepo.listStationsInSystem(db, id);
        return r.ok ? r.records.map((st) => ({ stationId: st.stationId, name: st.name,
          ownerFactionId: st.ownerFactionId, state: st.state, position: projectPosition(st.position, origin) })) : null;
      }),
      sites: section(() => {
        if (!running(ctx.sites)) return null;
        if (maxSites < 1) return { rows: [], truncated: false };
        const list = siteRepository.listVisibleBySystemInTx(db, id, maxSites + 1);
        return { rows: list.slice(0, maxSites).map((s) => ({ siteKey: s.siteKey, label: s.label,
          templateId: s.templateId, state: s.state, factionId: s.factionId, expiresMs: s.expiresAt - now,
          position: projectPosition(s.position, origin) })), truncated: list.length > maxSites };
      }),
      wrecks: section(() => {
        if (!wrecksRepo || typeof wrecksRepo.countWithPoolInSystem !== "function") return null;
        const r = wrecksRepo.countWithPoolInSystem(db, { systemId: id, at: now });
        if (!r || !r.ok) return null;
        const n = Number(r.count);
        return n > 0 ? { fields: n } : null;
      }),
      salvage: section(() => {
        if (!running(ctx.salvageAnomaly)) return null;
        const n = anomalyRepository.countCollectableBySystemInTx(db, id);
        return n > 0 ? { anomalies: n } : null;
      }),
    };
  }

  function getData(req) {
    const id = req && req.param;
    if (!Number.isSafeInteger(id) || id < 1) return { available: false, reason: "NO_SYSTEM" };
    if (call(store, "isOpen") !== true) return { available: false, reason: "STORE_CLOSED" };
    if (!admitted()) {
      metric("count", METRIC_DEFERRALS, 1);
      return { available: false, reason: "GOVERNOR_HOLD" };
    }
    const t0 = nowMs();
    const now = clock.now();
    const { statics, reason: staticsReason } = readStatics(id);
    const origin = statics && statics.system && statics.system.origin ? statics.system.origin : { x: 0, y: 0, z: 0 };
    const tx = store.transaction("observer.systemInterior",
      (db) => ({ ok: true, objects: readObjects(db, id, now, origin) }));
    if (!tx.ok || !tx.value || !tx.value.ok) return { available: false, reason: String(tx.reason || "TX_FAILED") };
    const placed = assignAnchors(tx.value.objects, statics, id, section(() => readLive(id)));
    const shown = section(() => readPresence(id));
    if (shown instanceof Map && shown.size > 0 && placed.fleets && Array.isArray(placed.fleets.rows)) {
      placed.fleets = { ...placed.fleets, rows: placed.fleets.rows.map((r) => (shown.has(r.fleetId)
        ? { ...r, presence: shown.get(r.fleetId) } : r)) };
    }
    metric("observe", METRIC_BUILD_MS, Math.round((nowMs() - t0) * MS_DECIMALS) / MS_DECIMALS);
    const body = { available: true, key: keyAt(now), systemId: id,
      name: statics && statics.system ? statics.system.name : null, statics, staticsReason, ...placed };
    body.names = factionIdsOf(body).map((f) => [f, factionNames.get(f) ?? null]);
    return body;
  }

  function cacheKey() {
    if (call(store, "isOpen") !== true || !admitted()) return null;
    return keyAt(clock.now());
  }

  return { title: "System interior", listed: false, param: "system", cacheKey, getData };
}

module.exports = { VIEW_ID, buildSystemInteriorView, assignAnchors, projectPosition, fnv1a };
