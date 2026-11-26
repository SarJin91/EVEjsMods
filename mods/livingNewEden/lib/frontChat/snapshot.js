"use strict";

const { progressToJson } = require("../world/occupation/progress");
const { STANDING_FLEET_STATES } = require("../world/occupation/schema");

const STABLE = "STABLE";
const PRESENT_STATES = Object.freeze([...STANDING_FLEET_STATES, "ENGAGED"]);
const WORK_CLASS = "MAINTENANCE";

function messageOf(err) {
  return String((err && err.message) || err);
}

function admitted(ctx) {
  try {
    const governor = ctx && ctx.governor;
    return !governor || typeof governor.admits !== "function" || governor.admits(WORK_CLASS) !== false;
  } catch (_err) {
    return true;
  }
}

function compareDue(a, b) {
  const da = a.phaseDueAt === null || a.phaseDueAt === undefined ? Infinity : a.phaseDueAt;
  const db = b.phaseDueAt === null || b.phaseDueAt === undefined ? Infinity : b.phaseDueAt;
  if (da !== db) return da < db ? -1 : 1;
  return a.systemId - b.systemId;
}

function factionFleetsInTx(db, fleetsRepo, systemId, maxFleets) {
  try {
    const r = fleetsRepo.listFleetsInSystem(db, systemId, { limit: maxFleets + 1, states: [...PRESENT_STATES] });
    if (!r || !r.ok) return null;
    const list = r.fleets.slice(0, maxFleets);
    const byFaction = new Map();
    let shipsTotal = 0;
    for (const f of list) {
      const row = byFaction.get(f.factionId) || { factionId: f.factionId, fleets: 0, ships: 0 };
      row.fleets += 1;
      row.ships += f.shipCount;
      shipsTotal += f.shipCount;
      byFaction.set(f.factionId, row);
    }
    return { factions: [...byFaction.values()].sort((a, b) => b.ships - a.ships || a.factionId - b.factionId),
      fleetsTotal: list.length, shipsTotal, truncated: r.fleets.length > maxFleets };
  } catch (_err) {
    return null;
  }
}

function readRegion({ store, ctx, graph, settings, now }, systemId, regionId) {
  const ids = regionId === null ? [] : [...(graph.getSystemsInRegion(regionId) || [])];
  const base = { systems: ids.length, tracked: 0, byState: [], controllers: [], contested: [], truncated: false,
    tooLarge: false };
  const fleetsRepo = ctx.fleets && ctx.fleets.repository;
  const maxFleets = settings.maxFleets;
  const readFleets = !!fleetsRepo && typeof fleetsRepo.listFleetsInSystem === "function"
    && Number.isSafeInteger(maxFleets) && maxFleets > 0;
  const tooLarge = ids.length > settings.regionMaxSystems;
  const repo = ctx.world && ctx.world.repository;
  const readWorld = !tooLarge && !!repo && typeof repo.getSystems === "function" && ids.length > 0;
  const noRegion = tooLarge ? { ...base, tooLarge: true } : null;
  if (!readWorld && !readFleets) return { ok: true, region: noRegion, fleets: null };
  const occ = ctx.occupation;
  const tx = store.transaction("frontChat.region", (db) => {
    const fleets = readFleets ? factionFleetsInTx(db, fleetsRepo, systemId, maxFleets) : null;
    if (!readWorld) return { ok: true, region: noRegion, fleets };
    const r = repo.getSystems(db, ids, { includeInfluence: false });
    if (!r.ok) return r;
    const byState = new Map();
    const controllers = new Map();
    for (const s of r.systems) {
      byState.set(s.occupationState, (byState.get(s.occupationState) || 0) + 1);
      if (Number.isSafeInteger(s.controllerFactionId) && s.controllerFactionId > 0) {
        controllers.set(s.controllerFactionId, (controllers.get(s.controllerFactionId) || 0) + 1);
      }
    }
    const open = r.systems.filter((s) => s.occupationState !== STABLE && s.systemId !== systemId).sort(compareDue);
    const shown = open.slice(0, settings.regionContestedRows);
    const memo = new Map();
    const contested = shown.map((s, i) => {
      let progress = null;
      if (i < settings.regionProgressSystems && occ && typeof occ.readProgressInTx === "function") {
        const p = occ.readProgressInTx(db, s.systemId, now, memo);
        const json = p && p.ok ? progressToJson(p.progress) : null;
        if (json) progress = { status: json.status, ratio: json.ratio, etaMs: json.etaMs, attacker: json.attacker };
      }
      const node = graph.getSystem(s.systemId);
      return { systemId: s.systemId, name: node && node.name ? node.name : String(s.systemId),
        state: s.occupationState, attacker: progress ? progress.attacker : (s.occupierFactionId ?? null),
        progress: progress ? { status: progress.status, ratio: progress.ratio, etaMs: progress.etaMs } : null };
    });
    return { ok: true, region: { ...base, tracked: r.systems.length,
      byState: [...byState.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)),
      controllers: [...controllers.entries()].map(([factionId, systems]) => ({ factionId, systems }))
        .sort((a, b) => b.systems - a.systems || a.factionId - b.factionId),
      contested, truncated: open.length > shown.length }, fleets };
  });
  if (!tx.ok) return { ok: false, reason: String(tx.reason || "TX_FAILED") };
  return tx.value && tx.value.ok ? tx.value : { ok: false, reason: String((tx.value && tx.value.reason) || "TX_FAILED") };
}

function readFrontSnapshot(deps, systemId) {
  const { card, store, ctx, graph } = deps;
  try {
    if (!store || typeof store.isOpen !== "function" || store.isOpen() !== true) {
      return { ok: false, reason: "STORE_CLOSED" };
    }
    if (!admitted(ctx)) return { ok: false, reason: "GOVERNOR_HOLD" };
    if (!graph || typeof graph.getSystem !== "function") return { ok: false, reason: "GRAPH_NOT_READY" };
    const body = card.getData({ param: systemId });
    if (!body || body.available !== true) return { ok: false, reason: String((body && body.reason) || "CARD_FAILED") };
    const node = graph.getSystem(systemId);
    const regionId = node && Number.isSafeInteger(node.regionId) ? node.regionId : null;
    const region = readRegion(deps, systemId, regionId);
    if (!region.ok) return region;
    const names = new Map(deps.names instanceof Map ? deps.names : []);
    for (const [id, name] of body.names || []) if (name && !names.has(id)) names.set(id, name);
    return { ok: true, snapshot: { systemId, systemName: node && node.name ? node.name : String(systemId), regionId,
      regionName: regionId === null ? null : graph.getRegionName(regionId), card: body, region: region.region,
      fleets: region.fleets || null, names } };
  } catch (err) {
    return { ok: false, reason: "SNAPSHOT_FAILED", detail: messageOf(err) };
  }
}

module.exports = { readFrontSnapshot };
