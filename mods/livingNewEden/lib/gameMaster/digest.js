"use strict";

const { createRng, deriveSeed } = require("../util/rng");
const { EXPANSION_EXCLUDED_REGION_IDS } = require("../strategy/data/expansion");
const { FACTIONS, ROLES } = require("./data/factions");
const { ARCS } = require("./data/arcs");
const { cycleMsOf } = require("./cycle");
const { arcFitsFaction } = require("./siteTemplates");

const PLACE_SEC_CLASSES = Object.freeze(["lowsec", "nullsec"]);
const PER_REGION = 3;
const MIN_FILL = 4;
const FACT_PLACES = 4;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isName = (v) => typeof v === "string" && v.trim() !== "";

function cooldownSince(cycleAt, cycles, S) {
  return cycleAt - cycles * cycleMsOf(S);
}

function arcsInCooldown(recent, cycleAt, S) {
  const since = cooldownSince(cycleAt, S.arcCooldownCycles, S);
  return new Set(recent.filter((r) => r.cycleAt >= since && r.cycleAt < cycleAt).map((r) => r.arc));
}

function systemsInCooldown(recent, cycleAt, S) {
  const since = cooldownSince(cycleAt, S.systemCooldownCycles, S);
  return new Set(recent.filter((r) => r.cycleAt >= since && r.cycleAt < cycleAt).map((r) => r.systemId));
}

function draw(list, n, rng) {
  const pool = [...list];
  const out = [];
  while (pool.length > 0 && out.length < n) {
    const i = rng.nextInt(0, pool.length - 1);
    out.push(pool[i]);
    pool.splice(i, 1);
  }
  return out;
}

function levelOf(samples, S) {
  if (samples >= S.activityHighSamples) return "high";
  if (samples >= S.activityMidSamples) return "mid";
  return "low";
}

function buildOffer(input) {
  const { cycleAt, seed, graph, S } = input;
  const names = input.factionNames instanceof Map ? input.factionNames : new Map();
  const registry = input.registry;
  const recent = (Array.isArray(input.recentThreads) ? input.recentThreads : []).filter((r) => r
    && typeof r.arc === "string" && isId(r.anchorSystemId) && Number.isSafeInteger(r.cycleAt))
    .map((r) => {
      const sys = graph.getSystem(r.anchorSystemId);
      return Object.freeze({ arc: r.arc, regionId: sys && isId(sys.regionId) ? sys.regionId : 0,
        systemId: r.anchorSystemId, cycleAt: r.cycleAt });
    })
    .sort((a, b) => a.cycleAt - b.cycleAt || a.systemId - b.systemId);
  const blockedSystems = systemsInCooldown(recent, cycleAt, S);
  const excluded = new Set(EXPANSION_EXCLUDED_REGION_IDS);

  const placeOf = (systemId) => {
    if (blockedSystems.has(systemId)) return null;
    const sys = graph.getSystem(systemId);
    if (!sys || !PLACE_SEC_CLASSES.includes(sys.secClass) || !isId(sys.regionId) || excluded.has(sys.regionId)) {
      return null;
    }
    const regionName = graph.getRegionName(sys.regionId);
    if (!isName(sys.name) || !isName(regionName)) return null;
    return { systemId, name: sys.name, regionId: sys.regionId, regionName, secClass: sys.secClass };
  };

  const chosen = [];
  const taken = new Set();
  const take = (p) => {
    if (!p || taken.has(p.systemId) || chosen.length >= S.maxPlaces) return;
    taken.add(p.systemId);
    chosen.push(p);
  };

  const factSystems = Array.isArray(input.factSystemIds) ? input.factSystemIds.filter(isId) : [];
  for (const id of factSystems) {
    if (chosen.length >= FACT_PLACES) break;
    take(placeOf(id));
  }
  const activity = (Array.isArray(input.activityRows) ? input.activityRows : [])
    .filter((r) => r && isId(r.regionId) && Number.isSafeInteger(r.samples) && r.samples > 0)
    .sort((a, b) => b.samples - a.samples || a.regionId - b.regionId)
    .slice(0, S.maxActivityRegions);
  for (const row of activity) {
    if (chosen.length >= S.maxPlaces || excluded.has(row.regionId)) continue;
    const ids = [...graph.getSystemsInRegion(row.regionId)].sort((a, b) => a - b);
    const candidates = ids.map(placeOf).filter((p) => p !== null);
    const rng = createRng(deriveSeed(seed, "places", row.regionId));
    for (const p of draw(candidates, PER_REGION, rng)) take(p);
  }
  const fillTo = Math.min(MIN_FILL, S.maxPlaces);
  if (chosen.length < fillTo) {
    const all = [...new Set([...graph.getSystemsBySecClass("lowsec"), ...graph.getSystemsBySecClass("nullsec")])]
      .sort((a, b) => a - b).filter((id) => !taken.has(id));
    const rng = createRng(deriveSeed(seed, "fill"));
    const pool = [...all];
    while (chosen.length < fillTo && pool.length > 0) {
      const i = rng.nextInt(0, pool.length - 1);
      const id = pool[i];
      pool.splice(i, 1);
      take(placeOf(id));
    }
  }
  if (chosen.length === 0) return { ok: false, reason: "NO_PLACE" };
  const places = Object.freeze(chosen.map((p, i) => Object.freeze({ ref: `P${i + 1}`, ...p })));

  const factions = Object.freeze(FACTIONS.filter((f) => isName(names.get(f.factionId)))
    .map((f) => Object.freeze({ key: f.key, factionId: f.factionId, role: f.role, name: names.get(f.factionId) })));
  if (!factions.some((f) => f.role === ROLES.PIRATE)) return { ok: false, reason: "NO_FACTION" };
  const hasActor = factions.some((f) => f.role === ROLES.ACTOR);

  const cooling = arcsInCooldown(recent, cycleAt, S);
  const arcs = Object.freeze([...S.arcs].filter((key) => {
    const arc = ARCS[key];
    if (!arc || cooling.has(key)) return false;
    if (!arc.requiredKinds.every((k) => registry.get(k) !== null)) return false;
    if (arc.needsActor && !hasActor) return false;
    if (!factions.some((f) => f.role === ROLES.PIRATE && arcFitsFaction(arc, f.factionId))) return false;
    return places.some((p) => arc.securityClasses.includes(p.secClass));
  }).sort());
  if (arcs.length === 0) return { ok: false, reason: "NO_ARC" };

  const stepKinds = Object.freeze(registry.list().map((k) => Object.freeze({ type: k.type, promptHint: k.promptHint,
    maxPerThread: k.maxPerThread })));
  const levels = Object.freeze(activity.map((r) => Object.freeze({ regionId: r.regionId,
    level: levelOf(r.samples, S) })));
  const hints = Array.isArray(input.hints) ? input.hints : [];
  const lines = Object.freeze(hints.flatMap((h) => h.lines.map((text) => Object.freeze({ key: h.key, text }))));
  const arcBias = Object.freeze([...new Set(hints.flatMap((h) => h.arcBias))].filter((a) => arcs.includes(a)).sort());
  return { ok: true, offer: Object.freeze({ places, factions, arcs, stepKinds, recent: Object.freeze(recent),
    activity: levels, lines, arcBias, cycleAt }) };
}

module.exports = { buildOffer, arcsInCooldown, systemsInCooldown, levelOf };
