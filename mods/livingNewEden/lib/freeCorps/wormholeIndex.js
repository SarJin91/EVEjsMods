"use strict";

const KSPACE_CLASSES = Object.freeze(["highsec", "lowsec", "nullsec"]);
const JSPACE_CLASS = "wormhole";
const EMPTY = Object.freeze([]);

function safe(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function createWormholeIndex(deps) {
  const settings = deps.settings;
  const excluded = deps.excluded instanceof Set ? deps.excluded : new Set();
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => 0;
  const graphNow = () => (typeof deps.graph === "function" ? safe(() => deps.graph(), null) : deps.graph || null);
  const usable = (g) => Boolean(g && typeof g.listWormholeEdges === "function"
    && typeof g.getWormholeVersion === "function" && typeof g.getRouteStats === "function"
    && typeof g.validateRoute === "function" && typeof g.getSystem === "function");

  let builtFor = null;
  let key = null;
  let builtAt = null;
  let edges = 0;
  let entries = new Map();
  let adj = new Map();
  let kjPairCount = 0;

  const keyOf = (g) => `${g.getWormholeVersion()}:${g.getRouteStats().wormholeEdges}`;
  const sysOf = (g, id) => safe(() => g.getSystem(id), null);
  const open = (v) => Boolean(v) && !excluded.has(v.regionId);
  const isK = (v) => open(v) && KSPACE_CLASSES.includes(v.secClass);
  const isJ = (v) => open(v) && v.secClass === JSPACE_CLASS;

  function build(g) {
    const list = g.listWormholeEdges();
    const nextEntries = new Map();
    const nextAdj = new Map();
    const link = (map, from, item) => {
      let arr = map.get(from);
      if (!arr) {
        arr = [];
        map.set(from, arr);
      }
      arr.push(item);
    };
    let n = 0;
    for (const e of list) {
      const a = sysOf(g, e.fromSystemId);
      const b = sysOf(g, e.toSystemId);
      if (!open(a) || !open(b)) continue;
      link(nextAdj, e.fromSystemId, e.toSystemId);
      link(nextAdj, e.toSystemId, e.fromSystemId);
      const expiresAt = Number.isSafeInteger(e.expiresAt) ? e.expiresAt : 0;
      if (isK(a) && isJ(b)) {
        link(nextEntries, e.fromSystemId, { jSystemId: e.toSystemId, expiresAt });
        n += 1;
      } else if (isJ(a) && isK(b)) {
        link(nextEntries, e.toSystemId, { jSystemId: e.fromSystemId, expiresAt });
        n += 1;
      }
    }
    for (const [id, arr] of nextAdj) {
      nextAdj.set(id, Object.freeze([...new Set(arr)].sort((x, y) => x - y)));
    }
    for (const [id, arr] of nextEntries) {
      nextEntries.set(id, Object.freeze(arr.sort((x, y) => x.jSystemId - y.jSystemId || y.expiresAt - x.expiresAt)
        .map((x) => Object.freeze(x))));
    }
    entries = nextEntries;
    adj = nextAdj;
    edges = list.length;
    kjPairCount = n;
  }

  function refresh(now) {
    const g = graphNow();
    if (!usable(g)) return { ok: false, reason: "GRAPH_NOT_READY" };
    try {
      const k = keyOf(g);
      const stale = builtFor !== g || key === null
        || (k !== key && Number.isFinite(now) && now - builtAt >= settings.indexRefreshMs);
      if (!stale) return { ok: true, rebuilt: false, ms: 0, key };
      const t0 = nowMs();
      build(g);
      builtFor = g;
      key = k;
      builtAt = Number.isFinite(now) ? now : 0;
      return { ok: true, rebuilt: true, ms: Math.max(0, nowMs() - t0), key };
    } catch (_err) {
      return { ok: false, reason: "INDEX_FAILED" };
    }
  }

  const entriesOf = (systemId) => entries.get(systemId) || EMPTY;

  function isLinked(route) {
    const g = graphNow();
    if (!g || typeof g.validateRoute !== "function" || !Array.isArray(route) || route.length < 2) return false;
    return safe(() => g.validateRoute(route).ok === true, false);
  }

  function findExit(jSystemId, homeSystemId, homeReach) {
    const g = graphNow();
    if (!usable(g) || typeof deps.bfs !== "function" || builtFor !== g) return { ok: false, reason: "GRAPH_NOT_READY" };
    const through = (id) => isJ(sysOf(g, id));
    const found = safe(() => deps.bfs([jSystemId], (id) => adj.get(id) || EMPTY,
      { maxJumps: settings.maxWhJumps, maxSystems: settings.maxBfsSystems, through }), null);
    if (!(found instanceof Map)) return { ok: false, reason: "GRAPH_NOT_READY" };
    const cands = [];
    for (const [id, hops] of found) {
      if (hops > 0 && isK(sysOf(g, id))) cands.push({ id, hops });
    }
    cands.sort((a, b) => a.hops - b.hops || a.id - b.id);
    const reachBy = new Map();
    if (Array.isArray(homeReach)) for (const e of homeReach) reachBy.set(e.systemId, e.jumps);
    let best = null;
    for (const c of cands.slice(0, settings.maxExitCandidates)) {
      const path = [c.id];
      let cur = c.id;
      for (let h = c.hops - 1; h >= 0; h -= 1) {
        const prev = (adj.get(cur) || EMPTY).find((nb) => found.get(nb) === h
          && (h === 0 ? nb === jSystemId : through(nb)));
        if (prev === undefined) break;
        path.push(prev);
        cur = prev;
      }
      if (path.length !== c.hops + 1 || path[path.length - 1] !== jSystemId) continue;
      path.reverse();
      if (!isLinked(path)) continue;
      let gateJumps = reachBy.has(c.id) ? reachBy.get(c.id) : null;
      if (gateJumps === null) {
        const r = typeof g.findRoute === "function" ? safe(() => g.findRoute(c.id, homeSystemId), null) : null;
        gateJumps = r && r.ok === true && Number.isSafeInteger(r.jumps) ? r.jumps : null;
      }
      if (gateJumps === null || gateJumps > settings.maxReturnJumps) continue;
      const total = c.hops + gateJumps;
      if (!best || total < best.total || (total === best.total && c.id < best.id)) {
        best = { id: c.id, total, route: path, hops: c.hops, gateJumps };
      }
    }
    if (!best) return { ok: false, reason: "NO_EXIT" };
    return { ok: true, route: best.route, hops: best.hops, gateJumps: best.gateJumps };
  }

  const stats = () => Object.freeze({ key, builtAt, edges, entries: entries.size });

  const kjPairs = () => kjPairCount;

  return Object.freeze({ refresh, entriesOf, isLinked, findExit, stats, kjPairs });
}

module.exports = { createWormholeIndex, KSPACE_CLASSES, JSPACE_CLASS };
