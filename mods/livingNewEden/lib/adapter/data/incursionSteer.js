"use strict";

const BANDS = Object.freeze(["high", "low", "null"]);

const isId = (v) => Number.isSafeInteger(v) && v > 0;

function narrowCatalog(catalog, targets, opts, deps) {
  if (!catalog || typeof catalog !== "object" || !Array.isArray(catalog.components) || !catalog.policy
    || !Array.isArray(targets) || !opts || !BANDS.includes(opts.securityBand)
    || !deps || typeof deps.fingerprint !== "function" || !isId(deps.affectedCount)) {
    return { ok: false, reason: "INVALID" };
  }
  const occupiedConstellations = new Set(Array.isArray(opts.occupiedConstellationIDs) ? opts.occupiedConstellationIDs : []);
  const occupiedSystems = new Set(Array.isArray(opts.occupiedSystemIDs) ? opts.occupiedSystemIDs : []);
  const candidates = catalog.components.filter((c) => c && c.securityBand === opts.securityBand
    && !occupiedConstellations.has(c.constellationID) && Array.isArray(c.systems)
    && !c.systems.some((s) => occupiedSystems.has(s.solarSystemID)));
  for (const target of targets) {
    const systemId = target && target.systemId;
    if (!isId(systemId)) continue;
    const component = candidates.find((c) => c.systems.some((s) => s.solarSystemID === systemId));
    if (!component) continue;
    const byId = new Map(component.systems.map((s) => [s.solarSystemID, s]));
    const queue = [systemId];
    const seen = new Set(queue);
    for (let i = 0; i < queue.length && queue.length < deps.affectedCount; i += 1) {
      const node = byId.get(queue[i]);
      const neighbors = node && Array.isArray(node.neighbors) ? [...node.neighbors].sort((a, b) => a - b) : [];
      for (const n of neighbors) {
        if (queue.length >= deps.affectedCount) break;
        if (!seen.has(n) && byId.has(n)) {
          seen.add(n);
          queue.push(n);
        }
      }
    }
    if (queue.length < deps.affectedCount) continue;
    const subset = new Set(queue);
    const systems = [...subset].sort((a, b) => a - b).map((id) => ({ solarSystemID: id,
      neighbors: byId.get(id).neighbors.filter((n) => subset.has(n)) }));
    const body = { version: catalog.version, policy: catalog.policy, components: [{ ...component, systems }] };
    return { ok: true, catalog: { ...body, fingerprint: deps.fingerprint(body) },
      target: { systemId, constellationId: component.constellationID } };
  }
  return { ok: false, reason: "NO_MATCH" };
}

module.exports = { narrowCatalog };
