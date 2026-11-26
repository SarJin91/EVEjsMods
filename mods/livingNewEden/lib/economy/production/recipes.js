"use strict";

const { HULL_GROUPS, HULL_GROUPS_V1, INDUSTRY_HULL_GROUPS, CAPITAL_HULL_GROUPS } = require("../../fleets/schema");
const { MINERALS } = require("../data/mineralYield");
const { createIndustryCatalog } = require("../industry/catalog");
const { effectiveFactorPermille } = require("../industry/componentFactor");

const RECIPES_VERSION = 2;
const MS_PER_SEC = 1000;
const PERMILLE = 1000;
const KEY_RE = /^type:(\d+)$/;

const isPositive = (v) => Number.isSafeInteger(v) && v > 0;
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function checkParams(params) {
  if (!params || !isPositive(params.timeFactorPermille) || !isPositive(params.minRunMs)
    || !isPositive(params.maxRunMs) || params.minRunMs > params.maxRunMs
    || !Number.isSafeInteger(params.componentWeightPermille) || params.componentWeightPermille < 0
    || !Number.isSafeInteger(params.componentFactorMaxPermille) || params.componentFactorMaxPermille < PERMILLE) {
    throw new TypeError("recipes: params");
  }
  if (params.scaledTimeEnabled === true && (!isPositive(params.titanRunMs)
    || !isPositive(params.scaledTimeReferenceSec) || params.titanRunMs < params.minRunMs)) {
    throw new TypeError("recipes: params");
  }
}

function runMsOf(g, timeSec, params) {
  if (params.scaledTimeEnabled !== true) {
    const raw = Math.floor((timeSec * MS_PER_SEC * params.timeFactorPermille) / PERMILLE);
    return Math.min(params.maxRunMs, Math.max(params.minRunMs, raw));
  }
  const product = timeSec * params.titanRunMs;
  if (!Number.isSafeInteger(product)) throw new TypeError(`recipes: scaled time overflow ${g}`);
  const raw = Math.floor(product / params.scaledTimeReferenceSec);
  return Math.min(params.titanRunMs, Math.max(params.minRunMs, raw));
}

const CAPITAL_PERMILLE_KEYS = Object.freeze({ supercarrier: "supercarrierRecipePermille",
  titan: "titanRecipePermille" });

function capitalPermilleOf(g, params) {
  const key = CAPITAL_PERMILLE_KEYS[g];
  const v = key ? params[key] : undefined;
  if (v === undefined || v === null) return PERMILLE;
  if (!isPositive(v) || v > PERMILLE) throw new TypeError(`recipes: ${key}`);
  return v;
}

function scaledRow(g, row, permille) {
  if (permille === PERMILLE || !row || !row.minerals || typeof row.minerals !== "object") return row;
  const minerals = {};
  for (const k of Object.keys(row.minerals)) {
    const base = row.minerals[k];
    if (!Number.isSafeInteger(base) || base < 0) throw new TypeError(`recipes: capital ${g}.${k}`);
    const scaled = Math.ceil((base * permille) / PERMILLE);
    if (scaled > 0) minerals[k] = scaled;
  }
  return { ...row, minerals };
}

function resolveCapital(capital) {
  const source = capital !== undefined && capital !== null ? capital : require("../data/capitalRecipes");
  if (!source || !source.HEADER || !isPositive(source.HEADER.recipesVersion) || !source.GROUPS
    || typeof source.GROUPS !== "object") {
    throw new TypeError("recipes: capital HEADER.recipesVersion / GROUPS");
  }
  const extra = Object.keys(source.GROUPS).filter((g) => !CAPITAL_HULL_GROUPS.includes(g));
  if (extra.length > 0) throw new TypeError(`recipes: capital groups (extra ${extra.join(",")})`);
  return source.GROUPS;
}

function resolveIndustry(industry) {
  if (industry !== undefined && industry !== null) return industry;
  const made = createIndustryCatalog();
  if (!made.ok) throw new TypeError(`recipes: industry catalog ${made.detail}`);
  return made.catalog;
}

function checkRow(g, row) {
  if (!row || !isPositive(row.timeSec) || !row.minerals || typeof row.minerals !== "object") {
    throw new TypeError(`recipes: ${g}`);
  }
  const keys = Object.keys(row.minerals).sort();
  if (keys.length === 0) throw new TypeError(`recipes: ${g} has no minerals`);
  for (const k of keys) {
    const m = KEY_RE.exec(k);
    if (!m || !hasOwn(MINERALS, m[1]) || !isPositive(row.minerals[k])) throw new TypeError(`recipes: ${g}.${k}`);
  }
  return { minerals: Object.freeze(Object.fromEntries(keys.map((k) => [k, row.minerals[k]]))), timeSec: row.timeSec };
}

