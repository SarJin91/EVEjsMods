"use strict";

const { RANK, PILOTS_KEY } = require("../callout");

const isId = (v) => Number.isSafeInteger(v) && v > 0;

function hostileObjectsOf(classified, S) {
  const out = [];
  for (const x of Array.isArray(classified) ? classified : []) {
    if (!x || x.hostile !== true || !x.entry || !isId(x.entry.entityId)) continue;
    if (x.cat === "npc") {
      const dist = x.entry.distanceMeters;
      if (typeof dist !== "number" || !Number.isFinite(dist) || dist <= S.calloutGridRangeMeters) continue;
      const factionId = isId(x.entry.factionId) ? x.entry.factionId : 0;
      out.push({ key: `e:${x.entry.entityId}`, groupKey: `f:${factionId}`, factionId, cls: x.cls || null });
    } else if (x.cat === "pilot") {
      out.push({ key: `e:${x.entry.entityId}`, groupKey: PILOTS_KEY, factionId: 0, cls: x.cls || null });
    }
  }
  return out;
}

function buildScanReading(seen, scan, S, factionName) {
  const sc = scan || {};
  const now = sc.nowMs;
  const systemId = isId(sc.systemId) ? sc.systemId : null;
  const known = sc.known instanceof Map ? sc.known : new Map();
  const objects = seen && seen.systemId === systemId && seen.objects instanceof Map
    ? new Map([...seen.objects].map(([k, o]) => [k, { ...o }])) : new Map();
  const found = hostileObjectsOf(sc.classified, S);
  let newObjects = 0;
  const here = new Set();
  for (const o of found) {
    if (here.has(o.key)) continue;
    here.add(o.key);
    const m = objects.get(o.key);
    if (!m || now - m.lastSeenAt >= S.dscanSeenTtlMs) {
      objects.set(o.key, { lastSeenAt: now, groupKey: o.groupKey, pending: true });
      newObjects += 1;
    } else {
      m.lastSeenAt = now;
      m.groupKey = o.groupKey;
    }
  }
  for (const [k, m] of [...objects]) if (now - m.lastSeenAt >= S.dscanSeenTtlMs) objects.delete(k);
  if (objects.size > S.dscanSeenMax) {
    const oldest = [...objects].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt);
    for (const [k] of oldest.slice(0, objects.size - S.dscanSeenMax)) objects.delete(k);
  }
  const groups = new Map();
  const counted = new Set();
  for (const o of found) {
    if (counted.has(o.key)) continue;
    counted.add(o.key);
    const g = groups.get(o.groupKey) || { key: o.groupKey, factionId: o.factionId, ships: 0, classes: new Set(),
      keys: [] };
    g.ships += 1;
    g.classes.add(o.cls);
    g.keys.push(o.key);
    groups.set(o.groupKey, g);
  }
  const out = [];
  for (const g of groups.values()) {
    const k = known.get(g.key);
    const covered = Boolean(k) && k.rank >= RANK.scan && g.ships < k.count + S.calloutGrowthMin;
    let pending = false;
    for (const key of g.keys) {
      const m = objects.get(key);
      if (!m) continue;
      if (covered) m.pending = false;
      else if (m.pending) pending = true;
    }
    if (!pending && !k) continue;
    const name = g.key === PILOTS_KEY || typeof factionName !== "function" ? null : factionName(g.factionId);
    out.push({ key: g.key, faction: typeof name === "string" && name !== "" ? name : null, ships: g.ships,
      cls: g.classes.size === 1 ? [...g.classes][0] : null });
  }
  out.sort((a, b) => b.ships - a.ships || (a.key < b.key ? -1 : 1));
  return { seen: { systemId, objects }, reading: { level: "scan", systemId, groups: out }, newObjects };
}

module.exports = { buildScanReading };
