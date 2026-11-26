"use strict";

const { createRng, deriveSeed } = require("../util/rng");
const { BATTLE_RELIC_TEMPLATES } = require("../events/data/eventCatalog");
const { THEMES } = require("./data/themes");
const { STAGE_KIND, J_SPACE_MIN, J_SPACE_MAX } = require("./schema");

const STAGE_SEC_CLASS = "nullsec";
const RELIC_SLICE = Object.freeze([0, 4]);
const DATA_SLICE = Object.freeze([4, 8]);

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const asSet = (v) => (v instanceof Set ? v : new Set(Array.isArray(v) ? v : []));

function bfsOf(graph, input) {
  const { fromSystemId, minJumps, maxJumps, maxBfsNodes } = input;
  const excluded = asSet(input.excludedRegionIds);
  const byRegion = new Map();
  const seen = new Set([fromSystemId]);
  const jumpsOf = input.withJumps === true ? new Map([[fromSystemId, 0]]) : null;
  let layer = [fromSystemId];
  let truncated = false;
  for (let d = 0; d <= maxJumps && layer.length > 0; d += 1) {
    const next = [];
    for (const id of layer) {
      const sys = graph.getSystem(id);
      if (d >= minJumps && sys && sys.secClass === STAGE_SEC_CLASS && isId(sys.regionId) && !excluded.has(sys.regionId)) {
        if (!byRegion.has(sys.regionId)) byRegion.set(sys.regionId, []);
        byRegion.get(sys.regionId).push(id);
      }
      if (d === maxJumps || truncated) continue;
      const near = graph.getNeighbors(id);
      if (!Array.isArray(near)) continue;
      for (const n of [...near].sort((a, b) => a - b)) {
        if (seen.has(n)) continue;
        if (seen.size >= maxBfsNodes) {
          truncated = true;
          break;
        }
        seen.add(n);
        if (jumpsOf) jumpsOf.set(n, d + 1);
        next.push(n);
      }
    }
    layer = next.sort((a, b) => a - b);
  }
  for (const list of byRegion.values()) list.sort((a, b) => a - b);
  return jumpsOf ? { byRegion, nodes: seen.size, truncated, jumpsOf } : { byRegion, nodes: seen.size, truncated };
}

const isJSpace = (id) => Number.isSafeInteger(id) && id >= J_SPACE_MIN && id <= J_SPACE_MAX;

function pickWormholeStage(graph, pairs, input) {
  const excluded = asSet(input.excludedRegionIds);
  const jumpsOf = input.jumpsOf instanceof Map ? input.jumpsOf : new Map();
  const has = (id) => {
    try {
      return graph.hasSystem(id) === true;
    } catch (_err) {
      return false;
    }
  };
  const best = new Map();
  for (const p of Array.isArray(pairs) ? pairs : []) {
    if (!p || p.active !== true) continue;
    const fromK = has(p.fromSystemId);
    const toK = has(p.toSystemId);
    if (fromK === toK) continue;
    const entry = fromK ? p.fromSystemId : p.toSystemId;
    const jId = fromK ? p.toSystemId : p.fromSystemId;
    if (!isJSpace(jId)) continue;
    const jumps = jumpsOf.get(entry);
    if (!Number.isSafeInteger(jumps) || jumps < input.minJumps) continue;
    const sys = graph.getSystem(entry);
    const regionId = sys && isId(sys.regionId) ? sys.regionId : null;
    if (regionId === null || excluded.has(regionId)) continue;
    const expiresAt = Number.isSafeInteger(p.expiresAt) && p.expiresAt > 0 ? p.expiresAt : 0;
    if (expiresAt !== 0 && expiresAt - input.now < input.whMinRemainingMs) continue;
    const key = `${entry}:${jId}`;
    const prev = best.get(key);
    if (prev && (prev.pairExpiresAt === 0 || (expiresAt !== 0 && expiresAt <= prev.pairExpiresAt))) continue;
    best.set(key, { entrySystemId: entry, systemId: jId, regionId, pairExpiresAt: expiresAt });
  }
  if (best.size === 0) return { ok: false, reason: "NO_WH" };
  const list = [...best.values()].sort((a, b) => a.entrySystemId - b.entrySystemId || a.systemId - b.systemId);
  const c = createRng(deriveSeed(input.seed, "wh", input.stageNo)).pick(list);
  return { ok: true, kind: STAGE_KIND.WH, systemId: c.systemId, entrySystemId: c.entrySystemId, regionId: c.regionId,
    pairExpiresAt: c.pairExpiresAt, regionReused: false };
}

