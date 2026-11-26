"use strict";

const { SEC_CLASSES } = require("./universeGraph");

const REASON = Object.freeze({
  UNKNOWN_SYSTEM: "UNKNOWN_SYSTEM",
  INVALID_CONSTRAINTS: "INVALID_CONSTRAINTS",
  UNREACHABLE: "UNREACHABLE",
  TOO_FAR: "TOO_FAR",
  ROUTE_FAILED: "ROUTE_FAILED",
  INVALID_ARGUMENT: "INVALID_ARGUMENT",
  BROKEN_EDGE: "BROKEN_EDGE",
  NOT_IMPLEMENTED: "NOT_IMPLEMENTED",
  SAME_SYSTEM: "SAME_SYSTEM",
});

const CONSTRAINT_KEYS = Object.freeze(["avoidSecClasses", "forbiddenSystems", "allowedRegions", "maxJumps",
  "secClassCost", "wormholes", "wormholeMinJumpMass"]);
const NO_PREV = -1;
const MAX_DETAIL_LENGTH = 200;
const MAX_EPOCH = 0xffffffff;
const MAX_CONNECTION_ID_LENGTH = 64;
const WORMHOLE_STATUS = Object.freeze({ OPEN: "open", CLOSED: "closed" });

const OTHER_CLASS_BIT = SEC_CLASSES.indexOf("other");

const VALID = Object.freeze({ ok: true });

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL_LENGTH);
}

function ascending(a, b) {
  return a - b;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isNonNegativeInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

class ConstraintError extends Error {
  constructor(field) {
    super(field);
    this.field = field;
  }
}

function integerList(value, field) {
  if (!Array.isArray(value)) throw new ConstraintError(field);
  const out = new Set();
  for (const item of value) {
    const n = typeof item === "number" ? item : NaN;
    if (!Number.isSafeInteger(n)) throw new ConstraintError(field);
    out.add(n);
  }
  return [...out].sort(ascending);
}

function transitAversionOf(value, indexOf) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) throw new TypeError("createRouteFinder: transitAversion object or null");
  let ids;
  try {
    ids = integerList(value.systemIds, "systemIds");
  } catch (_err) {
    throw new TypeError("createRouteFinder: transitAversion.systemIds integer array");
  }
  if (!isNonNegativeInteger(value.detourMaxJumps)) {
    throw new TypeError("createRouteFinder: transitAversion.detourMaxJumps integer >= 0");
  }
  const known = ids.filter((id) => indexOf.has(id));
  if (known.length === 0) return null;
  return Object.freeze({ ids: Object.freeze(known), indexes: new Set(known.map((id) => indexOf.get(id))),
    detourMaxJumps: value.detourMaxJumps });
}

