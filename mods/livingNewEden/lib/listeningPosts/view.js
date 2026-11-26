"use strict";

const LAYER_ID = "layer-listening-posts";
const LAYER_ORDER = 22;
const GALAXY_WORK_CLASS = "MAINTENANCE";
const SHAPE = "triangle";
const POST_COLOUR = "#40d0ff";
const MAX_POST_LINES = 8;
const MINUTE_MS = 60000;
const LEGEND = Object.freeze([
  Object.freeze(["post", "listening post", POST_COLOUR, SHAPE]),
  Object.freeze(["post-arming", "listening post (arming)", POST_COLOUR, SHAPE, null, "dashed"]),
]);

const isId = (v) => Number.isSafeInteger(v) && v > 0;

function call(obj, name) {
  try {
    return obj && typeof obj[name] === "function" ? obj[name]() : undefined;
  } catch (_err) {
    return undefined;
  }
}

function buildListeningPostsLayer(deps) {
  const { store, repo, clock } = deps;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const getPosts = typeof deps.getPosts === "function" ? deps.getPosts : () => [];
  const s = deps.settings || {};
  const int = (v, min) => Math.max(min, Math.trunc(Number(v) || 0));
  const windowMs = int(s.mapWindowMs, 0);
  const maxSystems = int(s.maxSystems, 0);
  const refreshMs = int(s.refreshMs, 1);
  const keyAt = (now) => `k${Math.floor(now / refreshMs)}`;

  function admitted() {
    try {
      const governor = getGovernor();
      return !governor || typeof governor.admits !== "function" || governor.admits(GALAXY_WORK_CLASS) !== false;
    } catch (_err) {
      return true;
    }
  }

  function groupsOf(list) {
    const bySystem = new Map();
    let total = 0;
    for (const p of Array.isArray(list) ? list : []) {
      if (!p || !isId(p.systemId)) continue;
      total += 1;
      if (!bySystem.has(p.systemId)) bySystem.set(p.systemId, []);
      bySystem.get(p.systemId).push(p);
    }
    const ids = [...bySystem.keys()].sort((a, b) => a - b);
    return { total, systems: ids.slice(0, maxSystems).map((id) => [id, bySystem.get(id)]),
      truncated: ids.length > maxSystems };
  }

  function getData() {
    if (call(store, "isOpen") !== true) return { available: false, reason: "STORE_CLOSED" };
    if (!admitted()) return { available: false, reason: "GOVERNOR_HOLD" };
    const now = clock.now();
    const legend = LEGEND.map((l) => [...l]);
    const g = groupsOf(getPosts());
    let counts = new Map();
    if (g.systems.length > 0) {
      const tx = store.transaction("observer.listeningPosts", (db) => repo.countBySystemSinceInTx(db,
        { systemIds: g.systems.map(([id]) => id), since: Math.max(0, now - windowMs) }));
      const read = tx.ok ? tx.value : tx;
      if (!tx.ok || !read || !read.ok) {
        return { available: false, reason: String((read && read.reason) || "TX_FAILED") };
      }
      counts = read.counts;
    }
    const minutes = Math.round(windowMs / MINUTE_MS);
    const items = g.systems.map(([systemId, list]) => {
      const n = counts.get(systemId) || 0;
      const armedAny = list.some((p) => p.armed === true);
      const lines = list.slice(0, MAX_POST_LINES)
        .map((p) => `corp ${p.ownerCorpId} ${p.armed === true ? "armed" : "arming"}`);
      lines.push(`sightings ${n} in ${minutes} min`);
      return [systemId, armedAny ? "post" : "post-arming", String(n), lines, null];
    });
    const note = `${g.total} post(s) in ${g.systems.length} system(s)` + (g.truncated ? " (truncated)" : "");
    return { available: true, key: keyAt(now), legend, items, note };
  }

  function cacheKey() {
    if (call(store, "isOpen") !== true || !admitted()) return null;
    return keyAt(clock.now());
  }

  return { title: "Listening posts", listed: false, mapLayer: { kind: "marks", order: LAYER_ORDER }, cacheKey,
    getData };
}

module.exports = { LAYER_ID, LAYER_ORDER, LEGEND, buildListeningPostsLayer };
