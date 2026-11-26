"use strict";

const { OCCUPATION_STATES } = require("../../world/schema");
const { MARK_KINDS, marksOf } = require("./marks");
const { asciiName, NAME_CHARS, LABEL_CHARS } = require("./wire");

const XY_MAX = 1000;
const FL_UNKNOWN = 7;
const FL_BASTION = 8;
const NO_FACTION = -1;
const KIND_OF = new Map(MARK_KINDS.map((k) => [k.kind, k]));

function byNumber(a, b) {
  return a - b;
}

function indexStatic(s) {
  const sys = s.systems;
  const n = sys.id.length;
  const regionCount = s.regions.length;
  const idIndex = new Map();
  const byRegion = new Map();
  const adj = Array.from({ length: n }, () => []);
  const sumX = new Array(regionCount).fill(0);
  const sumY = new Array(regionCount).fill(0);
  const sumSec = new Array(regionCount).fill(0);
  const count = new Array(regionCount).fill(0);
  for (let gi = 0; gi < n; gi += 1) {
    idIndex.set(sys.id[gi], gi);
    const ri = sys.region[gi];
    if (!byRegion.has(ri)) byRegion.set(ri, []);
    byRegion.get(ri).push(gi);
    sumX[ri] += sys.x[gi];
    sumY[ri] += sys.y[gi];
    sumSec[ri] += sys.sec[gi];
    count[ri] += 1;
  }
  for (const list of byRegion.values()) list.sort((a, b) => sys.id[a] - sys.id[b]);
  const pairs = new Set();
  const regionEdges = [];
  for (let i = 0; i + 1 < s.edges.length; i += 2) {
    const a = s.edges[i];
    const b = s.edges[i + 1];
    adj[a].push(b);
    adj[b].push(a);
    const ra = sys.region[a];
    const rb = sys.region[b];
    if (ra === rb) continue;
    const lo = Math.min(ra, rb);
    const hi = Math.max(ra, rb);
    const key = lo * regionCount + hi;
    if (pairs.has(key)) continue;
    pairs.add(key);
    regionEdges.push([lo, hi]);
  }
  regionEdges.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const regionIndex = new Map(s.regions.map((r, ri) => [r[0], ri]));
  const mean = (sum, ri) => (count[ri] > 0 ? sum[ri] / count[ri] : 0);
  return {
    s, idIndex, byRegion, adj, regionIndex,
    regionCentroid: s.regions.map((_r, ri) => [mean(sumX, ri), mean(sumY, ri)]),
    regionEdges,
    regionSecMean: s.regions.map((_r, ri) => Math.round(mean(sumSec, ri))),
  };
}

