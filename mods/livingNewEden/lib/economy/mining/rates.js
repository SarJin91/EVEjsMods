"use strict";

const { HULL_GROUPS } = require("../../fleets/schema");

const PERMILLE = 1000;

const MINING_RATE_GROUPS = Object.freeze({
  mining_frigate: Object.freeze({ rate: "rateMiningFrigateM3PerMin" }),
  mining_barge: Object.freeze({ rate: "rateMiningBargeM3PerMin" }),
  exhumer: Object.freeze({ rate: "rateExhumerM3PerMin" }),
  porpoise: Object.freeze({ rate: "ratePorpoiseM3PerMin", boost: "boostPorpoisePermille",
    miners: "boostedMinersPorpoise" }),
  orca: Object.freeze({ rate: "rateOrcaM3PerMin", boost: "boostOrcaPermille", miners: "boostedMinersOrca" }),
  rorqual: Object.freeze({ rate: "rateRorqualM3PerMin", boost: "boostRorqualPermille",
    miners: "boostedMinersRorqual" }),
});
const BOOSTER_ORDER = Object.freeze(["rorqual", "orca", "porpoise"]);
const LEGACY_MINER_ALIASES = Object.freeze({ industrial: "mining_frigate" });

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : 0);

function createMiningRates(M) {
  const src = M && typeof M === "object" ? M : {};
  const rates = new Map();
  const boosters = new Map();
  for (const [group, keys] of Object.entries(MINING_RATE_GROUPS)) {
    rates.set(group, count(src[keys.rate]));
    if (keys.boost) {
      boosters.set(group, Object.freeze({ boostPermille: Math.max(PERMILLE, count(src[keys.boost])),
        boostedMiners: count(src[keys.miners]) }));
    }
  }
  for (const [alias, target] of Object.entries(LEGACY_MINER_ALIASES)) rates.set(alias, rates.get(target) || 0);
  return Object.freeze({
    rateOf: (g) => (typeof g === "string" && rates.has(g) ? rates.get(g) : 0),
    boosterOf: (g) => (typeof g === "string" && boosters.has(g) ? boosters.get(g) : null),
  });
}

function fleetRatePermille(composition, rates) {
  const byGroup = new Map();
  for (const e of Array.isArray(composition) ? composition : []) {
    if (!e || typeof e.hullGroup !== "string" || !Number.isSafeInteger(e.count) || e.count < 1) continue;
    byGroup.set(e.hullGroup, (byGroup.get(e.hullGroup) || 0) + e.count);
  }
  const booster = BOOSTER_ORDER.find((g) => byGroup.has(g)) || null;
  const boost = booster ? rates.boosterOf(booster) : null;
  let sum = 0n;
  let miners = 0;
  const candidates = [];
  for (const [group, n] of byGroup) {
    const rate = rates.rateOf(group);
    if (!(rate > 0)) continue;
    miners += n;
    if (has(MINING_RATE_GROUPS, group) && MINING_RATE_GROUPS[group].boost) {
      sum += BigInt(n) * BigInt(rate) * BigInt(PERMILLE);
    } else {
      candidates.push({ group, n, rate, index: HULL_GROUPS.indexOf(group) });
    }
  }
  candidates.sort((a, b) => b.rate - a.rate || a.index - b.index);
  let left = boost ? boost.boostedMiners : 0;
  let boosted = 0;
  for (const c of candidates) {
    const up = Math.min(left, c.n);
    left -= up;
    boosted += up;
    sum += BigInt(up) * BigInt(c.rate) * BigInt(boost ? boost.boostPermille : PERMILLE)
      + BigInt(c.n - up) * BigInt(c.rate) * BigInt(PERMILLE);
  }
  return { sum, booster, boosted, miners };
}

module.exports = { MINING_RATE_GROUPS, BOOSTER_ORDER, LEGACY_MINER_ALIASES, createMiningRates, fleetRatePermille };