function factorFor(componentFactorPermille, params) {
  return effectiveFactorPermille(componentFactorPermille, params);
}

function industryRow(g, industry, params) {
  const row = typeof industry.hull === "function" ? industry.hull(g) : null;
  if (!row || !row.minerals || typeof row.minerals !== "object") throw new TypeError(`recipes: industry ${g}`);
  const f = factorFor(row.componentFactorPermille, params);
  if (f === null) throw new TypeError(`recipes: industry ${g}.componentFactorPermille`);
  const minerals = {};
  for (const k of Object.keys(row.minerals)) {
    const base = row.minerals[k];
    if (!Number.isSafeInteger(base) || base < 0) throw new TypeError(`recipes: industry ${g}.${k}`);
    if (base === 0) continue;
    const scaled = Math.ceil((base * f) / PERMILLE);
    if (!Number.isSafeInteger(scaled)) throw new TypeError(`recipes: industry ${g}.${k} overflow`);
    minerals[k] = scaled;
  }
  return { checked: checkRow(g, { minerals, timeSec: row.timeSec }), factor: f };
}

function createRecipeTable(data, params, industry, capital) {
  if (!data || !data.HEADER || !isPositive(data.HEADER.recipesVersion) || !data.GROUPS) {
    throw new TypeError("recipes: HEADER.recipesVersion / GROUPS");
  }
  checkParams(params);
  const names = Object.keys(data.GROUPS);
  const extra = names.filter((g) => !HULL_GROUPS.includes(g));
  const missing = HULL_GROUPS_V1.filter((g) => !names.includes(g));
  if (extra.length > 0 || missing.length > 0) {
    throw new TypeError(`recipes: groups (missing ${missing.join(",") || "-"}, extra ${extra.join(",") || "-"})`);
  }
  const needIndustry = INDUSTRY_HULL_GROUPS.some((g) => !names.includes(g));
  const catalog = needIndustry ? resolveIndustry(industry) : null;
  const needCapital = CAPITAL_HULL_GROUPS.some((g) => !names.includes(g));
  const capitalGroups = needCapital ? resolveCapital(capital) : null;
  const table = new Map();
  const factors = new Map();
  for (const g of HULL_GROUPS) {
    let checked;
    if (hasOwn(data.GROUPS, g)) {
      checked = checkRow(g, data.GROUPS[g]);
      factors.set(g, PERMILLE);
    } else if (CAPITAL_HULL_GROUPS.includes(g)) {
      if (!hasOwn(capitalGroups, g)) throw new TypeError(`recipes: capital ${g} missing`);
      checked = checkRow(g, scaledRow(g, capitalGroups[g], capitalPermilleOf(g, params)));
      factors.set(g, PERMILLE);
    } else {
      const made = industryRow(g, catalog, params);
      checked = made.checked;
      factors.set(g, made.factor);
    }
    const runMs = runMsOf(g, checked.timeSec, params);
    table.set(g, Object.freeze({ minerals: checked.minerals, runMs }));
  }
  return Object.freeze({
    version: RECIPES_VERSION,
    groups: Object.freeze([...HULL_GROUPS]),
    lookup: (g) => table.get(g) || null,
    billFor(g, runs) {
      const r = table.get(g);
      if (!r || !isPositive(runs)) return null;
      const out = {};
      for (const k of Object.keys(r.minerals)) out[k] = r.minerals[k] * runs;
      return out;
    },
    factorOf: (g) => (factors.has(g) ? factors.get(g) : null),
  });
}

function recipeParamsOf(P) {
  return { timeFactorPermille: P.timeFactorPermille, minRunMs: P.minRunMs, maxRunMs: P.maxRunMs,
    componentWeightPermille: P.componentWeightPermille, componentFactorMaxPermille: P.componentFactorMaxPermille,
    scaledTimeEnabled: P.scaledTimeEnabled, titanRunMs: P.titanRunMs, scaledTimeReferenceSec: P.scaledTimeReferenceSec,
    supercarrierRecipePermille: P.supercarrierRecipePermille, titanRecipePermille: P.titanRecipePermille };
}

module.exports = { createRecipeTable, recipeParamsOf, capitalPermilleOf, RECIPES_VERSION };
