"use strict";

const isId = (v) => Number.isSafeInteger(v) && v > 0;

function createTransitRiskReader(deps) {
  const { graph, transit, factionId } = deps;
  const maxRoutes = Number.isSafeInteger(deps.maxRoutes) && deps.maxRoutes >= 0 ? deps.maxRoutes : 0;
  const routes = new Map();
  const counts = { routes: 0, capped: 0, cold: 0, errors: 0 };

  function routeOf(from, to) {
    const key = `${from}:${to}`;
    if (routes.has(key)) return { known: true, systems: routes.get(key) };
    if (counts.routes >= maxRoutes) {
      counts.capped += 1;
      return { known: false, systems: null };
    }
    counts.routes += 1;
    const r = graph.findRoute(from, to);
    const systems = r && r.ok === true && Array.isArray(r.route) ? r.route : null;
    routes.set(key, systems);
    return { known: true, systems };
  }

  function of(from, to, mover) {
    try {
      if (!isId(from) || !isId(to)) return null;
      if (from === to) return 0;
      const route = routeOf(from, to);
      if (!route.known || route.systems === null) return null;
      const m = mover && typeof mover === "object" ? mover : {};
      const risk = transit.routeRiskOf(factionId, route.systems, {
        ...(typeof m.fleetRole === "string" ? { fleetRole: m.fleetRole } : {}),
        ...(Number.isSafeInteger(m.shipCount) ? { shipCount: m.shipCount } : {}),
        ...(typeof m.operationType === "string" ? { operationType: m.operationType } : {}) });
      if (risk === null || risk === undefined) {
        counts.cold += 1;
        return null;
      }
      return Number.isSafeInteger(risk.contactPermille) ? risk.contactPermille : null;
    } catch (_err) {
      counts.errors += 1;
      return null;
    }
  }

  return Object.freeze({ of, stats: () => Object.freeze({ ...counts }) });
}

module.exports = { createTransitRiskReader };
