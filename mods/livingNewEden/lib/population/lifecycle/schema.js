"use strict";

const { parseSystemIdList } = require("../schema");

const CAREER_NAMES = Object.freeze(["ROOKIE", "PILOT", "SEASONED", "VETERAN"]);
const CAREER = Object.freeze(Object.fromEntries(CAREER_NAMES.map((n, i) => [n, i + 1])));

const IDENTITY_STRIDE = 1048576;

function identityKey(pilotId, gen) {
  return gen > 0 ? pilotId + gen * IDENTITY_STRIDE : pilotId;
}

const CAREER_MAX_BAND = Object.freeze([0, 1, 2, 2]);
const INT32_MAX = 2147483647;

function hullCountOf(len, career) {
  if (!(len > 0)) return 0;
  if (!(career >= 1 && career <= CAREER_NAMES.length)) return len;
  return Math.floor((len * career + 3) / 4);
}

const CAREER_DEFAULTS = Object.freeze({ xpByCareer: Object.freeze([0, 30, 300, 1500]),
  costByCareer: Object.freeze([0, 100, 1500, 8000]), earnByBand: Object.freeze([10, 20, 40]), tradeEarn: 15,
  lossOnPod: 50, wealthMax: 1000000000, seedCareerPermille: Object.freeze([350, 350, 200, 100]),
  moveHomePermille: 500 });
const EARN_MAX = 1000000;

const intOr = (v, def, max) => (Number.isSafeInteger(v) && v >= 0 && v <= max ? v : def);

function buildArchVariants() {
  const { BANDS } = require("../schema");
  const { ARCHETYPES } = require("../data/archetypes");
  const out = new Map();
  for (const [code, arch] of Object.entries(ARCHETYPES)) {
    const perCareer = [];
    for (let c = 1; c <= CAREER_NAMES.length; c += 1) {
      const perBand = [];
      for (let h = 0; h <= BANDS.length; h += 1) {
        const homeBand = h < BANDS.length ? BANDS[h] : null;
        const bands = arch.bands.filter((b) => BANDS.indexOf(b) <= CAREER_MAX_BAND[c - 1] || b === homeBand);
        perBand.push(bands.length === arch.bands.length ? arch
          : Object.freeze({ weights: arch.weights, hulls: arch.hulls, bands: Object.freeze(bands) }));
      }
      perCareer.push(Object.freeze(perBand));
    }
    out.set(Number(code), Object.freeze(perCareer));
  }
  return { out, BANDS };
}

function careerSettingsOf(L) {
  if (!L || L.enabled !== true || L.careerEnabled !== true) return null;
  const { parseIntList, parsePermilleList } = require("../schema");
  const D = CAREER_DEFAULTS;
  const { out: variants, BANDS } = buildArchVariants();
  const minCareerByBand = Object.freeze(BANDS.map((_, b) => CAREER_MAX_BAND.findIndex((m) => m >= b) + 1));
  function archOf(archetype, career, band) {
    const perCareer = variants.get(archetype);
    if (!perCareer || !(career >= 1 && career <= CAREER_NAMES.length)) return null;
    const h = BANDS.indexOf(band);
    return perCareer[career - 1][h >= 0 ? h : BANDS.length];
  }
  return Object.freeze({
    xpByCareer: parseIntList(L.xpByCareer, 4, INT32_MAX) || D.xpByCareer,
    costByCareer: parseIntList(L.costByCareer, 4, INT32_MAX) || D.costByCareer,
    earnByBand: parseIntList(L.earnByBand, BANDS.length, EARN_MAX) || D.earnByBand,
    tradeEarn: intOr(L.tradeEarn, D.tradeEarn, EARN_MAX),
    lossOnPod: intOr(L.lossOnPod, D.lossOnPod, EARN_MAX),
    wealthMax: Number.isSafeInteger(L.wealthMax) && L.wealthMax >= 1 && L.wealthMax <= INT32_MAX ? L.wealthMax
      : D.wealthMax,
    seedCareerPermille: parsePermilleList(L.seedCareerPermille, CAREER_NAMES.length) || D.seedCareerPermille,
    moveHomePermille: intOr(L.moveHomePermille, D.moveHomePermille, 1000),
    minCareerByBand, archOf });
}

function lifecycleSettingsOf(P) {
  const L = P && P.lifecycle && typeof P.lifecycle === "object" ? P.lifecycle : {};
  if (L.enabled !== true) return Object.freeze({ ...L, enabled: false, career: null });
  const awayMaxMs = Number.isFinite(L.awayMinMs) && Number.isFinite(L.awayMaxMs) && L.awayMaxMs < L.awayMinMs
    ? L.awayMinMs : L.awayMaxMs;
  const ids = typeof L.rookieSystemIds === "string" ? parseSystemIdList(L.rookieSystemIds) : null;
  return Object.freeze({ ...L, enabled: true, awayMaxMs, rookieSystemIds: ids || Object.freeze([]),
    career: careerSettingsOf(L) });
}

const DDL = `
ALTER TABLE world_npc_pilots ADD COLUMN gen    INTEGER NOT NULL DEFAULT 0;
ALTER TABLE world_npc_pilots ADD COLUMN career INTEGER NOT NULL DEFAULT 0;
ALTER TABLE world_npc_pilots ADD COLUMN xp     INTEGER NOT NULL DEFAULT 0;
ALTER TABLE world_npc_pilots ADD COLUMN wealth INTEGER NOT NULL DEFAULT 0;
`;

function upPopulationLifecycle(db) {
  db.exec(DDL);
}

module.exports = { CAREER_NAMES, CAREER, IDENTITY_STRIDE, identityKey, lifecycleSettingsOf, upPopulationLifecycle,
  CAREER_MAX_BAND, INT32_MAX, hullCountOf, careerSettingsOf };