function normalize(points) {
  if (points.length === 0) return [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of points) {
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  const scale = XY_MAX / Math.max(maxX - minX, maxY - minY, 1);
  const out = [];
  for (const [x, y] of points) out.push(Math.round((x - minX) * scale), Math.round((y - minY) * scale));
  return out;
}

function flatPairs(pairs) {
  pairs.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const out = [];
  for (const [a, b] of pairs) out.push(a, b);
  return out;
}

function buildRegionScope(index, ri, opts) {
  const sys = index.s.systems;
  const inner = index.byRegion.get(ri) || [];
  const seen = new Set(inner);
  const outer = [];
  let frontier = inner;
  for (let d = 0; d < opts.neighborJumps; d += 1) {
    const next = [];
    for (const gi of frontier) {
      for (const nb of index.adj[gi]) {
        if (seen.has(nb)) continue;
        seen.add(nb);
        next.push(nb);
        outer.push(nb);
      }
    }
    frontier = next;
  }
  outer.sort((a, b) => sys.id[a] - sys.id[b]);
  const all = inner.concat(outer);
  const kept = all.slice(0, Math.max(0, opts.maxSystems));
  const local = new Map(kept.map((gi, li) => [gi, li]));
  const pairs = [];
  kept.forEach((gi, li) => {
    for (const nb of index.adj[gi]) {
      const lj = local.get(nb);
      if (lj !== undefined && li < lj) pairs.push([li, lj]);
    }
  });
  const innerCount = Math.min(inner.length, kept.length);
  const ext = [];
  for (let li = innerCount; li < kept.length; li += 1) ext.push(li);
  return {
    kind: "region",
    static: {
      ids: kept.map((gi) => sys.id[gi]),
      xy: normalize(kept.map((gi) => [sys.x[gi], sys.y[gi]])),
      sec: kept.map((gi) => sys.sec[gi]),
      nm: kept.map((gi) => asciiName(sys.name[gi], NAME_CHARS)),
      ed: flatPairs(pairs),
      ext,
    },
    trunc: all.length - kept.length,
    nodeOf: (systemId) => {
      const li = local.get(index.idIndex.get(systemId));
      return li === undefined ? -1 : li;
    },
    systemNodes: kept,
  };
}

function buildGalaxyScope(index, opts) {
  const regions = index.s.regions;
  const keptCount = Math.min(regions.length, Math.max(0, opts.maxSystems));
  const nodes = regions.slice(0, keptCount);
  const pairs = index.regionEdges.filter(([a, b]) => a < keptCount && b < keptCount).map((p) => [...p]);
  return {
    kind: "galaxy",
    static: {
      ids: nodes.map((r) => r[0]),
      xy: normalize(nodes.map((_r, ri) => index.regionCentroid[ri])),
      sec: nodes.map((_r, ri) => index.regionSecMean[ri]),
      nm: nodes.map((r) => asciiName(r[1], NAME_CHARS)),
      ed: flatPairs(pairs),
      ext: [],
    },
    trunc: regions.length - keptCount,
    nodeOf: (systemId) => {
      const gi = index.idIndex.get(systemId);
      if (gi === undefined) return -1;
      const ri = index.s.systems.region[gi];
      return ri < keptCount ? ri : -1;
    },
    regionNodes: keptCount,
  };
}

function dominant(index, ri, rows) {
  const counts = new Map();
  for (const gi of index.byRegion.get(ri) || []) {
    const row = rows.get(index.s.systems.id[gi]);
    const fid = row ? row[1] : null;
    if (Number.isSafeInteger(fid)) counts.set(fid, (counts.get(fid) || 0) + 1);
  }
  let best = null;
  let bestN = 0;
  for (const [fid, n] of counts) {
    if (n > bestN || (n === bestN && fid < best)) {
      best = fid;
      bestN = n;
    }
  }
  return best;
}

function buildState(index, scope, stateData, marks, colorOf) {
  const n = scope.static.ids.length;
  const rows = new Map();
  const bastions = new Set();
  const names = new Map();
  if (stateData) {
    for (const row of stateData.systems || []) rows.set(row[0], row);
    for (const b of stateData.bastions || []) bastions.add(b[0]);
    for (const [fid, name] of stateData.names || []) names.set(fid, name);
  }
  const ownFid = new Array(n).fill(null);
  const fl = new Array(n).fill(scope.kind === "galaxy" && stateData ? 0 : FL_UNKNOWN);
  if (stateData) {
    for (let li = 0; li < n; li += 1) {
      if (scope.kind === "galaxy") {
        ownFid[li] = dominant(index, li, rows);
        continue;
      }
      const sid = scope.static.ids[li];
      const row = rows.get(sid);
      ownFid[li] = row && Number.isSafeInteger(row[1]) ? row[1] : null;
      const occ = row ? OCCUPATION_STATES.indexOf(row[2]) : -1;
      fl[li] = (occ === -1 ? FL_UNKNOWN : occ) | (bastions.has(sid) ? FL_BASTION : 0);
    }
  }
  const fids = [...new Set(ownFid.filter((f) => f !== null))].sort(byNumber);
  const facIndex = new Map(fids.map((fid, i) => [fid, i]));
  const fac = fids.map((fid) => [fid, asciiName(names.get(fid) || `Faction ${fid}`, NAME_CHARS), ...colorOf(fid)]);
  const own = ownFid.map((f) => (f === null ? NO_FACTION : facIndex.get(f)));

  const counts = marksOf(marks.layers, scope.nodeOf);
  const all = [...counts].map(([key, c]) => {
    const [kind, idx] = key.split(":").map(Number);
    return [kind, idx, c];
  }).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const max = Math.max(0, marks.maxMarkers);
  const mk = all.slice(0, max);
  const kinds = [...new Set(mk.map((m) => m[0]))].sort(byNumber);
  const mkl = kinds.map((kind) => {
    const def = KIND_OF.get(kind);
    return [kind, asciiName(def.label, LABEL_CHARS), ...def.rgb];
  });
  return { state: { own, fl, fac, mk, mkl, miss: [...marks.miss] }, truncMk: all.length - mk.length };
}

module.exports = { XY_MAX, FL_UNKNOWN, FL_BASTION, NO_FACTION, indexStatic, normalize, buildRegionScope,
  buildGalaxyScope, buildState };
