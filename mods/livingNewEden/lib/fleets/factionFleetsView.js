"use strict";

const { FLEET_STATES, DESTROYED_STATE } = require("./schema");

const VIEW_ID = "faction-fleets";
const WORK_CLASS = "MAINTENANCE";
const METRIC_BUILD_MS = "observer.factionFleetsMs";
const MS_DECIMALS = 10;
const ACTIVE_STATES = Object.freeze(FLEET_STATES.filter((st) => st !== DESTROYED_STATE));
const OPERATION_PAGES = Object.freeze(["ACTIVE", "PLANNED"]);
const READ_ABORT = Symbol("faction-fleets-read-refused");

function call(obj, name) {
  try {
    return obj && typeof obj[name] === "function" ? obj[name]() : undefined;
  } catch (_err) {
    return undefined;
  }
}

function count(value) {
  return Math.max(0, Math.trunc(Number(value) || 0));
}

function hullsOf(composition) {
  const map = new Map();
  for (const e of Array.isArray(composition) ? composition : []) {
    if (!e || typeof e.hullGroup !== "string") continue;
    map.set(e.hullGroup, (map.get(e.hullGroup) || 0) + count(e.count));
  }
  return [...map];
}

function buildFactionFleetsView(deps) {
  const { store, repository, clock } = deps;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const telemetry = deps.telemetry || null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const maxFactions = count(deps.maxFactions);
  const maxPerFaction = count(deps.maxPerFaction);
  const maxOperations = count(deps.maxOperations);
  const refreshMs = Math.max(1, count(deps.refreshMs));

  function admitted() {
    try {
      const governor = getGovernor();
      return !governor || typeof governor.admits !== "function" || governor.admits(WORK_CLASS) !== false;
    } catch (_err) {
      return true;
    }
  }

  function observe(ms) {
    if (!telemetry || typeof telemetry.observe !== "function") return;
    try {
      telemetry.observe(METRIC_BUILD_MS, Math.round(ms * MS_DECIMALS) / MS_DECIMALS);
    } catch (_err) {
    }
  }

  function systemName(id) {
    if (!Number.isSafeInteger(id)) return null;
    try {
      const graph = deps.graph;
      const res = graph && typeof graph.getGraph === "function" ? graph.getGraph() : null;
      const vertex = res && res.ok === true && res.graph ? res.graph.getSystem(id) : null;
      return vertex && typeof vertex.name === "string" ? vertex.name : null;
    } catch (_err) {
      return null;
    }
  }

  function fleetRow(f) {
    return { fleetId: f.fleetId, role: f.fleetRole, state: f.state, systemId: f.currentSystemId,
      systemName: systemName(f.currentSystemId), targetSystemId: f.targetSystemId,
      targetName: systemName(f.targetSystemId), ships: f.shipCount, hulls: hullsOf(f.composition),
      operationId: f.operationId, supply: f.supplyState, refitPending: f.refitPending === true };
  }

  function operationRow(o) {
    return { operationId: o.operationId, type: o.operationType, objective: o.objective, state: o.state,
      targetSystemId: o.targetSystemId, targetName: systemName(o.targetSystemId),
      fleets: Array.isArray(o.fleetIds) ? o.fleetIds.length : 0, plannedAt: o.plannedAt, dueAt: o.dueAt };
  }

  function must(result) {
    if (!result || result.ok !== true) {
      const err = new Error("faction-fleets read refused");
      err[READ_ABORT] = result || { ok: false, reason: "NO_RESULT" };
      throw err;
    }
    return result;
  }

  function readOperations(tx, factionId) {
    const list = [];
    for (const state of OPERATION_PAGES) {
      const left = maxOperations - list.length;
      const page = must(repository.listOperations(tx, { factionId, state, limit: left + 1 }));
      const ops = page.operations;
      for (const o of ops.slice(0, Math.max(0, left))) list.push(operationRow(o));
      if (ops.length > left) return { list, truncated: true };
    }
    return { list, truncated: false };
  }

  function read(tx) {
    const summary = must(repository.summarizeFactions(tx, { states: ACTIVE_STATES }));
    const kept = summary.factions.slice(0, maxFactions);
    const factions = kept.map((fac) => {
      const card = { factionId: fac.factionId, fleets: fac.fleets, ships: fac.ships, byState: fac.byState,
        hulls: fac.hulls, list: [], truncated: fac.fleets > 0 };
      if (maxPerFaction > 0) {
        const page = must(repository.listFleetsByFaction(tx, fac.factionId,
          { states: [...ACTIVE_STATES], limit: maxPerFaction }));
        card.list = page.fleets.map(fleetRow);
        card.truncated = fac.fleets > card.list.length;
      }
      card.operations = maxOperations > 0 ? readOperations(tx, fac.factionId) : { list: [], truncated: false };
      return card;
    });
    return { factions, factionsTruncated: summary.factions.length - kept.length };
  }

  function getData() {
    if (call(store, "isOpen") !== true) return { available: false, reason: "STORE_CLOSED" };
    if (!admitted()) return { available: false, reason: "GOVERNOR_HOLD" };
    const generatedAt = clock.now();
    const t0 = nowMs();
    const tx = store.transaction("observer.factionFleets", (db) => {
      try {
        return { ok: true, ...read(db) };
      } catch (err) {
        if (err && err[READ_ABORT]) return err[READ_ABORT];
        throw err;
      }
    });
    const res = tx.ok ? tx.value : tx;
    if (!tx.ok || !res || res.ok !== true) {
      return { available: false, reason: String((res && res.reason) || "TX_FAILED") };
    }
    observe(nowMs() - t0);
    return { available: true, generatedAt, states: [...ACTIVE_STATES], factions: res.factions,
      factionsTruncated: res.factionsTruncated };
  }

  function cacheKey() {
    if (call(store, "isOpen") !== true || !admitted()) return null;
    return `ff${Math.floor(clock.now() / refreshMs)}`;
  }

  return { title: "Faction fleets", listed: false, cacheKey, getData };
}

module.exports = { VIEW_ID, ACTIVE_STATES, buildFactionFleetsView, hullsOf };