function orderOf(bfs, input) {
  const visited = asSet(input.visitedRegionIds);
  const order = [...bfs.byRegion.keys()].sort((a, b) => a - b);
  const rng = createRng(deriveSeed(input.seed, "regions", input.stageNo));
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = rng.nextInt(0, i);
    const t = order[i];
    order[i] = order[j];
    order[j] = t;
  }
  const regionOrder = [...order.filter((r) => !visited.has(r)), ...order.filter((r) => visited.has(r))];
  return { byRegion: bfs.byRegion, regionOrder, visited, nodes: bfs.nodes, truncated: bfs.truncated };
}

function candidatesOf(graph, input) {
  return orderOf(bfsOf(graph, input), input);
}

function regionsToRead(cands, input) {
  if (input.kind !== STAGE_KIND.HOSTILE_NULL) return [];
  const out = [];
  const regions = cands.regionOrder.filter((r) => !cands.visited.has(r)).slice(0, input.hostileRegionTries);
  for (const r of regions) {
    for (const id of cands.byRegion.get(r)) {
      if (out.length >= input.maxReadIds) return out;
      out.push(id);
    }
  }
  return out;
}

function pickOf(list, seed, label, stageNo) {
  return createRng(deriveSeed(seed, label, stageNo)).pick(list);
}

function pickNextPlace(cands, input) {
  const { seed, stageNo } = input;
  const controllerOf = input.controllerOf instanceof Map ? input.controllerOf : new Map();
  const fresh = cands.regionOrder.filter((r) => !cands.visited.has(r));
  if (input.kind === STAGE_KIND.HOSTILE_NULL) {
    for (const r of fresh) {
      const held = cands.byRegion.get(r).filter((id) => isId(controllerOf.get(id)));
      if (held.length === 0) continue;
      return { ok: true, systemId: pickOf(held, seed, "place", stageNo), regionId: r, kind: STAGE_KIND.HOSTILE_NULL,
        jumpsHint: null, regionReused: false };
    }
  }
  if (fresh.length > 0) {
    const r = fresh[0];
    return { ok: true, systemId: pickOf(cands.byRegion.get(r), seed, "place", stageNo), regionId: r,
      kind: STAGE_KIND.NULL, jumpsHint: null, regionReused: false };
  }
  if (cands.regionOrder.length > 0) {
    const r = cands.regionOrder[0];
    return { ok: true, systemId: pickOf(cands.byRegion.get(r), seed, "place", stageNo), regionId: r,
      kind: STAGE_KIND.NULL, jumpsHint: null, regionReused: true };
  }
  return { ok: false, reason: "NO_PLACE" };
}

function templatesOf(factionId, analyzer) {
  const list = BATTLE_RELIC_TEMPLATES[factionId];
  if (!Array.isArray(list)) return [];
  const [from, to] = analyzer === "relic" ? RELIC_SLICE : DATA_SLICE;
  return list.slice(from, to);
}

function pickTemplate(input) {
  const theme = THEMES[input.theme];
  if (!theme) return { ok: false, reason: "NO_TEMPLATE" };
  const rng = createRng(deriveSeed(input.seed, "template", input.stageNo));
  let factionId = isId(input.controllerFactionId) && templatesOf(input.controllerFactionId, theme.analyzer).length > 0
    ? input.controllerFactionId : null;
  if (factionId === null) {
    const keys = Object.keys(BATTLE_RELIC_TEMPLATES).map(Number).sort((a, b) => a - b)
      .filter((f) => templatesOf(f, theme.analyzer).length > 0);
    if (keys.length === 0) return { ok: false, reason: "NO_TEMPLATE" };
    factionId = rng.pick(keys);
  }
  return { ok: true, templateId: rng.pick(templatesOf(factionId, theme.analyzer)), factionId };
}

module.exports = { STAGE_SEC_CLASS, bfsOf, orderOf, candidatesOf, regionsToRead, pickNextPlace, pickTemplate,
  pickWormholeStage };
