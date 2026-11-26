"use strict";

const KIND_ORDER = Object.freeze({ gate: 0, station: 1, structure: 2, pos: 3, sun: 4, belt: 5, system: 6 });

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const rankOf = (kind) => (Object.prototype.hasOwnProperty.call(KIND_ORDER, kind) ? KIND_ORDER[kind] : KIND_ORDER.system + 1);

function anchorRef(kind, id) {
  return `${kind}:${id}`;
}

function compareAnchors(a, b) {
  return (rankOf(a.kind) - rankOf(b.kind)) || (a.id - b.id);
}

function orderAnchors(anchors) {
  return (Array.isArray(anchors) ? anchors.filter((a) => a && typeof a === "object") : []).sort(compareAnchors);
}

const hasPosition = (a) => a.position !== null && typeof a.position === "object"
  && Number.isFinite(a.position.x) && Number.isFinite(a.position.y) && Number.isFinite(a.position.z);

function clusterAnchors(anchors, rangeM) {
  const list = orderAnchors(anchors);
  const parent = list.map((_a, i) => i);
  const find = (i) => {
    let r = i;
    while (parent[r] !== r) r = parent[r];
    let j = i;
    while (parent[j] !== r) {
      const next = parent[j];
      parent[j] = r;
      j = next;
    }
    return r;
  };
  const range = Number.isFinite(rangeM) && rangeM >= 0 ? rangeM : 0;
  const range2 = range * range;
  for (let i = 0; i < list.length; i += 1) {
    if (!hasPosition(list[i])) continue;
    const p = list[i].position;
    for (let j = i + 1; j < list.length; j += 1) {
      if (!hasPosition(list[j])) continue;
      const q = list[j].position;
      const dx = p.x - q.x;
      const dy = p.y - q.y;
      const dz = p.z - q.z;
      if (dx * dx + dy * dy + dz * dz > range2) continue;
      const a = find(i);
      const b = find(j);
      if (a !== b) parent[Math.max(a, b)] = Math.min(a, b);
    }
  }
  const byRoot = new Map();
  const grids = [];
  const gridOf = new Map();
  for (let i = 0; i < list.length; i += 1) {
    const root = find(i);
    let grid = byRoot.get(root);
    if (!grid) {
      grid = { gridKey: anchorRef(list[root].kind, list[root].id), anchors: [] };
      byRoot.set(root, grid);
      grids.push(grid);
    }
    grid.anchors.push(list[i]);
    gridOf.set(anchorRef(list[i].kind, list[i].id), grid.gridKey);
  }
  return { grids, gridOf };
}

const smallest = (anchors, pred) => {
  let best = null;
  for (const a of anchors) {
    if (pred(a) && (best === null || a.id < best.id)) best = a;
  }
  return best;
};

function controlPointOf(anchors, systemId) {
  const list = Array.isArray(anchors) ? anchors.filter((a) => a && typeof a === "object" && isId(a.id)) : [];
  const rules = [
    (a) => a.kind === "structure" && typeof a.lneStationId === "string" && a.lneStationId !== "",
    (a) => a.kind === "station",
    (a) => a.kind === "structure" && typeof a.lneSovStructureId === "string" && a.lneSovStructureId !== "",
    (a) => a.kind === "gate",
    (a) => a.kind === "sun",
  ];
  for (const rule of rules) {
    const hit = smallest(list, rule);
    if (hit) return hit;
  }
  return Object.freeze({ kind: "system", id: systemId, position: null, toSystemId: null, lneStationId: null,
    lneSovStructureId: null, ownerCorpId: null });
}

function entryGateOf(anchors, fromSystemId) {
  if (!isId(fromSystemId) || !Array.isArray(anchors)) return null;
  return smallest(anchors.filter((a) => a && typeof a === "object" && isId(a.id)),
    (a) => a.kind === "gate" && a.toSystemId === fromSystemId);
}

module.exports = { KIND_ORDER, anchorRef, orderAnchors, clusterAnchors, controlPointOf, entryGateOf };