function createRouteFinder(graph, options) {
  if (!graph || typeof graph.getSystemIds !== "function" || typeof graph.getNeighbors !== "function") {
    throw new TypeError("createRouteFinder: graph from buildUniverseGraph expected");
  }
  const opts = options || {};
  if (!isNonNegativeInteger(opts.cacheSize)) throw new TypeError("createRouteFinder: cacheSize integer >= 0");
  if (!isNonNegativeInteger(opts.maxJumps)) throw new TypeError("createRouteFinder: maxJumps integer >= 0");
  const capacity = opts.cacheSize;
  const maxJumpsLimit = opts.maxJumps;
  const telemetry = opts.telemetry || null;
  const nowMs = typeof opts.nowMs === "function" ? opts.nowMs : null;

  const ids = graph.getSystemIds();
  const N = ids.length;
  const idOf = Int32Array.from(ids);
  const indexOf = new Map();
  for (let i = 0; i < N; i += 1) indexOf.set(idOf[i], i);
  const secClassBit = new Uint8Array(N);
  const regionOf = new Int32Array(N);
  const offsets = new Int32Array(N + 1);
  let edgeEnds = 0;
  for (let i = 0; i < N; i += 1) {
    const system = graph.getSystem(idOf[i]);
    const bit = SEC_CLASSES.indexOf(system.secClass);
    secClassBit[i] = bit < 0 ? OTHER_CLASS_BIT : bit;
    regionOf[i] = system.regionId;
    offsets[i] = edgeEnds;
    edgeEnds += graph.getNeighbors(idOf[i]).length;
  }
  offsets[N] = edgeEnds;
  const targets = new Int32Array(edgeEnds);
  for (let i = 0, k = 0; i < N; i += 1) {
    for (const neighbor of graph.getNeighbors(idOf[i])) {
      targets[k] = indexOf.get(neighbor);
      k += 1;
    }
  }

  const aversion = transitAversionOf(opts.transitAversion, indexOf);

  const prev = new Int32Array(N);
  const dist = new Float64Array(N);
  const queue = new Int32Array(N);
  const stamp = new Uint32Array(N);
  const settled = new Uint32Array(N);
  let heapDist = new Float64Array(edgeEnds + 1);
  let heapIdx = new Int32Array(edgeEnds + 1);
  let epoch = 0;

  function ensureHeap(size) {
    if (heapDist.length >= size) return;
    heapDist = new Float64Array(size);
    heapIdx = new Int32Array(size);
  }

  function nextEpoch() {
    if (epoch >= MAX_EPOCH) {
      stamp.fill(0);
      settled.fill(0);
      epoch = 0;
    }
    epoch += 1;
    return epoch;
  }

  let graphVersion = 1;
  const cache = new Map();
  const counters = { hits: 0, misses: 0, evictions: 0, invalidated: 0, searches: 0 };
  if (aversion !== null) Object.assign(counters, { aversionChecks: 0, aversionApplied: 0, aversionKept: 0 });

  let wormholeVersion = 0;
  const overlay = new Map();
  const pairsByEnds = new Map();
  let overlayAdj = new Map();
  let overlayMass = new Map();
  let overlayDirty = false;
  const whCache = new Map();
  let probeHandle = null;
  if (telemetry && typeof telemetry.registerMemoryProbe === "function") {
    try {
      const r = telemetry.registerMemoryProbe("graph.routeCache", () => ({ entries: cache.size + whCache.size }));
      if (r && r.ok === true) probeHandle = r;
    } catch (_err) {
    }
  }

  function dispose() {
    const h = probeHandle;
    probeHandle = null;
    if (h === null) return;
    try {
      h.unregister();
    } catch (_err) {
    }
  }

  function endsKey(x, y) {
    return x < y ? `${x}|${y}` : `${y}|${x}`;
  }

  function massKey(v, w) {
    return v < w ? `${v}:${w}` : `${w}:${v}`;
  }

  function massOf(v, w) {
    const m = overlayMass.get(massKey(v, w));
    return m === undefined ? 0 : m;
  }

  function rebuildOverlay() {
    const lists = new Map();
    const masses = new Map();
    const link = (v, w) => {
      let set = lists.get(v);
      if (set === undefined) {
        set = new Set();
        lists.set(v, set);
      }
      set.add(w);
    };
    for (const edge of overlay.values()) {
      link(edge.a, edge.b);
      link(edge.b, edge.a);
      const key = massKey(edge.a, edge.b);
      const prevMass = masses.get(key);
      if (prevMass === undefined || edge.maxJumpMass > prevMass) masses.set(key, edge.maxJumpMass);
    }
    overlayMass = masses;
    const next = new Map();
    let ends = 0;
    for (const [v, set] of lists) {
      const neighbors = Int32Array.from(set).sort();
      next.set(v, neighbors);
      ends += neighbors.length;
    }
    overlayAdj = next;
    overlayDirty = false;
    ensureHeap(edgeEnds + ends + 1);
  }

  function wormholeGauges() {
    metric("gauge", "graph.wormholeEdges", overlay.size);
    metric("gauge", "graph.wormholeVersion", wormholeVersion);
  }

  function metric(kind, name, value) {
    if (!telemetry) return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  }

  function normalize(constraints) {
    const c = constraints === undefined || constraints === null ? {} : constraints;
    if (!isPlainObject(c)) throw new ConstraintError("constraints");
    for (const key of Object.keys(c)) if (!CONSTRAINT_KEYS.includes(key)) throw new ConstraintError(key);

    let avoidMask = 0;
    const avoid = [];
    if (c.avoidSecClasses !== undefined) {
      if (!Array.isArray(c.avoidSecClasses)) throw new ConstraintError("avoidSecClasses");
      for (const secClass of c.avoidSecClasses) {
        const bit = SEC_CLASSES.indexOf(secClass);
        if (bit < 0) throw new ConstraintError("avoidSecClasses");
        avoidMask |= 1 << bit;
      }
      for (let bit = 0; bit < SEC_CLASSES.length; bit += 1) if (avoidMask & (1 << bit)) avoid.push(SEC_CLASSES[bit]);
    }

    const forbidden = c.forbiddenSystems === undefined ? []
      : integerList(c.forbiddenSystems, "forbiddenSystems").filter((id) => indexOf.has(id));

    let regions = null;
    if (c.allowedRegions !== undefined) {
      regions = integerList(c.allowedRegions, "allowedRegions");
      if (regions.length === 0) throw new ConstraintError("allowedRegions");
    }

    let maxJumps = maxJumpsLimit;
    if (c.maxJumps !== undefined) {
      if (!isNonNegativeInteger(c.maxJumps)) throw new ConstraintError("maxJumps");
      maxJumps = Math.min(c.maxJumps, maxJumpsLimit);
    }

    let costs = null;
    let weights = "none";
    if (c.secClassCost !== undefined) {
      if (!isPlainObject(c.secClassCost)) throw new ConstraintError("secClassCost");
      for (const key of Object.keys(c.secClassCost)) {
        const value = c.secClassCost[key];
        if (!SEC_CLASSES.includes(key) || typeof value !== "number" || !Number.isFinite(value) || value < 0) {
          throw new ConstraintError("secClassCost");
        }
      }
      costs = new Float64Array(SEC_CLASSES.length);
      const parts = [];
      SEC_CLASSES.forEach((secClass, bit) => {
        if (!Object.prototype.hasOwnProperty.call(c.secClassCost, secClass)) return;
        costs[bit] = c.secClassCost[secClass];
        parts.push(`${secClass}:${costs[bit]}`);
      });
      weights = parts.join(",");
      if (costs.every((cost) => cost === 0)) {
        costs = null;
        weights = "none";
      }
    }

    if (c.wormholes !== undefined && typeof c.wormholes !== "boolean") throw new ConstraintError("wormholes");
    const wormholes = c.wormholes === true;

    let minJumpMass = 0;
    if (c.wormholeMinJumpMass !== undefined) {
      if (!isNonNegativeInteger(c.wormholeMinJumpMass)) throw new ConstraintError("wormholeMinJumpMass");
      minJumpMass = c.wormholeMinJumpMass;
      if (minJumpMass > 0 && !wormholes) throw new ConstraintError("wormholeMinJumpMass");
    }

    return {
      avoidMask,
      forbidden: new Set(forbidden.map((id) => indexOf.get(id))),
      regions: regions === null ? null : new Set(regions),
      maxJumps,
      costs,
      wormholes,
      minJumpMass,
      keyPart: `a=${avoid.join(",")}|f=${forbidden.join(",")}|r=${regions === null ? "*" : regions.join(",")}`
        + `|m=${maxJumps}|w=${weights}${wormholes ? "|h=1" : ""}${minJumpMass > 0 ? `|jm=${minJumpMass}` : ""}`,
    };
  }

  function admissible(v, n) {
    if (n.avoidMask & (1 << secClassBit[v])) return false;
    if (n.forbidden.size > 0 && n.forbidden.has(v)) return false;
    if (n.regions !== null && !n.regions.has(regionOf[v])) return false;
    return true;
  }

  function bfs(from, to, n) {
    const e = nextEpoch();
    stamp[from] = e;
    prev[from] = NO_PREV;
    queue[0] = from;
    let head = 0;
    let tail = 1;
    while (head < tail) {
      const v = queue[head];
      head += 1;
      for (let k = offsets[v], end = offsets[v + 1]; k < end; k += 1) {
        const w = targets[k];
        if (stamp[w] === e) continue;
        stamp[w] = e;
        if (!admissible(w, n)) continue;
        prev[w] = v;
        if (w === to) return true;
        queue[tail] = w;
        tail += 1;
      }
      const extra = n.wormholes ? overlayAdj.get(v) : undefined;
      if (extra === undefined) continue;
      for (let k = 0; k < extra.length; k += 1) {
        const w = extra[k];
        if (stamp[w] === e) continue;
        if (n.minJumpMass > 0 && massOf(v, w) < n.minJumpMass) continue;
        stamp[w] = e;
        if (!admissible(w, n)) continue;
        prev[w] = v;
        if (w === to) return true;
        queue[tail] = w;
        tail += 1;
      }
    }
    return false;
  }

  function dijkstra(from, to, n) {
    const e = nextEpoch();
    let size = 0;
    const less = (aD, aI, bD, bI) => aD < bD || (aD === bD && aI < bI);
    function push(d, v) {
      let cursor = size;
      size += 1;
      while (cursor > 0) {
        const parent = (cursor - 1) >> 1;
        if (!less(d, v, heapDist[parent], heapIdx[parent])) break;
        heapDist[cursor] = heapDist[parent];
        heapIdx[cursor] = heapIdx[parent];
        cursor = parent;
      }
      heapDist[cursor] = d;
      heapIdx[cursor] = v;
    }
    function popInto() {
      const rootIdx = heapIdx[0];
      size -= 1;
      const tailD = heapDist[size];
      const tailI = heapIdx[size];
      let cursor = 0;
      while (true) {
        const left = cursor * 2 + 1;
        if (left >= size) break;
        let child = left;
        const right = left + 1;
        if (right < size && less(heapDist[right], heapIdx[right], heapDist[left], heapIdx[left])) child = right;
        if (!less(heapDist[child], heapIdx[child], tailD, tailI)) break;
        heapDist[cursor] = heapDist[child];
        heapIdx[cursor] = heapIdx[child];
        cursor = child;
      }
      heapDist[cursor] = tailD;
      heapIdx[cursor] = tailI;
      return rootIdx;
    }

    stamp[from] = e;
    dist[from] = 0;
    prev[from] = NO_PREV;
    push(0, from);
    while (size > 0) {
      const d = heapDist[0];
      const v = popInto();
      if (settled[v] === e || d > dist[v]) continue;
      settled[v] = e;
      if (v === to) return true;
      for (let k = offsets[v], end = offsets[v + 1]; k < end; k += 1) {
        const w = targets[k];
        if (settled[w] === e || !admissible(w, n)) continue;
        const nd = d + 1 + n.costs[secClassBit[w]];
        if (stamp[w] === e && nd >= dist[w]) continue;
        stamp[w] = e;
        dist[w] = nd;
        prev[w] = v;
        push(nd, w);
      }
      const extra = n.wormholes ? overlayAdj.get(v) : undefined;
      if (extra === undefined) continue;
      for (let k = 0; k < extra.length; k += 1) {
        const w = extra[k];
        if (settled[w] === e || !admissible(w, n)) continue;
        if (n.minJumpMass > 0 && massOf(v, w) < n.minJumpMass) continue;
        const nd = d + 1 + n.costs[secClassBit[w]];
        if (stamp[w] === e && nd >= dist[w]) continue;
        stamp[w] = e;
        dist[w] = nd;
        prev[w] = v;
        push(nd, w);
      }
    }
    return false;
  }

  function rebuild(to) {
    const out = [];
    for (let v = to; v !== NO_PREV; v = prev[v]) out.push(idOf[v]);
    out.reverse();
    return Object.freeze(out);
  }

  function remember(target, key, result, systems) {
    if (capacity === 0) return;
    if (target.size >= capacity) {
      target.delete(target.keys().next().value);
      counters.evictions += 1;
      metric("count", "graph.routeCacheEvictions", 1);
    }
    target.set(key, { result, systems });
    if (target === cache) metric("gauge", "graph.routeCacheSize", cache.size);
  }

  function hasGateEdge(fromId, toId) {
    const list = graph.getNeighbors(fromId);
    let lo = 0;
    let hi = list.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (list[mid] === toId) return true;
      if (list[mid] < toId) lo = mid + 1;
      else hi = mid - 1;
    }
    return false;
  }

  function bestPairOf(x, y, minJumpMass) {
    const keys = pairsByEnds.get(endsKey(x, y));
    if (keys === undefined) return null;
    let best = null;
    let bestAt = -1;
    for (const key of keys) {
      if (minJumpMass > 0 && !(overlay.get(key).maxJumpMass >= minJumpMass)) continue;
      const expiresAt = overlay.get(key).expiresAt;
      const at = expiresAt === 0 ? Infinity : expiresAt;
      if (best === null || at > bestAt || (at === bestAt && key < best)) {
        best = key;
        bestAt = at;
      }
    }
    return best;
  }

  function wormholeEdgesOf(route, minJumpMass) {
    const out = [];
    for (let i = 0; i + 1 < route.length; i += 1) {
      if (hasGateEdge(route[i], route[i + 1])) continue;
      const pairKey = bestPairOf(route[i], route[i + 1], minJumpMass);
      if (pairKey === null) continue;
      const edge = overlay.get(pairKey);
      out.push(Object.freeze({ i, pairKey, expiresAt: edge.expiresAt, createdAt: edge.createdAt }));
    }
    return Object.freeze(out);
  }

  function listWormholeEdges(opts) {
    const limit = opts && Number.isSafeInteger(opts.limit) && opts.limit > 0 ? opts.limit : Infinity;
    const keys = [...overlay.keys()].sort();
    const out = [];
    for (const pairKey of keys) {
      if (out.length >= limit) break;
      const edge = overlay.get(pairKey);
      out.push(Object.freeze({ pairKey, fromSystemId: edge.fromId, toSystemId: edge.toId, expiresAt: edge.expiresAt,
        createdAt: edge.createdAt, maxJumpMass: edge.maxJumpMass }));
    }
    return Object.freeze(out);
  }

  function avoidedInside(route, n) {
    const out = [];
    for (let i = 1; i < route.length - 1; i += 1) {
      const v = indexOf.get(route[i]);
      if (aversion.indexes.has(v) && !n.forbidden.has(v)) out.push(route[i]);
    }
    return out;
  }

  function detourOf(a, b, n, avoided) {
    counters.aversionChecks += 1;
    metric("count", "graph.routeAversionChecks", 1);
    const forbidden = new Set(n.forbidden);
    for (const id of avoided) forbidden.add(indexOf.get(id));
    const m = { ...n, forbidden };
    const startedAt = nowMs ? nowMs() : 0;
    counters.searches += 1;
    const found = m.costs === null ? bfs(a, b, m) : dijkstra(a, b, m);
    if (nowMs) metric("observe", "graph.routeSearchMs", Math.max(0, nowMs() - startedAt));
    if (!found) return null;
    const route = rebuild(b);
    const jumps = route.length - 1;
    return { route, jumps, cost: m.costs === null ? jumps : dist[b] };
  }

  function refusal(reason, extra) {
    return Object.freeze({ ok: false, reason, ...extra, graphVersion });
  }

  function findRoute(from, to, constraints) {
    try {
      metric("count", "graph.routeQueries", 1);
      const fromId = Number(from);
      const toId = Number(to);
      if (!graph.hasSystem(fromId)) return refusal(REASON.UNKNOWN_SYSTEM, { detail: "from" });
      if (!graph.hasSystem(toId)) return refusal(REASON.UNKNOWN_SYSTEM, { detail: "to" });
      let n;
      try {
        n = normalize(constraints);
      } catch (err) {
        if (err instanceof ConstraintError) return refusal(REASON.INVALID_CONSTRAINTS, { detail: err.field });
        throw err;
      }
      const target = n.wormholes ? whCache : cache;
      const key = `${fromId}>${toId}|${n.keyPart}|v=${graphVersion}`;
      const hit = target.get(key);
      if (hit !== undefined) {
        target.delete(key);
        target.set(key, hit);
        counters.hits += 1;
        metric("count", "graph.routeCacheHits", 1);
        return hit.result;
      }
      counters.misses += 1;
      metric("count", "graph.routeCacheMisses", 1);
      const whRefusal = n.wormholes ? { wormholeVersion } : {};

      const a = indexOf.get(fromId);
      const b = indexOf.get(toId);
      if (a === b) {
        const result = n.wormholes
          ? Object.freeze({ ok: true, route: Object.freeze([fromId]), jumps: 0, cost: 0, graphVersion, wormholeVersion,
            wormholeEdges: Object.freeze([]) })
          : Object.freeze({ ok: true, route: Object.freeze([fromId]), jumps: 0, cost: 0, graphVersion });
        remember(target, key, result, result.route);
        return result;
      }
      if (!admissible(b, n)) {
        const result = refusal(REASON.UNREACHABLE, { detail: "DESTINATION_EXCLUDED", ...whRefusal });
        remember(target, key, result, Object.freeze([fromId, toId]));
        return result;
      }
      if (n.wormholes && overlayDirty) rebuildOverlay();
      const startedAt = nowMs ? nowMs() : 0;
      counters.searches += 1;
      const found = n.costs === null ? bfs(a, b, n) : dijkstra(a, b, n);
      if (nowMs) metric("observe", "graph.routeSearchMs", Math.max(0, nowMs() - startedAt));
      if (!found) {
        const result = refusal(REASON.UNREACHABLE, { detail: "NO_PATH", ...whRefusal });
        remember(target, key, result, Object.freeze([fromId, toId]));
        return result;
      }
      let route = rebuild(b);
      let jumps = route.length - 1;
      let cost = n.costs === null ? jumps : dist[b];
      let systems = route;
      if (aversion !== null && jumps <= n.maxJumps) {
        const avoided = avoidedInside(route, n);
        if (avoided.length > 0) {
          const alt = detourOf(a, b, n, avoided);
          if (alt !== null && alt.jumps <= n.maxJumps && alt.cost - cost <= aversion.detourMaxJumps) {
            counters.aversionApplied += 1;
            metric("count", "graph.routeAversionApplied", 1);
            route = alt.route;
            jumps = alt.jumps;
            cost = alt.cost;
          } else {
            counters.aversionKept += 1;
            metric("count", "graph.routeAversionKept", 1);
          }
          systems = Object.freeze([...route, ...avoided]);
        }
      }
      let result;
      if (jumps > n.maxJumps) result = refusal(REASON.TOO_FAR, { jumps, ...whRefusal });
      else if (n.wormholes) {
        result = Object.freeze({ ok: true, route, jumps, cost, graphVersion, wormholeVersion,
          wormholeEdges: wormholeEdgesOf(route, n.minJumpMass) });
      } else result = Object.freeze({ ok: true, route, jumps, cost, graphVersion });
      remember(target, key, result, systems);
      return result;
    } catch (err) {
      return refusal(REASON.ROUTE_FAILED, { detail: messageOf(err) });
    }
  }

  function invalidateRouteCache(affectedSystems) {
    if (affectedSystems === null || typeof affectedSystems !== "object"
      || typeof affectedSystems[Symbol.iterator] !== "function") {
      return Object.freeze({ ok: false, reason: REASON.INVALID_ARGUMENT });
    }
    const affected = new Set();
    for (const id of affectedSystems) affected.add(Number(id));
    const removed = invalidateIn(cache, affected) + invalidateIn(whCache, affected);
    if (removed > 0) metric("gauge", "graph.routeCacheSize", cache.size);
    return Object.freeze({ ok: true, removed });
  }

  function invalidateIn(target, affected) {
    let removed = 0;
    if (affected.size > 0) {
      for (const [key, entry] of target) {
        if (entry.systems.some((id) => affected.has(id))) {
          target.delete(key);
          removed += 1;
        }
      }
    }
    if (removed > 0) {
      counters.invalidated += removed;
      metric("count", "graph.routeInvalidations", removed);
    }
    return removed;
  }

  function dropMassRoutes() {
    let removed = 0;
    for (const key of [...whCache.keys()]) {
      if (!key.includes("|jm=")) continue;
      whCache.delete(key);
      removed += 1;
    }
    if (removed > 0) {
      counters.invalidated += removed;
      metric("count", "graph.routeInvalidations", removed);
    }
  }

  function edgeResult(changed) {
    return Object.freeze({ ok: true, changed, wormholeVersion });
  }

  function removeWormholeEdge(connectionId, edge) {
    overlay.delete(connectionId);
    const ends = endsKey(edge.fromId, edge.toId);
    const keys = pairsByEnds.get(ends);
    if (keys !== undefined) {
      keys.delete(connectionId);
      if (keys.size === 0) pairsByEnds.delete(ends);
    }
    overlayDirty = true;
    invalidateIn(whCache, new Set([edge.fromId, edge.toId]));
  }

  function isNonNegativeNumber(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
  }

  function updateWormholeEdge(connectionId, state) {
    if (typeof connectionId !== "string" || connectionId.length === 0
      || connectionId.length > MAX_CONNECTION_ID_LENGTH || !isPlainObject(state)) {
      return Object.freeze({ ok: false, reason: REASON.INVALID_ARGUMENT });
    }
    const fromId = state.fromSystemId;
    const toId = state.toSystemId;
    const expiresAt = state.expiresAtMs === undefined ? 0 : state.expiresAtMs;
    const maxJumpMass = state.maxJumpMass === undefined ? 0 : state.maxJumpMass;
    const createdAt = state.createdAtMs === undefined ? 0 : state.createdAtMs;
    if (!Number.isSafeInteger(fromId) || !Number.isSafeInteger(toId) || !isNonNegativeInteger(expiresAt)
      || !isNonNegativeNumber(maxJumpMass) || !isNonNegativeInteger(createdAt)) {
      return Object.freeze({ ok: false, reason: REASON.INVALID_ARGUMENT, detail: "state" });
    }
    const current = overlay.get(connectionId);
    if (state.status === WORMHOLE_STATUS.CLOSED) {
      if (current === undefined) return edgeResult(false);
      removeWormholeEdge(connectionId, current);
      wormholeGauges();
      return edgeResult(true);
    }
    if (state.status !== WORMHOLE_STATUS.OPEN) {
      return Object.freeze({ ok: false, reason: REASON.INVALID_ARGUMENT, detail: "status" });
    }
    if (fromId === toId) return Object.freeze({ ok: false, reason: REASON.SAME_SYSTEM });
    if (!indexOf.has(fromId)) return Object.freeze({ ok: false, reason: REASON.UNKNOWN_SYSTEM, detail: "from" });
    if (!indexOf.has(toId)) return Object.freeze({ ok: false, reason: REASON.UNKNOWN_SYSTEM, detail: "to" });
    const ends = endsKey(fromId, toId);
    if (current !== undefined && endsKey(current.fromId, current.toId) === ends) {
      if (current.expiresAt === expiresAt && current.maxJumpMass === maxJumpMass && current.createdAt === createdAt) {
        return edgeResult(false);
      }
      overlay.set(connectionId, Object.freeze({ ...current, expiresAt, maxJumpMass, createdAt }));
      if (current.expiresAt !== expiresAt || current.createdAt !== createdAt) {
        invalidateIn(whCache, new Set([fromId, toId]));
      }
      if (current.maxJumpMass !== maxJumpMass) {
        overlayDirty = true;
        dropMassRoutes();
      }
      return edgeResult(true);
    }
    if (current !== undefined) removeWormholeEdge(connectionId, current);
    overlay.set(connectionId, Object.freeze({ fromId, toId, a: indexOf.get(fromId), b: indexOf.get(toId), expiresAt,
      maxJumpMass, createdAt }));
    let keys = pairsByEnds.get(ends);
    if (keys === undefined) {
      keys = new Set();
      pairsByEnds.set(ends, keys);
    }
    keys.add(connectionId);
    wormholeVersion += 1;
    whCache.clear();
    overlayDirty = true;
    wormholeGauges();
    return edgeResult(true);
  }

  function getWormholeVersion() {
    return wormholeVersion;
  }

  function hasEdge(fromId, toId) {
    return hasGateEdge(fromId, toId) || pairsByEnds.has(endsKey(fromId, toId));
  }

  function validateRoute(route) {
    if (!Array.isArray(route) || route.length === 0) {
      return Object.freeze({ ok: false, reason: REASON.INVALID_ARGUMENT });
    }
    for (let i = 0; i < route.length; i += 1) {
      if (!graph.hasSystem(route[i])) return Object.freeze({ ok: false, reason: REASON.UNKNOWN_SYSTEM, at: i });
    }
    for (let i = 0; i + 1 < route.length; i += 1) {
      if (!hasEdge(Number(route[i]), Number(route[i + 1]))) {
        return Object.freeze({ ok: false, reason: REASON.BROKEN_EDGE, at: i });
      }
    }
    return VALID;
  }

  function getGraphVersion() {
    return graphVersion;
  }

  function getRouteStats() {
    return Object.freeze({ graphVersion, size: cache.size, capacity, ...counters, wormholeVersion,
      wormholeEdges: overlay.size, whCacheSize: whCache.size });
  }

  function bumpGraphVersion() {
    graphVersion += 1;
    cache.clear();
    whCache.clear();
    metric("gauge", "graph.version", graphVersion);
    metric("gauge", "graph.routeCacheSize", 0);
    return graphVersion;
  }

  const publicApi = Object.freeze({
    findRoute, invalidateRouteCache, updateWormholeEdge, validateRoute, getGraphVersion, getWormholeVersion,
    getRouteStats, listWormholeEdges,
  });
  return { ...publicApi, bumpGraphVersion, dispose, publicApi };
}

module.exports = { REASON, CONSTRAINT_KEYS, createRouteFinder };
