"use strict";

const { bfs } = require("./bfs");

const STABLE = "STABLE";
const OFF = { intents: [], notes: [], cursor: null };
const isId = (v) => Number.isSafeInteger(v) && v > 0;

function planTerritoryTrim(snapshot, params) {
  try {
    const P = params;
    const t = snapshot && snapshot.trim;
    if (!P || P.territoryTrimEnabled !== true || !t) return OFF;
    if (t.mode === "stations_off") return { intents: [], notes: ["TRIM_STATIONS_OFF"], cursor: null };
    if (t.mode === "no_anchors") return { intents: [], notes: ["TRIM_NO_ANCHORS"], cursor: null };
    if (t.mode === "failed") return { intents: [], notes: ["TRIM_FAILED"], cursor: null };
    if (t.mode !== "ready") return OFF;
    const radius = P.startTerritoryJumps;
    const maxJumps = Math.max(radius, Math.min(P.captureRangeFromStationJumps, P.routeMaxJumps));
    const dist = bfs(t.anchors, snapshot.neighbors, { maxJumps, maxSystems: P.maxBfsSystems });
    const cut = dist.size >= P.maxBfsSystems && ![...dist.values()].some((j) => j > radius);
    const theatre = new Set(Array.isArray(snapshot.theatre) ? snapshot.theatre : []);
    const b = snapshot.border;
    const belt = b && b.reach instanceof Map ? b.reach : null;
    const home = snapshot.faction ? snapshot.faction.homeSystemId : null;
    const far = (id) => (dist.has(id) ? dist.get(id) : Infinity);
    const candidates = cut ? [] : t.rows.filter((r) => r && isId(r.systemId) && r.state === STABLE
      && r.capturedAt === null && far(r.systemId) > radius && !theatre.has(r.systemId)
      && !(belt && belt.has(r.systemId)) && r.systemId !== home
      && !(snapshot.coreOwners instanceof Map && snapshot.coreOwners.get(r.systemId) === snapshot.factionId))
      .sort((x, y) => far(y.systemId) - far(x.systemId) || x.systemId - y.systemId);
    const limit = P.maxTrimsPerReview;
    const picked = candidates.slice(0, Math.max(0, limit)).map((r) => r.systemId).sort((x, y) => x - y);
    const intents = picked.length > 0 ? [{ type: "TERRITORY_TRIM", systemIds: picked }] : [];
    const notes = picked.length > 0 ? ["TRIM_PLANNED"] : [];
    const after = isId(t.afterSystemId) ? t.afterSystemId : 0;
    if (candidates.length > picked.length) return { intents, notes, cursor: { afterSystemId: after, passClean: false } };
    const clean = t.passClean === true && candidates.length === 0;
    if (isId(t.nextAfterSystemId)) {
      return { intents, notes, cursor: { afterSystemId: t.nextAfterSystemId, passClean: clean } };
    }
    if (clean) return { intents: [{ type: "TERRITORY_TRIM_DONE" }], notes: ["TRIM_DONE"], cursor: null };
    return { intents, notes, cursor: { afterSystemId: 0, passClean: true } };
  } catch (_err) {
    return { intents: [], notes: ["TRIM_FAILED"], cursor: null };
  }
}

module.exports = { planTerritoryTrim };
