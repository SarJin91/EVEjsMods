// Port of an idea of X-Eve livingEconomyRuntime.js (refinery efficiency fixed per load, CREDITS.md): the load is computed once, frozen in the trip row, and the delivery only scales it.

"use strict";

const { YIELD_SEC_CLASSES, PERMILLE } = require("../schema");
const { fleetRatePermille } = require("./rates");
const { MINERALS } = require("../data/mineralYield");

const MS_PER_MINUTE = 60000;
const PER_MILLION = 1000000;

const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const big = (v) => BigInt(Math.max(0, Math.trunc(Number(v) || 0)));
const toNumber = (b) => Number(b);

function richnessOf({ secClass, belts }, params) {
  const b = isCount(belts) ? belts : 0;
  if (!YIELD_SEC_CLASSES.includes(secClass)) return { richnessPermille: 0, secClass: String(secClass), belts: b };
  const band = Math.max(0, Math.trunc(Number(params.bandFactorPermille[secClass]) || 0));
  const sites = Math.min(b, params.beltCap) + params.anomalySitesPerSystem;
  const saturation = Math.max(1, params.siteSaturation);
  const fill = Math.min(PERMILLE, Math.floor((sites * PERMILLE) / saturation));
  return { richnessPermille: Math.min(PERMILLE, Math.floor((band * fill) / PERMILLE)), secClass, belts: b };
}

function computeLoad({ composition, shiftMs, richnessPermille, secClass }, params, rates, bands) {
  const band = YIELD_SEC_CLASSES.includes(secClass) && bands && bands[secClass] ? bands[secClass] : null;
  if (!band || !rates) return { oreM3: 0, minerals: {}, boosted: 0, booster: null };
  const fleet = fleetRatePermille(composition, rates);
  const m3 = (fleet.sum * big(shiftMs) * big(richnessPermille))
    / (BigInt(MS_PER_MINUTE) * BigInt(PERMILLE) * BigInt(PERMILLE));
  const minerals = {};
  const refined = m3 * big(params.refineYieldPermille);
  for (const key of Object.keys(band).sort()) {
    const n = (refined * big(band[key])) / (BigInt(PER_MILLION) * BigInt(PERMILLE));
    if (n > 0n) minerals[key] = toNumber(n);
  }
  return { oreM3: toNumber(m3), minerals, boosted: fleet.boosted, booster: fleet.booster };
}

function scaleBands(bands, factors) {
  const f = factors || {};
  const out = {};
  for (const c of Object.keys(bands || {})) {
    const band = bands[c];
    if (!band) continue;
    const scaled = {};
    for (const k of Object.keys(band)) {
      const factor = isCount(f[k]) ? f[k] : PERMILLE;
      scaled[k] = toNumber((big(band[k]) * BigInt(factor)) / BigInt(PERMILLE));
    }
    out[c] = Object.freeze(scaled);
  }
  return Object.freeze(out);
}

function mineralFactors(M) {
  const out = {};
  for (const id of Object.keys(MINERALS)) out[`type:${id}`] = (M || {})[`mineralFactor${MINERALS[id]}Permille`];
  return Object.freeze(out);
}

function scaleCargo(cargo, shipsAtLoad, shipsNow) {
  const atLoad = Math.max(1, Math.trunc(Number(shipsAtLoad) || 1));
  const now = Math.min(atLoad, Math.max(0, Math.trunc(Number(shipsNow) || 0)));
  const deliver = {};
  let lost = 0n;
  for (const key of Object.keys(cargo || {}).sort()) {
    const have = big(cargo[key]);
    const part = (have * BigInt(now)) / BigInt(atLoad);
    lost += have - part;
    if (part > 0n) deliver[key] = toNumber(part);
  }
  return { deliver, lostUnits: toNumber(lost) };
}

function cargoUnits(cargo) {
  let n = 0;
  for (const key of Object.keys(cargo || {})) n += Math.max(0, Number(cargo[key]) || 0);
  return n;
}

module.exports = { richnessOf, computeLoad, scaleBands, mineralFactors, scaleCargo, cargoUnits };
