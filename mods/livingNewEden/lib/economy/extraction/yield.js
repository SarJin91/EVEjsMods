"use strict";

const { stableHash32 } = require("../../util/rng");

const YIELD_CLASSES = Object.freeze(["highsec", "lowsec", "nullsec"]);
const PERMILLE = 1000;
const MAX_UNITS_PER_KEY = 1000000000;
const CATALOG_METHODS = Object.freeze(["oresOfTier", "oreMaterials", "p1OfP0"]);
const PARAM_COUNTS = Object.freeze(["maxMoonsPerSystem", "maxPlanetsPerSystem", "moonPortionsPerMoonPerPeriod",
  "piP1UnitsPerPlanetPerPeriod"]);

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function invalid(detail) {
  return { ok: false, reason: "INVALID_INPUT", detail };
}

function checkInputs(sys, catalog, facts, params) {
  if (!isPlainObject(sys) || !isId(sys.systemId) || typeof sys.secClass !== "string") return "sys";
  if (!Array.isArray(sys.moons) || !sys.moons.every(isId)) return "sys.moons";
  const planetOk = (p) => isPlainObject(p) && isId(p.planetId) && isId(p.typeId);
  if (!Array.isArray(sys.planets) || !sys.planets.every(planetOk)) return "sys.planets";
  if (!catalog || !CATALOG_METHODS.every((m) => typeof catalog[m] === "function")) return "catalog";
  if (!facts || !(facts.p0ByPlanetType instanceof Map)) return "facts.p0ByPlanetType";
  if (!isPlainObject(params)) return "params";
  for (const key of PARAM_COUNTS) if (!isCount(params[key])) return `params.${key}`;
  if (!isPlainObject(params.bandPermille) || !YIELD_CLASSES.every((c) => isCount(params.bandPermille[c]))) {
    return "params.bandPermille";
  }
  if (!isPlainObject(params.tierWeights)) return "params.tierWeights";
  return null;
}

function weightsOf(list) {
  if (!Array.isArray(list)) return null;
  const out = [];
  let total = 0;
  for (const pair of list) {
    if (!Array.isArray(pair) || typeof pair[0] !== "string" || !isCount(pair[1])) return null;
    if (pair[1] > 0) {
      out.push([pair[0], pair[1]]);
      total += pair[1];
    }
  }
  return total > 0 ? { list: out, total } : null;
}

function pickTier(weights, h) {
  let r = h % weights.total;
  for (const [tier, w] of weights.list) {
    if (r < w) return tier;
    r -= w;
  }
  return weights.list[weights.list.length - 1][0];
}

function add(bag, typeId, units) {
  if (!(units > 0)) return;
  const key = `type:${typeId}`;
  bag[key] = Math.min(MAX_UNITS_PER_KEY, (bag[key] || 0) + units);
}

function systemYield(sys, catalog, facts, params) {
  const bad = checkInputs(sys, catalog, facts, params);
  if (bad) return invalid(bad);
  if (!YIELD_CLASSES.includes(sys.secClass)) return { ok: true, moon: {}, pi: {}, moonsUsed: 0, planetsUsed: 0 };
  const weights = weightsOf(params.tierWeights[sys.secClass]);
  if (!weights) return invalid(`params.tierWeights.${sys.secClass}`);
  const band = params.bandPermille[sys.secClass];

  const moon = {};
  const moons = [...new Set(sys.moons)].sort((a, b) => a - b).slice(0, params.maxMoonsPerSystem);
  const portions = params.moonPortionsPerMoonPerPeriod;
  for (const m of moons) {
    const tier = pickTier(weights, stableHash32("lne-moon", sys.systemId, m));
    const ores = catalog.oresOfTier(tier);
    if (!Array.isArray(ores) || ores.length === 0) continue;
    const ore = ores[stableHash32("lne-moon-ore", m) % ores.length];
    for (const [materialId, qty] of catalog.oreMaterials(ore)) {
      add(moon, materialId, Math.floor((qty * portions * band) / PERMILLE));
    }
  }

  const pi = {};
  const planets = [...sys.planets].sort((a, b) => a.planetId - b.planetId).slice(0, params.maxPlanetsPerSystem);
  const p1Units = Math.floor((params.piP1UnitsPerPlanetPerPeriod * band) / PERMILLE);
  for (const planet of planets) {
    const listed = facts.p0ByPlanetType.get(planet.typeId);
    const p0s = Array.isArray(listed) ? [...listed].filter(isId).sort((a, b) => a - b) : [];
    if (p0s.length === 0) continue;
    const p0 = p0s[stableHash32("lne-planet", planet.planetId) % p0s.length];
    const p1 = catalog.p1OfP0(p0);
    if (p1 === null || p1 === undefined) continue;
    add(pi, p1, p1Units);
  }
  return { ok: true, moon, pi, moonsUsed: moons.length, planetsUsed: planets.length };
}

module.exports = { systemYield, YIELD_CLASSES, MAX_UNITS_PER_KEY };
