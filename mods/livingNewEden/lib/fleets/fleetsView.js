"use strict";

const { positionAt } = require("./travel");

const VIEW_ID = "fleets";
const VIEW_ORDER = 35;
const GALAXY_WORK_CLASS = "MAINTENANCE";
const MS_PER_MINUTE = 60000;
const FLIGHT_STATES = Object.freeze(["TRAVELLING", "RETREATING"]);

function call(obj, name) {
  try {
    return obj && typeof obj[name] === "function" ? obj[name]() : undefined;
  } catch (_err) {
    return undefined;
  }
}

function corporationOf(fleet, registry, virtualCorps) {
  try {
    const hasRegistry = registry && typeof registry.corporationFor === "function";
    const id = fleet.corporationId !== null && fleet.corporationId !== undefined ? fleet.corporationId
      : (hasRegistry ? registry.corporationFor(fleet.factionId, fleet.fleetRole) : null);
    if (id === null || id === undefined) return null;
    const corp = registry && typeof registry.getCorporation === "function" ? registry.getCorporation(id) : null;
    let name = corp && typeof corp.name === "string" ? corp.name : null;
    if (!name && virtualCorps && typeof virtualCorps.nameOf === "function") {
      name = virtualCorps.nameOf(id);
    }
    return { id, name };
  } catch (_err) {
    return null;
  }
}

function buildFleetsView(deps) {
  const { store, repository, clock } = deps;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const rows = Math.max(0, Math.trunc(Number(deps.rows) || 0));
  const refreshMs = Math.max(1, Math.trunc(Number(deps.refreshMs) || 1));
  const lagMs = Math.max(0, Math.trunc(Number(deps.catchUpLagMs) || 0));

  function admitted() {
    try {
      const governor = getGovernor();
      return !governor || typeof governor.admits !== "function" || governor.admits(GALAXY_WORK_CLASS) !== false;
    } catch (_err) {
      return true;
    }
  }

  function schedulerPart() {
    const scheduler = typeof deps.getScheduler === "function" ? deps.getScheduler() : null;
    const st = call(scheduler, "getStatus");
    if (!st || st.state !== "ready") return null;
    return { open: st.open, sizes: st.sizes, inFlight: st.inFlight, parked: st.parked, nextDueAt: st.nextDueAt,
      catchUp: st.catchUp || null };
  }

  function collect(tx, now) {
    const counted = repository.countByState(tx);
    if (!counted.ok) return counted;
    const ops = repository.countOperationsByState(tx);
    if (!ops.ok) return ops;
    const overdue = repository.countOverdueInFlight(tx, Math.max(0, now - lagMs));
    if (!overdue.ok) return overdue;
    const flying = [];
    for (const state of FLIGHT_STATES) {
      if (flying.length >= rows) break;
      const page = repository.listFleetsByState(tx, state, { limit: rows - flying.length });
      if (!page.ok) return page;
      flying.push(...page.fleets);
    }
    return { ok: true, counted, ops, overdue: overdue.count, flying };
  }

  const keyAt = (now) => `f${Math.floor(now / refreshMs)}`;

  function getData() {
    if (call(store, "isOpen") !== true) return { available: false, reason: "STORE_CLOSED" };
    if (!admitted()) return { available: false, reason: "GOVERNOR_HOLD" };
    const now = clock.now();
    const tx = store.transaction("observer.fleets", (db) => collect(db, now));
    const read = tx.ok ? tx.value : tx;
    if (!tx.ok || !read || !read.ok) return { available: false, reason: String((read && read.reason) || "TX_FAILED") };
    const status = call({ getStatus: deps.getStatus }, "getStatus") || {};
    const registry = call(deps, "getRegistry") || null;
    const virtualCorps = typeof deps.getVirtualCorps === "function" ? deps.getVirtualCorps() : null;
    return {
      available: true,
      fleets: { byState: read.counted.counts, active: read.counted.active, limit: deps.limit,
        overdueInFlight: read.overdue },
      operations: { byState: read.ops.counts },
      travel: status.travel && status.travel.counters ? status.travel.counters : null,
      scheduler: schedulerPart(),
      inFlight: read.flying.map((f) => {
        const pos = positionAt(f, now);
        return { fleetId: f.fleetId, factionId: f.factionId, corporation: corporationOf(f, registry, virtualCorps), state: f.state,
          from: f.route ? f.route.systems[0] : null,
          to: f.targetSystemId, progress: pos.inFlight ? Math.round(pos.progress * 100) / 100 : 1,
          etaMin: pos.inFlight ? Math.max(0, Math.ceil((pos.arriveAt - now) / MS_PER_MINUTE)) : 0 };
      }),
      bench: status.bench || null,
    };
  }

  function cacheKey() {
    if (call(store, "isOpen") !== true || !admitted()) return null;
    return `${keyAt(clock.now())}|r${call(deps, "getRegistry") ? 1 : 0}|v${call(deps, "getVirtualCorps") ? 1 : 0}`;
  }

  return { title: "Fleets & operations", order: VIEW_ORDER, cacheKey, getData };
}

module.exports = { VIEW_ID, buildFleetsView, corporationOf };
